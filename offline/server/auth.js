'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SERVER — local staff authentication

   Server-side credentials only (docs/offline-design.md §4): salted,
   memory-hard hashes (Node built-in scrypt — zero native deps; Argon2id
   may replace it in Phase C packaging), HttpOnly SameSite session
   cookies with server-side revocation, short absolute expiry.
   Plaintext PINs/passwords never touch storage or logs.
═══════════════════════════════════════════════════════════════════ */

var crypto = require('crypto');

var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h absolute expiry
var ALLOWED_ROLES = ['admin','bursar','teacher','classteacher','hod','vp','principal','superadmin'];

function scryptHash(secret, salt){
  return crypto.scryptSync(String(secret), salt, 32, {N:16384, r:8, p:1, maxmem:64*1024*1024});
}

function hashCredential(secret){
  var salt = crypto.randomBytes(16).toString('hex');
  return {hash: scryptHash(secret, salt).toString('hex'), salt: salt};
}

function verifyCredential(secret, storedHash, salt){
  var a = Buffer.from(String(storedHash || ''), 'hex');
  var b = scryptHash(secret, salt);
  if(a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch(e){ return false; }
}

function randomToken(){
  return crypto.randomBytes(32).toString('hex');
}

function tokenHash(token){
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createSession(db, username, role){
  var token = randomToken();
  var now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token_hash, username, role, created_at, expires_at) ' +
    'VALUES (?,?,?,?,?)'
  ).run(tokenHash(token), username, role, new Date(now).toISOString(),
        new Date(now + SESSION_TTL_MS).toISOString());
  return token;
}

function readSession(db, cookieHeader){
  if(!cookieHeader) return null;
  var match = String(cookieHeader).match(/(?:^|;\s*)rsms_offline_session=([a-f0-9]{64})/);
  if(!match) return null;
  var row = db.prepare(
    'SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash(match[1]));
  if(!row || row.revoked_at) return null;
  if(Date.parse(row.expires_at) < Date.now()){
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(match[1]));
    return null;
  }
  return {token: match[1], username: row.username, role: row.role};
}

function revokeSession(db, token){
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), tokenHash(token));
}

function revokeAllForUser(db, username){
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE username = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), username);
}

function sessionCookie(token, https){
  var parts = ['rsms_offline_session=' + token, 'HttpOnly', 'SameSite=Lax', 'Path=/',
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000)];
  if(https) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(){
  return 'rsms_offline_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

/* Express middleware: require a valid session (and optionally one of the roles). */
function requireAuth(db, roles){
  return function(req, res, next){
    var session = readSession(db, req.headers.cookie);
    if(!session){
      if(req.accepts('html')) return res.status(401).sendPage({code:401, title:'Sign in required', body:'Staff sign-in required.'});
      return res.status(401).json({error:'unauthenticated'});
    }
    if(roles && roles.length && roles.indexOf(session.role) < 0){
      return res.status(403).json({error:'forbidden', role: session.role});
    }
    req.staff = session;
    next();
  };
}

module.exports = {
  ALLOWED_ROLES:ALLOWED_ROLES,
  hashCredential:hashCredential,
  verifyCredential:verifyCredential,
  createSession:createSession,
  readSession:readSession,
  revokeSession:revokeSession,
  revokeAllForUser:revokeAllForUser,
  sessionCookie:sessionCookie,
  clearSessionCookie:clearSessionCookie,
  requireAuth:requireAuth,
  SESSION_TTL_MS:SESSION_TTL_MS
};
