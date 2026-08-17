/* WindMark service worker.

   Strictly cache-first for everything the app is made of, so an installed PWA
   cold starts in airplane mode. There is no runtime network dependency at
   all — the network is only ever used to install a new version.

   The version and the file list come from js/assets.js so that the page's
   offline-readiness check and this worker can never disagree about what
   "cached" means. Bump WM_VERSION there when any cached file changes.

   Update behaviour, and why it is this way:

   * Each version installs into its own cache (windmark-v<version>).
     cache.addAll is atomic, so a failed install leaves NO partial cache
     behind and never touches the cache the phone is already running from.
     A half-downloaded update simply does not exist.

   * activate deletes the other caches only after the new worker has actually
     installed and taken over. Old assets are cleaned up, but never before
     their replacement is complete.

   * There is no skipWaiting. An update waits until WindMark is fully closed,
     so a running search cannot have its assets swapped out mid-log. Close the
     app completely and reopen it to finish an update.

   * Cached responses are served as-is and are never refreshed in the
     background. Silently pulling a newer file into an older version's cache
     would mix versions on a phone that is about to go offline. */

importScripts('js/assets.js');

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.has(WM_CACHE_NAME).then(function (existed) {
      return caches.open(WM_CACHE_NAME).then(function (cache) {
        // Atomic: one missing asset fails the whole install, loudly, rather
        // than leaving a half-cached app that breaks in the field.
        return cache.addAll(WM_ASSETS);
      }).catch(function (err) {
        // caches.open() creates the cache before addAll can fail, so a failed
        // install would otherwise leave an empty cache standing in for a
        // version that is not actually here. Clean up ONLY what this install
        // created: if a cache under this name already existed it belongs to
        // the version the phone is running, and must never be touched.
        if (existed) throw err;
        return caches.delete(WM_CACHE_NAME).then(function () { throw err; });
      });
    })
    // No skipWaiting: the running app keeps its own complete cache until it
    // is closed.
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== WM_CACHE_NAME && k.indexOf('windmark-') === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // nothing off-origin is used

  // Navigations always resolve to this version's cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.open(WM_CACHE_NAME).then(function (cache) {
        return cache.match('index.html').then(function (hit) {
          return hit || fetch(req).catch(function () { return cache.match('./'); });
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.open(WM_CACHE_NAME).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;                       // cache-first, full stop
        return fetch(req).then(function (res) {
          // Anything same-origin but not precached (nothing, today) is cached
          // opportunistically so a second offline launch still has it.
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        });
      });
    })
  );
});
