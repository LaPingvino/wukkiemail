// Minimal service worker — network-first with a small shell cache for
// offline fallback. Versioned cache name so deploys evict the old one.
//
// What it caches:
//   - The app shell (index.html, manifest, icons)
//   - JS/CSS/wasm chunks from /assets/ (immutable, content-hashed by Vite)
// What it does NOT cache:
//   - Matrix /sync, /api calls, anything dynamic
//   - Anything from a different origin

// Bumped v4->v5 so the activate sweep clears the OLD unbounded assets cache:
// because sw.js bytes rarely changed, install/activate almost never re-ran, so
// every deploy's content-hashed chunks accumulated in wukkiemail-assets-v4
// forever. v5 starts clean AND bounded (see ASSET_CACHE_CAP / trimAssetsCache).
const CACHE_VERSION = 'v5';
const SHELL_CACHE = `wukkiemail-shell-${CACHE_VERSION}`;
const ASSETS_CACHE = `wukkiemail-assets-${CACHE_VERSION}`;

// Cap the assets cache. A build is ~15-20 content-hashed chunks, so this retains
// ~4 deploys' worth — plenty for the current session plus recent versions — while
// bounding storage growth (which, with the persistent-storage grant, could creep
// toward quota and trigger the IndexedDB "UnknownError" eviction). FIFO eviction:
// assets are immutable + hashed, so oldest-inserted = stalest deploy = safe to drop.
const ASSET_CACHE_CAP = 60;

async function trimAssetsCache(cache) {
  const keys = await cache.keys(); // Cache API returns keys in insertion order
  if (keys.length <= ASSET_CACHE_CAP) return;
  const overflow = keys.slice(0, keys.length - ASSET_CACHE_CAP);
  await Promise.all(overflow.map((k) => cache.delete(k)));
}

// Fetch with one retry. A backgrounded tab restored by Chrome's Memory/Data
// Saver often has a cold network for a beat — the first asset fetch throws, but
// a retry ~400ms later usually succeeds, avoiding the fatal 503 that blanks the
// app before the entry bundle can run.
async function fetchWithRetry(req, attempts) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetch(req);
    } catch (e) {
      lastErr = e;
      // eslint-disable-next-line no-await-in-loop
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

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

  // Hashed assets: cache-first, persist on success. On a cache miss, retry the
  // network once before giving up — this covers the cold-network window right
  // after a tab restore, where a single failed fetch would otherwise 503 the
  // entry bundle and blank the app. Bound the cache after each new write.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetchWithRetry(req, 2);
        if (fresh.ok) {
          const cache = await caches.open(ASSETS_CACHE);
          await cache.put(req, fresh.clone());
          event.waitUntil(trimAssetsCache(cache)); // evict oldest in the background
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
