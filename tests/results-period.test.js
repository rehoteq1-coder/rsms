const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('rsms-results-print.html','utf8');
test('report loads only selected class, term and session and keeps zero scores',()=>{
 const student={id:'s1',class:'Primary 1'};
 const store={
  'rsms_school1_scores_Primary_1_First_Term_2025_2026':JSON.stringify({one:{stuId:'s1',subject:'Math',class:'Primary 1',term:'First Term',session:'2025/2026',ca1:0,ca2:0,exam:0}}),
  'rsms_scores_Primary_1_First_Term_2025_2026':JSON.stringify({one:{stuId:'s1',subject:'Math',ca1:20,ca2:20,exam:60}}),
  'rsms_school1_scores_Primary_1_Second_Term_2025_2026':JSON.stringify({one:{stuId:'s1',subject:'Math',ca1:20,ca2:20,exam:60}}),
  'rsms_school1_scores_Primary_10_First_Term_2025_2026':JSON.stringify({one:{stuId:'s1',subject:'Other',ca1:20}}),
 };
 const ctx={STUDENTS:[student],currentStudents:[],currentScores:{},currentSubjects:[],_sid:()=> 'school1',localStorage:{getItem:k=>store[k]||null},showPreview:()=>{}};
 vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('function loadScores('),html.indexOf('// ── PREVIEW',html.indexOf('function loadScores('))),ctx);
 ctx.loadScores('Primary 1','First Term','2025/2026');
 assert.equal(ctx.currentScores.s1.Math.exam,0);
 assert.equal(ctx.currentSubjects.join(','),'Math');
 ctx.loadScores('Primary 1','Third Term','2025/2026');
 assert.equal(Object.keys(ctx.currentScores).length,0);
});
