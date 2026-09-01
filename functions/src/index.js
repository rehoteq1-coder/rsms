'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS PAYMENT GATEWAY CLOUD FUNCTIONS — PER-SCHOOL MODEL

   Each school is the direct merchant of record: its own gateway account,
   its own public key (browser checkout) and its own secret key (stored in
   Google Cloud Secret Manager as rsms-flw-<school> / rsms-ps-<school>).
   The platform never holds customer funds and never holds any school key.

   - verifyPayment (callable): browser sends {ref, provider, schoolId}; the
     function verifies against the provider API with THAT SCHOOL's secret
     key and transitions only that school's matching Pending rows. It cannot
     create payments or wallet credits.
   - paymentWebhook (HTTP): each school's gateway dashboard posts to
     <url>?school=<schoolId>. The signature is checked against the raw body
     (SHA-512 for Flutterwave, HMAC-SHA512 with the school's secret for
     Paystack), then the same server-side verification runs.
   - storeGatewaySecret (callable): the school's bursar stores/revokes the
     school's own gateway secret key. Gated by Firebase Auth claims
     (bursar/admin/superadmin, cross-checked against users/{uid}) or, until
     auth enforcement is enabled, the school's legacy bursar PIN. The key
     goes to Secret Manager only; RTDB receives metadata and an audit row.
═══════════════════════════════════════════════════════════════════ */

var admin = require('firebase-admin');
var crypto = require('crypto');
var https = require('firebase-functions/v2/https');
var gateway = require('./gateway');
var secretstore = require('./secretstore');
var offlineSync = require('./offlineSync');

if(!admin.apps.length) admin.initializeApp();

function database(){ return admin.database(); }

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

/* The school's own gateway secret key, from Secret Manager. */
function providerSecret(schoolId, provider){
  return secretstore.getSecret(provider, schoolId).then(function(value){
    var secret = cleanText(value, 1000);
    if(!secret){
      throw responseError('The payment gateway key for this school is not configured.', 503);
    }
    return secret;
  });
}

function mapFromResponse(provider, response){
  return provider === 'flutterwave' ? gateway.mapFlutterwaveResponse(response) : gateway.mapPaystackResponse(response);
}

function providerVerification(schoolId, provider, reference){
  var ref = cleanText(reference, 300);

  if(!ref) return Promise.reject(responseError('A payment reference is required.', 400));
  if(provider !== 'flutterwave' && provider !== 'paystack'){
    return Promise.reject(responseError('Unsupported payment provider.', 400));
  }

  return providerSecret(schoolId, provider).then(function(secret){
    var url;
    var headers = {accept:'application/json'};
    if(provider === 'flutterwave'){
      url = 'https://api.flutterwave.com/v3/transactions/'+encodeURIComponent(ref)+'/verify';
    }else{
      url = 'https://api.paystack.co/transaction/verify/'+encodeURIComponent(ref);
    }
    headers.Authorization = 'Bearer '+secret;

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

/* Server-side verification, scoped to exactly one school. The school must
   exist and own a gateway secret; there is deliberately no cross-school
   scanning (payment refs are unique per school, not globally). */
function runVerification(input){
  input = input || {};
  var reference = cleanText(input.ref, 300);
  var provider = normaliseProvider(input.provider);
  var schoolId = cleanText(input.schoolId, 160);

  if(!reference) return Promise.reject(responseError('A payment reference is required.', 400));
  if(!schoolId) return Promise.reject(responseError('A school is required for verification.', 400));
  if(provider !== 'flutterwave' && provider !== 'paystack'){
    return Promise.reject(responseError('Choose Flutterwave or Paystack.', 400));
  }

  return database().ref('schools/'+schoolId).once('value').then(function(snapshot){
    if(!snapshot.val()) throw responseError('Unknown school.', 404);
    return providerVerification(schoolId, provider, reference).then(function(verdict){
      return applyForSchool(schoolId, reference, provider, verdict).then(function(transition){
        return resultSummary(verdict, [transition]);
      });
    });
  });
}

function callableData(request){
  return request && request.data && typeof request.data === 'object' ? request.data : {};
}

exports.verifyPayment = https.onCall({
  maxInstances:10
}, function(request){
  var data = callableData(request);
  // Intentionally no auth gate: the function only verifies an already
  // Pending record against the gateway and cannot introduce money records.
  // School scoping comes from the payload's schoolId.
  return runVerification(data).catch(function(error){
    if(error && error.status === 400) throw new https.HttpsError('invalid-argument', error.message);
    if(error && error.status === 404) throw new https.HttpsError('not-found', error.message);
    if(error && error.status === 503) throw new https.HttpsError('unavailable', error.message);
    throw new https.HttpsError('internal', 'Payment verification could not be completed.');
  });
});

exports.paymentWebhook = https.onRequest({
  cors:[]
}, function(request, response){
  if(request.method !== 'POST'){
    response.status(405).json({error:'method-not-allowed'});
    return;
  }

  var school = gateway.parseSchoolQuery(request.query ? request.query.school : '');
  if(!school){
    response.status(400).json({error:'missing-school'});
    return;
  }

  var provider;
  var signature;
  var reference;

  if(request.get('x-paystack-signature')){
    provider = 'paystack';
    signature = request.get('x-paystack-signature');
    reference = (request.body || {}).data && ((request.body || {}).data.reference || (request.body || {}).data.tx_ref);
  }else if(request.get('x-flw-signature')){
    provider = 'flutterwave';
    signature = request.get('x-flw-signature');
    reference = (request.body || {}).transaction && (request.body || {}).transaction.reference || (request.body || {}).tx_ref;
  }else{
    response.status(401).json({error:'missing-gateway-signature'});
    return;
  }

  if(!cleanText(reference, 300)){
    response.status(400).json({error:'missing-payment-reference'});
    return;
  }

  // The school's own secret must exist before signature or verification
  // work. A missing key is a configuration error (no retry), not a
  // transient failure.
  return secretstore.getSecret(provider, school).then(function(value){
    var secret = cleanText(value, 1000);
    if(!secret){
      response.status(400).json({error:'school-key-not-configured'});
      return;
    }
    var valid = provider === 'paystack' ?
      gateway.checkPaystackSignature(request.rawBody || '', signature, secret) :
      gateway.checkFlutterwaveSignature(request.rawBody || '', signature);
    if(!valid){
      response.status(401).json({error:'invalid-gateway-signature'});
      return;
    }
    return runVerification({ref:reference, provider:provider, schoolId:school}).then(function(result){
      response.status(200).json({status:'ok', data:result});
    });
  }).catch(function(){
    // A non-2xx response lets the gateway retry transient provider/database
    // failures. Validation errors were already excluded above.
    response.status(500).json({status:'retry', error:'verification-failed'});
  });
});

/* ── Gateway secret management (per school) ─────────────────────── */

/* Dual-mode school gate, mirroring the platform's current auth model:
   1. Firebase Auth claims (bursar/admin of the school, or superadmin),
      cross-checked against the users/{uid} registry — the same standard
      the strict database rules use.
   2. Legacy bursar PIN (schools/<id>/portal_pins.bursar), kept until
      auth enforcement is enabled. Uses the same data the login page
      already checks client-side — no trust regression.
   Returns the mode ('claims' | 'pin') for the audit row. */
function gateSchoolAccess(request, data, schoolId){
  var auth = request && request.auth;
  if(auth && auth.uid){
    var token = auth.token || {};
    var roleMap = token.roleMap || {};
    var schoolMap = token.schoolIds || {};
    var isSuperadmin = roleMap.superadmin === true;
    var isSchoolRole = (roleMap.bursar === true || roleMap.admin === true) &&
      schoolMap[schoolId] === true;
    if(!isSuperadmin && !isSchoolRole){
      throw new https.HttpsError('permission-denied', 'permission-denied');
    }
    return database().ref('users/'+auth.uid).once('value').then(function(snapshot){
      var reg = snapshot.val() || {};
      var regRoles = reg.roleMap || {};
      var regSchools = reg.schoolIds || {};
      var superadminOk = isSuperadmin && regRoles.superadmin === true;
      var schoolOk = isSchoolRole &&
        (regRoles.bursar === true || regRoles.admin === true) &&
        regSchools[schoolId] === true;
      if(!superadminOk && !schoolOk){
        throw new https.HttpsError('permission-denied', 'permission-denied');
      }
      return 'claims';
    });
  }

  var pin = cleanText(data && data.pin, 64);
  if(!pin){
    throw new https.HttpsError('permission-denied', 'permission-denied');
  }
  return database().ref('schools/'+schoolId+'/portal_pins').once('value').then(function(snapshot){
    var pins = snapshot.val() || {};
    var expected = String(pins.bursar || '');
    if(!expected || !timingSafeTextEqual(expected, pin)){
      throw new https.HttpsError('permission-denied', 'permission-denied');
    }
    return 'pin';
  });
}

exports.storeGatewaySecret = https.onCall({maxInstances:5}, function(request){
  var data = callableData(request);
  var schoolId = cleanText(data.schoolId, 160);
  var provider = normaliseProvider(data.provider);
  var action = cleanText(data.action, 16).toLowerCase();
  var key = data.secretKey === undefined || data.secretKey === null ? '' : String(data.secretKey);

  if(!schoolId || (provider !== 'flutterwave' && provider !== 'paystack')){
    throw new https.HttpsError('invalid-argument', 'schoolId and a provider (flutterwave or paystack) are required.');
  }
  if(action !== 'set' && action !== 'revoke'){
    throw new https.HttpsError('invalid-argument', 'action must be "set" or "revoke".');
  }
  if(action === 'set' && !gateway.isValidGatewayKey(provider, key)){
    throw new https.HttpsError('invalid-argument', 'The gateway secret key format is not recognised.');
  }

  return gateSchoolAccess(request, data, schoolId).then(function(mode){
    var storeOp = action === 'set' ?
      secretstore.setSecret(provider, schoolId, key) :
      secretstore.revokeSecret(provider, schoolId);
    var stamp = new Date().toISOString();
    return storeOp.then(function(){
      var update = { secretUpdatedAt: stamp };
      update[gateway.providerFlagKey(provider)] = action === 'set';
      return database().ref('schools/'+schoolId+'/flw_config').update(update);
    }).then(function(){
      return database().ref('schools/'+schoolId+'/audit_log').push({
        id:'gateway-secret-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),
        action:action === 'set' ? 'Gateway secret configured' : 'Gateway secret revoked',
        type:'gateway_settings',
        details:'Gateway secret for '+provider+(action === 'set' ? ' configured' : ' revoked')+' · key stored in secret manager',
        timestamp:stamp,
        date:stamp.slice(0,10),
        user:'Bursar ('+mode+')',
        provider:provider
      });
    }).then(function(){
      return {ok:true, provider:provider, action:action};
    });
  }).catch(function(error){
    if(error instanceof https.HttpsError) throw error;
    throw new https.HttpsError('internal', 'The gateway secret could not be saved.');
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

// ── Offline school server sync (Phase B) ───────────────────────
// The offline server authenticates with a per-school server token.
// Only the SHA-256 hash is stored (offline_servers/<schoolId>); the raw
// token exists once, at registration, and in the school's appliance.

function verifyServerAuth(data){
  var schoolId = cleanText(data && data.schoolId, 160);
  var token = data && data.serverToken === undefined ? '' : String(data.serverToken);
  if(!schoolId || !token){
    return Promise.reject(new https.HttpsError('invalid-argument', 'schoolId and serverToken are required.'));
  }
  return database().ref('offline_servers/'+schoolId).once('value').then(function(snap){
    var record = snap.val();
    if(!record || record.status !== 'active' || record.tokenHash !== offlineSync.hashToken(token)){
      throw new https.HttpsError('permission-denied', 'Unknown or revoked offline server installation.');
    }
    return record;
  });
}

exports.registerOfflineServer = https.onCall({maxInstances:5}, function(request){
  var data = callableData(request);
  var password = cleanText(data.password, 1000);
  var reg = offlineSync.isValidRegistration(data);
  if(!reg.ok) throw new https.HttpsError('invalid-argument', reg.error);

  return database().ref('config/superadmin_hash').once('value').then(function(snapshot){
    var expectedHash = cleanText(snapshot.val(), 256).toLowerCase();
    if(!password || !expectedHash || !timingSafeTextEqual(sha256(password), expectedHash)){
      throw new https.HttpsError('permission-denied', 'permission-denied');
    }
    var regRef = database().ref('offline_servers/'+reg.schoolId);
    return regRef.once('value').then(function(snap){
      var existing = snap.val();
      if(existing && existing.status === 'active' && reg.action === 'register'){
        throw new https.HttpsError('already-exists',
          'An active installation is already registered for this school. Use action "replace" to swap it.');
      }
      var now = new Date().toISOString();
      if(reg.action === 'revoke'){
        return regRef.set(null).then(function(){
          return {ok:true, action:'revoke', schoolId:reg.schoolId};
        });
      }
      var token = offlineSync.generateServerToken();
      var record = {
        schoolId:reg.schoolId,
        schoolCode:reg.schoolCode,
        schoolName:reg.schoolName || '',
        status:'active',
        installationId:offlineSync.cleanText(data.installationId, 64) ||
          ((existing && reg.action === 'replace' && existing.installationId) ||
           'inst-'+Date.now().toString(36)),
        tokenHash:offlineSync.hashToken(token),
        registeredAt:(existing && existing.registeredAt) || now,
        updatedAt:now
      };
      return regRef.set(record).then(function(){
        return {
          ok:true, action:reg.action, schoolId:reg.schoolId,
          installationId:record.installationId,
          serverToken:token,
          note:'Store the token only in the school appliance; it is shown once.'
        };
      });
    });
  }).catch(function(error){
    if(error instanceof https.HttpsError) throw error;
    throw new https.HttpsError('internal', 'Offline server registration could not be completed.');
  });
});

exports.offlineVerifyServer = https.onCall({maxInstances:5}, function(request){
  var data = callableData(request);
  return verifyServerAuth(data).then(function(record){
    return {
      ok:true,
      schoolId:record.schoolId,
      schoolCode:record.schoolCode || '',
      schoolName:record.schoolName || '',
      installationId:record.installationId || ''
    };
  });
});

var MAX_PUSH_BATCH = 50;
var PROCESSED_CAP = 2000;

exports.offlineSyncPush = https.onCall({maxInstances:5, timeoutSeconds:60}, function(request){
  var data = callableData(request);
  var entries = Array.isArray(data.entries) ? data.entries.slice(0, MAX_PUSH_BATCH) : [];
  if(!entries.length){
    throw new https.HttpsError('invalid-argument', 'entries is required.');
  }

  var groups = {};
  var order = [];
  entries.forEach(function(entry){
    var collection = cleanText(entry && entry.collection, 64);
    if(!collection) return;
    if(!groups[collection]){ groups[collection] = []; order.push(collection); }
    groups[collection].push(entry);
  });
  if(!order.length) throw new https.HttpsError('invalid-argument', 'no valid entries.');

  return verifyServerAuth(data).then(function(record){
    var serverRef = 'offline_servers/'+record.schoolId;

    function processGroup(collection){
      return database().ref(serverRef+'/processed').once('value').then(function(pSnap){
        var processedList = Object.keys(pSnap.val() || {});
        return database().ref('schools/'+record.schoolId+'/'+collection).once('value').then(function(cSnap){
          var result = offlineSync.applyPushBatch(collection, cSnap.val(), groups[collection], processedList);
          var writes = {};
          var prune = [];
          if(result.changed){
            writes['schools/'+record.schoolId+'/'+collection] = result.next;
          }
          Object.keys(result.markers).forEach(function(intentId){
            writes[serverRef+'/processed/'+intentId] = result.markers[intentId];
          });
          /* Cap the idempotency ledger: drop the oldest entries beyond the cap. */
          if(processedList.length + Object.keys(result.markers).length > PROCESSED_CAP){
            var dated = processedList.map(function(id){
              return {id:id, at:(pSnap.val() || {})[id] && (pSnap.val() || {})[id].at || ''};
            }).sort(function(a, b){ return a.at < b.at ? -1 : (a.at > b.at ? 1 : 0); });
            var excess = dated.length + Object.keys(result.markers).length - PROCESSED_CAP;
            prune = dated.slice(0, Math.max(0, excess)).map(function(row){ return row.id; });
          }
          prune.forEach(function(id){
            if(!result.markers[id]) writes[serverRef+'/processed/'+id] = null;
          });
          writes[serverRef+'/lastSyncAt'] = new Date().toISOString();
          return database().ref().update(writes).then(function(){
            return {
              collection:collection,
              applied:result.applied,
              skipped:result.skipped,
              rejected:result.rejected
            };
          });
        });
      });
    }

    function processNext(index, out){
      if(index >= order.length) return Promise.resolve(out);
      return processGroup(order[index]).then(function(result){
        out[order[index]] = result;
        return processNext(index + 1, out);
      });
    }

    return processNext(0, {}).then(function(perCollection){
      var applied = [], skipped = [], rejected = [];
      order.forEach(function(collection){
        (perCollection[collection].applied || []).forEach(function(r){ applied.push(r); });
        (perCollection[collection].skipped || []).forEach(function(r){ skipped.push(r); });
        (perCollection[collection].rejected || []).forEach(function(r){ rejected.push(r); });
      });
      return {ok:true, schoolId:record.schoolId, applied:applied, skipped:skipped, rejected:rejected};
    });
  }).catch(function(error){
    if(error instanceof https.HttpsError) throw error;
    throw new https.HttpsError('internal', 'Offline sync push could not be completed.');
  });
});

var MAX_PULL_COLLECTIONS = 40;

exports.offlineSyncPull = https.onCall({maxInstances:5, timeoutSeconds:60}, function(request){
  var data = callableData(request);
  var collections = stringList(data.collections, MAX_PULL_COLLECTIONS, 64);
  return verifyServerAuth(data).then(function(record){
    function readNext(index, out){
      if(index >= collections.length) return Promise.resolve(out);
      var key = collections[index];
      return database().ref('schools/'+record.schoolId+'/'+key).once('value').then(function(snap){
        var val = snap.val();
        out[key] = (val === null || val === undefined) ? [] : offlineSync.toArray(val);
        return readNext(index + 1, out);
      });
    }
    return readNext(0, {}).then(function(collectionsOut){
      database().ref('offline_servers/'+record.schoolId+'/lastPullAt')
        .set(new Date().toISOString());
      return {ok:true, schoolId:record.schoolId, collections: collectionsOut};
    });
  }).catch(function(error){
    if(error instanceof https.HttpsError) throw error;
    throw new https.HttpsError('internal', 'Offline sync pull could not be completed.');
  });
});

// Exported only for focused emulator/integration tests; deployment exports
// are the functions above.
exports._private = {
  runVerification:runVerification,
  providerVerification:providerVerification,
  gateSchoolAccess:gateSchoolAccess,
  timingSafeTextEqual:timingSafeTextEqual,
  sha256:sha256,
  secretstore:secretstore,
  offlineSync:offlineSync
};
