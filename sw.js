const CACHE = 'simpleledger-v22';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Handle notification messages from main thread
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(e.data.title, {
      body: e.data.body,
      tag: e.data.tag,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: [100, 50, 100],
    });
  }
});

// Handle server-sent push events (works even when app is fully closed)
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json(); // { title, body, tag, billIds?, month?, year? }
    e.waitUntil(
      self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        vibrate: [100, 50, 100],
        data: { url: './', billIds: data.billIds, month: data.month, year: data.year },
        // One-gesture mark-paid straight from the notification
        actions: data.billIds ? [{ action: 'markpaid', title: '✓ Mark Paid' }] : [],
      })
    );
  } catch (err) {
    // Fallback: show raw text
    e.waitUntil(
      self.registration.showNotification('SimpleLedger', {
        body: e.data.text(),
        icon: 'icon-192.png',
      })
    );
  }
});

// Tapping a notification opens the app; "Mark Paid" applies without navigation
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      if (e.action === 'markpaid' && d.billIds) {
        if (wins.length > 0) {
          wins[0].postMessage({ type: 'MARK_PAID', billIds: d.billIds, month: d.month, year: d.year });
          return wins[0].focus();
        }
        // App closed — pass the action through the launch URL
        return clients.openWindow(`./?markpaid=${d.billIds.join(',')}&m=${d.month}&y=${d.year}`);
      }
      if (wins.length > 0) { wins[0].focus(); return; }
      clients.openWindow('./');
    })
  );
});

// Network-first: try network, fall back to cache (works offline, always fresh when online)
self.addEventListener('fetch', e => {
  // Don't intercept non-GET or API calls (sync/push functions) — cache.put on POST throws
  if (e.request.method !== 'GET' || e.request.url.includes('/.netlify/functions/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
