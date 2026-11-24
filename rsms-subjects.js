// Tolerant class-name match: records often spell the same class differently (KG1 vs KG 1, Creche vs Creche)
function sameClass(a,b){
  var n=function(v){return String(v||'').trim().replace(/\s+/g,' ').toLowerCase();};
  return !!n(a)&&n(a)===n(b);
}

if(typeof rsmsCacheGet==='undefined'){function rsmsCacheKey(key){var sid='';try{sid=(JSON.parse(localStorage.getItem('rsms_school')||'{}')||{}).schoolId||'';}catch(e){}return sid?('rsms_'+sid+'_'+key):('rsms_'+key);}function rsmsCacheGetRaw(key){try{return localStorage.getItem(rsmsCacheKey(key));}catch(e){return null;}}function rsmsCacheGet(key,fallbackRaw){var raw=rsmsCacheGetRaw(key);if(raw===null||raw===undefined){return (fallbackRaw===undefined?null:fallbackRaw);}try{return JSON.parse(raw);}catch(e){return fallbackRaw;}}function rsmsCacheSetRaw(key,jsonStr){try{localStorage.setItem(rsmsCacheKey(key),jsonStr);}catch(e){}}}

// ════════════════════════════════════════════
// RSMS SHARED SUBJECTS MAP — used in ALL portals
// ════════════════════════════════════════════
var NG_SUBJECTS = {
  /* Early years (Creche, Playgroup, Pre-Nursery, KG, Nursery 1/2): play-based
     foundation areas used by Nigerian early-childhood classrooms. */
  "EARLY_YEARS": [
    "Letter Work","Number Work","Rhymes","Pre-Writing","Handwriting","Colouring",
    "Social Habits","Health Habits","Science Exploration","Creative Arts",
    "Music & Rhymes","Moral Instruction","Physical Development"
  ],
  /* Subject lists updated to the NERDC-approved national curriculum
     (approved Sept 2025, implementation from 2025/26, phased: P1, P4,
     JSS1, SS1 first). Each list carries the legacy/WAEC subject names
     still in use by schools running the old scheme, so both schemes can
     be entered side by side. Trade subjects are the approved 2025 list. */
  "PRIMARY_LOW": [
    "English Studies","Mathematics","Nigerian Language","Basic Science",
    "Physical & Health Education","Christian Religious Studies","Islamic Religious Studies",
    "Nigerian History","Social and Citizenship Studies","Cultural & Creative Arts",
    "Arabic Language",
    "English Language","Social Studies","Civic Education","Computer Studies",
    "Agricultural Science","Home Economics","Yoruba Language",
    "Verbal Reasoning","Quantitative Reasoning","Literacy","Numeracy",
    "Rhymes","Writing","Handwriting","Social Habits","Health Habits",
    "Security Education"
  ],
  "PRIMARY": [
    "English Studies","Mathematics","Nigerian Language","Basic Science & Technology",
    "Physical & Health Education","Basic Digital Literacy","Christian Religious Studies",
    "Islamic Religious Studies","Nigerian History","Social and Citizenship Studies",
    "Cultural & Creative Arts","Pre-Vocational Studies","French","Arabic Language",
    "English Language","Basic Science","Social Studies","Civic Education",
    "Computer Studies","Agricultural Science","Home Economics","Yoruba Language",
    "Verbal Reasoning","Quantitative Reasoning",
    "Handwriting", "Security Education"
  ],
  "JSS": [
    "English Studies","Mathematics","Nigerian Language","Intermediate Science",
    "Physical & Health Education","Digital Technologies","Christian Religious Studies",
    "Islamic Religious Studies","Nigerian History","Social and Citizenship Studies",
    "Cultural & Creative Arts","Business Studies","French","Arabic Language",
    "Solar Photovoltaic Installation & Maintenance","Fashion Design & Garment Making",
    "Livestock Farming","Beauty & Cosmetology","Computer Hardware & GSM Repairs",
    "Horticulture & Crop Production",
    "English Language","Basic Science & Technology","Social Studies","Civic Education",
    "Computer Studies/ICT","Agricultural Science","Home Economics","Security Education",
    "Basic Technology","Yoruba Language",
    "Basic Science", "Marketing"
  ],
  "SS_SCIENCE": [
    "English Language","General Mathematics","Digital Technologies",
    "Citizenship & Heritage Studies","Biology","Chemistry","Physics","Agriculture",
    "Further Mathematics","Physical Education","Health Education","Foods & Nutrition",
    "Geography","Technical Drawing","Christian Religious Studies","Islamic Religious Studies",
    "Nigerian History","Nigerian Language","French",
    "Solar Photovoltaic Installation & Maintenance","Fashion Design & Garment Making",
    "Livestock Farming","Beauty & Cosmetology","Computer Hardware & GSM Repairs",
    "Horticulture & Crop Production",
    "Mathematics","Agricultural Science","Computer Studies","Economics","Yoruba Language",
    "Social and Citizenship Studies",
    "Civic Education", "Social Studies", "Literature in English", "Commerce", "Financial Accounting", "Marketing", "Home Economics", "Business Studies"
  ],
  "SS_COMMERCIAL": [
    "English Language","General Mathematics","Accounting","Commerce","Marketing","Economics",
    "Digital Technologies","Citizenship & Heritage Studies","Business Studies",
    "Office Practice","Salesmanship","Christian Religious Studies","Islamic Religious Studies",
    "Nigerian History",
    "Solar Photovoltaic Installation & Maintenance","Fashion Design & Garment Making",
    "Livestock Farming","Beauty & Cosmetology","Computer Hardware & GSM Repairs",
    "Horticulture & Crop Production",
    "Mathematics","Literature in English","Computer Studies","Physical & Health Education",
    "Yoruba Language",
    "Social and Citizenship Studies",
    "Civic Education", "Social Studies", "Home Economics", "Financial Accounting"
  ],
  "SS_ARTS": [
    "English Language","General Mathematics","Nigerian History","Government",
    "Christian Religious Studies","Islamic Religious Studies","Nigerian Language",
    "French","Arabic","Visual Arts","Music","Literature in English","Home Management",
    "Catering Craft","Digital Technologies","Citizenship & Heritage Studies",
    "Economics","Geography",
    "Solar Photovoltaic Installation & Maintenance","Fashion Design & Garment Making",
    "Livestock Farming","Beauty & Cosmetology","Computer Hardware & GSM Repairs",
    "Horticulture & Crop Production",
    "Mathematics","Fine Arts","History","Yoruba Language","Physical & Health Education",
    "Civic Education", "Social Studies", "Commerce", "Financial Accounting", "Marketing", "Home Economics", "Business Studies",
    "Social and Citizenship Studies"
  ]
};

// Subjects a school may need in ANY portal regardless of class level. Every
// class's list is topped up with whichever of these it does not already carry,
// so whoever needs one can select it (user request, Nov 24 2026).
var RSMS_SHARED_SUBJECTS = [
  "Business Studies","Social and Citizenship Studies","Civic Education",
  "Basic Technology","Intermediate Science","Basic Science","Commerce",
  "Financial Accounting","Marketing","Cultural & Creative Arts","Social Studies",
  "Home Economics","Literature in English","Security Education"
];
function rsmsMergeSharedSubjects(list){
  var out=(list||[]).slice();
  RSMS_SHARED_SUBJECTS.forEach(function(s){ if(out.indexOf(s)<0) out.push(s); });
  return out;
}

function getSubjectsForClass(cls) {
  if(!cls) return rsmsMergeSharedSubjects(NG_SUBJECTS.JSS);
  var c = cls.toLowerCase();
  if(c.includes('creche')||c.includes('playgroup')||c.includes('pre-nursery')||c.includes('pre nursery')||c.includes('kg')||c.includes('nursery')) return rsmsMergeSharedSubjects(NG_SUBJECTS.EARLY_YEARS);
  if(c.includes('science'))  return rsmsMergeSharedSubjects(NG_SUBJECTS.SS_SCIENCE);
  if(c.includes('commercial')||c.includes('commerce')) return rsmsMergeSharedSubjects(NG_SUBJECTS.SS_COMMERCIAL);
  if(c.includes('art'))      return rsmsMergeSharedSubjects(NG_SUBJECTS.SS_ARTS);
  if(c.includes('ss')||c.includes('senior')) return rsmsMergeSharedSubjects(NG_SUBJECTS.SS_SCIENCE); // default SS
  if(c.includes('primary'))  return rsmsMergeSharedSubjects(NG_SUBJECTS.PRIMARY);
  return rsmsMergeSharedSubjects(NG_SUBJECTS.JSS); // JSS default
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
  var all = rsmsCacheGet('students','[]');
  if(!cls) return all;
  return all.filter(function(s){ return sameClass(s.class,cls); });
}
