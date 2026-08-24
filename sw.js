/*  ═══════════════════════════════════════════════════════
    RSMS Service Worker  —  v3.1.0
    Strategy: Network-first, cache-fallback
    Domain:   rsms.rehoteq.com (root paths, no prefix)
    ═══════════════════════════════════════════════════════ */

var CACHE_NAME = 'rsms-v3.1.0';

var STATIC_ASSETS = [
  '/',
  '/index.html',
  '/rsms-app.html',
  '/rsms-login.html',
  '/rsms-admin.html',
  '/rsms-bursar.html',
  '/rsms-teacher.html',
  '/rsms-classteacher.html',
  '/rsms-parent.html',
  '/rsms-student.html',
  '/rsms-cbt.html',
  '/rsms-cbt-questions.html',
  '/rsms-superadmin.html',
  '/rsms-control.html',
  '/rsms-onboarding.html',
  '/rsms-apply.html',
  '/rsms-attendance.html',
  '/rsms-analytics.html',
  '/rsms-hod.html',
  '/rsms-vp.html',
  '/rsms-principal.html',
  '/rsms-timetable.html',
  '/rsms-results-print.html',
  '/rsms-progress-report.html',
  '/rsms-fees-receipt.html',
  '/rsms-receipt.html',
  '/rsms-links.html',
  '/rsms-qrcodes.html',
  '/rsms-alerts.html',
  '/rsms-reset.html',
  '/rsms-flier.html',
  '/rsms-clock.html',
  '/rsms-staff-clock.html',
  '/rsms-demo-setup.html',
  '/rsms-dashboard.html',
  '/rsms-voice-ai.html',
  '/rsms-ai-guardian.html',
  '/rsms-migrate.html',
  '/rsms-core.js',
  '/rsms-core.css',
  '/rsms-firebase.js',
  '/rsms-config.js',
  '/rsms-auth.js',
  '/rsms-notifications.js',
  '/rsms-plan-guard.js',
  '/rsms-subjects.js',
  '/rsms-school-detect.js',
  '/rsms-pwa.js',
  '/rsms-sync.js',
  '/rsms-sync-config.example.js',
  '/rsms-sync-diagnostics.html',
  '/lesson-ai.html',
  '/manifest.json',
  '/icon-192.png'
];

var FONT_URLS = [
  'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700;900&family=Outfit:wght@300;400;500;600;700;800&display=swap'
];

/* ── Offline fallback page ──────────────────────────── */

var OFFLINE_PAGE = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="UTF-8"/>',
  '<meta name="viewport" content="width=device-width,initial-scale=1.0"/>',
  '<title>RSMS — Offline</title>',
  '<style>',
  '@import url("https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap");',
  '*{margin:0;padding:0;box-sizing:border-box;}',
  'body{background:#030305;color:#f0f2ff;font-family:Outfit,system-ui,sans-serif;',
  '  display:flex;align-items:center;justify-content:center;height:100vh;',
  '  text-align:center;padding:24px;}',
  '.container{max-width:400px;}',
  '.logo{font-size:2rem;font-weight:700;color:#d4a843;margin-bottom:8px;letter-spacing:.04em;}',
  '.spin{width:52px;height:52px;border:3px solid rgba(212,168,67,.15);',
  '  border-top-color:#d4a843;border-radius:50%;',
  '  animation:spin .8s linear infinite;margin:0 auto 24px;}',
  '@keyframes spin{to{transform:rotate(360deg);}}',
  'h1{font-size:1.35rem;font-weight:600;margin-bottom:10px;color:rgba(240,242,255,.85);}',
  'p{font-size:.92rem;color:rgba(240,242,255,.45);line-height:1.5;margin-bottom:28px;}',
  '.retry{display:inline-block;padding:12px 36px;background:#d4a843;color:#030305;',
  '  border:none;border-radius:10px;font-family:Outfit,sans-serif;font-size:.95rem;',
  '  font-weight:600;cursor:pointer;text-decoration:none;transition:background .2s;}',
  '.retry:hover{background:#e2b94f;}',
  '</style>',
  '</head>',
  '<body>',
  '<div class="container">',
  '  <div class="spin"></div>',
  '  <div class="logo">RSMS</div>',
  '  <h1>You are currently offline</h1>',
  '  <p>Please check your internet connection and try again.</p>',
  '  <button class="retry" onclick="location.reload()">Retry</button>',
  '</div>',
  '</body>',
  '</html>'
].join('\n');

/* ── Install event — pre-cache static assets ────────── */

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // Cache fonts separately (cross-origin, may fail gracefully)
      var fontPromises = FONT_URLS.map(function(url) {
        return cache.add(url).catch(function(err) {
          console.warn('[SW] Font cache skipped:', url, err);
        });
      });

      return Promise.all([
        cache.addAll(STATIC_ASSETS),
        Promise.all(fontPromises)
      ]);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

/* ── Activate event — clean old caches ──────────────── */

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(name) {
          return name !== CACHE_NAME;
        }).map(function(name) {
          console.log('[SW] Deleting old cache:', name);
          return caches.delete(name);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

/* ── Fetch event — network-first, cache-fallback ────── */

function isFirebaseRequest(url) {
  try {
    var host = new URL(url).hostname.toLowerCase();
    return host === 'firebaseio.com' || host.slice(-15) === '.firebaseio.com' ||
      host === 'firebasedatabase.app' || host.slice(-21) === '.firebasedatabase.app' ||
      host === 'firebaseapp.com' || host.slice(-16) === '.firebaseapp.com' ||
      host === 'firebase.googleapis.com' || host === 'identitytoolkit.googleapis.com' ||
      host === 'securetoken.googleapis.com' || host === 'firebasestorage.googleapis.com' ||
      host === 'googleapis.com' || host.slice(-15) === '.googleapis.com';
  } catch (e) {
    return false;
  }
}

self.addEventListener('fetch', function(event) {
  var request = event.request;

  // Never intercept writes or Firebase traffic. Firebase requests must pass
  // straight through so this cache cannot alter auth/database semantics.
  if (request.method !== 'GET' || isFirebaseRequest(request.url)) return;

  // Skip chrome-extension and other non-http(s) schemes
  if (request.url.indexOf('http') !== 0) return;

  // For navigation requests (HTML pages)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function(response) {
        // Cache successful navigation responses
        if (response.ok) {
          var responseClone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(request, responseClone);
          });
        }
        return response;
      }).catch(function() {
        // Try cache, then offline fallback
        return caches.match(request).then(function(cached) {
          if (cached) return cached;
          return new Response(OFFLINE_PAGE, {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        });
      })
    );
    return;
  }

  // For all other requests (assets, scripts, styles, fonts, images)
  event.respondWith(
    fetch(request).then(function(response) {
      // Cache successful responses
      if (response.ok) {
        var responseClone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(request, responseClone);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(request).then(function(cached) {
        return cached || new Response('', { status: 408, statusText: 'Offline' });
      });
    })
  );
});

/* ── Push notification support ──────────────────────── */

self.addEventListener('push', function(event) {
  var data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'RSMS', body: event.data.text() };
    }
  }

  var title = data.title || 'RSMS Notification';
  var options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'rsms-notification',
    data: data.data || {},
    vibrate: [200, 100, 200],
    actions: data.actions || []
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

/* ── Notification click handler ─────────────────────── */

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  var url = '/';
  if (event.notification.data && event.notification.data.url) {
    url = event.notification.data.url;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Focus existing window if available
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});

/* ── Notification close handler ─────────────────────── */

self.addEventListener('notificationclose', function(event) {
  // Analytics hook — can be extended
  console.log('[SW] Notification dismissed:', event.notification.tag);
});
