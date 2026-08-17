/* WindMark service worker.

   Cache-first for everything the app is made of, so an installed PWA cold
   starts in airplane mode. There is no runtime network dependency at all —
   the network is only ever used to pick up a new version of the app.

   Bump CACHE_NAME whenever any cached file changes. */

var CACHE_NAME = 'windmark-v1.1.0';

var ASSETS = [
  './',
  'index.html',
  'css/windmark.css',
  'js/util.js',
  'js/store.js',
  'js/sensors.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // addAll is atomic: if one asset fails, the install fails loudly
      // rather than leaving a half-cached app that breaks offline.
      return cache.addAll(ASSETS);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // nothing off-origin is used

  // Navigations always resolve to the cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('index.html').then(function (hit) {
        return hit || fetch(req).catch(function () { return caches.match('./'); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        // Refresh in the background; never block the field on the network.
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE_NAME).then(function (c) { c.put(req, res); });
        }).catch(function () {});
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
