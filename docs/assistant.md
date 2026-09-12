# Toye — the RSMS assistant

Toye is the helper bot on the landing page (`index.html`). It answers questions
about RSMS and, where it can, opens the right page for the visitor.

Two files own it:

| File | Role |
|---|---|
| `rsms-assistant.js` | The brain. Pure logic — no DOM, no network. Unit-tested in `tests/rsms-assistant.test.js`. |
| `index.html` (inline "RSMS ASSISTANT WIDGET" script) | The page layer. Renders answers, turns `actions[].act` into real UI, owns Firebase hooks. |
| `rsms-brand.js` | The bot's name and face (`assistantName`, `ownerAvatar`). |

The split is deliberate: everything answerable is testable in Node, and nothing
in the brain can touch the page.

## Matching, in plain terms

A question is normalised (lowercased, punctuation dropped), expanded through a
synonym table, and scored against every entry:

| Signal | Weight |
|---|---|
| A whole keyword phrase appears in the question | `4 + phrase length` (capped at 3) |
| A question word appears in the title or keywords | `2` |
| A *stemmed* word matches (`printing` → `print`) | `1.5` |
| A distinctive word (5+ chars) appears in the body text | `0.5` |

The best-scoring entry wins if it clears `THRESHOLD` (3). Ties keep the earlier
entry, so answers are deterministic. Below the threshold Toye says it does not
know and offers up to three chips instead of guessing.

**Synonyms** live in `SYNONYMS` and map the words visitors actually type onto
the wording of the knowledge base — `signup` → onboarding, `csv` → migration,
`how much` → pricing. Keys are matched against the normalised question, so they
must be lowercase with single spaces and no punctuation (a test enforces this).

## Adding or editing an answer

Entries live in the `KB` array in `rsms-assistant.js`:

```js
{
  id: 'buses',                       // stable id — also the "last topic" key
  title: 'Bus routes',               // shown on chips
  keywords: ['bus', 'bus route', 'transport'],
  answer:  'Buses leave at **14:00**. [Timetable](https://rehoteq.com)',
  more:    'The second bus waits for the after-school club.',   // "tell me more"
  actions: [ go('Open the timetable', 'timetable') ]
}
```

Rules of thumb:

- **`answer`** is the short reply. Keep it under a screenful.
- **`more`** is the expansion shown after "tell me more". Every entry in the
  built-in KB has one, and a test fails if a new entry does not.
- **Formatting** is intentionally tiny: `**bold**` and `[label](https://…)`.
  Everything else is escaped — the KB is not trusted, because it can be
  overridden from Firebase.
- **`keywords`** are phrases, not a bag of words. Add the way people ask, not
  just the jargon ("forgot pin", "reset password").
- Run `npm test` after editing: the tests check routing, follow-ups, portal
  targets and that every portal in `PORTALS` exists in the repo.

## Opening a page

`PORTALS` maps a short key to a page in this repo:

```js
var PORTALS = { admission: 'rsms-apply.html', links: 'rsms-links.html', … };
```

An entry opens one with `go('Label', 'key')`, which produces
`{label, act:'go', value:'rsms-apply.html'}`.

Navigation is treated as untrusted input twice over, because the KB can be
replaced from Firebase without a deploy:

1. `safePortalTarget()` in the brain accepts only `^[a-z0-9-]+\.html$`.
2. `goToPortal()` in the page layer re-checks the same pattern before assigning
   `window.location.href`.

So a tampered entry aiming at `javascript:…`, `//evil.example`, `../x.html` or
`rsms-apply.html?next=…` is refused, and the visitor is told the page cannot be
opened. Check 7 of `tests/assistant-dom.check.js` exercises exactly that.

## Overriding answers without a deploy

The page reads `config/assistant_kb` from Firebase Realtime Database on load
(`loadRemoteKb()`), merges it with `A.mergeKb()`, and uses the result for the
rest of the visit. Firebase is optional: if it is unavailable or the node is not
readable, the built-in KB is used and nothing else changes.

Write it from the Superadmin portal or the Firebase console as either an array
or a keyed map:

```json
{
  "buses": {
    "id": "buses",
    "title": "Bus routes",
    "keywords": ["bus", "bus route", "transport"],
    "answer": "Buses leave at **14:00** from the front gate.",
    "more": "The second bus waits for the after-school club."
  }
}
```

- Matching an existing `id` **replaces** that entry; a new `id` **adds** one.
- Missing `keywords` fall back to the words of the `id`.
- `answer` and `more` are capped at 2000 characters, `title` at 80, up to 40
  keywords. Entries with no `id` or no `answer` are dropped.
- **`actions` are always discarded.** Remote content cannot add navigation —
  only `PORTALS`, which is code-owned, decides where a button can go.
- Text is sanitised on render exactly like built-in text: only `**bold**` and
  `http(s)` links survive.

`database.rules.json` allows public read of `config/assistant_kb`
(`".read": true`) and restricts writes to superadmins. Remember that anything
published there is public — never put a pupil's name, a phone number or a key
in it.

## Unanswered questions

When Toye cannot answer, the question is pushed to `assistant_questions`
(`{text, createdAt, page}`), once per visit per question. Rules allow anyone to
*create* an entry and only superadmins to read them, so the list doubles as a
content backlog: whatever people keep asking for is the next entry to write.

## Verification

```bash
npm install                 # root test deps
npm test                    # 27/27 — assistant (23) + offline sync (4)
cd functions && npm test    # 25/25 — payment/offline cloud functions

npm install --no-save jsdom # dev-only, not persisted
node tests/assistant-dom.check.js   # 10/10 — real widget in jsdom
```

The DOM check loads the actual widget markup and page-layer script out of
`index.html`, then drives it: greeting, form submit, action buttons, a real
portal-button click, a `javascript:` navigation attempt, "tell me more", the
remembered topic surviving a reload, and chips on an unknown question.

## Naming and the photo

The name comes from `rsms-brand.js` (`assistantName`, defaulting to the brain's
`NAME`). The owner photo, when configured, appears in exactly two places, both
of them the bot: the floating button and the panel head. The RSMS "R" logo tile
and every other RSMS mark are left alone.
