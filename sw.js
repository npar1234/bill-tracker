const CACHE = 'simpleledger-v51';
const ASSETS = ['./', 'index.html', 'style.css?v=51', 'app.js?v=51', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.json'];

self.addEventListener('install', e => {
  // Individually, so one bad url can't fail the whole precache (addAll is all-or-nothing)
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {})))));
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

// ─────────────────────────────────────────────────────────────────────
//  Serve from cache, refresh behind the scenes.
//  HARD RULE: this handler always resolves with a real Response. The previous
//  worker did `.catch(() => caches.match(req))`, and caches.match resolves to
//  UNDEFINED on a miss — which Safari reports as "Returned response is null"
//  and refuses to render. Network failure plus a cache miss must degrade to a
//  page, never to nothing.
// ─────────────────────────────────────────────────────────────────────
const OFFLINE_HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>SimpleLedger</title></head>
<body style="background:#0f0f14;color:#f0f0f5;font:16px -apple-system,BlinkMacSystemFont,sans-serif;margin:0;
display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px">
<div><p style="color:#8b8b9e;line-height:1.6">Couldn't reach the network, and nothing is cached yet.</p>
<p style="color:#55556a;font-size:13px;line-height:1.6">Your data is safe on this device.<br>Pull down or reopen to retry.</p>
<button onclick="location.reload()" style="margin-top:18px;background:#3b82f6;color:#fff;border:0;
border-radius:12px;padding:12px 22px;font-size:15px;font-weight:600">Retry</button></div></body></html>`;

function offlineResponse(req) {
  const wantsHtml = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');
  return wantsHtml
    ? new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  // Don't intercept non-GET or API calls (sync/push functions) — cache.put on POST throws
  if (req.method !== 'GET' || req.url.includes('/.netlify/functions/')) return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;       // no third parties
  if (url.searchParams.has('nosw')) return;              // escape hatch: bypass the worker entirely

  e.respondWith((async () => {
    let cache = null;
    try { cache = await caches.open(CACHE); } catch { cache = null; }

    let cached = null;
    if (cache) { try { cached = await cache.match(req, { ignoreVary: true }); } catch { cached = null; } }

    if (cached) {
      // Instant paint; refresh for next time without blocking this response.
      if (cache) e.waitUntil((async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        } catch {}
      })());
      return cached;
    }

    // Nothing cached — go to network, but never hand back a non-Response.
    try {
      const res = await fetch(req);
      if (res) {
        if (cache && res.ok) { try { await cache.put(req, res.clone()); } catch {} }
        return res;
      }
    } catch {}

    // Network failed and the cache missed. Last resort: the shell, then a page.
    if (cache) {
      try {
        const shell = await cache.match('index.html', { ignoreVary: true })
                   || await cache.match('./', { ignoreVary: true });
        if (shell && req.mode === 'navigate') return shell;
      } catch {}
    }
    return offlineResponse(req);
  })());
});
