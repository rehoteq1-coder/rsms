// One sign-in for the Control Centre and the superadmin console: the console
// unlocks with the superadmin password through a server-side callable, because
// the strict rules rightly stopped serving config/superadmin_hash to browsers.
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fnSrc = fs.readFileSync(path.join(__dirname, '..', 'functions', 'src', 'index.js'), 'utf8');
const ctrlSrc = fs.readFileSync(path.join(__dirname, '..', 'rsms-control.html'), 'utf8');
const saSrc = fs.readFileSync(path.join(__dirname, '..', 'rsms-superadmin.html'), 'utf8');

test('verifySuperadminPassword: exported callable compares server-side', () => {
  assert.ok(/exports\.verifySuperadminPassword\s*=\s*https\.onCall/.test(fnSrc),
    'verifySuperadminPassword must be an exported onCall');
  assert.ok(/timingSafeTextEqual\(stored,\s*sha256\(pw\)\)/.test(fnSrc),
    'comparison must be timing-safe');
  assert.ok(/config\/superadmin_hash/.test(fnSrc));
});

test('verifySuperadminPassword: rate-limits and logs attempts', () => {
  assert.ok(/superadmin_attempts/.test(fnSrc), 'dedicated attempt counter');
  assert.ok(/count >= 10/.test(fnSrc), 'lockout after repeated failures');
  assert.ok(/superadmin_login_failed/.test(fnSrc));
  assert.ok(/superadmin_login',/.test(fnSrc));
});

test('superadmin panel: sign-in calls the callable before any hash read', () => {
  assert.ok(/httpsCallable\('verifySuperadminPassword'\)/.test(saSrc));
  assert.ok(/firebase-functions-compat\.js/.test(saSrc), 'callable SDK loaded');
  const start = saSrc.indexOf('async function saLogin()');
  const end = saSrc.indexOf('function showDashboard()');
  assert.ok(start >= 0 && end > start, 'saLogin block located');
  const block = saSrc.slice(start, end);
  const callIdx = block.indexOf("httpsCallable('verifySuperadminPassword')");
  const readIdx = block.indexOf('config/superadmin_hash');
  assert.ok(callIdx >= 0 && readIdx > callIdx,
    'the direct hash read may only appear as the fallback after the callable attempt');
  assert.ok(/functions\/permission-denied/.test(saSrc), 'wrong password surfaces as Wrong password');
});

test('control centre: one sign-in marks both sessions', () => {
  assert.ok(/httpsCallable\('verifySuperadminPassword'\)/.test(ctrlSrc));
  assert.ok(/setItem\('rsms_superadmin_auth','true'\)/.test(ctrlSrc),
    'console iframe signs in through the shared sessionStorage');
  assert.ok(/firebase-functions-compat\.js/.test(ctrlSrc), 'callable SDK loaded');
  assert.ok(/expectedCtrlHash\(\)/.test(ctrlSrc), 'classic dashboard password still works');
});
