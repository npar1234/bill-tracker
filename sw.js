const CACHE = 'simpleledger-v26';

// Precache the EXACT urls index.html requests (query string is part of the cache key).
// Bump these alongside the ?v= in index.html on every deploy.
const ASSETS = [
  './', 'index.html',
  'style.css?v=45',
  'app.js?v=49',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.json',
];

self.addEventListener('install', e => {
  // Individually so one 404 can't fail the whole precache (addAll is all-or-nothing)
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(ASSETS.map(u => c.add(u).catch(() => {})))
  ));
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

// Tell every open client the app shell changed under them (only ever sent for navigations)
function broadcast(msg) {
  clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(ws => ws.forEach(w => w.postMessage(msg)));
}

// ─────────────────────────────────────────────────────────────
// Stale-while-revalidate: paint from cache instantly, refresh in
// the background. Was network-first, which made EVERY launch wait
// on ~230KB (index + app.js + style.css) before anything rendered.
// ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const req = e.request;
  // Don't intercept non-GET or API calls (sync/push functions) — cache.put on POST throws
  if (req.method !== 'GET' || req.url.includes('/.netlify/functions/')) return;
  // Same-origin only. The app has no third-party requests left by design.
  if (new URL(req.url).origin !== self.location.origin) return;

  const isNav = req.mode === 'navigate';

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      // ignoreVary: Netlify sends `vary: Accept-Encoding`; one stored variant is all we want
      const cached = await cache.match(req, { ignoreVary: true });

      const network = fetch(req).then(async res => {
        if (res && res.ok) {
          // Compare bodies before declaring a shell update, so header/ETag
          // churn can't trigger a reload loop
          if (isNav && cached) {
            const [a, b] = await Promise.all([cached.clone().text(), res.clone().text()]);
            if (a !== b) broadcast({ type: 'SHELL_UPDATED' });
          }
          cache.put(req, res.clone());
        }
        return res;
      }).catch(() => null);

      // Cache hit → instant paint, update lands in the background
      if (cached) return cached;
      const fresh = await network;
      return fresh || new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
