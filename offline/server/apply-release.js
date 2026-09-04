'use strict';

/* Headless signed-release applier (Phase C).
   Use on the school PC (or from the wizard's admin API):

     node --experimental-sqlite server/apply-release.js <release-dir>

   The release dir contains the updated files plus a signed
   release-manifest.json. A verified backup is created first; the
   service is left with a pending-restart flag for the NSSM manager
   (or `POST /api/admin/restart` from the health page). */

var path = require('path');
var dbModule = require('./db');
var updater = require('./updater');
var REPO_ROOT = path.join(__dirname, '..', '..');

var releaseDir = process.argv[2];
if(!releaseDir){
  console.error('usage: node server/apply-release.js <release-dir>');
  process.exit(2);
}
var db = dbModule.openDatabase(
  process.env.RSMS_DB_FILE ||
  path.join(REPO_ROOT, 'offline', 'data', 'rsms-school.sqlite'));

try{
  var result = updater.applyRelease(path.resolve(releaseDir), {db: db});
  console.log('OK — release ' + result.version + ' applied.');
  console.log(result.note);
  console.log('Restart with: nssm restart RSMSOffline  (or POST /api/admin/restart)');
} catch(e){
  console.error('FAILED: ' + e.message);
  process.exit(1);
}
