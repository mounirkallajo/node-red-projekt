const TILE_CACHE_NAME = 'tile-cache-v2';
const TILE_URL_PATTERNS = [
  /\/tiles\/(light|colored)\/\d+\/\d+\/\d+/
];
const MAX_TILE_ENTRIES = 6000;

self.addEventListener('install', function (installEvent) {
  self.skipWaiting();
});

self.addEventListener('activate', function (activateEvent) {
  activateEvent.waitUntil(
    caches.keys().then(function (cacheNames) {
      return Promise.all(cacheNames.map(function (cacheName) {
        if (cacheName !== TILE_CACHE_NAME) return caches.delete(cacheName);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isTileRequest(requestUrl) {
  for (let patternIndex = 0; patternIndex < TILE_URL_PATTERNS.length; patternIndex++) {
    if (TILE_URL_PATTERNS[patternIndex].test(requestUrl)) return true;
  }
  return false;
}

async function trimCache(cache) {
  const cacheKeys = await cache.keys();
  if (cacheKeys.length <= MAX_TILE_ENTRIES) return;
  const overflow = cacheKeys.length - MAX_TILE_ENTRIES;
  for (let i = 0; i < overflow; i++) {
    await cache.delete(cacheKeys[i]);
  }
}

async function cacheFirstTile(request) {
  const cache = await caches.open(TILE_CACHE_NAME);
  const cachedResponse = await cache.match(request, { ignoreVary: true });
  if (cachedResponse) {
    fetch(request).then(function (networkResponse) {
      if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
        cache.put(request, networkResponse.clone()).catch(function () {});
      }
    }).catch(function () {});
    return cachedResponse;
  }
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
      cache.put(request, networkResponse.clone()).catch(function () {});
      trimCache(cache).catch(function () {});
    }
    return networkResponse;
  } catch (networkError) {
    const fallback = await cache.match(request, { ignoreVary: true });
    if (fallback) return fallback;
    throw networkError;
  }
}

self.addEventListener('fetch', function (fetchEvent) {
  const request = fetchEvent.request;
  if (request.method !== 'GET') return;
  if (!isTileRequest(request.url)) return;
  fetchEvent.respondWith(cacheFirstTile(request));
});

self.addEventListener('message', function (messageEvent) {
  const data = messageEvent.data || {};
  if (data.type === 'CLEAR_TILE_CACHE') {
    messageEvent.waitUntil(caches.delete(TILE_CACHE_NAME));
  }
});
