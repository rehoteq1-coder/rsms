const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../rsms-assessment.js');
const A=globalThis.RSMSAssessment;
const html = fs.readFileSync('rsms-teacher.html', 'utf8');
function setup() {
  const elements = {};
  const data = {};
  const localStorage = {getItem:k=>data[k] || null, setItem:(k,v)=>{data[k]=v;}};
  const ctx = { document:{getElementById:id=>elements[id]}, window:{addEventListener(){}}, localStorage,
    RSMSAssessment:A, RSMS:{user:()=>({name:'Teacher'})}, toast:()=>{}, _scoreKey:(c,t,s)=>`scoped_${c}_${t}_${s}`,
    _get:()=>({}), JSON, Object, Number, Date };
  vm.createContext(ctx);
  const start=html.indexOf('var scoreDrafts = {}');
  const end=html.indexOf('\n</script>', start);
  vm.runInContext(html.slice(start,end),ctx);
  return {ctx,elements,data};
}
test('switching subjects retains drafts and saves them together without removing other scores',()=>{
  const {ctx,elements,data}=setup();
  data.scoped_Primary = '';
  const first={cls:'Primary 1',term:'First Term',sess:'2025/2026',subj:'Mathematics',scheme:A.legacy()};
  const key=ctx._scoreKey(first.cls,first.term,first.sess);
  data[key]=JSON.stringify({'old_English':{subject:'English',total:50}});
  elements.ca1_1={value:'0'}; elements.ca2_1={value:'15'}; elements.exam_1={value:'50'};
  ctx.scoreActive=first; ctx.recordScoreDraft({id:'1',surname:'Ada'});
  ctx.scoreActive={...first,subj:'English Language'};
  elements.ca1_1.value='10'; ctx.recordScoreDraft({id:'1',surname:'Ada'});
  ctx.saveTeacherScores();
  const saved=JSON.parse(data[key]);
  assert.equal(saved['1_Mathematics'].total,65);
  assert.equal(saved['1_English_Language'].total,75);
  assert.equal(saved.old_English.total,50);
  assert.equal(Object.keys(ctx.scoreDrafts).length,0);
});
test('invalid or published scores are not saved and drafts remain',()=>{
  const {ctx,elements,data}=setup();
  ctx.scoreActive={cls:'Primary 1',term:'First Term',sess:'2025/2026',subj:'Math',scheme:A.legacy()};
  elements.ca1_1={value:'21'}; elements.ca2_1={value:'0'}; elements.exam_1={value:'0'};
  ctx.recordScoreDraft({id:'1'}); ctx.saveTeacherScores();
  assert.equal(Object.keys(data).length,0); assert.equal(Object.keys(ctx.scoreDrafts).length,1);
  elements.ca1_1.value='20'; ctx.recordScoreDraft({id:'1'});
  ctx._get=()=>({'Primary 1':{'First Term':true}}); ctx.saveTeacherScores();
  assert.equal(Object.keys(data).length,0); assert.equal(Object.keys(ctx.scoreDrafts).length,1);
});
