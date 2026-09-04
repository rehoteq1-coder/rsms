/* ═══════════════════════════════════════════════════════════
   RSMS AI UNITS — shared constants + pure helpers
   Real (server-side) metering for the AI Lesson Studio.

   Model (owner-directed):
   - Enterprise schools get AI_UNITS.BASE free units per term (a pool).
   - The school allocates units from the pool to its staff (teachers).
   - A teacher who exhausts their allocation purchases their own units.
   - When the pool is exhausted the school buys any number of units
     (flat AI_UNITS.UNIT_PRICE per unit) and keeps allocating.

   Data lives in Firebase at  schools/<schoolId>/ai_units :
     {
       base:   30,                      // free units granted per term
       pool:   22,                      // units still allocatable
       term:   "First Term 2025/2026",  // term the pool belongs to
       staff:  { "<email>": { allocated: 10, purchased: 0, used: 4 } }
     }
   A teacher's balance = allocated + purchased - used.
   ═══════════════════════════════════════════════════════════ */

window.AI_UNITS = (function(){
  var BASE = 30;               // free enterprise units per term (pool size)
  var UNIT_PRICE = 150;        // Naira, flat price per unit bought in bulk
  var UNITS_PER_TEACHER_TERM = 10; // default allocation per teacher (gift all)

  function normEmail(e){ return (e||'').toString().trim().toLowerCase(); }

  function staffNode(staff){ return staff && typeof staff === 'object' ? staff : {}; }

  /* Remaining units for one teacher from their staff node. */
  function balance(node){
    var s = staffNode(node);
    var b = (s.allocated||0) + (s.purchased||0) - (s.used||0);
    return b > 0 ? b : 0;
  }

  /* Breakdown for display: {school, own, remaining}. */
  function detail(node){
    var s = staffNode(node);
    return {
      school: s.allocated||0,        // allocated by the school (this term)
      own:    s.purchased||0,        // purchased personally (never expire)
      used:   s.used||0,
      remaining: balance(s)
    };
  }

  function priceFor(units){ return units * UNIT_PRICE; }

  return {
    BASE: BASE,
    UNIT_PRICE: UNIT_PRICE,
    UNITS_PER_TEACHER_TERM: UNITS_PER_TEACHER_TERM,
    normEmail: normEmail,
    balance: balance,
    detail: detail,
    priceFor: priceFor
  };
})();
