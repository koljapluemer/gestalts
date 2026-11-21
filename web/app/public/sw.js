// Opens the app offline: the user's data is in this browser, only the page comes from the web. The page (index.html,
// for every area's path) comes from the network when it can, so a new version shows on the next load; the hashed
// build files never change, so they come from the cache once fetched. Only this site's own files are kept, and never
// the teacher server's answers (/api).
const CACHE = 'gestalts-v1';
const PAGE = '/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keep = (key, response) => {
  if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then((c) => c.put(key, copy)); }
  return response;
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // every area is the same page
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((r) => keep(PAGE, r)).catch(() => caches.match(PAGE).then((hit) => hit ?? Response.error())));
    return;
  }
  if (!url.pathname.startsWith('/assets/')) {
    event.respondWith(fetch(request).then((r) => keep(request, r)).catch(() => caches.match(request).then((hit) => hit ?? Response.error())));
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((r) => keep(request, r))));
});
