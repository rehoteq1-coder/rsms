// ═══════════════════════════════════════════════════
// RSMS CORE — Shared utilities for all portals
// ═══════════════════════════════════════════════════

// ── AUTH ──
var RSMS = RSMS || {};

RSMS.auth = {
  // Check token in URL or sessionStorage
  init: function(requiredRole) {
    var params = new URLSearchParams(window.location.search);
    var token = params.get('token');
    if (token) {
      var tokens = JSON.parse(localStorage.getItem('rsms_access_tokens') || '{}');
      var td = tokens[token];
      if (td && td.active) {
        sessionStorage.setItem('rsms_user', JSON.stringify(td.user));
        sessionStorage.setItem('rsms_role', td.role);
        sessionStorage.setItem('rsms_auth', 'true');
        // Clean URL
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
    var user = JSON.parse(sessionStorage.getItem('rsms_user') || 'null');
    var role = sessionStorage.getItem('rsms_role') || '';
    var auth = sessionStorage.getItem('rsms_auth') === 'true';
    // Admin can access any portal
    var adminAuth = role === 'admin' || role === 'superadmin';
    if (!auth) {
      window.location.replace('rsms-login.html');
      return null;
    }
    if (requiredRole && role !== requiredRole && !adminAuth) {
      window.location.replace('rsms-login.html');
      return null;
    }
    return { user: user, role: role };
  },

  user: function() { return JSON.parse(sessionStorage.getItem('rsms_user') || '{}'); },
  role: function() { return sessionStorage.getItem('rsms_role') || ''; },

  logout: function() {
    sessionStorage.removeItem('rsms_auth');
    sessionStorage.removeItem('rsms_user');
    sessionStorage.removeItem('rsms_role');
    window.location.href = 'rsms-login.html';
  }
};

// ── DATA ──
RSMS.db = {
  get: function(key, def) {
    try { return JSON.parse(localStorage.getItem('rsms_' + key) || 'null') || def; }
    catch(e) { return def; }
  },
  set: function(key, val) {
    localStorage.setItem('rsms_' + key, JSON.stringify(val));
  },
  school:    function() { return RSMS.db.get('school', {name:'School', term:'First Term', session:'2025/2026'}); },
  students:  function() { return RSMS.db.get('students', []); },
  staff:     function() { return RSMS.db.get('staff', []); },
  fees:      function() { return RSMS.db.get('fees', []); }
};

// ── SUBJECTS ──
RSMS.subjects = {
  JSS: ["English Language","Mathematics","Basic Science & Technology","Social Studies",
    "Civic Education","Cultural & Creative Arts","Physical & Health Education",
    "Computer Studies/ICT","Agricultural Science","Home Economics","Business Studies",
    "French Language","Yoruba Language","Christian Religious Studies",
    "Islamic Religious Studies","Security Education","Basic Technology"],
  SS_SCIENCE: ["English Language","Mathematics","Physics","Chemistry","Biology",
    "Further Mathematics","Agricultural Science","Computer Studies","Technical Drawing",
    "Food & Nutrition","Christian Religious Studies","Islamic Religious Studies",
    "Civic Education","Physical & Health Education","Yoruba Language"],
  SS_COMMERCIAL: ["English Language","Mathematics","Economics","Commerce","Accounting",
    "Business Studies","Office Practice","Computer Studies","Salesmanship",
    "Christian Religious Studies","Islamic Religious Studies",
    "Civic Education","Physical & Health Education","Yoruba Language","Literature in English"],
  SS_ARTS: ["English Language","Mathematics","Literature in English","Government","History",
    "Christian Religious Studies","Islamic Religious Studies","Yoruba Language",
    "French Language","Fine Arts","Music","Geography","Economics",
    "Civic Education","Physical & Health Education"],
  PRIMARY: ["English Language","Mathematics","Basic Science","Social Studies",
    "Civic Education","Cultural & Creative Arts","Physical & Health Education",
    "Computer Studies","Agricultural Science","Home Economics","Yoruba Language",
    "Christian Religious Studies","Islamic Religious Studies",
    "Verbal Reasoning","Quantitative Reasoning"],

  forClass: function(cls) {
    var c = (cls || '').toLowerCase();
    if (c.includes('science'))    return RSMS.subjects.SS_SCIENCE;
    if (c.includes('commercial')) return RSMS.subjects.SS_COMMERCIAL;
    if (c.includes('art'))        return RSMS.subjects.SS_ARTS;
    if (c.includes('ss ') || c.includes('senior') || c.startsWith('ss'))
                                   return RSMS.subjects.SS_SCIENCE;
    if (c.includes('primary'))    return RSMS.subjects.PRIMARY;
    return RSMS.subjects.JSS;
  },

  fill: function(selId, cls, selected) {
    var sel = document.getElementById(selId);
    if (!sel) return;
    var list = RSMS.subjects.forClass(cls);
    sel.innerHTML = '<option value="">— Select Subject —</option>' +
      list.map(function(s) {
        return '<option value="' + s + '"' + (s === selected ? ' selected' : '') + '>' + s + '</option>';
      }).join('');
  }
};

// ── UI ──
RSMS.ui = {
  _toastTimer: null,
  toast: function(msg, type) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.className = 'toast show toast-' + (type || 'i');
    el.textContent = msg;
    clearTimeout(RSMS.ui._toastTimer);
    RSMS.ui._toastTimer = setTimeout(function() { el.classList.remove('show'); }, 3500);
  },
  openModal: function(id) { document.getElementById(id).classList.add('open'); },
  closeModal: function(id) { document.getElementById(id).classList.remove('open'); },

  initSidebar: function() {
    var sb    = document.getElementById('sidebar');
    var ov    = document.getElementById('sb-overlay');
    var mbtn  = document.getElementById('menu-btn');
    if (!sb) return;
    if (mbtn) mbtn.onclick = function() {
      sb.classList.toggle('open');
      if (ov) ov.classList.toggle('show');
    };
    if (ov) ov.onclick = function() {
      sb.classList.remove('open');
      ov.classList.remove('show');
    };
  },

  showPage: function(name, el) {
    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
    var pg = document.getElementById('pg-' + name);
    if (pg) pg.classList.add('active');
    document.querySelectorAll('.sbi').forEach(function(s) { s.classList.remove('active'); });
    if (el) el.classList.add('active');
    // Close sidebar on mobile
    var sb = document.getElementById('sidebar');
    var ov = document.getElementById('sb-overlay');
    if (sb) sb.classList.remove('open');
    if (ov) ov.classList.remove('show');
    return pg;
  },

  setTopbar: function(icon, title) {
    var ti = document.getElementById('tb-icon');
    var tt = document.getElementById('tb-title');
    if (ti) ti.textContent = icon || '';
    if (tt) tt.textContent = title || '';
  },

  avatar: function(name) {
    return (name || '?').charAt(0).toUpperCase();
  },

  fillSelect: function(selId, items, emptyLabel) {
    var sel = document.getElementById(selId);
    if (!sel) return;
    sel.innerHTML = '<option value="">' + (emptyLabel || '— Select —') + '</option>' +
      items.map(function(i) {
        if (typeof i === 'string') return '<option value="' + i + '">' + i + '</option>';
        return '<option value="' + i.v + '">' + i.l + '</option>';
      }).join('');
  }
};

// ── WORKFLOW ──
RSMS.workflow = {
  TYPES: { plan:'lesson_plans', note:'lesson_notes', exam:'exam_questions' },
  STATUS: {
    draft:     { label:'Draft',         cls:'status-draft' },
    submitted: { label:'Submitted',     cls:'status-submitted' },
    reviewed:  { label:'HOD Reviewed',  cls:'status-reviewed' },
    approved:  { label:'VP Approved ✅',cls:'status-approved' },
    returned:  { label:'Returned ↩',   cls:'status-returned' }
  },
  badge: function(status) {
    var s = RSMS.workflow.STATUS[status] || RSMS.workflow.STATUS.draft;
    return '<span class="badge ' + s.cls + '">' + s.label + '</span>';
  },
  get: function(type) {
    return RSMS.db.get(RSMS.workflow.TYPES[type], []);
  },
  save: function(type, docs) {
    RSMS.db.set(RSMS.workflow.TYPES[type], docs);
  },
  upsert: function(type, doc) {
    var all = RSMS.workflow.get(type);
    var idx = all.findIndex(function(d) { return d.id === doc.id; });
    if (idx > -1) all[idx] = doc; else all.push(doc);
    RSMS.workflow.save(type, all);
    return doc;
  },
  action: function(type, docId, status, note, byUser) {
    var all = RSMS.workflow.get(type);
    var idx = all.findIndex(function(d) { return d.id === docId; });
    if (idx < 0) return null;
    all[idx].status = status;
    all[idx].lastNote = note || '';
    all[idx].lastActionBy = (byUser && byUser.name) || 'Unknown';
    all[idx].lastActionAt = new Date().toISOString();
    all[idx].history = all[idx].history || [];
    all[idx].history.push({ status:status, by:all[idx].lastActionBy, at:all[idx].lastActionAt, note:note });
    RSMS.workflow.save(type, all);
    return all[idx];
  },
  pendingForHOD: function() {
    var n = 0;
    ['plan','note','exam'].forEach(function(t) {
      n += RSMS.workflow.get(t).filter(function(d) { return d.status === 'submitted'; }).length;
    });
    return n;
  },
  pendingForVP: function() {
    var n = 0;
    ['plan','note','exam'].forEach(function(t) {
      n += RSMS.workflow.get(t).filter(function(d) { return d.status === 'reviewed'; }).length;
    });
    return n;
  }
};

// ── LESSON AI UNITS ──
RSMS.lessonAI = {
  URL: 'https://rehoteq.com/lesson-ai.html',
  UNITS_PER_TERM: 10,
  buildGiftLink: function(teacher) {
    var raw = (teacher.id || '') + '|' + (teacher.email || teacher.name) + '|' + Date.now();
    var token = btoa(unescape(encodeURIComponent(raw))).replace(/[^a-zA-Z0-9]/g,'').slice(0,20);
    var email = encodeURIComponent(teacher.email || teacher.name + '@rsms');
    return RSMS.lessonAI.URL + '?rsms_gift=' + token + '&units=' + RSMS.lessonAI.UNITS_PER_TERM + '&teacher=' + email;
  },
  giftAllTeachers: function() {
    var school = RSMS.db.school();
    var staff  = RSMS.db.staff();
    var isEnt  = (school.plan || '').toLowerCase() === 'enterprise';
    if (!isEnt) return { ok:false, msg:'Only Enterprise plan schools can gift Lesson AI units.' };
    var term = school.term || 'First Term';
    var session = school.session || '2025/2026';
    var key = 'lesson_gifts';
    var gifts = RSMS.db.get(key, []);
    var giftId = term + '_' + session;
    if (gifts.indexOf(giftId) > -1) return { ok:false, msg:'Already gifted for ' + term + ' ' + session };
    var teachers = staff.filter(function(s) {
      var r = (s.role || '').toLowerCase();
      return r.includes('teacher') || r.includes('hod') || r.includes('principal');
    });
    gifts.push(giftId);
    RSMS.db.set(key, gifts);
    return { ok:true, count:teachers.length, teachers:teachers, term:term };
  }
};

// ── LINK GENERATOR ──
RSMS.links = {
  BASE: 'https://rsms.rehoteq.com/',
  PORTALS: {
    admin:'rsms-admin.html', bursar:'rsms-bursar.html',
    teacher:'rsms-teacher.html', classteacher:'rsms-classteacher.html',
    hod:'rsms-hod.html', vp:'rsms-vp.html',
    student:'rsms-student.html', parent:'rsms-parent.html',
    security:'rsms-clock.html'
  },
  ROLE_PORTAL: {
    'Class Teacher':'classteacher', 'Subject Teacher':'teacher',
    'HOD':'hod', 'Vice Principal Academic':'vp', 'Vice Principal Admin':'vp',
    'Bursar':'bursar', 'Admin Staff':'admin', 'Security':'security',
    'Librarian':'teacher', 'Teacher':'teacher'
  },
  token: function(id, role) {
    return btoa(unescape(encodeURIComponent(id + '|' + role + '|' + RSMS.db.school().schoolId)))
      .replace(/[^a-zA-Z0-9]/g,'').slice(0,18);
  },
  registerAll: function() {
    var tokens = RSMS.db.get('access_tokens', {});
    RSMS.db.staff().forEach(function(s) {
      var roleCode = RSMS.links.ROLE_PORTAL[s.role] || 'teacher';
      var tk = RSMS.links.token(s.id, s.role);
      tokens[tk] = { role:roleCode, user:{name:s.name, email:s.email||'', role:s.role, staffId:s.staffId}, active:true, id:s.id };
    });
    RSMS.db.students().forEach(function(s) {
      var tk = RSMS.links.token(s.id, 'student');
      tokens[tk] = { role:'student', user:{name:(s.surname||'')+' '+(s.firstname||''), reg:s.reg, class:s.class, role:'student', id:s.id}, active:true, id:s.id };
      var ptk = RSMS.links.token(s.id + '_parent', 'parent');
      tokens[ptk] = { role:'parent', user:{name:'Parent of '+(s.surname||''), child:s.id, childName:(s.surname||'')+' '+(s.firstname||''), role:'parent'}, active:true };
    });
    RSMS.db.set('access_tokens', tokens);
    return tokens;
  },
  forStaff: function(s) {
    var rc = RSMS.links.ROLE_PORTAL[s.role] || 'teacher';
    var tk = RSMS.links.token(s.id, s.role);
    return RSMS.links.BASE + (RSMS.links.PORTALS[rc] || 'rsms-teacher.html') + '?token=' + tk;
  },
  forStudent: function(s) {
    return RSMS.links.BASE + 'rsms-student.html?token=' + RSMS.links.token(s.id, 'student');
  },
  forParent: function(s) {
    return RSMS.links.BASE + 'rsms-parent.html?token=' + RSMS.links.token(s.id + '_parent', 'parent');
  }
};

// ── HELPERS ──
RSMS.fmt = {
  money: function(n) { return '₦' + (parseFloat(n)||0).toLocaleString('en-NG',{minimumFractionDigits:2}); },
  date:  function(d) { return d ? new Date(d).toLocaleDateString('en-NG') : '—'; },
  name:  function(s) { return ((s.surname||'') + ' ' + (s.firstname||'')).trim(); },
  initials: function(name) { return (name||'?').split(' ').map(function(w){return w[0]||'';}).join('').slice(0,2).toUpperCase(); }
};

console.log('[RSMS Core] loaded');
// ── WORKFLOW ENGINE ───────────────────────────────────
var WF = {
  getAll: function(type){ return JSON.parse(localStorage.getItem('rsms_wf_'+type)||'[]'); },
  saveAll: function(type,data){ localStorage.setItem('rsms_wf_'+type,JSON.stringify(data)); },
  STATUS: {
    draft:        {label:'Draft',     cls:'bg-gray'},
    submitted:    {label:'Submitted', cls:'bg-teal'},
    hod_reviewed: {label:'HOD OK',    cls:'bg-gold'},
    vp_approved:  {label:'VP Approved',cls:'bg-green'},
    returned:     {label:'Returned',  cls:'bg-red'}
  },
  badge: function(status){
    var s=WF.STATUS[status]||WF.STATUS.draft;
    return '<span class="badge '+s.cls+'" style="font-size:.6rem;">'+s.label+'</span>';
  },
  submit: function(type, doc){
    var all=WF.getAll(type);
    doc.id = doc.id||('wf'+Date.now()+Math.random().toString(36).slice(2,6));
    doc.status='submitted';
    doc.submittedAt=new Date().toISOString();
    doc.history=doc.history||[];
    doc.history.push({action:'submitted',by:doc.by,at:new Date().toISOString()});
    var i=all.findIndex(function(d){return d.id===doc.id;});
    if(i>-1) all[i]=doc; else all.push(doc);
    WF.saveAll(type,all);
    return doc;
  },
  review: function(type, id, action, note, by){
    var all=WF.getAll(type);
    var i=all.findIndex(function(d){return d.id===id;}); if(i<0)return false;
    all[i].status = action==='approve'?'hod_reviewed':'returned';
    all[i].hodNote=note; all[i].hodBy=by; all[i].hodAt=new Date().toISOString();
    all[i].history=all[i].history||[];
    all[i].history.push({action:all[i].status,by:by,at:new Date().toISOString(),note:note});
    WF.saveAll(type,all); return all[i];
  },
  vpApprove: function(type, id, action, note, by){
    var all=WF.getAll(type);
    var i=all.findIndex(function(d){return d.id===id;}); if(i<0)return false;
    all[i].status = action==='approve'?'vp_approved':'returned';
    all[i].vpNote=note; all[i].vpBy=by; all[i].vpAt=new Date().toISOString();
    all[i].history=all[i].history||[];
    all[i].history.push({action:all[i].status,by:by,at:new Date().toISOString(),note:note});
    WF.saveAll(type,all); return all[i];
  },
  pending: function(role){
    var count=0;
    ['plans','notes','exams'].forEach(function(t){
      var all=WF.getAll(t);
      if(role==='hod') count+=all.filter(function(d){return d.status==='submitted';}).length;
      if(role==='vp')  count+=all.filter(function(d){return d.status==='hod_reviewed';}).length;
    });
    return count;
  }
};

// ── LESSON AI UNITS ───────────────────────────────────
var LESSON_AI = {
  URL: 'https://rehoteq.com/lesson-ai.html',
  UNITS_PER_TERM: 10,
  giftLink: function(teacher){
    var token = btoa((teacher.id||teacher.name)+'|'+(teacher.email||'')+'|'+Date.now())
                  .replace(/[^a-zA-Z0-9]/g,'').slice(0,20);
    var email = encodeURIComponent(teacher.email||(teacher.name.replace(/\s+/g,''))+'@rsms.school');
    return LESSON_AI.URL+'?rsms_gift='+token+'&units='+LESSON_AI.UNITS_PER_TERM+'&teacher='+email;
  },
  giftAll: function(){
    var school=RSMS.school;
    var term=school.term||'First Term';
    var session=school.session||'2025/2026';
    var key='gift_'+term.replace(/\s+/g,'_')+'_'+session.replace('/','_');
    var alreadyDone = localStorage.getItem(key)==='done';
    var teachers=RSMS.staff().filter(function(s){
      var r=(s.role||'').toLowerCase();
      return r.includes('teacher')||r.includes('hod');
    });
    if(!alreadyDone) localStorage.setItem(key,'done');
    return {alreadyDone:alreadyDone, teachers:teachers, count:teachers.length};
  }
};

// ── LINK GENERATOR ────────────────────────────────────
var LINKS = {
  BASE: 'https://rsms.rehoteq.com/',
  PORTAL: {
    'Class Teacher':          'rsms-classteacher.html',
    'Subject Teacher':        'rsms-teacher.html',
    'Teacher':                'rsms-teacher.html',
    'HOD':                    'rsms-hod.html',
    'Vice Principal Academic':'rsms-vp.html',
    'Vice Principal Admin':   'rsms-vp.html',
    'Bursar':                 'rsms-bursar.html',
    'Admin Staff':            'rsms-admin.html',
    'Security':               'rsms-clock.html'
  },
  _token: function(seed){
    return btoa(seed+'|'+Date.now()).replace(/[^a-zA-Z0-9]/g,'').slice(0,16);
  },
  _save: function(token, data){
    var tokens=JSON.parse(localStorage.getItem('rsms_tokens')||'{}');
    tokens[token]=data;
    localStorage.setItem('rsms_tokens',JSON.stringify(tokens));
  },
  staff: function(s){
    var token=LINKS._token(s.id||s.name);
    var portal=LINKS.PORTAL[s.role]||'rsms-teacher.html';
    LINKS._save(token,{role:s.role,name:s.name,id:s.id,email:s.email||'',
      myClass:s.myClass||'',subjects:s.subjects||'',staffId:s.staffId||''});
    return LINKS.BASE+portal+'?token='+token;
  },
  student: function(s){
    var token=LINKS._token(s.id||s.reg);
    LINKS._save(token,{role:'student',name:(s.surname||'')+' '+(s.firstname||''),
      id:s.id,stuId:s.id,class:s.class,reg:s.reg,
      parentPhone:s.parentPhone||''});
    return LINKS.BASE+'rsms-student.html?token='+token;
  },
  parent: function(s){
    var token=LINKS._token('p'+(s.id||s.reg));
    LINKS._save(token,{role:'parent',childId:s.id,
      childName:(s.surname||'')+' '+(s.firstname||''),
      class:s.class,parentPhone:s.parentPhone||''});
    return LINKS.BASE+'rsms-parent.html?token='+token;
  }
};

// ── POPULATE SELECT (subject dropdown) ──────────────────────
function populateSelect(selId, cls, selected){
  var sel=document.getElementById(selId); if(!sel)return;
  var subjects=getSubjects(cls);
  sel.innerHTML='<option value="">-- Select Subject --</option>'+
    subjects.map(function(s){
      return '<option value="'+s+'"'+(s===selected?' selected':'')+'>'+s+'</option>';
    }).join('');
}
// alias used in some portals
function getStudents(cls){
  var all=RSMS.students();
  if(!cls)return all;
  return all.filter(function(s){return (s.class||'')===cls;});
}
