// Opens the gestalter offline: its notes are on the gestalts-node on this computer, only the page comes from the web.
// The page (index.html) comes from the network when it can, so a new version shows on the next load; the hashed
// build files never change, so they come from the cache once fetched. Only this site's own files are kept.
const CACHE = 'gestalter-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' || !url.pathname.includes('/assets/')) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then((c) => c.put(request, copy)); }
      return response;
    }).catch(() => caches.match(request).then((hit) => hit ?? Response.error())));
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
    if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then((c) => c.put(request, copy)); }
    return response;
  })));
});
