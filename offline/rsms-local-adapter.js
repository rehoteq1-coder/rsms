/* ═══════════════════════════════════════════════════════════════
   RSMS LAN data adapter (injected by the offline server only)

   In LAN mode the existing portal pages run unchanged: this adapter
   swaps the data transport.
     - reads:  warmCache is served from the local API (same localStorage
               keys the pages already use)
     - writes: the usual save functions additionally POST to the local
               API (durable server-side outbox); a best-effort browser
               queue retries writes the network dropped
     - money:  card payments are disabled offline (cash / bank transfer
               remain, labelled by the existing Pending flows)
   Cloud mode (no RSMS_LOCAL flag) is completely untouched.
═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var LOCAL = global.RSMS_LOCAL;
  if (!LOCAL || LOCAL.mode !== 'lan') return;

  var SCHOOL_ID = LOCAL.schoolId || '';
  var BROWSER_OUTBOX_KEY = 'rsms_local_browser_outbox';

  function log(){ try { console.log('[rsms-lan]', [].slice.call(arguments).join(' ')); } catch (e) {} }

  function scopedKey(base){
    return SCHOOL_ID ? ('rsms_' + SCHOOL_ID + '_' + base) : ('rsms_' + base);
  }

  function lsSet(base, data){
    var json = JSON.stringify(data);
    try { localStorage.setItem('rsms_' + base, json); } catch (e) {}
    if (SCHOOL_ID) { try { localStorage.setItem('rsms_' + SCHOOL_ID + '_' + base, json); } catch (e) {} }
  }

  function readJson(key){
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function whoami(){
    return fetch('/api/whoami', {credentials: 'same-origin'}).then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    }).catch(function () { return null; });
  }

  function fetchCollections(){
    return fetch('/api/school/collections', {credentials: 'same-origin'}).then(function (r) {
      if (r.status === 401) return {unauth: true};
      if (!r.ok) return {error: r.status};
      return r.json();
    }).catch(function () { return {error: 'network'}; });
  }

  /* Seed localStorage the same way the cloud warmCache does, from the LAN. */
  function seedFromServer(force){
    var school = readJson('rsms_school');
    var seededKey = SCHOOL_ID ? ('rsms_lan_seeded_' + SCHOOL_ID) : '';
    if (!force && SCHOOL_ID && localStorage.getItem(seededKey) && school) return Promise.resolve(true);
    return fetchCollections().then(function (data) {
      if (data && data.unauth) return false;
      if (!data || !data.collections) return false;
      try { localStorage.setItem(seededKey, new Date().toISOString()); } catch (e) {}
      if (!school && SCHOOL_ID) {
        localStorage.setItem('rsms_school', JSON.stringify({schoolId: SCHOOL_ID}));
      }
      Object.keys(data.collections).forEach(function (key) {
        lsSet(key, data.collections[key]);
      });
      log('seeded', Object.keys(data.collections).length, 'collections from LAN server');
      return true;
    });
  }

  /* ── Browser best-effort outbox for dropped writes ───────────── */
  function browserOutbox(){
    var list = readJson(BROWSER_OUTBOX_KEY);
    return Array.isArray(list) ? list : [];
  }

  function queueBrowserOutbox(entry){
    var list = browserOutbox();
    if (list.length > 200) list = list.slice(-200);
    list.push(entry);
    try { localStorage.setItem(BROWSER_OUTBOX_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function flushBrowserOutbox(){
    var list = browserOutbox();
    if (!list.length) return;
    var next = list.slice();
    next.forEach(function (entry) {
      fetch('/api/school/collections/' + encodeURIComponent(entry.collection), {
        method: 'PUT', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({rows: entry.rows})
      }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
      }).catch(function () {
        /* keep in queue for next attempt */
      });
    });
    setTimeout(function () {
      /* re-check after the batch settles; drop acknowledged ones lazily */
      var remaining = browserOutbox().filter(function (entry) {
        return Date.parse(entry.at) + 60000 > Date.now();
      });
      try { localStorage.setItem(BROWSER_OUTBOX_KEY, JSON.stringify(remaining.length ? remaining : [])); } catch (e) {}
    }, 4000);
  }

  function postCollection(collection, rows){
    return fetch('/api/school/collections/' + encodeURIComponent(collection), {
      method: 'PUT', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({rows: rows})
    }).then(function (r) {
      if (r.status === 401) return {unauth: true};
      if (!r.ok) throw new Error('http ' + r.status);
      return {ok: true};
    }).catch(function (e) {
      queueBrowserOutbox({collection: collection, rows: rows, at: new Date().toISOString()});
      log('write queued locally (server unreachable):', collection, e.message);
      return {queued: true};
    });
  }

  /* ── Patch RSMS_FB when it exists ────────────────────────────── */
  function patch(){
    var fb = global.RSMS_FB;
    if (!fb || fb.__lanPatched) return;
    fb.__lanPatched = true;

    var originalWarm = fb.warmCache;
    fb.warmCache = function (schoolId, onComplete) {
      if (SCHOOL_ID) fb.setSchoolId && fb.setSchoolId(SCHOOL_ID);
      seedFromServer(false).then(function (ok) {
        if (ok) { if (onComplete) onComplete(true); return; }
        /* fall back to the original (cloud) path, which will no-op offline */
        try { originalWarm.call(fb, schoolId, onComplete); }
        catch (e) { if (onComplete) onComplete(false); }
      });
    };

    /* Write paths: original first (updates localStorage; the Firebase
       write is disabled in LAN mode by the rsms-firebase.js guard), then
       the durable local API write. */
    var genericWrap = function (collection) {
      return function (data) {
        postCollection(collection, data);
      };
    };
    var wrapNamed = function (fnName, collection) {
      if (typeof fb[fnName] !== 'function') return;
      var original = fb[fnName];
      fb[fnName] = function (data) {
        original.apply(fb, arguments);
        postCollection(collection, data);
      };
    };
    var wrapGeneric = function (fnName) {
      if (typeof fb[fnName] !== 'function') return;
      var original = fb[fnName];
      fb[fnName] = function (key, data) {
        original.apply(fb, arguments);
        postCollection(key, data);
      };
    };

    wrapGeneric('saveCollection');
    wrapNamed('saveStudents', 'students');
    wrapNamed('saveStaff', 'staff');
    wrapNamed('saveFees', 'fees');
    wrapNamed('saveBroadcasts', 'broadcasts');
    wrapNamed('saveLogo', 'settings');
    wrapNamed('saveSchool', 'settings');
    wrapNamed('saveClockLogs', 'clock_logs');
    wrapNamed('saveAssignments', 'assignments');
    wrapNamed('saveAttendance', 'attendance');
    wrapNamed('saveFeeSchedule', 'fee_schedule');
    wrapNamed('saveStreamConfig', 'stream_config');
    wrapNamed('saveCTRemarks', 'ct_remarks');
    if (typeof fb.saveFlwConfig === 'function') {
      var originalFlw = fb.saveFlwConfig;
      fb.saveFlwConfig = function (data) {
        originalFlw.apply(fb, arguments);
        postCollection('flw_config', data && data.rows ? data.rows : data);
      };
    }
    log('RSMS_FB transport swapped to LAN server');
  }

  function start(){
    if (typeof global.RSMS_FB !== 'undefined') patch();
    else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { patch(); });
    } else {
      setTimeout(patch, 50);
    }

    whoami().then(function (session) {
      if (!session) {
        if (location.pathname.indexOf('staff-login') === -1) {
          global.location.href = '/staff-login.html';
        }
        return;
      }
      /* Restore the portal session the usual pages expect. */
      try {
        sessionStorage.setItem('rsms_role', session.role);
        sessionStorage.setItem('rsms_user', JSON.stringify({
          id: session.username, name: session.displayName || session.username, role: session.role
        }));
      } catch (e) {}
      seedFromServer(false).then(function (ok) {
        if (ok) {
          /* Offline finance boundary (design §7): card payments are
             cloud-only. Disable the card path for the local school. */
          var raw = readJson(scopedKey('flw_config')) || readJson('rsms_flw_config') || {};
          if (raw.hasFlwSecret || raw.hasPsSecret || raw.publicKey) {
            raw.hasFlwSecret = false;
            raw.hasPsSecret = false;
            raw.publicKey = '';
            lsSet('flw_config', raw);
          }
        }
        flushBrowserOutbox();
      });
    });
  }

  /* Logout: kill the LAN session server-side, then go to the staff
     sign-in page. The portals' own logout only clears cached data,
     so without this the session cookie would survive and every
     portal would stay open after "logging out". */
  if(typeof window.RSMS !== 'undefined' && window.RSMS && typeof window.RSMS.logout === 'function'){
    window.RSMS.logout = function(){
      function done(){
        try{ sessionStorage.clear(); }catch(e){}
        location.href = '/staff-login.html';
      }
      try{ fetch('/api/auth/logout', {method: 'POST'}).then(done, done); }
      catch(e){ done(); }
    };
  }

  /* The server's own /staff-login.html is served directly (no injection),
     so the adapter only ever runs on portal pages. */
  start();

})(typeof window !== 'undefined' ? window : this);
