# RSMS Offline — Pilot Playbook & Support Runbook

Companion to `docs/offline-design.md` §10–13 (Phases A–C). Audience:
platform operator and school ICT administrator. The offline appliance is
an **always-on staff-only LAN server**; parents always stay on the cloud
portal.

## 1. Pre-pilot acceptance checklist

| # | Check (design §13) | How it is verified |
| --- | --- | --- |
| 1 | A local database cannot be bound to a second cloud school | `offlineVerifyServer` matches the token's `schoolId`; binding wizard rejects mismatch; restore of a foreign-school backup is refused (tested: `backup.test.js`) |
| 2 | Parents cannot authenticate or receive portal data from the LAN | No parent routes exist in `offline/server/index.js`; staff auth is PIN + role middleware (tested: `server.test.js`) |
| 3 | A denied role cannot call the API, even with tampered page JS | Every route re-checks the session + role server-side (tested: `server.test.js`, `ops.test.js`) |
| 4 | A local receipt survives reboot and network loss | Outbox is SQLite-persisted with the write in the same transaction; sync resumes on reconnect (tested: `sync.test.js`) |
| 5 | Retried outbox UUIDs never duplicate cloud rows | Cloud `offlineSyncPush` is idempotent per intent id, 2000-entry ledger (tested: `offlineSync.test.js`, `sync.test.js`) |
| 6 | A money conflict always reaches Bursar Conflict Review, never auto-merges | `mergeSnapshot` money rules + `offlineSyncPush` gateway-settled refusal (tested: `sync.test.js`) |
| 7 | Flutterwave absent offline; manual entries say "Sync pending" | Card config stripped in LAN mode; adapter marks pending (Phase A) |
| 8 | 7-day backup/restore drill preserves binding, UUIDs, outbox, audit | `backup.test.js` restore drill + manual drill below |

## 2. Building the installer (operator, Windows machine, ~10 min)

Prereqs: Inno Setup 6 (free) installed; internet access.

```powershell
cd <repo>\installer
powershell -ExecutionPolicy Bypass -File .\fetch-deps.ps1   # Node 22.22.3 + nssm 2.24 → vendor\
iscc .\rsms-offline.iss
# → installer\output\rsms-offline-setup-0.3.0.exe
```

Also run `npm install` in `offline/` first (the installer ships
`offline\node_modules` — the server's only runtime dependency is
express). The setup.exe is **unsigned**: first launch shows SmartScreen
"More info → Run anyway". Sign the output with an operator code-signing
certificate when one is available.

## 3. Installing at a school (operator, ~30 min)

1. On the school PC (Windows 10/11, x64): run
   `rsms-offline-setup-<ver>.exe`. The
   installer copies the server, a portable Node 22 runtime, `nssm.exe`,
   creates shortcuts and **installs + starts the `RSMSOffline` service**
   (auto-start, self-restarting, logs under `C:\ProgramData\RSMS-Offline\logs`).
2. Browser on the LAN: `http://<LAN-IP>:8300/staff-login.html` → bootstrap
   the staff account → open `http://<LAN-IP>:8300/wizard.html`:
   - bind the school code (and, for offline-registered schools, the
     one-time **server token** from the platform superadmin — runbook
     Stage 7b — plus the cloud base URL),
   - print the staff QR code,
   - note the DHCP reservation steps for the ICT teacher,
   - set the backup destination (separate disk/USB/NAS preferred) and run
     the first verified backup.
3. Verify `http://<LAN-IP>:8300/health`: "cloud validated" (if a token was
   given), outbox counts, backups, disk free, service boot info.
4. Lock the Windows session to the least-privilege staff account; the
   service itself keeps running.

## 4. Signing releases (operator, once per release)

The updater (`server/updater.js`) accepts **only signed releases**.

1. Generate the release signing keypair **on the operator's machine** and
   keep the private key in the secret store (never in this repo, never in
   chat):

   ```bash
   node -e "const c=require('crypto'),k=c.generateKeyPairSync('ed25519');\n\
   console.log('PUBLIC:',k.publicKey.export({type:'spki',format:'der'}).toString('base64'));\n\
   console.log('PRIVATE (store securely):',k.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'));"
   ```

2. Put the `PUBLIC` value into
   `offline/server/updater.js` → `RELEASE_PUBLIC_KEY` and rebuild the
   installer. (Until this is done the updater refuses every release —
   safe default.)
3. To build a release: copy the updated `offline/` files into a staging
   dir, compute the manifest, sign it with the private key:

   ```bash
   node -e "
   const c=require('crypto'),fs=require('fs'),path=require('path');
   const dir=process.argv[1], version=process.argv[2], privB64=process.argv[3];
   const files={};
   (function walk(rel){fs.readdirSync(path.join(dir,rel)).forEach(f=>{
     const p=path.join(dir,rel,f);
     if(fs.statSync(p).isDirectory()) return walk(rel?rel+'/'+f:f);
     files[rel?rel+'/'+f:f]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
   });})('');
   const m={version,releasedAt:new Date().toISOString(),files};
   const canon=(o)=>typeof o==='object'&&o? (Array.isArray(o)?'['+o.map(canon).join(',')+']'
     :'{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canon(o[k])).join(',')+'}'):JSON.stringify(o);
   m.signature=c.sign(null,Buffer.from(canon({version:m.version,releasedAt:m.releasedAt,files:m.files})),
     c.createPrivateKey({key:Buffer.from(privB64,'base64'),type:'pkcs8',format:'der'})).toString('base64');
   fs.writeFileSync(path.join(dir,'release-manifest.json'),JSON.stringify(m,null,2));
   " <staging-dir> <version> <private-key-base64>
   ```

4. Ship the staging dir to the school PC (USB), then either
   `node --experimental-sqlite offline/server/apply-release.js <dir>`
   or `POST /api/admin/update {"releaseDir":"C:\\..."}` from the admin
   session, then restart (health page → "restart service", or
   `nssm restart RSMSOffline`).

**Safety rails (enforced in code):** update is paused during a restore or
schema migration; a verified backup is always taken first (named
`pre-update-<version>`); signature + per-file SHA-256 verified before any
change; the service records `pending_restart` and the next boot clears it.

## 5. Daily operations (school administrator, 1 page)

- **Staff** open the portal from the printed QR (or `http://<IP>:8300/staff-login.html`).
- **Bursar** watches:
  - `http://<IP>:8300/health` — outbox pending count, last cloud sync,
    backups, disk space.
  - `http://<IP>:8300/conflicts.html` — **money conflicts are never
    auto-merged**; resolve each: *Local wins* re-pushes this appliance's
    record, *Cloud wins* adopts the cloud record. Resolve finance
    conflicts before further financial activity.
- **Backups** run nightly (03:15 default) and are kept for 7 days;
  "Run first backup now" lives in the wizard and
  `POST /api/admin/backup`.
- **Never** change the PC's IP without a DHCP reservation; if it changes,
  re-print the QR (wizard).
- For support: `http://<IP>:8300/api/admin/diag.download` (admin session)
  downloads a diagnostics bundle — it contains **no secrets** (no server
  token, no PINs, no gateway keys).

## 6. Drills

### 6.1 Power loss / reboot
1. Cut power (or reboot).
2. On return: the service auto-starts (NSSM `SERVICE_AUTO_START`);
   `health` shows boot count incremented, outbox intact, "Last cloud
   sync" as before.
3. Within ~60 s the sync loop runs: outbox drains, pull merges.
   Acceptance: no pending rows older than one sync interval, no lost
   receipts.

### 6.2 Network loss / long outage
1. Unplug the internet (LAN stays up).
2. Keep entering data for 1–2 hours: outbox grows, health shows pending.
3. Restore internet: the next sync cycle pushes (idempotent) and pulls;
   money rows changed on both sides appear in Conflict Review.
4. Acceptance: zero duplicate cloud rows, every money difference in the
   review screen, nothing silently overwritten.

### 6.3 IP change
1. Ask the router to hand the PC a new IP (simulates lease expiry).
2. Staff devices lose the portal → run the wizard, note the new IP,
   re-print the QR, and create the **DHCP reservation** to make this a
   one-time event.

### 6.4 Restore drill (weekly, 5 min)
1. `GET /api/admin/backups` → pick yesterday's backup.
2. `POST /api/admin/backups/<name>/restore` with
   `{"schoolCode":"<CODE>","createdAt":"<exact timestamp>"}` — both must
   match what the operator sees; the server also checks the file hash,
   full integrity, schema version and school identity.
3. A pre-restore emergency copy is written to `backups/pre-restore/`.
4. Writes are paused (503) only for the duration of the swap.
5. Review outbox + conflicts, then resume normal operation.
   Acceptance: binding, local UUIDs, outbox state and audit rows all
   match the backup point.

### 6.5 Disk full
- `health` turns the disk row amber (<3 GB) then red (<1 GB).
- Response: point backups at a bigger destination
  (`POST /api/admin/backups/config {"dir":"D:\\rsms-backups"}`), prune old
  backups (retention is automatic), or free disk. Writes are **not**
  blocked by low disk — the outbox keeps the data durable; the alert must
  be acted on.

### 6.6 Schema upgrade / rollback
- Apply the signed release (section 4). If the new server reports
  "SCHEMA MIGRATION PENDING" on health, stop: restore the
  `pre-update-<version>` backup (drill 6.4) and re-apply the previous
  release. Updates are never forced mid-restore or mid-migration.

## 7. Rollback & replacement flows

- **Replace appliance** (new PC, same school): platform superadmin calls
  `registerOfflineServer` with `"action":"replace"` (old token dies),
  fresh-install the new PC, bind with the new token. Then restore the
  latest verified backup from the old PC's backup destination (drill
  5.4) — one install, one school, no split-brain.
- **Decommission**: `"action":"revoke"`; the local server keeps working
  offline with sync paused (its token check fails, outbox keeps
  accumulating). Take a final verified backup.

## 8. Known deferrals (documented)

- Pull is full-snapshot per collection (simple/stateless); incremental
  cursors come with scale, if ever needed.
- Deletion sync (tombstones) is not in v1: a row deleted on one side is
  re-created from the other side's snapshot. Delete carefully and resolve
  conflicts.
- The diagnostic bundle omits row payloads (ids/collections/reasons only)
  to keep the export non-sensitive.
