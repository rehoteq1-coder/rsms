'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
const { webcrypto } = require('node:crypto');

global.window = {
  indexedDB,
  IDBKeyRange,
  crypto: webcrypto,
  RSMS_CONFIG: { sync: { enabled: false, transport: 'disabled' } }
};
global.indexedDB = indexedDB;
// Node 24 already exposes Web Crypto globally; the browser shim above exposes it to the script.

// The browser-targeted script deliberately has no module wrapper.
require(path.join(__dirname, '..', 'rsms-sync.js'));
const sync = global.window.RSMS_SYNC;

test('creates the v1 stores and keeps a stable local device ID', async () => {
  await sync.clearPilotData();
  const first = await sync.getDeviceId();
  const second = await sync.getDeviceId();
  assert.match(first, /^[0-9a-f-]{36}$/i);
  assert.equal(second, first);
  const status = await sync.getStatus();
  assert.equal(status.localOnly, true);
  assert.equal(status.counts.meta, 2);
  await sync.putEntity('class', 'A', { label: 'Senior 1' }, 1);
  assert.equal((await sync.getStatus()).counts.entities, 1);
});

test('queues UUID operations once and retains acknowledgement/rejection history', async () => {
  await sync.clearPilotData();
  const request = { type: 'attendance.recorded', entityType: 'attendance', entityId: 'row-1', payload: { present: true } };
  const first = await sync.enqueue(request);
  const duplicate = await sync.enqueue(request);
  assert.match(first.operation.operationId, /^[0-9a-f-]{36}$/i);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.operation.operationId, first.operation.operationId);

  const acknowledged = await sync.acknowledge(first.operation.operationId);
  assert.deepEqual(acknowledged, { operationId: first.operation.operationId, status: 'acked', retained: true });
  const rejected = await sync.enqueue({ type: 'result.saved', entityType: 'result', entityId: 'row-2', payload: { score: 12 } });
  await sync.reject(rejected.operation.operationId, 'validation failed / email@example.test');

  const status = await sync.getStatus();
  assert.equal(status.counts.outbox, 2);
  assert.equal(status.counts.inbox, 2);
  assert.equal(status.counts.acked, 1);
  assert.equal(status.counts.rejected, 1);
  assert.equal(status.counts.conflicts, 1);
});

test('has redacted diagnostics, a local-only transport, and an explicit pilot clear', async () => {
  const diagnostics = await sync.exportDiagnostics();
  const rendered = JSON.stringify(diagnostics);
  assert.equal(diagnostics.localOnly, true);
  assert.equal(diagnostics.transport.networkAllowed, false);
  assert.equal(rendered.includes('email@example.test'), false);
  assert.equal(rendered.includes('row-1'), false);
  assert.equal(rendered.includes('deviceId'), false);
  assert.equal(rendered.includes('createdAt'), false);
  assert.deepEqual(await sync.syncNow(), { sent: false, reason: 'transport-disabled' });

  await sync.clearPilotData();
  const status = await sync.getStatus();
  assert.deepEqual(status.counts, { meta: 0, outbox: 0, inbox: 0, entities: 0, conflicts: 0, pending: 0, acked: 0, rejected: 0 });
});

test('service worker guards Firebase and non-GET traffic before caching', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(worker, /request\.method !== 'GET' \|\| isFirebaseRequest\(request\.url\)/);
  assert.match(worker, /firebasedatabase\.app/);
  assert.match(worker, /'\/lesson-ai\.html'/);
  assert.match(worker, /'\/rsms-sync\.js'/);
});
