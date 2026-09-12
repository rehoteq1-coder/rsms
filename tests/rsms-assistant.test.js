'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const assistant = require(path.join(__dirname, '..', 'rsms-assistant.js'));
const repoRoot = path.join(__dirname, '..');

test('answer() matches an entry from a natural question', () => {
  const reply = assistant.answer('I forgot my PIN, what do I do?');
  assert.ok(reply.entry, 'expected a matched entry');
  assert.equal(reply.entry.id, 'pin');
  assert.equal(reply.unanswered, false);
  assert.match(reply.text, /school admin/i);
});

test('answer() is case, punctuation and whitespace insensitive', () => {
  const a = assistant.answer('  HOW   do I LOG IN?? ');
  const b = assistant.answer('how do i log in');
  assert.equal(a.entry.id, 'login');
  assert.equal(a.entry.id, b.entry.id);
});

test('answer() routes common phrasings to the right entry', () => {
  const cases = [
    ['how do i find my school', 'login'],
    ['reset my password', 'pin'],
    ['can i print a report card', 'results'],
    ['who collects school fees', 'fees'],
    ['does it work without internet', 'offline'],
    ['how much does rsms cost', 'pricing'],
    ['i want to talk to a human', 'support'],
    ['can teachers do cbt exams', 'cbt']
  ];
  for (const [question, id] of cases) {
    const reply = assistant.answer(question);
    assert.equal(reply.entry && reply.entry.id, id, `question: ${question}`);
  }
});

test('answer() falls back with suggestions instead of guessing', () => {
  const reply = assistant.answer('what is the weather in lagos tomorrow');
  assert.equal(reply.entry, null);
  assert.equal(reply.unanswered, true);
  assert.ok(reply.suggestions.length > 0, 'expected suggestion chips');
  assert.equal(reply.suggestions.length <= 3, true);
});

test('the assistant has a name and introduces itself', () => {
  assert.equal(assistant.NAME, 'Toye');
  assert.match(assistant.answer('hello there').text, /I am Toye/i);
  assert.match(assistant.answer('').text, /I am Toye/i);
});

test('visitors can ask who the assistant is', () => {
  const reply = assistant.answer('what is your name?');
  assert.equal(reply.entry.id, 'identity');
  assert.match(reply.text, /Toye/);
  const alt = assistant.answer('are you a robot?');
  assert.equal(alt.entry.id, 'identity');
});

test('a greeting answers instead of falling back', () => {
  const reply = assistant.answer('hello there');
  assert.equal(reply.entry.id, 'hello');
  assert.equal(reply.unanswered, false);
});

test('an empty question greets instead of matching', () => {
  const reply = assistant.answer('');
  assert.equal(reply.entry, null);
  assert.equal(reply.unanswered, false);
  assert.match(reply.text, /RSMS assistant/i);
});

test('safeRich() escapes HTML and only allows http(s) links and bold', () => {
  const out = assistant.safeRich('<img src=x onerror=alert(1)> **bold** [site](https://rehoteq.com)');
  assert.ok(!out.includes('<img'), 'raw HTML must be escaped');
  assert.ok(out.includes('&lt;img'));
  assert.ok(out.includes('<strong>bold</strong>'));
  assert.ok(out.includes('href="https://rehoteq.com"'));
  assert.ok(out.includes('rel="noopener noreferrer"'));
});

test('safeRich() rejects javascript: and other unsafe link schemes', () => {
  const out = assistant.safeRich('click [here](javascript:alert(1)) now');
  assert.ok(!out.includes('href='), 'unsafe scheme must not become a link');
  assert.equal(assistant.safeUrl('javascript:alert(1)'), '');
  assert.equal(assistant.safeUrl('https://rehoteq.com/x'), 'https://rehoteq.com/x');
});

test('mergeKb() lets an admin override an entry and drops junk', () => {
  const merged = assistant.mergeKb([
    { id: 'pin', answer: 'Call the bursar on extension 2.' },
    { id: '', answer: 'no id' },
    { id: 'ghost' },
    'not an object',
    { id: 'bus', title: 'Bus routes', answer: 'Buses leave at 14:00.', keywords: ['bus', 'transport'] }
  ]);
  assert.equal(assistant.byId('pin', merged).answer, 'Call the bursar on extension 2.');
  assert.equal(assistant.byId('bus', merged).keywords.join(','), 'bus,transport');
  assert.equal(assistant.byId('ghost', merged), null);
  assert.equal(merged.length, assistant.KB.length + 1);
});

test('merged remote entries are answerable and still sanitised', () => {
  const merged = assistant.mergeKb([
    { id: 'bus', title: 'Bus routes', answer: 'Buses leave at **14:00**.', keywords: ['bus route', 'transport'] }
  ]);
  const reply = assistant.answer('when is the bus route?', { kb: merged });
  assert.equal(reply.entry.id, 'bus');
  assert.ok(reply.html.includes('<strong>14:00</strong>'));
});

/* ── deeper knowledge base ───────────────────────────────── */

test('the new onboarding, admission, migration, access and troubleshooting entries answer', () => {
  const cases = [
    ['how do i register my school on rsms', 'onboarding'],
    ['how does a parent apply for admission', 'admission'],
    ['can i import my students from a csv', 'migration'],
    ['how do i send a parent their access link', 'access'],
    ['the page is blank and nothing works', 'troubleshooting']
  ];
  for (const [question, id] of cases) {
    const reply = assistant.answer(question);
    assert.equal(reply.entry && reply.entry.id, id, `question: ${question}`);
    assert.ok(reply.text.length > 120, `${id} should answer in real detail`);
  }
});

test('every entry has a unique id, keywords and a more block', () => {
  const seen = new Set();
  for (const entry of assistant.KB) {
    assert.ok(entry.id, 'entry needs an id');
    assert.equal(seen.has(entry.id), false, `duplicate id: ${entry.id}`);
    seen.add(entry.id);
    assert.ok(entry.keywords && entry.keywords.length, `${entry.id} needs keywords`);
    assert.ok(entry.answer && entry.answer.length > 80, `${entry.id} needs a real answer`);
    assert.ok(entry.more && entry.more.length > 80, `${entry.id} needs a "tell me more" block`);
  }
});

test('"tell me more" expands the topic the visitor was last on', () => {
  const first = assistant.answer('how do I sign in?');
  assert.equal(first.entry.id, 'login');
  assert.equal(first.more, false);

  const deeper = assistant.answer('tell me more', { lastTopic: first.entry.id });
  assert.equal(deeper.entry.id, 'login');
  assert.equal(deeper.more, true);
  assert.equal(deeper.text, first.entry.more);
  assert.notEqual(deeper.text, first.text);

  for (const phrase of ['more', 'tell me more', 'go on', 'explain further', 'continue please']) {
    assert.equal(assistant.isMoreRequest(phrase), true, phrase);
  }
  for (const phrase of ['how much is rsms', 'my child is in jss 2', 'the portal is slow', '']) {
    assert.equal(assistant.isMoreRequest(phrase), false, phrase);
  }
});

test('a follow-up with no remembered topic asks which topic instead of guessing', () => {
  const reply = assistant.answer('more');
  assert.equal(reply.entry, null);
  assert.equal(reply.unanswered, false);
  assert.equal(reply.more, true);
  assert.match(reply.text, /which topic/i);
  assert.ok(reply.suggestions.length > 0);
});

test('entries expose portal actions that resolve to PORTALS pages', () => {
  const portalValues = Object.values(assistant.PORTALS);
  let goActions = 0;
  for (const entry of assistant.KB) {
    for (const action of entry.actions || []) {
      assert.ok(action.label && action.act, `${entry.id} action needs a label and act`);
      if (action.act !== 'go') continue;
      goActions++;
      assert.ok(portalValues.includes(action.value), `${entry.id}: ${action.value} is not a known portal`);
      assert.equal(assistant.safePortalTarget(action.value), action.value);
    }
  }
  assert.ok(goActions >= 12, `expected the KB to open several portals, got ${goActions}`);
});

test('every portal in the index is a page that exists in the repo', () => {
  const keys = Object.keys(assistant.PORTALS);
  assert.ok(keys.length >= 18, 'the portal index should cover the RSMS pages');
  for (const key of keys) {
    const file = assistant.PORTALS[key];
    assert.match(file, assistant.PORTAL_TARGET_RE, `${key}: ${file} is not a safe target`);
    assert.ok(fs.existsSync(path.join(repoRoot, file)), `${key}: ${file} is missing from the repo`);
  }
});

test('safePortalTarget() blocks javascript:, protocol-relative and parent paths', () => {
  const bad = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '//evil.example/steal.html',
    'https://evil.example/rsms-apply.html',
    '../rsms-apply.html',
    'admin/rsms-apply.html',
    'RSMS-APPLY.HTML',
    'rsms-apply.html?next=javascript:alert(1)',
    '',
    null,
    undefined
  ];
  for (const value of bad) {
    assert.equal(assistant.safePortalTarget(value), '', `should be rejected: ${String(value)}`);
  }
  assert.equal(assistant.safePortalTarget('rsms-apply.html'), 'rsms-apply.html');
  assert.equal(assistant.safePortalTarget('  rsms-cbt.html  '), 'rsms-cbt.html');
});

test('synonyms route the words visitors actually type', () => {
  assert.equal(assistant.answer('i want to signup').entry.id, 'onboarding');
  assert.equal(assistant.answer('csv upload of students').entry.id, 'migration');
  assert.equal(assistant.answer('how much is it').entry.id, 'pricing');
  // the synonym table itself stays normalised
  for (const key of Object.keys(assistant.SYNONYMS)) {
    assert.equal(key, assistant.normalize(key), `synonym key not normalised: ${key}`);
  }
});

test('light stemming matches inflected words', () => {
  assert.equal(assistant.stem('printing'), 'print');
  assert.equal(assistant.stem('payments'), 'payment');
  assert.equal(assistant.stem('less'), 'less', 'short words must survive stemming');
  assert.equal(assistant.answer('printing a result card').entry.id, 'results');
  assert.equal(assistant.answer('paying school fees').entry.id, 'fees');
});

test('a remote override can replace an answer and its more block, but not actions', () => {
  const merged = assistant.mergeKb([{
    id: 'fees',
    title: 'Fees',
    answer: 'Fees are paid at the bursary, **room 4**.',
    more: 'Opening hours are 8am to 2pm.',
    keywords: ['fee', 'fees'],
    actions: [{ label: 'Evil', act: 'go', value: 'javascript:alert(1)' }]
  }]);
  const reply = assistant.answer('school fees', { kb: merged });
  assert.equal(reply.entry.id, 'fees');
  assert.match(reply.text, /room 4/);
  assert.deepEqual(reply.actions, [], 'remote entries must not bring their own actions');
  const deeper = assistant.answer('tell me more', { kb: merged, lastTopic: 'fees' });
  assert.match(deeper.text, /8am to 2pm/);
});

test('unanswered questions never invent a portal link', () => {
  const reply = assistant.answer('who won the world cup in 1994');
  assert.equal(reply.entry, null);
  assert.equal(reply.unanswered, true);
  assert.deepEqual(reply.actions, []);
  for (const suggestion of reply.suggestions) {
    for (const action of suggestion.actions || []) {
      if (action.act === 'go') assert.ok(assistant.safePortalTarget(action.value));
    }
  }
});
