# RSMS Offline School Server — Design

> **Status: design only.** This is the proposed architecture for schools with
> unreliable internet. It is not an implementation plan for browser-only
> offline caching, and it does not change the current cloud deployment.

## 1. Product boundary

The offline product is a **staff-only LAN deployment**:

- One always-on school PC runs the local RSMS server and a single-file SQLite
  database.
- Staff connect from school computers/phones to that PC over the school Wi-Fi
  or wired LAN and use the familiar RSMS portal pages.
- Parents remain on the cloud Parent Portal. There is deliberately no local
  parent account, parent data endpoint, or public port forwarding from the
  school PC.
- When the internet returns, the local server synchronises authorised school
  data with the existing cloud school. The cloud remains the cross-device,
  parent-facing, and disaster-recovery authority.

This design is intended for a single named school installation. It must never
be used as a generic offline cache shared across schools.

## 2. Architecture overview

```text
Staff browser on LAN
       |
       | http(s)://rsms-school.local:PORT or http://LAN-IP:PORT
       v
Always-on school PC (Windows initially)
  Node.js + Express local server
    |-- serves existing RSMS portal assets
    |-- local authentication / role middleware
    |-- local REST data adapter API
    |-- sync engine (outbox + pull cursor)
    |-- backup, restore, update, and health endpoints
       |
       v
better-sqlite3 single-file database
       |
       | when internet is available
       v
RSMS cloud / Firebase / authorised Cloud Functions
```

The school PC is an appliance-like local server, not a browser application.
This avoids depending on every staff device having the same cached files or
network state, and gives the school one durable local source during an outage.

## 3. Local server and LAN delivery

### Server stack

The first release runs a Node.js process with:

- **Express** for static portal delivery, local API routes, health checks, the
  first-run wizard, and administration pages;
- **better-sqlite3** for synchronous, transactional access to one SQLite file;
- a small sync worker in the same process (or a supervised child worker later
  if isolation is needed); and
- a configuration directory separate from the database for server certificate,
  school binding, backup location, and update metadata.

The existing HTML/CSS/JS portal pages are served unchanged wherever possible.
The local server injects or selects the local data adapter before portal
feature code loads. The adapter preserves existing function names so screens do
not need a second UI implementation.

### LAN endpoints

The wizard advertises a memorable local hostname where supported, plus the
fixed LAN address and port. It prints/displays a QR code containing the staff
portal URL. The health page shows:

- server version and database schema version;
- bound school name/code and last successful cloud sync;
- LAN IP(s), Wi-Fi/ethernet state, and available disk space;
- outbox/conflict counts; and
- backup and update status.

The server binds to the LAN interface only after setup. It must not expose an
internet-facing route, automatic router port forwarding, or a parent portal.
Where the school has a certificate/managed local DNS option, HTTPS is preferred;
otherwise the wizard explains the LAN-only trust limitation clearly.

## 4. School binding and identity

### One install, one school

During first-run setup an authorised administrator enters a **school code** and
completes an online cloud binding. The cloud returns the canonical `schoolId`,
a server installation ID, and a signed/bound registration record. The local
server stores this beside the database and refuses to:

- sync data for another school code or `schoolId`;
- import a database whose school binding differs; or
- accept a remote operation whose school binding does not match.

The binding must be revalidated whenever cloud connectivity returns. A server
cannot silently become a second installation for the same school; the cloud
registration flow either marks it as a recognised replacement or blocks it for
operator review.

### Staff-only local authentication

Local access uses server-side staff authentication, not browser `localStorage`:

- Staff PINs and optional email/password credentials are stored as salted,
  memory-hard password hashes (for example Argon2id; bcrypt only as a migration
  fallback), never as plaintext.
- A staff session is an HttpOnly, Secure where applicable, SameSite cookie with
  short idle/absolute expiry and server-side session revocation.
- The server maintains the same staff roles used by RSMS today (admin, bursar,
  teacher, class teacher, HOD, VP, principal, and permitted staff roles).
- Role middleware protects every local API route. UI hiding is only a
  convenience, not authorization.
- Parent, student, public, superadmin, and payment-provider credentials are
  not accepted by the offline server.

Initial staff credentials are seeded only from an authenticated cloud sync or
an encrypted/bootstrap process controlled by the school administrator. The
first-run wizard forces replacement of any temporary administrator credential.

## 5. SQLite data model

`better-sqlite3` uses one durable SQLite database file, for example
`data/rsms-school.sqlite`, with WAL mode, foreign keys, integrity checks, and
transactional migrations. A SQLite backup is a copy of this one file plus any
required WAL checkpoint; it is not a collection of browser caches.

Every synchronised business row has both local and cloud identity fields:

| Field | Meaning |
| --- | --- |
| `local_id` | UUID generated by the school server. It is stable before and after cloud sync. |
| `online_key` | Canonical Firebase/cloud key once known; nullable for locally created unsynchronised data. |
| `school_id` | Canonical cloud school ID, required on every school-scoped row. |
| `updated_at` | UTC update cursor timestamp from the authoritative side. |
| `created_at` | UTC creation timestamp. |
| `sync_state` | `synced`, `pending`, `conflict`, `rejected`, or `local_only` during an approved workflow. |
| `row_version` | Monotonic/version token used for conflict detection. |

Core tables mirror the existing portal collections—students, staff, classes,
subjects, results, attendance, fee structures, fee assignments, payments,
wallet entries, expenses, settings, and audit information—rather than
inventing incompatible field names. Mapping tables associate `local_id` with
`online_key` for records that predate local UUIDs.

Additional infrastructure tables include:

- `outbox`: immutable local sync intents with dependency order, retry state,
  idempotency UUID, acknowledgement receipt, and normalised error;
- `sync_cursor`: per-collection `updated_at` pull cursor and last successful
  cloud transaction;
- `conflicts`: immutable snapshots of local/base/cloud versions plus a bursar
  decision and resolution audit;
- `local_users` and `sessions`: hashed credential metadata, role snapshots,
  session revoke times, and never plaintext PINs/passwords; and
- `audit_log`: local actor, action, entity, timestamp, sync state, and linked
  cloud audit receipt when available.

## 6. Existing portal data adapter

Portal pages should continue calling the names they already know—for example
reads/saves for students, staff, fees, scores, attendance, finance lookup, and
reports. The adapter selects its transport from a runtime mode flag:

```text
cloud mode:   existing Firebase / Cloud Function adapter
LAN mode:     local Express API adapter
```

The local adapter normalises local API responses to the same arrays/objects the
current pages expect, so report and finance display code can remain shared. It
adds explicit source/sync status to the UI: **Local server**, **Sync pending**,
**Conflict review required**, or **Last cloud sync at …**.

No page should directly query SQLite. The Express API is the only supported
boundary, allowing server-side role checks, input validation, transactions,
and audit writes.

## 7. Online/offline finance rules

Financial integrity is stricter than general school data:

- Local money records are append-only. They are never silently deleted,
  compacted, or auto-merged.
- When the local server is offline, **Flutterwave/card checkout is hidden**.
  The interface offers only authorised **cash** and **bank/manual receipt**
  capture, labelled `Sync pending` until acknowledged by cloud sync.
- Wallet activity, payments, fee amounts, reversals, and adjustments retain
  references, actor, reason, time, and immutable local UUIDs.
- A local financial receipt must state that cloud verification is pending when
  it has not been acknowledged. It must not claim successful gateway payment.
- Gateway verification, provider webhooks, and card status transitions remain
  cloud-only; the offline server does not emulate them.

The Bursar Conflict Review screen is mandatory before a local money intent can
be reconciled with conflicting cloud state. It shows the local receipt, cloud
record, linked student/fee references, values, timestamps, and all related
outbox/audit IDs. Only an authorised bursar may choose an explicit safe action;
the system never guesses a financial merge.

## 8. Sync engine

Sync begins only after the server validates its school-code binding and obtains
an authenticated cloud connection. It has two coordinated directions.

### A. Durable outbox push

1. A local staff action validates role and writes the business transaction,
   local audit event, and `outbox` intent in **one SQLite transaction**.
2. The outbox entry gets a UUID/idempotency key, `school_id`, local UUID,
   current `online_key` if present, base version, action type, and creation
   time.
3. When online, the sync worker sends pending entries in dependency order.
4. The cloud returns an acknowledgement containing canonical key/version and
   audit/receipt correlation.
5. **Only after that acknowledgement is durably committed locally** may the
   outbox entry be marked acknowledged and become eligible for removal by a
   later retention job. A timeout is retried with the same idempotency key.

This “acknowledged before removal” rule prevents local receipt loss and
prevents a temporary connection failure from producing duplicate cloud records.

### B. Incremental pull

1. For each collection, the worker asks cloud for rows changed after its stored
   `updated_at` cursor (with a stable tiebreaker/key if timestamps collide).
2. It verifies the cloud `schoolId` against the installation binding.
3. It applies non-conflicting changes in short SQLite transactions and advances
   the cursor only after the batch is complete.
4. It reconciles `online_key` mappings and acknowledges matching outbox
   entries.
5. It repeats until caught up, then records the successful sync time.

Pull occurs before and after push as needed to reduce stale-base conflicts. It
uses exponential backoff with jitter for network faults and pauses, rather than
deleting work, on permission, schema, or school-binding errors.

## 9. Merge and conflict rules

| Data type | Rule |
| --- | --- |
| Non-money, independent fields (for example a staff contact field or lesson note) | Field-level last-write-wins using `updated_at`, field revision metadata, and a retained audit entry. |
| Non-money row with overlapping edits or schema uncertainty | Create a review record; do not overwrite either side invisibly. |
| Results/attendance where a staff workflow requires a review stage | Respect the existing workflow/role state; no generic overwrite. |
| **Payments, wallet entries, fee amounts, refunds, reversals, expenses, and any monetary ledger value** | **Never auto-merge.** Create a conflict for the Bursar Conflict Review screen. |
| Gateway/card/provider status | Cloud-only; local server cannot authoritatively change it. |

A conflict stays visible until a named authorised user resolves it. Resolution
creates a new audit event and outbox intent; it never edits away the original
local or cloud evidence.

## 10. Packaging and operations

### Windows service packaging

The initial supported appliance is Windows. The installer:

- installs a supported Node.js runtime and the signed RSMS offline package;
- creates an **NSSM Windows service** that starts automatically after reboot;
- runs under a least-privilege service account with restricted data directory
  permissions;
- creates desktop/start-menu shortcuts to the local admin/health page; and
- records service logs, a health endpoint, and a simple support export bundle.

The server should survive a staff browser closing. The health page must make
service restarts and disk/full warnings obvious without exposing secrets.

### Backup and restore

A nightly task performs a verified SQLite backup, keeps the most recent
**7 days**, and records each result in the health page. Backups should be held
on a separate approved local disk/USB/NAS destination where possible.

The restore page is admin-only and requires a confirmation of school code,
backup timestamp, and impact. It stops writes, makes a pre-restore emergency
copy, verifies the candidate SQLite integrity and school binding, restores
atomically, then requires a sync/conflict review before normal operation.

### First-run network wizard

The wizard covers:

1. online school-code binding and administrator bootstrap;
2. server name, detected LAN IP, and staff portal URL;
3. a QR code for staff devices;
4. firewall/LAN visibility checks;
5. a clear recommendation to create a **DHCP reservation** for the school PC
   so its LAN IP does not change; and
6. optional local hostname/DNS and backup destination setup.

### Updates

When cloud connectivity is available, the service checks a signed release
manifest. It downloads/validates an update, performs a backup, applies any
SQLite migration transactionally, restarts through NSSM, and reports success
or a rollback-ready failure. It never force-updates during an active restore,
with unresolved migrations, or while a manually paused sync requires review.

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Shared school PC accessed by an unauthorised person | Data exposure or fraudulent local entry | Locked Windows account, least-privilege NSSM service, short server sessions, hashed credentials, role middleware, screen-lock training, and local audit review. |
| LAN IP changes | Staff cannot reach the portal | First-run IP/QR wizard, DHCP reservation instructions, local hostname option, and health screen showing current address. |
| Disk failure or corruption | Loss of unsynchronised work | WAL/integrity checks, nightly 7-day backups, separate backup target, restore page, cloud sync, and support runbook. |
| Conflict pile-up after a long outage | Delayed reconciliation, especially money | Queue age/conflict alerts, per-collection dashboard, Bursar Conflict Review, and a policy to resolve finance conflicts before additional sensitive activity. |
| Two installs for one school | Split-brain data and duplicate IDs | Signed school-code binding, cloud installation registry, installation ID, operator replacement flow, and refusal to sync an unrecognised second server. |
| Schema drift between local and cloud releases | Failed sync or incorrect mapping | Versioned migrations, API/adapter contract tests, signed update manifest, compatibility window, sync pause with clear upgrade state, and rollback backup. |

## 12. Build plan

### Phase A — Offline server

- Create the Express + better-sqlite3 local server, static portal delivery,
  school-code binding, local staff auth, SQLite migrations, health page,
  backup/restore basics, and a local data adapter for read/write staff flows.
- Deliver LAN setup wizard, QR code, DHCP guidance, NSSM service installer, and
  no-cloud-outage smoke tests.
- Keep Flutterwave hidden offline and limit finance to manual cash/bank
  receipts marked sync-pending.

### Phase B — Sync engine

- Implement schema mapping, `local_id`/`online_key` reconciliation, durable
  outbox with acknowledgement-before-removal, `updated_at` cursor pulls,
  idempotency, retry/backoff, and signed school binding checks.
- Add audit correlation, data/role contract tests, online/offline transition
  tests, and the Bursar Conflict Review screen.
- Pilot first with non-money data, then manual finance receipts under close
  operational review.

### Phase C — Packaging

- Produce the signed Windows installer, NSSM service configuration, updater,
  first-run wizard, backup/restore UI, diagnostics export, support playbook,
  and school administrator training.
- Validate power-loss/reboot recovery, disk-full behaviour, IP changes,
  restore drills, multi-device LAN use, long-outage reconciliation, and
  schema-upgrade rollback before wider deployment.

## 13. Acceptance checks before a pilot

1. A school cannot bind one local database to a second cloud school.
2. A parent cannot authenticate or receive portal data from the LAN server.
3. A staff role denied by cloud/local policy cannot call the corresponding local
   API even if it manipulates page JavaScript.
4. A local receipt survives reboot and network loss until a cloud
   acknowledgement is durably stored.
5. The same outbox UUID can be retried without duplicate cloud business rows.
6. A money conflict always reaches the Bursar Conflict Review screen and is
   never auto-merged.
7. Flutterwave is absent from offline UI; cash/bank entries clearly say
   `Sync pending` until cloud acknowledgement.
8. A seven-day backup/restore drill preserves school binding, local UUIDs,
   outbox state, and audit evidence.
