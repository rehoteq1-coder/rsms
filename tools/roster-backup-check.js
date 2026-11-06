#!/usr/bin/env node
'use strict';
/* Read-only analysis of an RSMS admin "Download read-only roster backup" file.
   Usage: node tools/roster-backup-check.js backup.json [--json]
   Never contacts Firebase and never writes to the backup or any database. */
const fs=require('node:fs');
const path=require('node:path');
require('../rsms-roster.js');
const R=globalThis.RSMSRoster;
function fail(message){console.error(message);process.exit(2);}
const args=process.argv.slice(2),json=args.includes('--json'),file=args.find(a=>a!=='--json');
if(!file)fail('Usage: node tools/roster-backup-check.js <backup.json> [--json]');
let backup;
try{backup=JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));}
catch(e){fail('Could not read backup JSON: '+e.message);}
if(!backup||typeof backup!=='object')fail('Backup must be a JSON object.');
if(backup.format!=='rsms-roster-backup-v1')fail('Unsupported backup format. Use the admin portal read-only roster backup.');
const diagnosis=R.diagnose(backup.local,backup.database,'students');
const report={
  tool:'rsms-roster-backup-check',readOnly:true,file:path.resolve(file),
  schoolId:backup.schoolId||'',capturedAt:backup.capturedAt||'',databasePath:backup.databasePath||'',
  storedDashboardCount:backup.dashboardCount,diagnosis,
  matches:diagnosis.local.valid===diagnosis.database.valid&&diagnosis.missingFromLocal.length===0&&diagnosis.extraInLocal.length===0,
  note:'A cache/database count mismatch indicates stale or incomplete local cache, invalid records, duplicate IDs, or a school-context problem. It is not proof that records were deleted. No restore or reconciliation was performed.'
};
if(json)console.log(JSON.stringify(report,null,2));
else{
  const d=diagnosis;
  console.log('RSMS read-only roster backup check');
  console.log('School: '+(report.schoolId||'(unknown)'));
  console.log('Captured: '+(report.capturedAt||'(unknown)'));
  console.log('Database path: '+(report.databasePath||'(unknown)'));
  console.log('Admin dashboard/cache: '+d.local.valid+' valid / '+d.local.rawEntries+' raw entries; '+d.local.invalid+' invalid; '+d.local.duplicateIds.length+' duplicate IDs');
  console.log('Database: '+d.database.valid+' valid / '+d.database.rawEntries+' raw entries; '+d.database.invalid+' invalid; '+d.database.duplicateIds.length+' duplicate IDs');
  console.log('Database IDs missing from cache: '+d.missingFromLocal.length);
  console.log('Cache-only IDs: '+d.extraInLocal.length);
  console.log('Counts match: '+(report.matches?'yes':'no'));
  console.log(report.note);
}
process.exit(report.matches?0:1);
