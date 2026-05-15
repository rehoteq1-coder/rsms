/* ═══════════════════════════════════════════════════════════════
   RSMS FIREBASE DATA LAYER — v2.0
   Firebase is the SOURCE OF TRUTH.
   localStorage is CACHE ONLY.
   Every read = Firebase first, localStorage fallback.
   Every write = Firebase + localStorage simultaneously.
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
  // When another device writes to Firebase, update this device's cache
  function _setupListeners(){
    var keys = ['students','staff','fees','scores','ct_remarks',
                'fee_schedule','stream_config','broadcasts'];
    keys.forEach(function(key){
      _db.ref('schools/'+_sid+'/'+key).on('value', function(snap){
        var val = snap.val();
        if(val !== null){
          var data = Array.isArray(val) ? val : (typeof val==='object' ? Object.values(val) : val);
          localStorage.setItem('rsms_'+key, JSON.stringify(data));
          // Trigger UI refresh if portal has the handler
          var handler = window['onFirebaseUpdate_'+key];
          if(typeof handler==='function') handler(data);
        }
      }, function(err){
        // Permission denied or offline — use cache silently
      });
    });

    // Scores are nested — listen to all score keys for this school
    _db.ref('schools/'+_sid+'/score_entries').on('value', function(snap){
      var val = snap.val();
      if(!val) return;
      Object.keys(val).forEach(function(scoreKey){
        localStorage.setItem('rsms_scores_'+scoreKey, JSON.stringify(val[scoreKey]));
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
  // Each saves to localStorage immediately (instant UI) + Firebase (sync)

  function saveStudents(data){
    localStorage.setItem('rsms_students', JSON.stringify(data));
    if(_sid) _write('schools/'+_sid+'/students', data);
  }

  function saveStaff(data){
    localStorage.setItem('rsms_staff', JSON.stringify(data));
    if(_sid) _write('schools/'+_sid+'/staff', data);
  }

  function saveFees(data){
    localStorage.setItem('rsms_fees', JSON.stringify(data));
    if(_sid) _write('schools/'+_sid+'/fees', data);
  }

  function saveScores(cls, term, sess, data){
    var lsKey = 'rsms_scores_'+cls.replace(/\s+/g,'_')+'_'+term.replace(/\s+/g,'_')+'_'+sess.replace('/','_');
    var fbKey  = cls.replace(/\s+/g,'_')+'_'+term.replace(/\s+/g,'_')+'_'+sess.replace('/','_');
    localStorage.setItem(lsKey, JSON.stringify(data));
    if(_sid) _write('schools/'+_sid+'/score_entries/'+fbKey, data);
  }

  function saveCTRemarks(data){
    localStorage.setItem('rsms_ct_remarks', JSON.stringify(data));
    if(_sid) _write('schools/'+_sid+'/ct_remarks', data);
  }

  function saveFeeSchedule(data){
    localStorage.setItem('rsms_fee_schedule', JSON.stringify(data));
    if(_sid) _write('schools/'+_sid+'/fee_schedule', data);
  }

  function saveStreamConfig(data){
    localStorage.setItem('rsms_stream_config', JSON.stringify(data));
    if(_sid) _write('schools/'+_sid+'/stream_config', data);
  }

  function saveBroadcasts(data){
    localStorage.setItem('rsms_broadcasts', JSON.stringify(data));
    if(_sid) _write('schools/'+_sid+'/broadcasts', data);
  }

  function saveSchool(data){
    localStorage.setItem('rsms_school', JSON.stringify(data));
    _sid = data.schoolId||_sid;
    if(_sid) _write('schools/'+_sid+'/info', data);
    // Also update public_schools for login page
    if(_sid && data.name){
      var pub = {
        schoolId:   data.schoolId,
        name:       data.name,
        plan:       data.plan||'Standard',
        state:      data.state||'',
        subdomain:  data.subdomain||'',
        brandColor: data.brandColor||'#d4a843',
        logoUrl:    localStorage.getItem('rsms_school_logo')||data.logoUrl||'',
        updatedAt:  new Date().toISOString()
      };
      _write('public_schools/'+_sid, pub);
    }
  }

  // ── PUBLIC READ FUNCTIONS ───────────────────────────────────
  // Read from localStorage (already synced by listener)
  // On first load, do a one-time Firebase fetch to warm the cache

  function getStudents(cb){
    var cached = JSON.parse(localStorage.getItem('rsms_students')||'[]');
    if(cb) cb(cached); // return cached immediately
    // Refresh from Firebase in background
    if(_ready&&_sid){
      _db.ref('schools/'+_sid+'/students').once('value').then(function(snap){
        var val=snap.val();
        if(val){
          var data=Array.isArray(val)?val:Object.values(val);
          localStorage.setItem('rsms_students',JSON.stringify(data));
          if(cb) cb(data);
        }
      }).catch(function(){});
    }
    return cached;
  }

  function getStaff(cb){
    var cached = JSON.parse(localStorage.getItem('rsms_staff')||'[]');
    if(cb) cb(cached);
    if(_ready&&_sid){
      _db.ref('schools/'+_sid+'/staff').once('value').then(function(snap){
        var val=snap.val();
        if(val){
          var data=Array.isArray(val)?val:Object.values(val);
          localStorage.setItem('rsms_staff',JSON.stringify(data));
          if(cb) cb(data);
        }
      }).catch(function(){});
    }
    return cached;
  }

  function getFees(cb){
    var cached = JSON.parse(localStorage.getItem('rsms_fees')||'[]');
    if(cb) cb(cached);
    if(_ready&&_sid){
      _db.ref('schools/'+_sid+'/fees').once('value').then(function(snap){
        var val=snap.val();
        if(val){
          var data=Array.isArray(val)?val:Object.values(val);
          localStorage.setItem('rsms_fees',JSON.stringify(data));
          if(cb) cb(data);
        }
      }).catch(function(){});
    }
    return cached;
  }

  // ── WARM CACHE ON PORTAL LOAD ───────────────────────────────
  // Call this when any portal opens — fetches all school data from Firebase
  // and populates localStorage so all getX() calls work instantly
  function warmCache(schoolId, onComplete){
    _sid = schoolId||_sid;
    if(!_ready||!_sid){ if(onComplete) onComplete(false); return; }

    var keys = ['students','staff','fees','ct_remarks',
                'fee_schedule','stream_config','broadcasts','info'];
    var done = 0;
    var total = keys.length + 1; // +1 for score_entries

    function tick(){
      done++;
      if(done>=total && onComplete) onComplete(true);
    }

    keys.forEach(function(key){
      _db.ref('schools/'+_sid+'/'+key).once('value').then(function(snap){
        var val=snap.val();
        if(val!==null){
          var lsKey = key==='info' ? 'rsms_school' : 'rsms_'+key;
          var data  = (key==='info') ? val :
                      (Array.isArray(val)?val:(typeof val==='object'?Object.values(val):val));
          localStorage.setItem(lsKey, JSON.stringify(data));
        }
        tick();
      }).catch(function(){ tick(); });
    });

    // Fetch all score entries
    _db.ref('schools/'+_sid+'/score_entries').once('value').then(function(snap){
      var val=snap.val();
      if(val){
        Object.keys(val).forEach(function(k){
          localStorage.setItem('rsms_scores_'+k, JSON.stringify(val[k]));
        });
      }
      tick();
    }).catch(function(){ tick(); });
  }

  // ── SCHOOL ID HELPER ────────────────────────────────────────
  function setSchoolId(id){
    _sid = id;
    if(_ready) _setupListeners();
  }

  // ── IS READY ────────────────────────────────────────────────
  function isReady(){ return _ready && !!_sid; }

  // ── PUBLIC API ───────────────────────────────────────────────
  return {
    init:           init,
    isReady:        isReady,
    setSchoolId:    setSchoolId,
    warmCache:      warmCache,
    // Saves
    saveStudents:   saveStudents,
    saveStaff:      saveStaff,
    saveFees:       saveFees,
    saveScores:     saveScores,
    saveCTRemarks:  saveCTRemarks,
    saveFeeSchedule:saveFeeSchedule,
    saveStreamConfig:saveStreamConfig,
    saveBroadcasts: saveBroadcasts,
    saveSchool:     saveSchool,
    // Reads
    getStudents:    getStudents,
    getStaff:       getStaff,
    getFees:        getFees,
  };

})();

// Auto-init when script loads
if(typeof firebase!=='undefined'){
  RSMS_FB.init();
} else {
  // Firebase SDK not yet loaded — init after it loads
  window.addEventListener('load', function(){
    if(typeof firebase!=='undefined') RSMS_FB.init();
  });
}
