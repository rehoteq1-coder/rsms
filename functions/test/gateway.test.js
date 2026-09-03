'use strict';

var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var test = require('node:test');
var gateway = require('../src/gateway');

function pendingData(){
  return {
    wallet:[{
      id:'wallet-1', walId:'WAL/2026/1/00001', stuId:'stu-1', student:'Ada Obi',
      type:'credit', amount:2500, status:'Pending', ref:'RSMS-WAL-123'
    }],
    fees:[{
      id:'fee-1', txId:'SP-123', receiptNo:'RCP/2026/1/00001', stuId:'stu-1',
      student:'Ada Obi', amount:4000, status:'Pending', ref:'RSMS-SP-123'
    }],
    payments:[{
      id:'payment-1', txId:'SP-123', receiptNo:'RCP/2026/1/00001', stuId:'stu-1',
      student:'Ada Obi', amount:4000, status:'Pending', ref:'RSMS-SP-123'
    }],
    audit_log:[]
  };
}

test('maps Flutterwave success, pending, and failed responses', function(){
  assert.deepEqual(gateway.mapFlutterwaveResponse({status:'success', data:{status:'successful', amount:'1250.50', tx_id:'flw-1'}}), {
    ok:true, pending:false, amount:1250.5, gatewayId:'flw-1'
  });
  assert.equal(gateway.mapFlutterwaveResponse({data:{status:'authorized', amount:50, tx_id:'flw-2'}}).pending, true);
  assert.equal(gateway.mapFlutterwaveResponse({status:'error', data:{status:'failed'}}).ok, false);
});

test('maps Paystack success in kobo, pending, and failed responses', function(){
  assert.deepEqual(gateway.mapPaystackResponse({status:true, data:{status:'success', amount:125050, id:98}}), {
    ok:true, pending:false, amount:1250.5, gatewayId:98
  });
  assert.equal(gateway.mapPaystackResponse({status:true, data:{status:'pending', amount:100}}).pending, true);
  assert.equal(gateway.mapPaystackResponse({status:false, data:{status:'failed', amount:100}}).ok, false);
});

test('checks Flutterwave SHA-512 and Paystack HMAC signatures', function(){
  var body = Buffer.from('{"event":"charge.success"}');
  var flw = crypto.createHash('sha512').update(body).digest('hex');
  var paystack = crypto.createHmac('sha512', 'test-secret').update(body).digest('hex');
  assert.equal(gateway.checkFlutterwaveSignature(body, flw.toUpperCase()), true);
  assert.equal(gateway.checkFlutterwaveSignature(body, flw.slice(0, -1)+'0'), false);
  assert.equal(gateway.checkPaystackSignature(body, paystack, 'test-secret'), true);
  assert.equal(gateway.checkPaystackSignature(body, paystack, 'wrong-secret'), false);
});

test('finds pending records by exact or prefix reference only', function(){
  var data = pendingData();
  var all = gateway.findPendingRecords(data, 'RSMS-SP-123');
  assert.deepEqual(all.map(function(row){ return row.collection; }).sort(), ['fees','payments']);
  assert.equal(gateway.findPendingRecords(data, 'RSMS-SP').length, 2);
  data.fees[0].status = 'Confirmed';
  assert.equal(gateway.findPendingRecords(data, 'RSMS-SP-123').length, 1);
});

test('rejects a wallet credit unless the verified amount exactly matches', function(){
  var result = gateway.applyVerification(pendingData(), {ok:true, amount:2499.99, gatewayId:'flw-verify-1'}, 'RSMS-WAL-123', 'flutterwave');
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].status, 'Rejected');
  assert.equal(result.data.wallet[0].status, 'Rejected');
  assert.match(result.data.wallet[0].statusNote, /exactly match/);
  assert.equal(result.audit.length, 1);
  assert.match(result.audit[0].details, /Ada Obi/);
});

test('confirms fee and payment records when verified amount is at least the recorded amount', function(){
  var result = gateway.applyVerification(pendingData(), {ok:true, amount:4500, gatewayId:'ps-verify-1'}, 'RSMS-SP-123', 'paystack');
  assert.equal(result.applied.length, 2);
  assert.deepEqual(result.applied.map(function(row){ return row.status; }), ['Confirmed','Confirmed']);
  assert.equal(result.data.fees[0].status, 'Confirmed');
  assert.equal(result.data.payments[0].status, 'Confirmed');
  assert.equal(result.audit.length, 2);
});

test('is idempotent after a pending record has been transitioned', function(){
  var first = gateway.applyVerification(pendingData(), {ok:true, amount:4000, gatewayId:'ps-verify-2'}, 'RSMS-SP-123', 'paystack');
  var second = gateway.applyVerification(first.data, {ok:true, amount:4000, gatewayId:'ps-verify-2'}, 'RSMS-SP-123', 'paystack');
  assert.equal(first.applied.length, 2);
  assert.equal(second.applied.length, 0);
  assert.equal(second.audit.length, 0);
});

test('validates gateway secret key formats per provider', function(){
  assert.equal(gateway.isValidGatewayKey('flutterwave', 'FLWSEC-abcdef123456'), true);
  assert.equal(gateway.isValidGatewayKey('flutterwave', '  FLWSEC-abcdef123456  '), true);
  assert.equal(gateway.isValidGatewayKey('flutterwave', 'flwsec-abcdef'), false);
  assert.equal(gateway.isValidGatewayKey('flutterwave', 'FLWPUBK-abcdef'), false);
  assert.equal(gateway.isValidGatewayKey('flutterwave', ''), false);
  assert.equal(gateway.isValidGatewayKey('paystack', 'sk_test_abc123'), true);
  assert.equal(gateway.isValidGatewayKey('paystack', 'sk_live_abc123'), true);
  assert.equal(gateway.isValidGatewayKey('paystack', 'pk_test_abc123'), false);
  assert.equal(gateway.isValidGatewayKey('paystack', 'FLWSEC-abc'), false);
});

test('maps school and provider to stable secret manager names', function(){
  assert.equal(gateway.schoolSecretName('flutterwave', 'green-valley-sec'), 'rsms-flw-green-valley-sec');
  assert.equal(gateway.schoolSecretName('paystack', 'Green Valley School'), 'rsms-ps-green-valley-school');
  assert.equal(gateway.schoolSecretName('flutterwave', 'a'), 'rsms-flw-a');
  assert.throws(function(){ gateway.schoolSecretName('paypal', 'x'); });
  assert.throws(function(){ gateway.schoolSecretName('flutterwave', ''); });
});

test('parses the webhook school query param safely', function(){
  assert.equal(gateway.parseSchoolQuery('green-valley-sec'), 'green-valley-sec');
  assert.equal(gateway.parseSchoolQuery('My School!'), 'MySchool');
  assert.equal(gateway.parseSchoolQuery('--x--'), 'x');
  assert.equal(gateway.parseSchoolQuery(undefined), '');
  assert.equal(gateway.parseSchoolQuery('a'.repeat(200)), '');
});

test('provider flag keys map to flw_config metadata', function(){
  assert.equal(gateway.providerFlagKey('flutterwave'), 'hasFlwSecret');
  assert.equal(gateway.providerFlagKey('paystack'), 'hasPsSecret');
  assert.equal(gateway.providerFlagKey('other'), '');
});
