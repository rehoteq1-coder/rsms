/* ═══════════════════════════════════════════════════════════
   RSMS ASSISTANT — landing-page helper brain
   -----------------------------------------------------------
   Pure logic, no DOM, no network. Safe to unit-test in Node
   (tests/rsms-assistant.test.js) and safe to load on any page.

   Usage (browser):
     var reply = RSMS_ASSISTANT.answer('how do I log in?');
     reply.entry          // matched KB entry (or null)
     reply.text           // answer text
     reply.html           // sanitised HTML for the answer
     reply.unanswered     // true when it fell back to suggestions
     reply.suggestions    // up to 3 follow-up entries (chips)

   The page layer (index.html) owns rendering and turns
   entry.actions[].act into real UI behaviour, so this file
   stays free of DOM/browser globals.
   ═══════════════════════════════════════════════════════════ */

(function (root, factory) {
  var api = factory();
  root.RSMS_ASSISTANT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* ── Text helpers ─────────────────────────────────────── */

  var STOPWORDS = ('a an and are as at be by can do does for from how i in is it me my of on or ' +
    'our so that the they this to we what when where which who why will with you your').split(' ');

  function normalize(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9\s/+-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(value) {
    var out = [];
    var words = normalize(value).split(' ');
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w || w.length < 3) continue;
      if (STOPWORDS.indexOf(w) !== -1) continue;
      if (out.indexOf(w) === -1) out.push(w);
    }
    return out;
  }

  /* ── Knowledge base ─────────────────────────────────────
     keywords  : phrases that should hit this entry
     answer    : plain text; **bold** and [label](https://…) allowed
     actions   : {label, act} — the page maps `act` to behaviour
     ─────────────────────────────────────────────────────── */

  var KB = [
    {
      id: 'hello',
      title: 'Say hello',
      keywords: ['hi', 'hey', 'hello', 'good morning', 'good afternoon', 'good evening', 'hiya'],
      answer: 'Hello! 👋 I am the RSMS assistant.\n\n' +
        'I can help you **sign in**, explain **results, fees and attendance**, tell you about ' +
        '**plans and pricing**, or point you to a **human** at Rehoteq.\n\n' +
        'What would you like to know?',
      actions: [
        { label: 'How do I sign in?', act: 'ask', value: 'how do I sign in' },
        { label: 'Talk to support', act: 'whatsapp' }
      ]
    },
    {
      id: 'login',
      title: 'Signing in',
      keywords: ['sign in', 'log in', 'login', 'signin', 'access portal', 'enter portal',
                 'find my school', 'school code', 'school id', 'how do i start', 'get started'],
      answer: 'Signing in takes four short steps:\n\n' +
        '1. **Find your school** — type its name in the search box.\n' +
        '2. **Pick your role** — Admin, Teacher, Bursar, Student, Parent and more.\n' +
        '3. **Pick your name** from the list that appears.\n' +
        '4. **Enter your PIN** and you are in.\n\n' +
        'On your school\'s own device the portal opens straight away — no internet needed.',
      actions: [{ label: 'Find my school', act: 'school' }]
    },
    {
      id: 'pin',
      title: 'Forgotten PIN',
      keywords: ['forgot pin', 'forgot password', 'lost pin', 'reset pin', 'reset password',
                 'change pin', 'change password', 'locked out', 'wrong pin', 'pin'],
      answer: 'Your PIN is issued by your school, so only your school admin can reset it.\n\n' +
        '• Ask your **school admin** to reset it from the Admin portal (Students / Staff → PIN).\n' +
        '• Or use the self-service **PIN reset** page and we will guide you.\n' +
        '• Still stuck? Message Rehoteq support on WhatsApp — we answer fast.',
      actions: [
        { label: 'Open PIN reset', act: 'pin' },
        { label: 'Message support', act: 'whatsapp' }
      ]
    },
    {
      id: 'roles',
      title: 'Portals & roles',
      keywords: ['role', 'portal', 'admin', 'teacher', 'class teacher', 'classteacher', 'bursar',
                 'hod', 'vp', 'principal', 'student', 'parent', 'account'],
      answer: 'Every role gets its own portal:\n\n' +
        '• **Admin** — school setup, staff, students, classes\n' +
        '• **Class Teacher** — remarks, promotion, attendance\n' +
        '• **Teacher / HOD / VP** — scores, approvals, subject oversight\n' +
        '• **Bursar** — fees, receipts, expenses, finance dashboard\n' +
        '• **Student & Parent** — results, fees, attendance, report cards\n\n' +
        'Pick the role that matches you on step 2 and the right portal opens.',
      actions: []
    },
    {
      id: 'results',
      title: 'Results & report cards',
      keywords: ['result', 'results', 'report card', 'score', 'scores', 'broadsheet', 'grade',
                 'grading', 'promotion', 'term', 'session', 'marksheet'],
      answer: 'Teachers enter Test 1–3 and Exam, RSMS totals and grades them automatically ' +
        '(**A 70+, B 60–69, C 50–59, D 40–49, F below 40**), then compiles:\n\n' +
        '• Class **broadsheets** (Excel or CSV)\n' +
        '• Printable **report cards** with remarks\n' +
        '• **Promotion lists** — promoted, trial, resit or repeat\n\n' +
        'Results entered offline sync to your school the moment the device reconnects.',
      actions: [{ label: 'Check a result', act: 'result' }]
    },
    {
      id: 'fees',
      title: 'Fees, payments & receipts',
      keywords: ['fee', 'fees', 'payment', 'pay', 'receipt', 'invoice', 'bursar', 'wallet',
                 'flutterwave', 'school fees', 'debt', 'balance', 'expense'],
      answer: 'The Bursar portal handles money end to end:\n\n' +
        '• Build a **fee structure** per class and term\n' +
        '• Record payments and print **receipts** instantly\n' +
        '• Parents can pay inline and the bursar gets an **alert** right away\n' +
        '• Track **expenses**, wallet balance and the live finance dashboard',
      actions: []
    },
    {
      id: 'attendance',
      title: 'Attendance & clock-in',
      keywords: ['attendance', 'absent', 'qr', 'qr code', 'scan', 'clock in', 'clock-in',
                 'staff clock', 'register', 'late'],
      answer: '• **Students** — QR scan or tap-in register, per class and per day.\n' +
        '• **Staff** — clock in and out from the staff clock; logs are exportable.\n' +
        '• Everything is per term and appears on the report card.',
      actions: []
    },
    {
      id: 'offline',
      title: 'Offline & install',
      keywords: ['offline', 'no internet', 'without internet', 'network', 'lan', 'install',
                 'install app', 'pwa', 'android', 'download', 'sync'],
      answer: 'RSMS is offline-first. You can enter scores, mark attendance and print receipts ' +
        'with **no internet**; data is kept on the device and syncs when a connection returns.\n\n' +
        'You can also install RSMS on your phone like a normal app — ' +
        'open the browser menu and choose **Install app** (or **Add to Home screen**).',
      actions: [{ label: 'Install RSMS', act: 'install' }]
    },
    {
      id: 'pricing',
      title: 'Plans & pricing',
      keywords: ['price', 'pricing', 'cost', 'how much', 'plan', 'plans', 'subscription',
                 'starter', 'standard', 'premium', 'enterprise', 'naira', 'pay for'],
      answer: 'RSMS runs on four plans — **Starter**, **Standard**, **Premium** and ' +
        '**Enterprise**. Each step unlocks more portals, finance automation and reporting.\n\n' +
        'AI Lesson Studio units are an Enterprise feature: the school gets a free pool of ' +
        'units each term and buys more in bulk when the pool runs out.\n\n' +
        'Tell us your school size and we will send a quote that fits.',
      actions: [{ label: 'Message support', act: 'whatsapp' }]
    },
    {
      id: 'onboarding',
      title: 'Onboard my school',
      keywords: ['onboard', 'onboarding', 'register school', 'sign up', 'signup', 'new school',
                 'join rsms', 'demo', 'trial', 'apply', 'get rsms'],
      answer: 'Onboarding is quick: we create your school, brand the portal with your logo, ' +
        'import your students and staff, then train your team.\n\n' +
        'Start from the application page and we will reach out the same day.',
      actions: [{ label: 'Apply for RSMS', act: 'apply' }]
    },
    {
      id: 'cbt',
      title: 'CBT exams',
      keywords: ['cbt', 'exam', 'exams', 'test', 'quiz', 'objective', 'question bank',
                 'computer based'],
      answer: 'The CBT module lets teachers build a question bank, schedule a computer-based ' +
        'test and score it automatically — results drop straight into the result sheet.',
      actions: []
    },
    {
      id: 'ai',
      title: 'AI tools',
      keywords: ['ai', 'artificial intelligence', 'lesson plan', 'lesson note', 'ai unit',
                 'ai units', 'lesson studio', 'voice ai', 'generate'],
      answer: '• **AI Lesson Studio** drafts lesson plans and notes from your scheme of work.\n' +
        '• **AI Guardian** watches for anomalies in fees and results.\n' +
        '• **Voice AI** lets staff log entries by speaking.\n\n' +
        'AI units are pooled per school and allocated to staff by the admin.',
      actions: []
    },
    {
      id: 'privacy',
      title: 'Data & privacy',
      keywords: ['privacy', 'data', 'secure', 'security', 'backup', 'who owns', 'gdpr',
                 'where is my data', 'firebase'],
      answer: 'Your school owns its data. Records are stored per school, scoped so only your ' +
        'school\'s users can reach them, and they sync to the cloud only when you are online. ' +
        'Admins can export everything at any time.',
      actions: []
    },
    {
      id: 'support',
      title: 'Talk to a human',
      keywords: ['human', 'agent', 'support', 'contact', 'help', 'phone', 'call', 'whatsapp',
                 'email', 'talk to someone'],
      answer: 'Rehoteq Technologies is right here in Okitipupa, Ondo State.\n\n' +
        '• **WhatsApp:** 0703 630 2585\n' +
        '• **Email:** rehoteq@gmail.com\n' +
        '• **Web:** [rehoteq.com](https://rehoteq.com)\n\n' +
        'Support is fastest on WhatsApp — send your school name and what went wrong.',
      actions: [
        { label: 'WhatsApp us', act: 'whatsapp' },
        { label: 'Email support', act: 'email' }
      ]
    }
  ];

  /* ── Scoring ──────────────────────────────────────────────
     Phrase hits weigh heaviest, then single-word overlap, then
     title words. Deterministic: ties keep the earlier entry.
     ─────────────────────────────────────────────────────── */

  function scoreEntry(entry, question, questionTokens) {
    if (!question) return 0;
    var score = 0;
    var i;

    var phrases = entry.keywords || [];
    for (i = 0; i < phrases.length; i++) {
      var phrase = normalize(phrases[i]);
      if (!phrase) continue;
      if (question.indexOf(phrase) !== -1) {
        // Longer phrases are more specific — reward them.
        score += 4 + Math.min(phrase.split(' ').length, 3);
      }
    }

    var haystack = normalize((entry.title || '') + ' ' + (entry.keywords || []).join(' '));
    for (i = 0; i < questionTokens.length; i++) {
      // Single-word hits in the keyword list count double so phrasings
      // like "reset my password" still find the PIN entry.
      if (haystack.indexOf(questionTokens[i]) !== -1) score += 2;
    }

    // Body text is a weak signal: only count distinctive words.
    var body = normalize(entry.answer || '');
    for (i = 0; i < questionTokens.length; i++) {
      var t = questionTokens[i];
      if (t.length >= 5 && body.indexOf(t) !== -1) score += 0.5;
    }
    return score;
  }

  function rank(question, list) {
    var q = normalize(question);
    var qTokens = tokens(q);
    var scored = [];
    for (var i = 0; i < list.length; i++) {
      scored.push({ entry: list[i], score: scoreEntry(list[i], q, qTokens), index: i });
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });
    return scored;
  }

  var THRESHOLD = 3; // a single phrase hit (4+) or several word hits

  function match(question, options) {
    var opts = options || {};
    var list = opts.kb || KB;
    var scored = rank(question, list);
    var top = scored[0];
    if (!top || top.score < THRESHOLD) return null;
    return top.entry;
  }

  function suggestions(question, options, count) {
    var opts = options || {};
    var scored = rank(question || '', opts.kb || KB);
    var out = [];
    var max = count || 3;
    for (var i = 0; i < scored.length && out.length < max; i++) {
      if (scored[i].score > 0) out.push(scored[i].entry);
    }
    if (!out.length) {
      // Nothing scored — offer the entries visitors ask for most.
      var fallbackIds = ['login', 'pin', 'support'];
      for (var j = 0; j < fallbackIds.length; j++) {
        var entry = byId(fallbackIds[j], opts.kb || KB);
        if (entry) out.push(entry);
      }
    }
    return out;
  }

  function byId(id, list) {
    var source = list || KB;
    for (var i = 0; i < source.length; i++) {
      if (source[i].id === id) return source[i];
    }
    return null;
  }

  /* ── Answering ────────────────────────────────────────── */

  function answer(question, options) {
    var opts = options || {};
    var text = String(question == null ? '' : question).trim();
    var entry = text ? match(text, opts) : null;

    if (entry) {
      return {
        entry: entry,
        text: entry.answer || '',
        html: safeRich(entry.answer || ''),
        actions: (entry.actions || []).slice(),
        unanswered: false,
        suggestions: []
      };
    }

    var fallbackText = text
      ? 'I do not have a solid answer for that yet. Here is what I can help with:'
      : 'Hi! I am the RSMS assistant. Ask me about signing in, results, fees, attendance, ' +
        'plans or anything else about the portal.';

    return {
      entry: null,
      text: fallbackText,
      html: safeRich(fallbackText),
      actions: [],
      unanswered: !!text,
      suggestions: suggestions(text, opts)
    };
  }

  /* ── Sanitising ───────────────────────────────────────────
     KB text (which admins can override from Firebase) is never
     trusted: escape everything, then re-allow only **bold** and
     [label](http(s)://…). No other markup survives.
     ─────────────────────────────────────────────────────── */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    var value = String(url || '').trim();
    return /^https?:\/\/[^\s<>"']+$/i.test(value) ? value : '';
  }

  function safeRich(text) {
    var escaped = escapeHtml(text);
    var linked = escaped.replace(/\[([^\]\n]{1,80})\]\(([^)\s]{1,300})\)/g, function (all, label, url) {
      var safe = safeUrl(String(url).replace(/&amp;/g, '&'));
      if (!safe) return label;
      return '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    return linked
      .replace(/\*\*([^*\n]{1,200})\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  /* ── Remote KB merge (optional, page supplies the data) ── */

  // Merges admin-authored entries from Firebase into the built-in KB.
  // Remote entries win on id conflict; junk entries are dropped.
  function mergeKb(remote) {
    if (!remote || typeof remote !== 'object') return KB.slice();
    var merged = KB.slice();
    var incoming = Array.isArray(remote) ? remote : Object.keys(remote).map(function (k) {
      return remote[k];
    });
    for (var i = 0; i < incoming.length; i++) {
      var item = incoming[i];
      if (!item || typeof item !== 'object') continue;
      var id = String(item.id || '').trim();
      var answerText = String(item.answer || item.text || '').trim();
      if (!id || !answerText) continue;
      var keywords = Array.isArray(item.keywords) ? item.keywords.filter(function (k) {
        return typeof k === 'string' && k.trim();
      }) : [];
      var entry = {
        id: id.slice(0, 64),
        title: String(item.title || id).slice(0, 80),
        keywords: keywords.length ? keywords.slice(0, 40) : normalize(id).split(' '),
        answer: answerText.slice(0, 2000),
        actions: []
      };
      var existing = byId(entry.id, merged);
      if (existing) merged[merged.indexOf(existing)] = entry;
      else merged.push(entry);
    }
    return merged;
  }

  return {
    KB: KB,
    THRESHOLD: THRESHOLD,
    normalize: normalize,
    tokens: tokens,
    match: match,
    answer: answer,
    suggestions: suggestions,
    byId: byId,
    safeRich: safeRich,
    safeUrl: safeUrl,
    mergeKb: mergeKb
  };
});
