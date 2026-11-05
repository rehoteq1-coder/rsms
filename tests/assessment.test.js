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
