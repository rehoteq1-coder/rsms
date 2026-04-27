// RSMS Service Worker — Rehoteq Technologies
const CACHE_NAME = 'rsms-v1.0.0';
const STATIC_ASSETS = [
  '/rsms/',
  '/rsms/index.html',
  '/rsms/rsms-admin.html',
  '/rsms/rsms-teacher.html',
  '/rsms/rsms-student.html',
  '/rsms/rsms-parent.html',
  '/rsms/rsms-cbt.html',
  '/rsms/rsms-apply.html',
  '/rsms/rsms-onboarding.html',
  '/rsms/rsms-control.html',
  '/rsms/manifest.json',
  'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700;900&family=Outfit:wght@300;400;500;600;700;800&display=swap'
];

// Install — cache all static assets
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS.map(function(url) {
        return new Request(url, { mode: 'no-cors' });
      }));
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Activate — clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
          .map(function(key) { return caches.delete(key); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch — network first, cache fallback
self.addEventListener('fetch', function(event) {
  // Skip non-GET and external requests (except fonts)
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Cache successful responses
        if (response && response.status === 200) {
          var responseClone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(function() {
        // Offline fallback — serve from cache
        return caches.match(event.request).then(function(cached) {
          if (cached) return cached;
          // Offline page for navigation
          if (event.request.mode === 'navigate') {
            return caches.match('/rsms/index.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});

// Push notifications
self.addEventListener('push', function(event) {
  var data = {};
  if (event.data) {
    try { data = event.data.json(); } catch(e) { data = { title: 'RSMS', body: event.data.text() }; }
  }
  var options = {
    body: data.body || 'New notification from RSMS',
    icon: '/rsms/icons/icon-192.png',
    badge: '/rsms/icons/icon-72.png',
    vibrate: [200, 100, 200],
    data: data.url || '/rsms/',
    actions: data.actions || []
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'RSMS Notification', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data || '/rsms/')
  );
});
