// School settings save: the admin's Save Settings must push the school
// profile (name, address, phone, email, principal, term, session, plan)
// to the database info node, because warmCache overwrites rsms_school
// from schools/<sid>/info on every portal load. Local-only saves are
// wiped on the next sign-in, which is the bug this fixes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const fbBody = () => read('rsms-firebase.js').match(/function saveSchoolProfile\(data\)\{[\s\S]{0,1600}/)[0];

test('rsms-firebase.js: saveSchoolProfile is defined and exported', () => {
  const src = read('rsms-firebase.js');
  assert.ok(src.includes('function saveSchoolProfile(data){'), 'defined');
  assert.ok(src.includes('saveSchoolProfile: saveSchoolProfile'), 'in the public API');
});

test('saveSchoolProfile merges into schools/<sid>/info, the node warmCache reads back', () => {
  const body = fbBody();
  assert.ok(body.includes("ref('schools/'+sid+'/info')"), 'targets the info node');
  assert.ok(body.includes('.update(payload)'), 'merge write, never a full-set clobber');
  assert.ok(body.includes('delete payload.assessment'), 'assessment subtree protected');
});

test('saveSchoolProfile refuses offline paths instead of silently dropping the save', () => {
  const body = fbBody();
  assert.ok(body.includes("window.RSMS_LOCAL.mode==='lan'"), 'LAN mode rejected with a message');
  assert.ok(body.includes('if(!_ready||!_db) return Promise.reject'), 'no connection rejected');
  assert.ok(body.includes("return Promise.reject(new Error("), 'failures surface, not console-only');
});

test('admin Save Settings saves the profile to the database alongside the scheme', () => {
  const body = read('rsms-admin.html').match(/function saveSettings\(\)\{[\s\S]{0,4500}/)[0];
  assert.ok(body.includes('RSMS_FB.saveSchoolProfile(school)'), 'profile pushed to the database');
  assert.ok(body.includes('Promise.all(jobs)'), 'profile and assessment saved together');
  assert.ok(body.includes("e._part='the school information'"), 'failure names which part failed');
  assert.ok(body.includes("localStorage.setItem('rsms_school',JSON.stringify(school))"), 'device cache still updated');
});

test('warmCache still feeds rsms_school from the database info node', () => {
  const src = read('rsms-firebase.js');
  assert.ok(src.includes("localStorage.setItem('rsms_school', json)"), 'info overwrite happens on portal load');
});
