'use strict';

/* Installer packaging consistency (Phase C).
  
   The offline server serves the web portal from the install root
   (REPO_ROOT in offline/server/index.js via serve-portals.js), so EVERY
   root-level portal asset must be listed in installer/rsms-offline.iss.
   When the first Windows install 404'd on "/" (the portal pages were
   never packaged), this is the check that was missing.
  
   The test parses the Source patterns from the .iss and asserts that
   each portal file present in the repository is covered by one of them.
*/

var assert = require('node:assert/strict');
var test = require('node:test');
var fs = require('node:fs');
var path = require('node:path');

var REPO_ROOT = path.join(__dirname, '..', '..');
var ISS = path.join(REPO_ROOT, 'installer', 'rsms-offline.iss');

/* Source patterns from the .iss, normalized to forward slashes.
   Patterns beginning with ..\ become repo-root-relative; the vendor\
   patterns stay installer-directory-relative (as in the script). */
function sourcePatterns(){
  var iss = fs.readFileSync(ISS, 'utf8');
  var out = [];
  var re = /Source:\s*"([^"]+)"/g;
  var m;
  while((m = re.exec(iss))){
    var p = m[1].replace(/\\/g, '/');
    if(p.indexOf('../') === 0) p = p.slice(3);
    out.push(p);
  }
  return out;
}

/* Tiny matcher: literal equality or a single * wildcard (Inno Setup
   filename wildcards do not cross directory separators). */
function fnmatch(pattern, name){
  if(pattern === name) return true;
  var star = pattern.indexOf('*');
  if(star === -1) return false;
  var prefix = pattern.slice(0, star);
  var suffix = pattern.slice(star + 1);
  return name.indexOf(prefix) === 0 &&
    name.length >= prefix.length + suffix.length &&
    name.slice(name.length - suffix.length) === suffix;
}

/* Is repo-root file `name` covered by any root-level pattern? */
function rootCovered(patterns, name){
  return patterns.some(function(pat){
    if(pat.indexOf('/') !== -1) return false; /* root-level patterns only */
    return fnmatch(pat, name);
  });
}

var PATTERNS = sourcePatterns();
var ROOT_FILES = fs.readdirSync(REPO_ROOT, {withFileTypes: true})
  .filter(function(d){ return d.isFile(); })
  .map(function(d){ return d.name; });

test('installer: every root-level portal HTML page is packaged', function(){
  var html = ROOT_FILES.filter(function(f){ return /\.html$/.test(f); });
  assert.ok(html.length > 30, 'repo should contain the portal pages');
  html.forEach(function(f){
    assert.ok(rootCovered(PATTERNS, f), 'not packaged: ' + f);
  });
});

test('installer: every root-level portal JS file is packaged', function(){
  var js = ROOT_FILES.filter(function(f){ return /\.js$/.test(f); });
  assert.ok(js.length > 10, 'repo should contain the portal scripts');
  js.forEach(function(f){
    assert.ok(rootCovered(PATTERNS, f), 'not packaged: ' + f);
  });
});

/* Root .css/.json/.png: portal assets must be packaged; the list below
   is everything that is deliberately NOT a portal asset. Any NEW
   root-level asset of these types fails the test until a decision is
   made (package it, or add it to the skip list with a reason). */
var ROOT_SKIPS = {
  'package.json': 'npm manifest only',
  'package-lock.json': 'npm lockfile only',
  'firebase.json': 'Firebase CLI config',
  'database.rules.json': 'Firebase rules (live site)',
  'database.rules.compat.json': 'Firebase rules (live site)'
};

test('installer: root-level css/json/png are packaged or explicitly skipped', function(){
  var assets = ROOT_FILES.filter(function(f){
    return /\.(css|json|png)$/.test(f);
  });
  assert.ok(assets.length > 0, 'expected root-level portal assets');
  assets.forEach(function(f){
    if(ROOT_SKIPS[f]) return;
    assert.ok(rootCovered(PATTERNS, f), 'not packaged (and not skipped): ' + f);
  });
  /* The skip list itself must stay honest: every skip must still exist
     or the entry is stale. */
  Object.keys(ROOT_SKIPS).forEach(function(f){
    assert.ok(ROOT_FILES.indexOf(f) >= 0, 'stale skip entry: ' + f);
  });
});

test('installer: core service, runtime and vendor entries are present', function(){
  var required = [
    'offline/server/*',
    'offline/node_modules/*',
    'offline/rsms-local-adapter.js',
    'offline/package.json',
    'offline/windows/install-service.ps1',
    'offline/windows/uninstall-service.ps1',
    'vendor/nssm/nssm.exe',
    'vendor/node-runtime/node.exe'
  ];
  required.forEach(function(p){
    assert.ok(PATTERNS.indexOf(p) >= 0, 'missing Source entry: ' + p);
  });
});
