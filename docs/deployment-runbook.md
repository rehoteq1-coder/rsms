# RSMS production deployment runbook — Finance/Gateway Phases 1–4

> **Status (2026-08-27):** the per-school gateway model is **approved and
> implemented** (`docs/per-school-gateways.md`). **Each school is the direct
> gateway account holder** — no shared platform account, and **no platform
> gateway secrets to set**: every school's own key is entered by that
> school's bursar and stored in Google Secret Manager by the deployed
> `storeGatewaySecret` function. Deploy these four functions:
> `verifyPayment`, `paymentWebhook`, `provisionUser`, `storeGatewaySecret`.

This runbook deploys the already-merged implementation (commit `5ec1fd0`,
PR #12) to Firebase project **`rsms-a84ff`**. It is ordered so that:

1. gateway secrets exist **only** in Firebase Functions secret storage;
2. Cloud Functions deploy **only after** the secrets are set;
3. the **compatibility** RTDB rules go live **before** any strict rules;
4. card payments stay `Pending` until server-side verification confirms them;
5. cash/manual flows are never touched.

No command in this runbook passes a gateway secret on a command line, in a
file, or in chat. Secret values are entered only at the interactive
`firebase functions:secrets:set` CLI prompt.

---

## Preflight results (verified locally, 2026-08-26)

| Check | Result |
| --- | --- |
| Repo state | Clean working tree; Phases 1–4 (`5ec1fd0`) + Phase 5 per-school gateways on this branch |
| `functions/` dependencies | `npm install` OK (firebase-functions v5, firebase-admin, @google-cloud/secret-manager, node 20) |
| Syntax check | `node --check` passes for `src/index.js`, `src/gateway.js`, `src/secretstore.js` |
| Unit tests | `npm test` — **15/15 pass** (provider mapping, signature checks, pending→confirmed transitions, idempotency, key-format validation, secret-name mapping, webhook school parsing, secret store set/get/rotate/revoke) |
| JSON validity | `firebase.json`, both rules files, `functions/package.json` all parse |
| Secret leak scan | Working tree **and** full git history contain no gateway **secret** values. Only Flutterwave **public** keys (`FLWPUBK-…`) appear, which are client-side checkout keys and public by design. |
| Project identity | Web config targets `rsms-a84ff`, RTDB `rsms-a84ff-default-rtdb` (europe-west1) |
| Functions to deploy | `verifyPayment` (callable), `paymentWebhook` (HTTP), `provisionUser` (callable), `storeGatewaySecret` (callable) — codebase `rsms`, region default `us-central1` |
| Platform gateway secrets | **None required** — per-school keys are stored server-side by `storeGatewaySecret` in Google Secret Manager |

---

## Stage 0 — Prerequisites and project confirmation

Run from a terminal that has internet access to Google's Firebase APIs
(`*.googleapis.com`).

```bash
# once, if firebase-tools is not installed
npm install -g firebase-tools

firebase login
firebase use rsms-a84ff
firebase projects:info:get rsms-a84ff
```

Confirm the output shows project id `rsms-a84ff`. Stop if it does not.

## Stage 1 — Current-state audit (read-only)

```bash
firebase functions:list
firebase functions:secrets:list
firebase auth:list --limit 20
```

Note what exists already. If `verifyPayment`/`paymentWebhook` are already
deployed, the deploy in Stage 3 overwrites them with the same code — that is
expected. If secrets already exist, skip Stage 2 (or re-run it to rotate).

Also check the **live** RTDB rules: Firebase console →
`rsms-a84ff-default-rtdb` → Rules. They are either the legacy open rules, the
compat rules, or (must verify) the strict rules. Record which.

## Stage 2 — One-time IAM grant (no gateway secrets to set)

With per-school gateways there are **no platform gateway secrets to set**.
Each school's own key is entered by that school's bursar in the Bursar page
and stored in Google Secret Manager by the `storeGatewaySecret` function.

That function needs write access to Secret Manager through the Cloud
Functions service account. Grant it once:

1. Firebase console → project `rsms-a84ff` → **IAM and Admin → IAM**.
2. Find the **Cloud Functions service account**
   (`<numeric-project-id>-compute@developer.gserviceaccount.com`).
3. Add member → grant **Secret Manager Manager**
   (`roles/secretmanager.secretManager`) on the project.

Or via CLI:

```bash
gcloud projects add-iam-policy-binding rsms-a84ff \
  --member=serviceAccount:<numeric-project-id>-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretManager
```

> If you already ran `firebase functions:secrets:set` for the old model's
> `FLUTTERWAVE_SECRET_KEY` / `PAYSTACK_SECRET_KEY`, those secrets are now
> unused. Optional cleanup: `firebase functions:secrets:delete <name> --force`.

## Stage 3 — Deploy Cloud Functions (after Stage 2's IAM grant)

```bash
# from the repository root
firebase deploy --only functions
```

Do **not** run a bare `firebase deploy` — `firebase.json` currently points
`database.rules` at the strict `database.rules.json`, which must NOT go live
yet (Stage 4 explains the compat-first order).

The deploy output lists the deployed HTTPS URLs. Capture all six; the three
gateway functions you configure in RSMS are:

- `verifyPayment` (callable) — example shape:
  `https://verifyPayment-<hash>-rsms-a84ff-<numeric-id>.us-central1.cloudfunctions.net`
- `paymentWebhook` (HTTP) — example shape:
  `https://paymentWebhook-<hash>-rsms-a84ff-<numeric-id>.us-central1.cloudfunctions.net`
- `storeGatewaySecret` (callable) — same shape with `storeGatewaySecret`

…and the three offline-sync callables (used by offline school servers;
see Stage 7b):

- `registerOfflineServer` (callable, superadmin-only)
- `offlineVerifyServer` (callable, server-token)
- `offlineSyncPush` / `offlineSyncPull` (callables, server-token)

Copy the exact URLs from the CLI output (or `firebase functions:list`).
They can also be found in the console under Build → Functions. The
**offline server's cloud base URL is the shared host part** of any of
these — e.g.
`https://<hash>-rsms-a84ff-<numeric-id>.us-central1.cloudfunctions.net`
(no function name).

Smoke-test (before configuring anything else):

```bash
# must NOT return a verified result; the school does not exist
curl -s -X POST "<verifyPayment URL>" -H 'Content-Type: application/json' \
  -d '{"data":{"ref":"nonexistent-ref","provider":"flutterwave","schoolId":"no-such-school"}}'
```

Expected: an HTTP error envelope (`not-found`/`invalid-argument`), **not**
`{"result":{"verified":true,…}}`.

## Stage 4 — Compatibility RTDB rules first

Deploy `database.rules.compat.json` now. It keeps legacy school data writable,
blocks client writes to `config`/`users`, and requires auth for `users` reads.

**Option A (recommended, per docs/payment-security.md):** Firebase console →
Realtime Database (`rsms-a84ff-default-rtdb`) → Rules → paste the full
contents of `database.rules.compat.json` → Publish.

**Option B (CLI):** temporarily point `firebase.json` at the compat file,
deploy, restore:

```bash
cp firebase.json /tmp/firebase.json.bak
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('firebase.json','utf8'));j.database.rules='database.rules.compat.json';fs.writeFileSync('firebase.json',JSON.stringify(j,null,2)+'\n')"
firebase deploy --only database
git checkout -- firebase.json        # restores the committed pointer (strict file = Phase-4 target)
```

Then: reload the Rules tab to confirm the live rules match the compat file,
and smoke-test normal portal operation (bursar login, record a cash payment,
view a student).

**Do not deploy `database.rules.json` (strict) yet** — Stage 7 gates it on
verified Auth users, claims, and school membership.

## Stage 5 — Configure the Bursar payment settings (in RSMS)

In the deployed RSMS app, log in as **Bursar** → **Payment Settings** →
**Payment Verification** card (repeat for each school):

| Field | Value |
| --- | --- |
| Provider | `flutterwave` or `paystack` (the school's own gateway account) |
| **Verify Endpoint URL** | the deployed **`verifyPayment`** URL from Stage 3 |
| **Gateway Key Endpoint URL** | the deployed **`storeGatewaySecret`** URL from Stage 3 |
| **Your School's Secret Key** | the school's **own** gateway secret key (`FLWSEC-…` or `sk_…` from the school's gateway dashboard). Saved server-side only; if you're not signed in with email, the page asks for the bursar PIN once |
| Webhook Base URL | the deployed **`paymentWebhook`** URL from Stage 3 |
| Your School's Webhook URL | auto-composed (`…?school=<this school>`) — **Copy** it |

Then **Save Payment Settings**. The status line must read
"Gateway key: configured" — until it does, card payments stay disabled for
that school (cash and bank transfer are unaffected).

How it works: the Bursar/Parent browser POSTs the Firebase callable envelope
`{"data":{"ref":…,"provider":…,"schoolId":…}}` directly to the Verify
Endpoint URL and reads the `result` (or `data`) envelope — that is why the
raw callable URL (not a shortened link) goes in this field. The school's
public key stays in its Provider field; the school's secret key goes to
Google Secret Manager via `storeGatewaySecret` and is never shown again or
stored anywhere else.

## Stage 6 — Gateway dashboard webhook configuration (per school)

Each school does this in **its own** gateway dashboard (test/sandbox mode
first):

- **Flutterwave:** Settings → Webhooks → create/enable a webhook for
  transaction/charge-success notifications → URL = **that school's** webhook
  URL from Stage 5 (base + `?school=<schoolId>`, copied from the Bursar
  page). Flutterwave signs each delivery with the `x-flw-signature` header
  (SHA-512 of the raw body); the function verifies it in constant time.
- **Paystack:** Settings → API Keys → Webhooks → Add webhook → URL =
  **that school's** webhook URL, event `charge.success` (optional:
  `charge.pending`, `charge.failed`). Paystack signs deliveries with the
  `x-paystack-signature` header (HMAC-SHA512 keyed with **that school's**
  secret key); the function verifies it the same way.

The `?school=` suffix is what tells the shared function which school's key
and ledger to use — every school must use the URL the Bursar page composes
for it. The function answers `200 {"status":"ok",…}` when verification
succeeds; transient failures answer `500` so the provider retries
idempotently (a second delivery finds no pending row and creates no second
audit record).

## Stage 7 — Sandbox end-to-end verification (per school)

1. In RSMS, make a **card** payment (or wallet top-up) with the test gateway
   keys. The ledger row is created `Pending`.
2. Complete the charge in the gateway sandbox.
3. The browser calls `verifyPayment` (best-effort) and the provider POSTs to
   `paymentWebhook` (the authoritative path).
4. Confirm in RSMS: the row moves `Pending` → `Confirmed` with a
   "Gateway verified (…)" status note, and a new `audit_log` entry appears
   (action "Gateway verification confirmed", user
   "System (gateway webhook/verify)", verified amount + provider transaction
   id recorded).
5. Negative check: a gateway-failed charge stays `Pending` (provider timeout)
   or moves to `Rejected` (verified not-successful / wrong amount — wallet
   credits must match exactly; fee/payment rows accept verified amount ≥
   recorded).
6. Cash/manual: record a cash payment as usual — it is unaffected.
7. Check function logs while testing: `firebase functions:logs:read`.

Only after steps 1–6 pass, switch the gateway dashboards to **live** mode,
run `firebase functions:secrets:set` again with the live keys, redeploy
(`firebase deploy --only functions`), and re-run one live sandbox-adjacent
check with the smallest possible amount.

## Stage 7b — Register an offline school server (per offline school)

For each school that runs the offline LAN server (`offline/`), the
platform superadmin registers the school's appliance once. This produces
a **one-time server token** — hand it to the school out-of-band (it is
shown exactly once and only its SHA-256 hash is stored in
`offline_servers/<schoolId>`).

1. Console → Build → Functions → `registerOfflineServer` → **Test** →
   Request (JSON):

   ```json
   {
     "password": "<superadmin password>",
     "schoolId": "green-valley-sec",
     "schoolCode": "GREENVAL",
     "schoolName": "Green Valley Secondary",
     "action": "register"
   }
   ```

   `schoolId` is the school's existing RTDB school key (same value the
   cloud RSMS app uses). Responses: `{ok: true, serverToken:
   "rsms-offline-…", installationId: "…"}`.

   - `register` on an already-active school → error; use
     `"action": "replace"` to swap the appliance (new token, old token
     stops working).
   - `"action": "revoke"` (schoolId only) deactivates the installation
     immediately — the local server's sync then fails its token check and
     everything keeps working locally (outbox keeps accumulating).

2. On the school PC, start the offline server (Phase C will make this an
   installer step): from the `offline/` directory,
   `node --experimental-sqlite server/index.js` (Node 22.5+).

3. Browser on the LAN: `http://<LAN-IP>:8300/` → staff login → first run
   → bootstrap the staff account → bind the school with:

   - **School code** + the cloud base URL (the shared functions host from
     Stage 3, e.g. `https://<hash>-rsms-a84ff-<id>.us-central1.cloudfunctions.net`)
   - **Server token** from step 1

   The server calls `offlineVerifyServer`; only a valid token marks the
   binding *cloud validated* and enables the 60-second sync loop. A
   wrong/revoked token leaves the binding local-only (no data loss, no
   sync).

4. Verify on `http://<LAN-IP>:8300/health`: "Bound school … (cloud
   validated)", outbox counts draining, "Last cloud sync" updating.
   Money-row disagreements appear under **Bursar Conflict Review**
   (`/conflicts.html`, staff session) — never auto-merged.

## Stage 8 — Auth provisioning, then (and only then) strict rules

Prerequisite: real Firebase Auth (email) users exist for the people who must
operate under strict rules — superadmin(s), and the school's admins/bursars
(and, later, linked parents).

For each user, call `provisionUser` (it is auth-free callable guarded by the
`config/superadmin_hash` check — it stores the `roles` array **and** the
`roleMap`, sets `users/{uid}`, and sets the matching Auth custom claims):

```js
{ uid: "<firebase uid>", name: "Full Name",
  roles: ["bursar"],            // for superadmin: ["superadmin"]
  schoolIds: ["<schoolId>"] }   // parent: plus child links handled by the portal
```

Verification checklist — **every line must pass** before strict rules go
live:

- [ ] `firebase auth:list` shows the users.
- [ ] `firebase auth:get-account <uid>` shows `customClaims.roleMap` and
      `customClaims.schoolIds` for each user.
- [ ] RTDB `users/<uid>` contains the matching `roleMap`/`schoolIds`
      (cross-check is required by the strict rules: claim **and** registry).
- [ ] A test portal login produces a token whose `roleMap`/`schoolIds`
      claims are present.
- [ ] Rules Simulator: bursar write to `schools/<id>/payments` allowed;
      unrelated user's write denied; `config` write allowed for superadmin
      only.

Only then deploy the strict policy:

```bash
firebase deploy --only database
```

(`firebase.json` already points at `database.rules.json`.)

**If any checklist item fails: do not deploy strict rules.** Keep the compat
rules, fix provisioning, and re-run the checklist.

## Rollback

- **Functions:** `firebase functions:delete verifyPayment paymentWebhook provisionUser storeGatewaySecret --force`
  returns the platform to "verification endpoint not deployed": card rows
  remain `Pending`, the browser shows "verification has not been deployed",
  cash flows are unaffected. Or redeploy the previous code version.
- **Rules:** re-paste `database.rules.compat.json` in the Rules console (or
  re-run Stage 4 Option B). Strict rules have no finer rollback than compat.
- **School keys:** rotate by pasting the new key in the Bursar page (the new
  Secret Manager version replaces the old one). Server-side revocation is
  supported (`storeGatewaySecret` with `action:'revoke'`). There are no
  platform-level gateway secrets to rotate.
- **Money data:** verification only transitions `Pending` rows and appends
  audit rows; it never deletes or rewrites amounts. Rollback never touches
  confirmed/rejected rows or their audit trail.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `verifyPayment` → 503 "The payment gateway key for this school is not configured" | The school's bursar hasn't saved the school's own key yet — check the status line in Payment Settings (Stage 5) |
| Webhook `400 missing-school` | The dashboard webhook URL is missing the `?school=<schoolId>` suffix — use the URL the Bursar page composes |
| Webhook `400 school-key-not-configured` | The school's key isn't in Secret Manager yet (Stage 5 not completed for that school) |
| Webhook `401 invalid-gateway-signature` | Provider not sending the header, wrong school key (Paystack HMAC is keyed with that school's secret key), or payload mutated in transit |
| `502 provider declined verification` | Sandbox key used against live reference (or vice versa), or bad reference |
| Row stays `Pending` after a successful sandbox charge | Check the provider dashboard's webhook delivery log (right school URL?), then `firebase functions:logs:read` |
| `permission-denied` from `storeGatewaySecret` | Not signed in as the school's bursar/admin by email, and the bursar PIN prompt was declined or wrong; or the account's claims/registry aren't provisioned yet |
| `permission-denied` from `provisionUser` | `config/superadmin_hash` missing or password mismatch |

## Notes

- Function region defaults to `us-central1`; the RTDB is in `europe-west1`.
  This works as-is; pinning the functions to `europe-west1` is an optional
  latency tweak, not part of this rollout.
- `docs/offline-design.md` is design-only and not part of this deployment.
- `rsms-config.js` is committed and contains only public Firebase web-client
  identifiers (API key, project id, database URL) — no secrets.
