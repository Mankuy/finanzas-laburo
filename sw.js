/* Finanzas Laburo — offline-first cache-first */
const CACHE = 'finanzas-laburo-v6';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './sheets.js',
  './pdf.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/icon-maskable-512.svg'
];
const CDN = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of ASSETS) {
      try { await cache.add(url); } catch (e) { console.warn('[SW]', url, e); }
    }
    for (const url of CDN) {
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (res.ok) await cache.put(url, res.clone());
      } catch (_) {}
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) {
      event.waitUntil(
        fetch(event.request).then((res) => {
          if (res && res.ok) cache.put(event.request, res.clone());
        }).catch(() => {})
      );
      return cached;
    }
    try {
      const res = await fetch(event.request);
      if (res && res.ok) cache.put(event.request, res.clone());
      return res;
    } catch {
      if (event.request.mode === 'navigate') {
        return (await cache.match('./index.html')) ||
          (await cache.match('index.html')) ||
          new Response('Offline', { status: 503 });
      }
      return new Response('Offline', { status: 503 });
    }
  })());
});
