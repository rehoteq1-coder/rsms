/* ═══════════════════════════════════════════════════════════════
   RSMS FIREBASE DATA LAYER — v2.1
   Firebase is the SOURCE OF TRUTH.
   localStorage is CACHE ONLY.
   Every read = Firebase first, localStorage fallback.
   Every write = Firebase + localStorage (BOTH scoped + unscoped).
═══════════════════════════════════════════════════════════════ */

var RSMS_FB = (function(){

  // ── CONFIG ──────────────────────────────────────────────────
  // Firebase config — loaded from rsms-config.js (NEVER hardcode credentials here)
  var CFG = (window.RSMS_CONFIG && window.RSMS_CONFIG.firebase);
  if (!CFG) {
    console.error('RSMS: Firebase config not found. Ensure rsms-config.js is loaded before this file.');
    return {};
  }

  var _db    = null;
  var _ready = false;
  var _sid   = '';       // school ID
  var _queue = [];       // pending writes while connecting
  var _listeningSid = ''; // school currently attached to RTDB live listeners

  // ── KEY HELPERS ─────────────────────────────────────────────
  // Write to BOTH scoped (rsms_SCHOOLID_key) and unscoped (rsms_key)
  // so ALL portals can read regardless of which key format they use
  function _lsSet(key, data){
    var json = JSON.stringify(data);
    try{ localStorage.setItem('rsms_'+key, json); }catch(e){}
    if(_sid){
      try{ localStorage.setItem('rsms_'+_sid+'_'+key, json); }catch(e){}
    }
  }

  // Score key helpers (were missing — caused saveScores crash)
  function _scoreKey(cls, term, sess){
    return 'rsms_scores_'+cls.replace(/\s+/g,'_')+'_'+term.replace(/\s+/g,'_')+'_'+sess.replace('/','_');
  }
  function _scoreScopedKey(cls, term, sess){
    if(!_sid) return _scoreKey(cls,term,sess);
    return 'rsms_'+_sid+'_scores_'+cls.replace(/\s+/g,'_')+'_'+term.replace(/\s+/g,'_')+'_'+sess.replace('/','_');
  }
  function _fbScoreKey(cls, term, sess){
    return cls.replace(/\s+/g,'_')+'_'+term.replace(/\s+/g,'_')+'_'+sess.replace('/','_');
  }

  // ── INIT ────────────────────────────────────────────────────
  // -- REAL AUTH + PORTAL ACCESS ---------------------------------
  // These helpers intentionally retain the legacy PIN path for schools that
  // have not enabled Firebase Auth yet. Once a school opts in through
  // config/auth_enforced/{schoolId}, finance portals require verified claims.
  var _auth = null;
  var _authClaims = {};
  var _authInitialised = false;
  var _authPersistence = Promise.resolve();
  var _authEnforcedLoads = {};
  var FILE_ROLE = {
    'rsms-admin.html':'admin',
    'rsms-bursar.html':'bursar',
    'rsms-teacher.html':'teacher',
    'rsms-classteacher.html':'classteacher',
    'rsms-hod.html':'hod',
    'rsms-principal.html':'principal',
    'rsms-vp.html':'vp',
    'rsms-student.html':'student',
    'rsms-parent.html':'parent',
    'rsms-control.html':'control',
    'rsms-superadmin.html':'superadmin'
  };
  var FINANCE_ROLES = ['admin','bursar'];

  function _safeJson(raw, fallback){
    try { return raw ? JSON.parse(raw) : fallback; }
    catch(e){ return fallback; }
  }

  function _cleanText(value){
    return String(value === undefined || value === null ? '' : value).replace(/^\s+|\s+$/g, '');
  }

  function _claimList(value, lowercase){
    var out = [];
    var seen = {};
    var rows;
    if(Array.isArray(value)) rows = value;
    else if(value && typeof value === 'object'){
      rows = Object.keys(value).filter(function(key){ return value[key] === true || value[key] === 'true' || value[key] === 1; });
    }else if(value) rows = [value];
    else rows = [];
    rows.forEach(function(row){
      var item = _cleanText(row);
      if(lowercase) item = item.toLowerCase();
      if(item && !seen[item]){ seen[item] = true; out.push(item); }
    });
    return out;
  }

  function _session(){
    return _safeJson(sessionStorage.getItem('rsms_user'), {}) || {};
  }

  function _schoolIdFromContext(ids){
    var current = _safeJson(localStorage.getItem('rsms_school'), {}) || {};
    var selected = current.schoolId || '';
    if(selected && (!ids.length || ids.indexOf(selected) > -1)) return selected;
    return ids[0] || selected || '';
  }

  function _fireAuthChanged(session){
    try{
      if(typeof window.onRSMSAuthChanged === 'function') window.onRSMSAuthChanged(session);
    }catch(e){}
  }

  function _clearUnscopedSchoolCache(){
    var keys = ['students','staff','fees','ct_remarks','broadcasts','fee_schedule',
      'assignments','portal_pins','clock_logs','stream_config','results','scores',
      'fee_structures','student_fees','payments','recurring','recurring_schedule',
      'expenses','wallet','audit_log'];
    keys.forEach(function(key){
      try { localStorage.removeItem('rsms_'+key); }catch(e){}
    });
  }

  function _ensureAuthSchool(schoolId){
    var saved;
    if(!schoolId) return;
    saved = _safeJson(localStorage.getItem('rsms_school'), {}) || {};
    if(saved.schoolId && saved.schoolId !== schoolId){
      // A verified account may never inherit another school's unscoped cache,
      // branding, or active listeners. Scoped cache remains isolated by ID.
      _clearUnscopedSchoolCache();
      saved = {schoolId:schoolId};
      try { localStorage.removeItem('rsms_school_logo'); }catch(e2){}
    }else saved.schoolId = schoolId;
    try { localStorage.setItem('rsms_school', JSON.stringify(saved)); }catch(e3){}
    _sid = schoolId;
    if(_ready) _setupListeners();
  }

  function _applyAuthSession(user, claims){
    var previous = _session();
    var roles = _claimList(claims && claims.roles, true);
    if(!roles.length) roles = _claimList(claims && (claims.roleMap || claims.role), true);
    var schoolIds = _claimList(claims && claims.schoolIds, false);
    var childIds = _claimList(claims && claims.childIds, false);
    var selectedSchool = _schoolIdFromContext(schoolIds);
    var session = {
      uid:user.uid || '',
      email:user.email || '',
      name:user.displayName || previous.name || user.email || 'Verified user',
      roles:roles,
      schoolIds:schoolIds,
      schoolId:selectedSchool,
      childIds:childIds,
      childId:childIds[0] || previous.childId || '',
      realAuth:true,
      role:roles[0] || ''
    };
    _authClaims = claims || {};
    try{
      sessionStorage.setItem('rsms_user', JSON.stringify(session));
      sessionStorage.setItem('rsms_role', session.role || '');
      sessionStorage.setItem('rsms_auth', 'true');
      sessionStorage.setItem('rsms_real_auth', 'true');
    }catch(e){}
    _ensureAuthSchool(selectedSchool);
    _fireAuthChanged(session);
    _scheduleAuthGuard();
  }

  function _clearAuthSession(force){
    var wasReal = false;
    try { wasReal = force || sessionStorage.getItem('rsms_real_auth') === 'true'; }catch(e){}
    _authClaims = {};
    if(wasReal){
      try{
        sessionStorage.removeItem('rsms_user');
        sessionStorage.removeItem('rsms_role');
        sessionStorage.removeItem('rsms_auth');
        sessionStorage.removeItem('rsms_real_auth');
      }catch(e2){}
    }
    _fireAuthChanged(null);
    _scheduleAuthGuard();
  }

  function _initAuth(){
    if(_authInitialised) return true;
    if(typeof firebase === 'undefined' || typeof firebase.auth !== 'function') return false;
    try{
      _auth = firebase.auth();
      _authInitialised = true;
      // Firebase normally defaults to local persistence; set it explicitly
      // when this compat SDK exposes the enum so login survives a refresh.
      if(_auth && typeof _auth.setPersistence === 'function' && firebase.auth.Auth && firebase.auth.Auth.Persistence){
        var persistenceRequest = _auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        if(persistenceRequest && typeof persistenceRequest.then === 'function') _authPersistence = persistenceRequest.catch(function(){});
      }
      _auth.onAuthStateChanged(function(user){
        if(!user){ _clearAuthSession(false); return; }
        user.getIdTokenResult(true).then(function(token){
          _applyAuthSession(user, token.claims || {});
        }).catch(function(){
          _clearAuthSession(false);
        });
      });
      return true;
    }catch(e){
      _auth = null;
      _authInitialised = false;
      return false;
    }
  }

  function _normalisedAuthError(error){
    var message = _cleanText(error && error.message).replace(/^Firebase:\s*/i, '');
    var result = new Error(message || 'Sign-in could not be completed.');
    result.code = (error && error.code) || '';
    return result;
  }

  function login(email, password){
    if(!_initAuth() || !_auth) return Promise.reject(_normalisedAuthError({code:'auth/unavailable',message:'Firebase Auth is not available on this page.'}));
    return _authPersistence.then(function(){
      return _auth.signInWithEmailAndPassword(_cleanText(email), String(password || ''));
    }).then(function(credential){
      return credential.user;
    }).catch(function(error){
      return Promise.reject(_normalisedAuthError(error));
    });
  }

  function logout(){
    function finish(){
      _clearAuthSession(true);
      try { window.location.href = 'rsms-login.html'; }catch(e){}
    }
    if(_initAuth() && _auth && typeof _auth.signOut === 'function'){
      return _auth.signOut().catch(function(){}).then(function(){ finish(); });
    }
    finish();
    return Promise.resolve();
  }

  function currentUser(){
    return _auth && _auth.currentUser ? _auth.currentUser : null;
  }

  function claims(){
    return _safeJson(JSON.stringify(_authClaims || {}), {});
  }

  function authEnforced(schoolId){
    var sid = schoolId || _sid || ((_safeJson(localStorage.getItem('rsms_school'), {}) || {}).schoolId) || '';
    var cacheKey;
    var cached;
    if(!sid) return false;
    cacheKey = 'rsms_auth_enforced_'+sid;
    try { cached = localStorage.getItem(cacheKey); }catch(e){ cached = null; }
    if(cached !== null) return cached === 'true';
    if(_db && !_authEnforcedLoads[sid]){
      _authEnforcedLoads[sid] = true;
      _db.ref('config/auth_enforced/'+sid).once('value').then(function(snap){
        var enabled = snap.val() === true;
        try { localStorage.setItem(cacheKey, enabled ? 'true' : 'false'); }catch(e){}
        delete _authEnforcedLoads[sid];
        runAuthGuard();
      }).catch(function(){ delete _authEnforcedLoads[sid]; });
    }
    return false;
  }

  function _currentFile(){
    var path = (window.location && window.location.pathname) || '';
    var file = path.split('/').pop() || '';
    return file || 'index.html';
  }

  function _titleCase(value){
    return _cleanText(value).replace(/(^|[_-])(\w)/g, function(match, before, letter){ return (before ? ' ' : '')+letter.toUpperCase(); });
  }

  function _removeAuthBlock(){
    var existing = document.getElementById('rsms-auth-guard');
    if(existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function _showAuthBlock(title, message){
    var existing;
    if(!document.body) return;
    existing = document.getElementById('rsms-auth-guard');
    if(!existing){
      existing = document.createElement('div');
      existing.id = 'rsms-auth-guard';
      existing.setAttribute('role','alertdialog');
      existing.setAttribute('aria-modal','true');
      existing.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(8,13,28,.64);backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);font-family:Arial,sans-serif;';
      document.body.appendChild(existing);
    }
    existing.innerHTML = '<div style="width:min(430px,100%);background:#fff;border-radius:18px;padding:30px 26px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.28);color:#172033;"><div style="width:58px;height:58px;border-radius:18px;background:#fff5d8;color:#a76e00;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:28px;">&#128274;</div><h1 style="font-size:22px;margin:0 0 9px;">'+_cleanText(title)+'</h1><p style="margin:0 0 22px;color:#566278;line-height:1.55;font-size:14px;">'+_cleanText(message)+'</p><button type="button" id="rsms-auth-guard-login" style="border:0;border-radius:10px;background:#d4a843;color:#111827;font-weight:800;padding:12px 18px;cursor:pointer;font-size:14px;">&#8592; Sign in</button></div>';
    var button = document.getElementById('rsms-auth-guard-login');
    if(button) button.onclick = function(){ window.location.href = 'rsms-login.html'; };
  }

  function runAuthGuard(){
    var requiredRole;
    var session;
    var roles;
    var isReal;
    if(typeof document === 'undefined' || !document.body) return true;
    requiredRole = FILE_ROLE[_currentFile()];
    if(!requiredRole){ _removeAuthBlock(); return true; }
    session = _session();
    roles = _claimList(session.roles, true);
    if(!roles.length) roles = _claimList(session.roleMap || session.role, true);
    isReal = session.realAuth === true || sessionStorage.getItem('rsms_real_auth') === 'true';
    if(isReal){
      if(roles.indexOf('superadmin') > -1 || roles.indexOf(requiredRole) > -1){
        _removeAuthBlock();
        return true;
      }
      _showAuthBlock('Access denied', 'This verified account does not have the '+_titleCase(requiredRole)+' role required for this portal.');
      return false;
    }
    if(sessionStorage.getItem('rsms_auth') === 'true' && FINANCE_ROLES.indexOf(requiredRole) > -1 && authEnforced(session.schoolId || _sid)){
      _showAuthBlock('Email sign-in required', 'This school requires a verified staff email account before opening finance portals.');
      return false;
    }
    _removeAuthBlock();
    return true;
  }

  function _scheduleAuthGuard(){
    if(typeof document === 'undefined') return;
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runAuthGuard);
    else setTimeout(runAuthGuard, 0);
  }

  function init(){
    try{
      if(typeof firebase==='undefined') return;
      if(_ready){ _initAuth(); return; }
      if(!firebase.apps.length) firebase.initializeApp(CFG);
      _db    = firebase.database();
      _ready = true;

      // Get school context before an auth callback can select a claim-scoped one.
      var sc = JSON.parse(localStorage.getItem('rsms_school')||'{}');
      _sid   = sc.schoolId||'';
      _initAuth();

      // Flush queued writes
      _queue.forEach(function(w){ _write(w.path, w.data); });
      _queue = [];

      // Set up real-time listeners for live sync
      if(_sid) _setupListeners();

    }catch(e){ console.warn('RSMS Firebase init failed:', e.message); }
  }

  // ── REAL-TIME LISTENERS ─────────────────────────────────────
  function _setupListeners(){
    var keys = ['students','staff','fees','scores','ct_remarks',
                'fee_schedule','stream_config','broadcasts',
                'fee_structures','student_fees','payments','recurring',
                'recurring_schedule','expenses','wallet','audit_log'];
    var previousSid = _listeningSid;
    var listenSid = _sid;
    if(!_db || !listenSid || previousSid === listenSid) return;
    if(previousSid){
      keys.forEach(function(key){
        var oldRef = _db.ref('schools/'+previousSid+'/'+key);
        if(oldRef && typeof oldRef.off === 'function') oldRef.off('value');
      });
      var oldScores = _db.ref('schools/'+previousSid+'/score_entries');
      if(oldScores && typeof oldScores.off === 'function') oldScores.off('value');
    }
    _listeningSid = listenSid;
    keys.forEach(function(key){
      _db.ref('schools/'+listenSid+'/'+key).on('value', function(snap){
        if(_sid !== listenSid) return;
        var val = snap.val();
        if(val !== null){
          var data = Array.isArray(val) ? val.filter(Boolean) : (typeof val==='object' ? Object.values(val).filter(Boolean) : val);
          // Write to BOTH scoped and unscoped keys
          _lsSet(key, data);
          // Trigger UI refresh if portal has the handler
          var handler = window['onFirebaseUpdate_'+key];
          if(typeof handler==='function') handler(data);
        }
      }, function(err){ });
    });

    // Scores are nested — listen to all score keys for this school
    _db.ref('schools/'+listenSid+'/score_entries').on('value', function(snap){
      if(_sid !== listenSid) return;
      var val = snap.val();
      if(!val) return;
      Object.keys(val).forEach(function(scoreKey){
        var json = JSON.stringify(val[scoreKey]);
        // Write to both scoped and unscoped score keys
        try{ localStorage.setItem('rsms_scores_'+scoreKey, json); }catch(e){}
        if(_sid){ try{ localStorage.setItem('rsms_'+_sid+'_scores_'+scoreKey, json); }catch(e){} }
      });
      var handler = window['onFirebaseUpdate_scores'];
      if(typeof handler==='function') handler(val);
    }, function(){ });
  }

  // ── WRITE ───────────────────────────────────────────────────
  function _write(path, data){
    if(!_ready||!_db){ _queue.push({path:path,data:data}); return; }
    try{
      _db.ref(path).set(data).catch(function(e){
        console.warn('RSMS write failed ('+path+'):', e.message);
      });
    }catch(e){}
  }

  // ── PUBLIC SAVE FUNCTIONS ───────────────────────────────────

  function saveStudents(data){
    _lsSet('students', data);
    if(_sid) _write('schools/'+_sid+'/students', data);
  }

  function saveStaff(data){
    _lsSet('staff', data);
    if(_sid) _write('schools/'+_sid+'/staff', data);
  }

  function saveFees(data){
    _lsSet('fees', data);
    if(_sid) _write('schools/'+_sid+'/fees', data);
  }

  // Generic collection save for portal modules such as the finance engine.
  // Mirrors the established scoped + fallback cache and Firebase write pattern.
  function saveCollection(key, data){
    _lsSet(key, data);
    if(_sid) _write('schools/'+_sid+'/'+key, data);
  }

  function saveScores(cls, term, sess, data){
    // Write to both scoped and unscoped score localStorage keys
    var json = JSON.stringify(data);
    try{ localStorage.setItem(_scoreKey(cls,term,sess), json); }catch(e){}
    if(_sid){ try{ localStorage.setItem(_scoreScopedKey(cls,term,sess), json); }catch(e){} }
    // Write to Firebase under score_entries
    var fbKey = _fbScoreKey(cls,term,sess);
    if(_sid) _write('schools/'+_sid+'/score_entries/'+fbKey, data);
  }

  function saveCTRemarks(data){
    _lsSet('ct_remarks', data);
    if(_sid) _write('schools/'+_sid+'/ct_remarks', data);
  }

  function saveFeeSchedule(data){
    _lsSet('fee_schedule', data);
    if(_sid) _write('schools/'+_sid+'/fee_schedule', data);
  }

  function saveStreamConfig(data){
    _lsSet('stream_config', data);
    if(_sid) _write('schools/'+_sid+'/stream_config', data);
  }

  function saveClockLogs(data){
    _lsSet('clock_logs', data);
    if(_sid) _write('schools/'+_sid+'/clock_logs', data);
  }

  function saveBroadcasts(data){
    _lsSet('broadcasts', data);
    if(_sid) _write('schools/'+_sid+'/broadcasts', data);
  }

  function saveAssignments(data){
    _lsSet('assignments', data);
    if(_sid) _write('schools/'+_sid+'/assignments', data);
  }

  function saveFlwConfig(data){
    var json=JSON.stringify(data);
    try{ localStorage.setItem('rsms_flw_config', json); }catch(e){}
    if(_sid){
      try{ localStorage.setItem('rsms_'+_sid+'_flw_config', json); }catch(e){}
      _write('schools/'+_sid+'/flw_config', data);
    }
  }

  function pushPaymentAlert(rec){
    if(_sid&&_ready){
      // Push to notifications path so rsms-notifications.js picks it up
      _db.ref('schools/'+_sid+'/notifications').push({
        event:'parent_payment',
        data:{
          student:rec.student||'Unknown',
          class:rec.class||'--',
          amount:rec.amount||0,
          type:rec.type||'School Fee',
          method:rec.method||'Card',
          receiptNo:rec.receiptNo||''
        },
        from:rec.student||'Parent',
        fromRole:'parent',
        schoolId:_sid,
        createdAt:new Date().toISOString(),
        read:false
      });
    }
  }

  function listenPaymentAlerts(onAlert){
    if(!_ready||!_sid) return;
    _db.ref('schools/'+_sid+'/payment_alerts')
      .orderByChild('seen').equalTo(false)
      .on('child_added', function(snap){
        var val=snap.val();
        if(val && onAlert) onAlert(val, snap.key);
      });
  }

  function markAlertSeen(alertKey){
    if(_sid&&_ready){
      _db.ref('schools/'+_sid+'/payment_alerts/'+alertKey+'/seen').set(true);
    }
  }

  function saveAttendance(cls, date, data){
    var attKey = 'att_'+cls+'_'+date;
    _lsSet(attKey, data);
    if(_sid) _write('schools/'+_sid+'/attendance/'+cls.replace(/\s+/g,'_')+'/'+date, data);
  }

  function saveLogo(logoDataUrl){
    localStorage.setItem('rsms_school_logo', logoDataUrl);
    if(_sid) _write('schools/'+_sid+'/logo', logoDataUrl);
    var sc = JSON.parse(localStorage.getItem('rsms_school')||'{}');
    sc.logoUrl = logoDataUrl;
    _lsSet('school', sc);
    if(_sid) _write('schools/'+_sid+'/info', sc);
  }

  function saveSchool(data){
    _lsSet('school', data);
    _sid = data.schoolId||_sid;
    var dataWithLogo = Object.assign({}, data);
    dataWithLogo.logoUrl = localStorage.getItem('rsms_school_logo')||data.logoUrl||'';
    if(_sid) _write('schools/'+_sid+'/info', dataWithLogo);
    if(_sid && data.name){
      var pub = {
        schoolId:   data.schoolId,
        name:       data.name,
        plan:       data.plan||'Standard',
        state:      data.state||'',
        subdomain:  data.subdomain||'',
        brandColor: data.brandColor||'#d4a843',
        logoUrl:    localStorage.getItem('rsms_school_logo')||data.logoUrl||'',
        adminToken: data.adminToken||'',
        updatedAt:  new Date().toISOString()
      };
      _write('public_schools/'+_sid, pub);
      if(data.subdomain){
        _write('public_schools_by_subdomain/'+data.subdomain, pub);
      }
    }
  }

  // ── WARM CACHE ON PORTAL LOAD ───────────────────────────────
  // Fetches ALL school data from Firebase → writes to BOTH
  // scoped + unscoped localStorage keys so every portal works
  function warmCache(schoolId, onComplete){
    _sid = schoolId||_sid;
    if(!_sid){ if(onComplete) onComplete(false); return; }
    if(_ready) _setupListeners();
    if(!_ready||!_sid){ if(onComplete) onComplete(false); return; }

    var keys = ['students','staff','fees','ct_remarks',
                'fee_schedule','stream_config','broadcasts',
                'fee_structures','student_fees','payments','recurring',
                'recurring_schedule','expenses','wallet','audit_log',
                'info','clock_logs','clock_cfg','assignments'];
    var done  = 0;
    var total = keys.length + 3; // +1 score_entries, +1 attendance, +1 flw_config

    function tick(){
      done++;
      if(done>=total && onComplete) onComplete(true);
    }

    keys.forEach(function(key){
      _db.ref('schools/'+_sid+'/'+key).once('value').then(function(snap){
        var val=snap.val();
        if(val!==null){
          if(key==='info'){
            // School info — write to rsms_school
            var json=JSON.stringify(val);
            try{ localStorage.setItem('rsms_school', json); }catch(e){}
            if(val.logoUrl) try{ localStorage.setItem('rsms_school_logo', val.logoUrl); }catch(e){}
          } else {
            var data = Array.isArray(val)?val.filter(Boolean):(typeof val==='object'?Object.values(val).filter(Boolean):val);
            // Write to BOTH scoped and unscoped
            _lsSet(key, data);
          }
        }
        tick();
      }).catch(function(){ tick(); });
    });

    // Fetch all score entries
    _db.ref('schools/'+_sid+'/score_entries').once('value').then(function(snap){
      var val=snap.val();
      if(val){
        Object.keys(val).forEach(function(k){
          var json=JSON.stringify(val[k]);
          try{ localStorage.setItem('rsms_scores_'+k, json); }catch(e){}
          if(_sid){ try{ localStorage.setItem('rsms_'+_sid+'_scores_'+k, json); }catch(e){} }
        });
      }
      tick();
    }).catch(function(){ tick(); });

    // Fetch attendance records
    _db.ref('schools/'+_sid+'/attendance').once('value').then(function(snap){
      var val=snap.val();
      if(val){
        Object.keys(val).forEach(function(cls){
          Object.keys(val[cls]).forEach(function(date){
            var attKey='att_'+cls.replace(/_/g,' ')+'_'+date;
            var json=JSON.stringify(val[cls][date]);
            try{ localStorage.setItem('rsms_'+attKey, json); }catch(e){}
            if(_sid){ try{ localStorage.setItem('rsms_'+_sid+'_'+attKey, json); }catch(e){} }
          });
        });
      }
      tick();
    }).catch(function(){ tick(); });

    // Fetch Flutterwave config
    _db.ref('schools/'+_sid+'/flw_config').once('value').then(function(snap){
      var val=snap.val();
      if(val){
        var json=JSON.stringify(val);
        try{ localStorage.setItem('rsms_flw_config', json); }catch(e){}
        if(_sid){ try{ localStorage.setItem('rsms_'+_sid+'_flw_config', json); }catch(e){} }
      }
      tick();
    }).catch(function(){ tick(); });
  }

  // ── READ FUNCTIONS ───────────────────────────────────────────
  function _lsGet(key){
    // Try scoped first, fall back to unscoped
    var v = _sid ? localStorage.getItem('rsms_'+_sid+'_'+key) : null;
    return v || localStorage.getItem('rsms_'+key);
  }

  function getStudents(cb){
    var cached = JSON.parse(_lsGet('students')||'[]');
    if(cb) cb(cached);
    if(_ready&&_sid){
      _db.ref('schools/'+_sid+'/students').once('value').then(function(snap){
        var val=snap.val();
        if(val){
          var data=Array.isArray(val)?val.filter(Boolean):Object.values(val).filter(Boolean);
          _lsSet('students',data);
          if(cb) cb(data);
        }
      }).catch(function(){});
    }
    return cached;
  }

  function getStaff(cb){
    var cached = JSON.parse(_lsGet('staff')||'[]');
    if(cb) cb(cached);
    if(_ready&&_sid){
      _db.ref('schools/'+_sid+'/staff').once('value').then(function(snap){
        var val=snap.val();
        if(val){
          var data=Array.isArray(val)?val.filter(Boolean):Object.values(val).filter(Boolean);
          _lsSet('staff',data);
          if(cb) cb(data);
        }
      }).catch(function(){});
    }
    return cached;
  }

  function getFees(cb){
    var cached = JSON.parse(_lsGet('fees')||'[]');
    if(cb) cb(cached);
    if(_ready&&_sid){
      _db.ref('schools/'+_sid+'/fees').once('value').then(function(snap){
        var val=snap.val();
        if(val){
          var data=Array.isArray(val)?val.filter(Boolean):Object.values(val).filter(Boolean);
          _lsSet('fees',data);
          if(cb) cb(data);
        }
      }).catch(function(){});
    }
    return cached;
  }

  // ── HELPERS ──────────────────────────────────────────────────
  function setSchoolId(id){
    _sid = id;
    if(_ready) _setupListeners();
    _scheduleAuthGuard();
  }

  function isReady(){ return _ready; }  // _sid not required — warmCache can set it

  // ── PUBLIC API ───────────────────────────────────────────────
  return {
    init:             init,
    isReady:          isReady,
    setSchoolId:      setSchoolId,
    login:            login,
    logout:           logout,
    currentUser:      currentUser,
    claims:           claims,
    authEnforced:     authEnforced,
    runAuthGuard:     runAuthGuard,
    FILE_ROLE:        FILE_ROLE,
    warmCache:        warmCache,
    // Saves
    saveStudents:     saveStudents,
    saveStaff:        saveStaff,
    saveFees:         saveFees,
    saveCollection:   saveCollection,
    saveScores:       saveScores,
    saveCTRemarks:    saveCTRemarks,
    saveFeeSchedule:  saveFeeSchedule,
    saveStreamConfig: saveStreamConfig,
    saveBroadcasts:   saveBroadcasts,
    saveLogo:         saveLogo,
    saveClockLogs:    saveClockLogs,
    saveSchool:       saveSchool,
    saveAssignments:  saveAssignments,
    saveAttendance:   saveAttendance,
    saveFlwConfig:    saveFlwConfig,
    pushPaymentAlert: pushPaymentAlert,
    listenPaymentAlerts: listenPaymentAlerts,
    markAlertSeen:    markAlertSeen,
    // Reads
    getStudents:      getStudents,
    getStaff:         getStaff,
    getFees:          getFees,
  };

})();

// Auto-init when script loads. Guard the public calls so an older page with
// rsms-config.js loaded late degrades without throwing during page startup.
if(typeof firebase!=='undefined'&&typeof RSMS_FB.init==='function'){
  RSMS_FB.init();
} else {
  window.addEventListener('load', function(){
    if(typeof firebase!=='undefined'&&typeof RSMS_FB.init==='function') RSMS_FB.init();
  });
}

// Run the guard as soon as the portal DOM exists, then retry after load for
// pages whose Firebase Auth asset arrives later.
if(typeof document!=='undefined'){
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', function(){
      if(typeof RSMS_FB.runAuthGuard==='function') RSMS_FB.runAuthGuard();
    });
  }else if(typeof RSMS_FB.runAuthGuard==='function'){
    setTimeout(function(){ RSMS_FB.runAuthGuard(); },0);
  }
}
window.addEventListener('load', function(){
  if(typeof RSMS_FB.init==='function') RSMS_FB.init();
  if(typeof RSMS_FB.runAuthGuard==='function') RSMS_FB.runAuthGuard();
});
