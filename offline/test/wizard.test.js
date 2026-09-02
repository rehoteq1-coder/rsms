'use strict';

/* First-run wizard (Phase C) — end-to-end logic test.
  
   The wizard page ships inline browser JavaScript. This test extracts
   that script from the served page and executes it in a minimal DOM
   stub against a live in-memory server, simulating the whole
   first-run flow: initial load -> bind form -> bind -> LAN step ->
   backups step -> verified first backup -> done.
  
   This guards against the class of bug where the page's static HTML
   renders but the inline script silently fails (a syntax error or a
   dead branch leaves the step area empty and every button inert).
*/

var assert = require('node:assert/strict');
var test = require('node:test');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var dbModule = require('../server/db');
var {createApp} = require('../server/index');

function newDb(){
  return dbModule.openDatabase(':memory:');
}

function cookieFrom(res){
  var cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  var hit = cookies.find(function(c){ return c.indexOf('rsms_offline_session=') === 0; });
  return hit ? hit.split(';')[0] : null;
}

async function api(base, p, options){
  options = options || {};
  var res = await fetch(base + p, {
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

/* Minimal DOM: elements auto-vivify by id; innerHTML/value/className
   are plain data. The wizard script only needs getElementById. */
function makeDoc(){
  var els = {};
  return {
    getElementById: function(id){
      if(!els[id]) els[id] = {id: id, value: '', className: '', innerHTML: '', textContent: '', style: {}};
      return els[id];
    }
  };
}

function tick(ms){
  return new Promise(function(r){ setTimeout(r, ms == null ? 150 : ms); });
}

/* Fetch the served wizard page and run its inline script in the stub,
   exposing the page's functions on the returned handle. */
async function runWizardPage(h, cookie){
  var page = await api(h.base, '/wizard.html', {cookie: cookie});
  assert.equal(page.status, 200, 'wizard page served');
  assert.ok(page.text.indexOf('<input type="hidden" id="cur">') >= 0,
    'step-state input must exist in the DOM');
  var m = page.text.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'inline wizard script present');
  var doc = makeDoc();
  var fetchStub = function(url, opts){
    opts = opts || {};
    return fetch(h.base + url, {
      method: opts.method || 'GET',
      headers: Object.assign(opts.headers || {}, {Cookie: cookie}),
      body: opts.body
    });
  };
  new Function('document', 'window', 'fetch',
    m[1] + '\n;globalThis.__wiz={doBind:doBind,goto:goto,render:render,load:load,' +
    'cfgBackup:cfgBackup,firstBackup:firstBackup};'
  )(doc, {}, fetchStub);
  var wiz = globalThis.__wiz;
  return {doc: doc, wiz: wiz};
}

test('wizard: full first-run flow — load, bind, LAN, backups, verified backup, done', async function(){
  var db = newDb();
  var h = await startServer(db);
  var tmpdir = null;
  try{
    await api(h.base, '/api/bootstrap', {method: 'POST', body: {
      username: 'admin1', displayName: 'Admin', role: 'admin', pin: '1234'
    }});
    var login = await api(h.base, '/api/auth/login', {method: 'POST', body: {
      username: 'admin1', pin: '1234'
    }});
    assert.equal(login.status, 200);
    var cookie = cookieFrom(login.res);
    assert.ok(cookie, 'session cookie');

    var runner = await runWizardPage(h, cookie);
    var doc = runner.doc;
    var wiz = runner.wiz;
    var step = doc.getElementById('step');

    /* 1. initial load must render the bind form (old bug: rendered nothing). */
    await tick(300);
    assert.ok(step.innerHTML.indexOf('Bind this appliance to the school') >= 0,
      'bind form rendered on initial load');

    /* 2. bind a local-only school -> must land on the LAN step. */
    doc.getElementById('sc').value = 'TESTSCHOOL';
    doc.getElementById('sn').value = 'Test School';
    wiz.doBind();
    await tick(400);
    assert.ok(step.innerHTML.indexOf('Staff access') >= 0, 'LAN table after bind');
    assert.ok(step.innerHTML.indexOf('DHCP reservation') >= 0, 'DHCP warning shown');
    assert.ok(step.innerHTML.indexOf('Next: backups') >= 0, 'next: backups button');
    assert.equal(doc.getElementById('s1').className, 'done', 'step 1 marked done');
    assert.equal(doc.getElementById('s2').className, 'active', 'step 2 active');
    var st = await api(h.base, '/api/setup/status', {cookie: cookie});
    assert.equal(st.json.bound, true, 'server-side bound');
    assert.equal(st.json.binding.schoolCode, 'TESTSCHOOL');

    /* 3. backups step. */
    wiz.goto('backup');
    await tick(50);
    assert.ok(step.innerHTML.indexOf('Backups') >= 0, 'backup step rendered');
    assert.ok(step.innerHTML.indexOf('Run first backup now') >= 0, 'first-backup button');
    assert.ok(step.innerHTML.indexOf('Next: done') >= 0, 'next: done button');
    assert.equal(doc.getElementById('s3').className, 'active', 'step 3 active');

    /* 4. run the first verified backup into a temp dir. */
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsms-wiz-test-'));
    var cfg = await api(h.base, '/api/admin/backups/config', {
      method: 'POST', cookie: cookie, body: {dir: tmpdir}
    });
    assert.equal(cfg.status, 200, 'backup dir config');
    wiz.load();
    await tick(200);
    wiz.firstBackup();
    await tick(700);
    assert.ok(doc.getElementById('bsg').innerHTML.indexOf('verified') >= 0,
      'first backup verified: ' + doc.getElementById('bsg').innerHTML);
    assert.ok(fs.readdirSync(tmpdir).some(function(f){ return f.indexOf('.sqlite') >= 0; }),
      'backup file written to the configured dir');

    /* 5. done step. */
    wiz.goto('done');
    await tick(50);
    assert.ok(step.innerHTML.indexOf('All set') >= 0, 'done step rendered');
    assert.equal(doc.getElementById('s4').className, 'active', 'step 4 active');
  } finally {
    if(tmpdir) fs.rmSync(tmpdir, {recursive: true, force: true});
    await stopServer(h);
  }
});

test('wizard: served inline script is syntactically valid', async function(){
  var db = newDb();
  var h = await startServer(db);
  try{
    await api(h.base, '/api/bootstrap', {method: 'POST', body: {
      username: 'admin1', role: 'admin', pin: '1234'
    }});
    var login = await api(h.base, '/api/auth/login', {method: 'POST', body: {
      username: 'admin1', pin: '1234'
    }});
    var cookie = cookieFrom(login.res);
    var page = await api(h.base, '/wizard.html', {cookie: cookie});
    var m = page.text.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline wizard script present');
    /* A SyntaxError here means every wizard button would be inert in a browser. */
    assert.doesNotThrow(function(){ new Function('document', 'window', 'fetch', m[1]); },
      'wizard inline script must parse');
    assert.ok(m[1].trim().endsWith('load();'),
      'page must call load() on startup so the first step renders');
  } finally {
    await stopServer(h);
  }
});
