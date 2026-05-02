
// ════════════════════════════════════════════
// RSMS SHARED SUBJECTS MAP — used in ALL portals
// ════════════════════════════════════════════
var NG_SUBJECTS = {
  "JSS": [
    "English Language","Mathematics","Basic Science & Technology","Social Studies",
    "Civic Education","Cultural & Creative Arts","Physical & Health Education",
    "Computer Studies/ICT","Agricultural Science","Home Economics","Business Studies",
    "French Language","Yoruba Language","Arabic Language",
    "Christian Religious Studies","Islamic Religious Studies",
    "Security Education","Pre-Vocational Studies","Basic Technology"
  ],
  "SS_SCIENCE": [
    "English Language","Mathematics","Physics","Chemistry","Biology",
    "Agricultural Science","Computer Studies","Further Mathematics",
    "Technical Drawing","Food & Nutrition",
    "Christian Religious Studies","Islamic Religious Studies",
    "Civic Education","Physical & Health Education","Yoruba Language"
  ],
  "SS_COMMERCIAL": [
    "English Language","Mathematics","Economics","Commerce","Accounting",
    "Business Studies","Office Practice","Computer Studies","Salesmanship",
    "Christian Religious Studies","Islamic Religious Studies",
    "Civic Education","Physical & Health Education","Yoruba Language","Literature in English"
  ],
  "SS_ARTS": [
    "English Language","Mathematics","Literature in English","Government","History",
    "Christian Religious Studies","Islamic Religious Studies","Yoruba Language",
    "French Language","Fine Arts","Music","Geography","Economics",
    "Civic Education","Physical & Health Education"
  ],
  "PRIMARY": [
    "English Language","Mathematics","Basic Science","Social Studies",
    "Civic Education","Cultural & Creative Arts","Physical & Health Education",
    "Computer Studies","Agricultural Science","Home Economics","Yoruba Language",
    "Christian Religious Studies","Islamic Religious Studies",
    "Verbal Reasoning","Quantitative Reasoning"
  ]
};

function getSubjectsForClass(cls) {
  if(!cls) return NG_SUBJECTS.JSS;
  var c = cls.toLowerCase();
  if(c.includes('science'))  return NG_SUBJECTS.SS_SCIENCE;
  if(c.includes('commercial')||c.includes('commerce')) return NG_SUBJECTS.SS_COMMERCIAL;
  if(c.includes('art'))      return NG_SUBJECTS.SS_ARTS;
  if(c.includes('ss')||c.includes('senior')) return NG_SUBJECTS.SS_SCIENCE; // default SS
  if(c.includes('primary'))  return NG_SUBJECTS.PRIMARY;
  return NG_SUBJECTS.JSS; // JSS default
}

function getClassLevel(cls) {
  if(!cls) return 'JSS';
  var c = cls.toLowerCase();
  if(c.includes('ss')||c.includes('senior')) return 'SS';
  if(c.includes('primary')) return 'PRIMARY';
  return 'JSS';
}

// Populate a subject dropdown based on class
function populateSubjectDropdown(selId, cls, selectedVal) {
  var sel = document.getElementById(selId);
  if(!sel) return;
  var subjects = getSubjectsForClass(cls);
  sel.innerHTML = '<option value="">— Select Subject —</option>' +
    subjects.map(function(s){
      return '<option value="'+s+'"'+(s===selectedVal?' selected':'')+'>'+s+'</option>';
    }).join('');
}

// Get students for a class from shared pool
function getStudentsForClass(cls) {
  var all = JSON.parse(localStorage.getItem('rsms_students')||'[]');
  if(!cls) return all;
  return all.filter(function(s){ return (s.class||'')=== cls; });
}
