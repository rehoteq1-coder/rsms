'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SERVER — cloud sync engine (Phase B)

   Two coordinated directions (docs/offline-design.md §8):
     A. durable outbox push — pending intents in dependency order,
        acknowledged-before-removal, stable idempotency ids;
     B. snapshot pull — per-collection merge with the conflict rules:
        money rows never auto-merge (Bursar Conflict Review), non-money
        rows by row timestamp, ties/unknown become review records.

   The cloud side is the RSMS Cloud Functions (offlineVerifyServer,
   offlineSyncPush, offlineSyncPull), called with the per-school server
   token. The token is stored only in this appliance's config (meta).
═══════════════════════════════════════════════════════════════════ */

var dbModule = require('./db');

var PULL_COLLECTIONS = ['students','staff','fees','payments','wallet','audit_log',
  'attendance','score_entries','expenses','fee_structures','student_fees',
  'recurring','recurring_schedule','broadcasts','notifications','ct_remarks',
  'fee_schedule','stream_config','portal_pins','clock_logs','assignments',
  'flw_config','settings'];

var PUSH_BATCH_SIZE = 25;

function binding(db){
  var value = dbModule.metaGet(db, 'school_binding');
  if(!value) return null;
  try { return JSON.parse(value); } catch(e){ return null; }
}

function setBinding(db, record){
  dbModule.metaSet(db, 'school_binding', JSON.stringify({
    schoolCode: String(record.schoolCode || ''),
    schoolId: String(record.schoolId || ''),
    schoolName: String(record.schoolName || ''),
    installationId: String(record.installationId || dbModule.uuid()),
    cloudValidated: record.cloudValidated === true,
    boundAt: record.boundAt || dbModule.nowIso()
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

function serverToken(db){
  return dbModule.metaGet(db, 'server_token') || '';
}

function setServerToken(db, token){
  dbModule.metaSet(db, 'server_token', String(token || ''));
}

function cloudBaseUrl(db){
  return dbModule.metaGet(db, 'cloud_base_url') || '';
}

function setCloudBaseUrl(db, url){
  dbModule.metaSet(db, 'cloud_base_url', String(url || '').replace(/\/+$/, ''));
}

/* ── Callable client ─────────────────────────────────────────── */

function callFunction(db, name, data){
  var base = cloudBaseUrl(db);
  if(!base) return Promise.reject(new Error('cloud_base_url not configured'));
  return fetch(base + '/' + name, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({data: data})
  }).then(function(response){
    return response.json().catch(function(){ return {}; }).then(function(envelope){
      if(!response.ok){
        var err = envelope && envelope.error;
        var message = (err && (err.message || err.status)) || ('http ' + response.status);
        var error = new Error(String(message));
        error.status = response.status;
        error.code = err && err.status;
        throw error;
      }
      return envelope.result || envelope.data || {};
    });
  });
}

function cloudVerify(db, schoolId, token){
  return callFunction(db, 'offlineVerifyServer', {schoolId: schoolId, serverToken: token});
}

/* ── Push direction ──────────────────────────────────────────── */

function pendingIntents(db, limit){
  return db.prepare(
    'SELECT id, collection, local_id, online_key, action, base_version, payload, created_at ' +
    'FROM outbox WHERE status IN (\'pending\', \'in_flight\') ORDER BY created_at, id LIMIT ' +
    Number(limit || PUSH_BATCH_SIZE)).all();
}

function pushOutbox(db){
  var token = serverToken(db);
  var b = binding(db);
  if(!token || !b || !b.schoolId){
    return Promise.resolve({pushed: 0, reason: 'not-configured'});
  }
  function pushBatch(){
    var batch = pendingIntents(db, PUSH_BATCH_SIZE);
    if(!batch.length) return Promise.resolve({done: true, applied: [], skipped: [], rejected: []});
    db.prepare('UPDATE outbox SET status = \'in_flight\', attempts = attempts + 1 WHERE id IN (' +
      batch.map(function(){ return '?'; }).join(',') + ')')
      .run(...batch.map(function(r){ return r.id; }));
    var entries = batch.map(function(r){
      return {
        intentId: r.id,
        collection: r.collection,
        localId: r.local_id,
        onlineKey: r.online_key || r.local_id,
        action: r.action,
        baseVersion: r.base_version,
        payload: JSON.parse(r.payload)
      };
    });
    return callFunction(db, 'offlineSyncPush', {
      schoolId: b.schoolId,
      serverToken: token,
      entries: entries
    }).then(function(result){
      /* Acknowledged-before-removal: only acknowledged intents clear. */
      (result.applied || []).forEach(function(ack){
        markOutboxAcknowledged(db, ack.intentId, 'cloud:' + ack.localId);
      });
      (result.skipped || []).forEach(function(ack){
        markOutboxAcknowledged(db, ack.intentId, 'cloud:already-processed');
      });
      /* Rejected (e.g. gateway-settled) becomes a bursar conflict, never
         silently dropped and never retried forever. */
      (result.rejected || []).forEach(function(ack){
        if(ack.reason && ack.reason.indexOf('gateway-settled') !== -1){
          var entry = (entries.find(function(e){ return e.intentId === ack.intentId; }) || {});
          registerConflict(db, b.schoolId, {
            collection: entry.collection || '',
            localId: ack.localId || '',
            localData: entry.payload || null,
            cloudData: ack.cloudRow || null,
            reason: ack.reason
          });
        } else {
          db.prepare('UPDATE outbox SET status = \'pending\', last_error = ? WHERE id = ?')
            .run(String(ack.reason || 'rejected'), ack.intentId);
        }
      });
      /* Reset intents the cloud did not settle (defensive: every entry
         should appear in exactly one of applied/skipped/rejected). */
      var settledIds = (result.applied || []).map(function(a){ return a.intentId; })
        .concat((result.skipped || []).map(function(a){ return a.intentId; }))
        .concat((result.rejected || []).map(function(a){ return a.intentId; }));
      var unsettled = batch.filter(function(r){ return settledIds.indexOf(r.id) < 0; });
      if(unsettled.length){
        db.prepare('UPDATE outbox SET status = \'pending\' WHERE id IN (' +
          unsettled.map(function(){ return '?'; }).join(',') + ')')
          .run(...unsettled.map(function(r){ return r.id; }));
      }
      return {done: false, applied: result.applied, skipped: result.skipped, rejected: result.rejected};
    }).catch(function(error){
      /* Transient failure: back off to pending, keep the stable ids. */
      db.prepare('UPDATE outbox SET status = \'pending\', last_error = ? WHERE status = \'in_flight\'')
        .run(String((error && error.message) || 'push failed'));
      throw error;
    });
  }

  var totals = {pushed: 0, skipped: 0, rejected: 0};
  function next(){
    return pushBatch().then(function(result){
      totals.pushed += (result.applied || []).length;
      totals.skipped += (result.skipped || []).length;
      totals.rejected += (result.rejected || []).length;
      if(result.done || totals.pushed === 0 && totals.rejected === 0 && totals.skipped === 0){
        return totals;
      }
      /* No-progress guard: a batch that only produces rejections (already
         converted to conflicts) must not loop forever. */
      if(result.applied.length === 0 && result.skipped.length === 0 && result.rejected.length > 0){
        return totals;
      }
      return next();
    });
  }
  return next().then(function(t){
    dbModule.metaSet(db, 'last_cloud_sync_at', dbModule.nowIso());
    return t;
  }).catch(function(error){
    return {pushed: totals.pushed, skipped: totals.skipped, rejected: totals.rejected,
      error: String((error && error.message) || error)};
  });
}

/* ── Pull direction ──────────────────────────────────────────── */

function registerConflict(db, schoolId, item){
  var existing = db.prepare(
    'SELECT id FROM conflicts WHERE collection = ? AND local_id = ? AND status = \'open\'').get(
      item.collection, item.localId);
  if(existing) return existing.id;
  var id = dbModule.uuid();
  db.prepare(
    'INSERT INTO conflicts (id, collection, local_id, local_data, cloud_data, base_data, reason, status, created_at) ' +
    'VALUES (?,?,?,?,?,?,?,\'open\',?)').run(
      id, item.collection, item.localId,
      item.localData ? JSON.stringify(item.localData) : null,
      item.cloudData ? JSON.stringify(item.cloudData) : null,
      item.baseData ? JSON.stringify(item.baseData) : null,
      item.reason || null,
      dbModule.nowIso());
  db.prepare('INSERT INTO audit_log (id, actor, action, entity, detail, created_at) VALUES (?,?,?,?,?,?)')
    .run(dbModule.uuid(), 'sync-engine', 'conflict-created',
         item.collection + '/' + item.localId, item.reason || '', dbModule.nowIso());
  return id;
}

function applyCloudRow(db, schoolId, collection, row){
  var localId = rowIdOf(row);
  if(!localId) return null;
  var existing = db.prepare('SELECT created_at, row_version FROM rows WHERE collection = ? AND local_id = ?')
    .get(collection, localId);
  dbModule.withTransaction(db, function(){
    db.prepare(
      'INSERT INTO rows (collection, local_id, online_key, school_id, data, updated_at, created_at, sync_state, row_version) ' +
      'VALUES (?,?,?,?,?,?,?,\'synced\',1) ' +
      'ON CONFLICT(collection, local_id) DO UPDATE SET data = excluded.data, ' +
      'updated_at = excluded.updated_at, sync_state = \'synced\', row_version = row_version + 1'
    ).run(collection, localId, localId, schoolId, JSON.stringify(row),
          dbModule.nowIso(), existing ? existing.created_at : dbModule.nowIso());
  });
  return localId;
}

function rowIdOf(row){
  if(!row || typeof row !== 'object') return null;
  var id = row.id || row.localId || (row.walId || row.txId || row.receiptNo);
  return (id !== undefined && id !== null && String(id) !== '') ? String(id) : null;
}

function pullFromCloud(db){
  var token = serverToken(db);
  var b = binding(db);
  if(!token || !b || !b.schoolId){
    return Promise.resolve({pulled: 0, reason: 'not-configured'});
  }
  var pulled = 0;
  var conflicts = 0;
  var requeued = 0;
  return callFunction(db, 'offlineSyncPull', {
    schoolId: b.schoolId,
    serverToken: token,
    collections: PULL_COLLECTIONS
  }).then(function(result){
    var collections = result.collections || {};

    Object.keys(collections).forEach(function(collection){
      var cloudRows = collections[collection] || [];
      if(!cloudRows.length){
        /* An empty cloud snapshot is not a deletion signal in Phase B:
           deletions need tombstones (Phase B+). */
        return;
      }
      var localRows = dbModule.readCollection(db, collection);
      var merge = mergeSnapshot(localRows, cloudRows, collection);

      (merge.cloudAdds || []).forEach(function(row){
        if(applyCloudRow(db, b.schoolId, collection, row)) pulled++;
      });

      (merge.conflicts || []).forEach(function(item){
        registerConflict(db, b.schoolId, {
          collection: collection,
          localId: item.id,
          localData: item.local,
          cloudData: item.cloud,
          reason: item.reason
        });
        conflicts++;
      });

      if((merge.localAdds || []).length){
        /* Rows present locally but absent from the cloud: re-queue durable
           intents (stable idempotency ids make this safe). */
        dbModule.saveCollection(db, b.schoolId, collection, merge.localAdds, 'sync-engine');
        requeued += merge.localAdds.length;
      }
    });

    dbModule.metaSet(db, 'last_cloud_sync_at', dbModule.nowIso());
    return {pulled: pulled, conflicts: conflicts, requeued: requeued};
  }).catch(function(error){
    return {pulled: pulled, conflicts: conflicts, requeued: requeued,
      error: String((error && error.message) || error)};
  });
}

/* Snapshot merge with the conflict rules — mirrors functions/src/offlineSync.js. */
function mergeSnapshot(localRows, cloudRows, collection){
  var MONETARY = {payments:1, wallet:1, fees:1, expenses:1, recurring:1, recurring_schedule:1, student_fees:1};
  function rowsToMap(rows){
    var map = {};
    (rows || []).forEach(function(row){
      var id = rowIdOf(row);
      if(id) map[id] = row;
    });
    return map;
  }
  function canonical(value){
    if(value === null || value === undefined) return 'null';
    if(Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if(typeof value === 'object'){
      return '{' + Object.keys(value).sort().map(function(k){
        return JSON.stringify(k) + ':' + canonical(value[k]);
      }).join(',') + '}';
    }
    return JSON.stringify(value);
  }
  function jsonEqual(a, b){ return canonical(a) === canonical(b); }
  function rowTimestamp(row){
    var best = '';
    ['verifiedAt','updatedAt','recordedAt','timestamp','syncedAt','updated_at'].forEach(function(f){
      var v = String(row && row[f] || '');
      if(v && v > best) best = v;
    });
    return best;
  }

  var localMap = rowsToMap(localRows);
  var cloudMap = rowsToMap(cloudRows);
  var ids = {};
  Object.keys(localMap).forEach(function(id){ ids[id] = true; });
  Object.keys(cloudMap).forEach(function(id){ ids[id] = true; });

  var localAdds = [], cloudAdds = [], conflicts = [];
  Object.keys(ids).forEach(function(id){
    var l = localMap[id];
    var c = cloudMap[id];
    if(l && !c){ localAdds.push(l); return; }
    if(c && !l){ cloudAdds.push(c); return; }
    if(jsonEqual(l, c)) return;
    if(MONETARY[collection]){
      conflicts.push({id: id, local: l, cloud: c, reason: 'money-row-mismatch: never auto-merged; bursar review required'});
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
  return {localAdds: localAdds, cloudAdds: cloudAdds, conflicts: conflicts};
}

/* ── Conflict resolution (Bursar Conflict Review) ────────────── */

function listConflicts(db, limit){
  return db.prepare(
    'SELECT id, collection, local_id, local_data, cloud_data, reason, status, resolved_by, resolution, resolved_at, created_at ' +
    'FROM conflicts ORDER BY (status = \'open\') DESC, created_at DESC LIMIT ' + Number(limit || 200)).all();
}

function resolveConflict(db, schoolId, conflictId, resolution, actor){
  var row = db.prepare('SELECT * FROM conflicts WHERE id = ?').get(conflictId);
  if(!row) return {ok: false, error: 'not-found'};
  if(row.status !== 'open') return {ok: false, error: 'already-resolved'};
  if(resolution !== 'local' && resolution !== 'cloud') return {ok: false, error: 'invalid-resolution'};
  var stamp = dbModule.nowIso();
  var localData = row.local_data ? JSON.parse(row.local_data) : null;
  var cloudData = row.cloud_data ? JSON.parse(row.cloud_data) : null;

  if(resolution === 'local'){
    /* Local wins: re-queue the durable intent; the push carries it.
       saveCollection manages its own transaction. */
    if(localData){
      dbModule.saveCollection(db, schoolId, row.collection, [localData], actor || 'bursar');
    }
  }
  dbModule.withTransaction(db, function(){
    if(resolution === 'cloud'){
      /* Cloud is authoritative for this row: adopt it, mark synced. */
      if(cloudData && rowIdOf(cloudData)){
        db.prepare(
          'INSERT INTO rows (collection, local_id, school_id, data, updated_at, created_at, sync_state, row_version) ' +
          'VALUES (?,?,?,?,?,?,\'synced\',1) ' +
          'ON CONFLICT(collection, local_id) DO UPDATE SET data = excluded.data, ' +
          'updated_at = excluded.updated_at, sync_state = \'synced\', row_version = row_version + 1'
        ).run(row.collection, row.local_id, schoolId, JSON.stringify(cloudData),
              stamp, stamp);
      }
    }
    db.prepare('UPDATE conflicts SET status = \'resolved\', resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
      .run(resolution, actor || 'bursar', stamp, conflictId);
    db.prepare('INSERT INTO audit_log (id, actor, action, entity, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(dbModule.uuid(), actor || 'bursar', 'conflict-resolved',
           row.collection + '/' + row.local_id, 'resolution=' + resolution, stamp);
  });
  return {ok: true, conflictId: conflictId, resolution: resolution};
}

/* ── Sync cycle + loop ───────────────────────────────────────── */

function runSyncCycle(db){
  var b = binding(db);
  if(!b || !b.cloudValidated){
    return Promise.resolve({skipped: true, reason: 'cloud binding not validated (Phase B setup pending)'});
  }
  return pushOutbox(db).then(function(pushResult){
    return pullFromCloud(db).then(function(pullResult){
      return {skipped: false, push: pushResult, pull: pullResult};
    });
  });
}

var loopTimer = null;
var loopRunning = false;

function startSyncLoop(db, intervalMs){
  stopSyncLoop();
  loopTimer = setInterval(function(){
    if(loopRunning) return;
    loopRunning = true;
    runSyncCycle(db).then(function(){
      loopRunning = false;
    }).catch(function(){
      loopRunning = false;
    });
  }, Number(intervalMs || 60000));
  if(loopTimer.unref) loopTimer.unref();
}

function stopSyncLoop(){
  if(loopTimer){ clearInterval(loopTimer); loopTimer = null; }
}

module.exports = {
  PULL_COLLECTIONS:PULL_COLLECTIONS,
  binding:binding,
  setBinding:setBinding,
  clearBinding:clearBinding,
  outboxStatus:outboxStatus,
  markOutboxAcknowledged:markOutboxAcknowledged,
  recordCloudSyncAt:recordCloudSyncAt,
  serverToken:serverToken,
  setServerToken:setServerToken,
  cloudBaseUrl:cloudBaseUrl,
  setCloudBaseUrl:setCloudBaseUrl,
  cloudVerify:cloudVerify,
  callFunction:callFunction,
  pendingIntents:pendingIntents,
  pushOutbox:pushOutbox,
  pullFromCloud:pullFromCloud,
  mergeSnapshot:mergeSnapshot,
  registerConflict:registerConflict,
  listConflicts:listConflicts,
  resolveConflict:resolveConflict,
  runSyncCycle:runSyncCycle,
  startSyncLoop:startSyncLoop,
  stopSyncLoop:stopSyncLoop
};
