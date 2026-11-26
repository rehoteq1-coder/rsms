// Gateway PIN verification: the login gateway checks PINs behind a cloud
// callable that mints a signed token, instead of comparing them in the
// browser against PINs the database serves unauthenticated.
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fnPath = path.join(__dirname, '..', 'functions', 'src', 'index.js');
const fnSrc = fs.readFileSync(fnPath, 'utf8');
const loginPath = path.join(__dirname, '..', 'rsms-login.html');
const loginSrc = fs.readFileSync(loginPath, 'utf8');
const fbPath = path.join(__dirname, '..', 'rsms-firebase.js');
const fbSrc = fs.readFileSync(fbPath, 'utf8');

test('verifyGatewayPin: exported callable checks PINs server-side', () => {
  assert.ok(/exports\.verifyGatewayPin\s*=\s*https\.onCall/.test(fnSrc),
    'verifyGatewayPin must be an exported onCall');
  assert.ok(/timingSafeTextEqual\(expected,\s*pin\)/.test(fnSrc),
    'role PIN comparison must be timing-safe');
  assert.ok(/timingSafeTextEqual\(staffPin,\s*pin\)/.test(fnSrc),
    'staff record PIN comparison must be timing-safe');
});

test('verifyGatewayPin: HM falls back to the principal PIN like the old flow', () => {
  assert.ok(/if\(!expected && role === 'hm'\) expected = cleanText\(pins\.principal/.test(fnSrc));
});

test('verifyGatewayPin: rate-limits repeated failures per school and role', () => {
  assert.ok(/count >= 10/.test(fnSrc), 'lockout after repeated failures');
  assert.ok(/15 \* 60 \* 1000/.test(fnSrc), 'failures window expires');
  assert.ok(/attemptsRef\.remove\(\)/.test(fnSrc), 'successful sign-in clears attempts');
});

test('verifyGatewayPin: mints a custom token with school and role claims', () => {
  assert.ok(/createCustomToken/.test(fnSrc), 'mints a signed token');
  assert.ok(/gateway:\s*true/.test(fnSrc), 'claims mark gateway sign-ins');
  assert.ok(/roleMap\[role\] = true/.test(fnSrc));
  assert.ok(/schoolMap\[schoolId\] = true/.test(fnSrc));
});

test('verifyGatewayPin: wrong PIN increments the attempt counter and logs', () => {
  assert.ok(/attemptsRef\.set\(\{ count: count \+ 1/.test(fnSrc));
  assert.ok(/gateway_login_failed/.test(fnSrc));
  assert.ok(/action: 'gateway_login',/.test(fnSrc));
});

test('verifyGatewayPin: carries staff context (name, class, subjects) into claims', () => {
  assert.ok(/claims\.staffKey = staffKey/.test(fnSrc));
  assert.ok(/claims\.staffName = cleanText\(staffRec\.name/.test(fnSrc));
  assert.ok(/claims\.myClass = cleanText\(mc/.test(fnSrc));
  assert.ok(/claims\.subjects = cleanText\(sj/.test(fnSrc));
});

test('login page: PIN check calls the server callable with school, role and identity', () => {
  assert.ok(/httpsCallable\('verifyGatewayPin'\)/.test(loginSrc));
  assert.ok(/call\(\{schoolId:STATE\.school\.schoolId\|\|'', role:STATE\.role, pin:ent, staffKey:person\.id\|\|''\}\)/.test(loginSrc));
  assert.ok(/firebase-functions-compat\.js/.test(loginSrc), 'callable SDK loaded');
});

test('login page: success signs in with the returned token and clears pinAuth', () => {
  assert.ok(/signInWithCustomToken\(tok\)/.test(loginSrc));
  assert.ok(/if\(s&&s\.pinAuth\)\{ delete s\.pinAuth; s\.gatewayAuth=true;/.test(loginSrc),
    'pinAuth marker must be dropped so the portal adopts the claims');
});

test('login page: falls back to the local check when the callable is missing', () => {
  assert.ok(/functions\/not-found[\s\S]*functions\/unavailable[\s\S]*functions\/internal/.test(loginSrc));
  assert.ok(/function legacyCheckPIN\(ent\)/.test(loginSrc));
  // Legacy comparison against STATE._expectedPin still present as the fallback.
  assert.ok(/ent===STATE\._expectedPin/.test(loginSrc));
});

test('login page: local/offline appliance mode keeps local verification', () => {
  assert.ok(/RSMS_LOCAL && window\.RSMS_LOCAL\.mode==='lan'\)\{ legacyCheckPIN\(ent\); return; \}/.test(loginSrc));
});

test('login page: throttled lockout message shown, not a wrong-PIN message', () => {
  assert.ok(/Too many failed attempts\. Wait a few minutes and try again\./.test(loginSrc));
});

test('rsms-firebase.js: gateway claims seed the portal session', () => {
  assert.ok(/if\(claims && claims\.gateway\)\{/.test(fbSrc));
  assert.ok(/if\(claims\.schoolId\) session\.schoolId = claims\.schoolId;/.test(fbSrc));
  assert.ok(/if\(claims\.myClass\) session\.myClass = claims\.myClass;/.test(fbSrc));
  assert.ok(/if\(claims\.staffKey\) session\.staffKey = claims\.staffKey;/.test(fbSrc));
});

test('rsms-firebase.js: pinAuth guard stays intact for the legacy path', () => {
  assert.ok(/previous && previous\.pinAuth === true/.test(fbSrc));
});
