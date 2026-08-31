'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS OFFLINE SERVER — LAN portal delivery

   Serves the existing portal pages from the repository root with two
   transformations applied at serve time (repository files unchanged):

   1. Third-party CDN script URLs are rewritten to self-hosted /vendor/
      copies, so the portals load with no internet at all.
   2. A small inline config + the LAN adapter script are injected before
      </body>, so pages run against the local API instead of Firebase.
═══════════════════════════════════════════════════════════════════ */

var fs = require('fs');
var path = require('path');

/* CDN URL -> self-hosted vendor file (exact strings used by the portals). */
var ASSET_MAP = [
  ['https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js', '/vendor/firebase-app-compat.js'],
  ['https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js', '/vendor/firebase-database-compat.js'],
  ['https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js', '/vendor/firebase-auth-compat.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jsqr/1.4.0/jsQR.js', '/vendor/jsQR.js'],
  ['https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js', '/vendor/jsQR.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js', '/vendor/qrcode.min.js'],
  ['https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js', '/vendor/qrcode.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', '/vendor/chart.umd.min.js']
];

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};

function rewriteAssets(html){
  var out = html;
  ASSET_MAP.forEach(function(pair){
    out = out.split(pair[0]).join(pair[1]);
  });
  return out;
}

/* Inject the LAN runtime flag + adapter before </body>. */
function injectAdapter(html, serverConfig){
  var injected =
    '\n<script>window.RSMS_LOCAL=' + JSON.stringify(serverConfig) + ';</script>' +
    '<script src="/adapter.js"></script>\n';
  if(html.indexOf('</body>') !== -1){
    return html.replace('</body>', injected + '</body>');
  }
  return html + injected;
}

/* Build a static-file middleware for the portal root. HTML/JS get
   rewritten; other assets stream through untouched. */
function portalMiddleware(rootDir, serverConfig){
  return function servePortal(req, resx, next){
    if(req.method !== 'GET' && req.method !== 'HEAD') return next();
    var urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if(urlPath === '/') urlPath = '/index.html';
    var safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    var file = path.join(rootDir, safe);
    if(!file.startsWith(rootDir)) return next();
    fs.stat(file, function(err, stat){
      if(err || !stat || !stat.isFile()) return next();
      var ext = path.extname(file).toLowerCase();
      if(ext !== '.html' && ext !== '.js'){
        resx.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        fs.createReadStream(file).pipe(resx);
        return;
      }
      fs.readFile(file, 'utf8', function(err2, text){
        if(err2) return next();
        var out = text;
        if(ext === '.html'){
          out = rewriteAssets(out);
          out = injectAdapter(out, serverConfig);
        }
        resx.setHeader('Content-Type', MIME[ext]);
        resx.setHeader('Cache-Control', 'no-cache');
        resx.send(out);
      });
    });
  };
}

module.exports = {
  ASSET_MAP:ASSET_MAP,
  rewriteAssets:rewriteAssets,
  injectAdapter:injectAdapter,
  portalMiddleware:portalMiddleware
};
