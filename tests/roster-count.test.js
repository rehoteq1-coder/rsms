const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
require('../rsms-roster.js');
const R=globalThis.RSMSRoster;
test('counts valid records consistently in arrays and database objects',()=>{
 const roster=[{id:'a',surname:'Ada'},{id:'b',firstname:'Bob'},null,{id:'c',surname:'  '},{name:'metadata'},true];
 assert.equal(R.count(roster,'students'),2);
 assert.equal(R.count({...roster,_syncTs:123},'students'),2);
 assert.equal(R.count({one:{id:'s',name:'Staff'},_syncTs:123},'staff'),1);
 assert.equal(R.count(null,'students'),0);
});
test('does not truncate large school rosters',()=>{
 const rows=Array.from({length:2505},(_,i)=>({id:'s'+i,firstname:'Student'}));
 assert.equal(R.count(rows,'students'),2505);
});
test('school counters read full roster and handle failed reads without inventing zero',async()=>{
 const html=fs.readFileSync('rsms-superadmin.html','utf8');
 const fn=html.slice(html.indexOf('function _fillLiveCounts()'),html.indexOf('function initCreateForm()'));
 function element(id){return {textContent:'',title:'',getAttribute:k=>k==='data-sid'?id:'students'};}
 const ok=element('ok'),fail=element('fail');
 const ctx={RSMSRoster:R,document:{querySelectorAll:()=>[ok,fail]},_fbDB:()=>({ref:path=>({once:()=>path.includes('/ok/')?Promise.resolve({val:()=>({a:{id:'1',surname:'Ok'},_syncTs:123})}):Promise.reject(Error('offline'))})})};
 vm.createContext(ctx);vm.runInContext(fn,ctx);ctx._fillLiveCounts();
 await new Promise(r=>setImmediate(r));
 assert.equal(ok.textContent,1);assert.equal(fail.textContent,'—');
});
test('admin startup does not write cached rosters to the database as a reconciliation',()=>{
 const html=fs.readFileSync('rsms-admin.html','utf8');
 const start=html.indexOf('/* ── RSMS DATA BRIDGE');
 const end=html.indexOf('/* Safe save wrappers',start);
 const startup=html.slice(start,end);
 assert.doesNotMatch(startup,/RSMS_DB\.set\(/);
 assert.doesNotMatch(startup,/unscopedLen\s*>\s*scopedLen/);
 assert.match(html,/function checkStudentRosterCounts\(\)/);
});
test('diagnoses the reported 2-vs-18 mismatch without changing either roster',()=>{
 const local=[{id:'a',surname:'Ada'},{id:'b',surname:'Ben'}];
 const remote=Array.from({length:18},(_,i)=>({id:'s'+i,surname:'Student'}));
 remote.push({id:'s0',surname:'Duplicate'},{id:'no-name',surname:' '});
 const beforeLocal=JSON.stringify(local),beforeRemote=JSON.stringify(remote);
 const d=R.diagnose(local,remote,'students');
 assert.equal(d.local.valid,2);assert.equal(d.database.valid,19);
 assert.equal(d.database.duplicateIds.length,1);assert.equal(d.database.invalid,1);
 assert.equal(d.missingFromLocal.length,18);assert.equal(d.extraInLocal.length,2);
 assert.equal(JSON.stringify(local),beforeLocal);assert.equal(JSON.stringify(remote),beforeRemote);
});
test('offline backup checker recomputes counts and never rewrites the backup',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rsms-roster-'));
 const file=path.join(dir,'backup.json');
 const backup={format:'rsms-roster-backup-v1',readOnly:true,schoolId:'REH-2J8KQ2XF',capturedAt:'2026-11-06T00:00:00Z',
   databasePath:'schools/REH-2J8KQ2XF/students',dashboardCount:2,
   local:[{id:'a',surname:'A'},{id:'b',surname:'B'}],
   database:Object.fromEntries(Array.from({length:18},(_,i)=>['s'+i,{id:'s'+i,surname:'S'}]))};
 fs.writeFileSync(file,JSON.stringify(backup));const before=fs.readFileSync(file,'utf8');
 const run=cp.spawnSync(process.execPath,[path.join(__dirname,'..','tools','roster-backup-check.js'),file,'--json'],{encoding:'utf8'});
 assert.equal(run.status,1);const report=JSON.parse(run.stdout);
 assert.equal(report.diagnosis.local.valid,2);assert.equal(report.diagnosis.database.valid,18);
 assert.equal(report.diagnosis.missingFromLocal.length,18);assert.equal(report.matches,false);
 assert.equal(fs.readFileSync(file,'utf8'),before);
 fs.rmSync(dir,{recursive:true,force:true});
});
