/* ═══════════════════════════════════════════════════════════════
   RSMS FIREBASE DATA LAYER — v2.1
   Firebase is the SOURCE OF TRUTH.
   localStorage is CACHE ONLY.
   Every read = Firebase first, localStorage fallback.
   Every write = Firebase + localStorage (BOTH scoped + unscoped).
═══════════════════════════════════════════════════════════════ */

var RSMS_FB = (function(){

  // ── CONFIG ──────────────────────────────────────────────────
  var CFG = (window.RSMS_CONFIG&&window.RSMS_CONFIG.firebase)||{
    apiKey:            'AIzaSyDKkmeHjIJm1vTg9A-o_AZnhIp1f3jmG2M',
    authDomain:        'rsms-a84ff.firebaseapp.com',
    databaseURL:       'https://rsms-a84ff-default-rtdb.europe-west1.firebasedatabase.app',
    projectId:         'rsms-a84ff',
    storageBucket:     'rsms-a84ff.firebasestorage.app',
    messagingSenderId: '1068176996970',
    appId:             '1:1068176996970:web:a43f6c225090de05f86813'
  };

  var _db    = null;
  var _ready = false;
  var _sid   = '';       // school ID
  var _queue = [];       // pending writes while connecting

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
  function init(){
    try{
      if(typeof firebase==='undefined') return;
      if(!firebase.apps.length) firebase.initializeApp(CFG);
      _db    = firebase.database();
      _ready = true;

      // Get school ID
      var sc = JSON.parse(localStorage.getItem('rsms_school')||'{}');
      _sid   = sc.schoolId||'';

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
                'fee_schedule','stream_config','broadcasts'];
    keys.forEach(function(key){
      _db.ref('schools/'+_sid+'/'+key).on('value', function(snap){
        var val = snap.val();
        if(val !== null){
          var data = Array.isArray(val) ? val : (typeof val==='object' ? Object.values(val) : val);
          // Write to BOTH scoped and unscoped keys
          _lsSet(key, data);
          // Trigger UI refresh if portal has the handler
          var handler = window['onFirebaseUpdate_'+key];
          if(typeof handler==='function') handler(data);
        }
      }, function(err){ });
    });

    // Scores are nested — listen to all score keys for this school
    _db.ref('schools/'+_sid+'/score_entries').on('value', function(snap){
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
    if(!_ready||!_sid){ if(onComplete) onComplete(false); return; }

    var keys = ['students','staff','fees','ct_remarks',
                'fee_schedule','stream_config','broadcasts',
                'info','clock_logs','clock_cfg','assignments'];
    var done  = 0;
    var total = keys.length + 2; // +1 score_entries, +1 attendance

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
            var data = Array.isArray(val)?val:(typeof val==='object'?Object.values(val):val);
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
          var data=Array.isArray(val)?val:Object.values(val);
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
          var data=Array.isArray(val)?val:Object.values(val);
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
          var data=Array.isArray(val)?val:Object.values(val);
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
  }

  function isReady(){ return _ready && !!_sid; }

  // ── PUBLIC API ───────────────────────────────────────────────
  return {
    init:             init,
    isReady:          isReady,
    setSchoolId:      setSchoolId,
    warmCache:        warmCache,
    // Saves
    saveStudents:     saveStudents,
    saveStaff:        saveStaff,
    saveFees:         saveFees,
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
    // Reads
    getStudents:      getStudents,
    getStaff:         getStaff,
    getFees:          getFees,
  };

})();

// Auto-init when script loads
if(typeof firebase!=='undefined'){
  RSMS_FB.init();
} else {
  window.addEventListener('load', function(){
    if(typeof firebase!=='undefined') RSMS_FB.init();
  });
}

// Auto-init when script loads
if(typeof firebase!=='undefined'){
  RSMS_FB.init();
} else {
  window.addEventListener('load', function(){
    if(typeof firebase!=='undefined') RSMS_FB.init();
  });
}
