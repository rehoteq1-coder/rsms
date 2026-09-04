'use strict';

/* AI Units — real school-scoped metering (owner-directed, 2026-09-04):
   - Enterprise schools get 30 free units per term (a pool) in
     schools/<id>/ai_units; the school allocates units to staff.
   - Teachers who exhaust their allocation buy personal units.
   - The studio (lesson-ai.html) meters from Firebase when opened with
     ?school=<id>&teacher=<email>, and falls back to the legacy 2 free
     browser units on direct public access.

   The test executes the studio page's REAL inline script in a DOM stub
   against an in-memory Firebase stand-in — the same protection the
   bursar-features test provides for the bursar page.
*/

var assert = require('node:assert/strict');
var test = require('node:test');
var fs = require('fs');
var path = require('path');

var REPO_ROOT = path.join(__dirname, '..', '..');

function tick(n){
  return new Promise(function(resolve){
    var left = n || 3;
    (function step(){
      if(left-- <= 0) return resolve();
      setImmediate(step);
    })();
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

/* In-memory Firebase stand-in for the studio page.
   Fires on('value') listeners after writes, like the real database. */
function makeFirebase(initialTree){
  var tree = JSON.parse(JSON.stringify(initialTree || {}));
  var listeners = {};
  function getAt(p){
    var parts = p.split('/');
    var node = tree;
    for(var i=0;i<parts.length;i++){
      if(node === undefined || node === null) return undefined;
      node = node[parts[i]];
    }
    return node;
  }
  function setAt(p, val){
    var parts = p.split('/');
    var node = tree;
    for(var i=0;i<parts.length-1;i++){
      if(typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length-1]] = val;
  }
  function fire(p, val){
    (listeners[p] || []).forEach(function(fn){
      fn({ val: function(){ return val; } });
    });
  }
  return {
    initializeApp: function(){},
    database: function(){
      return {
        ref: function(p){
          return {
            once: function(){
              return Promise.resolve({ val: function(){ return getAt(p); } });
            },
            on: function(ev, fn){
              (listeners[p] = listeners[p] || []).push(fn);
              return function(){
                listeners[p] = (listeners[p] || []).filter(function(f){ return f !== fn; });
              };
            },
            set: function(v){ setAt(p, v); fire(p, v); return Promise.resolve(); },
            transaction: function(cb, complete){
              var cur = getAt(p);
              var next = cb(cur === undefined ? null : cur);
              if(next !== null){ setAt(p, next); fire(p, next); }
              if(complete) complete(null, { val: function(){ return next === null ? cur : next; } });
              return Promise.resolve(next !== null);
            }
          };
        }
      };
    },
    _tree: tree
  };
}

/* Execute the studio page's inline script with the given context and
   return {api, els, fb, store, timeouts, checkout}. */
function runStudio(opts){
  var page = fs.readFileSync(path.join(REPO_ROOT, 'lesson-ai.html'), 'utf8');
  var blocks = page.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g) || [];
  assert.ok(blocks.length === 1, 'one inline script expected');
  var main = blocks[0].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');

  var w = {};
  new Function('window', fs.readFileSync(path.join(REPO_ROOT, 'rsms-ai-units.js'), 'utf8'))(w);
  var AI_UNITS = w.AI_UNITS;

  var store = makeStore(opts.localStorage || {});
  var sess = makeStore({});
  var els = {};
  function makeEl(id){
    return {id: id, value: '', className: '', innerHTML: '', textContent: '',
      style: {}, dataset: {},
      classList: {add: function(){}, remove: function(){}},
      addEventListener: function(){}, appendChild: function(){},
      scrollIntoView: function(){}, setAttribute: function(){}};
  }
  var documentStub = {
    getElementById: function(id){ if(!els[id]) els[id] = makeEl(id); return els[id]; },
    querySelectorAll: function(){ return { forEach: function(){} }; },
    querySelector: function(){ return null; },
    createElement: function(t){ return makeEl(t); },
    addEventListener: function(){},
    body: {appendChild: function(){}}
  };

  var fb = makeFirebase(opts.dbTree);
  var workerCalls = 0;
  var fetchStub = function(url){
    workerCalls++;
    return Promise.resolve({
      ok: true,
      text: function(){ return Promise.resolve(JSON.stringify(
        {choices: [{message: {content: 'LESSON PLAN OUTPUT'}}]})); }
    });
  };

  var checkoutOpts = null;
  var FlutterwaveCheckout = function(opts){
    checkoutOpts = opts;
    setTimeout(function(){
      if(opts.callback) opts.callback({status: 'successful', txRef: opts.tx_ref});
    }, 0);
    return {close: function(){}};
  };

  var windowStub = {
    addEventListener: function(){},
    confirm: function(){ return true; },
    alert: function(){},
    open: function(){ return {}; },
    location: {href: '', pathname: '/lesson-ai.html', search: opts.search || ''},
    localStorage: store,
    sessionStorage: sess,
    RSMS_CONFIG: {firebase: {apiKey: 'test'}},
    AI_UNITS: AI_UNITS
  };

  var timeouts = [];
  var safeTimeout = function(fn, ms){ timeouts.push(fn); return timeouts.length; };

  new Function('document','window','localStorage','sessionStorage','location',
    'navigator','fetch','setTimeout','alert','prompt','confirm','firebase',
    'RSMS_CONFIG','AI_UNITS','FlutterwaveCheckout',
    main + '\n;globalThis.__ai={getUnits:getUnits, generate:generate, aiLoad:aiLoad,'
      + 'aiCredit:aiCredit, payForUnits:payForUnits, showGate:showGate,'
      + 'AI_CTX:AI_CTX, balanceNow:function(){return _aiBalance;}};'
  )(documentStub, windowStub, store, sess, windowStub.location,
    {clipboard: null}, fetchStub, safeTimeout,
    function(){}, function(){ return null; }, function(){ return true; },
    fb, {firebase: {apiKey: 'test'}}, AI_UNITS, FlutterwaveCheckout);

  assert.ok(globalThis.__ai, 'studio functions exposed');
  return {api: globalThis.__ai, els: els, doc: documentStub, fb: fb, store: store,
    workerCalls: function(){ return workerCalls; },
    checkoutOpts: function(){ return checkoutOpts; },
    timeouts: timeouts};
}

test('ai-units: balance math, breakdown and pricing are exact', function(){
  var w = {};
  new Function('window', fs.readFileSync(path.join(REPO_ROOT, 'rsms-ai-units.js'), 'utf8'))(w);
  var U = w.AI_UNITS;
  assert.equal(U.BASE, 30, 'enterprise free pool is 30 per term');
  assert.equal(U.UNIT_PRICE, 150);
  assert.equal(U.balance({allocated: 5, purchased: 2, used: 3}), 4);
  assert.equal(U.balance({allocated: 0, purchased: 0, used: 9}), 0, 'never negative');
  assert.equal(U.balance(null), 0);
  assert.deepEqual(U.detail({allocated: 5, purchased: 2, used: 3}),
    {school: 5, own: 2, used: 3, remaining: 4});
  assert.equal(U.priceFor(3), 450, 'any-amount pricing is flat per unit');
  assert.equal(U.normEmail('  T@X.COM '), 't@x.com', 'emails normalise case/whitespace');
});

test('studio: school-mode metering is real (Firebase), exhausts to the gate', async function(){
  var h = runStudio({
    search: '?school=REH1&teacher=T@X.COM',
    dbTree: {schools: {REH1: {ai_units: {staff: {'t@x.com': {allocated: 5, purchased: 0, used: 3}}}}}}
  });
  assert.ok(h.api.AI_CTX.schoolMode, 'context detected from URL (email lower-cased)');
  await tick();

  assert.equal(h.api.getUnits(), 2, 'balance = allocated - used (5 - 3)');
  assert.ok(String(h.els['unit-display'].textContent).indexOf('2 units left') !== -1, 'live display');
  assert.ok(String(h.els['unit-sub'].textContent).indexOf('School allocation: 5') !== -1, 'breakdown shown');

  h.doc.getElementById('f-topic').value = 'Photosynthesis';
  await h.api.generate();
  assert.equal(h.workerCalls(), 1, 'first generation reached the worker');
  assert.equal(h.fb._tree.schools.REH1.ai_units.staff['t@x.com'].used, 4, 'used incremented in the shared ledger');
  assert.equal(h.api.getUnits(), 1);

  await h.api.generate();
  assert.equal(h.fb._tree.schools.REH1.ai_units.staff['t@x.com'].used, 5);
  assert.equal(h.api.getUnits(), 0, 'allocation exhausted');

  await h.api.generate();
  assert.equal(h.workerCalls(), 2, 'no third generation while out of units');
  assert.equal(h.els['gate-overlay'].style.display, 'flex', 'gate shown when exhausted');
});

test('studio: exhausted teacher buys personal units via the working Flutterwave flow', async function(){
  var h = runStudio({
    search: '?school=REH1&teacher=t@x.com',
    dbTree: {schools: {REH1: {ai_units: {staff: {'t@x.com': {allocated: 5, purchased: 0, used: 5}}}}}}
  });
  await tick();
  assert.equal(h.api.getUnits(), 0);

  h.els['gate-email'].value = 't@x.com';
  await h.api.payForUnits();
  await tick();

  var co = h.checkoutOpts();
  assert.ok(co, 'Flutterwave checkout opened');
  assert.equal(co.amount, 1500, 'default 5-unit bundle');
  assert.ok(String(co.tx_ref).indexOf('REHOTEQ-AI-') === 0);

  var staff = h.fb._tree.schools.REH1.ai_units.staff['t@x.com'];
  assert.equal(staff.purchased, 5, 'personal units credited to the shared ledger (not the browser)');
  assert.equal(staff.allocated, 5, 'allocation untouched');
  assert.equal(h.api.getUnits(), 5);
});

test('studio: direct public access keeps the legacy 2 free browser units', async function(){
  var h = runStudio({search: ''});
  await tick();
  assert.ok(!h.api.AI_CTX.schoolMode, 'no school context = demo mode');
  assert.equal(h.api.getUnits(), 2, 'first visit gets the 2 free units');
  assert.equal(h.store.getItem('rms_ai_units'), '2', 'kept in the browser as before');

  h.doc.getElementById('f-topic').value = 'Cell structure';
  await h.api.generate();
  assert.equal(h.workerCalls(), 1);
  assert.equal(h.store.getItem('rms_ai_units'), '1', 'spend stays in the browser');
  assert.equal(h.api.getUnits(), 1);
});
