'use strict';

/* Phase B sync integration: local offline server + fake cloud functions.
   Fake cloud semantics mirror functions/src/offlineSync.js: idempotent
   intent processing, gateway-settled rows refuse conflicting pushes. */

var assert = require('node:assert/strict');
var test = require('node:test');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var db = require('../server/db');
var sync = require('../server/sync');
var mod = require('../server/index');

/* ── Fake cloud ──────────────────────────────────────────────── */

function createFakeCloud(){
  var state = {
    registration: {token: 'rsms-offline-testtoken-abcdef0123456789', schoolId: 'green-valley-sec'},
    collections: {},   // name -> {rowId: row}
    processed: {}      // intentId -> true
  };
  function rowsOf(name){ return Object.values(state.collections[name] || {}); }
  function settled(row){
    return !!row && (row.status === 'Confirmed' || row.status === 'Rejected') &&
      !!(row.verifiedAt || row.gatewayId || row.verifiedAmount !== undefined);
  }

  var server = http.createServer(function(req, res){
    var chunks = [];
    req.on('data', function(c){ chunks.push(c); });
    req.on('end', function(){
      var body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      var data = body.data || {};
      var respond = function(payload, status){
        status = status || 200;
        res.writeHead(status, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(status >= 400 ? {error: payload, code: status} : {result: payload}));
      };
      if(data.serverToken !== state.registration.token){
        return respond({status:'permission-denied', message:'unknown installation'}, 403);
      }
      if(req.url === '/offlineVerifyServer'){
        return respond({ok: true, schoolId: state.registration.schoolId,
          schoolCode: 'GREENVAL', schoolName: 'Green Valley Secondary', installationId: 'inst-test'});
      }
      if(req.url === '/offlineSyncPush'){
        var applied = [], skipped = [], rejected = [];
        (data.entries || []).forEach(function(entry){
          var id = entry.payload && (entry.payload.id || entry.payload.localId);
          var store = state.collections[entry.collection] || (state.collections[entry.collection] = {});
          if(state.processed[entry.intentId]){
            skipped.push({intentId: entry.intentId, localId: id});
            return;
          }
          var existing = store[id];
          if(existing && settled(existing)){
            var amountOf = function(r){ return r.amount; };
            if(amountOf(existing) !== amountOf(entry.payload) || existing.status !== entry.payload.status){
              rejected.push({intentId: entry.intentId, localId: id,
                reason: 'gateway-settled: row already verified on cloud; conflict required',
                cloudRow: existing});
              return;
            }
          }
          store[id] = entry.payload;
          state.processed[entry.intentId] = true;
          applied.push({intentId: entry.intentId, localId: id});
        });
        return respond({ok: true, schoolId: state.registration.schoolId,
          applied: applied, skipped: skipped, rejected: rejected});
      }
      if(req.url === '/offlineSyncPull'){
        var out = {};
        (data.collections || []).forEach(function(name){ out[name] = rowsOf(name); });
        return respond({ok: true, schoolId: state.registration.schoolId, collections: out});
      }
      respond({status:'not-found', message: req.url}, 404);
    });
  });
  return {
    state: state,
    server: server,
    start: function(){
      return new Promise(function(resolve){
        server.listen(0, '127.0.0.1', function(){
          resolve('http://127.0.0.1:' + server.address().port);
        });
      });
    },
    stop: function(){
      return new Promise(function(resolve){
        if(typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(resolve);
      });
    }
  };
}

/* ── Local harness ───────────────────────────────────────────── */

function api(base, cookiePath, method, urlPath, body){
  var options = {method: method, headers: {'Content-Type': 'application/json'}};
  var cookie = fs.existsSync(cookiePath) ? fs.readFileSync(cookiePath, 'utf8').trim() : '';
  if(cookie) options.headers.Cookie = cookie;
  if(body !== undefined) options.body = JSON.stringify(body);
  return fetch(base + urlPath, options).then(function(res){
    var setCookie = res.headers.get('set-cookie');
    if(setCookie) fs.writeFileSync(cookiePath, setCookie.split(';')[0]);
    return res.json().catch(function(){ return {}; }).then(function(json){
      return {status: res.status, json: json};
    });
  });
}

async function startLocal(){
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsms-sync-test-'));
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

async function bootstrapAdmin(h){
  var r = await api(h.base, h.cookiePath, 'POST', '/api/bootstrap',
    {username: 'admin', pin: '123456', role: 'admin', name: 'Admin'});
  assert.equal(r.status, 200, 'bootstrap');
  r = await api(h.base, h.cookiePath, 'POST', '/api/auth/login', {username: 'admin', pin: '123456'});
  assert.equal(r.status, 200, 'login');
}

function bindWithCloud(h, cloudBase){
  return api(h.base, h.cookiePath, 'POST', '/api/setup/bind', {
    schoolCode: 'GREENVAL',
    schoolId: 'green-valley-sec',
    serverToken: 'rsms-offline-testtoken-abcdef0123456789',
    cloudBaseUrl: cloudBase
  });
}

function outboxPending(localDb){
  return localDb.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status IN (\'pending\',\'in_flight\')').get().n;
}

/* ── Tests ───────────────────────────────────────────────────── */

test('phase b: push drains outbox to cloud, pull merges, money rows never auto-merge', async function(){
  var cloud = createFakeCloud();
  var cloudBase = await cloud.start();
  var h = await startLocal();
  try {
    await bootstrapAdmin(h);
    var b = await bindWithCloud(h, cloudBase);
    assert.equal(b.status, 200, 'bind with cloud validation: ' + JSON.stringify(b.json));
    assert.equal(b.json.cloudValidated, true, 'binding must be cloud-validated');

    /* Local writes land in the outbox. */
    var s1 = {id: 's1', name: 'Ada', class: '9A', updatedAt: '2026-08-01T00:00:00Z'};
    var s2 = {id: 's2', name: 'Ben', class: '9B', updatedAt: '2026-08-01T00:00:00Z'};
    var p1 = {id: 'p1', studentId: 's1', amount: 5000, status: 'Pending',
              recordedAt: '2026-08-02T00:00:00Z'};
    assert.equal((await api(h.base, h.cookiePath, 'PUT', '/api/school/collections/students',
      {rows: [s1, s2]})).status, 200);
    assert.equal((await api(h.base, h.cookiePath, 'PUT', '/api/school/collections/payments',
      {rows: [p1]})).status, 200);
    assert.equal(outboxPending(h.localDb), 3);

    /* Cycle 1: everything pushes to the cloud. */
    var c1 = await api(h.base, h.cookiePath, 'POST', '/api/school/sync/run');
    assert.equal(c1.status, 200, JSON.stringify(c1.json));
    assert.equal(c1.json.cycle.push.pushed, 3);
    assert.equal(outboxPending(h.localDb), 0, 'outbox must drain');
    assert.equal(cloud.state.collections.students.s1.name, 'Ada');
    assert.equal(cloud.state.collections.payments.p1.amount, 5000);

    /* Cloud moves on while the LAN was offline: new row + newer money row. */
    cloud.state.collections.students.s9 = {id: 's9', name: 'Cloud-only', updatedAt: '2026-08-10T00:00:00Z'};
    cloud.state.collections.payments.p1 = {id: 'p1', studentId: 's1', amount: 4000,
      status: 'Confirmed', verifiedAt: '2026-08-11T00:00:00Z'};

    /* Cycle 2: pull merges cloud-only row; the money mismatch is a
       conflict — NOT an auto-merge, NOT a local overwrite. */
    var c2 = await api(h.base, h.cookiePath, 'POST', '/api/school/sync/run');
    assert.equal(c2.status, 200, JSON.stringify(c2.json));
    assert.equal(c2.json.cycle.pull.pulled, 1, 'cloud-only student applied');
    var s9 = h.localDb.prepare('SELECT data FROM rows WHERE collection=\'students\' AND local_id=\'s9\'').get();
    assert.ok(s9, 'cloud-only student exists locally');
    assert.equal(JSON.parse(s9.data).name, 'Cloud-only');
    var p1local = h.localDb.prepare('SELECT data, sync_state FROM rows WHERE collection=\'payments\' AND local_id=\'p1\'').get();
    assert.equal(JSON.parse(p1local.data).amount, 5000, 'local money row untouched');
    var conflicts = await api(h.base, h.cookiePath, 'GET', '/api/school/conflicts');
    assert.equal(conflicts.json.conflicts.filter(function(c){ return c.status === 'open'; }).length, 1);
    var conflict = conflicts.json.conflicts[0];
    assert.match(conflict.reason, /money-row-mismatch/);
    assert.equal(outboxPending(h.localDb), 0, 'conflicted row is not requeued silently');

    /* Resolve: LOCAL wins → requeue durable intent → push carries it.
       But the cloud row is now gateway-settled, so the push is REFUSED
       and the conflict is recreated with the settled reason (review). */
    var r = await api(h.base, h.cookiePath, 'POST',
      '/api/school/conflicts/' + conflict.id + '/resolve', {resolution: 'local'});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(outboxPending(h.localDb), 1, 'local-wins requeues the row');
    await api(h.base, h.cookiePath, 'POST', '/api/school/sync/run');
    var settledConflict = await api(h.base, h.cookiePath, 'GET', '/api/school/conflicts');
    var open = settledConflict.json.conflicts.filter(function(c){ return c.status === 'open'; });
    assert.equal(open.length, 1);
    assert.match(open[0].reason, /gateway-settled/, 'settled rows require bursar review, not silent overwrite');

    /* Resolve: CLOUD wins → local adopts the verified amount. */
    r = await api(h.base, h.cookiePath, 'POST',
      '/api/school/conflicts/' + open[0].id + '/resolve', {resolution: 'cloud'});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    p1local = h.localDb.prepare('SELECT data, sync_state FROM rows WHERE collection=\'payments\' AND local_id=\'p1\'').get();
    assert.equal(JSON.parse(p1local.data).amount, 4000, 'cloud row adopted');
    assert.equal(p1local.sync_state, 'synced');
    var after = await api(h.base, h.cookiePath, 'GET', '/api/school/conflicts');
    assert.equal(after.json.conflicts.filter(function(c){ return c.status === 'open'; }).length, 0);
  } finally {
    await h.stop();
    await cloud.stop();
  }
});

test('phase b: push is idempotent — re-sent intents are skipped, rows not duplicated', async function(){
  var cloud = createFakeCloud();
  var cloudBase = await cloud.start();
  var h = await startLocal();
  try {
    await bootstrapAdmin(h);
    await bindWithCloud(h, cloudBase);
    var s1 = {id: 's1', name: 'Ada', updatedAt: '2026-08-01T00:00:00Z'};
    await api(h.base, h.cookiePath, 'PUT', '/api/school/collections/students', {rows: [s1]});
    await api(h.base, h.cookiePath, 'POST', '/api/school/sync/run');

    /* Simulate a redelivery: push the same intent id again. */
    var intents = h.localDb.prepare('SELECT id FROM outbox').all();
    assert.equal(intents.length, 1);
    var res = await fetch(cloudBase + '/offlineSyncPush', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({data: {
        schoolId: 'green-valley-sec',
        serverToken: 'rsms-offline-testtoken-abcdef0123456789',
        entries: [{intentId: intents[0].id, collection: 'students',
          localId: 's1', action: 'upsert', payload: s1}]
      }})
    });
    var body = await res.json();
    assert.equal(body.result.skipped.length, 1, 'already-processed intent is skipped');
    assert.equal(body.result.applied.length, 0);
    assert.equal(Object.keys(cloud.state.collections.students).length, 1, 'no duplication');
  } finally {
    await h.stop();
    await cloud.stop();
  }
});

test('phase b: non-money rows merge by row timestamp (LWW), ties go to review', async function(){
  var cloud = createFakeCloud();
  var cloudBase = await cloud.start();
  var h = await startLocal();
  try {
    await bootstrapAdmin(h);
    await bindWithCloud(h, cloudBase);
    var localRow = {id: 'k1', label: 'local', updatedAt: '2026-08-05T00:00:00Z'};
    await api(h.base, h.cookiePath, 'PUT', '/api/school/collections/flw_config', {rows: [localRow]});
    await api(h.base, h.cookiePath, 'POST', '/api/school/sync/run');

    /* Cloud has a newer row for the same id: pull must adopt it. */
    cloud.state.collections.flw_config.k1 = {id: 'k1', label: 'cloud-newer',
      updatedAt: '2026-08-06T00:00:00Z'};
    await api(h.base, h.cookiePath, 'POST', '/api/school/sync/run');
    var row = h.localDb.prepare('SELECT data FROM rows WHERE collection=\'flw_config\' AND local_id=\'k1\'').get();
    assert.equal(JSON.parse(row.data).label, 'cloud-newer');

    /* Local newer: must push, not be clobbered. */
    var newer = {id: 'k1', label: 'local-newest', updatedAt: '2026-08-07T00:00:00Z'};
    await api(h.base, h.cookiePath, 'PUT', '/api/school/collections/flw_config', {rows: [newer]});
    await api(h.base, h.cookiePath, 'POST', '/api/school/sync/run');
    assert.equal(cloud.state.collections.flw_config.k1.label, 'local-newest');

    /* Tie → review, never silent overwrite on either side. */
    cloud.state.collections.flw_config.k1 = {id: 'k1', label: 'cloud-tie',
      updatedAt: '2026-08-07T00:00:00Z'};
    await api(h.base, h.cookiePath, 'POST', '/api/school/sync/run');
    var conflicts = await api(h.base, h.cookiePath, 'GET', '/api/school/conflicts');
    var open = conflicts.json.conflicts.filter(function(c){ return c.status === 'open'; });
    assert.equal(open.length, 1);
    assert.equal(open[0].reason, 'timestamp-tie');
    var kept = h.localDb.prepare('SELECT data FROM rows WHERE collection=\'flw_config\' AND local_id=\'k1\'').get();
    assert.equal(JSON.parse(kept.data).label, 'local-newest', 'local row untouched on tie');
  } finally {
    await h.stop();
    await cloud.stop();
  }
});

test('phase b: invalid cloud credentials refuse the binding', async function(){
  var cloud = createFakeCloud();
  var cloudBase = await cloud.start();
  var h = await startLocal();
  try {
    await bootstrapAdmin(h);
    var r = await api(h.base, h.cookiePath, 'POST', '/api/setup/bind', {
      schoolCode: 'GREENVAL',
      schoolId: 'green-valley-sec',
      serverToken: 'wrong-token',
      cloudBaseUrl: cloudBase
    });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(sync.binding(h.localDb) ? sync.binding(h.localDb).cloudValidated : null, null,
      'no binding persisted on failed validation');
  } finally {
    await h.stop();
    await cloud.stop();
  }
});
