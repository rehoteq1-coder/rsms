# RSMS payment verification security

## What is trusted

A browser may **create an append-only `Pending` intent** for a card payment or
wallet top-up. It must not decide that money was received. The only component
that can transition one of those records to `Confirmed` is the deployed Cloud
Function after it asks Flutterwave or Paystack from the server.

```text
Parent/Bursar browser
  └─ creates Pending payment or wallet-credit record with a unique ref
      └─ Flutterwave / Paystack checkout
          ├─ browser calls verifyPayment (best-effort)
          └─ provider POSTs paymentWebhook (authoritative retry path)
              └─ Cloud Function verifies with provider API using a secret
                  └─ atomically transitions matching Pending rows + audits it
```

`verifyPayment` is deliberately callable without a Firebase-auth requirement.
That does **not** let an unauthenticated caller create money: it accepts only a
reference for an already-existing `Pending` record, verifies it with the
provider API, and only then changes that record's status. It does not contain a
payment-creation path.

## Verification guarantees

- Gateway secret keys are Firebase Function secrets only. They are never sent
to a page, written to `flw_config`, committed, or logged.
- Flutterwave API results must be `success` with `successful` or `completed`;
  Paystack API results must be `status: true`, `data.status: success`. Paystack
  kobo values are converted to naira on the server.
- Wallet **credits** require an exact verified amount. Fee/payment rows accept
  a verified amount equal to or greater than the recorded amount.
- Gateway webhook signatures are checked against the unparsed request body in
  constant time: SHA-512 for the Flutterwave header and HMAC-SHA512 for the
  Paystack header.
- A Realtime Database transaction finds matching `Pending` rows in `wallet`,
  `fees`, and `payments`, updates only their status metadata, and appends a
  server audit row in the same atomic write. A second delivery finds no pending
  row and makes no second money or audit record.
- Rejections are status transitions (`Pending` → `Rejected`), never deletes.
  Pending and rejected wallet records do not contribute to the derived wallet
  balance.
- The browser's `FIND.sweepPending()` is a convenience retry only. The signed
  webhook remains the reliable confirmation route if a browser closes or is
offline.

## Deploy in order

1. Install and authenticate the Firebase CLI, then select the production
   project:

   ```bash
   firebase login
   firebase use rsms-a84ff
   ```

2. Set each secret interactively. Do not pass a real key on a command line,
   place it in an `.env` file, or add it to the Bursar settings page.

   ```bash
   firebase functions:secrets:set FLUTTERWAVE_SECRET_KEY
   firebase functions:secrets:set PAYSTACK_SECRET_KEY
   ```

3. Review the dependencies and deploy the functions:

   ```bash
   cd functions && npm install && npm test && cd ..
   firebase deploy --only functions
   ```

4. Copy the deployed `verifyPayment` callable URL into **Bursar → Payment
   Settings → Payment Verification → Verify Endpoint URL**. It is a Firebase
   callable endpoint, so RSMS posts the callable envelope and reads either the
   `result` or `data` response envelope.

5. Copy the deployed `paymentWebhook` HTTPS URL into the provider dashboard
   and also save it in **Webhook URL** for the school's operational record.
   Configure Flutterwave to send `x-flw-signature` and Paystack to send
   `x-paystack-signature`. Send a sandbox transaction and confirm that the
   matching payment/wallet entry changes from `Pending` to `Confirmed` and an
   audit entry appears.

6. Keep card payments pending until steps 1–5 are complete. Cash flows are
   unaffected. A failed verification remains pending for retry or moves to
   `Rejected` only when the verified gateway result is not successful.

## Database rules rollout (Phase 4)

`database.rules.compat.json` is the safe interim policy. It keeps the current
legacy data paths writable while preventing client writes to `config` and
`users`; `users` reads require Firebase authentication. It intentionally does
not grant a root `.write`, because Realtime Database rules are cascading: a
root `true` grant cannot be revoked by a nested `false` rule. Instead it grants
writes only to the currently used school/public-school branches.

Deploy the compatibility policy first (for example, paste its contents in the
Realtime Database Rules console), test normal portal operation, and only then
deploy the function-backed authentication/provisioning flow. Do **not** deploy
`database.rules.json` until real Firebase Auth claims and the `users/{uid}`
registry are present for active users.

The enforced policy in `database.rules.json` is the Phase-4 target. It
implements these named policy predicates inline because Realtime Database Rules
has no reusable function declaration syntax:

| Policy name | Enforced meaning |
| --- | --- |
| `isSuperadmin` | A `roleMap.superadmin` custom claim **and** the same role in `users/{uid}`. |
| `isSchoolMember` | The requested school occurs in both `auth.token.schoolIds` and `users/{uid}/schoolIds`, or the user is a cross-checked superadmin. |
| `hasRole` | A requested role is present in both the custom-claim `roleMap` and registry `roleMap`. |
| `canWriteSchoolData` | A cross-checked, school-scoped staff role may write the relevant non-money branch. |
| `canManageSettings` | Cross-checked admin, bursar, or superadmin may update `flw_config`. |
| `isFinanceRole` | Cross-checked admin, bursar, or superadmin may write `payments`. |
| `isParentOfAnyChild` | A cross-checked parent has a `childIds` claim or registry link; it is limited to the parent-enabled wallet/fee branches. |

Under the enforced rules, school reads require membership; `payments` are
finance-role only; `wallet` and `fees` are finance-or-linked-parent; audit logs
are member-writable; and `config` plus `users` writes are superadmin-only. The
`provisionUser` callable stores both the requested `roles` array (for portal
UX) and a `roleMap` (for direct Realtime Database Rules membership checks), and
sets both in the Auth custom claims.

> **Important:** the existing portals write whole arrays to some collections.
> Before enabling the stricter policy for parents in production, test the exact
> parent write paths with the Rules simulator and migrate to child-scoped writes
> if needed. The compatibility rules are the required first deployment policy.

## Operational response

- A provider timeout or temporary 5xx leaves a record `Pending`; do not confirm
  it manually solely from a browser callback.
- Review `audit_log` using the wallet/transaction ID, student, provider
  transaction ID, and verified amount recorded by the function.
- If a card result has a wrong amount, leave the audit trail intact and use the
  provider dashboard/refund process. Do not alter the original amount or delete
  its ledger row.
- Rotate a provider key with `firebase functions:secrets:set …`, then redeploy
  the affected functions. Never rotate it by changing a portal file.
