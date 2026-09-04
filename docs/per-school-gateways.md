# RSMS per-school gateway design (Phase 5)

Status: **approved (2026-08-26) and implemented** on branch
`arena/01a03e39-rsms`. Owner decisions: bursar enters the school's own key in
the portal (stored in Secret Manager); dual-mode gate (Auth claims or legacy
bursar PIN); **shared platform-account mode removed entirely** — per-school
is the only card path.
Supersedes the single-account assumption in `docs/deployment-runbook.md`
(kept in sync).

## 1. Principle

**Each school is the direct merchant of record for its own payments.**

- A school uses its own Flutterwave/Paystack merchant account. Parents' money
  settles **directly into the school's own bank account** via the gateway —
  the platform never receives, holds, or remits customer funds.
- The platform (RSMS) only does three things server-side: **verify** the
  transaction against the provider's API using the school's own secret key,
  **transition** the matching `Pending` ledger rows, and **append** the audit
  row. All of that is already implemented in Phases 1–4; what changes is
  *which secret key is used and how the school is identified*.
- Cash and bank-transfer flows are untouched (bank transfer already settles to
  the school's own account configured per school today).

## 2. Gap in the current (merged) implementation

| Aspect | Today | Problem |
|---|---|---|
| Public key | Per-school (`flw_config.publicKey`) | OK — checkout already runs in the school's own account |
| Secret key | One platform pair (function secrets `FLUTTERWAVE_SECRET_KEY` / `PAYSTACK_SECRET_KEY`) | Verification of a transaction that lives in *the school's* account fails with the *platform's* key → payment stuck `Pending` |
| Webhook signature | HMAC checked against the platform's Paystack secret | A school's own account signs with *its* secret → `401 invalid-gateway-signature` |
| School resolution (webhook) | No school identifier in the request; function scans up to 200 schools for a matching Pending ref | Refs like `TX/2026/1/0001` are unique per school, not globally — cross-school match risk; hard cap at ~200 schools |
| School resolution (verify) | Browser sends `schoolId` and the function already filters to it | OK |

Conclusion: the merged system only works end-to-end when every school shares
one gateway account. Per-school accounts are a first-class requirement, so
they must land **before** launch (owner decision, 2026-08-26).

## 3. Target design

### 3.1 Per-school gateway profile

Stored per school (existing `schools/<schoolId>/flw_config`, same rules scope
— no rule changes):

```js
{
  provider: "flutterwave" | "paystack",
  publicKey: "FLWPUBK-… / pk_…",        // existing field
  currency, businessName,
  verifyUrl,                              // existing (platform callable URL)
  keyEndpointUrl,                         // NEW: storeGatewaySecret callable URL
  webhookUrl,                             // existing; now per-school value (see 3.3)
  bankName, accountNo, accountName,       // existing (bank transfer)
  hasSecret: true,                        // NEW metadata (no key material in RTDB)
  secretUpdatedAt: "2026-08-26T10:00:00Z" // NEW metadata
}
```

**Card payments are enabled for a school only when `hasSecret` is true.**
Until the school's bursar configures the school's own keys, card checkout is
disabled for that school with a clear notice; cash and bank transfer keep
working. (Shared platform-account mode was **removed** per owner decision —
a school without its own gateway account simply has no card payments until it
gets one.)

### 3.2 Where the school's secret key lives

**Google Cloud Secret Manager**, one secret per school per provider:

- `rsms-flw-<schoolId>` (Flutterwave `FLWSEC-…`)
- `rsms-ps-<schoolId>`  (Paystack `sk_test_…` / `sk_live_…`)

Written by a new callable (3.4) using the Cloud Function's own ADC; the key
never sits in RTDB, the repository, a `.env` file, or any client storage.
RTDB holds only the `hasSecret`/`secretUpdatedAt` metadata above.

One-time IAM setup: the Cloud Functions service account
(`<numeric-id>-compute@developer.gserviceaccount.com`) is granted
`roles/secretmanager.secretManager` on `rsms-a84ff` (can create secrets and
add versions; needed for self-service onboarding). All writes are auditable in
Cloud Audit Logs.

Key rotation = bursar pastes the new key (replaces the version). Revocation =
bursar revokes in the portal; card mode disables until reconfigured.

> **Trust-model change (needs owner sign-off):** the school's bursar enters
> *their own school's* secret key through the Bursar settings page over
> HTTPS. It is the school's key, for the school's account, stored where the
> school's own gateway already stores it. The platform operator cannot read
> or decrypt it (Secret Manager + function ADC only). This is the only way a
> school can be the direct account holder while the platform does the
> server-side verification.

### 3.3 One deployment, per-school webhook URLs

The single deployed `paymentWebhook` endpoint carries the school in a query
param. The Bursar page displays a **pre-composed** per-school URL:

```
https://<paymentWebhook-base>/ ?school=<schoolId>
```

Each school pastes *its own* URL into *its own* gateway dashboard
(Flutterwave: Webhooks → charge-success notifications; Paystack: Settings →
API Keys → Webhooks → `charge.success`).

Security: the school id is not secret — the delivery is still bound to the
school because (a) the Paystack HMAC must verify with *that school's* secret,
and (b) the ref must match a `Pending` row in *that school's* ledger whose
amount matches the **secret-keyed** provider verify result. (Flutterwave's
`x-flw-signature` is an unkeyed SHA-512 of the body — anti-tamper only; the
money decision always comes from the secret-keyed verify API call, which is
account-scoped.)

Resolution in `paymentWebhook`: the `?school=` query param is **required** —
a delivery without it is rejected (`400 missing-school`). There is no
cross-school scanning: payment refs are unique per school, not globally, so a
delivery must be addressed to its school.

`verifyPayment` keeps its current contract (browser already sends
`{ref, provider, schoolId}`) and resolves secrets per school the same way.
The cross-school scan is never used when a school is identified.

### 3.4 New callable: `storeGatewaySecret`

```js
POST {data:{
  schoolId,            // the calling school
  provider,            // "flutterwave" | "paystack"
  action,              // "set" | "revoke"
  secretKey,           // only for "set"; validated: FLWSEC-… / sk_test_… / sk_live_…
  pin?                 // legacy path, see gate below
}}
```

**Server-side gate (dual mode, mirrors the platform's current auth):**
1. If the request carries a Firebase ID token: require claims
   `roleMap.bursar|admin|superadmin === true` **and** `schoolIds[schoolId] ===
   true`, cross-checked against `users/<uid>` (same predicate style as the
   strict rules).
2. Otherwise (legacy PIN session): compare the submitted `pin` against
   `schools/<schoolId>/portal_pins.bursar` (or the staff record's PIN) with
   `crypto.timingSafeEqual`. Same data the client already sees today — no
   trust regression; this path is retired when auth enforcement is enabled.

Behaviour: validates key format → writes/updates the Secret Manager version →
sets `flw_config.hasSecret`/`secretUpdatedAt` (metadata only) → appends an
`audit_log` row ("Gateway secret configured/revoked", user, timestamp) →
returns `{ok:true}`. **Never** echoes or stores the key anywhere else, and
the response never contains it.

### 3.5 Verification path (what changes in the functions)

`runVerification(schoolId, reference, provider)`:

1. Resolve the school's secret from Secret Manager. If the school has no key
   configured, verification reports "not configured" (503 for the callable,
   400 `school-key-not-configured` for the webhook — no retry) and the row
   stays `Pending`.
2. Provider verify API call with **that** key (unchanged otherwise:
   success rules, kobo→naira, amount rules all stay as implemented).
3. Ledger transaction scoped **only** to the resolved school (no cross-school
   writes; the existing atomic transition + audit append is reused unchanged).

Existing money logic — `mapFlutterwaveResponse`, `mapPaystackResponse`,
amount matching, `Pending`→`Confirmed`/`Rejected` transitions, idempotency,
audit rows — is **not** modified.

### 3.6 Bursar UI (Payment Settings → Payment Verification card)

- **Secret Key** field (masked, password input): "Your school's gateway secret
  key. Saved server-side, never shown again." Empty field = no change.
- **Status row:** "Gateway key: configured · updated <date>" or
  "not configured — card payments disabled until set".
- **Webhook URL (per school):** read-only display box auto-composed as
  `<paymentWebhook base>?school=<this school>` with a Copy button (the base
  URL is the value saved in the existing Webhook URL field).
- Card payment toggle reflects `hasSecret` automatically.

### 3.7 No ledger-row account marker needed

Per-school is the only mode, so each row's school (its `schools/<id>` node)
already determines the verifying account. No extra marker field is added.

## 4. Explicitly unchanged

- Ledger model, audit-log format, amount rules, rejection semantics
- Cash and bank-transfer flows (fully unaffected)
- Auth model (email sign-in + legacy PIN dual mode), role guard
- Bursar Report Center (7 reports, CSV/print)
- Realtime Database rules (compat → strict rollout plan unchanged; the new
  `flw_config` metadata fields inherit the existing scope)
- Ref formats (parent card refs are already globally unique; the school is
  now identified via webhook param / payload instead of scanning)

## 5. Work items (implementation plan)

1. `functions/src/secretstore.js` (new) — Secret Manager wrapper
   (create/update/get latest version) via the function ADC.
   Dependency: `@google-cloud/secret-manager`.
2. `functions/src/index.js` — add `storeGatewaySecret` callable; per-school
   secret resolution in `runVerification`; `?school=` resolution in
   `paymentWebhook`; audit rows; shared-marker fallback.
3. `functions/src/gateway.js` — key-format validators, secret-name mapping,
   webhook query-param parsing helpers (pure, unit-tested).
4. `rsms-bursar.html` — Secret Key field, status row, per-school webhook URL
   display + copy; card toggle bound to `hasSecret`; `storeGatewaySecret`
   callable client (same fetch-envelope pattern as `gatewayVerify`).
5. `rsms-finance.js` — `gatewayAccount` marker on gateway row creation;
   card-mode availability from `hasSecret`.
6. Tests — new unit tests: key-format validation, secret-name mapping,
   `?school=` parsing, secret-store set/get/rotate/revoke (in-memory fake),
   idempotency preserved.

**Implementation status (2026-08-27):** items 1–6 implemented on branch
`arena/01a03e39-rsms`; `npm test` → **15/15 pass**; syntax checks pass;
inline portal scripts compile-check clean. The platform's two function
secrets (`FLUTTERWAVE_SECRET_KEY` / `PAYSTACK_SECRET_KEY`) are no longer
declared by the functions.

## 6. Rollout (after implementation)

1. **Blaze plan upgrade** on `rsms-a84ff` (prerequisite for Secret Manager
   and the functions; already required).
2. Grant the Functions service account `roles/secretmanager.secretManager`.
3. `firebase deploy --only functions` — deploys `verifyPayment`,
   `paymentWebhook`, `provisionUser`, `storeGatewaySecret`. **No platform
   gateway secrets are needed** (per-school keys arrive through the Bursar
   page into Secret Manager).
4. Compat RTDB rules live (per the runbook, Stage 4).
5. **Per school** (self-service, ~10 min each): bursar enters the school's
   public + secret key → status shows configured → copy the per-school
   webhook URL into the school's own gateway dashboard → one sandbox test
   payment → live.
6. Strict-rules gate unchanged: only after real Auth users/claims/registry
   are verified.

## 7. Rollback

- Functions: redeploy previous version (legacy code path remains for legacy
  rows); new callables simply stop being called.
- Per school: revoke the key in the portal → card mode disables for that
  school; its ledger rows keep their verified state and audit trail.
- No money data is ever rewritten by a rollback; transitions remain
  append-only and audited.

## 8. Owner decisions (resolved 2026-08-26)

1. Trust model: **approved** — the bursar enters the school's own key in the
   portal; the platform stores it in Secret Manager and cannot read it.
2. Dual-mode gate: **approved** — Auth claims when available, legacy bursar
   PIN otherwise; the PIN path is retired when auth enforcement is enabled.
3. Shared fallback: **removed** — per-school is the only card path.
