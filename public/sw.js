// Minimal service worker — network-first with a small shell cache for
// offline fallback. Versioned cache name so deploys evict the old one.
//
// What it caches:
//   - The app shell (index.html, manifest, icons)
//   - JS/CSS/wasm chunks from /assets/ (immutable, content-hashed by Vite)
// What it does NOT cache:
//   - Matrix /sync, /api calls, anything dynamic
//   - Anything from a different origin

const CACHE_VERSION = 'v4';
const SHELL_CACHE = `wukkiemail-shell-${CACHE_VERSION}`;
const ASSETS_CACHE = `wukkiemail-assets-${CACHE_VERSION}`;

const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/wukkie.svg',
  '/icons/android-192.png',
  '/icons/android-512.png',
  '/icons/apple-touch-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== SHELL_CACHE && k !== ASSETS_CACHE)
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SPA navigation: ALWAYS fetch index.html fresh, bypassing the browser's
  // HTTP cache (cache: 'no-store'). This is the key fix for stale apps on
  // mobile — a cached HTML would point at old, content-hashed asset URLs, and
  // since assets are cache-first that would pin the whole old app. The HTML is
  // tiny, so revalidating it every navigation is cheap. We refresh the offline
  // shell copy on success and fall back to it only when truly offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        if (fresh.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/', fresh.clone());
        }
        return fresh;
      } catch {
        const shell = await caches.match('/');
        return shell ?? new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Hashed assets: cache-first, persist on success.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(ASSETS_CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        return new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Everything else: network-first, fall back to whatever's cached.
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      return fresh;
    } catch {
      const cached = await caches.match(req);
      return cached ?? new Response('Offline', { status: 503 });
    }
  })());
});
