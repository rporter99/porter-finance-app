// Caches only the app's own files so it opens fast. Your financial data is
// never cached: requests to Google are left alone.
const CACHE = 'pf-shell-v41';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'demo-data.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'images/accounts.jpg', 'images/budget.jpg', 'images/transactions.jpg', 'images/connections.jpg'];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's own cache so a new version never saves old files.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first, so updates show up right away; fall back to the cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // 'no-cache' asks GitHub whether the file changed instead of trusting a copy for 10 minutes.
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        // Safari refuses a followed redirect for a page load; hand it back as a redirect instead.
        if (res.redirected && e.request.mode === 'navigate') return Response.redirect(res.url, 302);
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
