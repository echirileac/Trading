// Edison Growth as a home-screen app: this worker only makes the app open without a connection.
// Always network first, so prices, forecasts and new versions of the page arrive exactly as before;
// the saved copy is used only when the network fails. Other sites (fonts, TradingView, Twelve Data) are not touched.
// Data files stay as published (encrypted when the password lock is on).
const CACHE = 'edison-app-v1';
const SHELL = ['./', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png', 'vendor/lightweight-charts-4.2.3.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => { /* offline install: fill later */ }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('edison-app-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// One saved copy per file: the ?t= and ?v= parts are dropped from the key, so the cache never grows.
const keyOf = (url) => url.origin + url.pathname;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL('./', self.location).pathname)) return;
  if (url.pathname.endsWith('/sw.js')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(keyOf(url), copy)).catch(() => {}));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(keyOf(url));
      if (hit) return hit;
      if (req.mode === 'navigate') { const page = await caches.match(keyOf(new URL('./', self.location))); if (page) return page; }
      throw err;
    }
  })());
});
