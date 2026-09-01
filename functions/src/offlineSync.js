'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SYNC — pure cloud-side core (Phase B)

   Server registration validation, token hashing, outbox push
   application (idempotent, gateway-settled guard), and snapshot merge
   with the conflict rules from docs/offline-design.md §9:

     - money rows (payments, wallet, fees, expenses, recurring,
       student_fees) are NEVER auto-merged — mismatches become bursar
       conflicts;
     - non-money rows merge by row timestamp (last-write-wins); a tie or
       missing timestamps becomes a review record, never a silent
       overwrite;
     - a cloud row already settled by the gateway (Confirmed/Rejected
       with a verification trace) is never overwritten by a push.

   All functions here are side-effect free; the RTDB I/O lives in
   index.js.
═══════════════════════════════════════════════════════════════════ */

var crypto = require('crypto');

var MONETARY_COLLECTIONS = {
  payments: true,
  wallet: true,
  fees: true,
  expenses: true,
  recurring: true,
  recurring_schedule: true,
  student_fees: true
};

function cleanText(value, maxLength){
  var text = String(value === undefined || value === null ? '' : value).replace(/^\s+|\s+$/g, '');
  return text.slice(0, maxLength || 200);
}

function sha256(value){
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function hashToken(token){
  return sha256(token);
}

function generateServerToken(){
  return 'rsms-offline-' + crypto.randomBytes(24).toString('hex');
}

function isValidRegistration(input){
  input = input || {};
  var action = cleanText(input.action, 16).toLowerCase();
  var schoolId = cleanText(input.schoolId, 160);
  var schoolCode = cleanText(input.schoolCode, 64);
  if(action !== 'register' && action !== 'replace' && action !== 'revoke'){
    return {ok: false, error: 'action must be register, replace or revoke'};
  }
  if(!schoolId || !/^[A-Za-z0-9-]+$/.test(schoolId)){
    return {ok: false, error: 'a valid schoolId is required'};
  }
  if(action !== 'revoke' && !schoolCode){
    return {ok: false, error: 'schoolCode is required'};
  }
  return {ok: true, action: action, schoolId: schoolId,
          schoolCode: schoolCode, schoolName: cleanText(input.schoolName, 200)};
}

/* ── Row identity / shape helpers ─────────────────────────────── */

function rowIdOf(collection, row){
  if(!row || typeof row !== 'object') return null;
  var id = row.id || row.localId ||
    (collection === 'wallet' ? (row.walId || row.id) : (row.txId || row.id || row.receiptNo));
  if(id !== undefined && id !== null && String(id) !== '') return String(id);
  return null;
}

function toArray(value){
  if(Array.isArray(value)) return value.filter(Boolean);
  if(value && typeof value === 'object'){
    return Object.keys(value).map(function(k){ return value[k]; }).filter(Boolean);
  }
  return [];
}

function rowsToMap(rows){
  var map = {};
  rows.forEach(function(row){
    var id = rowIdOf('generic', row);
    if(id) map[id] = row;
  });
  return map;
}

/* Canonical JSON for stable comparison (key-sorted, null-safe). */
function canonical(value){
  if(value === null || value === undefined) return 'null';
  if(Array.isArray(value)){
    return '[' + value.map(canonical).join(',') + ']';
  }
  if(typeof value === 'object'){
    return '{' + Object.keys(value).sort().map(function(k){
      return JSON.stringify(k) + ':' + canonical(value[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function jsonEqual(a, b){
  return canonical(a) === canonical(b);
}

var TIMESTAMP_FIELDS = ['verifiedAt', 'updatedAt', 'recordedAt', 'timestamp', 'syncedAt', 'updated_at'];

function rowTimestamp(row){
  var best = '';
  TIMESTAMP_FIELDS.forEach(function(field){
    var value = String(row && row[field] || '');
    if(value && value > best) best = value;
  });
  return best;
}

/* A row the gateway has already settled: its status must not be
   changed by local pushes. */
function isGatewaySettled(row){
  var status = String(row && row.status || '').toLowerCase();
  if(status !== 'confirmed' && status !== 'rejected') return false;
  return !!(row && (row.verifiedAt || row.gatewayId || row.verifiedAmount !== undefined));
}

/* ── Snapshot merge (pull direction) ────────────────────────────
   localRows / cloudRows: arrays of rows. Returns where each differing
   row must go; money mismatches and tie/unknown cases become conflicts
   (nothing is ever silently overwritten). */
function mergeSnapshot(localRows, cloudRows, collection){
  var localMap = rowsToMap(localRows || []);
  var cloudMap = rowsToMap(cloudRows || []);
  var ids = {};
  Object.keys(localMap).forEach(function(id){ ids[id] = true; });
  Object.keys(cloudMap).forEach(function(id){ ids[id] = true; });

  var localAdds = [];   // rows to push to the cloud
  var cloudAdds = [];   // rows to apply locally
  var conflicts = [];
  var sameCount = 0;

  Object.keys(ids).forEach(function(id){
    var l = localMap[id];
    var c = cloudMap[id];
    if(l && !c){ localAdds.push(l); return; }
    if(c && !l){ cloudAdds.push(c); return; }
    if(jsonEqual(l, c)){ sameCount++; return; }

    if(MONETARY_COLLECTIONS[collection]){
      conflicts.push({id: id, local: l, cloud: c,
        reason: 'money-row-mismatch: never auto-merged; bursar review required'});
      return;
    }
    var lt = rowTimestamp(l);
    var ct = rowTimestamp(c);
    if(lt && ct){
      if(lt > ct) localAdds.push(l);
      else if(ct > lt) cloudAdds.push(c);
      else conflicts.push({id: id, local: l, cloud: c, reason: 'timestamp-tie'});
      return;
    }
    if(lt && !ct){ localAdds.push(l); return; }
    if(ct && !lt){ cloudAdds.push(c); return; }
    conflicts.push({id: id, local: l, cloud: c, reason: 'no-timestamps'});
  });

  return {localAdds: localAdds, cloudAdds: cloudAdds, conflicts: conflicts, sameCount: sameCount};
}

/* ── Outbox push application (push direction, cloud side) ───────
   current: the cloud collection as stored (array or map).
   entries: [{intentId, localId, onlineKey, action, payload}] in
   dependency order. processedIds: intent ids already acknowledged.
   Returns the single write (same shape as the input), per-entry
   results, and the processed markers to persist atomically. */
function applyPushBatch(collection, current, entries, processedIds){
  processedIds = processedIds || [];
  var wasArray = Array.isArray(current);
  var rows = toArray(current);
  var map = rowsToMap(rows);
  var written = {};
  var applied = [];
  var skipped = [];
  var rejected = [];
  var markers = {};
  var changed = false;

  (entries || []).forEach(function(entry){
    if(!entry || !entry.intentId) return;
    if(processedIds.indexOf(entry.intentId) >= 0){
      skipped.push({intentId: entry.intentId, reason: 'already-processed'});
      return;
    }
    var row = entry.payload;
    var id = rowIdOf(collection, row);
    if(!id){
      rejected.push({intentId: entry.intentId, reason: 'row-without-id'});
      return;
    }
    var existing = map[id];
    if(existing && isGatewaySettled(existing) && !jsonEqual(existing, row)){
      rejected.push({intentId: entry.intentId, localId: id,
        reason: 'gateway-settled: cloud row is verified; local push refused, conflict required',
        cloudRow: existing});
      return;
    }
    if(existing){
      rows = rows.filter(function(r){ return rowIdOf(collection, r) !== id; });
    }
    rows.push(row);
    map[id] = row;
    written[id] = row;
    applied.push({intentId: entry.intentId, localId: id});
    markers[entry.intentId] = {
      collection: collection,
      localId: id,
      onlineKey: entry.onlineKey || id,
      at: new Date().toISOString()
    };
    changed = true;
  });

  return {
    wasArray: wasArray,
    next: changed || !wasArray ? (wasArray ? rows : map) : current,
    applied: applied,
    skipped: skipped,
    rejected: rejected,
    markers: markers,
    changed: changed
  };
}

module.exports = {
  MONETARY_COLLECTIONS:MONETARY_COLLECTIONS,
  cleanText:cleanText,
  sha256:sha256,
  hashToken:hashToken,
  generateServerToken:generateServerToken,
  isValidRegistration:isValidRegistration,
  rowIdOf:rowIdOf,
  toArray:toArray,
  rowsToMap:rowsToMap,
  canonical:canonical,
  jsonEqual:jsonEqual,
  rowTimestamp:rowTimestamp,
  isGatewaySettled:isGatewaySettled,
  mergeSnapshot:mergeSnapshot,
  applyPushBatch:applyPushBatch
};
