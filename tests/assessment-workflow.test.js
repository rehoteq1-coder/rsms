'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadPortal,fakeFirebase,setInput,setSelect,flush,blobText}=require('./portal-harness');
const SID='REH-TEST';
const CLASS='JSS 1',TERM='First Term',SESS='2025/2026';
const SCORE_SUFFIX='JSS_1_First_Term_2025_2026';
const SCOPED='rsms_'+SID+'_scores_'+SCORE_SUFFIX;
const THREE={tests:3,ca1:10,ca2:15,ca3:20,exam:55};
const TWO={tests:2,ca1:30,ca2:30,ca3:0,exam:40};
function baseStorage(){
  const school={schoolId:SID,name:'Workflow School',term:TERM,session:SESS,plan:'Standard'};
  const students=[
    {id:'s1',surname:'Legacy',firstname:'Ada',class:CLASS,reg:'001'},
    {id:'s2',surname:'Three',firstname:'Ben',class:CLASS,reg:'002'},
    {id:'s3',surname:'Import',firstname:'Chi',class:CLASS,reg:'003'}
  ];
  const legacy={stuId:'s1',student:'Legacy Ada',class:CLASS,subject:'Mathematics',term:TERM,session:SESS,ca1:10,ca2:10,exam:30,total:50,enteredBy:'Old teacher'};
  return {school,students,legacy,local:{rsms_school:school,['rsms_'+SID+'_students']:students,[SCOPED]:{s1_Mathematics:legacy}}};
}
function session(role,extra={}){return {rsms_user:Object.assign({id:role+'1',name:role+' user',role,schoolId:SID},extra),rsms_auth:'true'};}
function chooseScoreContext(w,subject,prefix='sc'){
  const cls=w.document.getElementById(prefix+'-class');
  if(!Array.from(cls.options).some(o=>o.value===CLASS)){const o=w.document.createElement('option');o.value=CLASS;o.textContent=CLASS;cls.appendChild(o);}
  cls.value=CLASS;
  const subj=w.document.getElementById(prefix+'-subject');
  subj.innerHTML='<option value="">Select</option><option>'+subject+'</option>';subj.value=subject;
  w.document.getElementById(prefix+'-term').value=TERM;
  w.document.getElementById(prefix+'-session').value=SESS;
}
function savedScores(fb){return fb.state.schools[SID].score_entries[SCORE_SUFFIX];}
function noRosterWrites(fb){assert.ok(!fb.writes.some(w=>w.path.includes('/students')),'diagnostic must not write students');}

test('complete workflow: settings, mixed historical entry, CSV, class-teacher/admin/principal overrides, reports and lock',async()=>{
  const {school,students,legacy,local}=baseStorage();
  const fb=fakeFirebase({schools:{[SID]:{info:school,students:Object.fromEntries(students.map(s=>[s.id,s])),
    score_entries:{[SCORE_SUFFIX]:{s1_Mathematics:legacy}}}}});
  const pages=[];
  const open=(file,storage,role,extra)=>{const p=loadPortal(file,{firebase:fb,localStorage:storage,sessionStorage:session(role,extra)});pages.push(p);return p;};
  try{
    // 1. Admin changes the future scheme. Historical score and roster are untouched.
    const admin=open('rsms-admin.html',local,'admin');
    admin.window.loadSettings();
    setSelect(admin.window,'cfg-assessment-tests','3');
    setInput(admin.window,'cfg-ca1-max','10');setInput(admin.window,'cfg-ca2-max','15');
    setInput(admin.window,'cfg-ca3-max','20');setInput(admin.window,'cfg-exam-max','55');
    const writesBefore=fb.writes.length;
    admin.window.saveSettings();await flush();
    assert.deepEqual(fb.state.schools[SID].info.assessment,THREE);
    assert.deepEqual(savedScores(fb).s1_Mathematics,legacy);
    assert.ok(fb.writes.slice(writesBefore).every(w=>w.path==='schools/'+SID+'/info/assessment'));
    assert.equal(JSON.parse(admin.window.localStorage.getItem('rsms_school')).assessment.ca3,20);

    // 2. Teacher enters a new three-test row beside an unchanged legacy row.
    const teacher=open('rsms-teacher.html',admin.storage(),'teacher',{myClass:CLASS,subjects:'Mathematics,English Language'});
    chooseScoreContext(teacher.window,'Mathematics');teacher.window.loadScoreTable();
    assert.equal(teacher.document.getElementById('ca1_s1').max,'20');
    assert.equal(teacher.document.getElementById('ca3_s1').disabled,true);
    assert.equal(teacher.document.getElementById('ca3_s2').max,'20');
    setInput(teacher.window,'ca1_s2','5');setInput(teacher.window,'ca2_s2','10');
    setInput(teacher.window,'ca3_s2','15');setInput(teacher.window,'exam_s2','40');
    assert.equal(teacher.document.getElementById('tot_s2').textContent,'70');
    teacher.window.saveTeacherScores();
    assert.deepEqual(savedScores(fb).s2_Mathematics.assessment,THREE);
    assert.equal(savedScores(fb).s2_Mathematics.total,70);
    assert.deepEqual(savedScores(fb).s1_Mathematics,legacy);

    // 3. CSV preview/apply uses the current four score columns and saves a draft.
    const A=teacher.window.RSMSAssessment,CSV=teacher.window.RSMSScoreImport;
    const csv=CSV.template({cls:CLASS,term:TERM,sess:SESS},students,['Mathematics'],A.forSchool(JSON.parse(teacher.window.localStorage.getItem('rsms_school'))));
    const lines=CSV.parseCSV(csv);lines[3][7]='1';lines[3][8]='2';lines[3][9]='3';lines[3][10]='4';
    const filled='\uFEFF'+lines.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
    const input=teacher.document.getElementById('score-csv-file');
    Object.defineProperty(input,'files',{value:[new teacher.window.File([filled],'scores.csv',{type:'text/csv'})],configurable:true});
    teacher.window.previewScoreCSV(input);
    for(let i=0;i<20&&!teacher.window.scoreImportPending;i++)await flush(10);
    assert.ok(teacher.window.scoreImportPending,teacher.document.getElementById('score-import-preview').textContent);
    teacher.window.applyScoreCSV();teacher.window.saveTeacherScores();
    assert.equal(savedScores(fb).s3_Mathematics.total,10);
    assert.deepEqual(savedScores(fb).s3_Mathematics.assessment,THREE);

    // 4. Class teacher edits the new row; its captured scheme survives.
    const ct=open('rsms-classteacher.html',teacher.storage(),'classteacher',{myClass:CLASS});
    chooseScoreContext(ct.window,'Mathematics');ct.window.loadScoreTable();
    setInput(ct.window,'exam_s2','45');ct.window.saveTeacherScores();
    assert.equal(savedScores(fb).s2_Mathematics.total,75);
    assert.deepEqual(savedScores(fb).s2_Mathematics.assessment,THREE);

    // 5. Admin override validates against the row snapshot, not a hard-coded max.
    const admin2=open('rsms-admin.html',ct.storage(),'admin');
    chooseScoreContext(admin2.window,'Mathematics','asc');admin2.window.loadAdminScoreTable();
    setInput(admin2.window,'asc_ca1_s3','11');admin2.window.saveAdminScores();
    assert.equal(savedScores(fb).s3_Mathematics.ca1,1);
    setInput(admin2.window,'asc_ca1_s3','9');admin2.window.saveAdminScores();
    assert.equal(savedScores(fb).s3_Mathematics.total,18);
    assert.deepEqual(savedScores(fb).s3_Mathematics.assessment,THREE);

    // 6. Principal single-row override requires a reason and preserves history.
    const principal=open('rsms-principal.html',admin2.storage(),'principal');
    principal.window.populateAllSelects();
    principal.document.getElementById('ov-class').value=CLASS;
    principal.document.getElementById('res-term').value=TERM;
    principal.window.loadOverrideScores();
    setInput(principal.window,'ov-s2-Mathematics-exam','50');
    principal.window.promptOverride('s2|Mathematics');
    principal.document.getElementById('override-reason').value='Moderation checked';
    principal.window.confirmOverride();
    assert.equal(savedScores(fb).s2_Mathematics.total,80);
    assert.equal(savedScores(fb).s2_Mathematics.overrideReason,'Moderation checked');
    assert.deepEqual(savedScores(fb).s2_Mathematics.assessment,THREE);

    // 7. A later settings change applies only to a new subject/record.
    admin2.window.loadSettings();setSelect(admin2.window,'cfg-assessment-tests','2');
    setInput(admin2.window,'cfg-ca1-max','30');setInput(admin2.window,'cfg-ca2-max','30');setInput(admin2.window,'cfg-exam-max','40');
    admin2.window.saveSettings();await flush();
    assert.deepEqual(fb.state.schools[SID].info.assessment,TWO);
    const teacher2=open('rsms-teacher.html',admin2.storage(),'teacher',{myClass:CLASS,subjects:'Mathematics,English Language'});
    chooseScoreContext(teacher2.window,'English Language');teacher2.window.loadScoreTable();
    setInput(teacher2.window,'ca1_s1','30');setInput(teacher2.window,'ca2_s1','30');setInput(teacher2.window,'exam_s1','40');
    teacher2.window.saveTeacherScores();
    assert.deepEqual(savedScores(fb).s1_English_Language.assessment,TWO);
    assert.equal(savedScores(fb).s1_English_Language.total,100);
    assert.deepEqual(savedScores(fb).s1_Mathematics,legacy);
    assert.deepEqual(savedScores(fb).s2_Mathematics.assessment,THREE);

    // 8. Principal review and printable report use mixed snapshot denominators.
    const principal2=open('rsms-principal.html',teacher2.storage(),'principal');
    principal2.window.populateAllSelects();principal2.document.getElementById('res-class').value=CLASS;
    principal2.document.getElementById('res-term').value=TERM;principal2.window.loadResults();
    assert.match(principal2.document.getElementById('results-content').textContent,/50 \/ 100/);
    const report=open('rsms-results-print.html',teacher2.storage(),'admin');
    report.window.populateClassDropdown();
    report.window.loadScores(CLASS,TERM,SESS);
    report.document.getElementById('cls-sel').value=CLASS;report.document.getElementById('term-sel').value=TERM;report.document.getElementById('sess-in').value=SESS;
    report.window.generateCards();
    const cards=report.document.getElementById('cards-output').textContent;
    assert.ok(cards.length,'cards empty: '+report.document.getElementById('rsms-toast').textContent+' '+report.errors.map(e=>e.message||e).join('|'));
    assert.match(cards,/T3 \/ CA3/);assert.match(cards,/Saved marking schemes/);
    assert.match(cards,/Mathematics: T1 \(CA 1\) \/ 20/);assert.match(cards,/English Language: T1 \(CA 1\) \/ 30/);
    assert.ok(!report.document.getElementById('ca1-max'));

    // 9. Student and parent views display the third test and configured maximums.
    const student=open('rsms-student.html',teacher2.storage(),'student',{id:'s2',name:'Three Ben',class:CLASS});
    student.window.MY_ID='s2';student.window.MY_NAME='Three Ben';student.window.MY_CLASS=CLASS;
    student.window.renderResults();
    assert.match(student.document.getElementById('s-results-list').textContent,/T3 \/ CA 3/);
    assert.match(student.document.getElementById('s-results-list').textContent,/15 \/ 20/);
    const parent=open('rsms-parent.html',teacher2.storage(),'parent',{childId:'s2',childName:'Three Ben',class:CLASS});
    parent.window.CHILD_ID='s2';parent.window.CHILD_NAME='Three Ben';parent.window.CHILD_CLASS=CLASS;
    parent.window.renderChildResults();
    assert.match(parent.document.getElementById('p-results-list').textContent,/T3: 15 \/ 20/);

    // 10. Published results refuse teacher writes and retain drafts.
    const lockedStorage=teacher2.storage();lockedStorage['rsms_'+SID+'_published_results']={[CLASS]:{[TERM]:true}};
    const locked=open('rsms-teacher.html',lockedStorage,'teacher',{myClass:CLASS});
    chooseScoreContext(locked.window,'Mathematics');locked.window.loadScoreTable();
    setInput(locked.window,'ca1_s2','1');
    const before=fb.writes.length;locked.window.saveTeacherScores();
    assert.equal(fb.writes.length,before);assert.equal(Object.keys(locked.window.scoreDrafts).length,1);
    assert.equal(savedScores(fb).s2_Mathematics.ca1,5);
    for(const p of pages)assert.deepEqual(p.errors,[],p.window.location.href);
  }finally{await flush();pages.forEach(p=>p.close());}
});

test('read-only student-count diagnostic explains an 18-vs-2 cache mismatch and exports a backup without writes',async()=>{
  const {school,students,local}=baseStorage();
  const remote=Array.from({length:18},(_,i)=>({id:'r'+i,surname:'Student',firstname:String(i),class:CLASS}));
  const fb=fakeFirebase({schools:{[SID]:{info:school,students:Object.fromEntries(remote.map(s=>[s.id,s]))}}});
  local['rsms_'+SID+'_students']=students.slice(0,2);
  const p=loadPortal('rsms-admin.html',{firebase:fb,localStorage:local,sessionStorage:session('admin')});
  try{
    p.window.checkStudentRosterCounts();await flush();
    const text=p.document.getElementById('student-count-check').textContent;
    assert.match(text,/Admin dashboard\/cache: 2 valid/);
    assert.match(text,/Database: 18 valid/);
    assert.match(text,/Database IDs missing from cache: 18/);
    p.window.downloadStudentRosterBackup();await flush();
    assert.equal(p.downloads.length,1);
    const backup=JSON.parse(await blobText(p.downloads[0],p.window));
    assert.equal(backup.format,'rsms-roster-backup-v1');assert.equal(backup.schoolId,SID);
    assert.equal(Object.keys(backup.database).length,18);assert.equal(backup.local.length,2);
    assert.equal(backup.diagnosis.database.valid,18);assert.equal(backup.diagnosis.local.valid,2);
    noRosterWrites(fb);assert.deepEqual(p.errors,[]);
  }finally{await flush();p.close();}
});
