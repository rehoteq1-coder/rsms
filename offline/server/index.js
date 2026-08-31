'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SERVER — application entry (Phase A)

   A staff-only LAN deployment (docs/offline-design.md):
   - serves the existing portal pages with self-hosted assets
   - local staff auth (hashed PINs, HttpOnly sessions, role middleware)
   - local data API over SQLite with a durable sync outbox
   - health/admin page
   The cloud sync direction is Phase B (sync.js stub).
═══════════════════════════════════════════════════════════════════ */

var path = require('path');
var fs = require('fs');
var http = require('http');
var os = require('os');
var express = require('express');

var dbModule = require('./db');
var auth = require('./auth');
var sync = require('./sync');
var portals = require('./serve-portals');

var REPO_ROOT = path.join(__dirname, '..', '..');
var VENDOR_DIR = path.join(__dirname, 'vendor');
var SERVER_VERSION = '0.1.0-phase-a';

function lanAddresses(){
  var out = [];
  Object.keys(os.networkInterfaces()).forEach(function(name){
    (os.networkInterfaces()[name] || []).forEach(function(iface){
      if(iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    });
  });
  return out;
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
      '<p>' + payload.body + '</p><p><a href="/login.html" style="color:#d4a843">→ Staff sign in</a></p></div>');
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
    res.json({ok: true, username: user.username, role: user.role,
      displayName: user.display_name, bootstrapPending: dbModule.metaGet(db, 'bootstrap_pending') === '1'});
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
  app.get('/staff-login.html', function(req, res){
    var b = sync.binding(db);
    var html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>RSMS Staff Sign In</title>' +
      '<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaf2;display:grid;place-items:center;min-height:100vh;margin:0}' +
      'div{background:#12141d;border:1px solid #262a3a;border-radius:14px;padding:28px;width:min(92vw,360px)}' +
      'h1{font-size:1.05rem;margin:0 0 4px}p{color:#8b93a7;font-size:.8rem;margin:0 0 18px}' +
      'input{width:100%;box-sizing:border-box;background:#0b0d12;border:1px solid #262a3a;color:#e8eaf2;' +
      'border-radius:10px;padding:12px;margin-bottom:12px;font-size:.95rem}' +
      'button{width:100%;background:linear-gradient(135deg,#4a2500,#d4a843);border:none;border-radius:10px;' +
      'padding:13px;font-weight:700;color:#000;cursor:pointer;font-size:.95rem}' +
      '.err{color:#f87171;font-size:.8rem;min-height:1.2em;margin-bottom:8px}</style>' +
      '<div><h1>🏫 RSMS — Staff Sign In</h1>' +
      '<p>' + (b ? ('School: <b>' + b.schoolId + '</b>') : 'School not bound yet — run setup first.') + '</p>' +
      '<div class="err" id="err"></div>' +
      '<input id="u" autocomplete="username" placeholder="Staff username"/>' +
      '<input id="p" type="password" autocomplete="current-password" placeholder="PIN"/>' +
      '<button id="go">Sign in</button></div>' +
      '<script>' +
      'function go(){' +
      ' var err=document.getElementById("err");err.textContent="";' +
      ' fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},' +
      '  body:JSON.stringify({username:document.getElementById("u").value,pin:document.getElementById("p").value})' +
      ' }).then(function(r){return r.json().catch(function(){return{}}).then(function(d){if(!r.ok)throw d;return d;});})' +
      '.then(function(){location.href="/";})' +
      '.catch(function(d){err.textContent=(d&&(d.error))?"Sign-in failed — check username and PIN.":"Sign-in failed.";});' +
      '}' +
      'document.getElementById("go").onclick=go;' +
      'document.getElementById("p").onkeydown=function(e){if(e.key==="Enter")go();};' +
      '</script></body>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  /* ── First-run binding ───────────────────────────────────────── */
  app.post('/api/setup/bind', auth.requireAuth(db, ['admin','superadmin']), function(req, res){
    var schoolCode = String((req.body || {}).schoolCode || '').trim();
    var schoolId = String((req.body || {}).schoolId || '').trim();
    if(!schoolCode) return res.status(400).json({error:'schoolCode required'});
    if(db.prepare('SELECT COUNT(*) AS n FROM local_users').get().n === 0){
      return res.status(409).json({error:'bootstrap a staff account first'});
    }
    var existing = sync.binding(db);
    if(existing && existing.schoolCode && existing.schoolCode !== schoolCode){
      return res.status(409).json({error:'bound-to-different-school'});
    }
    sync.setBinding(db, {
      schoolCode: schoolCode,
      schoolId: schoolId || schoolCode,
      cloudValidated: false, // Phase B: validated by registerOfflineServer
      schoolName: String((req.body || {}).schoolName || '')
    });
    res.json({ok: true, cloudValidated: false,
      note: 'Cloud validation arrives with Phase B; sync stays paused until then.'});
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

  /* Phase B stub — reports that the cloud direction is not live yet. */
  app.post('/api/school/sync/run', auth.requireAuth(db, ['admin','superadmin']), requireBound(), function(req, res){
    sync.pushOutbox(db).then(function(pushResult){
      sync.pullFromCloud(db).then(function(pullResult){
        res.json({ok: true, push: pushResult, pull: pullResult});
      });
    });
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
      JSON.stringify(s.byStatus) + ' · open conflicts: ' + s.openConflicts + '</td></tr>' +
      '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">Last cloud sync</td><td>' +
      (s.lastCloudSyncAt || 'never (Phase B)') + '</td></tr>' +
      '<tr><td style="padding:6px 14px 6px 0;color:#8b93a7">LAN addresses</td><td>' +
      lanAddresses().join(', ') + ' — staff portal: http://&lt;ip&gt;:' + (process.env.PORT || 8300) + '/</td></tr>' +
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

  /* ── Portals (rewritten + adapter-injected) ──────────────────── */
  app.use(portals.portalMiddleware(REPO_ROOT, serverConfig()));

  /* 404 */
  app.use(function(req, res){ res.status(404).json({error:'not found'}); });

  app.locals.db = db;
  return app;
}

function start(){
  var port = Number(process.env.PORT || 8300);
  var app = createApp({});
  var server = http.createServer(app);
  server.listen(port, '0.0.0.0', function(){
    console.log('RSMS offline server v' + SERVER_VERSION + ' listening on 0.0.0.0:' + port);
    console.log('Staff portal: http://<LAN-IP>:' + port + '/   Health: http://<LAN-IP>:' + port + '/health');
    console.log('Note: LAN-only deployment — no internet route, no parent portal.');
  });
  return server;
}

if(require.main === module) start();

module.exports = {createApp: createApp, start: start};
