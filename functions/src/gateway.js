'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS PAYMENT GATEWAY HELPERS
   Pure, dependency-free logic for provider mapping, signatures, and the
   in-memory verification transition. Firebase I/O lives in index.js.
═══════════════════════════════════════════════════════════════ */

var crypto = require('crypto');

function asNumber(value){
  var parsed = parseFloat(value);
  return isFinite(parsed) ? parsed : 0;
}

function money(value){
  return Math.round(asNumber(value) * 100) / 100;
}

function rawBuffer(rawBody){
  if(Buffer.isBuffer(rawBody)) return rawBody;
  if(rawBody === undefined || rawBody === null) return Buffer.from('');
  return Buffer.from(String(rawBody));
}

function safeHexEqual(expected, received){
  if(!expected || !received) return false;
  var actual = String(received).trim().toLowerCase();
  var wanted = String(expected).trim().toLowerCase();
  if(actual.length !== wanted.length) return false;
  try{
    return crypto.timingSafeEqual(Buffer.from(wanted, 'utf8'), Buffer.from(actual, 'utf8'));
  }catch(e){
    return false;
  }
}

function mapFlutterwaveResponse(response){
  var data = response && response.data ? response.data : {};
  var status = String(data.status || '').toLowerCase();
  if(response && String(response.status || '').toLowerCase() === 'success' &&
      (status === 'successful' || status === 'completed')){
    return {ok:true, pending:false, amount:money(data.amount), gatewayId:data.tx_id || data.id || ''};
  }
  if(status === 'pending' || status === 'authorized'){
    return {ok:false, pending:true, amount:money(data.amount), gatewayId:data.tx_id || data.id || ''};
  }
  return {ok:false, pending:false, amount:money(data.amount), gatewayId:data.tx_id || data.id || '', reason:status || 'verification-failed'};
}

function mapPaystackResponse(response){
  var data = response && response.data ? response.data : {};
  var status = String(data.status || '').toLowerCase();
  if(response && response.status === true && status === 'success'){
    return {ok:true, pending:false, amount:money(asNumber(data.amount) / 100), gatewayId:data.id || data.reference || ''};
  }
  if(status === 'pending' || status === 'default'){
    return {ok:false, pending:true, amount:money(asNumber(data.amount) / 100), gatewayId:data.id || data.reference || ''};
  }
  return {ok:false, pending:false, amount:money(asNumber(data.amount) / 100), gatewayId:data.id || data.reference || '', reason:status || 'verification-failed'};
}

function checkFlutterwaveSignature(rawBody, header){
  var digest = crypto.createHash('sha512').update(rawBuffer(rawBody)).digest('hex');
  return safeHexEqual(digest, header);
}

function checkPaystackSignature(rawBody, header, secret){
  if(!secret) return false;
  var digest = crypto.createHmac('sha512', String(secret)).update(rawBuffer(rawBody)).digest('hex');
  return safeHexEqual(digest, header);
}

function collectionEntries(value){
  if(Array.isArray(value)){
    return value.map(function(record, index){ return {key:String(index), record:record}; }).filter(function(row){ return !!row.record; });
  }
  if(value && typeof value === 'object'){
    return Object.keys(value).map(function(key){ return {key:key, record:value[key]}; }).filter(function(row){ return !!row.record; });
  }
  return [];
}

function refMatches(value, txRef){
  var stored = String(value || '');
  var requested = String(txRef || '');
  if(!stored || !requested) return false;
  return stored === requested || stored.indexOf(requested) === 0 || requested.indexOf(stored) === 0;
}

function recordId(collection, key, record){
  if(collection === 'wallet') return record.walId || record.id || key;
  return record.txId || record.id || record.receiptNo || key;
}

function findPendingRecords(db, txRef){
  var results = [];
  ['wallet','fees','payments'].forEach(function(collection){
    collectionEntries(db && db[collection]).forEach(function(row){
      var record = row.record || {};
      if(record.status === 'Pending' && refMatches(record.ref, txRef)){
        results.push({
          collection:collection,
          key:row.key,
          id:recordId(collection, row.key, record),
          record:record
        });
      }
    });
  });
  return results;
}

function clone(value){
  return JSON.parse(JSON.stringify(value || {}));
}

function toArrays(db){
  var input = db || {};
  return {
    wallet:collectionEntries(input.wallet).map(function(row){ return clone(row.record); }),
    fees:collectionEntries(input.fees).map(function(row){ return clone(row.record); }),
    payments:collectionEntries(input.payments).map(function(row){ return clone(row.record); }),
    audit_log:collectionEntries(input.audit_log).map(function(row){ return clone(row.record); })
  };
}

function findRecordIndex(collection, descriptor, rows){
  var target = descriptor.record || {};
  for(var i=0;i<rows.length;i++){
    var row = rows[i] || {};
    if((target.id && row.id === target.id) ||
       (descriptor.collection === 'wallet' && target.walId && row.walId === target.walId) ||
       (descriptor.collection !== 'wallet' && target.txId && row.txId === target.txId) ||
       (target.receiptNo && row.receiptNo === target.receiptNo && row.ref === target.ref)){
      return i;
    }
  }
  return -1;
}

function auditFor(record, collection, provider, verdict, before, status, note){
  var isWallet = collection === 'wallet';
  return {
    id:'gateway-audit-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),
    action:status === 'Confirmed' ? 'Gateway verification confirmed' : 'Gateway verification rejected',
    type:isWallet ? 'wallet_credit' : 'fee_payment',
    details:(isWallet ? 'Wallet ' + (record.walId || record.id || '') : 'Payment ' + (record.txId || record.receiptNo || record.id || ''))+
      ' for '+(record.student || 'Unknown Student')+': '+(before.status || 'Pending')+' → '+status+
      ' · provider transaction '+(verdict.gatewayId || 'unknown')+' · ₦'+money(verdict.amount).toLocaleString()+' · '+note,
    before:before,
    after:record,
    timestamp:new Date().toISOString(),
    date:new Date().toISOString().slice(0,10),
    user:'System (gateway webhook/verify)',
    provider:provider || '',
    gatewayId:verdict.gatewayId || '',
    verifiedAmount:money(verdict.amount)
  };
}

function applyVerification(db, verdict, txRef, provider){
  var source = db || {};
  var pending = findPendingRecords(source, txRef);
  var data = toArrays(source);
  var result = {
    records:pending.map(function(row){
      return {collection:row.collection, key:row.key, id:row.id, ref:row.record.ref || '', status:row.record.status};
    }),
    applied:[],
    audit:[],
    data:data,
    pending:!!(verdict && verdict.pending),
    verified:!!(verdict && verdict.ok),
    rejected:false
  };

  if(!pending.length || result.pending) return result;

  pending.forEach(function(descriptor){
    var rows = data[descriptor.collection] || [];
    var index = findRecordIndex(descriptor.collection, descriptor, rows);
    if(index < 0) return;
    var record = rows[index];
    if(record.status !== 'Pending') return;
    var before = clone(record);
    var verifiedAmount = money(verdict && verdict.amount);
    var requiredAmount = money(record.amount);
    var isWalletCredit = descriptor.collection === 'wallet' && record.type === 'credit';
    var amountMatches = isWalletCredit ? verifiedAmount === requiredAmount : verifiedAmount >= requiredAmount;
    var confirmed = !!(verdict && verdict.ok) && amountMatches;
    var status = confirmed ? 'Confirmed' : 'Rejected';
    var note;

    if(confirmed){
      note = 'Gateway verified ('+(provider || 'provider')+'): '+(verdict.gatewayId || 'transaction')+' · ₦'+verifiedAmount.toLocaleString();
    }else if(verdict && verdict.ok && !amountMatches){
      note = isWalletCredit ?
        'Gateway verification rejected: wallet amount must exactly match ₦'+requiredAmount.toLocaleString()+', received ₦'+verifiedAmount.toLocaleString() :
        'Gateway verification rejected: expected at least ₦'+requiredAmount.toLocaleString()+', received ₦'+verifiedAmount.toLocaleString();
    }else{
      note = 'Gateway verification rejected: '+((verdict && verdict.reason) || 'payment was not successful');
    }

    record.status = status;
    record.statusNote = note;
    record.note = note;
    record.gatewayProvider = provider || '';
    record.gatewayId = (verdict && verdict.gatewayId) || '';
    record.verifiedAmount = verifiedAmount;
    record.verifiedAt = new Date().toISOString();
    rows[index] = record;

    var applied = {
      collection:descriptor.collection,
      key:descriptor.key,
      id:recordId(descriptor.collection, descriptor.key, record),
      txId:record.txId || '',
      walId:record.walId || '',
      receiptNo:record.receiptNo || '',
      ref:record.ref || '',
      status:status,
      statusNote:note,
      amount:requiredAmount,
      verifiedAmount:verifiedAmount,
      gatewayId:(verdict && verdict.gatewayId) || '',
      provider:provider || '',
      verifiedAt:record.verifiedAt || ''
    };
    result.applied.push(applied);
    var audit = auditFor(clone(record), descriptor.collection, provider, verdict || {}, before, status, note);
    result.audit.push(audit);
    data.audit_log.push(audit);
    if(status === 'Rejected') result.rejected = true;
  });

  return result;
}

module.exports = {
  mapFlutterwaveResponse:mapFlutterwaveResponse,
  mapPaystackResponse:mapPaystackResponse,
  checkFlutterwaveSignature:checkFlutterwaveSignature,
  checkPaystackSignature:checkPaystackSignature,
  findPendingRecords:findPendingRecords,
  applyVerification:applyVerification
};
