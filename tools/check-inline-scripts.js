#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=['rsms-admin.html','rsms-teacher.html','rsms-classteacher.html','rsms-principal.html','rsms-results-print.html','rsms-student.html','rsms-parent.html','rsms-analytics.html'];
const js=['rsms-core.js','rsms-assessment.js','rsms-score-import.js','rsms-roster.js','rsms-firebase.js','sw.js','tools/roster-backup-check.js'];
let failures=0;
for(const file of html){
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  const blocks=[...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim());
  blocks.forEach((code,i)=>{try{new vm.Script(code,{filename:file+'#script'+i});}catch(e){failures++;console.error(file+' script '+i+': '+e.message);}});
}
for(const file of js){try{new vm.Script(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{filename:file});}catch(e){failures++;console.error(file+': '+e.message);}}
console.log(failures?failures+' syntax failure(s)':'Inline/module syntax checks passed ('+html.length+' pages, '+js.length+' scripts)');
process.exit(failures?1:0);
