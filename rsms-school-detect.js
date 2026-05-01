/**
 * RSMS School Auto-Detection System
 * Include this in ALL portals before any other script
 * Handles: subdomain detection, school ID mapping, branding load
 */

var RSMS_DETECT = (function() {

  // ── SUBDOMAIN → SCHOOL ID MAP ──
  // Add every school here when onboarded
  // Format: 'subdomain': 'SCHOOL-ID'
  var SCHOOL_MAP = {
    'sharonrose':  'OND-ENT-0001',
    'gtc':         'OND-SEC-0001',
    'rsms':        null,           // main portal — show school ID entry
    'www':         null
  };

  // Detect subdomain from current hostname
  function getSubdomain() {
    var host = window.location.hostname.toLowerCase();
    var parts = host.split('.');
    // e.g. sharonrose.rehoteq.com → parts = ['sharonrose','rehoteq','com']
    if (parts.length >= 3 && parts[1] === 'rehoteq') {
      return parts[0];
    }
    // localhost or direct file — return null
    return null;
  }

  // Get school ID from URL param or subdomain
  function detectSchoolId() {
    // 1. URL param takes priority: ?school=OND-ENT-0001
    var params = new URLSearchParams(window.location.search);
    if (params.get('school')) return params.get('school');

    // 2. Check subdomain map
    var sub = getSubdomain();
    if (sub && SCHOOL_MAP[sub]) return SCHOOL_MAP[sub];

    // 3. Check active school in localStorage
    var active = localStorage.getItem('rsms_active_school_id');
    if (active) return active;

    // 4. Check school record
    try {
      var school = JSON.parse(localStorage.getItem('rsms_school') || '{}');
      if (school.schoolId) return school.schoolId;
    } catch(e) {}

    return null;
  }

  // Load school branding data
  function loadSchoolData(schoolId) {
    try {
      var school = JSON.parse(localStorage.getItem('rsms_school') || '{}');
      // If school ID matches or no ID stored yet
      if (!schoolId || school.schoolId === schoolId || !school.schoolId) {
        return school;
      }
    } catch(e) {}
    return null;
  }

  // Get school logo
  function getLogo() {
    return localStorage.getItem('rsms_school_logo') || '';
  }

  // Apply branding to a school header element
  function applyBranding(el, school) {
    if (!el || !school) return;
    var logo = getLogo();
    var name = school.name || 'School';
    el.innerHTML =
      (logo
        ? '<img src="' + logo + '" style="height:48px;object-fit:contain;" onerror="this.style.display=\'none\'"/>'
        : '') +
      '<span style="font-family:Fraunces,serif;font-weight:700;">' + name + '</span>';
  }

  // Register a new school subdomain (called when school is onboarded)
  function registerSubdomain(subdomain, schoolId) {
    try {
      var map = JSON.parse(localStorage.getItem('rsms_school_map') || '{}');
      map[subdomain] = schoolId;
      localStorage.setItem('rsms_school_map', JSON.stringify(map));
      SCHOOL_MAP[subdomain] = schoolId;
    } catch(e) {}
  }

  // Load persisted school map from localStorage (for dynamically added schools)
  function loadPersistedMap() {
    try {
      var map = JSON.parse(localStorage.getItem('rsms_school_map') || '{}');
      Object.keys(map).forEach(function(sub) {
        SCHOOL_MAP[sub] = map[sub];
      });
    } catch(e) {}
  }

  // Auto-run on include
  loadPersistedMap();

  return {
    getSubdomain: getSubdomain,
    detectSchoolId: detectSchoolId,
    loadSchoolData: loadSchoolData,
    getLogo: getLogo,
    applyBranding: applyBranding,
    registerSubdomain: registerSubdomain,
    SCHOOL_MAP: SCHOOL_MAP
  };

})();
