/* ═══════════════════════════════════════════════════════════
   RSMS PLAN GUARD — Feature gating per subscription plan
   Include this in every portal after rsms-firebase.js
═══════════════════════════════════════════════════════════ */

var PLAN_GUARD = (function(){

  // ── PLAN HIERARCHY ──────────────────────────────────────────
  var PLANS = ['starter','standard','premium','enterprise','whitelabel'];

  // ── FEATURE MAP ─────────────────────────────────────────────
  // Each feature requires a minimum plan
  var FEATURES = {
    // ── ALL PLANS (Starter and above) ─────────────────────────
    results_basic:        'starter',   // View/print result sheets
    students_add:         'starter',   // Add/manage students
    staff_add:            'starter',   // Add/manage staff
    fees_record:          'starter',   // Record fee payments
    fees_ledger:          'starter',   // View student ledger
    portal_links:         'starter',   // Generate login links
    portal_passwords:     'starter',   // Manage portal passwords
    student_portal:       'starter',   // Student portal access
    parent_portal:        'starter',   // Parent portal access
    school_logo:          'starter',   // Upload school logo (ALL plans)
    results_print:        'starter',   // Print result sheets (ALL plans)
    fee_schedule:         'starter',   // Fee schedule configuration
    score_entry:          'starter',   // Teacher score entry (ALL plans)
    ct_remarks:           'starter',   // Class teacher remarks on results
    broadcast:            'starter',   // Principal broadcast messages
    school_settings:      'starter',   // School name, term, session config
    receipts:             'starter',   // Fee receipts generation

    // ── STANDARD (Standard and above) ─────────────────────────
    attendance:           'standard',  // Attendance marking + QR scanner
    assignments:          'standard',  // Teacher assignments
    lesson_plans:         'standard',  // Lesson plan submission to HOD
    lesson_notes:         'standard',  // Lesson note submission to HOD
    hod_review:           'standard',  // HOD approval workflow
    vp_review:            'standard',  // VP approval workflow
    cbt_exam:             'standard',  // CBT student exam
    self_pay:             'standard',  // Parent self-pay via bank transfer
    qr_codes:             'standard',  // QR code generation + print
    class_streams:        'standard',  // Class arm/stream configuration

    // ── PREMIUM (Premium and above) ───────────────────────────
    bulk_import:          'premium',   // Bulk CSV student/staff import
    progress_report:      'premium',   // Progress/mid-term reports
    card_payment:         'premium',   // Flutterwave card payment
    results_advanced:     'premium',   // Advanced result analytics
    parent_attendance:    'premium',   // Parent sees child attendance history
    cbt_questions_bank:   'premium',   // Upload CBT question banks

    // ── ENTERPRISE (Enterprise and above) ─────────────────────
    clock_gps:            'enterprise', // GPS staff clock-in/out
    lesson_ai:            'enterprise', // AI-powered lesson generation
    dedicated_db:         'enterprise', // Dedicated Firebase database
    cloud_storage:        'enterprise', // Extended cloud storage (unlimited)
    custom_reg_prefix:    'enterprise', // Custom registration number prefix
    subdomain:            'enterprise', // Custom subdomain (school.rsms.rehoteq.com)
    bg_images:            'enterprise', // Multiple login background images
    payroll:              'enterprise', // Staff payroll (coming soon)
    timetable:            'enterprise', // Timetable builder (coming soon)
    superadmin_access:    'enterprise', // Superadmin portal access

    // ── WHITE LABEL (White Label only) ────────────────────────
    custom_branding:      'whitelabel', // Full custom branding/domain
    white_label_resell:   'whitelabel', // Resell RSMS under own brand
  };

  // ── PLAN LIMITS ─────────────────────────────────────────────
  var LIMITS = {
    starter:     { students: 200,  staff: 20,  storage_mb: 200,  bg_images: 1  },
    standard:    { students: 500,  staff: 50,  storage_mb: 500,  bg_images: 1  },
    premium:     { students: 1500, staff: 150, storage_mb: 2048, bg_images: 2  },
    enterprise:  { students: 9999, staff: 500, storage_mb: 99999,bg_images: 5  },
    whitelabel:  { students: 9999, staff: 999, storage_mb: 99999,bg_images: 10 },
  };

  // ── HELPERS ─────────────────────────────────────────────────
  function getPlan(){
    var school = JSON.parse(localStorage.getItem('rsms_school')||'{}');
    return (school.plan||'starter').toLowerCase().replace(/\s+/g,'').replace('white label','whitelabel').replace('white-label','whitelabel');
  }

  function planIndex(plan){
    var p = (plan||'').toLowerCase().replace(/\s+/g,'').replace('white label','whitelabel').replace('white-label','whitelabel');
    var idx = PLANS.indexOf(p);
    return idx < 0 ? 0 : idx;
  }

  function canUse(feature){
    var required = FEATURES[feature];
    if(!required) return true; // unknown feature = allowed
    return planIndex(getPlan()) >= planIndex(required);
  }

  function getLimit(key){
    var plan = getPlan();
    var limits = LIMITS[plan] || LIMITS.starter;
    return limits[key] || 0;
  }

  function getRequiredPlan(feature){
    return FEATURES[feature] || 'starter';
  }

  // ── UPGRADE PROMPT ───────────────────────────────────────────
  function upgradePrompt(feature, targetEl){
    var required = getRequiredPlan(feature);
    var planLabel = required.charAt(0).toUpperCase()+required.slice(1);
    var msg =
      '<div style="text-align:center;padding:24px 16px;">'+
        '<div style="font-size:2rem;margin-bottom:10px;">&#128274;</div>'+
        '<div style="font-weight:700;color:var(--t1);margin-bottom:6px;">'+planLabel+' Plan Required</div>'+
        '<div style="font-size:.82rem;color:var(--t3);margin-bottom:16px;">'+
          'This feature requires the '+planLabel+' plan or above.<br/>'+
          'Contact Rehoteq Technologies to upgrade.'+
        '</div>'+
        '<a href="https://rehoteq.com" target="_blank" class="btn btn-gold btn-sm">Upgrade Plan</a>'+
        '<div style="font-size:.72rem;color:var(--t4);margin-top:10px;">Current plan: '+getPlan().toUpperCase()+'</div>'+
      '</div>';
    if(targetEl){
      targetEl.innerHTML = msg;
    }
    return msg;
  }

  // ── GATE ELEMENT ─────────────────────────────────────────────
  // Adds lock overlay to a DOM element if feature not allowed
  function gate(feature, el){
    if(!el) return canUse(feature);
    if(canUse(feature)) return true;
    el.style.position   = 'relative';
    el.style.pointerEvents = 'none';
    el.style.opacity    = '0.45';
    var lock = document.createElement('div');
    lock.style.cssText  = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(13,17,23,.7);border-radius:inherit;z-index:10;cursor:pointer;pointer-events:all;';
    lock.innerHTML      = '<div style="text-align:center;"><div style="font-size:1.4rem;">&#128274;</div><div style="font-size:.72rem;color:var(--gold);font-weight:700;margin-top:4px;">'+getRequiredPlan(feature).toUpperCase()+'</div></div>';
    lock.onclick        = function(){ upgradeModal(feature); };
    el.appendChild(lock);
    return false;
  }

  // ── UPGRADE MODAL ────────────────────────────────────────────
  function upgradeModal(feature){
    var required = getRequiredPlan(feature);
    var planLabel = required.charAt(0).toUpperCase()+required.slice(1);
    if(typeof toast === 'function'){
      toast(planLabel+' plan required. Contact Rehoteq to upgrade.','error');
    }
    var m = document.getElementById('rsms-upgrade-modal');
    if(!m){
      m = document.createElement('div');
      m.id = 'rsms-upgrade-modal';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
      m.onclick = function(e){ if(e.target===m) m.remove(); };
      document.body.appendChild(m);
    }
    m.innerHTML =
      '<div style="background:var(--card,#1a2236);border-radius:16px;padding:28px 24px;max-width:340px;width:100%;text-align:center;">'+
        '<div style="font-size:2.5rem;margin-bottom:12px;">&#128274;</div>'+
        '<div style="font-family:var(--serif,serif);font-size:1.3rem;font-weight:900;color:var(--t1,#f0f6ff);margin-bottom:8px;">'+planLabel+' Plan Required</div>'+
        '<div style="font-size:.84rem;color:var(--t3,#8899bb);margin-bottom:20px;line-height:1.6;">'+
          'This feature is available on the <strong style="color:var(--gold,#d4a843);">'+planLabel+'</strong> plan and above.'+
          '<br/>Upgrade to unlock this and other premium features.'+
        '</div>'+
        '<div style="display:flex;gap:10px;justify-content:center;">'+
          '<button onclick="document.getElementById(\'rsms-upgrade-modal\').remove()" style="padding:10px 20px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#fff;border-radius:8px;cursor:pointer;">Not Now</button>'+
          '<a href="https://rehoteq.com" target="_blank" style="padding:10px 20px;background:var(--gold,#d4a843);color:#000;border-radius:8px;font-weight:700;text-decoration:none;cursor:pointer;">Upgrade Now</a>'+
        '</div>'+
        '<div style="font-size:.7rem;color:var(--t4,#566280);margin-top:12px;">Current plan: '+getPlan().toUpperCase()+' | Rehoteq Technologies</div>'+
      '</div>';
  }

  // ── CHECK LIMITS ─────────────────────────────────────────────
  function checkLimit(key, currentCount){
    var limit = getLimit(key);
    if(limit >= 9999) return {ok:true, limit:limit, count:currentCount};
    var ok = currentCount < limit;
    if(!ok){
      var plan = getPlan();
      if(typeof toast === 'function'){
        toast(key+' limit reached ('+limit+' on '+plan+' plan). Upgrade to add more.','error');
      }
    }
    return {ok:ok, limit:limit, count:currentCount};
  }

  // ── AUTO-GATE ON LOAD ─────────────────────────────────────────
  // Call this after page loads to apply gates based on data-feature attributes
  function applyGates(){
    document.querySelectorAll('[data-feature]').forEach(function(el){
      var feature = el.getAttribute('data-feature');
      if(!canUse(feature)){
        gate(feature, el);
      }
    });
  }

  // ── PUBLIC ───────────────────────────────────────────────────
  return {
    canUse:         canUse,
    gate:           gate,
    checkLimit:     checkLimit,
    getPlan:        getPlan,
    upgradeModal:   upgradeModal,
    upgradePrompt:  upgradePrompt,
    applyGates:     applyGates,
    getLimit:       getLimit,
    FEATURES:       FEATURES,
    LIMITS:         LIMITS,
  };

})();
