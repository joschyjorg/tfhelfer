'use strict';
// Service Worker: macht die App offline startfähig.
// VERSION wird beim Bauen des Pakets (tools/paket_bauen.py) auf einen neuen Wert gesetzt, also bei jeder Veröffentlichung neu.
// Dadurch bekommt jede Veröffentlichung einen frischen Cache; alte Caches werden gelöscht.
const VERSION = '20261123-160008';
const CACHE = 'tf-helfer-' + VERSION;
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'network.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'js/geo.js', 'js/route.js', 'js/map.js', 'js/sim.js', 'js/storage.js', 'js/app.js', 'js/details.js', 'js/daten.js'
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(FILES.map(f => c.add(new Request(f, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('tf-helfer-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Erst das Netz (immer die neueste Version, ohne den Browser-Zwischenspeicher), bei Fehler oder Zeitüberschreitung der Cache.
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
    const res = await fetch(req.url, { cache: 'no-cache', signal: ctrl.signal });
    clearTimeout(timer);
    if (res && res.ok) cache.put(req.url, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req.url, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const page = (await cache.match('index.html')) || (await cache.match('./'));
      if (page) return page;
    }
    throw e;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});
