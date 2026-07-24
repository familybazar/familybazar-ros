/* Family Bazar ROS - service worker (installable + offline + push).
   Bump SW_VERSION whenever the app shell changes so clients update. */
const SW_VERSION = 'ros-v1';
const SHELL_CACHE = 'shell-' + SW_VERSION;
const DATA_CACHE  = 'data-'  + SW_VERSION;
const SHELL = [
  '/', '/preview.html', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-maskable.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await c.addAll(SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== SHELL_CACHE && k !== DATA_CACHE) ? caches.delete(k) : null));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never cache writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // only handle same-origin

  // App navigations: network-first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(SHELL_CACHE);
        c.put('/preview.html', net.clone());
        return net;
      } catch (err) {
        return (await caches.match('/preview.html')) || (await caches.match('/')) ||
               new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // GET API data: network-first, cache the last good copy for offline viewing.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        if (net && net.ok) { const c = await caches.open(DATA_CACHE); c.put(req, net.clone()); }
        return net;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response(JSON.stringify({ offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // Static assets (icons, css-in-html already inline): cache-first.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const net = await fetch(req);
      if (net && net.ok) { const c = await caches.open(SHELL_CACHE); c.put(req, net.clone()); }
      return net;
    } catch (err) {
      return cached || new Response('', { status: 504 });
    }
  })());
});

// ---- Push notifications ----
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'Family Bazar OS';
  const opts = {
    body: data.body || '',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    tag: data.tag || 'ros',
    renotify: !!data.renotify,
    data: { url: data.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) { client.navigate(target).catch(() => {}); return client.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
