/* ═══════════════════════════════════════════════════════════════
   RSMS FIREBASE SYNC LAYER
   Project: rsms-a84ff | Region: europe-west1
   Architecture:
     - Shared tier: /schools/REH-{id}/ (Starter/Standard/Premium)
     - Dedicated tier: school uses own Firebase config
   Pattern: localStorage = offline cache, Firebase = sync source
═══════════════════════════════════════════════════════════════ */

(function(){

// ── FIREBASE CONFIG (Shared project) ───────────────────────────
var SHARED_CONFIG = {
  apiKey:            "AIzaSyDKkmeHjIJm1vTg9A-o_AZnhIp1f3jmG2M",
  authDomain:        "rsms-a84ff.firebaseapp.com",
  databaseURL:       "https://rsms-a84ff-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "rsms-a84ff",
  storageBucket:     "rsms-a84ff.firebasestorage.app",
  messagingSenderId: "1068176996970",
  appId:             "1:1068176996970:web:a43f6c225090de05f86813"
};

// ── STATE ───────────────────────────────────────────────────────
var _app      = null;
var _db       = null;       // Realtime Database
var _fs       = null;       // Firestore
var _auth     = null;
var _schoolId = null;       // e.g. REH-MNG8KH7V
var _tier     = 'shared';   // 'shared' | 'dedicated'
var _online   = true;
var _queue    = [];         // offline write queue
var _ready    = false;
var _readyCbs = [];

// ── PUBLIC API ──────────────────────────────────────────────────
window.RSMS_DB = {

  // Initialise — call once on page load
  init: function(onReady){
    if(onReady) _readyCbs.push(onReady);
    if(_ready){ onReady&&onReady(); return; }

    var school = JSON.parse(localStorage.getItem('rsms_school')||'{}');
    var ref    = localStorage.getItem('rsms_ref')||'';          // e.g. MNG8KH7V
    _schoolId  = school.schoolId || (ref ? 'REH-'+ref : null);
    _tier      = school.firebaseTier || 'shared';

    // Determine which Firebase config to use
    var config = SHARED_CONFIG;
    if(_tier === 'dedicated'){
      var custom = JSON.parse(localStorage.getItem('rsms_firebase_config')||'null');
      if(custom) config = custom;
    }

    if(!_schoolId){
      console.warn('RSMS_DB: no school ID — offline only');
      _ready = true;
      _readyCbs.forEach(function(cb){cb();});
      return;
    }

    // Load Firebase SDKs dynamically
    _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js', function(){
      _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js', function(){
        _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js', function(){
          try {
            if(!firebase.apps.length){
              _app  = firebase.initializeApp(config);
            } else {
              _app  = firebase.apps[0];
            }
            _db   = firebase.database();
            _auth = firebase.auth();
            _ready = true;
            _flushQueue();
            _readyCbs.forEach(function(cb){cb();});
            console.log('RSMS_DB ready | school:', _schoolId, '| tier:', _tier);
          } catch(e){
            console.error('RSMS_DB init error:', e);
            _ready = true;
            _readyCbs.forEach(function(cb){cb();});
          }
        });
      });
    });

    // Online/offline listeners
    window.addEventListener('online',  function(){ _online=true;  _flushQueue(); });
    window.addEventListener('offline', function(){ _online=false; });
  },

  // ── READ ────────────────────────────────────────────────────────
  // Get a collection — returns array. Falls back to localStorage.
  get: function(key, cb){
    var lsKey   = 'rsms_' + key;
    var local   = JSON.parse(localStorage.getItem(lsKey) || (key==='fees'||key==='students'||key==='staff'?'[]':'{}'));

    if(!_db || !_schoolId){
      cb(null, local); return;
    }
    _db.ref(_path(key)).once('value')
      .then(function(snap){
        var val = snap.val();
        if(val === null){ cb(null, local); return; }
        // Firebase stores arrays as objects with numeric keys — convert
        var data = Array.isArray(val) ? val : _objToArr(val);
        // Update local cache
        localStorage.setItem(lsKey, JSON.stringify(data));
        cb(null, data);
      })
      .catch(function(e){
        console.warn('RSMS_DB.get fallback:', e.message);
        cb(null, local);
      });
  },

  // ── WRITE ───────────────────────────────────────────────────────
  // Save entire collection (array or object)
  set: function(key, data, cb){
    var lsKey = 'rsms_' + key;
    // Always write localStorage immediately
    localStorage.setItem(lsKey, JSON.stringify(data));
    if(cb) cb(null);

    if(!_db || !_schoolId){
      _queue.push({key:key, data:data}); return;
    }
    if(!_online){
      _queue.push({key:key, data:data}); return;
    }
    _db.ref(_path(key)).set(data)
      .then(function(){ /* synced */ })
      .catch(function(e){ console.warn('RSMS_DB.set error:', e.message); _queue.push({key:key,data:data}); });
  },

  // Push a single item to a list
  push: function(key, item, cb){
    var lsKey  = 'rsms_' + key;
    var arr    = JSON.parse(localStorage.getItem(lsKey)||'[]');
    item.id    = item.id || (key.slice(0,1)+Date.now());
    arr.push(item);
    localStorage.setItem(lsKey, JSON.stringify(arr));
    if(cb) cb(null, item);

    if(!_db || !_schoolId || !_online){ _queue.push({op:'push',key:key,item:item}); return; }
    _db.ref(_path(key)+'/'+item.id).set(item)
      .catch(function(e){ _queue.push({op:'push',key:key,item:item}); });
  },

  // Update single record by id
  update: function(key, id, patch, cb){
    var lsKey  = 'rsms_' + key;
    var arr    = JSON.parse(localStorage.getItem(lsKey)||'[]');
    var idx    = arr.findIndex(function(x){return x.id===id;});
    if(idx > -1) Object.assign(arr[idx], patch);
    localStorage.setItem(lsKey, JSON.stringify(arr));
    if(cb) cb(null);

    if(!_db || !_schoolId || !_online){ _queue.push({op:'update',key:key,id:id,patch:patch}); return; }
    _db.ref(_path(key)+'/'+id).update(patch)
      .catch(function(e){ _queue.push({op:'update',key:key,id:id,patch:patch}); });
  },

  // Remove single record by id
  remove: function(key, id, cb){
    var lsKey  = 'rsms_' + key;
    var arr    = JSON.parse(localStorage.getItem(lsKey)||'[]');
    arr        = arr.filter(function(x){return x.id!==id;});
    localStorage.setItem(lsKey, JSON.stringify(arr));
    if(cb) cb(null);

    if(!_db || !_schoolId || !_online){ return; }
    _db.ref(_path(key)+'/'+id).remove()
      .catch(function(e){ console.warn('remove error:', e.message); });
  },

  // ── REALTIME LISTENER ──────────────────────────────────────────
  // Subscribe to live updates (e.g. bursar payment → student sees instantly)
  listen: function(key, cb){
    if(!_db || !_schoolId) return function(){};
    var ref = _db.ref(_path(key));
    ref.on('value', function(snap){
      var val  = snap.val();
      var data = val===null ? [] : (Array.isArray(val)?val:_objToArr(val));
      localStorage.setItem('rsms_'+key, JSON.stringify(data));
      cb(data);
    });
    return function(){ ref.off(); }; // returns unsubscribe fn
  },

  // ── SCHOOL SETUP ───────────────────────────────────────────────
  // Called when school is first configured
  provisionSchool: function(schoolData, tier){
    _schoolId = schoolData.schoolId;
    _tier     = tier || 'shared';
    var school = JSON.parse(localStorage.getItem('rsms_school')||'{}');
    school.schoolId     = _schoolId;
    school.firebaseTier = _tier;
    localStorage.setItem('rsms_school', JSON.stringify(school));
    if(!_db || !_schoolId) return;
    // Write school meta to Firebase
    _db.ref('schools/'+_schoolId+'/meta').set({
      schoolId:   _schoolId,
      name:       schoolData.name||'',
      plan:       schoolData.plan||'Starter',
      tier:       _tier,
      createdAt:  new Date().toISOString(),
      version:    '1.0'
    });
  },

  // ── DEDICATED CONFIG ───────────────────────────────────────────
  // Enterprise schools set their own Firebase config
  setDedicatedConfig: function(config){
    localStorage.setItem('rsms_firebase_config', JSON.stringify(config));
    localStorage.setItem('rsms_firebase_tier', 'dedicated');
  },

  // ── SYNC ALL LOCAL DATA TO FIREBASE ───────────────────────────
  // Run once to push all localStorage data to Firebase
  syncAll: function(onProgress){
    var keys = ['students','staff','fees','results','attendance',
                'assignments','broadcasts','ct_remarks','clock_logs',
                'fee_schedule','stream_config','school'];
    var done = 0;
    keys.forEach(function(key){
      var lsKey = 'rsms_'+key;
      var data  = JSON.parse(localStorage.getItem(lsKey)||'null');
      if(data && _db && _schoolId){
        _db.ref(_path(key)).set(data)
          .then(function(){
            done++;
            if(onProgress) onProgress(done, keys.length, key);
          });
      } else {
        done++;
        if(onProgress) onProgress(done, keys.length, key);
      }
    });
  },

  // ── STORAGE QUOTA ──────────────────────────────────────────────
  getStorageUsed: function(cb){
    // Estimate from localStorage
    var total = 0;
    for(var k in localStorage){
      if(localStorage.hasOwnProperty(k) && k.startsWith('rsms_')){
        total += (localStorage.getItem(k)||'').length;
      }
    }
    cb(null, {bytes: total, kb: Math.round(total/1024), mb: (total/1048576).toFixed(2)});
  },

  schoolId: function(){ return _schoolId; },
  isReady:  function(){ return _ready; },
  isOnline: function(){ return _online; },
};

// ── HELPERS ─────────────────────────────────────────────────────
function _path(key){
  return 'schools/' + _schoolId + '/' + key;
}

function _objToArr(obj){
  if(!obj) return [];
  return Object.keys(obj).map(function(k){ return obj[k]; }).filter(Boolean);
}

function _flushQueue(){
  if(!_db || !_schoolId || !_online || !_queue.length) return;
  var q = _queue.splice(0, _queue.length);
  q.forEach(function(item){
    if(item.op === 'push'){
      _db.ref(_path(item.key)+'/'+item.item.id).set(item.item).catch(function(){});
    } else if(item.op === 'update'){
      _db.ref(_path(item.key)+'/'+item.id).update(item.patch).catch(function(){});
    } else {
      _db.ref(_path(item.key)).set(item.data).catch(function(){});
    }
  });
}

function _loadScript(url, cb){
  if(document.querySelector('script[src="'+url+'"]')){ cb(); return; }
  var s = document.createElement('script');
  s.src = url; s.async = true;
  s.onload = cb;
  s.onerror = function(){ console.warn('Failed to load:', url); cb(); };
  document.head.appendChild(s);
}

})();
