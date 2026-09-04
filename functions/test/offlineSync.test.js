'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var sync = require('../src/offlineSync');

test('registration validation enforces action, schoolId and schoolCode', function(){
  assert.equal(sync.isValidRegistration({action:'register', schoolId:'green-valley-sec', schoolCode:'GREENVAL'}).ok, true);
  assert.equal(sync.isValidRegistration({action:'register', schoolId:'green-valley-sec'}).ok, false);
  assert.equal(sync.isValidRegistration({action:'revoke', schoolId:'green-valley-sec'}).ok, true);
  assert.equal(sync.isValidRegistration({action:'nuke', schoolId:'x', schoolCode:'y'}).ok, false);
  assert.equal(sync.isValidRegistration({action:'register', schoolId:'bad school!', schoolCode:'y'}).ok, false);
});

test('token hashing is stable and tokens are opaque', function(){
  assert.equal(sync.hashToken('abc'), sync.sha256('abc'));
  assert.notEqual(sync.hashToken('a'), sync.hashToken('b'));
  var token = sync.generateServerToken();
  assert.ok(token.indexOf('rsms-offline-') === 0);
  assert.ok(token.length > 40);
});

test('gateway-settled rows are detected from the verification trace', function(){
  assert.equal(sync.isGatewaySettled({status:'Confirmed', verifiedAt:'2026-01-01T00:00:00Z'}), true);
  assert.equal(sync.isGatewaySettled({status:'Rejected', gatewayId:'flw-9'}), true);
  assert.equal(sync.isGatewaySettled({status:'Pending'}), false);
  assert.equal(sync.isGatewaySettled({status:'Confirmed'}), false, 'no verification trace = not settled');
  assert.equal(sync.isGatewaySettled(null), false);
});

test('merge: adds flow to the missing side, identical rows are skipped', function(){
  var l = [{id:'a', v:1, updatedAt:'2026-01-02T00:00:00Z'}, {id:'b', v:1}];
  var c = [{id:'b', v:1}, {id:'c', v:3}];
  var m = sync.mergeSnapshot(l, c, 'students');
  assert.deepEqual(m.localAdds.map(function(r){ return r.id; }), ['a']);
  assert.deepEqual(m.cloudAdds.map(function(r){ return r.id; }), ['c']);
  assert.equal(m.conflicts.length, 0);
  assert.equal(m.sameCount, 1);
});

test('merge: money rows never auto-merge — mismatch is always a conflict', function(){
  var l = [{id:'p1', amount:5000, status:'Pending'}];
  var c = [{id:'p1', amount:5000, status:'Confirmed', verifiedAt:'2026-01-01'}];
  var m = sync.mergeSnapshot(l, c, 'payments');
  assert.equal(m.localAdds.length, 0);
  assert.equal(m.cloudAdds.length, 0);
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0].id, 'p1');
  assert.match(m.conflicts[0].reason, /money-row-mismatch/);
});

test('merge: non-money rows use last-write-wins on row timestamps', function(){
  var l = [{id:'s1', name:'Ada', updatedAt:'2026-01-05T00:00:00Z'}];
  var c = [{id:'s1', name:'Ada O.', updatedAt:'2026-01-04T00:00:00Z'}];
  var newerLocal = sync.mergeSnapshot(l, c, 'staff');
  assert.deepEqual(newerLocal.localAdds.map(function(r){ return r.id; }), ['s1']);
  assert.deepEqual(newerLocal.cloudAdds, []);

  var olderLocal = sync.mergeSnapshot(c, l, 'staff');
  assert.deepEqual(olderLocal.cloudAdds.map(function(r){ return r.id; }), ['s1']);
  assert.deepEqual(olderLocal.localAdds, []);
});

test('merge: timestamp ties and missing timestamps become review records', function(){
  var t = '2026-01-01T00:00:00Z';
  var tie = sync.mergeSnapshot(
    [{id:'s1', a:1, updatedAt:t}], [{id:'s1', b:2, updatedAt:t}], 'staff');
  assert.equal(tie.conflicts.length, 1);
  assert.equal(tie.conflicts[0].reason, 'timestamp-tie');

  var none = sync.mergeSnapshot([{id:'s1', a:1}], [{id:'s1', b:2}], 'staff');
  assert.equal(none.conflicts.length, 1);
  assert.equal(none.conflicts[0].reason, 'no-timestamps');
});

test('push batch: idempotent re-delivery is skipped, settled rows are refused', function(){
  var current = [
    {id:'p1', amount:100, status:'Confirmed', verifiedAt:'2026-01-01T00:00:00Z'},
    {id:'s1', name:'Old'}
  ];
  var entries = [
    {intentId:'i-done', localId:'s1', payload:{id:'s1', name:'New'}},
    {intentId:'i-money', localId:'p1', payload:{id:'p1', amount:100, status:'Pending'}},
    {intentId:'i-staff', localId:'s1', payload:{id:'s1', name:'New'}}
  ];
  var result = sync.applyPushBatch('mixed', current, entries, ['i-done']);
  assert.deepEqual(result.skipped.map(function(r){ return r.intentId; }), ['i-done']);
  assert.deepEqual(result.rejected.map(function(r){ return r.intentId; }), ['i-money']);
  assert.match(result.rejected[0].reason, /gateway-settled/);
  assert.deepEqual(result.applied.map(function(r){ return r.localId; }), ['s1']);
  /* The collection keeps its array shape with the row replaced in place. */
  assert.equal(Array.isArray(result.next), true);
  assert.equal(result.next.length, 2);
  var byId = sync.rowsToMap(result.next);
  assert.equal(byId.s1.name, 'New');
  assert.equal(byId.p1.status, 'Confirmed', 'settled row untouched');
  assert.ok(result.markers['i-staff']);
});

test('push batch: map collections stay maps and new rows are added', function(){
  var current = {'k1': {id:'k1', v:1}};
  var result = sync.applyPushBatch('fees', current, [
    {intentId:'i1', localId:'k1', payload:{id:'k1', v:2}},
    {intentId:'i2', localId:'k2', payload:{id:'k2', v:1}}
  ], []);
  assert.equal(Array.isArray(result.next), false);
  assert.equal(result.next.k1.v, 2);
  assert.equal(result.next.k2.v, 1);
  assert.equal(result.applied.length, 2);
});

test('push batch: empty or no-op batches leave the collection untouched', function(){
  var current = [{id:'a', v:1}];
  var noEntries = sync.applyPushBatch('x', current, [], []);
  assert.equal(noEntries.changed, false);
  assert.equal(noEntries.next, current);
});
