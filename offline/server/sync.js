'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SERVER — sync engine (Phase A core + Phase B stub)

   Phase A delivers the durable, audited LOCAL side:
     - outbox intents captured atomically with business writes (db.js)
     - outbox status/age reporting for the health page
     - binding + school-identity guards
   The cloud direction (push/pull/ack) is Phase B and lands with the
   registerOfflineServer cloud function; it is deliberately a no-op
   stub here — this file never opens a network connection by itself.
═══════════════════════════════════════════════════════════════════ */

var dbModule = require('./db');

function binding(db){
  var value = dbModule.metaGet(db, 'school_binding');
  if(!value) return null;
  try { return JSON.parse(value); } catch(e){ return null; }
}

/* First-run binding record. Cloud validation of the school code is
   Phase B (registerOfflineServer); until then the wizard stores the
   record with cloudValidated: false and sync stays paused. */
function setBinding(db, record){
  dbModule.metaSet(db, 'school_binding', JSON.stringify({
    schoolCode: String(record.schoolCode || ''),
    schoolId: String(record.schoolId || ''),
    installationId: String(record.installationId || dbModule.uuid()),
    cloudValidated: record.cloudValidated === true,
    boundAt: dbModule.nowIso()
  }));
}

function clearBinding(db){
  dbModule.metaSet(db, 'school_binding', '');
}

function outboxStatus(db){
  var rows = db.prepare(
    'SELECT status, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest ' +
    'FROM outbox GROUP BY status').all();
  var byStatus = {};
  rows.forEach(function(r){ byStatus[r.status] = {count: r.n, oldest: r.oldest, newest: r.newest}; });
  var conflicts = db.prepare('SELECT COUNT(*) AS n FROM conflicts WHERE status = \'open\'').get().n;
  var lastSync = dbModule.metaGet(db, 'last_cloud_sync_at');
  return {byStatus: byStatus, openConflicts: conflicts, lastCloudSyncAt: lastSync || null};
}

function markOutboxAcknowledged(db, intentId, receipt){
  db.prepare('UPDATE outbox SET status = \'acknowledged\', ack_receipt = ? WHERE id = ?')
    .run(receipt || '', intentId);
  db.prepare('UPDATE rows SET sync_state = \'synced\' ' +
             'WHERE collection = (SELECT collection FROM outbox WHERE id = ?) ' +
             'AND local_id = (SELECT local_id FROM outbox WHERE id = ?)')
    .run(intentId, intentId);
}

function recordCloudSyncAt(db, stamp){
  dbModule.metaSet(db, 'last_cloud_sync_at', stamp);
}

/* ── Phase B cloud connector (stub) ──────────────────────────────
   Implemented together with the registerOfflineServer cloud function.
   Contract: push outbox entries in dependency order with stable
   idempotency ids; pull per-collection rows changed after the cursor;
   never auto-merge money rows (conflicts table + Bursar Review). */
function pushOutbox(db){
  return Promise.resolve({
    pushed: 0,
    skipped: outboxStatus(db).byStatus.pending ? outboxStatus(db).byStatus.pending.count : 0,
    reason: 'cloud-connector-not-implemented (Phase B; requires cloud binding validation)'
  });
}

function pullFromCloud(db){
  return Promise.resolve({
    pulled: 0,
    reason: 'cloud-connector-not-implemented (Phase B; requires cloud binding validation)'
  });
}

module.exports = {
  binding:binding,
  setBinding:setBinding,
  clearBinding:clearBinding,
  outboxStatus:outboxStatus,
  markOutboxAcknowledged:markOutboxAcknowledged,
  recordCloudSyncAt:recordCloudSyncAt,
  pushOutbox:pushOutbox,
  pullFromCloud:pullFromCloud
};
