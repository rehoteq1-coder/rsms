/* ═══════════════════════════════════════════════════════════════
   RSMS NOTIFICATION SYSTEM v1.0
   Uses Firebase Realtime DB + Web Push API (no server needed!)
   Works as PWA on phone and desktop
═══════════════════════════════════════════════════════════════ */

var RSMS_NOTIFY = (function(){

  var VAPID_PUBLIC_KEY = ''; // Set by admin in settings
  var _sw = null;
  var _sub = null;

  // ── INIT ──────────────────────────────────────────────────
  function init(){
    if(!('Notification' in window)) return;
    if(!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(function(reg){
      _sw = reg;
      // Listen for Firebase notification triggers
      _listenForTriggers();
    });
  }

  // ── REQUEST PERMISSION ────────────────────────────────────
  function requestPermission(cb){
    if(!('Notification' in window)){
      if(cb) cb(false, 'not_supported');
      return;
    }
    if(Notification.permission === 'granted'){
      _subscribe(cb);
      return;
    }
    Notification.requestPermission().then(function(perm){
      if(perm === 'granted'){ _subscribe(cb); }
      else { if(cb) cb(false, 'denied'); }
    });
  }

  // ── SUBSCRIBE ─────────────────────────────────────────────
  function _subscribe(cb){
    if(!_sw){ if(cb) cb(false,'no_sw'); return; }
    navigator.serviceWorker.ready.then(function(reg){
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY||_getVAPID())
      }).then(function(sub){
        _sub = sub;
        _saveSubscription(sub);
        if(cb) cb(true, sub);
      }).catch(function(e){
        // Push subscription failed — use in-app only
        if(cb) cb(false, e.message);
      });
    });
  }

  function _getVAPID(){
    var id=_sid();
    return localStorage.getItem(id?'rsms_'+id+'_vapid_key':'rsms_vapid_key')||'';
  }

  // ── SAVE SUBSCRIPTION TO FIREBASE ────────────────────────
  function _saveSubscription(sub){
    var id=_sid();
    if(!id||typeof firebase==='undefined') return;
    var user=JSON.parse(sessionStorage.getItem('rsms_user')||'{}');
    var role=(user.role||'unknown').toLowerCase();
    var subData={
      endpoint: sub.endpoint,
      keys: {
        p256dh: btoa(String.fromCharCode.apply(null,new Uint8Array(sub.getKey('p256dh')))),
        auth:   btoa(String.fromCharCode.apply(null,new Uint8Array(sub.getKey('auth'))))
      },
      role: role,
      name: user.name||'',
      device: navigator.userAgent.indexOf('Mobile')>-1?'mobile':'desktop',
      savedAt: new Date().toISOString()
    };
    try{
      firebase.database().ref('schools/'+id+'/push_subscriptions/'+role+'_'+Date.now()).set(subData);
    }catch(e){}
  }

  // ── IN-APP NOTIFICATION ───────────────────────────────────
  function showInApp(msg, type, opts){
    opts = opts||{};
    // Create notification element
    var wrap=document.getElementById('rsms-notif-wrap');
    if(!wrap){
      wrap=document.createElement('div');
      wrap.id='rsms-notif-wrap';
      wrap.style.cssText='position:fixed;top:70px;right:12px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:320px;pointer-events:none;';
      document.body.appendChild(wrap);
    }
    var n=document.createElement('div');
    var colors={
      info:'#3b82f6', success:'#22c55e', warning:'#f97316',
      error:'#f43f5e', result:'#8b5cf6', pipeline:'#d4a843'
    };
    var color=colors[type]||colors.info;
    n.style.cssText='background:#0f1535;border:1px solid '+color+';border-left:4px solid '+color+';'+
      'border-radius:10px;padding:12px 14px;box-shadow:0 4px 20px rgba(0,0,0,.4);'+
      'pointer-events:all;cursor:pointer;animation:slideIn .3s ease;';
    n.innerHTML=
      '<div style="display:flex;align-items:flex-start;gap:10px;">'+
        '<div style="font-size:1.2rem;flex-shrink:0;">'+(opts.icon||'🔔')+'</div>'+
        '<div style="flex:1;">'+
          '<div style="font-weight:700;font-size:.82rem;color:#f0f4ff;margin-bottom:2px;">'+(opts.title||'RSMS')+'</div>'+
          '<div style="font-size:.78rem;color:rgba(240,244,255,.7);">'+msg+'</div>'+
          (opts.time?'<div style="font-size:.68rem;color:rgba(240,244,255,.4);margin-top:3px;">'+opts.time+'</div>':'')+
        '</div>'+
        '<div onclick="this.closest(\'div[id]\').parentElement&&this.parentElement.parentElement.remove()" '+
          'style="font-size:.9rem;color:rgba(240,244,255,.3);cursor:pointer;flex-shrink:0;">✕</div>'+
      '</div>';
    if(opts.action){
      var btn=document.createElement('button');
      btn.style.cssText='margin-top:8px;width:100%;background:'+color+'22;color:'+color+';border:1px solid '+color+'44;'+
        'border-radius:6px;padding:5px;font-size:.75rem;font-weight:700;cursor:pointer;';
      btn.textContent=opts.action.label;
      btn.onclick=opts.action.fn;
      n.appendChild(btn);
    }
    n.onclick=function(){ n.style.opacity='0'; setTimeout(function(){ n.remove(); },300); };
    wrap.appendChild(n);
    // Auto remove after 6s
    setTimeout(function(){ if(n.parentNode){ n.style.opacity='0'; setTimeout(function(){ n.remove(); },300); } }, 6000);
    // Also show browser notification if granted
    if(Notification.permission==='granted' && opts.browserNotif!==false){
      try{
        new Notification(opts.title||'RSMS', {
          body: msg, icon: localStorage.getItem('rsms_school_logo')||'/icon-192.png',
          badge: '/icon-192.png', tag: opts.tag||'rsms-'+Date.now()
        });
      }catch(e){}
    }
  }

  // ── TRIGGER NOTIFICATION TO OTHER ROLES VIA FIREBASE ─────
  function trigger(event, data){
    var id=_sid();
    if(!id||typeof firebase==='undefined') return;
    var user=JSON.parse(sessionStorage.getItem('rsms_user')||'{}');
    var notif={
      event: event,
      data: data||{},
      from: user.name||user.role||'System',
      fromRole: (user.role||'').toLowerCase(),
      schoolId: id,
      createdAt: new Date().toISOString(),
      read: false
    };
    try{
      firebase.database().ref('schools/'+id+'/notifications').push(notif);
    }catch(e){}
  }

  // ── LISTEN FOR NOTIFICATIONS FROM FIREBASE ───────────────
  function _listenForTriggers(){
    var id=_sid();
    if(!id||typeof firebase==='undefined') return;
    var user=JSON.parse(sessionStorage.getItem('rsms_user')||'{}');
    var myRole=(user.role||'').toLowerCase();
    // Map: which roles should receive which events
    var ROLE_EVENTS = {
      hod:        ['scores_submitted','ct_remarks_saved'],
      vp:         ['hod_approved'],
      principal:  ['vp_approved','hod_approved'],
      admin:      ['school_registered','scores_submitted','results_published'],
      teacher:    ['scores_returned','exam_approved'],
      classteacher:['scores_returned','remarks_returned'],
      student:    ['results_published'],
      parent:     ['results_published','fee_reminder','attendance_alert']
    };
    var myEvents = ROLE_EVENTS[myRole]||[];
    if(!myEvents.length) return;
    // Listen to new notifications
    var ref = firebase.database().ref('schools/'+id+'/notifications');
    var lastRead = localStorage.getItem('rsms_notif_last_read_'+myRole)||new Date(0).toISOString();
    ref.orderByChild('createdAt').startAt(lastRead).limitToLast(20)
      .on('child_added', function(snap){
        var n = snap.val();
        if(!n||n.fromRole===myRole) return; // Don't notify self
        if(myEvents.indexOf(n.event)<0) return;
        var msgs = _getNotifMessage(n);
        if(msgs){
          showInApp(msgs.body, msgs.type, {
            title: msgs.title, icon: msgs.icon, tag: snap.key,
            time: new Date(n.createdAt).toLocaleTimeString(),
            action: msgs.action
          });
          // Update badge count
          _updateBadge();
        }
      });
  }

  function _getNotifMessage(n){
    var map = {
      scores_submitted: {
        title:'New Scores Submitted', type:'pipeline', icon:'📊',
        body: n.from+' submitted scores for '+(n.data.cls||'a class'),
        action:{label:'Review Now', fn:function(){ if(typeof showPage==='function') showPage('results'); }}
      },
      ct_remarks_saved: {
        title:'CT Remarks Saved', type:'info', icon:'✍️',
        body: n.from+' saved remarks for '+(n.data.cls||'a class')
      },
      hod_approved: {
        title:'HOD Approved Results', type:'success', icon:'✅',
        body: n.from+' approved '+(n.data.cls||'class')+' results — awaiting your review',
        action:{label:'Review', fn:function(){ if(typeof showPage==='function') showPage('results'); }}
      },
      vp_approved: {
        title:'VP Approved Results', type:'success', icon:'🎓',
        body: n.from+' forwarded '+(n.data.cls||'class')+' results for your approval',
        action:{label:'Approve', fn:function(){ if(typeof showPage==='function') showPage('results'); }}
      },
      results_published: {
        title:'Results Published! 🎉', type:'result', icon:'📢',
        body: 'Your '+(n.data.term||'')+ ' results are now available',
        action:{label:'View Results', fn:function(){ if(typeof showPage==='function') showPage('results'); }}
      },
      fee_reminder: {
        title:'Fee Reminder', type:'warning', icon:'💰',
        body: 'Outstanding fee balance for '+(n.data.student||'your child')
      },
      attendance_alert: {
        title:'Attendance Alert', type:'warning', icon:'📍',
        body: (n.data.student||'Your child')+' was marked absent today'
      },
      scores_returned: {
        title:'Scores Returned', type:'warning', icon:'↩️',
        body: 'Your scores for '+(n.data.cls||'a class')+' were returned for correction'
      },
      exam_approved: {
        title:'Exam Approved', type:'success', icon:'✅',
        body: 'Your exam submission for '+(n.data.subject||'a subject')+' was approved'
      }
    };
    return map[n.event]||null;
  }

  // ── BADGE COUNT ───────────────────────────────────────────
  function _updateBadge(){
    var count=(parseInt(localStorage.getItem('rsms_unread_notifs')||'0'))+1;
    localStorage.setItem('rsms_unread_notifs',count);
    // Show badge on notification bell
    var bell=document.getElementById('notif-bell-badge');
    if(bell){ bell.textContent=count; bell.style.display='block'; }
    // PWA badge
    if(navigator.setAppBadge) navigator.setAppBadge(count).catch(function(){});
  }

  function clearBadge(){
    localStorage.setItem('rsms_unread_notifs','0');
    var bell=document.getElementById('notif-bell-badge');
    if(bell) bell.style.display='none';
    if(navigator.clearAppBadge) navigator.clearAppBadge().catch(function(){});
    // Mark all read
    var id=_sid(); if(!id||typeof firebase==='undefined') return;
    localStorage.setItem('rsms_notif_last_read_'+(JSON.parse(sessionStorage.getItem('rsms_user')||'{}').role||''),new Date().toISOString());
  }

  // ── NOTIFICATION BELL UI ──────────────────────────────────
  function injectBell(){
    // Inject bell icon into topbar
    var topbar=document.querySelector('.topbar')||document.querySelector('.top-bar');
    if(!topbar||document.getElementById('notif-bell')) return;
    var bell=document.createElement('div');
    bell.id='notif-bell';
    bell.style.cssText='position:relative;cursor:pointer;width:34px;height:34px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.08);border-radius:50%;border:1px solid rgba(255,255,255,.15);flex-shrink:0;';
    bell.innerHTML='🔔<span id="notif-bell-badge" style="display:none;position:absolute;top:-2px;right:-2px;background:#f43f5e;color:#fff;border-radius:50%;width:16px;height:16px;font-size:.6rem;font-weight:800;display:flex;align-items:center;justify-content:center;"></span>';
    bell.onclick=function(){ clearBadge(); showNotifPanel(); };
    // Insert before last child of topbar
    topbar.insertBefore(bell, topbar.lastElementChild);
    // Add CSS animation
    var style=document.createElement('style');
    style.textContent='@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}#notif-bell:hover{background:rgba(255,255,255,.15)!important;}';
    document.head.appendChild(style);
  }

  // ── NOTIFICATION PANEL ────────────────────────────────────
  function showNotifPanel(){
    var existing=document.getElementById('notif-panel');
    if(existing){ existing.remove(); return; }
    var id=_sid();
    var panel=document.createElement('div');
    panel.id='notif-panel';
    panel.style.cssText='position:fixed;top:60px;right:12px;width:300px;max-height:400px;overflow-y:auto;'+
      'background:#141830;border:1px solid rgba(255,255,255,.12);border-radius:12px;z-index:9998;'+
      'box-shadow:0 8px 32px rgba(0,0,0,.5);';
    panel.innerHTML='<div style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-between;align-items:center;">'+
      '<div style="font-weight:700;color:#f0f4ff;font-size:.85rem;">🔔 Notifications</div>'+
      '<div style="display:flex;gap:8px;">'+
        '<button onclick="RSMS_NOTIFY.requestPermission(function(ok){ RSMS_NOTIFY.showInApp(ok?\'Push notifications enabled \u2705\':\'Using in-app only\',ok?\'success\':\'info\',{title:\'Notifications\'}); })" style="font-size:.7rem;padding:3px 8px;border-radius:6px;background:rgba(212,168,67,.15);color:#d4a843;border:1px solid rgba(212,168,67,.3);cursor:pointer;">Enable Push</button>'+
        '<div onclick="document.getElementById(\'notif-panel\').remove()" style="cursor:pointer;color:rgba(240,244,255,.3);font-size:.9rem;">✕</div>'+
      '</div></div>'+
      '<div id="notif-panel-list" style="padding:8px 0;"><div style="padding:20px;text-align:center;color:rgba(240,244,255,.3);font-size:.8rem;">Loading...</div></div>';
    document.body.appendChild(panel);
    // Load recent notifications
    if(id&&typeof firebase!=='undefined'){
      var user=JSON.parse(sessionStorage.getItem('rsms_user')||'{}');
      var myRole=(user.role||'').toLowerCase();
      var ROLE_EVENTS={hod:['scores_submitted','ct_remarks_saved'],vp:['hod_approved'],principal:['vp_approved','hod_approved'],admin:['scores_submitted','results_published'],teacher:['scores_returned','exam_approved'],classteacher:['scores_returned'],student:['results_published'],parent:['results_published','fee_reminder','attendance_alert']};
      var myEvents=ROLE_EVENTS[myRole]||[];
      firebase.database().ref('schools/'+id+'/notifications').orderByChild('createdAt').limitToLast(15).once('value').then(function(snap){
        var items=[];
        snap.forEach(function(c){ var v=c.val(); if(v&&myEvents.indexOf(v.event)>=0&&v.fromRole!==myRole) items.unshift(v); });
        var list=document.getElementById('notif-panel-list');
        if(!list) return;
        if(!items.length){ list.innerHTML='<div style="padding:20px;text-align:center;color:rgba(240,244,255,.3);font-size:.8rem;">No notifications yet</div>'; return; }
        list.innerHTML=items.map(function(n){
          var m=_getNotifMessage(n)||{title:'Notification',body:'',icon:'🔔',type:'info'};
          var colors={info:'#3b82f6',success:'#22c55e',warning:'#f97316',error:'#f43f5e',result:'#8b5cf6',pipeline:'#d4a843'};
          var c=colors[m.type]||colors.info;
          return '<div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;gap:10px;align-items:flex-start;">'+
            '<div style="font-size:1.1rem;">'+m.icon+'</div>'+
            '<div><div style="font-weight:700;font-size:.78rem;color:#f0f4ff;">'+m.title+'</div>'+
            '<div style="font-size:.72rem;color:rgba(240,244,255,.6);margin-top:2px;">'+m.body+'</div>'+
            '<div style="font-size:.65rem;color:rgba(240,244,255,.3);margin-top:3px;">'+new Date(n.createdAt).toLocaleString()+'</div></div></div>';
        }).join('');
      }).catch(function(){});
    }
    // Close on outside click
    setTimeout(function(){
      document.addEventListener('click',function closePanel(e){
        if(!panel.contains(e.target)&&e.target.id!=='notif-bell'){
          panel.remove(); document.removeEventListener('click',closePanel);
        }
      });
    },100);
  }

  // ── HELPERS ───────────────────────────────────────────────
  function _sid(){ return (JSON.parse(localStorage.getItem('rsms_school')||'{}')||{}).schoolId||''; }

  function _urlBase64ToUint8Array(base64String){
    var padding='='.repeat((4-base64String.length%4)%4);
    var base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
    var raw=atob(base64);
    var arr=new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
    return arr;
  }

  // ── PUBLIC API ────────────────────────────────────────────
  return {
    init:              init,
    requestPermission: requestPermission,
    showInApp:         showInApp,
    trigger:           trigger,
    injectBell:        injectBell,
    clearBadge:        clearBadge,
    showNotifPanel:    showNotifPanel
  };
})();

// Auto-init
window.addEventListener('load', function(){
  setTimeout(function(){
    RSMS_NOTIFY.init();
    RSMS_NOTIFY.injectBell();
  }, 1000);
});
