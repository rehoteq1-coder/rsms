TASK: Build the "School Finance Platform" for this repo (RSMS — deployed at
rsms.rehoteq.com, Firebase project rsms-a84ff). This is a full rebuild from
spec: implement Phases 1-4 + landing polish + an offline design doc, then
open a PR. Work in the repo you have; explore it FIRST.

STEP 0 — EXPLORE (do not skip):
- rsms-firebase.js  → the data-layer pattern you MUST follow (scoped
  localStorage keys rsms_{schoolId}_{key} with rsms_{key} fallback +
  Firebase sync via _write to schools/{schoolId}/{key}, listener keys array,
  _lsSet helper, isReady()).
- rsms-bursar.html  → portal structure (sidebar pages, showPage +
  window.onPage_{page} hooks, getFlwConfig/saveFlwConfig, logAudit,
  naira/getVal/setVal/gEl helpers, existing pages: record, selfpay,
  receipts, accounts, cashbook, reports, settings, payroll, audit).
- rsms-parent.html  → child data pattern (_get, CHILD_ID/CHILD_NAME,
  payFeeOnline, rsms_tokens, fee_schedule usage).
- rsms-login.html   → multi-step login flow (school → role → identity → PIN).
- rsms-config.js    → READ ONLY, never modify (contains Firebase config).

HARD RULES:
- NEVER modify: rsms-config.js, root package.json, package-lock.json, CNAME,
  or any file not listed below. Only overwrite the 5 portal files listed
  below and ADD the new files.
- No secrets in any file. Gateway keys live only in Cloud Function env vars.
- All new JS must be plain ES5-ish (var/function) like the existing code,
  and must pass `node --check`.
- Money records are never auto-merged/deleted: ledger is append-only;
  reversals are status transitions that net to zero in totals.

PHASE 1 — FINANCE CORE
New file rsms-finance.js: a FIND namespace (IIFE, window.FIND), loaded in
rsms-bursar.html AND rsms-parent.html right after rsms-firebase.js.
- Data access mirrors rsms-firebase.js exactly (scoped localStorage +
  fallback + RSMS_FB.saveCollection — you must ADD a generic
  saveCollection(key,data) to rsms-firebase.js plus these listener keys:
  fee_structures, student_fees, payments, recurring, recurring_schedule,
  expenses, wallet).
- Collections: fee_structures (per class+term+session: {class,term,session,
  items:[{id,type,amount}]}), student_fees (per student+term+session:
  {charges:[{id,label,amount}], discounts:[...]}), payments (immutable
  ledger: {id,txId,receiptNo,stuId,student,class,reg,amount,type,method,
  channel,ref,status,term,session,by,date,recordedAt,source,note}),
  recurring, recurring_schedule, expenses, wallet.
- Fee math: classTotal(class)=sum(items). studentPayable=
  max(0, classTotal + charges - discounts). paidFor(student)=sum of payments
  with status Paid or 'Partially Paid' ONLY (Reversed/Pending/Failed count
  zero). outstanding=max(0,payable-paid). termStats(): projected=sum
  payable, collected=sum paid, outstanding, avgFee, collectionRate,
  paidStudents/unpaidStudents, per-class table, top-5 unpaid.
- FIND.pay({stuId,amount,type,method,channel,ref,status,by,source}):
  the ONLY way to record money. txId=TX/{year}/{1|2|3}/{seq:00001},
  receiptNo=RCP/{year}/{term}/{seq:00001}. For Paid/'Partially Paid' ALSO
  mirror a legacy record into the existing fees collection (same shape as
  current fees records: receiptNo,stuId,student,class,reg,type,amount,
  method,date,ref,term,session,recordedAt,channel) so existing
  parent/student portals keep working. logAudit every transition with
  before→after. setPaymentStatus(txId,status,note) audited.
- One-time legacy migration (localStorage flag rsms_finance_migrated):
  import existing fees records into payments as Paid, source='legacy'.
- New bursar pages (sidebar + pg-{id} + window.onPage_{id}):
  1) fees "Classes & Fees": class picker, fee items add/remove, per-student
     charges & discounts (with confirmation), live payable matrix
     (student/class/payable/paid/outstanding/status, searchable).
  2) recurring "Recurring Payments": plan = student, amount, category,
     frequency (Weekly/Bi-weekly/Monthly/Termlly≈4 months), start, optional
     end → auto-generate schedule entries {dueDate,status:'Due'}; per-due
     "Mark Paid" creates a real FIND.pay with ref REC-{recid-short}-{date}
     and marks the entry Paid with paidTxId; Stop plan.
  3) expenses: form (title,description,amount,category
     [Staff Salary/Utilities/Repairs & Maintenance/Supplies/Transport/Food &
     Catering/Security/General],date,person,ref,status Pending|Approved);
     approve/reject/void (voided excluded from totals, record retained);
     stats: Total Income (collected), Total Expenses (approved), Net.
  4) projection "Term Projection": Expected/Collected/Outstanding, students
     paid/not-paid, Average Fee, Collection Rate + per-class table
     (Class/Fee avg/Students/Paid/Unpaid/Expected/Collected/Outstanding)+TOTAL.
  5) wallet (see Phase 2). 6) reportcenter (see Phase 4).
- Dashboard (bursar pg-home): replace the hardcoded ₦35,000-per-student
  outstanding estimate with real termStats: 4 stat tiles (Projected Term
  Revenue, Revenue Collected, Outstanding Revenue, Average Fee/Student),
  collection-rate progress bar, class-by-class projection table, top-5
  unpaid list.
- Report Center (reportcenter): 7 reports (Student Fee / Outstanding Fee /
  Payment / Wallet / Expense / Term Financial / Class Financial), each a
  table built from live data + "Download CSV" (BOM \uFEFF, quote escaping) +
  "Print / Save as PDF" (window.open a styled print page that auto-prints).
- Bursar bug fixes (part of this phase):
  * `window.onPage_audit = renderAuditTrail;` throws ReferenceError
    (function defined in a later script block) — wrap in a function.
  * Dead showPage('ledger') links → change to 'accounts'.
  * Script order in head: rsms-config.js MUST load before
    rsms-firebase.js (and add firebase-auth-compat script) — otherwise the
    data layer silently dies. Apply the same order fix to
    rsms-parent.html and rsms-login.html.

PHASE 2 — WALLETS
- Wallet = append-only ledger per student (wallet collection: {id,walId,
  stuId,student,class,type:'credit'|'debit',amount,reason,method,status,
  ref,by,date,recordedAt,note,feeTxId}). Balance is ALWAYS derived:
  sum of Confirmed credits minus debits. Never stored.
  walId=WAL/{year}/{term}/{seq:00001}.
- FIND.walletCredit / FIND.walletDebit (balance check, insufficient → error;
  debit also creates a real FIND.pay channel:'wallet') /
  FIND.setWalletStatus (Pending→Confirmed|Rejected, audited) /
  walletTotals / printWalletReceipt (window.open receipt with balance-after).
- Bursar "Wallet Actions" page (wallet): 4 stat tiles (Total Wallet
  Balance, Active Wallets, Total Credits, Total Debits); "+ Credit Wallet"
  form (student picker w/ live balances, amount, reason, method
  Cash|Bank Transfer|Card|Wallet Top-up, REQUIRED confirmation checkbox,
  submit); actions table (Receipt ID, Student, Amount ±colored, Reason,
  Date, By, Status badge, Confirm button when Pending, 🧾 receipt button);
  search + type filter.
- Parent portal: new Wallet page (pg-wallet + window.onPage_wallet):
  balance card, Fund Wallet form (Card → Flutterwave checkout, record
  Pending credit with ref RSMS-WAL-{ts}-{rand}, then verify per Phase 3;
  Bank Transfer → Pending; Cash (at school) → Confirmed), transaction list
  (icon, type, reason/date/ref, ±amount, status).
- Parent Fee Status page: add wallet-balance row + "Pay from Wallet" button
  (prompt for amount ≤ balance → Confirmed debit + fee record channel
  'parent_wallet' receiptNo WAL/{year}/{term}/{seq}); PENDING VERIFICATION
  badge on fee records with status Pending; ONLY confirmed payments count
  toward totals/outstanding (paidFees helper); receipt modal shows a
  pending state (⏳ orange) vs confirmed (✅ green).
- Parent payFeeOnline card path: record the fee as PENDING (status field) +
  mirror a Pending record into the payments collection (txId SP-{ts}) so
  the bursar ledger + gateway sweep see it; verify per Phase 3.

PHASE 3 — GATEWAY VERIFICATION (Cloud Functions)
New folder functions/: package.json (firebase-admin ^12, firebase-functions
^5, node 20, main src/index.js), .env.example (FLUTTERWAVE_SECRET_KEY +
PAYSTACK_SECRET_KEY placeholders, comment: set via firebase
functions:secrets:set), src/gateway.js (PURE logic, unit-testable):
- mapFlutterwaveResponse: {status:'success',data:{status:'successful'|
  'completed',amount,tx_id}} → ok + amount + gatewayId;
  data.status 'pending'|'authorized' → {ok:false,pending:true}; else not ok.
- mapPaystackResponse: {status:true,data:{status:'success',amount(in KOBO),
  id}} → ok, amount/100; 'pending'|'default' → pending; else not ok.
- checkFlutterwaveSignature(rawBody,header): SHA-512 hex of raw body,
  constant-time compare, case-insensitive.
- checkPaystackSignature(rawBody,header,secret): HMAC-SHA512 hex.
- findPendingRecords(db,txRef): across wallet/fees/payments, status
  'Pending' and ref exact-or-prefix match.
- applyVerification: wallet credits require EXACT amount match; fee/payment
  records require verified amount >= recorded amount; idempotent; flips to
  Confirmed with statusNote + appends audit entries (type wallet_credit /
  fee_payment, user 'System (gateway webhook/verify)', details with
  wallet/tx id, student, provider tx id, amount). Returns {records,applied,
  audit}.
src/index.js (firebase-functions v2 https):
- verifyPayment = onCall(handler,{maxInstances:10}) — deliberately
  unauthenticated (it only confirms records the gateway already verified;
  it cannot create money): body {ref,provider,schoolId} → verify via
  provider API (fetch; flutterwave GET /v3/transactions/{ref}/verify with
  Authorization header = secret; paystack GET /transaction/verify/{ref}
  Bearer secret) → for each school (listSchoolIds: RTDB schools
  limitToLast(200)) apply verdict, batch-write changed collections +
  audit_log. Returns {verified,pending?,rejected?,reason?,applied}.
- paymentWebhook = onRequest(handler,{cors:[]}) — POST only (405); detect
  provider by header presence (x-paystack-signature vs x-flw-signature);
  verify signature → 401 on mismatch; extract ref (paystack:
  body.data.reference|tx_ref; flutterwave: body.transaction.reference|
  tx_ref) → 400 if missing; runVerification; 200 {status:'ok',...} or 500
  (provider retries).
- provisionUser = onCall(handler) — superadmin gate: SHA-256(password) vs
  RTDB config/superadmin_hash, constant-time compare → 403
  'permission-denied' on mismatch; body {password,uid,name,roles[],
  schoolIds[]} → set users/{uid} {name,roles,schoolIds as {sid:true},
  provisionedAt} + admin.auth().setCustomUserClaims(uid,{roles,schoolIds}).
Client wiring (both portals): gatewayConfig() reads flw_config fields
provider/verifyUrl/webhookUrl (ADD these three fields to the bursar
Settings page: "Payment Verification" card with provider select, Verify
Endpoint URL input, Webhook URL input + explanatory note that card payments
stay Pending until the function is deployed); FIND.gatewayVerify(ref,
provider) POSTs {ref,provider,schoolId} to verifyUrl, returns .data;
FIND.applyVerification(data) flips local records (setPaymentStatus /
setWalletStatus with note 'Gateway verified (server)'); FIND.sweepPending()
(debounced 1200ms, verifies up to 3 pending refs, called from the
onSync live-update hook so pages keep polling while open). Card flows:
bursar self-pay callback → record PENDING with gateway tx_ref →
gatewayVerify → applyVerification (toasts: 'verifying…' / '✓ verified' /
'could not confirm — stays Pending for bursar review' / 'still
processing'); parent card payment + wallet card top-up follow the same
pattern.
Repo root new files: firebase.json ({database:{rules:"database.rules.json"},
functions:[{source:"functions",codebase:"rsms",ignore:["node_modules",
".git","*.log"]}]}), database.rules.json (ENFORCED RBAC — deploy LATER only:
isSuperadmin/isSchoolMember (claims AND users/{uid} registry
cross-check)/hasRole/canWriteSchoolData/canManageSettings/isFinanceRole/
isParentOfAnyChild; payments finance-roles only; wallet+fees finance or
parent; audit_log members; config+users write-locked to superadmin;
schools/{schoolId} read = isSchoolMember), database.rules.compat.json
(SAFE interim — deploy FIRST: .read/.write true at root except config.write
false, users.write false + users.read auth). docs/payment-security.md
(architecture, deploy steps: firebase login → use rsms-a84ff →
functions:secrets:set both keys → deploy --only functions → webhook URL in
gateway dashboard → Settings URL in bursar; verification guarantees;
Phase-4 rules rollout).

PHASE 4 — REAL AUTH + REPORT CENTER
rsms-firebase.js additions: REAL AUTH — _initAuth():
firebase.auth().onAuthStateChanged → getIdTokenResult(true) → claims →
write session to sessionStorage (rsms_user {uid,email,name,roles[],
schoolIds,schoolId,childIds,realAuth:true,role:roles[0]}, rsms_role,
rsms_auth, rsms_real_auth) + fire window.onRSMSAuthChanged(session);
login(email,pw) via signInWithEmailAndPassword (normalize errors: strip
'Firebase: ', pass code through); logout(); currentUser(); claims().
PORTAL ACCESS GUARD: FILE_ROLE map (rsms-admin.html→admin,
rsms-bursar.html→bursar, rsms-teacher.html→teacher,
rsms-classteacher.html→classteacher, rsms-hod.html→hod,
rsms-principal.html→principal, rsms-student.html→student,
rsms-parent.html→parent, rsms-control.html→control); FINANCE_ROLES=
[admin,bursar]; runAuthGuard(): if real-auth session → role must be in
claims.roles or superadmin, else full-screen block (lock icon, 'Access
denied', message, '← Sign in' → rsms-login.html, blur the page behind); if
legacy PIN session AND portal role in FINANCE_ROLES AND
authEnforced(schoolId) → block with 'Email sign-in required' (school requires
verified staff accounts). authEnforced(sid): read RTDB
config/auth_enforced/{sid}, cache localStorage rsms_auth_enforced_{sid}.
Guard runs on DOMContentLoaded + after every session apply/clear. Export
login/logout/currentUser/claims/authEnforced.
rsms-login.html: add "Staff Email Sign-In" card on step 1 (OR divider,
email + password inputs, Sign In button) + emailLogin(): validate →
RSMS_FB.login → poll sessionStorage rsms_user every 250ms (max 25) for
realAuth+roles → redirect to the role's portal (P map like FILE_ROLE);
errors invalid-credential|wrong-password|user-not-found → 'Incorrect email
or password'. PIN flow unchanged (legacy schools keep working).
Report Center page = Phase 1 item 6 (list it here too: 7 reports, CSV +
print/PDF).

LANDING POLISH — index.html (left panel only, keep everything else):
Pure CSS/JS, no dependencies, respect prefers-reduced-motion (static but
fully visible). Add: (1) aurora — 3 blurred drifting radial-gradient orbs
(gold/teal/violet, 14s/17s/11s alternate drifts) behind content; (2) panning
dot-grid texture (26px radial-gradient, 60s loop); (3) cursor-following
gold glow (radial at CSS vars --mx/--my from mousemove, desktop hover only);
(4) staggered entrance for logo/name/badge/tagline/features (0.08s steps);
(5) LOGO BOUNCE on every page load: squash-and-stretch keyframes (up 20px
anticipation, land squash scale 1.07/0.9, smaller bounce, settle), 1.15s,
delayed 0.55s after entrance — this is a headline feature, make it feel
physical; (6) rotating tagline (5 lines: 'Results in minutes, not days',
'Fees without the chase', 'Attendance on autopilot', 'Parents always in
the loop', 'One login for the whole school', 3.4s cycle, fade/slide);
(7) count-up stats (40+ Schools onboarded / 15,000+ Students tracked /
1M+ Records kept, ease-out cubic 1.6s, toLocaleString); (8) live demo card
"LIVE" pulse badge + 3 animated meters (Today's attendance 96% / Fees
collected this term 82% / Report cards automated 100%) + looping
'receipt sent to parent — ₦120,000 · JSS 2' toast + light sweep;
(9) CTA button shimmer sweep; (10) 5th feature item 'Live Finance
Dashboard'; (11) mobile ≤640px: demo card + aurora/grid hidden, smaller
stats; short viewports ≤760px: padding adjustments.

OFFLINE DESIGN DOC — docs/offline-design.md (for the no-internet-schools
project; design only, no code): architecture = ONE always-on school PC runs
a local server (Node.js + Express + better-sqlite3) serving the existing
portal pages over the LAN; staff-only offline (parents stay on the cloud);
SQLite single-file DB with local UUIDs + online_key mapping; data adapter
keeps the existing function names but talks to the local API instead of
Firebase; server-side hashed PIN/email auth (staff roles as today); sync
engine = outbox queue (acknowledged before removal) + pull with
updated_at cursors + school-code binding to online schoolId; merge rules:
non-money last-write-wins field-level, MONEY records (payments, wallet,
fee amounts) NEVER auto-merged → conflict review screen for the bursar;
Flutterwave hidden when offline (cash/bank manual receipts, sync-pending
flag); packaging = NSSM Windows service auto-start, nightly 7-day SQLite
backup + restore page, first-run wizard with LAN IP + QR code, DHCP
reservation instructions, update check from cloud when online; risks table
(shared PC, IP changes, disk failure, conflict pile-up, two installs per
school, schema drift) + build plan (Phase A offline server, Phase B sync
engine, Phase C packaging).

REQUIRED VERIFICATION before the PR (all must pass):
- node --check every new/modified .js (incl. functions/src/*).
- Parse-check every inline <script> in all 5 portal files (no syntax
  errors; note the parent portal historically had an unescaped quote in a
  modal — make sure none exist).
- DOM smoke test (jsdom or equivalent) for bursar + parent: FIND loads;
  fee structure → payable matrix numbers correct (incl. a discount case);
  FIND.pay → ledger entry + legacy fees mirror + audit entry; reversal
  nets to zero; wallet credit/debit/insufficient/reject flow; pay-from-
  wallet in parent; report numbers (projected/collected/outstanding/avg);
  auth guard: real-auth allowed for matching role, blocked for mismatch,
  legacy PIN blocked when authEnforced, allowed when not.
- functions/src/gateway.js unit tests: both provider mappers (success/
  pending/failed, kobo conversion), both signature checks (valid/invalid),
  findPendingRecords matching, applyVerification (wallet exact-match
  rejection, fee >= acceptance, idempotent second run).
- Confirm untouched files are untouched (rsms-config.js, package.json,
  CNAME, all other portals).

DELIVERABLE:
git add -A && git commit -m "School Finance Platform — Phases 1-4
(finance engine, wallets, gateway verification, RBAC, reports, landing
polish, offline design doc)" → push branch school-finance-platform → open
PR to main with a short description: what each phase adds, deploy notes
pointing to docs/payment-security.md, and the note that card payments stay
Pending until the Cloud Functions are deployed (cash flows are unaffected).
