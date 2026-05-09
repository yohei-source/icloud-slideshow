// Service Worker: caches iCloud media by pathname so the rotating
// signature in the query string doesn't bust the cache.
// iCloud signed URLs expire after ~3 hours, but the pathname is stable
// for the same asset, so once a photo/video is cached, future loads
// are served from the device with zero network traffic.

const CACHE_VERSION = 'v1';
const MEDIA_CACHE = `icloud-media-${CACHE_VERSION}`;
const ICLOUD_HOSTS = ['cvws.icloud-content.com'];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('icloud-media-') && n !== MEDIA_CACHE)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

function isMediaUrl(url) {
  return ICLOUD_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h));
}

function cacheKey(url) {
  return url.origin + url.pathname;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!isMediaUrl(url)) return;
  event.respondWith(handleMedia(event.request, url));
});

async function handleMedia(request, url) {
  const cache = await caches.open(MEDIA_CACHE);
  const key = cacheKey(url);

  const cached = await cache.match(key);
  if (cached) return buildResponse(cached, request);

  let response;
  try {
    response = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok && response.type !== 'opaque') {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (e) {
    try {
      response = await fetch(request.url, { mode: 'no-cors' });
    } catch (e2) {
      return Response.error();
    }
  }

  try {
    await cache.put(key, response.clone());
  } catch (e) {
    // Cache write may fail (quota, opaque restrictions); fall through and serve directly.
  }

  return buildResponse(response, request);
}

async function buildResponse(response, request) {
  const range = request.headers.get('range');
  if (!range) return response;
  if (response.type === 'opaque') return response;

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return response;

  const buffer = await response.clone().arrayBuffer();
  const total = buffer.byteLength;

  let start = match[1] !== '' ? parseInt(match[1], 10) : 0;
  let end = match[2] !== '' ? parseInt(match[2], 10) : total - 1;
  if (end >= total) end = total - 1;
  if (start > end || start < 0) {
    return new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': `bytes */${total}` },
    });
  }

  const sliced = buffer.slice(start, end + 1);
  return new Response(sliced, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Length': String(sliced.byteLength),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
