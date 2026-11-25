// Early-years ratings mode: creche/Baby Class teachers score via the developmental
// rubric in the scoring unit, and ratings flow into the progress report card.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const eyRx = src => {
  const m = src.match(/function _eyClass\(cls\)\{ return \/(.+?)\/i\.test/);
  assert.ok(m, '_eyClass defined');
  return new RegExp(m[1], 'i');
};
const slugFn = src => {
  const m = src.match(/function _devAreaSlug\(a\)\{[\s\S]*?\}/);
  assert.ok(m, '_devAreaSlug defined');
  return new Function('a', 'var f=' + m[0] + '; return f(a);');
};

for (const f of ['rsms-teacher.html', 'rsms-classteacher.html']) {
  test(f + ': creche/baby classes enter developmental ratings mode', () => {
    const src = read(f);
    const rx = eyRx(src);
    assert.ok(rx.test('Creche'), 'creche is early years');
    assert.ok(rx.test('Baby Class'), 'Baby Class is early years');
    assert.ok(rx.test('Pre-school'), 'pre-school is early years');
    assert.ok(!rx.test('KG 1'), 'KG is NOT early years');
    assert.ok(!rx.test('Nursery 1'), 'Nursery is NOT early years');
    assert.ok(!rx.test('Primary 1'), 'Primary is NOT early years');
  });
  test(f + ': ratings table + save wired into the scoring unit', () => {
    const src = read(f);
    assert.ok(src.includes('function loadRatingsTable(){'), 'loadRatingsTable defined');
    assert.ok(src.includes('function saveTeacherRatings(){'), 'saveTeacherRatings defined');
    assert.ok(src.includes('if(_eyClass(cls)){ loadRatingsTable(); return; }'), 'load branch');
    assert.ok(src.includes('if(eyRatingsActive){ saveTeacherRatings(); return; }'), 'save branch');
    const saveBody = src.match(/function saveTeacherRatings\(\)\{[\s\S]{0,1500}/)[0];
    assert.ok(saveBody.includes('.toLowerCase()'), 'letters stored lowercase like the card expects');
    assert.ok(src.includes('rsms_progress_ratings'), 'writes the progress-report localStorage keys');
    assert.ok(src.includes("firebase.database().ref('schools/'+fsid+'/progress_ratings/'+sid).update("), 'also persists ratings to Firebase');
    assert.ok(src.includes('Developmental ratings'), 'mode explained in the UI');
  });
}

test('teacher rates the same areas the progress report card renders', () => {
  const teacher = read('rsms-teacher.html');
  const report = read('rsms-progress-report.html');
  const areas = [...teacher.matchAll(/\{area:'([^']+)', short:/g)].map(m => m[1]);
  assert.equal(areas.length, 5, 'five development areas');
  const card = report.slice(report.indexOf('function buildProgressCard'));
  const cardAreas = [...card.matchAll(/\{area:'([^']+)',items:/g)].map(m => m[1]);
  assert.deepEqual(areas, cardAreas, 'teacher area names match the card areas exactly');
});

test('progress report card falls back to the area-level rating', () => {
  const src = read('rsms-progress-report.html');
  assert.ok(src.includes("sv=ratings[slug]||ratings[_slug(section.area)]||''"), 'item rating falls back to area rating');
  assert.equal(slugFn(read('rsms-teacher.html'))('Cognitive Development'), 'cognitive-development', 'area slug matches the card slug');
});

test('teacher ratings grid hides subject and bulk-CSV controls in ratings mode', () => {
  const src = read('rsms-teacher.html');
  assert.ok(src.includes('id="sc-bulk-card"'), 'bulk CSV card tagged');
  const fn = src.match(/function enterEyRatingsMode\(on\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'enterEyRatingsMode defined');
  assert.ok(fn[0].includes("fg.style.display=on?'none':''"), 'subject field hidden in ratings mode');
  assert.ok(fn[0].includes("bulk.style.display=on?'none':''"), 'bulk card hidden in ratings mode');
});
