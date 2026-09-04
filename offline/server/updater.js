'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SERVER — signed release updater (Phase C)

   A release is a directory of files plus release-manifest.json:
     {
       "version": "0.4.0",
       "releasedAt": "2026-09-01T00:00:00Z",
       "files": { "server/backup.js": "<sha256>", ... },
       "signature": "<base64 ed25519 signature>"
     }

   The signature is over the canonical (key-sorted) JSON of
   {version, releasedAt, files}. The ed25519 public key of the release
   signing identity is embedded below; the private key lives only with
   the operator (see docs/pilot-playbook.md "Signing releases").

   Apply: verify signature + every file hash, make a verified backup
   first, copy the release over the package, record pending_restart.
   Never force-updates during an active restore, while a maintenance
   flag is set, or with unresolved migrations (schema version check).
═══════════════════════════════════════════════════════════════════ */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var dbModule = require('./db');
var sync = require('./sync');
var backup = require('./backup');

/* Release signing public key (ed25519, SPKI base64). Replace with the
   operator's key at first release; tests use their own keypair. */
var RELEASE_PUBLIC_KEY =
  'MCowBQYDK2VwAyEArsms-offline-release-signing-key-placeholder-0000';

function canonical(obj){
  if(obj === null || obj === undefined) return 'null';
  if(Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  if(typeof obj === 'object'){
    return '{' + Object.keys(obj).sort().map(function(k){
      return JSON.stringify(k) + ':' + canonical(obj[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(obj);
}

function manifestPayload(manifest){
  return {version: manifest.version, releasedAt: manifest.releasedAt,
    files: manifest.files};
}

function verifyManifest(manifest, publicKey){
  var key = publicKey || RELEASE_PUBLIC_KEY;
  if(!manifest || !manifest.version || !manifest.files || !manifest.signature){
    return {ok: false, error: 'manifest missing version/files/signature'};
  }
  var keyObj;
  try{
    keyObj = crypto.createPublicKey({key: Buffer.from(key, 'base64'),
      type: 'spki', format: 'der'});
  } catch(e){
    return {ok: false, error: 'release public key is not a valid ed25519 SPKI key'};
  }
  var good = crypto.verify(null,
    Buffer.from(canonical(manifestPayload(manifest)), 'utf8'),
    keyObj, Buffer.from(manifest.signature, 'base64'));
  if(!good) return {ok: false, error: 'signature verification failed'};
  return {ok: true};
}

function sha256File(file){
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readRelease(releaseDir){
  var manifestFile = path.join(releaseDir, 'release-manifest.json');
  if(!fs.existsSync(manifestFile))
    throw new Error('release-manifest.json not found in ' + releaseDir);
  var manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  var missing = [];
  Object.keys(manifest.files || {}).forEach(function(rel){
    var f = path.join(releaseDir, rel);
    if(!fs.existsSync(f)) missing.push(rel);
    else if(sha256File(f) !== manifest.files[rel])
      missing.push(rel + ' (hash mismatch)');
  });
  if(missing.length)
    throw new Error('release files missing or tampered: ' + missing.join(', '));
  return manifest;
}

/* Apply a signed release to this package directory.
   opts: {db, publicKey} — db required (backup + maintenance guard). */
function applyRelease(releaseDir, opts){
  opts = opts || {};
  if(opts.db){
    if(backup.inMaintenance(opts.db))
      throw new Error('restore in progress — updates are paused');
    if(dbModule.inMigration(opts.db))
      throw new Error('unresolved migrations — update paused');
  }
  var manifest = readRelease(releaseDir);
  var sig = verifyManifest(manifest, opts.publicKey);
  if(!sig.ok) throw new Error(sig.error);

  var target = path.resolve(opts.targetDir || path.join(__dirname, '..'));
  var staged = path.join(target, '.release-staging');

  /* Never force-update: a verified backup exists before any change. */
  if(opts.db){
    backup.createBackup(opts.db, {suffix: 'pre-update-' + String(manifest.version).replace(/[^0-9a-zA-Z.]/g, '')});
  }

  fs.rmSync(staged, {recursive: true, force: true});
  fs.mkdirSync(staged, {recursive: true});
  Object.keys(manifest.files).forEach(function(rel){
    var src = path.join(releaseDir, rel);
    var dst = path.join(staged, rel);
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.copyFileSync(src, dst);
  });

  /* Atomic-ish swap: staged dir already verified; move into place. */
  Object.keys(manifest.files).forEach(function(rel){
    var src = path.join(staged, rel);
    var dst = path.join(target, rel);
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    if(fs.existsSync(dst) && fs.statSync(dst).isDirectory()){
      fs.rmSync(dst, {recursive: true, force: true});
    }
    fs.copyFileSync(src, dst);
  });
  fs.rmSync(staged, {recursive: true, force: true});

  var appliedAt = dbModule.nowIso();
  if(opts.db){
    dbModule.metaSet(opts.db, 'applied_version', String(manifest.version));
    dbModule.metaSet(opts.db, 'pending_restart', JSON.stringify({
      version: manifest.version, appliedAt: appliedAt,
      reason: 'signed release applied'
    }));
    dbModule.metaSet(opts.db, 'pending_restart_at', appliedAt);
  }
  return {ok: true, version: manifest.version, appliedAt: appliedAt,
    pendingRestart: Boolean(opts.db),
    note: 'Restart the service to finish the update.'};
}

function pendingRestart(db){
  var value = dbModule.metaGet(db, 'pending_restart');
  if(!value) return null;
  try { return JSON.parse(value); } catch(e){ return null; }
}

function clearPendingRestart(db){
  dbModule.metaSet(db, 'pending_restart', '');
  dbModule.metaSet(db, 'pending_restart_at', '');
}

module.exports = {
  canonical:canonical,
  verifyManifest:verifyManifest,
  readRelease:readRelease,
  applyRelease:applyRelease,
  pendingRestart:pendingRestart,
  clearPendingRestart:clearPendingRestart,
  RELEASE_PUBLIC_KEY:RELEASE_PUBLIC_KEY
};
