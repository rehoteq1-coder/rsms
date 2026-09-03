'use strict';

/* Bursar portal features (owner-directed, 2026-09-03):
   - printReceipt(idx): every receipt in the Receipts page must be
     printable as a designed receipt (school logo, name, details,
     amount, signature lines).
   - downloadFinanceExcel(): report-center export as a branded .xls
     (school logo + name + report title + term context above a
     styled table), in addition to the plain CSV.
  
   The test executes the bursar page's REAL main inline script in a
   DOM stub against a live in-memory server, then invokes both
   functions and asserts on their output — the same protection the
   wizard test provides for the wizard page.
*/

var assert = require('node:assert/strict');
var test = require('node:test');
var dbModule = require('../server/db');
var {createApp} = require('../server/index');

function newDb(){ return dbModule.openDatabase(':memory:'); }

function cookieFrom(res){
  var cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  var hit = cookies.find(function(c){ return c.indexOf('rsms_offline_session=') === 0; });
  return hit ? hit.split(';')[0] : null;
}

async function api(base, p, o){
  o = o || {};
  var res = await fetch(base + p, {
    method: o.method || 'GET',
    headers: Object.assign(o.body ? {'Content-Type': 'application/json'} : {},
      o.cookie ? {Cookie: o.cookie} : {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  var text = await res.text();
  var json = null;
  try { json = JSON.parse(text); } catch(e){}
  return {status: res.status, json: json, text: text, res: res};
}

function startServer(db){
  var server = createApp({db: db}).listen(0, '127.0.0.1');
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

function makeStore(seed){
  var s = {};
  Object.keys(seed || {}).forEach(function(k){ s[k] = seed[k]; });
  return {
    getItem: function(k){ return (k in s) ? s[k] : null; },
    setItem: function(k, v){ s[k] = String(v); },
    removeItem: function(k){ delete s[k]; }
  };
}

/* Execute the bursar page's main inline script in a stub and return
   the exposed functions. */
async function runBursarScript(h, cookie){
  var page = await api(h.base, '/rsms-bursar.html', {cookie: cookie});
  assert.equal(page.status, 200, 'bursar page served');
  var blocks = page.text.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g) || [];
  assert.ok(blocks.length >= 1, 'inline scripts present');
  /* The page splits its code across several inline <script> blocks
     that share the global scope in a browser — execute them all, in
     order, like a browser would. */
  var main = blocks.map(function(b){
    return b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  }).join('\n;\n');

  var printed = null;
  var store = makeStore({
    rsms_school: JSON.stringify({name: 'Test School', term: 'First Term', session: '2025/2026'}),
    rsms_school_logo: 'data:image/png;base64,TESTLOGO',
    rsms_role: 'admin',
    rsms_user: JSON.stringify({id: 'admin1', name: 'School Admin', role: 'admin'})
  });
  var els = {};
  var created = [];
  var blobParts = null;
  var blobType = null;
  function makeEl(id){
    return {id: id, value: '', className: '', innerHTML: '', textContent: '',
      style: {}, dataset: {}, options: [],
      addEventListener: function(){}, appendChild: function(){},
      removeChild: function(){}, click: function(){}, setAttribute: function(){}};
  }
  var documentStub = {
    getElementById: function(id){ if(!els[id]) els[id] = makeEl(id); return els[id]; },
    createElement: function(tag){ var e = makeEl(tag); e.tagName = String(tag).toUpperCase(); created.push(e); return e; },
    addEventListener: function(){},
    body: {appendChild: function(){}, removeChild: function(){}}
  };
  var windowStub = {
    addEventListener: function(){},
    open: function(){
      var w = {document: {write: function(html){ printed = html; }, close: function(){}}, print: function(){}};
      return w;
    },
    location: {href: '', pathname: '/rsms-bursar.html'},
    localStorage: store,
    FIND: null,
    _receiptFees: null,
    _financeReportModel: null
  };
  var fetchStub = function(url, opts){
    opts = opts || {};
    return fetch(h.base + url, {
      method: opts.method || 'GET',
      headers: Object.assign(opts.headers || {}, {Cookie: cookie}),
      body: opts.body
    });
  };
  var timeouts = [];
  var safeTimeout = function(fn, ms){ timeouts.push(fn); return timeouts.length; };
  var CapturedBlob = function(parts, opts){
    blobParts = parts.map(function(p){ return String(p); }).join('');
    blobType = opts && opts.type;
    return new globalThis.Blob(parts.map(function(p){ return String(p); }), opts || {});
  };

  new Function('document', 'window', 'localStorage', 'sessionStorage', 'location',
    'navigator', 'fetch', 'setTimeout', 'Blob',
    main + '\n;globalThis.__bursar={printReceipt:printReceipt,downloadFinanceExcel:downloadFinanceExcel};'
  )(documentStub, windowStub, store, makeStore({}), windowStub.location,
    {clipboard: null}, fetchStub, safeTimeout, CapturedBlob);

  assert.ok(globalThis.__bursar, 'bursar functions exposed');
  return {
    window: windowStub, els: els, created: created,
    getPrinted: function(){ return printed; },
    getBlob: function(){ return {parts: blobParts, type: blobType}; }
  };
}

async function seededHandle(){
  var db = newDb();
  var h = await startServer(db);
  var setup = async function(){
    await api(h.base, '/api/bootstrap', {method: 'POST', body: {
      username: 'admin1', displayName: 'Admin', role: 'admin', pin: '1234'
    }});
    var login = await api(h.base, '/api/auth/login', {method: 'POST', body: {
      username: 'admin1', pin: '1234'
    }});
    assert.equal(login.status, 200);
    var cookie = cookieFrom(login.res);
    await api(h.base, '/api/setup/bind', {method: 'POST', cookie: cookie, body: {
      schoolCode: 'TESTSCHOOL', schoolName: 'Test School'
    }});
    return cookie;
  };
  return {h: h, setup: setup};
}

test('bursar: printReceipt renders the designed receipt (logo, school, details, amount)', async function(){
  var env = await seededHandle();
  try{
    var cookie = await env.setup();
    var run = await runBursarScript(env.h, cookie);
    run.window._receiptFees = [{
      receiptNo: 'RCPT-001', date: '2026-09-03', student: 'Ada Obi',
      class: 'JSS 1', type: 'Tuition', method: 'Cash',
      amount: 50000, channel: 'bursar'
    }];
    globalThis.__bursar.printReceipt(0);
    var out = run.getPrinted();
    assert.ok(out, 'print window received the receipt HTML');
    assert.ok(out.indexOf('RCPT-001') >= 0, 'receipt number shown');
    assert.ok(out.indexOf('Ada Obi') >= 0, 'student shown');
    assert.ok(out.indexOf('Test School') >= 0, 'school name shown');
    assert.ok(out.indexOf('TESTLOGO') >= 0, 'school logo embedded');
    assert.ok(out.indexOf('50,000') >= 0, 'amount shown in naira');
    assert.ok(out.indexOf('Authorized Signatory') >= 0, 'signature lines present');
    assert.ok(out.indexOf('OFFICIAL FEE RECEIPT') >= 0, 'receipt title');

    /* Missing index must toast an error, not print. */
    var before = run.getPrinted();
    globalThis.__bursar.printReceipt(99);
    assert.equal(run.getPrinted(), before, 'no print for a missing receipt');
  } finally {
    await stopServer(env.h);
  }
});

test('bursar: downloadFinanceExcel produces a branded .xls document', async function(){
  var env = await seededHandle();
  try{
    var cookie = await env.setup();
    var run = await runBursarScript(env.h, cookie);
    run.window._financeReportModel = {
      title: 'Payment Report',
      headers: ['Date', 'Student', 'Amount'],
      rows: [['2026-09-03', 'Ada Obi', '\u20a650,000']]
    };
    globalThis.__bursar.downloadFinanceExcel();

    /* The .xls body must carry the school brand + report context. */
    var blob = run.getBlob();
    assert.ok(blob.parts, 'xls document assembled');
    assert.ok(blob.type && blob.type.indexOf('application/vnd.ms-excel') === 0,
      'served as an Excel document: ' + blob.type);
    assert.ok(blob.parts.indexOf('TESTLOGO') >= 0, 'school logo embedded');
    assert.ok(blob.parts.indexOf('Test School') >= 0, 'school name in the header');
    assert.ok(blob.parts.indexOf('Payment Report') >= 0, 'report title in the header');
    assert.ok(blob.parts.indexOf('First Term') >= 0, 'term context shown');
    assert.ok(blob.parts.indexOf('2025/2026') >= 0, 'session context shown');
    assert.ok(blob.parts.indexOf('Ada Obi') >= 0, 'report rows present');
    assert.ok(blob.parts.indexOf('x:ExcelWorkbook') >= 0, 'MSO workbook metadata present');

    /* The download is named <school>_<report>.xls */
    var anchor = run.created.filter(function(e){ return e.tagName === 'A'; }).pop();
    assert.ok(anchor, 'download anchor created');
    assert.ok(anchor.download.indexOf('Test School_') === 0, 'name starts with the school: ' + anchor.download);
    assert.ok(anchor.download.indexOf('.xls') === anchor.download.length - 4, 'ends in .xls: ' + anchor.download);
  } finally {
    await stopServer(env.h);
  }
});
