const admin = require('firebase-admin');
admin.initializeApp();
(async () => {
  const email = 'a.adebayo@adetolagroupof.rsms';
  try {
    const u = await admin.auth().getUserByEmail(email);
    console.log('AUTH_OK', JSON.stringify({uid: u.uid, disabled: u.disabled, verified: u.emailVerified, created: u.metadata.creationTime, lastLogin: u.metadata.lastSignInTime}));
  } catch (e) {
    console.log('AUTH_FAIL', e.code || e.message);
  }
  try {
    const snap = await admin.database().ref('schools').once('value');
    const schools = snap.val() || {};
    Object.entries(schools).forEach(([sid, s]) => {
      const staff = s.staff || {};
      Object.entries(staff).forEach(([k, st]) => {
        const em = String((st && st.email) || '').toLowerCase();
        if (em === email) {
          console.log('STAFF', sid, k, JSON.stringify({name: st.name, email: st.email, authUid: st.authUid || null, role: st.role || st.jobRole || null}));
        }
      });
    });
    console.log('DB_SCAN_DONE');
  } catch (e) {
    console.log('DB_FAIL', e.code || e.message);
  }
  process.exit(0);
})();
