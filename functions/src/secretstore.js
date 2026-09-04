'use strict';

/* ═══════════════════════════════════════════════════════════════
   PER-SCHOOL GATEWAY SECRET STORE (Google Cloud Secret Manager)

   Each school's gateway secret key lives in Secret Manager as
   `rsms-flw-<school>` / `rsms-ps-<school>`, accessed through the Cloud
   Function's own Application Default Credentials. The raw key never touches
   the database, request payloads, responses, or logs. The platform operator
   does not hold any school key — only the function's ADC does.
═══════════════════════════════════════════════════════════════════ */

var gateway = require('./gateway');

var clientOverride = null; // injected by tests only

function makeClient(){
  var SecretManagerService = require('@google-cloud/secret-manager').SecretManagerService;
  return new SecretManagerService();
}

function getClient(){
  if(clientOverride) return clientOverride;
  return makeClient();
}

function setClientForTesting(client){ clientOverride = client; }

function projectId(){
  var id = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
  if(!id) throw new Error('Cloud project id is not available.');
  return id;
}

function fullSecretName(provider, schoolId){
  return 'projects/' + projectId() + '/secrets/' + gateway.schoolSecretName(provider, schoolId);
}

function isMissing(error){
  var code = error && (error.code || error.status);
  if(String(code) === '5') return true;
  return /not.?found|does not exist|secret not found/i.test(String((error && error.message) || ''));
}

/* Create the secret if needed, then add a new version with the key. */
function setSecret(provider, schoolId, key){
  var client;
  var full;
  try {
    client = getClient();
    full = fullSecretName(provider, schoolId);
  } catch(e){
    return Promise.reject(e);
  }
  var parent = 'projects/' + projectId();
  var secretId = gateway.schoolSecretName(provider, schoolId);
  return client.secretExists({ name: full }).then(function(result){
    if(result && result.exists) return full;
    return client.createSecret({
      parent: parent,
      secretId: secretId,
      secret: { replication: { automatic: {} } }
    }).then(function(created){
      var secret = created && created[0];
      return (secret && secret.name) || full;
    });
  }).then(function(secretName){
    return client.addVersion({
      parent: secretName,
      payload: { data: Buffer.from(String(key), 'utf8').toString('base64') }
    }).then(function(){
      return secretName;
    });
  });
}

/* Latest key value, or '' when the secret does not exist / is disabled. */
function getSecret(provider, schoolId){
  var client;
  var full;
  try {
    client = getClient();
    full = fullSecretName(provider, schoolId);
  } catch(e){
    return Promise.reject(e);
  }
  return client.accessLatestVersion({ name: full + '/versions/latest' }).then(function(result){
    var version = result && result[0];
    var payload = version && version.payload;
    return payload && payload.data ? payload.data.toString('utf8') : '';
  }).catch(function(error){
    if(isMissing(error)) return '';
    throw error;
  });
}

function hasSecret(provider, schoolId){
  return getSecret(provider, schoolId).then(function(value){
    return !!value;
  });
}

/* Disable the secret (keeps the audit trail; re-enabling is possible). */
function revokeSecret(provider, schoolId){
  var client;
  var full;
  try {
    client = getClient();
    full = fullSecretName(provider, schoolId);
  } catch(e){
    return Promise.reject(e);
  }
  return client.getSecret({ name: full }).then(function(result){
    var secret = result && result[0];
    if(!secret || secret.disabled) return false;
    if(typeof secret.disable !== 'function'){
      return client.updateSecret({
        secret: { name: full, disabled: true },
        updateMask: { paths: ['disabled'] }
      }).then(function(){ return true; });
    }
    return secret.disable().then(function(){ return true; });
  }).catch(function(error){
    if(isMissing(error)) return false;
    throw error;
  });
}

module.exports = {
  setSecret:setSecret,
  getSecret:getSecret,
  hasSecret:hasSecret,
  revokeSecret:revokeSecret,
  setClientForTesting:setClientForTesting
};
