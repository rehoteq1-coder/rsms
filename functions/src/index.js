'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS PAYMENT GATEWAY CLOUD FUNCTIONS
   No gateway secret is accepted from, or exposed to, a browser. The callable
   verifier can only transition existing Pending ledger entries after asking
   the gateway's server API. It never creates a payment or wallet credit.
═══════════════════════════════════════════════════════════════ */

var admin = require('firebase-admin');
var crypto = require('crypto');
var https = require('firebase-functions/v2/https');
var params = require('firebase-functions/params');
var gateway = require('./gateway');

if(!admin.apps.length) admin.initializeApp();

function database(){ return admin.database(); }

var flutterwaveSecret = params.defineSecret('FLUTTERWAVE_SECRET_KEY');
var paystackSecret = params.defineSecret('PAYSTACK_SECRET_KEY');

function cleanText(value, maxLength){
  var text = String(value === undefined || value === null ? '' : value).replace(/^\s+|\s+$/g, '');
  return text.slice(0, maxLength || 400);
}

function normaliseProvider(value){
  var provider = cleanText(value, 32).toLowerCase();
  if(provider === 'flw') provider = 'flutterwave';
  if(provider === 'ps') provider = 'paystack';
  return provider;
}

function responseError(message, status){
  var error = new Error(message);
  error.status = status || 502;
  return error;
}

function secretValue(secret){
  try { return cleanText(secret.value(), 1000); }
  catch(e){ return ''; }
}

function timingSafeTextEqual(left, right){
  var a = Buffer.from(String(left || ''), 'utf8');
  var b = Buffer.from(String(right || ''), 'utf8');
  if(!a.length || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); }
  catch(e){ return false; }
}

function sha256(value){
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function stringList(value, maxItems, maxItemLength){
  var seen = {};
  var rows = Array.isArray(value) ? value : [];
  return rows.reduce(function(out, entry){
    var item = cleanText(entry, maxItemLength || 80).toLowerCase();
    if(item && !seen[item] && out.length < (maxItems || 25)){
      seen[item] = true;
      out.push(item);
    }
    return out;
  }, []);
}

function mapFromResponse(provider, response){
  return provider === 'flutterwave' ? gateway.mapFlutterwaveResponse(response) : gateway.mapPaystackResponse(response);
}

function providerVerification(provider, reference){
  var ref = cleanText(reference, 300);
  var url;
  var headers = {accept:'application/json'};
  var secret;

  if(!ref) return Promise.reject(responseError('A payment reference is required.', 400));
  if(provider !== 'flutterwave' && provider !== 'paystack'){
    return Promise.reject(responseError('Unsupported payment provider.', 400));
  }

  if(provider === 'flutterwave'){
    secret = secretValue(flutterwaveSecret);
    if(!secret) return Promise.reject(responseError('Flutterwave verification is not configured.', 503));
    url = 'https://api.flutterwave.com/v3/transactions/'+encodeURIComponent(ref)+'/verify';
    headers.Authorization = 'Bearer '+secret;
  }else{
    secret = secretValue(paystackSecret);
    if(!secret) return Promise.reject(responseError('Paystack verification is not configured.', 503));
    url = 'https://api.paystack.co/transaction/verify/'+encodeURIComponent(ref);
    headers.Authorization = 'Bearer '+secret;
  }

  return fetch(url, {method:'GET', headers:headers}).catch(function(){
    throw responseError('The payment provider could not be reached.', 503);
  }).then(function(response){
    return response.json().catch(function(){
      throw responseError('The payment provider returned an invalid response.', 502);
    }).then(function(body){
      if(!response.ok){
        throw responseError('The payment provider declined verification.', response.status >= 500 ? 503 : 502);
      }
      return mapFromResponse(provider, body);
    });
  });
}

function listSchoolIds(requestedSchoolId){
  return database().ref('schools').limitToLast(200).once('value').then(function(snapshot){
    var schools = snapshot.val() || {};
    var ids = Object.keys(schools);
    var requested = cleanText(requestedSchoolId, 160);
    if(requested) ids = ids.filter(function(id){ return id === requested; });
    return ids;
  });
}

function resultSummary(verdict, transitions){
  var applied = [];
  var rejected = false;
  var pending = !!verdict.pending;
  transitions.forEach(function(transition){
    (transition.applied || []).forEach(function(item){
      applied.push(item);
      if(item.status === 'Rejected') rejected = true;
    });
  });
  return {
    verified:!!verdict.ok,
    pending:pending,
    rejected:rejected || (!verdict.ok && !pending),
    reason:verdict.reason || '',
    applied:applied
  };
}

function applyForSchool(schoolId, reference, provider, verdict){
  var rootRef = database().ref('schools/'+schoolId);
  var finalTransition = null;
  return rootRef.transaction(function(current){
    var transition;
    if(!current) return;
    transition = gateway.applyVerification(current, verdict, reference, provider);
    finalTransition = transition;
    if(!transition.applied.length) return;

    // The transaction atomically carries the changed ledger collections and
    // the appended server audit log together. Existing non-money branches are
    // left untouched; money rows are only status transitions.
    transition.applied.forEach(function(item){
      if(item.collection === 'wallet') current.wallet = transition.data.wallet;
      if(item.collection === 'fees') current.fees = transition.data.fees;
      if(item.collection === 'payments') current.payments = transition.data.payments;
    });
    current.audit_log = transition.data.audit_log;
    return current;
  }, undefined, false).then(function(transaction){
    if(!transaction.committed || !finalTransition){
      return {schoolId:schoolId, applied:[], records:[]};
    }
    return {
      schoolId:schoolId,
      applied:finalTransition.applied || [],
      records:finalTransition.records || []
    };
  });
}

function runVerification(input){
  input = input || {};
  var reference = cleanText(input.ref, 300);
  var provider = normaliseProvider(input.provider);

  if(!reference) return Promise.reject(responseError('A payment reference is required.', 400));
  if(provider !== 'flutterwave' && provider !== 'paystack'){
    return Promise.reject(responseError('Choose Flutterwave or Paystack.', 400));
  }

  return providerVerification(provider, reference).then(function(verdict){
    return listSchoolIds(input.schoolId).then(function(ids){
      var transitions = [];
      function applyNext(index){
        if(index >= ids.length) return Promise.resolve();
        return applyForSchool(ids[index], reference, provider, verdict).then(function(transition){
          transitions.push(transition);
          return applyNext(index + 1);
        });
      }
      return applyNext(0).then(function(){ return resultSummary(verdict, transitions); });
    });
  });
}

function callableData(request){
  return request && request.data && typeof request.data === 'object' ? request.data : {};
}

exports.verifyPayment = https.onCall({
  maxInstances:10,
  secrets:[flutterwaveSecret, paystackSecret]
}, function(request){
  var data = callableData(request);
  // Intentionally no auth gate: the function only verifies an already
  // Pending record against the gateway and cannot introduce money records.
  return runVerification(data).catch(function(error){
    if(error && error.status === 400) throw new https.HttpsError('invalid-argument', error.message);
    if(error && error.status === 503) throw new https.HttpsError('unavailable', error.message);
    throw new https.HttpsError('internal', 'Payment verification could not be completed.');
  });
});

exports.paymentWebhook = https.onRequest({
  cors:[],
  secrets:[flutterwaveSecret, paystackSecret]
}, function(request, response){
  var provider;
  var signature;
  var reference;
  var valid;
  var body = request.body || {};

  if(request.method !== 'POST'){
    response.status(405).json({error:'method-not-allowed'});
    return;
  }

  if(request.get('x-paystack-signature')){
    provider = 'paystack';
    signature = request.get('x-paystack-signature');
    valid = gateway.checkPaystackSignature(request.rawBody || '', signature, secretValue(paystackSecret));
    reference = body && body.data && (body.data.reference || body.data.tx_ref);
  }else if(request.get('x-flw-signature')){
    provider = 'flutterwave';
    signature = request.get('x-flw-signature');
    valid = gateway.checkFlutterwaveSignature(request.rawBody || '', signature);
    reference = (body && body.transaction && body.transaction.reference) || (body && body.tx_ref);
  }else{
    response.status(401).json({error:'missing-gateway-signature'});
    return;
  }

  if(!valid){
    response.status(401).json({error:'invalid-gateway-signature'});
    return;
  }
  if(!cleanText(reference, 300)){
    response.status(400).json({error:'missing-payment-reference'});
    return;
  }

  return runVerification({ref:reference, provider:provider}).then(function(result){
    response.status(200).json({status:'ok', data:result});
  }).catch(function(){
    // A non-2xx response lets the gateway retry transient provider/database
    // failures. Validation errors were already excluded above.
    response.status(500).json({status:'retry', error:'verification-failed'});
  });
});

exports.provisionUser = https.onCall({maxInstances:10}, function(request){
  var data = callableData(request);
  var password = cleanText(data.password, 1000);
  var uid = cleanText(data.uid, 128);
  var name = cleanText(data.name, 160);
  var roles = stringList(data.roles, 12, 40);
  var schools = stringList(data.schoolIds, 100, 160);
  var roleMap = {};
  var schoolMap = {};

  return database().ref('config/superadmin_hash').once('value').then(function(snapshot){
    var expectedHash = cleanText(snapshot.val(), 256).toLowerCase();
    if(!password || !expectedHash || !timingSafeTextEqual(sha256(password), expectedHash)){
      throw new https.HttpsError('permission-denied', 'permission-denied');
    }
    if(!uid || !roles.length || !schools.length){
      throw new https.HttpsError('invalid-argument', 'uid, at least one role, and at least one school are required.');
    }

    roles.forEach(function(role){ roleMap[role] = true; });
    schools.forEach(function(schoolId){ schoolMap[schoolId] = true; });

    return database().ref('users/'+uid).set({
      name:name || uid,
      roles:roles,
      roleMap:roleMap,
      schoolIds:schoolMap,
      provisionedAt:new Date().toISOString()
    }).then(function(){
      return admin.auth().setCustomUserClaims(uid, {
        roles:roles,
        roleMap:roleMap,
        schoolIds:schoolMap
      });
    }).then(function(){
      return {ok:true, uid:uid};
    });
  }).catch(function(error){
    if(error instanceof https.HttpsError) throw error;
    throw new https.HttpsError('internal', 'User provisioning could not be completed.');
  });
});

// Exported only for focused emulator/integration tests; deployment exports are
// the three functions above.
exports._private = {
  runVerification:runVerification,
  providerVerification:providerVerification,
  listSchoolIds:listSchoolIds,
  timingSafeTextEqual:timingSafeTextEqual,
  sha256:sha256
};
