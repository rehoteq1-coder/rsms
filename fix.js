const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.database();
const SCHOOL = 'REH-2J8KQ2XF';
const EMAIL = 'a.adebayo@adetolagroupof.rsms';
const NAME = 'Adegboye Adebayo';
const PW = process.env.PW || '';
if(!PW || PW.length < 10 || !/[a-zA-Z]/.test(PW) || !/[0-9]/.test(PW)){ console.log('PW env missing/weak'); process.exit(1); }
const TABLE = [
  [/^admin(\s*staff)?$/i, ['admin']],
  [/^principal$/i, ['admin', 'principal']],
  [/^vice\s*principal/i, ['vp']],
  [/^head\s*of\s*department|^hod\b/i, ['hod']],
  [/^bursar/i, ['bursar']],
  [/^class\s*teacher/i, ['classteacher', 'teacher']],
  [/^(subject\s*)?teacher$/i, ['teacher']],
  [/^head\s*(mistress|master|teacher)/i, ['principal']]
];
function rolesFor(t){ const s=String(t||'').trim(); const o=[]; TABLE.forEach(function(pair){ if(pair[0].test(s)) pair[1].forEach(function(r){ if(o.indexOf(r)<0) o.push(r); }); }); return o; }
(async () => {
  const enabled = (await db.ref('schools/'+SCHOOL+'/settings/staffEmailLogins').once('value')).val();
  console.log('staffEmailLogins enabled:', enabled);
  const snap = await db.ref('schools/'+SCHOOL+'/staff').once('value');
  const rows = snap.val() || {};
  let key = null, row = null;
  Object.keys(rows).forEach(function(k){
    const r = rows[k];
    if(!r || typeof r !== 'object') return;
    const login = String(r.loginEmail||'').toLowerCase();
    const bare = String(r.email||'').toLowerCase();
    const nm = String(r.name||'').toLowerCase();
    if(login === EMAIL || bare === EMAIL || nm === NAME.toLowerCase()){
      if(key !== null){ console.log('AMBIGUOUS match at', k); process.exit(1); }
      key = k; row = r;
    }
  });
  if(!key){
    console.log('NO STAFF ROW. names:', JSON.stringify(Object.keys(rows).map(function(k){ return [k, rows[k] && rows[k].name]; })));
    process.exit(1);
  }
  console.log('staffKey:', key, 'role:', row.role, 'existing loginEmail:', row.loginEmail||'(none)');
  const roles = rolesFor(row.role);
  console.log('roles:', roles.join(','));
  if(!roles.length){ console.log('TITLE CARRIES NO PORTAL ROLE:', row.role); process.exit(1); }
  let uid;
  try {
    const u = await admin.auth().getUserByEmail(EMAIL);
    uid = u.uid;
    console.log('existing auth user:', uid);
  } catch(e) {
    if(e.code !== 'auth/user-not-found'){ console.log('LOOKUP ERR:', e.code, e.message); process.exit(1); }
    const u = await admin.auth().createUser({ email: EMAIL, password: PW, displayName: NAME, emailVerified: false });
    uid = u.uid;
    console.log('created auth user:', uid);
  }
  await admin.auth().updateUser(uid, { password: PW, displayName: NAME });
  const roleMap = {}; roles.forEach(function(r){ roleMap[r] = true; });
  const schoolMap = {}; schoolMap[SCHOOL] = true;
  await admin.auth().setCustomUserClaims(uid, { roles: roles, roleMap: roleMap, schoolIds: schoolMap });
  const at = new Date().toISOString();
  const upd = {};
  upd['schools/'+SCHOOL+'/staff/'+key+'/loginEmail'] = EMAIL;
  upd['schools/'+SCHOOL+'/staff/'+key+'/authUid'] = uid;
  upd['schools/'+SCHOOL+'/staff/'+key+'/loginActive'] = true;
  upd['schools/'+SCHOOL+'/staff/'+key+'/loginCreatedAt'] = at;
  await db.ref().update(upd);
  await db.ref('schools/'+SCHOOL+'/audit_log').push({ action: 'staff_login_created', by: 'manual_repair', at: at, detail: EMAIL });
  const after = (await db.ref('schools/'+SCHOOL+'/staff/'+key).once('value')).val() || {};
  console.log('VERIFY DB:', JSON.stringify({loginEmail: after.loginEmail, authUid: after.authUid, loginActive: after.loginActive}));
  const u2 = await admin.auth().getUser(uid);
  console.log('VERIFY AUTH:', u2.email, 'claims=', JSON.stringify(u2.customClaims));
  console.log('DONE uid=' + uid);
})().catch(function(e){ console.log('FATAL:', e.code || '', e.message); process.exit(1); });
