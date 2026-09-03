'use strict';

/* Portal serving correctness (Phase C).
  
   The offline server serves each root portal page with exactly two
   transformations: CDN URL -> /vendor/ rewrites, and the LAN adapter
   injected before the final </body>. This test asserts, for EVERY
   root .html page, that the served body equals the repo file with
   precisely those transformations applied.
  
   It exists because injectAdapter once used String.replace('</body>',
   ...), which landed inside a JS string on rsms-bursar.html (its
   report print-windows contain the literal text "</body>") — the
   injected <script> tags then truncated the page's main script
   (SyntaxError, dead nav, raw JS rendered as visible text). An
   exact-equality check catches that class of bug for every page.
*/

var assert = require('node:assert/strict');
var test = require('node:test');
var fs = require('node:fs');
var path = require('node:path');
var dbModule = require('../server/db');
var {createApp} = require('../server/index');
var {rewriteAssets, injectAdapter} = require('../server/serve-portals');

var REPO_ROOT = path.join(__dirname, '..', '..');

/* Must mirror serverConfig() in offline/server/index.js for an
   UNBOUND appliance. */
var UNBOUND_CONFIG = {
  mode: 'lan',
  server: '',
  version: '0.3.0-phase-c',
  schoolId: '',
  schoolName: '',
  syncEnabled: false,
  syncNote: 'Phase A: local storage only; cloud sync arrives in Phase B'
};

/* Portal pages are session-gated — fetch them with a valid staff
   session (bootstrap + login against the in-memory db). */
async function staffCookie(base){
  await fetch(base + '/api/bootstrap', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: 'admin1', displayName: 'Admin', role: 'admin', pin: '1234'})
  });
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: 'admin1', pin: '1234'})
  });
  var cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  var hit = cookies.find(function(c){ return c.indexOf('rsms_offline_session=') === 0; });
  return hit ? hit.split(';')[0] : null;
}

test('portals: served body of every root page == repo file + documented transformations only', async function(){
  var db = dbModule.openDatabase(':memory:');
  var server = createApp({db: db}).listen(0, '127.0.0.1');
  await new Promise(function(r){ server.on('listening', r); });
  var base = 'http://127.0.0.1:' + server.address().port;
  var cookie = await staffCookie(base);
  assert.ok(cookie, 'test session established');
  try{
    /* rsms-login.html is intentionally NOT served as a page on the
       appliance: the offline server redirects it to the staff entry
       (it is a cloud-only email login). */
    var files = fs.readdirSync(REPO_ROOT).filter(function(f){
      return /\.html$/.test(f) && f !== 'rsms-login.html';
    });
    assert.ok(files.length > 30, 'expected the portal pages at the repo root');
    var problems = [];
    for(var i = 0; i < files.length; i++){
      var f = files[i];
      var raw = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
      var expected = injectAdapter(rewriteAssets(raw), UNBOUND_CONFIG);
      var t;
      try {
        t = await (await fetch(base + '/' + f, {headers: {Cookie: cookie}})).text();
      } catch(e){
        problems.push(f + ': ' + e.message);
        continue;
      }
      if(t !== expected){
        var at = -1;
        for(var k = 0; k < Math.min(t.length, expected.length); k++){
          if(t[k] !== expected[k]) { at = k; break; }
        }
        problems.push(f + ': served body differs from documented transformations (first diff at char ' + at + ')');
      }
    }
    assert.deepEqual(problems, [], 'pages with wrong served bodies:\n' + problems.join('\n'));
  } finally {
    if(typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  }
});

test('portals: adapter injection lands before the LAST </body>, even when JS strings contain </body>', async function(){
  var db = dbModule.openDatabase(':memory:');
  var server = createApp({db: db}).listen(0, '127.0.0.1');
  await new Promise(function(r){ server.on('listening', r); });
  var base = 'http://127.0.0.1:' + server.address().port;
  var cookie = await staffCookie(base);
  assert.ok(cookie, 'test session established');
  try{
    /* Pages known to contain the literal text "</body>" inside JS
       strings (report print-windows). The adapter tag must sit
       immediately before the document's final </body>. */
    var tricky = ['rsms-bursar.html', 'rsms-timetable.html'];
    for(var i = 0; i < tricky.length; i++){
      var f = tricky[i];
      var t = await (await fetch(base + '/' + f, {headers: {Cookie: cookie}})).text();
      var bodyIdx = t.lastIndexOf('</body>');
      assert.ok(bodyIdx !== -1, f + ': final </body> present');
      assert.match(t.slice(bodyIdx), /^\s*<\/body>\s*<\/html>\s*$/i, f + ': real document tail after final </body>');
      var before = t.slice(Math.max(0, bodyIdx - 400), bodyIdx);
      assert.ok(before.indexOf('src="/adapter.js"') !== -1,
        f + ': adapter script must be injected immediately before the final </body>');
      /* The RSMS_LOCAL flag must NOT appear inside any JS string:
         concretely, it must occur after the last document.write( call. */
      var lastDw = t.lastIndexOf('document.write(');
      var flagIdx = t.indexOf('window.RSMS_LOCAL');
      if(lastDw !== -1) assert.ok(flagIdx > lastDw, f + ': RSMS_LOCAL flag must be after the last inline-JS usage');
    }
  } finally {
    if(typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  }
});
