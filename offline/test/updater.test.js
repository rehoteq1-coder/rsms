'use strict';

/* Phase C: signed release updater. The test signs its own keypair;
   the embedded production key stays a placeholder until the operator
   generates the real signing identity (docs/pilot-playbook.md). */

var assert = require('node:assert/strict');
var test = require('node:test');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');

var dbModule = require('../server/db');
var updater = require('../server/updater');

function makeKey(){
  var kp = crypto.generateKeyPairSync('ed25519');
  return {
    public: kp.publicKey.export({type: 'spki', format: 'der'}).toString('base64'),
    sign: function(payload){
      return crypto.sign(null, Buffer.from(payload, 'utf8'), kp.privateKey)
        .toString('base64');
    }
  };
}

function makeRelease(dir, key, version, files){
  fs.mkdirSync(dir, {recursive: true});
  var hashes = {};
  Object.keys(files).forEach(function(rel){
    var f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(f, files[rel]);
    hashes[rel] = crypto.createHash('sha256')
      .update(fs.readFileSync(f)).digest('hex');
  });
  var manifest = {version: version, releasedAt: '2026-09-01T00:00:00Z',
    files: hashes};
  manifest.signature = key.sign(updater.canonical(
    {version: manifest.version, releasedAt: manifest.releasedAt, files: manifest.files}));
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(manifest));
  return manifest;
}

function makeEnv(){
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsms-update-test-'));
  var db = dbModule.openDatabase(path.join(tmp, 'school.sqlite'));
  dbModule.saveCollection(db, 'gvs', 'students', [{id: 's1', name: 'Ada'}], 'admin');
  return {tmp: tmp, db: db,
    cleanup: function(){ fs.rmSync(tmp, {recursive: true, force: true}); }};
}

test('updater: signed release applies with backup + pending restart flag', function(){
  var env = makeEnv();
  var key = makeKey();
  try{
    var releaseDir = path.join(env.tmp, 'release');
    var target = path.join(env.tmp, 'target');
    fs.mkdirSync(path.join(target, 'server'), {recursive: true});
    fs.writeFileSync(path.join(target, 'server', 'old.txt'), 'old');
    makeRelease(releaseDir, key, '9.9.9', {'server/old.txt': 'new', 'README.txt': 'hi'});

    var result = updater.applyRelease(releaseDir,
      {db: env.db, publicKey: key.public, targetDir: target});
    assert.equal(result.ok, true);
    assert.equal(result.version, '9.9.9');
    assert.equal(fs.readFileSync(path.join(target, 'server', 'old.txt'), 'utf8'), 'new');
    assert.ok(fs.existsSync(path.join(target, 'README.txt')));
    assert.equal(dbModule.metaGet(env.db, 'applied_version'), '9.9.9');
    var pending = updater.pendingRestart(env.db);
    assert.equal(pending.version, '9.9.9');
    /* a pre-update backup was created */
    assert.match(dbModule.metaGet(env.db, 'last_backup_name') || '', /pre-update-9\.9\.9/);
  } finally { env.cleanup(); }
});

test('updater: wrong signature, tampered files and tampered manifests are refused', function(){
  var env = makeEnv();
  var key = makeKey();
  var other = makeKey();
  try{
    var target = path.join(env.tmp, 'target');
    fs.mkdirSync(path.join(target, 'server'), {recursive: true});
    fs.writeFileSync(path.join(target, 'server', 'f.txt'), 'orig');

    /* signed by a different identity */
    var d1 = path.join(env.tmp, 'rel1');
    makeRelease(d1, other, '1.0.0', {'server/f.txt': 'evil'});
    assert.throws(function(){
      updater.applyRelease(d1, {db: env.db, publicKey: key.public, targetDir: target});
    }, /signature verification failed/);
    assert.equal(fs.readFileSync(path.join(target, 'server', 'f.txt'), 'utf8'), 'orig');

    /* file tampered after signing */
    var d2 = path.join(env.tmp, 'rel2');
    makeRelease(d2, key, '2.0.0', {'server/f.txt': 'v2'});
    fs.appendFileSync(path.join(d2, 'server', 'f.txt'), 'x');
    assert.throws(function(){
      updater.applyRelease(d2, {db: env.db, publicKey: key.public, targetDir: target});
    }, /hash mismatch/);
    assert.equal(fs.readFileSync(path.join(target, 'server', 'f.txt'), 'utf8'), 'orig');

    /* manifest tampered after signing (version bumped) */
    var d3 = path.join(env.tmp, 'rel3');
    makeRelease(d3, key, '3.0.0', {'server/f.txt': 'v3'});
    var mf = path.join(d3, 'release-manifest.json');
    var m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    m.version = '3.1.1';
    fs.writeFileSync(mf, JSON.stringify(m));
    assert.throws(function(){
      updater.applyRelease(d3, {db: env.db, publicKey: key.public, targetDir: target});
    }, /signature verification failed/);
  } finally { env.cleanup(); }
});

test('updater: paused during a restore, pending restart clears on boot', function(){
  var env = makeEnv();
  var key = makeKey();
  try{
    var target = path.join(env.tmp, 'target');
    fs.mkdirSync(path.join(target, 'server'), {recursive: true});
    fs.writeFileSync(path.join(target, 'server', 'f.txt'), 'orig');
    var d = path.join(env.tmp, 'rel');
    makeRelease(d, key, '4.0.0', {'server/f.txt': 'v4'});

    dbModule.metaSet(env.db, 'maintenance', dbModule.nowIso());
    assert.throws(function(){
      updater.applyRelease(d, {db: env.db, publicKey: key.public, targetDir: target});
    }, /restore in progress/);
    dbModule.metaSet(env.db, 'maintenance', '');

    var result = updater.applyRelease(d, {db: env.db, publicKey: key.public, targetDir: target});
    assert.equal(result.ok, true);
    assert.ok(updater.pendingRestart(env.db));
    updater.clearPendingRestart(env.db);
    assert.equal(updater.pendingRestart(env.db), null);
  } finally { env.cleanup(); }
});
