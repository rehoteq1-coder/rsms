'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SERVER — SQLite data layer (node:sqlite, built-in)

   One durable single-file database. Every synchronised business row
   carries local + cloud identity fields per docs/offline-design.md §5:
   local_id, online_key, school_id, updated_at, created_at, sync_state,
   row_version. Money rows are append-only; nothing is auto-deleted.
═══════════════════════════════════════════════════════════════════ */

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

var SCHEMA_VERSION = 2;

var DATABASE_FILE = new WeakMap();
function openDatabase(file){
  var DatabaseSync = require('node:sqlite').DatabaseSync;
  if(file !== ':memory:') fs.mkdirSync(path.dirname(file), {recursive:true});
  var db = new DatabaseSync(file);
  DATABASE_FILE.set(db, file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  ensureSchema(db);
  return db;
}

function ensureSchema(db){
  db.exec(
    'CREATE TABLE IF NOT EXISTS meta (' +
      'key TEXT PRIMARY KEY, value TEXT NOT NULL' +
    ');' +
    'CREATE TABLE IF NOT EXISTS local_users (' +
      'username TEXT PRIMARY KEY,' +
      'display_name TEXT NOT NULL,' +
      'role TEXT NOT NULL,' +
      'credential_hash TEXT NOT NULL,' +
      'salt TEXT NOT NULL,' +
      'created_at TEXT NOT NULL,' +
      'updated_at TEXT NOT NULL' +
    ');' +
    'CREATE TABLE IF NOT EXISTS sessions (' +
      'token_hash TEXT PRIMARY KEY,' +
      'username TEXT NOT NULL,' +
      'role TEXT NOT NULL,' +
      'created_at TEXT NOT NULL,' +
      'expires_at TEXT NOT NULL,' +
      'revoked_at TEXT' +
    ');' +
    /* Business rows: one logical table per portal collection. data is the
       row exactly as the portal pages know it (JSON), so the LAN adapter
       can hand pages their usual arrays without reshaping. */
    'CREATE TABLE IF NOT EXISTS rows (' +
      'collection TEXT NOT NULL,' +
      'local_id TEXT NOT NULL,' +
      'online_key TEXT,' +
      'school_id TEXT NOT NULL,' +
      'data TEXT NOT NULL,' +
      'updated_at TEXT NOT NULL,' +
      'created_at TEXT NOT NULL,' +
      'sync_state TEXT NOT NULL DEFAULT \'pending\',' +
      'row_version INTEGER NOT NULL DEFAULT 1,' +
      'PRIMARY KEY (collection, local_id)' +
    ');' +
    'CREATE INDEX IF NOT EXISTS idx_rows_sync ON rows(collection, sync_state);' +
    'CREATE INDEX IF NOT EXISTS idx_rows_updated ON rows(collection, updated_at);' +
    /* Durable outbox: local sync intents. Acknowledged-before-removal. */
    'CREATE TABLE IF NOT EXISTS outbox (' +
      'id TEXT PRIMARY KEY,' +
      'collection TEXT NOT NULL,' +
      'local_id TEXT NOT NULL,' +
      'online_key TEXT,' +
      'action TEXT NOT NULL,' +
      'base_version INTEGER,' +
      'payload TEXT NOT NULL,' +
      'created_at TEXT NOT NULL,' +
      'status TEXT NOT NULL DEFAULT \'pending\',' +
      'attempts INTEGER NOT NULL DEFAULT 0,' +
      'last_error TEXT,' +
      'ack_receipt TEXT' +
    ');' +
    'CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);' +
    'CREATE TABLE IF NOT EXISTS sync_cursor (' +
      'collection TEXT PRIMARY KEY, updated_at TEXT NOT NULL, last_sync_at TEXT' +
    ');' +
    'CREATE TABLE IF NOT EXISTS conflicts (' +
      'id TEXT PRIMARY KEY,' +
      'collection TEXT NOT NULL,' +
      'local_id TEXT NOT NULL,' +
      'local_data TEXT,' +
      'cloud_data TEXT,' +
      'base_data TEXT,' +
      'reason TEXT,' +
      'status TEXT NOT NULL DEFAULT \'open\',' +
      'resolved_by TEXT,' +
      'resolution TEXT,' +
      'resolved_at TEXT,' +
      'created_at TEXT NOT NULL' +
    ');' +
    'CREATE TABLE IF NOT EXISTS audit_log (' +
      'id TEXT PRIMARY KEY,' +
      'actor TEXT NOT NULL,' +
      'action TEXT NOT NULL,' +
      'entity TEXT,' +
      'detail TEXT,' +
      'created_at TEXT NOT NULL,' +
      'sync_state TEXT NOT NULL DEFAULT \'pending\',' +
      'cloud_receipt TEXT' +
    ');'
  );
  var v = metaGet(db, 'schema_version');
  if(!v) metaSet(db, 'schema_version', String(SCHEMA_VERSION));
  else if(Number(v) < SCHEMA_VERSION){
    migrate(db, Number(v));
  }
}

function migrate(db, from){
  if(from < 2){
    /* Phase B: conflicts carry a human-readable reason for the
       Bursar Conflict Review screen. */
    db.exec('ALTER TABLE conflicts ADD COLUMN reason TEXT');
    metaSet(db, 'schema_version', '2');
  }
}

function databaseFile(db){
  return DATABASE_FILE.get(db) || null;
}

function metaGet(db, key){
  var row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/* True when the database schema version does not match this server —
   the updater must not force an update across a migration boundary. */
function inMigration(db){
  var v = metaGet(db, 'schema_version');
  return !v || Number(v) !== SCHEMA_VERSION;
}

function metaSet(db, key, value){
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/* Run fn inside a single SQLite transaction. */
function withTransaction(db, fn){
  db.exec('BEGIN');
  try{
    var result = fn();
    db.exec('COMMIT');
    return result;
  }catch(e){
    try{ db.exec('ROLLBACK'); }catch(_){}
    throw e;
  }
}

function uuid(){
  return crypto.randomUUID();
}

function nowIso(){
  return new Date().toISOString();
}

/* Store a whole collection as the portal knows it (array or map).
   Reconciles rows by the row's own id field when present, keeps
   local_id stable across saves, and appends an outbox intent per
   changed row in the SAME transaction. Returns the changed local_ids. */
function saveCollection(db, schoolId, collection, value, actor){
  var rows = toArray(value);
  var seen = {};
  var changed = [];
  var stamp = nowIso();

  withTransaction(db, function(){
    rows.forEach(function(row){
      var localId = rowId(collection, row);
      seen[localId] = true;
      var existing = db.prepare(
        'SELECT online_key, row_version, created_at, sync_state FROM rows ' +
        'WHERE collection = ? AND local_id = ?').get(collection, localId);
      if(existing){
        db.prepare(
          'UPDATE rows SET online_key = COALESCE(?, online_key), data = ?, ' +
          'updated_at = ?, row_version = row_version + 1, sync_state = \'pending\' ' +
          'WHERE collection = ? AND local_id = ?'
        ).run(onlineKeyOf(row) || null, JSON.stringify(row), stamp, collection, localId);
      }else{
        db.prepare(
          'INSERT INTO rows (collection, local_id, online_key, school_id, data, ' +
          'updated_at, created_at, sync_state, row_version) VALUES (?,?,?,?,?,?,?,?,1)'
        ).run(collection, localId, onlineKeyOf(row) || null, schoolId,
              JSON.stringify(row), stamp, stamp, 'pending');
      }
      /* One stable idempotency intent per (collection, local_id): if a
         pending/intent is already in flight for this row, refresh its
         payload under the SAME id so cloud retries stay deduplicated. */
      var openIntent = db.prepare(
        'SELECT id FROM outbox WHERE collection = ? AND local_id = ? ' +
        'AND status IN (\'pending\', \'in_flight\') ORDER BY created_at DESC LIMIT 1'
      ).get(collection, localId);
      if(openIntent){
        db.prepare(
          'UPDATE outbox SET online_key = COALESCE(?, online_key), action = ?, ' +
          'base_version = ?, payload = ?, created_at = ?, last_error = NULL ' +
          'WHERE id = ?'
        ).run(onlineKeyOf(row) || null, 'upsert',
             existing ? existing.row_version : 0, JSON.stringify(row), stamp, openIntent.id);
      }else{
        db.prepare(
          'INSERT INTO outbox (id, collection, local_id, online_key, action, ' +
          'base_version, payload, created_at, status) VALUES (?,?,?,?,?,?,?,?,' +
          '\'pending\')'
        ).run(
          uuid(), collection, localId, onlineKeyOf(row) || null, 'upsert',
          existing ? existing.row_version : 0, JSON.stringify(row), stamp
        );
      }
      changed.push(localId);
    });

    db.prepare('INSERT OR IGNORE INTO sync_cursor (collection, updated_at) VALUES (?, ?)')
      .run(collection, stamp);
    if(changed.length){
      db.prepare(
        'INSERT INTO audit_log (id, actor, action, entity, detail, created_at) ' +
        'VALUES (?,?,?,?,?,?)'
      ).run(uuid(), actor || 'staff', 'collection-save',
           collection, changed.length + ' row(s) updated', stamp);
    }
  });
  return changed;
}

function toArray(value){
  if(Array.isArray(value)) return value.filter(Boolean);
  if(value && typeof value === 'object'){
    return Object.keys(value).map(function(k){ return value[k]; }).filter(Boolean);
  }
  return [];
}

/* Stable local identity for a row: prefer the portal's own ids. */
function rowId(collection, row){
  var id = row.id || row.localId ||
    (collection === 'wallet' ? (row.walId || row.id) : (row.txId || row.id || row.receiptNo));
  if(id !== undefined && id !== null && String(id) !== '') return String(id);
  return 'row-' + crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16);
}

function onlineKeyOf(row){
  var k = row.onlineKey || row.online_key;
  return k ? String(k) : null;
}

function readCollection(db, collection){
  var rows = db.prepare('SELECT data FROM rows WHERE collection = ? ORDER BY created_at').all(collection);
  return rows.map(function(r){ return JSON.parse(r.data); });
}

function collectionCount(db, collection){
  var r = db.prepare('SELECT COUNT(*) AS n FROM rows WHERE collection = ?').get(collection);
  return r ? r.n : 0;
}

module.exports = {
  openDatabase:openDatabase,
  databaseFile:databaseFile,
  inMigration:inMigration,
  metaGet:metaGet,
  metaSet:metaSet,
  withTransaction:withTransaction,
  uuid:uuid,
  nowIso:nowIso,
  saveCollection:saveCollection,
  readCollection:readCollection,
  collectionCount:collectionCount,
  rowId:rowId,
  SCHEMA_VERSION:SCHEMA_VERSION
};
