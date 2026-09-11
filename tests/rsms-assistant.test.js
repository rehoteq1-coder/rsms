'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const assistant = require(path.join(__dirname, '..', 'rsms-assistant.js'));

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
