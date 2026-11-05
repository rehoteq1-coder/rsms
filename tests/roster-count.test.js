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
