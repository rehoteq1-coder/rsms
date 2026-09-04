'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SERVER — verified backup & restore (Phase C)

   Backup: VACUUM INTO (consistent WAL-safe snapshot, safe while the
   server is live) + sidecar metadata (SHA-256, schema, binding, row
   counts, outbox status) + integrity quick_check + 7-day retention.
   Restore: hash-verified, integrity-checked, school-binding-checked
   candidate; pre-restore emergency copy of the live DB; single
   transactional swap of all data; maintenance flag stops writes for
   the duration. Never changes the school identity of the appliance.
═══════════════════════════════════════════════════════════════════ */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var dbModule = require('./db');

var sync = require('./sync');

function stamp(){
  var d = new Date();
  var p = function(n){ return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function backupDir(db, explicit){
  if(explicit) return path.resolve(explicit);
  var meta = dbModule.metaGet(db, 'backup_dir');
  if(meta) return path.resolve(meta);
  return path.join(path.dirname(dbModule.databaseFile(db)), 'backups');
}

function setBackupDir(db, dir){
  dbModule.metaSet(db, 'backup_dir', path.resolve(dir));
  return path.resolve(dir);
}

function sha256File(file){
  var h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function collectionStats(db){
  var rows = db.prepare(
    'SELECT collection, COUNT(*) AS n, COALESCE(MAX(updated_at),\'\') AS newest ' +
    'FROM rows GROUP BY collection').all();
  var out = {};
  rows.forEach(function(r){ out[r.collection] = {count: r.n, newest: r.newest}; });
  return out;
}

/* Create one verified backup. Returns the sidecar record. */
function createBackup(db, opts){
  opts = opts || {};
  var dest = backupDir(db, opts.dir);
  fs.mkdirSync(dest, {recursive: true});
  var base = 'rsms-school-' + stamp() + (opts.suffix ? '-' + String(opts.suffix) : '');
  var file = path.join(dest, base + '.sqlite');

  /* VACUUM INTO produces a consistent snapshot even while live. */
  db.prepare('VACUUM INTO ?').get(file);

  var record = {
    name: base + '.sqlite',
    createdAt: dbModule.nowIso(),
    sourceFile: dbModule.databaseFile(db),
    backupSize: fs.statSync(file).size,
    sha256: sha256File(file),
    schemaVersion: dbModule.SCHEMA_VERSION,
    schoolBinding: sync.binding(db),
    collections: collectionStats(db),
    outbox: sync.outboxStatus(db),
    integrity: null
  };

  /* Verify the candidate before it can ever be restored. */
  var v = new (require('node:sqlite').DatabaseSync)(file, {readOnly: true});
  try{
    var qc = v.prepare('PRAGMA quick_check').get().quick_check;
    var rows = v.prepare('SELECT COUNT(*) AS n FROM rows').get().n;
    record.integrity = qc === 'ok' ? 'ok' : 'FAILED:' + qc;
    record.rows = rows;
  } finally {
    v.close();
  }
  if(record.integrity !== 'ok'){
    fs.rmSync(file, {force: true});
    throw new Error('backup failed integrity check: ' + record.integrity);
  }

  fs.writeFileSync(path.join(dest, base + '.json'), JSON.stringify(record, null, 2));
  pruneBackups(db, opts);
  dbModule.metaSet(db, 'last_backup_at', record.createdAt);
  dbModule.metaSet(db, 'last_backup_name', record.name);
  return record;
}

/* Retention: keep the most recent `retain` backups (nightly cadence →
   7 days by default). Emergency pre-restore copies are never pruned. */
function pruneBackups(db, opts){
  var retain = Number((opts && opts.retain) ||
    dbModule.metaGet(db, 'backup_retain') || 7);
  var dest = backupDir(db, (opts && opts.dir));
  if(!fs.existsSync(dest)) return;
  var files = fs.readdirSync(dest)
    .filter(function(f){ return /^rsms-school-.*\.sqlite$/.test(f); })
    .sort(); /* name embeds timestamp → lexicographic = chronological */
  var excess = files.length - retain;
  for(var i = 0; i < excess; i++){
    fs.rmSync(path.join(dest, files[i]), {force: true});
    fs.rmSync(path.join(dest, files[i].replace(/\.sqlite$/, '.json')), {force: true});
  }
}

function setBackupRetain(db, retain){
  dbModule.metaSet(db, 'backup_retain', String(Number(retain) || 7));
}

function listBackups(db, opts){
  var dest = backupDir(db, opts && opts.dir);
  if(!fs.existsSync(dest)) return [];
  return fs.readdirSync(dest)
    .filter(function(f){ return /^rsms-school-.*\.json$/.test(f); })
    .sort()
    .reverse()
    .map(function(f){
      try { return JSON.parse(fs.readFileSync(path.join(dest, f), 'utf8')); }
      catch(e){ return {name: f.replace(/\.json$/, '.sqlite'), corrupt: true}; }
    });
}

function getBackupRecord(db, name, opts){
  var dest = backupDir(db, opts && opts.dir);
  var json = path.join(dest, name.replace(/\.sqlite$/, '') + '.json');
  if(!fs.existsSync(json)) return null;
  return JSON.parse(fs.readFileSync(json, 'utf8'));
}

function preRestoreCopy(db, destDir){
  var dir = path.join(backupDir(db, destDir), 'pre-restore');
  fs.mkdirSync(dir, {recursive: true});
  var file = path.join(dir, 'rsms-school-' + stamp() + '-pre-restore.sqlite');
  db.prepare('VACUUM INTO ?').get(file);
  return file;
}

/* Restore a verified backup into the live database.
   confirm: {schoolCode, createdAt} must match the candidate's binding
   and the backup timestamp the operator is looking at. */
function restoreBackup(db, name, confirm){
  var dest = backupDir(db);
  var file = path.join(dest, name);
  if(!fs.existsSync(file)) throw new Error('backup not found: ' + name);
  var record = getBackupRecord(db, name);
  if(!record) throw new Error('backup metadata missing for ' + name);
  if(record.sha256 && sha256File(file) !== record.sha256)
    throw new Error('backup hash mismatch — file changed after verification');
  if(record.integrity !== 'ok')
    throw new Error('backup was not verified at creation time');
  if(!confirm || confirm.schoolCode !== (record.schoolBinding && record.schoolBinding.schoolCode))
    throw new Error('school code confirmation does not match the backup');
  if(!confirm || confirm.createdAt !== record.createdAt)
    throw new Error('backup timestamp confirmation does not match');

  /* Candidate integrity + identity, checked on the real file. */
  var v = new (require('node:sqlite').DatabaseSync)(file, {readOnly: true});
  var candidate = {integrity: null, binding: null, schemaVersion: null, tables: {}};
  try{
    candidate.integrity = v.prepare('PRAGMA integrity_check').get().integrity_check;
    if(candidate.integrity !== 'ok') throw new Error('candidate failed integrity_check');
    var sv = v.prepare('SELECT value FROM meta WHERE key = \'schema_version\'').get();
    candidate.schemaVersion = sv ? Number(sv.value) : null;
    var b = v.prepare('SELECT value FROM meta WHERE key = \'school_binding\'').get();
    candidate.binding = b && b.value ? JSON.parse(b.value) : null;
    v.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all()
      .forEach(function(t){ candidate.tables[t.name] = true; });
  } finally {
    v.close();
  }
  if(candidate.schemaVersion !== dbModule.SCHEMA_VERSION)
    throw new Error('candidate schema v' + candidate.schemaVersion +
      ' does not match server v' + dbModule.SCHEMA_VERSION + ' — apply updates first');
  var live = sync.binding(db);
  if(candidate.binding && live &&
     (candidate.binding.schoolCode !== live.schoolCode ||
      candidate.binding.schoolId !== live.schoolId)){
    throw new Error('backup belongs to a different school — restore refused');
  }

  /* 1. emergency copy of the current state (never pruned) */
  var emergency = preRestoreCopy(db);
  /* 2. stop writes for the duration */
  dbModule.metaSet(db, 'maintenance', dbModule.nowIso());
  try{
    dbModule.withTransaction(db, function(){
      /* 3. transactional swap: every live table becomes the candidate's. */
      db.exec("ATTACH DATABASE '" + file.replace(/'/g, "''") + "' AS cand");
      var tables = db.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\'').all();
      tables.forEach(function(t){
        db.exec('DELETE FROM ' + t.name);
        db.exec('INSERT INTO ' + t.name + ' SELECT * FROM cand."' + t.name + '"');
      });
    });
    /* A database used inside a transaction cannot be detached until the
       transaction ends. */
    try { db.exec('DETACH DATABASE cand'); } catch(e){ /* already detached */ }
  } catch(e){
    dbModule.metaSet(db, 'maintenance', '');
    throw new Error('restore failed (emergency copy at ' +
      path.basename(emergency) + '): ' + e.message);
  }
  dbModule.metaSet(db, 'maintenance', '');
  dbModule.metaSet(db, 'last_restore_at', dbModule.nowIso());
  dbModule.metaSet(db, 'last_restore_backup', name);
  return {
    ok: true,
    restored: name,
    emergencyCopy: emergency,
    note: 'Review outbox and Bursar Conflict Review before normal operation.'
  };
}

function inMaintenance(db){
  return Boolean(dbModule.metaGet(db, 'maintenance'));
}

/* Reject business writes while a restore is in flight. */
function guardMaintenance(db, res){
  if(!inMaintenance(db)) return true;
  res.status(503).json({error: 'server restoring backup — writes paused'});
  return false;
}

module.exports = {
  stamp:stamp,
  backupDir:backupDir,
  setBackupDir:setBackupDir,
  setBackupRetain:setBackupRetain,
  createBackup:createBackup,
  listBackups:listBackups,
  getBackupRecord:getBackupRecord,
  preRestoreCopy:preRestoreCopy,
  restoreBackup:restoreBackup,
  inMaintenance:inMaintenance,
  guardMaintenance:guardMaintenance
};
