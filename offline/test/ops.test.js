'use strict';

/* Phase C: first-run wizard, verified backups, restore, diagnostics —
   over HTTP, with auth gates. The diagnostic bundle must never leak
   secrets (server token, cloud base URL credentials). */

var assert = require('node:assert/strict');
var test = require('node:test');
var fs = require('fs');
var os = require('os');
var path = require('path');

var db = require('../server/db');
var sync = require('../server/sync');
var mod = require('../server/index');

function api(base, cookiePath, method, urlPath, body){
  var options = {method: method, headers: {'Content-Type': 'application/json'}};
  var cookie = fs.existsSync(cookiePath) ? fs.readFileSync(cookiePath, 'utf8').trim() : '';
  if(cookie) options.headers.Cookie = cookie;
  if(body !== undefined) options.body = JSON.stringify(body);
  return fetch(base + urlPath, options).then(function(res){
    var setCookie = res.headers.get('set-cookie');
    if(setCookie) fs.writeFileSync(cookiePath, setCookie.split(';')[0]);
    var ct = res.headers.get('content-type') || '';
    return res.clone().text().then(function(text){
      var json = null;
      if(ct.indexOf('json') !== -1){
        try { json = JSON.parse(text); } catch(e){}
      }
      return {status: res.status, json: json, text: text,
        download: res.headers.get('content-disposition') || ''};
    });
  });
}

async function startLocal(){
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsms-ops-test-'));
  var localDb = db.openDatabase(path.join(tmp, 'test.sqlite'));
  var app = mod.createApp({db: localDb});
  var server = app.listen(0, '127.0.0.1');
  await new Promise(function(r){ server.on('listening', r); });
  var base = 'http://127.0.0.1:' + server.address().port;
  var cookiePath = path.join(tmp, 'cookie.txt');
  return {
    localDb: localDb, base: base, cookiePath: cookiePath, tmp: tmp,
    stop: async function(){
      fs.rmSync(tmp, {recursive: true, force: true});
      await new Promise(function(r){
        if(typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(r);
      });
    }
  };
}

async function bootstrapAdmin(h, pin){
  var r = await api(h.base, h.cookiePath, 'POST', '/api/bootstrap',
    {username: 'admin', pin: pin, role: 'admin', name: 'Admin'});
  assert.equal(r.status, 200, 'bootstrap: ' + r.text);
  r = await api(h.base, h.cookiePath, 'POST', '/api/auth/login',
    {username: 'admin', pin: pin});
  assert.equal(r.status, 200, 'login');
}

test('ops: wizard info, page, backup + restore flow, diagnostics without secrets', async function(){
  var h = await startLocal();
  try{
    await bootstrapAdmin(h, '123456');
    var bind = await api(h.base, h.cookiePath, 'POST', '/api/setup/bind',
      {schoolCode: 'GREENVAL', schoolId: 'green-valley-sec'});
    assert.equal(bind.status, 200, bind.text);

    /* Bind some data, including a payment (money evidence). */
    await api(h.base, h.cookiePath, 'PUT', '/api/school/collections/students',
      {rows: [{id: 's1', name: 'Ada', updatedAt: '2026-08-01T00:00:00Z'}]});
    await api(h.base, h.cookiePath, 'PUT', '/api/school/collections/payments',
      {rows: [{id: 'p1', studentId: 's1', amount: 5000, status: 'Pending'}]});

    /* Wizard info. */
    var info = await api(h.base, h.cookiePath, 'GET', '/api/wizard/info');
    assert.equal(info.status, 200);
    assert.equal(info.json.binding.schoolCode, 'GREENVAL');
    assert.ok(Array.isArray(info.json.lan));
    assert.ok(info.json.backup && typeof info.json.backup.dir === 'string');
    assert.ok(!JSON.stringify(info.json).includes('SECRET-TOKEN-VALUE-abc123'),
      'wizard info must not leak the server token');

    /* Wizard page renders. */
    var page = await api(h.base, h.cookiePath, 'GET', '/wizard.html');
    assert.equal(page.status, 200);
    assert.ok(page.text.indexOf('First-run') !== -1 || page.text.indexOf('first-run') !== -1);
    assert.ok(page.text.indexOf('qrcode.min.js') !== -1);

    /* Manual backup. */
    var mk = await api(h.base, h.cookiePath, 'POST', '/api/admin/backup', {});
    assert.equal(mk.status, 200, mk.text);
    assert.equal(mk.json.ok, true);
    assert.equal(mk.json.backup.integrity, 'ok');
    assert.equal(mk.json.backup.rows, 2);

    var list = await api(h.base, h.cookiePath, 'GET', '/api/admin/backups');
    assert.equal(list.json.backups.length, 1);

    /* Health page shows backup + service rows. */
    var health = await api(h.base, h.cookiePath, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.ok(health.text.indexOf('Backups') !== -1);
    assert.ok(health.text.indexOf('Service') !== -1);

    /* Damage the live data, then restore through the API. */
    h.localDb.prepare('DELETE FROM rows WHERE local_id = ? AND collection = \'payments\'').run('p1');
    var restore = await api(h.base, h.cookiePath, 'POST',
      '/api/admin/backups/' + mk.json.backup.name + '/restore',
      {schoolCode: 'GREENVAL', createdAt: mk.json.backup.createdAt});
    assert.equal(restore.status, 200, restore.text);
    assert.equal(restore.json.ok, true);
    assert.ok(fs.existsSync(restore.json.emergencyCopy));
    assert.equal(h.localDb.prepare(
      'SELECT COUNT(*) AS n FROM rows WHERE collection = \'payments\'').get().n, 1,
      'payment row restored');

    /* Restore with a wrong confirmation is refused. */
    var bad = await api(h.base, h.cookiePath, 'POST',
      '/api/admin/backups/' + mk.json.backup.name + '/restore',
      {schoolCode: 'WRONG', createdAt: mk.json.backup.createdAt});
    assert.equal(bad.status, 400);

    /* Diagnostics: present, downloadable, and free of secrets. */
    var diag = await api(h.base, h.cookiePath, 'GET', '/api/admin/diag');
    assert.equal(diag.status, 200);
    assert.equal(diag.json.school.schoolCode, 'GREENVAL');
    assert.ok(diag.json.sync.outbox);
    assert.ok(diag.json.auditRecent.length >= 1);
    var dl = await api(h.base, h.cookiePath, 'GET', '/api/admin/diag.download');
    assert.equal(dl.status, 200);
    assert.ok(/attachment/.test(dl.download));
    assert.ok(dl.text.indexOf('SECRET-TOKEN-VALUE-abc123') === -1,
      'diagnostics must not leak the server token');
    assert.ok(dl.text.indexOf('server_token') === -1);
  } finally {
    await h.stop();
  }
});

test('ops: admin endpoints are admin-only; writes paused during maintenance', async function(){
  var h = await startLocal();
  try{
    await bootstrapAdmin(h, '123456');

    /* Create a bursar directly (seeding is bootstrap/cloud-sync territory). */
    var auth = require('../server/auth');
    var bh = auth.hashCredential('654321');
    h.localDb.prepare('INSERT INTO local_users (username, display_name, role, credential_hash, salt, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?)').run('bursar1', 'B', 'bursar', bh.hash, bh.salt, '2026-01-01', '2026-01-01');
    var cookiePath2 = path.join(h.tmp, 'bursar2.txt');
    var b = await api(h.base, cookiePath2, 'POST', '/api/auth/login',
      {username: 'bursar1', pin: '654321'});
    assert.equal(b.status, 200);

    var r1 = await api(h.base, cookiePath2, 'GET', '/api/admin/backups');
    assert.equal(r1.status, 403, 'bursar cannot list backups');
    var r2 = await api(h.base, cookiePath2, 'GET', '/api/admin/diag');
    assert.equal(r2.status, 403, 'bursar cannot read diagnostics');
    var r3 = await api(h.base, cookiePath2, 'POST', '/api/admin/backup', {});
    assert.equal(r3.status, 403, 'bursar cannot run backups');

    /* Unauthenticated. */
    var r4 = await api(h.base, path.join(h.tmp, 'none.txt'), 'GET', '/api/wizard/info');
    assert.equal(r4.status, 401);

    /* Maintenance pauses business writes. */
    await api(h.base, h.cookiePath, 'POST', '/api/setup/bind',
      {schoolCode: 'GREENVAL', schoolId: 'green-valley-sec'});
    db.metaSet(h.localDb, 'maintenance', db.nowIso());
    var put = await api(h.base, h.cookiePath, 'PUT', '/api/school/collections/students',
      {rows: [{id: 's9', name: 'X'}]});
    assert.equal(put.status, 503, 'writes refused during restore: ' + put.text);
    db.metaSet(h.localDb, 'maintenance', '');
    var put2 = await api(h.base, h.cookiePath, 'PUT', '/api/school/collections/students',
      {rows: [{id: 's9', name: 'X'}]});
    assert.equal(put2.status, 200, 'writes resume after restore');
  } finally {
    await h.stop();
  }
});
