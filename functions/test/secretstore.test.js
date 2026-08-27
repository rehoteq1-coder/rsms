'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var secretstore = require('../src/secretstore');

process.env.GOOGLE_CLOUD_PROJECT = 'rsms-test';

function notFoundError(){
  return Object.assign(new Error('secret not found'), {code:5});
}

/* In-memory stand-in for the Secret Manager client. */
function fakeClient(){
  var store = new Map(); // full name -> {disabled, versions:[base64, ...]}
  return {
    store:store,
    secretExists:function(req){
      return Promise.resolve({exists:store.has(req.name)});
    },
    createSecret:function(req){
      var name = req.parent + '/secrets/' + req.secretId;
      store.set(name, {disabled:false, versions:[]});
      return Promise.resolve([{name:name}]);
    },
    addVersion:function(req){
      var secret = store.get(req.parent);
      if(!secret) return Promise.reject(notFoundError());
      secret.versions.push(req.payload.data);
      return Promise.resolve({name:req.parent + '/versions/' + secret.versions.length});
    },
    accessLatestVersion:function(req){
      var name = req.name.split('/versions/')[0];
      var secret = store.get(name);
      if(!secret || secret.disabled || !secret.versions.length){
        return Promise.reject(notFoundError());
      }
      var latest = secret.versions[secret.versions.length - 1];
      return Promise.resolve([{payload:{data:Buffer.from(latest, 'base64')}}]);
    },
    getSecret:function(req){
      var secret = store.get(req.name);
      if(!secret) return Promise.reject(notFoundError());
      var view = {name:req.name, disabled:secret.disabled};
      view.disable = function(){
        secret.disabled = true;
        return Promise.resolve([view]);
      };
      return Promise.resolve([view]);
    }
  };
}

test('set then get returns the same key; rotation replaces the value', function(){
  var client = fakeClient();
  secretstore.setClientForTesting(client);
  return secretstore.setSecret('flutterwave', 'green-valley-sec', 'FLWSEC-aaa')
    .then(function(){
      return secretstore.setSecret('flutterwave', 'green-valley-sec', 'FLWSEC-bbb');
    })
    .then(function(){
      return secretstore.getSecret('flutterwave', 'green-valley-sec');
    })
    .then(function(value){
      assert.equal(value, 'FLWSEC-bbb');
      secretstore.setClientForTesting(null);
    });
});

test('missing or revoked secret reads as empty (not configured)', function(){
  var client = fakeClient();
  secretstore.setClientForTesting(client);
  return secretstore.getSecret('paystack', 'no-school')
    .then(function(value){
      assert.equal(value, '');
      return secretstore.setSecret('paystack', 'no-school', 'sk_test_x1');
    })
    .then(function(){
      return secretstore.revokeSecret('paystack', 'no-school');
    })
    .then(function(revoked){
      assert.equal(revoked, true);
      return secretstore.getSecret('paystack', 'no-school');
    })
    .then(function(value){
      assert.equal(value, '');
      secretstore.setClientForTesting(null);
    });
});

test('secrets are namespaced per provider and school', function(){
  var client = fakeClient();
  secretstore.setClientForTesting(client);
  return secretstore.setSecret('flutterwave', 'green-valley-sec', 'FLWSEC-flw')
    .then(function(){
      return secretstore.setSecret('paystack', 'green-valley-sec', 'sk_test-ps');
    })
    .then(function(){
      assert.equal(client.store.size, 2);
      return Promise.all([
        secretstore.getSecret('flutterwave', 'green-valley-sec'),
        secretstore.getSecret('paystack', 'green-valley-sec')
      ]);
    })
    .then(function(pair){
      assert.deepEqual(pair, ['FLWSEC-flw', 'sk_test-ps']);
      secretstore.setClientForTesting(null);
    });
});

test('hasSecret reflects configuration state', function(){
  var client = fakeClient();
  secretstore.setClientForTesting(client);
  return secretstore.hasSecret('flutterwave', 'green-valley-sec')
    .then(function(before){
      assert.equal(before, false);
      return secretstore.setSecret('flutterwave', 'green-valley-sec', 'FLWSEC-1');
    })
    .then(function(){
      return secretstore.hasSecret('flutterwave', 'green-valley-sec');
    })
    .then(function(after){
      assert.equal(after, true);
      secretstore.setClientForTesting(null);
    });
});
