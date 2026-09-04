'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SERVER — application entry (Phase A)

   A staff-only LAN deployment (docs/offline-design.md):
   - serves the existing portal pages with self-hosted assets
   - local staff auth (hashed PINs, HttpOnly sessions, role middleware)
   - local data API over SQLite with a durable sync outbox
   - health/admin page
   Phase B (live): cloud-verified binding, outbox push + snapshot pull,
   Bursar Conflict Review (/conflicts.html) — see server/sync.js.
═══════════════════════════════════════════════════════════════════ */

var path = require('path');
var fs = require('fs');
var http = require('http');
var os = require('os');
var express = require('express');

var dbModule = require('./db');
var auth = require('./auth');
var sync = require('./sync');
var backup = require('./backup');
var updater = require('./updater');
var portals = require('./serve-portals');

var WIZARD_PAGE = require('./wizard-page');

var REPO_ROOT = path.join(__dirname, '..', '..');
var VENDOR_DIR = path.join(__dirname, 'vendor');
var SERVER_VERSION = '0.3.0-phase-c';

var CONFLICTS_PAGE = '<!doctype html><meta charset="utf-8"><title>RSMS — Bursar Conflict Review</title>' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaf2;margin:0;padding:24px}' +
  'h1{font-size:1.15rem}a{color:#8b93a7;font-size:.85rem}' +
  'table{border-collapse:collapse;width:100%;font-size:.85rem}' +
  'td,th{border:1px solid #262a3a;padding:8px;vertical-align:top;text-align:left}' +
  '.money{color:#f59e0b}.local{white-space:pre-wrap;max-width:320px}.btn{padding:8px 12px;border:none;' +
  'border-radius:8px;cursor:pointer;font-weight:700;margin:2px}' +
  '.l{background:#123c2b;color:#86efac}.c{background:#3b1d12;color:#fdba74}' +
  '.done{color:#86efac}p.hint{color:#8b93a7;font-size:.8rem;max-width:720px;line-height:1.5}</style>' +
  '<h1>⚖️ Bursar Conflict Review</h1>' +
  '<p class="hint">Money rows are <b>never auto-merged</b>. For each conflict choose which side wins: ' +
  '<b>Local</b> re-pushes this school appliance&rsquo;s record to the cloud; <b>Cloud</b> adopts the ' +
  'cloud record locally. The original evidence is kept in the audit log either way.</p>' +
  '<table id="t"><tr><th>Collection</th><th>Row</th><th>Reason</th><th>Local</th><th>Cloud</th><th>Created</th><th>Resolve</th></tr></table>' +
  '<p><a href="/health">← health</a></p>' +
  '<script>' +
  'function esc(s){return String(s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}' +
  'function load(){' +
  ' fetch("/api/school/conflicts").then(function(r){return r.json();}).then(function(data){' +
  '  var t=document.getElementById("t");' +
  '  (data.conflicts||[]).forEach(function(c){' +
  '   var tr=document.createElement("tr");' +
  '   var l=c.local_data?JSON.parse(c.local_data):null, cl=c.cloud_data?JSON.parse(c.cloud_data):null;' +
  '   tr.innerHTML="<td>"+esc(c.collection)+"</td><td>"+esc(c.local_id)+"</td><td class=\"money\">"+esc(c.reason||"")+"</td>"+' +
  '    "<td class=\"local\">"+esc(l?JSON.stringify(l):"(none)")+"</td><td class=\"local\">"+esc(cl?JSON.stringify(cl):"(none)")+"</td>"+' +
  '    "<td>"+esc(String(c.created_at).slice(0,16))+"</td><td>"+(c.status==="open"?' +
  '    "<button class=\"btn l\" onclick=\\"res(\\""+esc(c.id)+"\\"",\\"local\\")\\">Local wins</button> "+' +
  '    "<button class=\"btn c\" onclick=\\"res(\\""+esc(c.id)+"\\"",\\"cloud\\")\\">Cloud wins</button>"' +
  '    : "<span class=\\\"done\\\">resolved: "+esc(c.resolution||"")+"</span>")+"</td>";' +
  '   t.appendChild(tr);' +
  '  });' +
  ' }).catch(function(){ alert("Could not load conflicts."); });' +
  '}' +
  'function res(id, resolution){' +
  ' if(!confirm("Confirm: "+resolution+" record wins for this row?")) return;' +
  ' fetch("/api/school/conflicts/"+id+"/resolve",{method:"POST",headers:{"Content-Type":"application/json"},' +
  '  body:JSON.stringify({resolution:resolution})}).then(function(r){return r.json();}).then(function(d){' +
  '   if(d.ok) load(); else alert("Resolution failed: "+(d.error||""));' +
  '  });' +
  '}' +
  'load();' +
  '</script></body>';

function lanAddresses(){
  var out = [];
  Object.keys(os.networkInterfaces()).forEach(function(name){
    (os.networkInterfaces()[name] || []).forEach(function(iface){
      if(iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    });
  });
  return out;
}

/* Free disk space (MB) for the path's volume. Returns null when the
   platform probe fails — the health page then shows "unknown". */
function diskFreeMB(targetPath){
  var child = require('child_process');
  try{
    if(process.platform === 'win32'){
      var letter = String(targetPath || 'C:').replace(/\\/g, '/').charAt(0).toUpperCase();
      var out = child.execSync(
        'wmic logicaldisk where "DeviceID=\'' + letter + ':\'" get FreeSize /value',
        {timeout: 8000}).toString();
      var m = out.match(/FreeSize=(\d+)/);
      return m ? Math.floor(Number(m[1]) / 1024 / 1024) : null;
    }
    var lines = child.execSync('df -Pk ' + JSON.stringify(String(targetPath || '/')),
      {timeout: 8000}).toString().trim().split('\n');
    var fields = lines[lines.length - 1].split(/\s+/);
    return Math.floor(Number(fields[3]) / 1024);
  } catch(e){
    return null;
  }
}

function createApp(options){
  options = options || {};
  var db = options.db || dbModule.openDatabase(options.dbFile ||
    path.join(REPO_ROOT, 'offline', 'data', 'rsms-school.sqlite'));
  var app = express();
  app.disable('x-powered-by');
  app.use(express.json({limit: '8mb'}));

  /* Attach a tiny page sender for 401s on HTML routes. */
  app.response.sendPage = function(payload){
    this.setHeader('Content-Type', 'text/html; charset=utf-8');
    this.send('<!doctype html><meta charset="utf-8"><title>RSMS offline</title>' +
      '<body style="font-family:sans-serif;background:#0b0d12;color:#e8eaf2;display:grid;' +
      'place-items:center;min-height:100vh;margin:0"><div style="text-align:center">' +
      '<div style="font-size:3rem">🔒</div><h1>' + payload.title + '</h1>' +
      '<p>' + payload.body + '</p><p><a href="/staff-login.html" style="color:#d4a843">→ Staff sign in</a></p></div>');
  };

  function serverConfig(){
    var b = sync.binding(db);
    return {
      mode: 'lan',
      server: '',
      version: SERVER_VERSION,
      schoolId: b ? b.schoolId : '',
      schoolName: b ? (b.schoolName || '') : '',
      syncEnabled: false,
      syncNote: 'Phase A: local storage only; cloud sync arrives in Phase B'
    };
  }

  /* ── LAN adapter + vendor assets ─────────────────────────────── */
  app.get('/adapter.js', function(req, res){
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', 'rsms-local-adapter.js'));
  });
  app.use('/vendor', express.static(VENDOR_DIR, {maxAge: '7d'}));

  /* ── First-run bootstrap (staff-only, no binding required yet) ── */
  app.post('/api/bootstrap', function(req, res){
    var userCount = db.prepare('SELECT COUNT(*) AS n FROM local_users').get().n;
    if(userCount > 0) return res.status(409).json({error:'already-bootstrapped'});
    var username = String((req.body || {}).username || '').trim();
    var displayName = String((req.body || {}).displayName || '').trim();
    var role = String((req.body || {}).role || '').trim().toLowerCase();
    var pin = String((req.body || {}).pin || '');
    if(username.length < 3 || username.length > 64) return res.status(400).json({error:'username must be 3-64 chars'});
    if(auth.ALLOWED_ROLES.indexOf(role) < 0){
      return res.status(400).json({error:'invalid role'});
    }
    if(pin.length < 4 || pin.length > 12) return res.status(400).json({error:'PIN must be 4-12 characters'});
    var h = auth.hashCredential(pin);
    var stamp = dbModule.nowIso();
    dbModule.withTransaction(db, function(){
      db.prepare(
        'INSERT INTO local_users (username, display_name, role, credential_hash, salt, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?)'
      ).run(username, displayName || username, role, h.hash, h.salt, stamp, stamp);
      dbModule.metaSet(db, 'bootstrap_pending', '1');
      dbModule.metaSet(db, 'created_at', stamp);
    });
    res.json({ok: true, temporaryAdmin: true});
  });

  /* ── Auth ────────────────────────────────────────────────────── */
  app.post('/api/auth/login', function(req, res){
    var username = String((req.body || {}).username || '').trim();
    var pin = String((req.body || {}).pin || '');
    var user = db.prepare('SELECT * FROM local_users WHERE username = ?').get(username);
    if(!user || !auth.verifyCredential(pin, user.credential_hash, user.salt)){
      return res.status(401).json({error:'invalid credentials'});
    }
    var token = auth.createSession(db, user.username, user.role);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, req.secure));
    var bb = sync.binding(db);
    res.json({ok: true, username: user.username, role: user.role,
      displayName: user.display_name,
      bound: !!(bb && bb.schoolId),
      bootstrapPending: dbModule.metaGet(db, 'bootstrap_pending') === '1'});
  });

  app.post('/api/auth/logout', function(req, res){
    var session = auth.readSession(db, req.headers.cookie);
    if(session) auth.revokeSession(db, session.token);
    res.setHeader('Set-Cookie', auth.clearSessionCookie());
    res.json({ok: true});
  });

  app.post('/api/auth/change-credential', auth.requireAuth(db), function(req, res){
    var oldPin = String((req.body || {}).oldPin || '');
    var newPin = String((req.body || {}).newPin || '');
    var user = db.prepare('SELECT * FROM local_users WHERE username = ?').get(req.staff.username);
    if(!user || !auth.verifyCredential(oldPin, user.credential_hash, user.salt)){
      return res.status(401).json({error:'invalid credentials'});
    }
    if(newPin.length < 4 || newPin.length > 12) return res.status(400).json({error:'PIN must be 4-12 characters'});
    var h = auth.hashCredential(newPin);
    db.prepare('UPDATE local_users SET credential_hash = ?, salt = ?, updated_at = ? WHERE username = ?')
      .run(h.hash, h.salt, dbModule.nowIso(), user.username);
    auth.revokeAllForUser(db, user.username);
    if(dbModule.metaGet(db, 'bootstrap_pending') === '1'){
      dbModule.metaSet(db, 'bootstrap_pending', '0');
    }
    var token = auth.createSession(db, user.username, user.role);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, req.secure));
    res.json({ok: true, credentialChanged: true});
  });

  /* ── Staff login accounts (LAN sign-in management) ─────────── */
  app.get('/api/admin/users', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    var rows = db.prepare('SELECT username, display_name, role, created_at FROM local_users ORDER BY created_at, username').all();
    res.json({users: rows.map(function(u){
      return {username: u.username, displayName: u.display_name, role: u.role, createdAt: u.created_at};
    })});
  });

  app.post('/api/admin/users', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    var b = req.body || {};
    var username = String(b.username || '').trim();
    var displayName = String(b.displayName || '').trim();
    var role = String(b.role || '').trim().toLowerCase();
    var pin = String(b.pin || '');
    if(username.length < 3 || username.length > 64) return res.status(400).json({error:'username must be 3-64 chars'});
    if(!/^[a-zA-Z0-9._-]+$/.test(username)) return res.status(400).json({error:'username may contain letters, numbers, dots, dashes'});
    if(auth.ALLOWED_ROLES.indexOf(role) < 0) return res.status(400).json({error:'invalid role'});
    if(pin.length < 4 || pin.length > 12) return res.status(400).json({error:'PIN must be 4-12 characters'});
    var existing = db.prepare('SELECT username FROM local_users WHERE username = ?').get(username);
    if(existing) return res.status(409).json({error:'username already exists'});
    var h = auth.hashCredential(pin);
    var stamp = dbModule.nowIso();
    db.prepare(
      'INSERT INTO local_users (username, display_name, role, credential_hash, salt, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?)'
    ).run(username, displayName || username, role, h.hash, h.salt, stamp, stamp);
    res.json({ok: true, username: username, role: role});
  });

  app.put('/api/admin/users/:username', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    var user = db.prepare('SELECT * FROM local_users WHERE username = ?').get(req.params.username);
    if(!user) return res.status(404).json({error:'user not found'});
    var b = req.body || {};
    if(b.pin === undefined){
      return res.status(400).json({error:'pin required'});
    }
    var pin = String(b.pin || '');
    if(pin.length < 4 || pin.length > 12) return res.status(400).json({error:'PIN must be 4-12 characters'});
    var h = auth.hashCredential(pin);
    db.prepare('UPDATE local_users SET credential_hash = ?, salt = ?, updated_at = ? WHERE username = ?')
      .run(h.hash, h.salt, dbModule.nowIso(), user.username);
    auth.revokeAllForUser(db, user.username);
    res.json({ok: true, username: user.username});
  });

  function requireBound(){
    return function(req, res, next){
      var b = sync.binding(db);
      if(!b || !b.schoolId) return res.status(409).json({error:'not-bound', hint:'complete first-run setup'});
      req.binding = b;
      next();
    };
  }

  app.get('/api/whoami', function(req, res){
    var session = auth.readSession(db, req.headers.cookie);
    if(!session) return res.status(401).json({error:'unauthenticated'});
    res.json({username: session.username, role: session.role});
  });

  /* ── Staff login page (LAN entry point) ──────────────────────── */
  function escHtml(s){
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  app.get('/staff-login.html', function(req, res){
    var b = sync.binding(db);
    var bootstrapped = db.prepare('SELECT COUNT(*) AS n FROM local_users').get().n > 0;
    var sub = !bootstrapped
      ? 'First run: create the first staff account below, then sign in with it.'
      : (b
        ? 'School: <b>' + escHtml(b.schoolId) + '</b>'
        : 'School not bound yet — after signing in you will be taken to the first-run wizard.');
    var html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>RSMS Staff Sign In</title>' +
      '<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaf2;display:grid;place-items:center;min-height:100vh;margin:0}' +
      'div.card{background:#12141d;border:1px solid #262a3a;border-radius:14px;padding:28px;width:min(92vw,380px)}' +
      'h1{font-size:1.05rem;margin:0 0 4px}p.sub{color:#8b93a7;font-size:.8rem;margin:0 0 18px}' +
      'input{width:100%;box-sizing:border-box;background:#0b0d12;border:1px solid #262a3a;color:#e8eaf2;' +
      'border-radius:10px;padding:12px;margin-bottom:12px;font-size:.95rem}' +
      'button{width:100%;background:linear-gradient(135deg,#4a2500,#d4a843);border:none;border-radius:10px;' +
      'padding:13px;font-weight:700;color:#000;cursor:pointer;font-size:.95rem;margin-bottom:4px}' +
      '.err{color:#f87171;font-size:.8rem;min-height:1.2em;margin-bottom:8px}' +
      '.ok{color:#86efac;font-size:.8rem;min-height:1.2em;margin-bottom:8px}' +
      '.bshead{color:#d4a843;font-size:.8rem;margin:0 0 10px;font-weight:600}' +
      'hr.sep{border:none;border-top:1px solid #262a3a;margin:16px 0}</style>' +
      '<div class="card"><h1>🏫 RSMS — Staff Sign In</h1>' +
      '<p class="sub">' + sub + '</p>' +
      (!bootstrapped
        ? '<p class="bshead">Create the first staff account (school admin)</p>' +
          '<input id="bu" autocomplete="username" placeholder="Staff username (3-64 chars)"/>' +
          '<input id="bn" placeholder="Full name (optional)"/>' +
          '<input id="bp" type="password" autocomplete="new-password" placeholder="PIN (4-12 characters)"/>' +
          '<input id="bp2" type="password" autocomplete="new-password" placeholder="Repeat PIN"/>' +
          '<button id="bsgo">Create account</button><hr class="sep">'
        : '') +
      '<div class="ok" id="ok"></div>' +
      '<div class="err" id="err"></div>' +
      '<input id="u" autocomplete="username" placeholder="Staff username"/>' +
      '<input id="p" type="password" autocomplete="current-password" placeholder="PIN"/>' +
      '<button id="go">Sign in</button></div>' +
      '<script>' +
      'function showErr(m){document.getElementById("err").textContent=m;document.getElementById("ok").textContent="";}' +
      'function go(){' +
      ' var err=document.getElementById("err");err.textContent="";' +
      ' fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},' +
      '  body:JSON.stringify({username:document.getElementById("u").value,pin:document.getElementById("p").value})' +
      ' }).then(function(r){return r.json().catch(function(){return{}}).then(function(d){if(!r.ok)throw d;return d;});})' +
      '.then(function(d){' +
      ' var pages={admin:"/rsms-admin.html",bursar:"/rsms-bursar.html",teacher:"/rsms-teacher.html",' +
      ' classteacher:"/rsms-classteacher.html",hod:"/rsms-hod.html",vp:"/rsms-vp.html",' +
      ' principal:"/rsms-principal.html",superadmin:"/rsms-superadmin.html"};' +
      ' location.href=d.bound?(pages[d.role]||"/"):"/wizard.html";})' +
      '.catch(function(d){showErr((d&&(d.error))?"Sign-in failed — check username and PIN.":"Sign-in failed.");});' +
      '}' +
      'document.getElementById("go").onclick=go;' +
      'document.getElementById("p").onkeydown=function(e){if(e.key==="Enter")go();};' +
      (bootstrapped ? '' :
      'document.getElementById("bsgo").onclick=function(){' +
      ' var err=document.getElementById("err"),ok=document.getElementById("ok");err.textContent="";' +
      ' if(document.getElementById("bp").value!==document.getElementById("bp2").value){showErr("PINs do not match.");return;}' +
      ' fetch("/api/bootstrap",{method:"POST",headers:{"Content-Type":"application/json"},' +
      '  body:JSON.stringify({username:document.getElementById("bu").value,displayName:document.getElementById("bn").value,role:"admin",pin:document.getElementById("bp").value})' +
      ' }).then(function(r){return r.json().catch(function(){return{}}).then(function(d){if(!r.ok)throw d;return d;});})' +
      '.then(function(){ok.textContent="Account created — sign in below with it.";' +
      ' document.getElementById("bu").value="";document.getElementById("bn").value="";' +
      ' document.getElementById("bp").value="";document.getElementById("bp2").value="";}).' +
      'catch(function(d){showErr((d&&(d.error))?d.error:"Could not create account.");});' +
      '};' +
      'document.getElementById("bp2").onkeydown=function(e){if(e.key==="Enter")document.getElementById("bsgo").onclick();};') +
      '</script></body>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  /* ── First-run binding ───────────────────────────────────────── */
  app.post('/api/setup/bind', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    var body = req.body || {};
    var schoolCode = String(body.schoolCode || '').trim();
    var schoolId = String(body.schoolId || '').trim();
    var token = String(body.serverToken || '').trim();
    var cloudBase = String(body.cloudBaseUrl || '').trim();
    if(!schoolCode) return res.status(400).json({error:'schoolCode required'});
    if(db.prepare('SELECT COUNT(*) AS n FROM local_users').get().n === 0){
      return res.status(409).json({error:'bootstrap a staff account first'});
    }
    var existing = sync.binding(db);
    if(existing && existing.schoolCode && existing.schoolCode !== schoolCode){
      return res.status(409).json({error:'bound-to-different-school'});
    }
    var finalSchoolId = schoolId || schoolCode;
    var finishLocal = function(cloudValidated, verified){
      sync.setBinding(db, {
        schoolCode: schoolCode,
        schoolId: finalSchoolId,
        schoolName: String(body.schoolName || (verified && verified.schoolName) || ''),
        installationId: (verified && verified.installationId) || '',
        cloudValidated: cloudValidated
      });
      if(cloudValidated){
        sync.setServerToken(db, token);
        sync.setCloudBaseUrl(db, cloudBase);
      }
      res.json({ok: true, cloudValidated: cloudValidated,
        note: cloudValidated
          ? 'Cloud binding validated — sync is active.'
          : 'Local binding only — sync stays paused until cloud validation.'});
    };
    /* Production cloud bases are https (Firebase). http is tolerated so
       operators can validate against an emulator before first go-live. */
    if(!token || !/^https?:\/\//.test(cloudBase)){
      return finishLocal(false, null);
    }
    sync.setCloudBaseUrl(db, cloudBase);
    sync.cloudVerify(db, finalSchoolId, token).then(function(verified){
      if(verified && verified.ok && (!verified.schoolId || verified.schoolId === finalSchoolId)){
        finishLocal(true, verified);
      } else {
        res.status(400).json({error:'cloud verification failed',
          detail: verified && verified.error || 'unknown installation'});
      }
    }).catch(function(error){
      res.status(400).json({error:'cloud verification failed',
        detail: String((error && error.message) || error)});
    });
  });

  app.get('/api/setup/status', function(req, res){
    var b = sync.binding(db);
    res.json({
      bootstrapped: db.prepare('SELECT COUNT(*) AS n FROM local_users').get().n > 0,
      bootstrapPending: dbModule.metaGet(db, 'bootstrap_pending') === '1',
      bound: !!b,
      binding: b,
      version: SERVER_VERSION,
      schemaVersion: dbModule.SCHEMA_VERSION
    });
  });

  /* ── Staff data API (bound school only) ──────────────────────── */
  var COLLECTIONS = ['students','staff','fees','payments','wallet','audit_log',
    'attendance','score_entries','expenses','fee_structures','student_fees',
    'recurring','recurring_schedule','broadcasts','notifications','ct_remarks',
    'fee_schedule','stream_config','portal_pins','clock_logs','assignments',
    'flw_config','settings'];

  app.get('/api/school/collections', auth.requireAuth(db), requireBound(), function(req, res){
    var all = {};
    COLLECTIONS.forEach(function(c){
      all[c] = dbModule.readCollection(db, c);
    });
    res.json({schoolId: req.binding.schoolId, collections: all, outbox: sync.outboxStatus(db)});
  });

  app.get('/api/school/collections/:key', auth.requireAuth(db), requireBound(), function(req, res){
    var key = req.params.key;
    if(COLLECTIONS.indexOf(key) < 0) return res.status(404).json({error:'unknown collection'});
    res.json({collection: key, rows: dbModule.readCollection(db, key)});
  });

  app.put('/api/school/collections/:key', auth.requireAuth(db), requireBound(), function(req, res){
    if(!backup.guardMaintenance(db, res)) return;
    var key = req.params.key;
    if(COLLECTIONS.indexOf(key) < 0) return res.status(404).json({error:'unknown collection'});
    var value = (req.body || {}).rows !== undefined ? req.body.rows : (req.body || {});
    try{
      var changed = dbModule.saveCollection(db, req.binding.schoolId, key, value, req.staff.username);
      res.json({ok: true, changed: changed.length, outbox: sync.outboxStatus(db)});
    }catch(e){
      res.status(400).json({error: 'save failed: ' + e.message});
    }
  });

  app.get('/api/school/outbox', auth.requireAuth(db, ['admin','bursar','superadmin']), requireBound(), function(req, res){
    var pending = db.prepare(
      'SELECT id, collection, local_id, action, status, attempts, last_error, created_at ' +
      'FROM outbox WHERE status IN (\'pending\', \'in_flight\') ORDER BY created_at LIMIT 200').all();
    res.json({status: sync.outboxStatus(db), entries: pending});
  });

  /* Run one full sync cycle (push outbox, then pull + merge). */
  app.post('/api/school/sync/run', auth.requireAuth(db, ['admin','superadmin']), requireBound(), function(req, res){
    sync.runSyncCycle(db).then(function(result){
      res.json({ok: true, cycle: result, outbox: sync.outboxStatus(db)});
    });
  });

  /* ── Bursar Conflict Review ──────────────────────────────────── */
  app.get('/api/school/conflicts', auth.requireAuth(db), requireBound(), function(req, res){
    res.json({conflicts: sync.listConflicts(db)});
  });

  app.post('/api/school/conflicts/:id/resolve', auth.requireAuth(db, ['admin','bursar','superadmin']), requireBound(), function(req, res){
    if(!backup.guardMaintenance(db, res)) return;
    var resolution = String((req.body || {}).resolution || '').trim().toLowerCase();
    var result = sync.resolveConflict(db, req.binding.schoolId, req.params.id, resolution, req.staff.username);
    if(!result.ok) return res.status(result.error === 'not-found' ? 404 : 400).json({error: result.error});
    res.json(result);
  });

  app.get('/conflicts.html', auth.requireAuth(db), function(req, res){
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(CONFLICTS_PAGE);
  });

  /* ── First-run network wizard (Phase C) ─────────────────────── */
  app.get('/api/wizard/info', auth.requireAuth(db), function(req, res){
    var ifaces = os.networkInterfaces();
    var macs = {};
    Object.keys(ifaces).forEach(function(name){
      (ifaces[name] || []).forEach(function(i){
        if(i.family === 'IPv4' && !i.internal) macs[i.address] = i.mac;
      });
    });
    var port = Number(process.env.PORT || 8300);
    res.json({
      version: SERVER_VERSION,
      schemaVersion: dbModule.SCHEMA_VERSION,
      hostname: os.hostname(),
      port: port,
      lan: lanAddresses().map(function(ip){
        return {ip: ip, mac: macs[ip] || null, portalUrl: 'http://' + ip + ':' + port + '/staff-login.html'};
      }),
      binding: sync.binding(db),
      inMigration: dbModule.inMigration(db),
      maintenance: backup.inMaintenance(db),
      pendingRestart: updater.pendingRestart(db),
      backup: {
        dir: backup.backupDir(db),
        retain: Number(dbModule.metaGet(db, 'backup_retain') || 7),
        last: dbModule.metaGet(db, 'last_backup_at'),
        count: backup.listBackups(db).length
      },
      diskFreeMB: diskFreeMB(backup.backupDir(db))
    });
  });

  app.get('/wizard.html', auth.requireAuth(db), function(req, res){
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(WIZARD_PAGE);
  });

  /* ── Admin operations: backups, restore, update, restart, diag ── */
  app.get('/api/admin/backups', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    res.json({dir: backup.backupDir(db), backups: backup.listBackups(db)});
  });

  app.post('/api/admin/backups/config', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    var body = req.body || {};
    var result = {};
    if(body.dir) result.dir = backup.setBackupDir(db, String(body.dir));
    if(body.retain) result.retain = Number(backup.setBackupRetain(db, body.retain));
    res.json({ok: true, dir: backup.backupDir(db),
      retain: Number(dbModule.metaGet(db, 'backup_retain') || 7)});
  });

  app.post('/api/admin/backup', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    try{
      var body = req.body || {};
      var opts = {};
      if(body.dir) opts.dir = String(body.dir);
      if(body.suffix) opts.suffix = String(body.suffix).slice(0, 32);
      var record = backup.createBackup(db, opts);
      res.json({ok: true, backup: record});
    }catch(e){
      res.status(500).json({error: 'backup failed: ' + e.message});
    }
  });

  app.post('/api/admin/backups/:name/restore', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    try{
      var body = req.body || {};
      var result = backup.restoreBackup(db, req.params.name, {
        schoolCode: String(body.schoolCode || '').trim(),
        createdAt: String(body.createdAt || '').trim()
      });
      res.json(result);
    }catch(e){
      res.status(400).json({error: e.message});
    }
  });

  app.post('/api/admin/update', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    if(!backup.guardMaintenance(db, res)) return;
    try{
      var dir = String((req.body || {}).releaseDir || '');
      if(!dir) return res.status(400).json({error: 'releaseDir required'});
      var result = updater.applyRelease(dir, {db: db});
      res.json(result);
    }catch(e){
      res.status(400).json({error: e.message});
    }
  });

  app.post('/api/admin/restart', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    var child = require('child_process');
    res.json({ok: true,
      note: process.platform === 'win32'
        ? 'restarting the RSMS Offline service'
        : 'exiting; the supervisor (NSSM/foreground) will restart it'});
    setTimeout(function(){
      try{
        if(process.platform === 'win32'){
          child.spawn('nssm', ['restart', 'RSMSOffline'], {detached: true, stdio: 'ignore'}).unref();
          setTimeout(function(){ process.exit(0); }, 500);
        } else {
          process.exit(0);
        }
      }catch(e){
        process.exit(0);
      }
    }, 300);
  });

  function diagBundle(){
    var b = sync.binding(db);
    return {
      generatedAt: dbModule.nowIso(),
      server: {
        version: SERVER_VERSION,
        schemaVersion: dbModule.SCHEMA_VERSION,
        schemaCurrent: !dbModule.inMigration(db),
        hostname: os.hostname(),
        uptimeSec: Math.round(process.uptime()),
        bootedAt: dbModule.metaGet(db, 'booted_at'),
        bootCount: Number(dbModule.metaGet(db, 'boot_count') || 0),
        appliedVersion: dbModule.metaGet(db, 'applied_version'),
        pendingRestart: updater.pendingRestart(db)
      },
      school: {
        schoolCode: b ? b.schoolCode : null,
        schoolId: b ? b.schoolId : null,
        schoolName: b ? b.schoolName : null,
        installationId: b ? b.installationId : null,
        cloudValidated: b ? b.cloudValidated : false
      },
      sync: {
        outbox: sync.outboxStatus(db),
        lastCloudSyncAt: sync.outboxStatus(db).lastCloudSyncAt
      },
      conflicts: sync.listConflicts(db, 100).map(function(c){
        return {id: c.id, collection: c.collection, localId: c.local_id,
          reason: c.reason || null, status: c.status, resolution: c.resolution,
          resolvedAt: c.resolved_at};
      }),
      backups: {
        dir: backup.backupDir(db),
        retain: Number(dbModule.metaGet(db, 'backup_retain') || 7),
        last: dbModule.metaGet(db, 'last_backup_at'),
        lastRestoreAt: dbModule.metaGet(db, 'last_restore_at'),
        count: backup.listBackups(db).length
      },
      diskFreeMB: diskFreeMB(backup.backupDir(db)),
      lan: lanAddresses(),
      auditRecent: db.prepare(
        'SELECT actor, action, entity, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT 50').all(),
      outboxErrors: db.prepare(
        'SELECT collection, local_id, status, attempts, last_error, created_at FROM outbox ' +
        'WHERE last_error IS NOT NULL AND last_error <> \'\' ORDER BY created_at DESC LIMIT 20').all()
    };
  }

  app.get('/api/admin/diag', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    res.json(diagBundle());
  });

  app.get('/api/admin/diag.download', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    var b = sync.binding(db);
    var stamp = backup.stamp();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition',
      'attachment; filename="rsms-support-' + (b ? b.schoolCode : 'unbound') + '-' + stamp + '.json"');
    res.json(diagBundle());
  });

  /* ── Health / admin page ─────────────────────────────────────── */
  app.get('/health', function(req, res){
    var b = sync.binding(db);
    var s = sync.outboxStatus(db);
    var users = db.prepare('SELECT username, role FROM local_users').all();
    var body = '<!doctype html><meta charset="utf-8"><title>RSMS offline health</title>' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaf2;margin:0;padding:24px">' +
      '<h1 style="font-size:1.2rem">🏫 RSMS Offline Server</h1>' +
      '<p style="color:#8b93a7;font-size:.85rem">version ' + SERVER_VERSION +
      ' · schema v' + dbModule.SCHEMA_VERSION + '</p>' +
      '<table style="border-collapse:collapse;font-size:.9rem">' +
      '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">Bound school</td><td>' +
      (b ? b.schoolId + (b.cloudValidated ? ' (cloud validated)' : ' (local binding — cloud validation pending)') : '<b style="color:#f59e0b">NOT BOUND — run first setup</b>') +
      '</td></tr>' +
      '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">Staff accounts</td><td>' +
      (users.map(function(u){ return u.username + ' (' + u.role + ')'; }).join(', ') || 'none') + '</td></tr>' +
      '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">Outbox</td><td>' +
      JSON.stringify(s.byStatus) + ' · open conflicts: ' + s.openConflicts +
      (s.openConflicts ? ' — <a href="/conflicts.html" style="color:#f59e0b">review in Bursar Conflict Review</a>' : '') + '</td></tr>' +
      '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">Last cloud sync</td><td>' +
      (s.lastCloudSyncAt || 'never (Phase B)') + '</td></tr>' +
      '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">Backups</td><td>' +
      (dbModule.metaGet(db, 'last_backup_at')
        ? dbModule.metaGet(db, 'last_backup_at') + ' (' + backup.listBackups(db).length + ' kept, latest ' +
          (dbModule.metaGet(db, 'last_backup_name') || '') + ')'
        : '<b style="color:#f59e0b">never — run the first-run wizard or POST /api/admin/backup</b>') +
      (dbModule.metaGet(db, 'last_restore_at')
        ? ' · last restore ' + dbModule.metaGet(db, 'last_restore_at') : '') + '</td></tr>' +
      (function(){
        var free = diskFreeMB(backup.backupDir(db));
        if(free === null) return '';
        var warn = free < 1024 ? ' style="color:#fca5a5"' : (free < 3072 ? ' style="color:#f59e0b"' : '');
        return '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">Disk free</td><td' + warn + '>' +
          Math.round(free / 1024 * 10) / 10 + ' GB' +
          (free < 1024 ? ' — <b>almost full: free space or prune old backups</b>' : '') + '</td></tr>';
      })() +
      '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">Service</td><td>' +
      'boot ' + (dbModule.metaGet(db, 'boot_count') || 1) +
      ' at ' + (dbModule.metaGet(db, 'booted_at') || '?') +
      (dbModule.metaGet(db, 'applied_version') ? ' · v' + dbModule.metaGet(db, 'applied_version') : '') +
      (updater.pendingRestart(db) ? ' · <b style="color:#f59e0b">restart pending (update applied)</b>' : '') +
      (backup.inMaintenance(db) ? ' · <b style="color:#fca5a5">RESTORE IN PROGRESS — writes paused</b>' : '') +
      (dbModule.inMigration(db) ? ' · <b style="color:#fca5a5">SCHEMA MIGRATION PENDING</b>' : '') +
      '</td></tr>' +
      '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">LAN addresses</td><td>' +
      lanAddresses().join(', ') + ' — staff portal: http://&lt;ip&gt;:' + (process.env.PORT || 8300) + '/staff-login.html · ' +
      '<a href="/wizard.html" style="color:#8b93a7">first-run wizard</a></td></tr>' +
      '</table>' +
      '<p style="color:#8b93a7;font-size:.8rem">Card payments are cloud-only: offline the portal records cash / bank transfer as <i>Sync pending</i>.</p>' +
      '</body>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(body);
  });

  app.get('/api/health', function(req, res){
    res.json({ok: true, version: SERVER_VERSION, binding: sync.binding(db),
      outbox: sync.outboxStatus(db), lanAddresses: lanAddresses()});
  });

  /* ── LAN entry: send everyone to the staff entry point.
     The public landing page (school search) and the cloud email
     login (rsms-login.html) are cloud-only flows — on a LAN
     appliance they confuse staff. Signed-in staff go straight to
     their role page; everyone else goes to the PIN sign-in. */
  var ROLE_PAGES = {
    admin: '/rsms-admin.html', bursar: '/rsms-bursar.html',
    teacher: '/rsms-teacher.html', classteacher: '/rsms-classteacher.html',
    hod: '/rsms-hod.html', vp: '/rsms-vp.html',
    principal: '/rsms-principal.html', superadmin: '/rsms-superadmin.html'
  };
  function staffEntry(req, res){
    var session = auth.readSession(db, req.headers.cookie);
    var b = sync.binding(db);
    if(session && b && b.schoolId && ROLE_PAGES[session.role]){
      return res.redirect(ROLE_PAGES[session.role]);
    }
    return res.redirect('/staff-login.html');
  }
  app.get('/', staffEntry);
  app.get('/rsms-login.html', staffEntry);

  /* Portal pages require a valid LAN session. Without this gate the
     pages open for anyone on the LAN and "logout" is cosmetic — the
     session cookie survives and every portal stays reachable. */
  app.use(function portalSessionGate(req, res, next){
    if(req.method !== 'GET' && req.method !== 'HEAD') return next();
    var p = (req.url || '/').split('?')[0];
    if(!/^\/rsms-[a-z0-9_-]+\.html$/i.test(p)) return next();
    if(auth.readSession(db, req.headers.cookie)) return next();
    res.redirect('/staff-login.html');
  });

  /* ── Portals (rewritten + adapter-injected) ──────────────────── */
  app.use(portals.portalMiddleware(REPO_ROOT, serverConfig()));

  /* 404 */
  app.use(function(req, res){ res.status(404).json({error:'not found'}); });

  app.locals.db = db;
  return app;
}

function start(){
  var port = Number(process.env.PORT || 8300);
  var db = dbModule.openDatabase(path.join(REPO_ROOT, 'offline', 'data', 'rsms-school.sqlite'));

  /* Boot tracking: the health page makes service restarts obvious. */
  var boots = Number(dbModule.metaGet(db, 'boot_count') || 0) + 1;
  dbModule.metaSet(db, 'boot_count', String(boots));
  dbModule.metaSet(db, 'booted_at', dbModule.nowIso());

  /* A signed update was applied while we were down: record it as a
     clean boot, then clear the restart flag. */
  var pending = updater.pendingRestart(db);
  if(pending){
    dbModule.metaSet(db, 'applied_version', pending.version);
    updater.clearPendingRestart(db);
  }

  var app = createApp({db: db});
  var server = http.createServer(app);
  var interval = Number(process.env.SYNC_INTERVAL_MS || 60000);
  if(interval > 0) sync.startSyncLoop(db, interval);

  /* Nightly verified backup (Phase C): default 03:15 local time. */
  var backupEnabled = String(process.env.BACKUP_ENABLED !== undefined
    ? process.env.BACKUP_ENABLED : '1').toLowerCase();
  if(backupEnabled !== '0' && backupEnabled !== 'false'){
    var hour = Number(process.env.BACKUP_HOUR || 3);
    var minute = Number(process.env.BACKUP_MINUTE || 15);
    var timer = null;
    function scheduleNext(){
      var now = new Date();
      var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
      if(next <= now) next.setDate(next.getDate() + 1);
      timer = setTimeout(function(){
        try{
          var record = backup.createBackup(db);
          console.log('[backup] nightly verified backup: ' + record.name);
        }catch(e){
          console.error('[backup] nightly backup failed: ' + e.message);
        }
        scheduleNext();
      }, next - now);
      if(timer.unref) timer.unref();
    }
    scheduleNext();
  }
  server.listen(port, '0.0.0.0', function(){
    console.log('RSMS offline server v' + SERVER_VERSION + ' listening on 0.0.0.0:' + port);
    console.log('Staff portal: http://<LAN-IP>:' + port + '/staff-login.html   Health: http://<LAN-IP>:' + port + '/health');
    console.log('Conflict review: http://<LAN-IP>:' + port + '/conflicts.html (staff session required)');
    console.log('Sync loop: every ' + interval + 'ms (no-op until cloud binding is validated).');
    console.log('Note: LAN-only deployment — no internet route, no parent portal.');
  });
  return {server: server, db: db};
}

if(require.main === module) start();

module.exports = {createApp: createApp, start: start};
