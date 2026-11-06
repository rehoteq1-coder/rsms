'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadPortal,fakeFirebase,setInput,setSelect,flush}=require('./portal-harness');
const SID='S2',CLASS='JSS 1',TERM='First Term',SESS='2025/2026';
const SUFFIX='JSS_1_First_Term_2025_2026',KEY='rsms_'+SID+'_scores_'+SUFFIX;
function fixture(scheme){
  const school={schoolId:SID,name:'Regression School',term:TERM,session:SESS,assessment:scheme};
  const students=[{id:'a',surname:'Ada',firstname:'A',class:CLASS,reg:'001'}];
  return {school,students,local:{rsms_school:school,['rsms_'+SID+'_students']:students},
    session:{rsms_user:{id:'u1',name:'User',role:'teacher',schoolId:SID,myClass:CLASS},rsms_auth:'true'}};
}
function context(w,subject='Mathematics',prefix='sc'){
  w.document.getElementById(prefix+'-class').value=CLASS;
  const s=w.document.getElementById(prefix+'-subject');s.innerHTML='<option>'+subject+'</option>';s.value=subject;
  w.document.getElementById(prefix+'-term').value=TERM;w.document.getElementById(prefix+'-session').value=SESS;
}
test('existing two-test schools keep working with custom maximums and no third-test column',async()=>{
  const scheme={tests:2,ca1:25,ca2:25,ca3:0,exam:50};
  const {school,students,local,session}=fixture(scheme);
  const fb=fakeFirebase({schools:{[SID]:{info:school,students}}});
  const p=loadPortal('rsms-teacher.html',{firebase:fb,localStorage:local,sessionStorage:session});
  try{
    context(p.window);p.window.loadScoreTable();
    assert.equal(p.document.getElementById('ca3_a'),null); // no third-test column in a pure two-test table
    assert.equal(p.document.getElementById('ca1_a').max,'25');assert.equal(p.document.getElementById('exam_a').max,'50');
    setInput(p.window,'ca1_a','25');setInput(p.window,'ca2_a','25');setInput(p.window,'exam_a','50');
    assert.equal(p.document.getElementById('tot_a').textContent,'100');
    p.window.saveTeacherScores();
    const saved=fb.state.schools[SID].score_entries[SUFFIX].a_Mathematics;
    assert.deepEqual(saved.assessment,scheme);assert.equal(saved.total,100);
    const csv=p.window.RSMSScoreImport.template({cls:CLASS,term:TERM,sess:SESS},students,['Mathematics'],scheme);
    assert.equal(p.window.RSMSScoreImport.parseCSV(csv)[0].length,10);
    assert.ok(!csv.includes('CA 3'));
    assert.deepEqual(p.errors,[]);
  }finally{await flush();p.close();}
});
test('invalid settings do not write; a failed shared save is reported and keeps the old scheme',async()=>{
  const legacy={tests:2,ca1:20,ca2:20,ca3:0,exam:60};
  const {school,local}=fixture(legacy);
  const fb=fakeFirebase({schools:{[SID]:{info:school}}},{failPath:'schools/'+SID+'/info/assessment'});
  const p=loadPortal('rsms-admin.html',{firebase:fb,localStorage:local,sessionStorage:{rsms_user:{role:'admin',schoolId:SID},rsms_auth:'true'}});
  try{
    p.window.loadSettings();setInput(p.window,'cfg-ca1-max','0');p.window.saveSettings();await flush();
    assert.equal(fb.writes.length,0);assert.deepEqual(fb.state.schools[SID].info.assessment,legacy);
    setInput(p.window,'cfg-ca1-max','10');setSelect(p.window,'cfg-assessment-tests','3');
    setInput(p.window,'cfg-ca2-max','10');setInput(p.window,'cfg-ca3-max','20');setInput(p.window,'cfg-exam-max','60');
    p.window.saveSettings();await flush();
    assert.deepEqual(fb.state.schools[SID].info.assessment,legacy);
    assert.match(p.document.getElementById('cfg-assessment-summary').textContent,/not saved/);
    assert.equal(p.document.getElementById('cfg-save-settings').disabled,false);
    assert.deepEqual(p.errors,[]);
  }finally{await flush();p.close();}
});
test('CSV cannot silently replace an older snapshot with the current scheme',async()=>{
  const three={tests:3,ca1:10,ca2:10,ca3:20,exam:60};
  const {school,students,local,session}=fixture(three);
  const legacy={stuId:'a',student:'Ada A',class:CLASS,subject:'Mathematics',term:TERM,session:SESS,ca1:5,ca2:5,exam:20,total:30};
  local[KEY]={a_Mathematics:legacy};
  const fb=fakeFirebase({schools:{[SID]:{info:school,students,score_entries:{[SUFFIX]:{a_Mathematics:legacy}}}}});
  const p=loadPortal('rsms-teacher.html',{firebase:fb,localStorage:local,sessionStorage:session});
  try{
    context(p.window);p.window.loadScoreTable();
    const CSV=p.window.RSMSScoreImport;
    const rows=CSV.parseCSV(CSV.template({cls:CLASS,term:TERM,sess:SESS},students,['Mathematics'],three));
    rows[1][7]='1';rows[1][8]='2';rows[1][9]='3';rows[1][10]='4';
    const text=rows.map(r=>r.join(',')).join('\n');
    const input=p.document.getElementById('score-csv-file');
    Object.defineProperty(input,'files',{value:[new p.window.File([text],'scores.csv',{type:'text/csv'})],configurable:true});
    p.window.previewScoreCSV(input);
    for(let i=0;i<20&&!p.window.scoreImportPending;i++)await flush(10);
    assert.ok(p.window.scoreImportPending);
    p.window.applyScoreCSV();
    assert.equal(Object.keys(p.window.scoreDrafts).length,0);
    assert.match(p.document.getElementById('rsms-toast').textContent,/older scheme/);
    assert.deepEqual(fb.state.schools[SID].score_entries[SUFFIX].a_Mathematics,legacy);
    assert.deepEqual(p.errors,[]);
  }finally{await flush();p.close();}
});
test('cumulative report totals use each term’s saved denominator',async()=>{
  const three={tests:3,ca1:10,ca2:10,ca3:20,exam:60};
  const {school,students,local}=fixture(three);
  const firstKey='rsms_'+SID+'_scores_JSS_1_First_Term_2025_2026';
  const secondKey='rsms_'+SID+'_scores_JSS_1_Second_Term_2025_2026';
  local[firstKey]={a_Mathematics:{stuId:'a',subject:'Mathematics',class:CLASS,term:'First Term',session:SESS,ca1:10,ca2:10,exam:30,total:50}};
  local[secondKey]={a_Mathematics:{stuId:'a',subject:'Mathematics',class:CLASS,term:'Second Term',session:SESS,ca1:10,ca2:10,ca3:20,exam:40,total:80,assessment:three}};
  const p=loadPortal('rsms-results-print.html',{localStorage:local,sessionStorage:{rsms_user:{role:'admin'}}});
  try{
    p.window.populateClassDropdown();p.window.loadScores(CLASS,'Second Term',SESS);
    p.document.getElementById('cls-sel').value=CLASS;p.document.getElementById('term-sel').value='Second Term';p.document.getElementById('sess-in').value=SESS;
    p.window.generateCards();
    const text=p.document.getElementById('cards-output').textContent;
    assert.match(text,/130 \/ 200/);assert.match(text,/65%/);assert.match(text,/T3 \/ CA3/);
    assert.deepEqual(p.errors,[]);
  }finally{await flush();p.close();}
});
test('LAN mode refuses an unsynced assessment write instead of bypassing the offline adapter',async()=>{
  const legacy={tests:2,ca1:20,ca2:20,ca3:0,exam:60};
  const {school,local}=fixture(legacy);
  const fb=fakeFirebase({schools:{[SID]:{info:school}}});
  const p=loadPortal('rsms-admin.html',{firebase:fb,localStorage:local,sessionStorage:{rsms_user:{role:'admin',schoolId:SID},rsms_auth:'true'}});
  try{
    p.window.RSMS_LOCAL={mode:'lan',schoolId:SID};
    p.window.loadSettings();setSelect(p.window,'cfg-assessment-tests','3');
    setInput(p.window,'cfg-ca1-max','10');setInput(p.window,'cfg-ca2-max','10');setInput(p.window,'cfg-ca3-max','20');setInput(p.window,'cfg-exam-max','60');
    p.window.saveSettings();await flush();
    assert.equal(fb.writes.length,0);
    assert.match(p.document.getElementById('cfg-assessment-summary').textContent,/offline appliance does not sync assessment schemes/);
    assert.deepEqual(p.errors,[]);
  }finally{await flush();p.close();}
});
