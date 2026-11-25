// School branding stored in the database (schools/<id>/branding):
// every portal must read it, not just the device the admin uploaded on.
// Static guards: helper present everywhere, wrong-id bug stays fixed,
// admin writes branding to the database and downscales uploaded rasters.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const read = f => fs.readFileSync(f, 'utf8');

const PORTALS = [
  'index.html', 'rsms-admin.html', 'rsms-teacher.html', 'rsms-classteacher.html',
  'rsms-hod.html', 'rsms-hm.html', 'rsms-principal.html', 'rsms-vp.html',
  'rsms-bursar.html', 'rsms-student.html', 'rsms-parent.html'
];

test('every portal defines and calls applySchoolBranding', () => {
  for (const f of PORTALS) {
    const s = read(f);
    assert.ok(s.includes('function applySchoolBranding('), `${f}: helper defined`);
    assert.ok(s.includes('applySchoolBranding('), `${f}: helper called`);
  }
});

test('helper reads branding from the database and falls back to initials-safe ids', () => {
  for (const f of PORTALS) {
    const s = read(f);
    assert.ok(s.includes("ref('schools/'+sid+'/branding')"), `${f}: database read`);
    assert.ok(
      s.includes("document.getElementById('sb-logo-img')||document.getElementById('sb-logo')"),
      `${f}: matches both sidebar logo ids`
    );
  }
});

test('portals that had the wrong logo id no longer look up only sb-logo-img', () => {
  // teacher/vp/classteacher/hod/student markup uses id="sb-logo" while their
  // old JS looked up 'sb-logo-img', so the logo never showed even from cache.
  for (const f of ['rsms-teacher.html', 'rsms-vp.html', 'rsms-classteacher.html', 'rsms-hod.html', 'rsms-student.html']) {
    const s = read(f);
    assert.ok(!/getElementById\('sb-logo-img'\);\s*\n\s*var logo=localStorage/.test(s), `${f}: old id-mismatch block removed`);
  }
});

test('hm and principal sidebars carry the school logo', () => {
  for (const f of ['rsms-hm.html', 'rsms-principal.html']) {
    const s = read(f);
    assert.ok(s.includes('id="sb-logo-img"'), `${f}: logo markup`);
    assert.ok(s.includes('id="sb-school"'), `${f}: school name markup`);
    assert.ok(s.includes('applySchoolBranding(school.schoolId)'), `${f}: applied at init`);
  }
});

test('admin saves branding to the database and downscales uploads', () => {
  const s = read('rsms-admin.html');
  assert.ok(s.includes("ref('schools/'+school.schoolId+'/branding')"), 'branding write to database');
  assert.ok(s.includes("bref.child('logoUrl')"), 'logoUrl write');
  assert.ok(s.includes("bref.child('brandColor')"), 'brandColor write');
  assert.ok(s.includes('id="cfg-brandcolor"'), 'brand colour picker present');
  assert.ok(s.includes('MAX=256'), 'upload downscale to 256px');
  assert.ok(s.includes("c.toDataURL('image/webp',0.9)"), 'webp compression');
});
