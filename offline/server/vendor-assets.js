'use strict';

/* Copy the third-party assets the portals reference from node_modules
   into server/vendor/ so the LAN server can serve them offline.
   Run once with `npm run vendor` (internet available); the resulting
   files are committed so pilot installs need no network build step. */

var fs = require('fs');
var path = require('path');

var VENDOR_DIR = path.join(__dirname, 'vendor');

var COPIES = [
  [path.join('firebase', 'firebase-app-compat.js'), 'firebase-app-compat.js'],
  [path.join('firebase', 'firebase-database-compat.js'), 'firebase-database-compat.js'],
  [path.join('firebase', 'firebase-auth-compat.js'), 'firebase-auth-compat.js'],
  [path.join('chart.js', 'dist', 'chart.umd.js'), 'chart.umd.min.js'],
  [path.join('jsqr', 'dist', 'jsQR.js'), 'jsQR.js'],
  [path.join('qrcodejs', 'qrcode.min.js'), 'qrcode.min.js']
];

function main(){
  fs.mkdirSync(VENDOR_DIR, {recursive: true});
  COPIES.forEach(function(pair){
    var from = path.join(__dirname, '..', 'node_modules', pair[0]);
    var to = path.join(VENDOR_DIR, pair[1]);
    if(!fs.existsSync(from)){
      console.error('missing source: ' + from);
      process.exitCode = 1;
      return;
    }
    fs.copyFileSync(from, to);
    console.log('vendored: ' + pair[1] + ' (' + fs.statSync(to).size + ' bytes)');
  });
}

main();
