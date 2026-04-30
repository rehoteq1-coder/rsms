/**
 * RSMS Authentication & Portal Security Layer
 * Every portal includes this file to enforce login
 */

var RSMS_AUTH = (function() {

  // Role → portal file mapping
  var PORTAL_MAP = {
    admin:      'rsms-admin.html',
    teacher:    'rsms-teacher.html',
    student:    'rsms-student.html',
    parent:     'rsms-parent.html',
    superadmin: 'rsms-superadmin.html',
    control:    'rsms-control.html'
  };

  // Which portal file belongs to which role
  var FILE_ROLE_MAP = {
    'rsms-admin.html':      'admin',
    'rsms-teacher.html':    'teacher',
    'rsms-student.html':    'student',
    'rsms-parent.html':     'parent',
    'rsms-superadmin.html': 'superadmin',
    'rsms-control.html':    'control'
  };

  // Get current portal file name
  function currentFile() {
    var parts = window.location.pathname.split('/');
    return parts[parts.length - 1] || 'rsms-app.html';
  }

  // Get required role for this portal
  function requiredRole() {
    return FILE_ROLE_MAP[currentFile()] || null;
  }

  // Get logged in user from session
  function getUser() {
    try { return JSON.parse(sessionStorage.getItem('rsms_user') || 'null'); }
    catch(e) { return null; }
  }

  // Get logged in role
  function getRole() {
    return sessionStorage.getItem('rsms_role') || null;
  }

  // Check if link-based access is valid (for parent/student links)
  function checkLinkAccess() {
    var params = new URLSearchParams(window.location.search);
    var token = params.get('token');
    var schoolId = params.get('school');
    if (!token) return null;

    // Check token in school's access tokens
    var tokens = JSON.parse(localStorage.getItem('rsms_access_tokens') || '{}');
    var tokenData = tokens[token];
    if (!tokenData) return null;
    if (!tokenData.active) return { valid: false, reason: 'Link deactivated by school admin' };
    if (tokenData.expires && new Date(tokenData.expires) < new Date()) {
      return { valid: false, reason: 'Link has expired' };
    }
    // Auto-login with token
    sessionStorage.setItem('rsms_role', tokenData.role);
    sessionStorage.setItem('rsms_user', JSON.stringify(tokenData.user));
    sessionStorage.setItem('rsms_link_token', token);
    return { valid: true, role: tokenData.role, user: tokenData.user };
  }

  // Main auth check — call this at top of every portal
  function check() {
    var needed = requiredRole();
    if (!needed) return true; // Not a protected portal

    // Check link-based access first
    var linkAccess = checkLinkAccess();
    if (linkAccess) {
      if (!linkAccess.valid) {
        showLinkError(linkAccess.reason);
        return false;
      }
      if (linkAccess.role === needed) return true;
    }

    var user = getUser();
    var role = getRole();

    // Not logged in at all
    if (!user || !role) {
      redirectToLogin();
      return false;
    }

    // Wrong portal for this role
    if (role !== needed) {
      // Super admin can access everything
      if (role === 'superadmin') return true;
      showWrongPortal(role, needed);
      return false;
    }

    return true;
  }

  function redirectToLogin() {
    sessionStorage.setItem('rsms_redirect', window.location.href);
    window.location.href = 'rsms-app.html';
  }

  function showWrongPortal(yourRole, neededRole) {
    document.body.innerHTML = `
      <div style="font-family:'Outfit',sans-serif;background:#030305;color:#f0f2ff;
        min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;">
        <div style="text-align:center;max-width:360px;">
          <div style="font-size:4rem;margin-bottom:20px;">🔒</div>
          <div style="font-family:'Fraunces',serif;font-size:1.5rem;font-weight:700;
            color:#d4a843;margin-bottom:10px;">Access Denied</div>
          <div style="font-size:.95rem;color:rgba(240,242,255,.6);margin-bottom:6px;">
            This portal is for <strong style="color:#f0f2ff;">${neededRole}</strong> accounts only.
          </div>
          <div style="font-size:.9rem;color:rgba(240,242,255,.4);margin-bottom:28px;">
            You are logged in as <strong style="color:#d4a843;">${yourRole}</strong>.
          </div>
          <button onclick="window.location.href='rsms-app.html'"
            style="background:linear-gradient(135deg,#4a2500,#d4a843);border:none;
            border-radius:10px;color:#000;font-family:'Outfit',sans-serif;
            font-size:1rem;font-weight:700;padding:14px 28px;cursor:pointer;width:100%;">
            ← Go to Login
          </button>
        </div>
      </div>`;
  }

  function showLinkError(reason) {
    document.body.innerHTML = `
      <div style="font-family:'Outfit',sans-serif;background:#030305;color:#f0f2ff;
        min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;">
        <div style="text-align:center;max-width:360px;">
          <div style="font-size:4rem;margin-bottom:20px;">🔗</div>
          <div style="font-family:'Fraunces',serif;font-size:1.5rem;font-weight:700;
            color:#f43f5e;margin-bottom:10px;">Link Invalid</div>
          <div style="font-size:.95rem;color:rgba(240,242,255,.6);margin-bottom:28px;">${reason}</div>
          <div style="font-size:.85rem;color:rgba(240,242,255,.35);margin-bottom:20px;">
            Contact your school admin to get a new link.
          </div>
          <button onclick="window.location.href='rsms-app.html'"
            style="background:linear-gradient(135deg,#4a2500,#d4a843);border:none;
            border-radius:10px;color:#000;font-family:'Outfit',sans-serif;
            font-size:1rem;font-weight:700;padding:14px 28px;cursor:pointer;width:100%;">
            ← Login Normally
          </button>
        </div>
      </div>`;
  }

  // ── TOKEN MANAGEMENT (Admin uses these) ──
  function generateToken(role, userData, options) {
    options = options || {};
    var token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var tokens = JSON.parse(localStorage.getItem('rsms_access_tokens') || '{}');
    tokens[token] = {
      role: role,
      user: userData,
      active: true,
      created: new Date().toISOString(),
      expires: options.expires || null,
      schoolId: options.schoolId || localStorage.getItem('rsms_school_id') || 'SCH',
      createdBy: 'admin'
    };
    localStorage.setItem('rsms_access_tokens', JSON.stringify(tokens));
    return token;
  }

  function buildLink(role, userData, options) {
    var token = generateToken(role, userData, options);
    var base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
    var file = PORTAL_MAP[role] || 'rsms-app.html';
    return base + file + '?token=' + token;
  }

  function deactivateToken(token) {
    var tokens = JSON.parse(localStorage.getItem('rsms_access_tokens') || '{}');
    if (tokens[token]) {
      tokens[token].active = false;
      localStorage.setItem('rsms_access_tokens', JSON.stringify(tokens));
      return true;
    }
    return false;
  }

  function activateToken(token) {
    var tokens = JSON.parse(localStorage.getItem('rsms_access_tokens') || '{}');
    if (tokens[token]) {
      tokens[token].active = true;
      localStorage.setItem('rsms_access_tokens', JSON.stringify(tokens));
      return true;
    }
    return false;
  }

  function getAllTokens() {
    return JSON.parse(localStorage.getItem('rsms_access_tokens') || '{}');
  }

  // ── SCHOOL CODE SYSTEM ──
  // Schools get a unique code on deployment
  // Students/parents enter code + their ID to get in
  function verifySchoolCode(code) {
    var school = JSON.parse(localStorage.getItem('rsms_school') || '{}');
    var validCodes = [
      school.adminCode,
      school.teacherCode,
      school.studentCode,
      school.parentCode
    ].filter(Boolean);
    return validCodes.indexOf(code) > -1;
  }

  function getRoleByCode(code) {
    var school = JSON.parse(localStorage.getItem('rsms_school') || '{}');
    if (code === school.adminCode) return 'admin';
    if (code === school.teacherCode) return 'teacher';
    if (code === school.studentCode) return 'student';
    if (code === school.parentCode) return 'parent';
    return null;
  }

  // ── BOARDING HOUSE ──
  var BOARDING_STATUSES = ['Day Student', 'Boarder', 'Weekly Boarder'];

  return {
    check, getUser, getRole, redirectToLogin,
    generateToken, buildLink, deactivateToken, activateToken, getAllTokens,
    verifySchoolCode, getRoleByCode,
    PORTAL_MAP, BOARDING_STATUSES
  };
})();

// Auto-check on load for protected portals
window.addEventListener('DOMContentLoaded', function() {
  RSMS_AUTH.check();
});
