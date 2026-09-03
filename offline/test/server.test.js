'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var dbModule = require('../server/db');
var auth = require('../server/auth');
var {createApp} = require('../server/index');

function newDb(){
  return dbModule.openDatabase(':memory:');
}

function cookieFrom(res){
  var cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  var hit = cookies.find(function(c){ return c.indexOf('rsms_offline_session=') === 0; });
  return hit ? hit.split(';')[0] : null;
}

async function api(base, path, options){
  options = options || {};
  var res = await fetch(base + path, {
    method: options.method || 'GET',
    headers: Object.assign(
      options.body ? {'Content-Type': 'application/json'} : {},
      options.cookie ? {Cookie: options.cookie} : {}
    ),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  var text = await res.text();
  var json = null;
  try { json = JSON.parse(text); } catch(e){}
  return {status: res.status, json: json, text: text, res: res};
}

function startServer(db){
  var app = createApp({db: db});
  var server = app.listen(0, '127.0.0.1');
  return new Promise(function(resolve){
    server.on('listening', function(){
      resolve({server: server, base: 'http://127.0.0.1:' + server.address().port});
    });
  });
}

function stopServer(h){
  return new Promise(function(resolve){
    if(typeof h.server.closeAllConnections === 'function') h.server.closeAllConnections();
    h.server.close(resolve);
  });
}

test('credential hashing is salted and rejects wrong PINs', function(){
  var a = auth.hashCredential('1234');
  var b = auth.hashCredential('1234');
  assert.notEqual(a.salt, b.salt);
  assert.equal(auth.verifyCredential('1234', a.hash, a.salt), true);
  assert.equal(auth.verifyCredential('1235', a.hash, a.salt), false);
  assert.equal(auth.verifyCredential('', a.hash, a.salt), false);
});

test('session lifecycle: create, read, revoke, wrong cookie', function(){
  var db = newDb();
  var token = auth.createSession(db, 'admin1', 'admin');
  var session = auth.readSession(db, 'rsms_offline_session=' + token);
  assert.equal(session.username, 'admin1');
  auth.revokeSession(db, token);
  assert.equal(auth.readSession(db, 'rsms_offline_session=' + token), null);
  assert.equal(auth.readSession(db, 'rsms_offline_session=' + 'f'.repeat(64)), null);
});

test('row identity is stable and outbox intents stay idempotent', function(){
  var db = newDb();
  var row = {id: 'stu-1', name: 'Ada', class: 'JSS1'};
  dbModule.saveCollection(db, 'school-a', 'students', [row], 'tester');
  var first = db.prepare('SELECT id FROM outbox WHERE collection = \'students\'').all();
  assert.equal(first.length, 1);
  /* Saving again must refresh the SAME intent, not create a duplicate. */
  dbModule.saveCollection(db, 'school-a', 'students', [{id: 'stu-1', name: 'Ada O.', class: 'JSS1'}], 'tester');
  var second = db.prepare('SELECT id FROM outbox WHERE collection = \'students\'').all();
  assert.equal(second.length, 1);
  assert.equal(second[0].id, first[0].id);
  var rows = dbModule.readCollection(db, 'students');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ada O.');
  var versions = db.prepare('SELECT row_version, sync_state FROM rows WHERE collection = \'students\'').all();
  assert.equal(versions[0].row_version, 2);
  assert.equal(versions[0].sync_state, 'pending');
});

test('server: bootstrap, login, bind, collection round-trip, auth gates', async function(){
  var db = newDb();
  var h = await startServer(db);
  try{
    /* Unauthenticated data access is refused. */
    var anon = await api(h.base, '/api/school/collections');
    assert.equal(anon.status, 401);

    /* Bootstrap (first user only). */
    var boot = await api(h.base, '/api/bootstrap', {method: 'POST', body: {
      username: 'admin1', displayName: 'School Admin', role: 'admin', pin: '1234'
    }});
    assert.equal(boot.status, 200);
    var again = await api(h.base, '/api/bootstrap', {method: 'POST', body: {
      username: 'other', role: 'admin', pin: '9999'
    }});
    assert.equal(again.status, 409);

    /* Login with wrong PIN fails; right PIN sets the session cookie. */
    var bad = await api(h.base, '/api/auth/login', {method: 'POST', body: {username: 'admin1', pin: '9999'}});
    assert.equal(bad.status, 401);
    var login = await api(h.base, '/api/auth/login', {method: 'POST', body: {username: 'admin1', pin: '1234'}});
    assert.equal(login.status, 200);
    assert.equal(login.json.bootstrapPending, true);
    var cookie = cookieFrom(login.res);
    assert.ok(cookie);

    var me = await api(h.base, '/api/whoami', {cookie: cookie});
    assert.equal(me.json.username, 'admin1');
    assert.equal(me.json.role, 'admin');

    /* Bind the school (admin only). */
    var bind = await api(h.base, '/api/setup/bind', {method: 'POST', cookie: cookie, body: {
      schoolCode: 'GREENVAL', schoolId: 'green-valley-sec', schoolName: 'Green Valley Secondary'
    }});
    assert.equal(bind.status, 200);
    assert.equal(bind.json.cloudValidated, false);

    /* Collection round-trip. */
    var students = [
      {id: 'stu-1', name: 'Ada Obi', class: 'JSS1'},
      {id: 'stu-2', name: 'Chinedu Eze', class: 'JSS1'}
    ];
    var put = await api(h.base, '/api/school/collections/students', {method: 'PUT', cookie: cookie, body: {rows: students}});
    assert.equal(put.status, 200);
    assert.equal(put.json.changed, 2);
    assert.equal(put.json.outbox.byStatus.pending.count, 2);

    var get = await api(h.base, '/api/school/collections/students', {cookie: cookie});
    assert.equal(get.json.rows.length, 2);
    assert.equal(get.json.rows[0].id, 'stu-1');

    /* Re-save: same outbox intent ids (idempotency across retries). */
    var outbox1 = await api(h.base, '/api/school/outbox', {cookie: cookie});
    assert.equal(outbox1.json.entries.length, 2);
    var ids1 = outbox1.json.entries.map(function(e){ return e.id; }).sort();
    await api(h.base, '/api/school/collections/students', {method: 'PUT', cookie: cookie, body: {rows: students}});
    var outbox2 = await api(h.base, '/api/school/outbox', {cookie: cookie});
    assert.equal(outbox2.json.entries.length, 2);
    assert.deepEqual(outbox2.json.entries.map(function(e){ return e.id; }).sort(), ids1);

    /* Unknown collection rejected. */
    var unknown = await api(h.base, '/api/school/collections/evil', {cookie: cookie});
    assert.equal(unknown.status, 404);

    /* Health page. */
    var health = await api(h.base, '/health');
    assert.equal(health.status, 200);
    assert.ok(health.text.indexOf('RSMS Offline Server') !== -1);
    assert.ok(health.text.indexOf('green-valley-sec') !== -1);
  } finally {
    await stopServer(h);
  }
});

test('server: role middleware denies out-of-role access', async function(){
  var db = newDb();
  await api0(db, '/api/bootstrap', {method: 'POST', body: {username: 'admin1', role: 'admin', pin: '1234'}});
  var h = await startServer(db);
  try{
    var adminCookie = await loginCookie(h.base, 'admin1', '1234');
    /* Create a bursar directly (seeding is a bootstrap/cloud-sync concern). */
    var bh = auth.hashCredential('4321');
    db.prepare('INSERT INTO local_users (username, display_name, role, credential_hash, salt, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?)').run('bursar1', 'B', 'bursar', bh.hash, bh.salt, '2026-01-01', '2026-01-01');
    var bursarCookie = await loginCookie(h.base, 'bursar1', '4321');
    await api0(db, '/api/setup/bind', {method: 'POST', cookie: adminCookie, body: {schoolCode: 'X', schoolId: 'x'}});

    var denied = await fetch(h.base + '/api/school/sync/run', {method: 'POST', headers: {Cookie: bursarCookie}});
    assert.equal(denied.status, 403);
    var allowed = await fetch(h.base + '/api/school/outbox', {headers: {Cookie: bursarCookie}});
    assert.equal(allowed.status, 200);
  } finally {
    await stopServer(h);
  }
});

test('server: portal pages are served with self-hosted assets and the LAN adapter', async function(){
  var db = newDb();
  var h = await startServer(db);
  try{
    var res = await fetch(h.base + '/rsms-bursar.html');
    assert.equal(res.status, 200);
    var html = await res.text();
    assert.equal(html.indexOf('gstatic.com'), -1, 'no CDN URLs remain');
    assert.equal(html.indexOf('cdnjs.cloudflare.com'), -1, 'no CDN URLs remain');
    assert.ok(html.indexOf('/vendor/firebase-database-compat.js') !== -1);
    assert.ok(html.indexOf('/adapter.js') !== -1);
    assert.ok(html.indexOf('window.RSMS_LOCAL=') !== -1);

    var adapter = await fetch(h.base + '/adapter.js');
    assert.equal(adapter.status, 200);
    var adapterText = await adapter.text();
    assert.ok(adapterText.indexOf('RSMS LAN data adapter') !== -1);
    assert.ok(adapterText.indexOf('postCollection') !== -1);
  } finally {
    await stopServer(h);
  }
});

/* Helpers that talk to a db without a running server. */
async function api0(db, path, options){
  var app = createApp({db: db});
  var server = app.listen(0, '127.0.0.1');
  await new Promise(function(r){ server.on('listening', r); });
  var base = 'http://127.0.0.1:' + server.address().port;
  try{
    return await api(base, path, options);
  } finally {
    await new Promise(function(r){
      if(typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(r);
    });
  }
}

async function loginCookie(base, username, pin){
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: username, pin: pin})
  });
  return cookieFrom(res);
}

test('server: first-run UI — bootstrap form only before first account; 401 links to staff login', async function(){
  var db = newDb();
  var h = await startServer(db);
  try{
    /* Before the first account exists, the login page offers the
       create-first-account form (the old build had no UI for
       /api/bootstrap — a first-run deadlock). */
    var page1 = await api(h.base, '/staff-login.html');
    assert.equal(page1.status, 200);
    assert.ok(page1.text.indexOf('Create the first staff account') >= 0,
      'bootstrap form visible on first run');
    assert.ok(page1.text.indexOf('/api/bootstrap') >= 0,
      'page posts to /api/bootstrap');

    /* The auth gate links to the real staff login page. */
    var gate = await api(h.base, '/wizard.html');
    assert.equal(gate.status, 401);
    assert.ok(gate.text.indexOf('/staff-login.html') >= 0,
      '401 page links to /staff-login.html');

    /* Create the first account via the same call the page makes. */
    var boot = await api(h.base, '/api/bootstrap', {method: 'POST', body: {
      username: 'admin1', displayName: 'School Admin', role: 'admin', pin: '1234'
    }});
    assert.equal(boot.status, 200);

    var page2 = await api(h.base, '/staff-login.html');
    assert.ok(page2.text.indexOf('Create the first staff account') < 0,
      'bootstrap form hidden after the first account exists');
    assert.ok(page2.text.indexOf('first-run wizard') >= 0,
      'unbound hint points to the first-run wizard');
    assert.ok(page2.text.indexOf('rsms-bursar.html') >= 0,
      'login page carries the role-page redirect map (staff land on their role page, not the public landing page)');

    /* Login reports bound:false so the client lands on the wizard. */
    var login = await api(h.base, '/api/auth/login', {method: 'POST', body: {
      username: 'admin1', pin: '1234'
    }});
    assert.equal(login.status, 200);
    assert.equal(login.json.bound, false);
  } finally {
    await stopServer(h);
  }
});

test('server: LAN entry redirects — / and /rsms-login.html go to the staff entry', async function(){
  var db = newDb();
  var h = await startServer(db);
  try{
    /* Not signed in: both the public landing page and the cloud email
       login redirect to the PIN sign-in (cloud-only flows on a LAN
       appliance confuse staff). */
    var anon1 = await fetch(h.base + '/', {redirect: 'manual'});
    assert.equal(anon1.status, 302);
    assert.equal(anon1.headers.get('location'), '/staff-login.html');
    var anon2 = await fetch(h.base + '/rsms-login.html', {redirect: 'manual'});
    assert.equal(anon2.status, 302);
    assert.equal(anon2.headers.get('location'), '/staff-login.html');

    /* Signed-in admin on a bound school: / goes straight to the
       role page. */
    await api(h.base, '/api/bootstrap', {method: 'POST', body: {
      username: 'admin1', displayName: 'Admin', role: 'admin', pin: '1234'
    }});
    var login = await api(h.base, '/api/auth/login', {method: 'POST', body: {
      username: 'admin1', pin: '1234'
    }});
    var cookie = cookieFrom(login.res);
    assert.ok(cookie);
    var bind = await api(h.base, '/api/setup/bind', {method: 'POST', cookie: cookie, body: {
      schoolCode: 'TESTSCHOOL', schoolName: 'Test School'
    }});
    assert.equal(bind.status, 200);
    var root = await fetch(h.base + '/', {redirect: 'manual', headers: {Cookie: cookie}});
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/rsms-admin.html');
  } finally {
    await stopServer(h);
  }
});
