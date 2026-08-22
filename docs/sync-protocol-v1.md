# RSMS offline-sync protocol v1 (foundation)

## Scope and safety boundary

This is a **local-only pilot foundation**, not a live sync feature. `rsms-sync.js` uses a new, separate IndexedDB database named `rsms-offline-sync-v1`; it neither reads nor changes legacy browser storage, existing RSMS data paths, authentication, Firebase configuration, or `rsms-firebase.js`.

The default and required initial configuration is:

```js
sync: { enabled: false, transport: 'disabled' }
```

The public API exposes adapter names `disabled`, `firebaseGateway`, and `lanHub` for future protocol work. In v1 all adapters are inert: `syncNow()` returns `sent: false` and the script contains no `fetch`, Firebase, WebSocket, or LAN transport. Selecting a non-default name does not enable any network behavior.

Include `rsms-sync.js` before `rsms-pwa.js` only on pages that intentionally need the local foundation. `rsms-pwa.js` then initializes it safely, but never starts a sync.

## Local database

| Store | Key | Purpose |
| --- | --- | --- |
| `meta` | `key` | schema marker and a Web-Crypto-generated, stable per-database device ID |
| `outbox` | `operationId` | locally queued mutation operations and their retained terminal status |
| `inbox` | `receiptId` | retained acknowledgement/rejection receipts |
| `entities` | `entityKey` | optional local entity snapshots, separate from legacy storage |
| `conflicts` | `conflictId` | open rejection/conflict markers |

Operation IDs and receipt IDs are UUIDs generated with Web Crypto (`crypto.randomUUID()` or `crypto.getRandomValues()`). Initialization creates the device ID once and keeps it in `meta` until pilot data is explicitly cleared.

## Operation envelope

`RSMS_SYNC.enqueue()` accepts:

```js
{
  type: 'attendance.recorded',
  entityType: 'attendance',
  entityId: 'local-row-42',
  payload: { /* application-defined data */ },
  dedupeKey: 'optional-stable-command-key'
}
```

The stored envelope adds `operationId`, `deviceId`, `status: 'pending'`, `createdAt`, and `attempts`. `type`, `entityType`, and `entityId` are required. A supplied `dedupeKey` is preferred. If absent, v1 builds a deterministic key from the operation fields and a stable serialization of the payload. The outbox has a unique `dedupeKey` index, so repeated clicks and cross-tab races return the original queued operation with `duplicate: true` rather than creating a second mutation.

## Receipts, conflicts, and retention

A future trusted receiver may pass only a validated receipt shape to this local foundation:

```js
await RSMS_SYNC.acknowledge(operationId);
await RSMS_SYNC.reject(operationId, 'validation_failed');
// equivalent: applyReceipt({ operationId, status: 'ack' | 'reject', reasonCode? })
```

Acknowledged and rejected outbox records are **retained**, never silently removed. Every receipt is retained in `inbox`. A rejection additionally creates/updates a conflict marker in `conflicts`; reason codes are normalized to a short token. This supports audit and reconciliation during a pilot. There is no retry loop or background transport in v1.

## Diagnostics and clearing

`RSMS_SYNC.getStatus()` and `RSMS_SYNC.exportDiagnostics()` return aggregate counts and transport safety flags. The exported diagnostics intentionally exclude device IDs, operation/entity IDs, payloads, receipt reasons, timestamps, and all configuration values/secrets. `rsms-sync-diagnostics.html` renders only that redacted diagnostic object.

`RSMS_SYNC.clearPilotData()` clears only the five stores in `rsms-offline-sync-v1`. It does not call Firebase, touch auth, change localStorage/sessionStorage, or alter existing RSMS records. A later initialization creates a new pilot device ID.

## Future transport gate

Before any transport implementation, require a separately reviewed protocol version that defines authentication, tenant/school scoping, authorization, payload encryption/privacy, idempotency, receipt authenticity, conflict resolution, user consent, rollout controls, and operational monitoring. Do not turn `enabled` on as a shortcut: v1 has no live adapter by design.
