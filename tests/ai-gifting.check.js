#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   Toye — AI gifting fallback checks (device ledger + replay queue)
   -----------------------------------------------------------
   Gifting AI units must survive a flaky connection. rsms-admin.html
   mirrors schools/<sid>/ai_units to a device ledger (ai_units_local),
   queues allocations the server could not accept (ai_units_queue),
   replays them on the next successful aiEnsure, and tells the admin
   WHY the panel is not live — aiEnsure answers cb(data, reason) and
   every message says what actually happened.

   These checks run the REAL region of the admin page (between the
   AI-GIFTING markers) in a vm against a stubbed Firebase,
   localStorage and toast — no jsdom, no browser, no network.

   Usage:
     node tests/ai-gifting.check.js   # → "6/6 AI gifting checks passed"
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const adminPath = path.join(repoRoot, 'rsms-admin.html');
const adminHtml = fs.readFileSync(adminPath, 'utf8');

/* ── extraction ─────────────────────────────────────────────── */

function extractGiftRegion() {
  const a = adminHtml.indexOf('// >>> AI-GIFTING-BEGIN');
  const b = adminHtml.indexOf('// <<< AI-GIFTING-END');
  if (a === -1 || b === -1 || b <= a) {
    throw new Error('AI-GIFTING markers not found in rsms-admin.html');
  }
  return adminHtml.slice(adminHtml.indexOf('\n', a) + 1, b);
}

/* ── stubs ──────────────────────────────────────────────────── */

function makeLocalStorage(seed) {
  const store = Object.assign({}, seed || {});
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store
  };
}

/* In-memory Firebase stand-in. once/set/transaction follow the real
   shapes, including transaction aborts (fn returns null → rejected)
   and async-looking error callbacks. `offline` flips failure. */
function makeFirebase(tree, offline) {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function getAt(p) {
    let node = tree;
    for (const part of p.split('/')) {
      if (node == null) return undefined;
      node = node[part];
    }
    return node;
  }
  function setAt(p, val) {
    const parts = p.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = clone(val);
  }
  return {
    database() {
      return {
        ref(p) {
          return {
            once() {
              if (offline.reads) return Promise.reject(new Error('unreachable'));
              const v = getAt(p);
              return Promise.resolve({ val: () => (v === undefined ? null : clone(v)) });
            },
            set(v) {
              if (offline.writes) return Promise.reject(new Error('unreachable'));
              setAt(p, v);
              return Promise.resolve();
            },
            transaction(fn, cb) {
              if (offline.writes) { cb(new Error('unreachable')); return; }
              const before = getAt(p);
              const out = fn(before == null ? null : clone(before));
              if (out === null) { cb(null, { val: () => (getAt(p) === undefined ? null : clone(getAt(p))) }); return; }
              setAt(p, out);
              cb(null, { val: () => clone(out) });
            }
          };
        }
      };
    }
  };
}


function boot({ plan = 'Enterprise', tree = {}, seed = {}, reads = false, writes = false } = {}) {
  const toasts = [];
  const localStorage = makeLocalStorage(seed);
  const ctx = {
    console,
    localStorage,
    firebase: makeFirebase(tree, { reads, writes }),
    _sid: () => 'REH-2j8kq2xf',
    getSchool: () => ({ plan, term: 'First Term', session: '2025/2026' }),
    getStaff: () => [],
    AI_UNITS: {
      BASE: 30,
      UNITS_PER_TEACHER_TERM: 10,
      normEmail: (e) => String(e || '').trim().toLowerCase()
    },
    toast: (msg, kind) => { toasts.push({ msg, kind }); },
    el: () => {},
    document: { getElementById: () => null }
  };
  vm.createContext(ctx);
  vm.runInContext(extractGiftRegion(), ctx, { filename: 'rsms-admin.html (AI gifting region)' });
  const api = vm.runInContext(
    '({aiEnsure:aiEnsure,aiAllocate:aiAllocate,aiNotice:aiNotice,aiLedgerLoad:aiLedgerLoad,aiQueueLoad:aiQueueLoad})',
    ctx
  );
  const ledger = () => JSON.parse(localStorage.getItem('ai_units_local') || 'null');
  const queue = () => JSON.parse(localStorage.getItem('ai_units_queue') || 'null');
  const server = () => JSON.parse(JSON.stringify(tree)).schools['REH-2j8kq2xf'].ai_units;
  return {
    ctx, api, toasts, tree, ledger, queue, server, localStorage,
    ensure: () => new Promise((resolve) => api.aiEnsure((data, reason) => resolve({ data, reason }))),
    allocate: (email, n) => new Promise((resolve) => api.aiAllocate(email, n, (ok, queued) => resolve({ ok, queued })))
  };
}

/* ── checks ─────────────────────────────────────────────────── */

const total = 6;
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}

(async function main() {
  console.log('AI gifting fallback checks\n');

  await check('1. first Enterprise run opens the termly pool and mirrors it to the device', async () => {
    const h = boot({ tree: {} });
    const { data, reason } = await h.ensure();
    assert.ok(data, 'aiEnsure delivered no data on a healthy run');
    assert.equal(reason, '', 'a fresh server read must report no reason');
    assert.equal(data.pool, 30, 'the free Enterprise termly pool');
    assert.equal(h.server().pool, 30, 'the school record holds the pool');
    assert.deepEqual(h.ledger().pool, 30, 'the device ledger mirrors the read');
  });

  await check('2. a Standard-plan school is told the pool is an Enterprise feature', async () => {
    const h = boot({ plan: 'Standard', tree: {} });
    const { data, reason } = await h.ensure();
    assert.equal(data, null);
    assert.equal(reason, 'free', 'not enterprise, nothing stored → free');
    assert.match(h.api.aiNotice('free'), /Enterprise/);
    assert.equal(h.tree.schools, undefined, 'no pool may be created for a Standard school');
  });

  await check('3. an offline read answers from the device ledger and says so', async () => {
    const saved = { base: 30, pool: 12, term: 'First Term 2025/2026', staff: { 't@x': { allocated: 8, purchased: 0, used: 2 } } };
    const h = boot({ reads: true, seed: { ai_units_local: JSON.stringify(saved) } });
    const { data, reason } = await h.ensure();
    assert.ok(data, 'the ledger copy should have been served');
    assert.equal(reason, 'offline-ledger');
    assert.equal(data.pool, 12, 'numbers as last saved on the device');
    assert.match(h.api.aiNotice('offline-ledger'), /saved on this device/i);
    assert.match(h.api.aiNotice('offline-ledger'), /queued/i);
  });

  await check('4. no ledger and no network: honest "unknown, not zero" — never a vague connection taunt', async () => {
    const h = boot({ reads: true, writes: true, tree: {} });
    const { data, reason } = await h.ensure();
    assert.equal(data, null, 'nothing to show without a server copy or a ledger');
    assert.equal(reason, 'offline');
    const notice = h.api.aiNotice('offline');
    assert.match(notice, /unknown — not zero/i, 'the admin is told the numbers are unknown');
    for (const why of ['free', 'offline', 'offline-ledger', '']) {
      assert.ok(!/check your connection/i.test(h.api.aiNotice(why)), 'aiNotice(' + why + ') went vague');
    }
    // the shipped page is the contract: the phrase is gone from rsms-admin.html entirely,
    // and every AI panel message now comes from aiNotice(reason) or states the outcome
    assert.ok(!/check your connection/i.test(adminHtml), 'rsms-admin.html still blames the connection');
    assert.ok(!/Could not load AI units/.test(adminHtml), 'the old shrug message is still shipped');
    for (const fnName of ['renderLessonAI', 'giftAllTeachers', 'allocateIndividual', 'newAiTerm']) {
      assert.ok(adminHtml.includes('function ' + fnName + '('), fnName + ' has vanished from the admin page');
    }
    assert.equal((adminHtml.match(/aiEnsure\(function\(d, ?reason\)/g) || []).length, 4,
      'all four AI panel entry points must branch on the reason');
  });

  await check('5. an allocation made offline lands in the ledger and the replay queue', async () => {
    const saved = { base: 30, pool: 30, term: 'First Term 2025/2026', staff: {} };
    const h = boot({ writes: true, seed: { ai_units_local: JSON.stringify(saved) } });
    const { ok, queued } = await h.allocate('teacher@rsms.school', 10);
    assert.equal(ok, true, 'the click must not be swallowed by an unreachable server');
    assert.equal(queued, true, 'and it must be reported as queued, not live');
    assert.equal(h.ledger().pool, 20, 'the device ledger pays for the gift');
    assert.equal(h.ledger().staff['teacher@rsms.school'].allocated, 10, 'the teacher has it on this device');
    const q = h.queue();
    assert.equal(q.length, 1, 'queued for the next good load');
    assert.equal(q[0].email, 'teacher@rsms.school');
    assert.equal(q[0].n, 10);
    assert.ok(q[0].at, 'queued entries carry a timestamp');
    assert.match(h.toasts[h.toasts.length - 1].msg, /saved on this device/i, 'and it was said honestly');
  });

  await check('6. the queue replays oldest-first on the next good load; a short pool keeps the rest queued', async () => {
    const saved = { base: 30, pool: 7, term: 'First Term 2025/2026', staff: { 'ada@x': { allocated: 8, purchased: 0, used: 0 } } };
    const h = boot({
      tree: { schools: { 'REH-2j8kq2xf': { ai_units: { base: 30, pool: 12, term: 'First Term 2025/2026', staff: {} } } } },
      seed: { ai_units_local: JSON.stringify(saved), ai_units_queue: JSON.stringify([
        { email: 'ada@x', n: 5, at: '2026-09-01T10:00:00.000Z' },
        { email: 'bola@x', n: 9, at: '2026-09-01T10:05:00.000Z' }
      ]) }
    });
    const { data, reason } = await h.ensure();
    assert.equal(reason, '', 'the read succeeded; replay happened as part of it');
    assert.ok(data, 'data still arrives');
    const srv = h.server();
    assert.equal(srv.staff['ada@x'].allocated, 5, 'the oldest queued gift was applied first');
    assert.equal(srv.pool, 7, '12 minus 5 — the server pays, not the ledger');
    const left = h.queue();
    assert.equal(left.length, 1, 'the entry the pool could not cover stays queued');
    assert.equal(left[0].email, 'bola@x');
    assert.match(h.toasts.map((t) => t.msg).join('\n'), /still waiting because the pool is short/i);
  });

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' of ' + total + ' checks failed');
    process.exit(1);
  }
  console.log(passed + '/' + total + ' AI gifting checks passed');
  process.exit(0);
})().catch((err) => {
  console.error('\nAI gifting check run failed:', err);
  process.exit(1);
});
