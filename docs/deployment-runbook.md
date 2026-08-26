# RSMS production deployment runbook — Finance/Gateway Phases 1–4

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
| Repo state | Clean working tree, `5ec1fd0` ("School Finance Platform — Phases 1-4") in HEAD history |
| `functions/` dependencies | `npm install` OK (239 packages, firebase-functions v5, node 20) |
| Syntax check | `node --check` passes for `src/index.js` and `src/gateway.js` |
| Unit tests | `npm test` — **7/7 pass** (provider mapping, signature checks, pending→confirmed transitions, idempotency) |
| JSON validity | `firebase.json`, both rules files, `functions/package.json` all parse |
| Secret leak scan | Working tree **and** full git history contain no `FLWSEC_` / `PSKS_…` / `flwsk_` secret values. Only Flutterwave **public** keys (`FLWPUBK-…`) appear, which are client-side checkout keys and public by design. |
| Project identity | Web config targets `rsms-a84ff`, RTDB `rsms-a84ff-default-rtdb` (europe-west1) |
| Functions to deploy | `verifyPayment` (callable), `paymentWebhook` (HTTP), `provisionUser` (callable), codebase `rsms`, region default `us-central1` |

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

## Stage 2 — Set Functions secrets (interactive, secure prompt only)

Exactly two secrets, with **exactly these names** (the functions bind
`params.defineSecret` to these names and both `verifyPayment` and
`paymentWebhook` declare both):

```bash
firebase functions:secrets:set FLUTTERWAVE_SECRET_KEY
firebase functions:secrets:set PAYSTACK_SECRET_KEY
```

Type the value only at the CLI prompt. Never use `--value`, never put it in
`.env`, never paste it in chat, never put it in the Bursar settings page.
Use the **test/sandbox** secret keys for the first end-to-end pass; switch to
live keys only in Stage 8.

Verify existence (names/metadata only — the value is never shown):

```bash
firebase functions:secrets:describe FLUTTERWAVE_SECRET_KEY
firebase functions:secrets:describe PAYSTACK_SECRET_KEY
```

## Stage 3 — Deploy Cloud Functions (only after Stage 2)

```bash
# from the repository root
firebase deploy --only functions
```

Do **not** run a bare `firebase deploy` — `firebase.json` currently points
`database.rules` at the strict `database.rules.json`, which must NOT go live
yet (Stage 4 explains the compat-first order).

The deploy output lists the deployed HTTPS URLs. Capture all three; the two
you need are:

- `verifyPayment` (callable) — example shape:
  `https://verifyPayment-<hash>-rsms-a84ff-<numeric-id>.us-central1.cloudfunctions.net`
- `paymentWebhook` (HTTP) — example shape:
  `https://paymentWebhook-<hash>-rsms-a84ff-<numeric-id>.us-central1.cloudfunctions.net`

Copy the exact URLs from the CLI output (or `firebase functions:list`).
They can also be found in the console under Build → Functions.

Smoke-test (before configuring anything else):

```bash
# must NOT return a verified result; it should error with a missing/invalid reference
curl -s -X POST "<verifyPayment URL>" -H 'Content-Type: application/json' \
  -d '{"data":{"ref":"nonexistent-ref","provider":"flutterwave"}}'
```

Expected: an HTTP error envelope (`invalid-argument`/`internal`), **not**
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
**Payment Verification** card:

| Field | Value |
| --- | --- |
| Provider | `flutterwave` or `paystack` (default provider used by the browser's verify call) |
| **Verify Endpoint URL** | the deployed **`verifyPayment`** URL from Stage 3 (full URL, `https://…`) |
| **Webhook URL** | the deployed **`paymentWebhook`** URL from Stage 3 (saved as the school's operational record) |

Then **Save Payment Settings**.

How it works: the Bursar/Parent browser POSTs the Firebase callable envelope
`{"data":{"ref":…,"provider":…,"schoolId":…}}` directly to the Verify
Endpoint URL and reads the `result` (or `data`) envelope — that is why the
raw callable URL (not a shortened link) goes in this field. The public
gateway keys stay in their existing Provider fields; **secret keys never
belong in this page** (the card itself says so).

## Stage 6 — Gateway dashboard webhook configuration

Use **test/sandbox mode** first.

**Flutterwave** (dashboard, sandbox environment first): Settings →
Webhooks → create/enable a webhook for transaction/charge-success
notifications → URL = the **`paymentWebhook`** URL. Flutterwave signs each
delivery with the `x-flw-signature` header (SHA-512 of the raw body); the
function verifies it in constant time.

**Paystack** (dashboard, Test Mode first): Settings → API Keys → Webhooks →
Add webhook → URL = the **`paymentWebhook`** URL, event `charge.success`
(optional: `charge.pending`, `charge.failed`). Paystack signs deliveries with
the `x-paystack-signature` header (HMAC-SHA512 keyed with the **secret** key);
the function verifies it the same way.

Both dashboards must point at the *same* `paymentWebhook` URL stored in
Stage 5. The function answers `200 {"status":"ok",…}` when verification
succeeds; transient failures answer `500` so the provider retries
idempotently (a second delivery finds no pending row and creates no second
audit record).

## Stage 7 — Sandbox end-to-end verification

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

- **Functions:** `firebase functions:delete verifyPayment paymentWebhook provisionUser --force`
  returns the platform to "verification endpoint not deployed": card rows
  remain `Pending`, the browser shows "verification has not been deployed",
  cash flows are unaffected. Or redeploy the previous code version.
- **Rules:** re-paste `database.rules.compat.json` in the Rules console (or
  re-run Stage 4 Option B). Strict rules have no finer rollback than compat.
- **Secrets:** rotate with `firebase functions:secrets:set <NAME>` then
  `firebase deploy --only functions` — never by editing a portal file.
- **Money data:** verification only transitions `Pending` rows and appends
  audit rows; it never deletes or rewrites amounts. Rollback never touches
  confirmed/rejected rows or their audit trail.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `verifyPayment` → 503 "Flutterwave verification is not configured" | Secret not set, or functions deployed before the secret existed — re-run Stage 2 then Stage 3 |
| Webhook `401 invalid-gateway-signature` | Provider not sending the header, wrong secret (Paystack HMAC uses the **secret** key), or payload mutated in transit |
| `502 provider declined verification` | Sandbox key used against live reference (or vice versa), or bad reference |
| Row stays `Pending` after a successful sandbox charge | Check the provider dashboard's webhook delivery log, then `firebase functions:logs:read` |
| `permission-denied` from `provisionUser` | `config/superadmin_hash` missing or password mismatch |

## Notes

- Function region defaults to `us-central1`; the RTDB is in `europe-west1`.
  This works as-is; pinning the functions to `europe-west1` is an optional
  latency tweak, not part of this rollout.
- `docs/offline-design.md` is design-only and not part of this deployment.
- `rsms-config.js` is committed and contains only public Firebase web-client
  identifiers (API key, project id, database URL) — no secrets.
