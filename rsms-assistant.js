/* ═══════════════════════════════════════════════════════════
   RSMS ASSISTANT — landing-page helper brain ("Toye")
   -----------------------------------------------------------
   Pure logic, no DOM, no network. Safe to unit-test in Node
   (tests/rsms-assistant.test.js) and safe to load on any page.

   Usage (browser):
     var reply = RSMS_ASSISTANT.answer('how do I log in?', {lastTopic:'login'});
     reply.entry          // matched KB entry (or null)
     reply.text           // answer text
     reply.html           // sanitised HTML for the answer
     reply.unanswered     // true when it fell back to suggestions
     reply.more           // true when this is a "tell me more" expansion
     reply.suggestions    // up to 3 follow-up entries (chips)

   The page layer (index.html) owns rendering and turns
   entry.actions[].act into real UI behaviour, so this file
   stays free of DOM/browser globals.

   Navigation is data-driven: actions of {act:'go', value:'x.html'}
   are validated by safePortalTarget() here AND again in the page
   layer, because the knowledge base can be overridden from
   Firebase (config/assistant_kb) without a deploy. Only a plain
   local page is ever allowed through — optionally pinned to the
   demo school as x.html?school=<DEMO_SCHOOL.id>; a pin to any
   other school is refused.
   ═══════════════════════════════════════════════════════════ */

(function (root, factory) {
  var api = factory();
  root.RSMS_ASSISTANT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* ── Text helpers ─────────────────────────────────────── */

  var NAME = 'Toye';   // the assistant's name, used in greetings

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

  /* Light stemming. Deliberately conservative: long words only, so
     "printing" reaches "print" while "less" never becomes "les". */
  function stem(word) {
    var w = String(word == null ? '' : word);
    if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);
    if (w.length > 4 && /ers$/.test(w)) return w.slice(0, -1);
    if (w.length > 4 && /es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/(ss|us|is|as)$/.test(w)) return w.slice(0, -1);
    return w;
  }

  function stemText(value) {
    var words = normalize(value).split(' ');
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var s = stem(words[i]);
      if (s && s.length >= 3 && out.indexOf(s) === -1) out.push(s);
    }
    return out;
  }

  /* ── Synonyms ─────────────────────────────────────────────
     Visitors type one thing, the knowledge base says another.
     Each entry appends canonical wording to the question before
     scoring, so "signup" finds onboarding and "csv" finds the
     migration tool. Keys and values must already be normalised
     (lowercase, single spaces, no punctuation).
     ───────────────────────────────────────────────────────── */
  var SYNONYMS = {
    'signup': 'onboarding school',
    'sign up': 'onboarding school',
    'sign up my school': 'onboarding school',
    'register my school': 'onboarding school',
    'join rsms': 'onboarding school',
    'try it': 'demo school',
    'demo school': 'demo school',
    'csv': 'migration data',
    'excel': 'migration data',
    'spreadsheet': 'migration data',
    'import data': 'migration data',
    'move my data': 'migration data',
    'enrol': 'admission student',
    'enroll': 'admission student',
    'admission form': 'admission student',
    'application form': 'admission student',
    'new student': 'admission student',
    'access link': 'access links parent',
    'portal link': 'access links parent',
    'share link': 'access links parent',
    'how much': 'pricing cost',
    'how many naira': 'pricing cost',
    'password': 'pin',
    'not working': 'troubleshooting problem',
    'does not work': 'troubleshooting problem',
    'blank page': 'troubleshooting problem',
    'stuck': 'troubleshooting problem'
  };

  function expand(value) {
    var text = normalize(value);
    var keys = Object.keys(SYNONYMS);
    for (var i = 0; i < keys.length; i++) {
      if (text.indexOf(keys[i]) !== -1) text += ' ' + SYNONYMS[keys[i]];
    }
    return text;
  }

  /* ── Portals ──────────────────────────────────────────────
     The pages Toye is allowed to open. Targets are validated
     against PORTAL_TARGET_RE before the page layer navigates, so
     a tampered knowledge base cannot send a visitor to
     javascript:, //evil.example or a path outside the site.
     ───────────────────────────────────────────────────────── */
  var PORTAL_TARGET_RE = /^[a-z0-9-]+\.html$/;

  /* Toye lives on the public landing page, so every portal it opens
     is pinned to the demo school — a click lands inside Adetola
     Group of School with sample data, not on a cold, unconfigured
     portal. The pin is only ever the demo id: safePortalTarget()
     rejects a target pinned to any other school. */
  var DEMO_SCHOOL = { id: 'REH-2j8kq2xf', name: 'Adetola Group of School' };

  /* Pages that need a signed-in session. Sending a visitor there
     straight from the landing page lands them on a wall, so these
     route through the demo school's login instead. */
  var PRIVILEGED_PAGES = [
    'rsms-dashboard.html',
    'rsms-bursar.html',
    'rsms-links.html',
    'rsms-alerts.html',
    'rsms-reset.html'
  ];
  var LOGIN_GATE = 'rsms-login.html';

  var PRIVILEGED = (function () {
    var m = {};
    for (var i = 0; i < PRIVILEGED_PAGES.length; i++) m[PRIVILEGED_PAGES[i]] = true;
    return m;
  })();

  var PORTALS = {
    admission:  'rsms-apply.html',            // student application form
    onboarding: 'rsms-onboarding.html',       // school onboarding (6 steps)
    pin:        'rsms-reset.html',            // reset tool for a stuck school device
    result:     'rsms-results-print.html',    // result cards
    report:     'rsms-progress-report.html',  // KG & nursery progress report
    receipt:    'rsms-receipt.html',          // fee receipt generator
    feebook:    'rsms-bursar.html',           // bursar / fee book
    qr:         'rsms-qrcodes.html',          // QR ID cards
    links:      'rsms-links.html',            // parent & student access links
    timetable:  'rsms-timetable.html',
    analytics:  'rsms-analytics.html',
    cbt:        'rsms-cbt.html',
    migration:  'rsms-migrate.html',          // data migration tool
    demo:       'rsms-demo-setup.html',       // demo school setup
    attendance: 'rsms-attendance.html',
    alerts:     'rsms-alerts.html',           // parent alerts
    flyer:      'rsms-flier.html',
    dashboard:  'rsms-dashboard.html'
  };

  /* A plain page, or the same page pinned to the demo school — and
     nothing else. Extra parameters, a foreign school id, or any
     punctuation in either part all fail the match. */
  var PINNED_PORTAL_RE = /^([a-z0-9-]+\.html)(?:\?school=([A-Za-z0-9-]+))?$/;

  function safePortalTarget(value) {
    var target = String(value == null ? '' : value).trim();
    var pinned = PINNED_PORTAL_RE.exec(target);
    if (!pinned) return '';
    if (pinned[2] && pinned[2] !== DEMO_SCHOOL.id) return '';
    return target;
  }

  /* The navigation rule, in one place: privileged pages go through
     the login gate, everything else opens directly — always pinned
     to the demo school so the visitor sees a configured school. */
  function pinTarget(file) {
    var target = String(file == null ? '' : file);
    if (!target) return target;
    return (PRIVILEGED[target] ? LOGIN_GATE : target) + '?school=' + DEMO_SCHOOL.id;
  }

  function go(label, portalKey) {
    return { label: label, act: 'go', value: pinTarget(PORTALS[portalKey]) };
  }

  /* ── Knowledge base ─────────────────────────────────────
     keywords  : phrases that should hit this entry
     answer    : plain text; **bold** and [label](https://…) allowed
     more      : the "tell me more" expansion for the same entry
     actions   : {label, act} — the page maps `act` to behaviour
     ─────────────────────────────────────────────────────── */

  var KB = [
    {
      id: 'hello',
      title: 'Say hello',
      keywords: ['hi', 'hey', 'hello', 'good morning', 'good afternoon', 'good evening', 'hiya'],
      answer: 'Hello! 👋 I am Toye, the RSMS assistant.\n\n' +
        'I can help you **sign in**, explain **results, fees and attendance**, walk you through ' +
        '**onboarding, admission and data migration**, or point you to a **human** at Rehoteq.\n\n' +
        'What would you like to know?',
      more: 'You can ask me things like:\n\n' +
        '• "how do I sign in?"\n' +
        '• "my PIN was rejected"\n' +
        '• "can I print a report card?"\n' +
        '• "how do I move my school data?"\n' +
        '• "how much does RSMS cost?"\n\n' +
        'Say **more** after any answer and I will go deeper on the same topic.',
      actions: [
        { label: 'How do I sign in?', act: 'ask', value: 'how do I sign in' },
        { label: 'Talk to support', act: 'whatsapp' }
      ]
    },
    {
      id: 'identity',
      title: 'Who is Toye?',
      keywords: ['who are you', 'what is your name', 'your name', 'are you human', 'are you a robot',
                 'are you real', 'is this a bot', 'toye', 'adetoye', 'tope'],
      answer: 'I am **Toye**, the RSMS assistant for every school running Rehoteq School ' +
        'Management System.\n\n' +
        'I am not a person — think of me as a guide that knows the portal inside out: signing in, ' +
        'results, fees, attendance, onboarding, plans and pricing. Anything I cannot answer, I will ' +
        'happily hand to a human at Rehoteq.\n\n' +
        'So, what can I help you with?',
      more: 'I cannot see your school\'s data — I only explain how RSMS works and open the right ' +
        'page for you. Anything account-specific (a PIN, a payment, a student record) has to come ' +
        'from your school or from Rehoteq support.',
      actions: [{ label: 'Message a human', act: 'whatsapp' }]
    },
    {
      id: 'login',
      title: 'Signing in',
      keywords: ['sign in', 'log in', 'login', 'signin', 'access portal', 'enter portal',
                 'find my school', 'school code', 'school id', 'how do i start', 'get started'],
      answer: 'Signing in takes four short steps:\n\n' +
        '1. **Find your school** — type its name, or open the link or school code the school gave you.\n' +
        '2. **Pick your role** — Admin, Bursar, Teacher, Class Teacher, HOD, VP, Principal, Student or Parent.\n' +
        '3. **Pick your name** from the list that appears.\n' +
        '4. **Enter your PIN** and the portal opens.\n\n' +
        'On your school\'s own device the portal opens straight away — no internet needed.',
      more: 'Details worth knowing:\n\n' +
        '• Your **school code** looks like OND-SEC-0001; the school prints it on receipts and ID cards.\n' +
        '• A direct link already selects the school, so you start at your role.\n' +
        '• Staff use the PIN their admin issued; parents and students use the PIN that came with their access link.\n' +
        '• On a shared computer, sign out when you finish so the next person starts from step 1.',
      actions: [
        { label: 'Find my school', act: 'school' },
        go('Open the dashboard', 'dashboard')
      ]
    },
    {
      id: 'pin',
      title: 'Forgotten PIN',
      keywords: ['forgot pin', 'forgot password', 'lost pin', 'reset pin', 'reset password',
                 'change pin', 'change password', 'locked out', 'wrong pin', 'pin'],
      answer: 'Your PIN is issued by your school, so only your school can reset it.\n\n' +
        '• Ask your **school admin** to reset it: Admin portal → Students or Staff → open the record → set a new PIN.\n' +
        '• Parents and students get a fresh PIN from the **access link** the school generates.\n' +
        '• PINs are case-sensitive — check caps lock before you try again.',
      more: '• A PIN is 4–12 characters and belongs to one person in one school.\n' +
        '• The moment an admin resets it, the old PIN stops working.\n' +
        '• Staff at schools that use email sign-in reset access from the login screen instead of a PIN.\n' +
        '• On a shared school device that will not let anyone in, the reset tool rebuilds the local ' +
        'copy of the school data — that one is for the admin, not for students or parents.',
      actions: [
        go('Open the reset tool', 'pin'),
        { label: 'Message support', act: 'whatsapp' }
      ]
    },
    {
      id: 'roles',
      title: 'Portals & roles',
      keywords: ['role', 'portal', 'admin', 'teacher', 'class teacher', 'classteacher', 'bursar',
                 'hod', 'vp', 'principal', 'student', 'parent', 'account'],
      answer: 'Every role gets its own portal:\n\n' +
        '• **Admin** — school setup, students, staff, classes, access links\n' +
        '• **Class Teacher** — remarks, promotion, class attendance\n' +
        '• **Teacher / HOD / VP** — scores, approvals, subject oversight\n' +
        '• **Bursar** — fees, receipts, expenses, finance dashboard\n' +
        '• **Student & Parent** — results, fees, attendance, report cards\n\n' +
        'Pick the role that matches you on step 2 and the right portal opens.',
      more: '• One person can hold several roles — pick the one you need for the job in hand.\n' +
        '• Admins create, expire and deactivate logins from the portal passwords and access-links pages.\n' +
        '• Schools that turn on verified staff accounts can require email sign-in for finance roles ' +
        '(Admin and Bursar).',
      actions: [
        go('Open the dashboard', 'dashboard'),
        go('Open the timetable', 'timetable')
      ]
    },
    {
      id: 'results',
      title: 'Results & report cards',
      keywords: ['result', 'results', 'report card', 'score', 'scores', 'broadsheet', 'grade',
                 'grading', 'promotion', 'term', 'session', 'marksheet'],
      answer: 'Teachers enter Test 1–3 and Exam; RSMS totals, averages and grades automatically ' +
        '(**A 70+, B 60–69, C 50–59, D 40–49, F below 40**), then produces:\n\n' +
        '• Class **broadsheets** you can export\n' +
        '• Printable **report cards** with remarks and attendance\n' +
        '• **Promotion lists** — promoted, trial, resit or repeat\n\n' +
        'Results entered offline sync to the school the moment the device reconnects.',
      more: '• Scores are entered per class, subject and term by any teacher assigned to the class.\n' +
        '• HOD, VP or Principal approve the broadsheet before cards are printed.\n' +
        '• Result cards print two to four per sheet with the school logo, position and signature lines.\n' +
        '• KG and Nursery print a progress report instead of grades.\n' +
        '• Analytics turns the same scores into charts per class and per subject.',
      actions: [
        go('Print result cards', 'result'),
        go('KG progress report', 'report'),
        go('Open analytics', 'analytics')
      ]
    },
    {
      id: 'fees',
      title: 'Fees, payments & receipts',
      keywords: ['fee', 'fees', 'payment', 'pay', 'receipt', 'invoice', 'bursar', 'wallet',
                 'flutterwave', 'school fees', 'debt', 'balance', 'expense'],
      answer: 'The Bursar portal handles money end to end:\n\n' +
        '• Build a **fee structure** per class and term, with per-student charges and discounts\n' +
        '• Record cash, bank transfer, card or **wallet** payments and print a **receipt** instantly\n' +
        '• Parents can pay inline and the bursar gets an **alert** right away\n' +
        '• Track **expenses**, approvals and the live finance dashboard\n\n' +
        'Card payments are verified server-side, so a payment only counts once the gateway confirms it.',
      more: '• The ledger is append-only: a wrong entry is reversed, never deleted, and totals net to zero.\n' +
        '• Every payment carries a transaction ID (TX/2026/1/00001) and a receipt number (RCP/…).\n' +
        '• Parents can fund a wallet and pay fees from it; the bursar confirms wallet top-ups.\n' +
        '• Reconcile by filtering on class, method or date, then export.\n' +
        '• Cash and bank transfer work fully offline and sync later.',
      actions: [
        go('Open the fee book', 'feebook'),
        go('Print a receipt', 'receipt')
      ]
    },
    {
      id: 'attendance',
      title: 'Attendance & clock-in',
      keywords: ['attendance', 'absent', 'qr', 'qr code', 'scan', 'clock in', 'clock-in',
                 'staff clock', 'register', 'late'],
      answer: '• **Students** — mark the register per class and day, or scan a QR ID card.\n' +
        '• **Staff** — clock in and out from the staff clock; logs are exportable.\n' +
        '• Absences can trigger a **parent alert** the same day.\n' +
        '• Attendance feeds straight into the report card at the end of term.',
      more: '• QR ID cards are generated per student and print as a class sheet.\n' +
        '• Late arrivals and early departures are recorded with a timestamp.\n' +
        '• Export the register to CSV for inspection days or for the ministry.\n' +
        '• Staff clock logs drive the payroll view in the bursar portal.',
      actions: [
        go('Mark attendance', 'attendance'),
        go('QR ID cards', 'qr'),
        go('Parent alerts', 'alerts')
      ]
    },
    {
      id: 'offline',
      title: 'Offline & install',
      keywords: ['offline', 'no internet', 'without internet', 'network', 'lan', 'install',
                 'install app', 'pwa', 'android', 'download', 'sync'],
      answer: 'RSMS is offline-first. You can enter scores, mark attendance and print receipts ' +
        'with **no internet**; data is kept on the device and syncs when a connection returns.\n\n' +
        'A school that runs RSMS on its own PC can work fully offline over the school LAN — the ' +
        'server holds a queue of changes and pushes them to the cloud when it reconnects.\n\n' +
        'You can also install RSMS on your phone like a normal app — ' +
        'open the browser menu and choose **Install app** (or **Add to Home screen**).',
      more: '• Money records are never merged automatically: if two devices touched the same ' +
        'payment, the bursar reviews the conflict.\n' +
        '• Sync uses a per-school cursor, so only changed records move.\n' +
        '• The school server keeps nightly backups for seven days.\n' +
        '• Card payments are hidden offline — cash and bank transfer keep working and sync later.',
      actions: [{ label: 'Install RSMS', act: 'install' }]
    },
    {
      id: 'pricing',
      title: 'Plans & pricing',
      keywords: ['price', 'pricing', 'cost', 'how much', 'plan', 'plans', 'subscription',
                 'starter', 'standard', 'premium', 'enterprise', 'naira', 'pay for'],
      answer: 'RSMS runs on four plans — **Starter**, **Standard**, **Premium** and ' +
        '**Enterprise**. Each step unlocks more portals, finance automation and reporting, and ' +
        'onboarding is free to start.\n\n' +
        'AI Lesson Studio units are an Enterprise feature: the school gets a free pool of ' +
        'units each term and buys more in bulk when the pool runs out.\n\n' +
        'Tell us your school size and we will send a quote that fits.',
      more: '• Every plan includes the core portals, offline working and unlimited students.\n' +
        '• Standard adds the finance platform, parent alerts and reporting.\n' +
        '• Premium adds analytics, CBT and the AI tools.\n' +
        '• Enterprise adds the local LAN server, full branding and a dedicated onboarding team.',
      actions: [
        { label: 'Message support', act: 'whatsapp' },
        go('See the flier', 'flyer')
      ]
    },
    {
      id: 'onboarding',
      title: 'Onboard my school',
      keywords: ['onboard', 'onboarding', 'register school', 'sign up', 'signup', 'new school',
                 'join rsms', 'demo', 'trial', 'apply', 'get rsms'],
      answer: 'Onboarding runs through six short steps:\n\n' +
        '1. **School info** — name, address, contacts\n' +
        '2. **Sections** — Creche/Nursery, Primary, Secondary\n' +
        '3. **Streams** — per class (for example A, B, C)\n' +
        '4. **Plan** — Starter, Standard, Premium or Enterprise\n' +
        '5. **Logo & MOU**\n' +
        '6. **Submit** — we review and set the school up\n\n' +
        'Rather look first? Ask for a **demo school** and click through every portal with sample data.',
      more: '• After you submit, Rehoteq creates the school, brands the portal with your logo and ' +
        'colours, and issues the school code and admin token.\n' +
        '• We import your existing students and staff from a CSV or spreadsheet.\n' +
        '• Training is included — a short session for the admin, the teachers and the bursar.',
      actions: [
        go('Onboard my school', 'onboarding'),
        go('Try the demo', 'demo'),
        go('See the flier', 'flyer')
      ]
    },
    {
      id: 'admission',
      title: 'Student admission',
      // Keywords carry the parents' vocabulary too — people ask about
      // "my child", not about "admission processes".
      keywords: ['admission', 'admit', 'admitted', 'enrol', 'enroll', 'application form',
                 'admission form', 'new student', 'register a student', 'apply for admission',
                 'put my child', 'my son', 'my daughter', 'transfer my child',
                 'get my child into', 'join the school', 'start school'],
      answer: 'Parents apply from the **application form** in five steps:\n\n' +
        '1. School and class applying for\n' +
        '2. Student details and passport photograph\n' +
        '3. Previous school or transfer details\n' +
        '4. Parents, guardian and emergency contacts\n' +
        '5. Documents — birth certificate, last result, transfer letter, parent ID — and the declaration\n\n' +
        'On submission the applicant is given a reference number to quote when the school follows up.',
      more: '• The form works on a phone; the passport photo is compressed before it is stored.\n' +
        '• Transfer students fill in the previous school and the reason for leaving.\n' +
        '• Boarding, medical notes and certificates can be added in step 3.\n' +
        '• Schools can also admit a student directly from the Admin portal without the online form.',
      actions: [go('Open the admission form', 'admission')]
    },
    {
      id: 'migration',
      title: 'Data migration',
      keywords: ['migration', 'migrate', 'csv', 'excel', 'import', 'import data', 'transfer data',
                 'move data', 'spreadsheet', 'push to firebase', 'publish branding', 'school id'],
      answer: 'The **data migration tool** moves a school onto RSMS without retyping anything:\n\n' +
        '1. **Connect Firebase** — or work from data already on the device\n' +
        '2. Review **data on this device** — students, staff, scores, fees\n' +
        '3. **Push to Firebase** to publish the school to the cloud\n' +
        '4. **Publish school branding** so every portal picks up the logo and colours\n' +
        '5. Set the **school ID** by hand if a device lost it\n\n' +
        'Coming from another system? Export to CSV or Excel and we map the columns for you.',
      more: '• Migration is per school — records are never merged across schools.\n' +
        '• Imported payments are historical: they are never auto-edited afterwards.\n' +
        '• Run it on the device that already holds the data, check the counts, then push.\n' +
        '• Branding is public read data: logo, colours, motto and the school name shown at login.',
      actions: [go('Open the migration tool', 'migration')]
    },
    {
      id: 'access',
      title: 'Parent & student access links',
      keywords: ['access link', 'portal link', 'share link', 'parent link', 'student link',
                 'send link', 'invite parent', 'parent access', 'student access', 'expiry'],
      answer: 'The Admin portal generates a **link per person**:\n\n' +
        '1. Choose the **role** — Parent, Student or Staff\n' +
        '2. Pick the **person** from the list\n' +
        '3. Optionally set an **expiry date** and add a note\n' +
        '4. Send it by **WhatsApp** or copy the link\n\n' +
        'Opening the link takes the person straight to their portal — school and role already ' +
        'selected — so they only need their PIN. Links can be deactivated at any time.',
      more: '• Parents see only their own children; students see only their own record.\n' +
        '• An expiring link is handy for a one-off result check.\n' +
        '• Lost link or changed phone number? The admin re-generates it — nothing is lost.\n' +
        '• Deactivating a link blocks the portal immediately but keeps the student\'s records.',
      actions: [go('Manage access links', 'links')]
    },
    {
      id: 'troubleshooting',
      title: 'Something is not working',
      keywords: ['not working', 'does not work', 'error', 'problem', 'issue', 'fix', 'broken',
                 'blank page', 'stuck', 'failed', 'fails', 'slow', 'crash', 'trouble',
                 'cannot', 'nothing happens', 'help me fix'],
      answer: 'Quick fixes for the usual problems:\n\n' +
        '• **Blank or stuck page** — refresh, try Chrome or Edge, and check you are online.\n' +
        '• **My school does not appear** — check the spelling, or ask the school for its direct link ' +
        'or school code.\n' +
        '• **PIN rejected** — ask your school admin to reset it; PINs are case-sensitive.\n' +
        '• **Nothing syncs** — the device needs one successful connection; leave it online for a minute.\n' +
        '• **Payment still pending** — card payments only count once the gateway confirms them.\n\n' +
        'Still stuck? Send your school name, your role and what you see.',
      more: '• On a shared school PC, sign out between users so the next person starts at step 1.\n' +
        '• If a page looks broken right after an update, clear the site data in the browser and reload.\n' +
        '• Admins: the reset tool rebuilds a school\'s local copy of data on a stuck device.\n' +
        '• Persistent sync problems usually mean the device clock or the school ID is wrong.',
      actions: [
        { label: 'Message support', act: 'whatsapp' },
        go('Open the reset tool', 'pin')
      ]
    },
    {
      id: 'cbt',
      title: 'CBT exams',
      keywords: ['cbt', 'exam', 'exams', 'test', 'quiz', 'objective', 'question bank',
                 'computer based'],
      answer: 'The CBT module lets teachers build a **question bank** per subject, schedule a ' +
        'computer-based test and score it automatically — results drop straight into the result sheet.\n\n' +
        'Questions are reused across terms, shuffled per student and timed per test.',
      more: '• Add questions one by one or in bulk from the question-bank page.\n' +
        '• Set duration, number of questions and pass mark per test.\n' +
        '• Scores export to the broadsheet, so nothing is typed twice.',
      actions: [go('Open CBT', 'cbt')]
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
      more: '• Each school gets a free pool of units every term and buys more in bulk.\n' +
        '• Lesson notes follow your scheme of work, week and duration, and stay editable.\n' +
        '• AI suggestions never overwrite what a teacher typed.',
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
      more: '• Portals are role-scoped: a parent sees only their children, a teacher only their classes.\n' +
        '• Deleting a school is an explicit admin action — never a side effect of a sync.\n' +
        '• Corrections keep history: a wrong money entry is reversed, not erased.\n' +
        '• The school server keeps seven nights of local backups when it runs in LAN mode.',
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
      more: '• Include your **school name**, your **role** and a screenshot if you can get one.\n' +
        '• WhatsApp is answered during school hours (WAT).\n' +
        '• For pricing or onboarding, mention your student count and how many branches you run.',
      actions: [
        { label: 'WhatsApp us', act: 'whatsapp' },
        { label: 'Email support', act: 'email' }
      ]
    }
  ];

  /* ── Scoring ──────────────────────────────────────────────
     Phrase hits weigh heaviest, then single-word overlap, then
     stemmed overlap, then title words. Deterministic: ties keep
     the earlier entry.
     ─────────────────────────────────────────────────────── */

  function scoreEntry(entry, question, questionTokens, questionStems) {
    if (!question) return 0;
    var score = 0;
    var i;

    // Phrases are padded with spaces and matched with spaces around
    // them, so "hi" answers a greeting but never fires inside
    // c-hi-ld: a keyword phrase must match whole words in the question.
    var padded = ' ' + question + ' ';
    var phrases = entry.keywords || [];
    for (i = 0; i < phrases.length; i++) {
      var phrase = normalize(phrases[i]);
      if (!phrase) continue;
      if (padded.indexOf(' ' + phrase + ' ') !== -1) {
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

    // Stemmed overlap catches "printing" → "print", "paying" → "pay".
    var stemHay = ' ' + stemText(haystack).join(' ') + ' ';
    for (i = 0; i < questionStems.length; i++) {
      if (stemHay.indexOf(' ' + questionStems[i] + ' ') !== -1) score += 1.5;
    }

    // Body text is a weak signal: only count distinctive words.
    var body = normalize((entry.answer || '') + ' ' + (entry.more || ''));
    for (i = 0; i < questionTokens.length; i++) {
      var t = questionTokens[i];
      if (t.length >= 5 && body.indexOf(t) !== -1) score += 0.5;
    }
    return score;
  }

  function rank(question, list) {
    var q = expand(question);
    var qTokens = tokens(q);
    var qStems = stemText(q);
    var scored = [];
    for (var i = 0; i < list.length; i++) {
      scored.push({ entry: list[i], score: scoreEntry(list[i], q, qTokens, qStems), index: i });
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

  /* ── "Tell me more" ─────────────────────────────────────
     Follow-ups are handled by the caller: the page remembers the
     last answered entry (lastTopic) and passes it back in, so
     "more" deepens the same topic instead of starting over.
     ─────────────────────────────────────────────────────── */

  var MORE_WORDS = ('more tell explain expand detail details deeper further continue else again ' +
    'info information what about that please pls bit little some on go me it know need want').split(' ');

  function isMoreRequest(value) {
    var words = normalize(value).split(' ').filter(Boolean);
    if (!words.length) return false;
    var hits = 0;
    for (var i = 0; i < words.length; i++) {
      if (MORE_WORDS.indexOf(words[i]) !== -1) hits++;
    }
    return hits > 0 && hits === words.length;
  }

  /* ── Answering ────────────────────────────────────────── */

  function answer(question, options) {
    var opts = options || {};
    var text = String(question == null ? '' : question).trim();
    var entry = text ? match(text, opts) : null;

    // A follow-up ("tell me more") deepens the last topic when we have one.
    if (isMoreRequest(text)) {
      var topic = opts.lastTopic ? byId(opts.lastTopic, opts.kb || KB) : null;
      if (topic && topic.more) {
        return {
          entry: topic,
          text: topic.more,
          html: safeRich(topic.more),
          actions: (topic.actions || []).slice(),
          unanswered: false,
          more: true,
          suggestions: []
        };
      }
      if (!topic) {
        var prompt = 'Happy to — which topic should I go deeper on? Ask me about signing in, ' +
          'results, fees, attendance, onboarding, admission or pricing.';
        return {
          entry: null,
          text: prompt,
          html: safeRich(prompt),
          actions: [],
          unanswered: false,
          more: true,
          suggestions: suggestions('', opts)
        };
      }
      // Topic known but it has no expansion — fall through to a normal answer.
    }

    if (entry) {
      return {
        entry: entry,
        text: entry.answer || '',
        html: safeRich(entry.answer || ''),
        actions: (entry.actions || []).slice(),
        unanswered: false,
        more: false,
        suggestions: []
      };
    }

    var fallbackText = text
      ? 'I do not have a solid answer for that yet. Here is what I can help with:'
      : 'Hi! I am Toye, the RSMS assistant. Ask me about signing in, results, fees, attendance, ' +
        'plans or anything else about the portal.';

    return {
      entry: null,
      text: fallbackText,
      html: safeRich(fallbackText),
      actions: [],
      unanswered: !!text,
      more: false,
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
  // Remote `more` text is allowed (it is sanitised like everything
  // else) but remote actions are not: navigation stays code-owned.
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
        more: String(item.more || '').slice(0, 2000),
        actions: []
      };
      var existing = byId(entry.id, merged);
      if (existing) merged[merged.indexOf(existing)] = entry;
      else merged.push(entry);
    }
    return merged;
  }

  return {
    NAME: NAME,
    KB: KB,
    PORTALS: PORTALS,
    PORTAL_TARGET_RE: PORTAL_TARGET_RE,
    DEMO_SCHOOL: DEMO_SCHOOL,
    PRIVILEGED_PAGES: PRIVILEGED_PAGES,
    LOGIN_GATE: LOGIN_GATE,
    THRESHOLD: THRESHOLD,
    SYNONYMS: SYNONYMS,
    normalize: normalize,
    tokens: tokens,
    stem: stem,
    expand: expand,
    match: match,
    answer: answer,
    suggestions: suggestions,
    byId: byId,
    isMoreRequest: isMoreRequest,
    safeRich: safeRich,
    safeUrl: safeUrl,
    safePortalTarget: safePortalTarget,
    pinTarget: pinTarget,
    mergeKb: mergeKb
  };
});
