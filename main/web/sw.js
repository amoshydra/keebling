// Service worker for the published UI.
//
// It exists for one case: the phone has joined the dongle's own access point,
// which has no internet, so nothing can be fetched from GitHub. Network-first
// with a cache fallback keeps updates automatic while leaving the last good
// copy for exactly that moment.
//
// Only the published origin registers this. The device serves its own UI and
// has its own upload mechanism; caching there would just pin a stale copy.

const CACHE = 'keebling-shell';

const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'common.js',
  'ui.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // A missing file must not fail the whole install: an offline shell with
    // one gap is still better than no shell at all.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // The device is a different origin and is permission-gated by the browser.
  // Caching it would be both pointless and wrong.
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // no-store on purpose: GitHub Pages sends max-age=600, so a plain fetch
    // here would keep serving the previous deploy for ten minutes after a push
    // even though this worker is network-first.
    //
    // A network that is up but has no route can take a minute to give up; the
    // cached shell should not wait for it.
    const res = await fetch(req, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    return new Response('offline', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
