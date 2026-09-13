#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   Toye — DOM checks for the landing-page assistant widget
   -----------------------------------------------------------
   Runs the real widget from index.html in jsdom, the way a
   visitor's browser would, and checks the behaviour unit tests
   cannot see: rendering, chips, action buttons, follow-ups and —
   importantly — that a knowledge base tampered from Firebase
   cannot navigate the visitor anywhere but a local page. The
   voice layer runs against a stubbed speechSynthesis, so Toye
   speaking is checked without any browser audio at all.

   Usage:
     npm install --no-save jsdom          # dev-only, not persisted
     node tests/assistant-dom.check.js   # → "12/12 jsdom DOM checks passed"
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.log('SKIPPED: jsdom is not installed. Run: npm install --no-save jsdom');
  process.exit(0);
}
const { VirtualConsole } = require('jsdom');

/* ── harness ─────────────────────────────────────────────── */

const total = 12;
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Pull the widget out of the real page: its markup plus the inline
   page-layer script, with no server and no network involved.
   opts.voice injects a stub speechSynthesis BEFORE the page layer
   runs, and collects every utterance the widget submits for the
   voice checks. */
function extractWidget() {
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const markupStart = html.indexOf('<div class="rsms-assist" id="rsms-assist" hidden>');
  const scriptOpen = html.indexOf('<script>', markupStart);
  const scriptClose = html.indexOf('</script>', scriptOpen);
  if (markupStart === -1 || scriptOpen === -1 || scriptClose === -1) {
    throw new Error('could not find the assistant widget in index.html');
  }
  return {
    markup: html.slice(markupStart, scriptOpen),
    script: html.slice(scriptOpen + '<script>'.length, scriptClose)
  };
}

function boot(storageSeed, opts) {
  const options = opts || {};
  const { markup, script } = extractWidget();
  const navigationErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    if (/Not implemented: navigation/.test(err.message)) navigationErrors.push(err.message);
  });

  const dom = new JSDOM('<!DOCTYPE html><html><body>' + markup + '</body></html>', {
    url: 'https://rsms.rehoteq.com/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });

  const win = dom.window;
  if (storageSeed) {
    for (const key of Object.keys(storageSeed)) win.localStorage.setItem(key, storageSeed[key]);
  }
  const voice = { spoken: [], cancels: 0 };
  if (options.voice) {
    win.SpeechSynthesisUtterance = function (text) { this.text = text; };
    win.speechSynthesis = {
      getVoices: () => [
        { name: 'Microsoft Nigerian English', lang: 'en-NG' },
        { name: 'Google UK English Female', lang: 'en-GB' }
      ],
      speak(utt) { voice.spoken.push(utt); },
      cancel() { voice.cancels++; }
    };
  }
  // Order matters: brand → brain → page layer.
  win.eval(fs.readFileSync(path.join(repoRoot, 'rsms-brand.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(repoRoot, 'rsms-assistant.js'), 'utf8'));
  win.eval(script);
  return { win, navigationErrors, voice };
}

const logMessages = (win) =>
  Array.from(win.document.querySelectorAll('#rsms-assist-log .rsms-assist-msg'));
const lastMessage = (win) => {
  const all = logMessages(win);
  return all.length ? all[all.length - 1] : null;
};
// Action buttons belong to the message they were rendered under.
const actionButtons = (win) => {
  const last = lastMessage(win);
  return last ? Array.from(last.querySelectorAll('.rsms-assist-act')) : [];
};

/* ── checks ──────────────────────────────────────────────── */

(async function main() {
  console.log('Toye DOM checks (jsdom)\n');

  const { win, navigationErrors } = boot();
  const doc = win.document;

  await check('1. the widget appears once the brain loads', () => {
    assert(win.RSMS_ASSISTANT, 'the brain did not load');
    assert(win.RSMS_ASSISTANT_WIDGET, 'the widget did not initialise');
    assert(doc.getElementById('rsms-assist').hidden === false, 'widget stayed hidden');
  });

  await check('2. the bot is named from rsms-brand.js', () => {
    assert.equal(doc.getElementById('rsms-assist-title').textContent, 'Toye');
    assert.match(doc.getElementById('rsms-assist-fab').getAttribute('aria-label'), /Toye/);
  });

  await check('3. opening the panel greets with a message and chips', () => {
    doc.getElementById('rsms-assist-fab').click();
    assert(doc.getElementById('rsms-assist-panel').hidden === false, 'panel did not open');
    assert(logMessages(win).length === 1, 'expected exactly one greeting message');
    assert(doc.querySelectorAll('.rsms-assist-chip').length > 0, 'expected suggestion chips');
  });

  const input = doc.getElementById('rsms-assist-input');
  input.value = 'how do I sign in?';
  doc.getElementById('rsms-assist-form').dispatchEvent(
    new win.Event('submit', { bubbles: true, cancelable: true })
  );
  await sleep(500);

  await check('4. submitting the form renders the question and the answer', () => {
    const userMsg = logMessages(win).filter((m) => m.classList.contains('user'));
    assert.equal(userMsg.length, 1, 'expected the visitor question in the log');
    assert.match(userMsg[0].textContent, /how do I sign in/i);
    assert.match(lastMessage(win).textContent, /Find your school/i);
    assert.equal(input.value, '', 'the input should be cleared after sending');
  });

  await check('5. action buttons render, including "Tell me more"', () => {
    const labels = actionButtons(win).map((b) => b.textContent);
    assert(labels.includes('Find my school'), 'missing the school action: ' + labels.join(', '));
    assert(labels.includes('Open the dashboard'), 'missing the portal action: ' + labels.join(', '));
    assert(labels.includes('Tell me more'), 'missing the follow-up button: ' + labels.join(', '));
  });

  await check('6. clicking a real portal button opens the page', () => {
    const before = navigationErrors.length;
    const portalButton = actionButtons(win).find((b) => b.textContent === 'Open the dashboard');
    assert(portalButton, 'no portal button rendered');
    portalButton.click();
    assert.equal(
      navigationErrors.length,
      before + 1,
      'clicking a portal button should navigate to a local page'
    );
  });

  await check('7. a tampered KB cannot navigate to javascript:', async () => {
    // Stand in for a hostile config/assistant_kb entry pushed from Firebase.
    const entry = win.RSMS_ASSISTANT.byId('admission');
    entry.actions = [{ label: 'Claim your prize', act: 'go', value: 'javascript:alert(1)' }];

    const before = navigationErrors.length;
    win.RSMS_ASSISTANT_WIDGET.ask('admission form');
    await sleep(500);

    const evil = actionButtons(win).find((b) => b.textContent === 'Claim your prize');
    assert(evil, 'the tampered action did not render');
    evil.click();
    assert.equal(navigationErrors.length, before, 'a javascript: target must never navigate');
    assert.match(
      lastMessage(win).textContent,
      /not one I can open/i,
      'the visitor should be told the page cannot be opened'
    );
  });

  win.RSMS_ASSISTANT_WIDGET.ask('how much does RSMS cost');
  await sleep(500);
  const pricingAnswer = lastMessage(win).textContent;
  win.RSMS_ASSISTANT_WIDGET.ask('tell me more');
  await sleep(500);

  await check('8. "tell me more" deepens the last topic', () => {
    const deeper = lastMessage(win).textContent;
    assert.notEqual(deeper, pricingAnswer, 'the follow-up repeated the same answer');
    assert.match(deeper, /Standard adds/i, 'expected the pricing expansion');
  });

  await check('9. the last topic is remembered for the next visit', async () => {
    assert.equal(win.localStorage.getItem('rsms_assist_topic'), 'pricing');
    const reload = boot({ rsms_assist_topic: 'pricing' });
    reload.win.RSMS_ASSISTANT_WIDGET.ask('more');
    await sleep(500);
    const text = lastMessage(reload.win).textContent;
    assert.match(text, /Standard adds/i, 'a reload should keep the thread: ' + text.slice(0, 60));
  });

  await check('10. an unknown question offers chips instead of a blank wall', async () => {
    win.RSMS_ASSISTANT_WIDGET.ask('who won the world cup in 1994');
    await sleep(500);
    assert.match(lastMessage(win).textContent, /do not have a solid answer/i);
    assert(doc.querySelectorAll('.rsms-assist-chip').length > 0, 'expected suggestion chips');
    assert(actionButtons(win).length === 0, 'an unanswered question must not offer actions');
  });

  await check('11. every answer carries "Read it", and speech is clean text, not markup', async () => {
    // Without a browser voice the controls simply do not exist.
    const plain = boot();
    assert.equal(plain.win.document.getElementById('rsms-assist-voice').hidden, true,
      'the voice toggle must stay hidden without speechSynthesis');
    plain.win.document.getElementById('rsms-assist-fab').click();
    plain.win.RSMS_ASSISTANT_WIDGET.ask('i want to talk to a human');
    await sleep(500);
    assert.equal(plain.win.document.querySelectorAll('.rsms-assist-say').length, 0,
      'no Read-it buttons without a voice');

    // With one, every answer gets its own.
    const v = boot(null, { voice: true });
    v.win.document.getElementById('rsms-assist-fab').click();
    assert.equal(v.win.document.getElementById('rsms-assist-voice').hidden, false,
      'the toggle appears once the browser can speak');
    v.win.RSMS_ASSISTANT_WIDGET.ask('i want to talk to a human');
    await sleep(500);
    const say = lastMessage(v.win).querySelector('.rsms-assist-say');
    assert(say, 'expected a Read-it button on the answer');
    say.click();
    assert.equal(v.voice.spoken.length, 1, 'clicking Read it speaks once');
    const said = v.voice.spoken[0].text;
    assert.match(said, /rehoteq\.com/i);
    assert.ok(!said.includes('*'), 'markdown must not reach the speaker: ' + said);
    assert.ok(!said.includes('https://'), 'link schemes must be flattened away');
    assert.ok(!said.includes('[') && !said.includes(']'), 'link brackets must not be spoken');
    assert.equal(v.voice.spoken[0].voice.lang, 'en-NG', 'the Nigerian voice wins where one exists');
    assert.match(say.textContent, /Stop/i, 'the button turns into a stop control while reading');
    const cancelsBefore = v.voice.cancels;
    say.click();
    assert.ok(v.voice.cancels > cancelsBefore, 'the second click cancels the reading');
    assert.match(say.textContent, /Read it/, 'and the button resets');
  });

  await check('12. the always-speak toggle persists and speaks without a second click', async () => {
    const v = boot(null, { voice: true });
    const toggle = v.win.document.getElementById('rsms-assist-voice');
    v.win.document.getElementById('rsms-assist-fab').click();
    await sleep(500);
    assert.equal(v.voice.spoken.length, 0, 'nothing is spoken until it is asked for');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(v.win.localStorage.getItem('rsms_assist_voice'), '1', 'remembered between visits');
    assert.match(v.voice.spoken[0].text, /voice on/i, 'the change confirms itself out loud');
    v.win.RSMS_ASSISTANT_WIDGET.ask('how do I sign in?');
    await sleep(500);
    assert.equal(v.voice.spoken.length, 2, 'the answer speaks by itself');
    assert.match(v.voice.spoken[1].text, /Find your school/i);

    // a fresh visit: remembered state starts on, and the greeting is read aloud
    const again = boot({ rsms_assist_voice: '1' }, { voice: true });
    const toggle2 = again.win.document.getElementById('rsms-assist-voice');
    assert.equal(toggle2.getAttribute('aria-pressed'), 'true', 'a reload restores the toggle');
    again.win.document.getElementById('rsms-assist-fab').click();
    await sleep(500);
    assert.match(again.voice.spoken[0].text, /I am Toye/i, 'greeting is read aloud too');
    again.win.document.getElementById('rsms-assist-close').click();
    assert.ok(again.voice.cancels > 0, 'closing the panel silences Toye');
  });

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' of ' + total + ' checks failed');
    process.exit(1);
  }
  console.log(passed + '/' + total + ' jsdom DOM checks passed');
  process.exit(0);
})().catch((err) => {
  console.error('\nDOM check run failed:', err);
  process.exit(1);
});
