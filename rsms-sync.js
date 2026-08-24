/* RSMS offline-sync foundation v1. Deliberately local-only: it never sends network traffic. */
(function (global) {
  'use strict';

  var DB_NAME = 'rsms-offline-sync-v1';
  var DB_VERSION = 1;
  var STORE_NAMES = ['meta', 'outbox', 'inbox', 'entities', 'conflicts'];
  var dbPromise = null;
  var initialized = false;
  var defaultConfig = { enabled: false, transport: 'disabled' };

  function now() { return new Date().toISOString(); }
  function safeCrypto() {
    return global.crypto || (typeof crypto !== 'undefined' ? crypto : null);
  }
  function uuid() {
    var c = safeCrypto();
    if (!c) throw new Error('RSMS Sync requires Web Crypto for operation IDs.');
    if (typeof c.randomUUID === 'function') return c.randomUUID();
    if (typeof c.getRandomValues !== 'function') throw new Error('RSMS Sync requires crypto.getRandomValues.');
    var bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function configured() {
    var input = global.RSMS_CONFIG && global.RSMS_CONFIG.sync || {};
    return {
      enabled: input.enabled === true,
      transport: ['disabled', 'firebaseGateway', 'lanHub'].indexOf(input.transport) >= 0 ? input.transport : defaultConfig.transport
    };
  }
  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB request failed.')); };
    });
  }
  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error || new Error('IndexedDB transaction failed.')); };
      transaction.onabort = function () { reject(transaction.error || new Error('IndexedDB transaction aborted.')); };
    });
  }
  function openDatabase() {
    if (dbPromise) return dbPromise;
    if (!global.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
    dbPromise = new Promise(function (resolve, reject) {
      var request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('outbox')) {
          var outbox = db.createObjectStore('outbox', { keyPath: 'operationId' });
          outbox.createIndex('dedupeKey', 'dedupeKey', { unique: true });
          outbox.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { keyPath: 'receiptId' });
        if (!db.objectStoreNames.contains('entities')) db.createObjectStore('entities', { keyPath: 'entityKey' });
        if (!db.objectStoreNames.contains('conflicts')) db.createObjectStore('conflicts', { keyPath: 'conflictId' });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { dbPromise = null; reject(request.error || new Error('Could not open IndexedDB.')); };
    });
    return dbPromise;
  }
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
  }
  function cleanReason(value) {
    var reason = String(value || 'rejected').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
    return reason || 'rejected';
  }
  function countStore(db, name) {
    var tx = db.transaction(name, 'readonly');
    return requestResult(tx.objectStore(name).count());
  }
  function countStatus(db, status) {
    var tx = db.transaction('outbox', 'readonly');
    return requestResult(tx.objectStore('outbox').index('status').count(status));
  }

  function initialize() {
    return openDatabase().then(function (db) {
      var tx = db.transaction('meta', 'readwrite');
      var store = tx.objectStore('meta');
      return requestResult(store.get('deviceId')).then(function (record) {
        if (!record) store.put({ key: 'deviceId', value: uuid(), createdAt: now() });
        store.put({ key: 'schemaVersion', value: DB_VERSION });
        return transactionDone(tx);
      }).then(function () { initialized = true; return getStatus(); });
    });
  }

  function getDeviceId() {
    return initialize().then(function () {
      return openDatabase();
    }).then(function (db) {
      var tx = db.transaction('meta', 'readonly');
      return requestResult(tx.objectStore('meta').get('deviceId')).then(function (record) { return record.value; });
    });
  }

  function enqueue(input) {
    input = input || {};
    if (!input.type || !input.entityType || input.entityId === undefined || input.entityId === null) {
      return Promise.reject(new Error('enqueue requires type, entityType, and entityId.'));
    }
    var signature = String(input.type) + ':' + String(input.entityType) + ':' + String(input.entityId) + ':' + stableStringify(input.payload === undefined ? null : input.payload);
    var dedupeKey = String(input.dedupeKey || signature);
    return initialize().then(function () { return Promise.all([openDatabase(), getDeviceId()]); }).then(function (result) {
      var db = result[0];
      var deviceId = result[1];
      var operation = {
        operationId: uuid(), deviceId: deviceId, type: String(input.type), entityType: String(input.entityType),
        entityId: String(input.entityId), payload: input.payload === undefined ? null : input.payload,
        dedupeKey: dedupeKey, status: 'pending', createdAt: now(), attempts: 0
      };
      var tx = db.transaction('outbox', 'readwrite');
      var store = tx.objectStore('outbox');
      return requestResult(store.index('dedupeKey').get(dedupeKey)).then(function (existing) {
        if (existing) return { operation: existing, duplicate: true, tx: tx };
        store.add(operation);
        return { operation: operation, duplicate: false, tx: tx };
      }).then(function (result) {
        return transactionDone(tx).then(function () { return { operation: result.operation, duplicate: result.duplicate }; });
      }).catch(function (error) {
        /* A second tab may win the unique-index race; return that operation instead. */
        if (error && error.name === 'ConstraintError') {
          var retry = db.transaction('outbox', 'readonly');
          return requestResult(retry.objectStore('outbox').index('dedupeKey').get(dedupeKey)).then(function (existing) {
            if (existing) return { operation: existing, duplicate: true };
            throw error;
          });
        }
        throw error;
      });
    });
  }

  function applyReceipt(receipt) {
    receipt = receipt || {};
    var status = receipt.status === 'ack' ? 'acked' : receipt.status === 'reject' ? 'rejected' : null;
    if (!receipt.operationId || !status) return Promise.reject(new Error('Receipt requires an operationId and status of ack or reject.'));
    return initialize().then(openDatabase).then(function (db) {
      var tx = db.transaction(['outbox', 'inbox', 'conflicts'], 'readwrite');
      var outbox = tx.objectStore('outbox');
      return requestResult(outbox.get(receipt.operationId)).then(function (operation) {
        if (!operation) throw new Error('Unknown operation receipt.');
        /* Receipts are retained, including repeats, for an auditable pilot history. */
        var completedAt = now();
        operation.status = status;
        operation.completedAt = completedAt;
        if (status === 'rejected') operation.rejectCode = cleanReason(receipt.reasonCode);
        outbox.put(operation);
        tx.objectStore('inbox').put({ receiptId: uuid(), operationId: operation.operationId, status: status, receivedAt: completedAt, reasonCode: status === 'rejected' ? operation.rejectCode : undefined });
        if (status === 'rejected') {
          tx.objectStore('conflicts').put({ conflictId: operation.operationId, operationId: operation.operationId, status: 'open', reasonCode: operation.rejectCode, createdAt: completedAt });
        }
        return transactionDone(tx).then(function () { return { operationId: operation.operationId, status: status, retained: true }; });
      });
    });
  }

  function putEntity(entityType, entityId, data, version) {
    if (!entityType || entityId === undefined || entityId === null) return Promise.reject(new Error('putEntity requires entityType and entityId.'));
    return initialize().then(openDatabase).then(function (db) {
      var tx = db.transaction('entities', 'readwrite');
      tx.objectStore('entities').put({ entityKey: String(entityType) + ':' + String(entityId), entityType: String(entityType), entityId: String(entityId), data: data === undefined ? null : data, version: version === undefined ? null : version, updatedAt: now() });
      return transactionDone(tx);
    });
  }

  function getStatus() {
    return openDatabase().then(function (db) {
      return Promise.all(STORE_NAMES.map(function (name) { return countStore(db, name); }).concat([countStatus(db, 'pending'), countStatus(db, 'acked'), countStatus(db, 'rejected')])).then(function (values) {
        var config = configured();
        return {
          schemaVersion: DB_VERSION, initialized: initialized, localOnly: true,
          transport: { configured: config.transport, enabled: config.enabled, networkAllowed: false },
          counts: { meta: values[0], outbox: values[1], inbox: values[2], entities: values[3], conflicts: values[4], pending: values[5], acked: values[6], rejected: values[7] }
        };
      });
    });
  }

  function exportDiagnostics() {
    return getStatus().then(function (status) {
      /* Intentionally omit device IDs, operation/entity IDs, payloads, receipt reasons, timestamps, and config secrets. */
      return { format: 'rsms-sync-diagnostics-v1', generated: true, schemaVersion: status.schemaVersion, localOnly: true, transport: status.transport, counts: status.counts };
    });
  }

  function clearPilotData() {
    return openDatabase().then(function (db) {
      var tx = db.transaction(STORE_NAMES, 'readwrite');
      STORE_NAMES.forEach(function (name) { tx.objectStore(name).clear(); });
      return transactionDone(tx).then(function () { initialized = false; return { cleared: true, stores: STORE_NAMES.slice() }; });
    });
  }

  /* All adapters are intentionally inert in this foundation. No code path calls fetch, Firebase, WebSocket, or LAN APIs. */
  function disabledTransport(name) {
    return { name: name, enabled: false, send: function () { return Promise.resolve({ sent: false, reason: 'transport-disabled' }); } };
  }
  function getTransport(name) {
    name = name || configured().transport;
    return disabledTransport(['disabled', 'firebaseGateway', 'lanHub'].indexOf(name) >= 0 ? name : 'disabled');
  }
  function syncNow() { return getTransport().send(); }

  global.RSMS_SYNC = {
    version: '1.0.0', initialize: initialize, getDeviceId: getDeviceId, enqueue: enqueue,
    applyReceipt: applyReceipt, acknowledge: function (operationId) { return applyReceipt({ operationId: operationId, status: 'ack' }); },
    reject: function (operationId, reasonCode) { return applyReceipt({ operationId: operationId, status: 'reject', reasonCode: reasonCode }); },
    putEntity: putEntity, getStatus: getStatus, exportDiagnostics: exportDiagnostics,
    clearPilotData: clearPilotData, getTransport: getTransport, syncNow: syncNow
  };
})(window);
