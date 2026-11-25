// Report split: progress report only for creche/Baby Class/pre-school; KG and Nursery use the report card
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const rxFrom = src => {
  const m = src.match(/function _isEarlyYears\(cls\)\{[\s\S]*?\}/);
  assert.ok(m, '_isEarlyYears defined');
  const line = m[0].match(/return \/(.+)\/i\.test/);
  assert.ok(line, 'regex found');
  return new RegExp(line[1], 'i');
};

test('progress report early-years matcher no longer claims KG or Nursery', () => {
  const rx = rxFrom(read('rsms-progress-report.html'));
  assert.ok(rx.test('Creche'), 'creche is early years');
  assert.ok(rx.test('Baby Class'), 'Baby Class is early years');
  assert.ok(rx.test('Pre-school'), 'pre-school is early years');
  assert.ok(!rx.test('KG 1'), 'KG is NOT early years');
  assert.ok(!rx.test('Nursery 1'), 'Nursery is NOT early years');
});

test('progress report page no longer lists Nursery or KG classes', () => {
  const src = read('rsms-progress-report.html');
  assert.ok(src.includes('<option>Baby Class</option>'), 'Baby Class option present');
  assert.ok(src.includes('<option>Pre-school</option>'), 'Pre-school option present');
  assert.ok(!/<option>Nursery 1<\/option>/.test(src), 'Nursery 1 option removed');
  assert.ok(!/<option>KG 1<\/option>/.test(src), 'KG 1 option removed');
  assert.ok(!/<option>Pre-Primary 1<\/option>/.test(src), 'Pre-Primary option removed');
  assert.ok(!/KG & Nursery Progress Report/.test(src), 'old title removed');
});

test('report card claims creche/baby classes for the progress report, not KG/Nursery', () => {
  const rx = rxFrom(read('rsms-results-print.html'));
  assert.ok(rx.test('Creche'), 'creche routed to progress report');
  assert.ok(rx.test('Baby Class'), 'baby class routed to progress report');
  assert.ok(!rx.test('KG 1'), 'KG stays on the report card');
  assert.ok(!rx.test('Nursery 2'), 'Nursery stays on the report card');
  assert.ok(!/toast\('KG, pre-nursery/.test(read('rsms-results-print.html')), 'old KG toast wording removed');
});

test('HM and Principal report pickers label the progress report for creche/baby class', () => {
  for (const f of ['rsms-hm.html', 'rsms-principal.html']) {
    const src = read(f);
    assert.ok(src.includes('Progress Report (Crèche &amp; Baby Class)'), f + ' label updated');
    assert.ok(!src.includes('Progress Report (KG/Nursery)'), f + ' old label removed');
  }
});
