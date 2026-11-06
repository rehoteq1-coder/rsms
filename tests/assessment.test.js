const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../rsms-assessment.js');
const A=globalThis.RSMSAssessment;
const two={tests:2,ca1:20,ca2:20,ca3:0,exam:60};
const three={tests:3,ca1:10,ca2:10,ca3:20,exam:60};
test('supports two and three tests with school-specific maximums',()=>{
 assert.deepEqual(A.validate(two),[]); assert.deepEqual(A.validate(three),[]);
 assert.equal(A.total({ca1:15,ca2:18,exam:50},two),83);
 assert.equal(A.total({ca1:5,ca2:8,ca3:17,exam:50},three),80);
 assert.equal(A.totalMax(two),100);assert.equal(A.totalMax(three),100);
});
test('validates marks and preserves zero rather than treating it as missing',()=>{
 assert.deepEqual(A.validateScores({ca1:0,ca2:0,ca3:0,exam:0},three,true),[]);
 assert.ok(A.validateScores({ca1:11,ca2:0,ca3:0,exam:0},three,true).length);
 assert.ok(A.validateScores({ca1:-1,ca2:0,ca3:0,exam:0},three,true).length);
 assert.ok(A.validateScores({ca1:1,ca2:0,ca3:'',exam:0},three,true).length);
 assert.ok(A.validateScores({ca1:1.5,ca2:0,ca3:0,exam:0},three,true).length);
});
test('old scores retain legacy scheme, snapshots stay independent of later changes',()=>{
 const record={assessment:{...three},ca1:5,ca2:8,ca3:17,exam:50};
 three.ca1=9;
 assert.equal(A.forRecord(record).ca1,10);
 assert.deepEqual(A.forRecord({ca1:5}),two);
 assert.throws(()=>A.forRecord({assessment:{tests:3}}),/Invalid saved/);
 assert.equal(A.total(record,A.forRecord(record)),80);
});
test('invalid or ambiguous maximums are rejected',()=>{
 assert.ok(A.validate({tests:4}).length);
 assert.ok(A.validate({tests:2,ca1:20,ca2:20,ca3:10,exam:50}).length);
 assert.ok(A.validate({tests:3,ca1:10,ca2:10,ca3:0,exam:60}).length);
});
test('settings parsing rejects ambiguous values and defaults an unused third test to zero',()=>{
 assert.deepEqual(A.fromForm({tests:'3',ca1:'10',ca2:'10',ca3:'20',exam:'60'}),{tests:3,ca1:10,ca2:10,ca3:20,exam:60});
 assert.deepEqual(A.fromForm({tests:'2',ca1:'20',ca2:'20',ca3:'',exam:'60'}),two);
 assert.ok(A.validate(A.fromForm({tests:'2',ca1:'20.5',ca2:'20',exam:'60'})).length);
 assert.ok(A.validate(A.fromForm({tests:'2',ca1:'20',ca2:'20',ca3:'5',exam:'60'})).length);
 assert.ok(A.validate(A.fromForm({tests:'3',ca1:'10',ca2:'10',ca3:'0',exam:'60'})).length);
});
test('new records snapshot the supplied scheme and overrides never adopt current settings',()=>{
 const scheme={tests:3,ca1:10,ca2:10,ca3:20,exam:60};
 const captured=A.copy(scheme);
 const record=A.createRecord({stuId:'s1',subject:'Math'}, {ca1:5,ca2:8,ca3:17,exam:50}, captured);
 captured.ca1=99;
 assert.equal(record.assessment.ca1,10);
 const changedSchool={assessment:{tests:2,ca1:30,ca2:30,ca3:0,exam:40}};
 const updated=A.updateRecord(record,{ca1:6,ca2:8,ca3:17,exam:50});
 assert.deepEqual(updated.assessment,scheme); assert.equal(updated.total,81);
 assert.equal(A.forSchool(changedSchool).ca1,30);
 assert.throws(()=>A.createRecord({}, {ca1:5,ca2:8,exam:50}, three),/T3/);
});
test('historical and mixed-scheme summaries use snapshot denominators',()=>{
 const old={ca1:20,ca2:20,exam:60};
 const custom=A.createRecord({},{ca1:5,ca2:8,ca3:17,exam:50},{tests:3,ca1:10,ca2:10,ca3:20,exam:60});
 const summary=A.summarize([old,custom]);
 assert.equal(summary.total,180); assert.equal(summary.totalMax,200); assert.equal(summary.percent,90);
 assert.equal(A.viewRecord({total:0}).total,0);
 assert.equal(A.viewRecord({total:0}).percent,0);
 assert.equal(A.viewRecord({ca1:0,ca2:0,exam:0}).total,0);
 assert.ok(A.viewRecord({assessment:{tests:3}}).error);
 assert.equal(A.viewRecord({ca1:5}).complete,false);
});
