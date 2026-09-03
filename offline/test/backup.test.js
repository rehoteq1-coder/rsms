'use strict';

/* Phase C: verified backup & restore.
   Covers acceptance check #8: a backup/restore drill preserves school
   binding, local UUIDs, outbox state, and audit evidence. */

var assert = require('node:assert/strict');
var test = require('node:test');
var fs = require('fs');
var os = require('os');
var path = require('path');

var dbModule = require('../server/db');
var sync = require('../server/sync');
var backup = require('../server/backup');

function makeEnv(){
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsms-backup-test-'));
  var dbFile = path.join(tmp, 'school.sqlite');
  var db = dbModule.openDatabase(dbFile);
  return {tmp: tmp, db: db, dbFile: dbFile,
    cleanup: function(){ fs.rmSync(tmp, {recursive: true, force: true}); }};
}

function seed(env, extra){
  sync.setBinding(env.db, {schoolCode: 'GREENVAL', schoolId: 'green-valley-sec',
    schoolName: 'Green Valley Secondary', cloudValidated: true});
  dbModule.saveCollection(env.db, 'green-valley-sec', 'students', [
    {id: 's1', name: 'Ada', updatedAt: '2026-08-01T00:00:00Z'},
    {id: 's2', name: 'Ben', updatedAt: '2026-08-01T00:00:00Z'}
  ], 'admin');
  dbModule.saveCollection(env.db, 'green-valley-sec', 'payments',
    [{id: 'p1', studentId: 's1', amount: 5000, status: 'Pending'}], 'bursar');
  if(extra) extra(env);
}

test('backup: verified snapshot with sidecar, hash and retention metadata', function(){
  var env = makeEnv();
  try{
    seed(env);
    var record = backup.createBackup(env.db, {retain: 7});
    assert.ok(fs.existsSync(path.join(backup.backupDir(env.db), record.name)));
    assert.ok(/^[0-9a-f]{64}$/.test(record.sha256));
    assert.equal(record.integrity, 'ok');
    assert.equal(record.rows, 3);
    assert.equal(record.schoolBinding.schoolCode, 'GREENVAL');
    assert.equal(record.outbox.byStatus.pending.count, 3);
    assert.equal(dbModule.metaGet(env.db, 'last_backup_name'), record.name);
    assert.equal(backup.listBackups(env.db).length, 1);
  } finally { env.cleanup(); }
});

test('restore: drill preserves binding, UUIDs, outbox and audit evidence', function(){
  var env = makeEnv();
  try{
    seed(env, function(e){
      e.db.prepare('INSERT INTO audit_log (id, actor, action, entity, detail, created_at) ' +
        'VALUES (?,?,?,?,?,?)').run('aud-1', 'bursar', 'cash-receipt', 'payments/p1',
        'evidence', '2026-08-02T00:00:00Z');
    });
    var record = backup.createBackup(env.db);

    /* The school keeps working after the backup, then a fault happens. */
    dbModule.saveCollection(env.db, 'green-valley-sec', 'students', [
      {id: 's1', name: 'Ada CHANGED', updatedAt: '2026-08-05T00:00:00Z'}
    ], 'admin');
    dbModule.saveCollection(env.db, 'green-valley-sec', 'students', [
      {id: 's3', name: 'Late row', updatedAt: '2026-08-05T00:00:00Z'}
    ], 'admin');
    env.db.prepare('DELETE FROM rows WHERE local_id = ? AND collection = \'payments\'').run('p1');
    assert.equal(dbModule.collectionCount(env.db, 'payments'), 0);

    var result = backup.restoreBackup(env.db, record.name,
      {schoolCode: 'GREENVAL', createdAt: record.createdAt});
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.emergencyCopy), 'pre-restore emergency copy kept');

    /* State is back to the backup point. */
    assert.equal(dbModule.collectionCount(env.db, 'students'), 2);
    assert.equal(dbModule.collectionCount(env.db, 'payments'), 1);
    var s1 = dbModule.readCollection(env.db, 'students').find(function(r){ return r.id === 's1'; });
    assert.equal(s1.name, 'Ada', 'local row restored to backup content');
    var audit = env.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE id = ?').get('aud-1');
    assert.equal(audit.n, 1, 'audit evidence preserved');
    var outbox = env.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status = \'pending\'').get();
    assert.equal(outbox.n, 3, 'outbox state preserved');
    assert.equal(sync.binding(env.db).schoolCode, 'GREENVAL', 'binding preserved');
    assert.ok(dbModule.metaGet(env.db, 'last_restore_at'));
  } finally { env.cleanup(); }
});

test('restore: confirmations, tampering and foreign schools are refused', function(){
  var env = makeEnv();
  try{
    seed(env);
    var record = backup.createBackup(env.db);
    var file = path.join(backup.backupDir(env.db), record.name);

    assert.throws(function(){
      backup.restoreBackup(env.db, record.name, {schoolCode: 'WRONG', createdAt: record.createdAt});
    }, /school code/);
    assert.throws(function(){
      backup.restoreBackup(env.db, record.name, {schoolCode: 'GREENVAL', createdAt: 'nope'});
    }, /timestamp/);
    assert.throws(function(){
      backup.restoreBackup(env.db, 'does-not-exist.sqlite',
        {schoolCode: 'GREENVAL', createdAt: record.createdAt});
    }, /not found/);

    /* Tampered backup file fails the hash check. */
    fs.appendFileSync(file, 'garbage');
    assert.throws(function(){
      backup.restoreBackup(env.db, record.name,
        {schoolCode: 'GREENVAL', createdAt: record.createdAt});
    }, /hash mismatch/);
    fs.truncateSync(file, fs.statSync(file).size - 7);

    /* Candidate bound to a different school is refused. */
    var other = dbModule.openDatabase(path.join(env.tmp, 'other.sqlite'));
    sync.setBinding(other, {schoolCode: 'OTHERSCHOOL', schoolId: 'other-sec'});
    var otherRecord = backup.createBackup(other, {dir: backup.backupDir(env.db), suffix: 'other'});
    assert.throws(function(){
      backup.restoreBackup(env.db, otherRecord.name,
        {schoolCode: 'OTHERSCHOOL', createdAt: otherRecord.createdAt});
    }, /different school/);
  } finally { env.cleanup(); }
});

test('restore: schema version mismatch is refused', function(){
  var env = makeEnv();
  try{
    seed(env);
    var record = backup.createBackup(env.db);
    var file = path.join(backup.backupDir(env.db), record.name);
    var w = new (require('node:sqlite').DatabaseSync)(file);
    w.prepare('INSERT INTO meta (key, value) VALUES (\'schema_version\', \'1\') ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run();
    w.close();
    /* Re-verify the (now modified) candidate so the hash check passes and
       the schema guard is what trips. */
    var h = require('crypto').createHash('sha256')
      .update(fs.readFileSync(file)).digest('hex');
    var sidecarFile = path.join(backup.backupDir(env.db), record.name.replace(/\.sqlite$/, '.json'));
    var sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
    sidecar.sha256 = h;
    fs.writeFileSync(sidecarFile, JSON.stringify(sidecar));
    assert.throws(function(){
      backup.restoreBackup(env.db, record.name,
        {schoolCode: 'GREENVAL', createdAt: record.createdAt});
    }, /schema v1/);
  } finally { env.cleanup(); }
});

test('retention: keeps the most recent N, never prunes emergency copies', function(){
  var env = makeEnv();
  try{
    seed(env);
    var dir = backup.backupDir(env.db);
    /* Suffixes keep names unique and lexicographically ordered. */
    for(var i = 0; i < 9; i++){
      backup.createBackup(env.db, {retain: 7, suffix: 'b' + i});
    }
    var kept = fs.readdirSync(dir).filter(function(f){ return /^rsms-school-.*\.sqlite$/.test(f); }).sort();
    assert.equal(kept.length, 7, 'retention keeps 7: ' + kept.join(','));
    assert.equal(kept[0], kept[0].includes('b2') ? kept[0] : 'expected b2 first',
      'oldest two pruned');
    assert.ok(kept.indexOf(kept[0]) >= 0 && !/b0|b1/.test(kept.join(',')),
      'b0 and b1 pruned');

    /* Emergency copies survive pruning. */
    var emergency = backup.preRestoreCopy(env.db);
    backup.createBackup(env.db, {retain: 7, suffix: 'x'});
    assert.ok(fs.existsSync(emergency), 'pre-restore copy not pruned');
  } finally { env.cleanup(); }
});

test('maintenance: writes are refused while a restore is in flight', function(){
  var env = makeEnv();
  try{
    seed(env);
    var record = backup.createBackup(env.db);
    dbModule.metaSet(env.db, 'maintenance', dbModule.nowIso());
    assert.equal(backup.inMaintenance(env.db), true);
    var res = {status: function(c){ this.code = c; return this; }, json: function(b){ this.body = b; }};
    assert.equal(backup.guardMaintenance(env.db, res), false);
    assert.equal(res.code, 503);
    dbModule.metaSet(env.db, 'maintenance', '');
    assert.equal(backup.guardMaintenance(env.db, {status:function(){return this;}, json:function(){}}), true);

    /* A completed restore clears the flag even after mid-restore faults
       are impossible here — verify flag is clear after a good restore. */
    var r = backup.restoreBackup(env.db, record.name,
      {schoolCode: 'GREENVAL', createdAt: record.createdAt});
    assert.equal(r.ok, true);
    assert.equal(backup.inMaintenance(env.db), false);
  } finally { env.cleanup(); }
});
