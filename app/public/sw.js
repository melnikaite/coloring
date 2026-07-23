// Hand-written service worker for Coloriki.
//
// Strategy:
// - Navigations (index.html / the SPA shell): network-first, falling back to
//   the cached shell when offline.
// - Hashed build assets (/assets/**, produced by Vite - content-addressed,
//   so "cache once, keep forever" is always safe): cache-first, populated on
//   first fetch since we don't have a precomputed manifest of hashed names.
// - Coloring page images (/images/**): cache-first. We deliberately do NOT
//   bulk-download every catalog image on activate (the catalog can grow
//   large) - a page caches itself the moment it's viewed, and the gallery
//   page can also explicitly download a whole category ahead of time via
//   the Cache API (see src/offlineCache.ts), writing into this same cache.
//   EXCEPTION: /images/catalog.json is network-first (still stored in the
//   images cache for offline) - it's the mutable index of the whole gallery,
//   and serving it cache-first would hide newly deployed images forever.
// - Everything else same-origin: network falling back to cache.

const CACHE_VERSION = 'coloriki-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const IMAGES_CACHE = `${CACHE_VERSION}-images`;
const ALL_CACHES = [SHELL_CACHE, RUNTIME_CACHE, IMAGES_CACHE];

const SHELL_FILES = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-180.png'];

// Best-effort precache of the hashed Vite build (JS/CSS). Written at build
// time by the precache-manifest Vite plugin (see vite.config.ts). Without
// this, the hashed bundle is only cached lazily by the cache-first fetch
// handler below, which doesn't run until AFTER the SW is controlling the
// page - i.e. not on the very first load following registration. That left
// a window where a single online visit followed by going offline could
// break the app. Precaching it during install closes that gap.
async function precacheHashedAssets() {
  try {
    const res = await fetch('/precache-manifest.json');
    if (!res.ok) return;
    const urls = await res.json();
    if (!Array.isArray(urls) || urls.length === 0) return;
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.addAll(urls);
  } catch {
    // Precaching is a best-effort enhancement, not required for install to succeed.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => precacheHashedAssets())
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => !ALL_CACHES.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

function isHashedAsset(url) {
  return url.pathname.startsWith('/assets/');
}

function isImageRequest(url) {
  return url.pathname.startsWith('/images/');
}

function isCatalogRequest(url) {
  return url.pathname === '/images/catalog.json';
}

const NETWORK_TIMEOUT_MS = 3000;

// Fetches with a timeout so a "connected but not really working" network
// (weak cell signal, hotel captive wifi) falls back to cache quickly instead
// of hanging for tens of seconds. Uses AbortController to actually cancel the
// in-flight request rather than just racing it.
function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function networkFirst(request, cacheName, { shellFallback = false } = {}) {
  const cache = await caches.open(cacheName);
  async function fallback() {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (shellFallback) {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    return null;
  }
  try {
    const fresh = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
      return fresh;
    }
    // Non-ok response (e.g. a captive-portal error page): prefer cache if we
    // have it, only surface the bad response if there's truly nothing cached.
    const cachedFallback = await fallback();
    return cachedFallback || fresh;
  } catch {
    const cachedFallback = await fallback();
    if (cachedFallback) return cachedFallback;
    throw new Error('offline and not cached');
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE, { shellFallback: true }));
    return;
  }
  if (isCatalogRequest(url)) {
    // Network-first: newly deployed images must show up on next online visit.
    event.respondWith(networkFirst(request, IMAGES_CACHE));
    return;
  }
  if (isImageRequest(url)) {
    event.respondWith(cacheFirst(request, IMAGES_CACHE));
    return;
  }
  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }
  event.respondWith(networkFirst(request, RUNTIME_CACHE));
});
