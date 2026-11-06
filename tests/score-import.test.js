const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../rsms-assessment.js');
require('../rsms-score-import.js');
const csv=globalThis.RSMSScoreImport;
const context={cls:'Primary 1',term:'First Term',sess:'2025/2026'};
const students=[{id:'a1',reg:'001',surname:'Ade, Jr',firstname:'Tolu'},{id:'b2',reg:'002',surname:'Bello'}];
const subjects=['Math','English'];
function row(id,subject,a,b,c){return [context.cls,context.term,context.sess,'id:'+id,'','',subject,a,b,c].join(',');}
function document(...rows){return csv.headers.join(',')+'\n'+rows.join('\n');}
test('template quotes names and skips blank rows',()=>{
 const text=csv.template(context,students,subjects);
 assert.equal(csv.parseCSV(text).length,5);
 assert.match(text,/"Ade, Jr Tolu"/);
 const result=csv.validate(text,context,students,subjects);
 assert.equal(result.blank,4);assert.equal(result.missing,2);assert.equal(result.errors.length,0);
});
test('valid rows calculate totals, including zero, and missing students are reported',()=>{
 const result=csv.validate(document(row('a1','Math',0,20,60)),context,students,subjects);
 assert.equal(result.errors.length,0);assert.equal(result.items[0].total,80);assert.equal(result.missing,1);
});
test('blocks invalid scores, duplicates, wrong context, IDs and subjects',()=>{
 const wrong=row('a1','Math',1,2,3).replace('First Term','Second Term');
 const result=csv.validate(document(row('a1','Math',1,2,3),row('a1','Math',1,2,3),row('a1','English',21,2,3),row('b2','Math',1,'',3),row('unknown','Math',1,2,3),row('b2','Other',1,2,3),wrong),context,students,subjects);
 assert.equal(result.errors.length,6);
});
test('rejects malformed CSV and protects spreadsheet text from formulas',()=>{
 assert.throws(()=>csv.parseCSV('"unterminated'));
 const result=csv.template(context,[{id:'a',surname:'=HYPERLINK("bad")'}],['Math']);
 assert.match(result,/"'=HYPERLINK/);
});
test('three-test templates and imports carry the configured maximums',()=>{
 const A=globalThis.RSMSAssessment, scheme={tests:3,ca1:10,ca2:15,ca3:20,exam:55};
 const text=csv.template(context,students,subjects,scheme);
 assert.deepEqual(csv.parseCSV(text)[0],csv.headersFor(scheme));
 function filled(id,subject,a,b,c,d){return [context.cls,context.term,context.sess,'id:'+id,'','',subject,a,b,c,d].join(',');}
 const doc=csv.headersFor(scheme).join(',')+'\n'+filled('a1','Math',0,15,20,55);
 const result=csv.validate(doc,context,students,subjects,scheme);
 assert.deepEqual(result.errors,[]); assert.equal(result.items[0].total,90); assert.deepEqual(result.items[0].assessment,scheme);
 const bad=csv.headersFor(scheme).join(',')+'\n'+filled('a1','Math',11,15,20,55);
 assert.match(csv.validate(bad,context,students,subjects,scheme).errors[0],/0 to 10/);
 assert.match(csv.validate(document(row('a1','Math',1,2,3)),context,students,subjects,scheme).errors[0],/3 tests/);
});
