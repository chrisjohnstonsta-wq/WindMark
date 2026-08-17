/* WindMark — offline readiness and the pre-search check.

   A SAR search happens with no cell service, no Wi-Fi, and often airplane
   mode. "Offline ready" therefore has to mean something stronger than
   navigator.onLine, which only reports whether a network interface is up and
   says nothing about whether this phone can actually launch WindMark without
   one.

   Here it means, specifically:

     1. this browser can cache at all (Cache Storage + service workers), and
     2. the cache named for THIS app version exists, and
     3. every file in WM_ASSETS is present in it, and
     4. a service worker is controlling the page right now.

   Because the cache name carries the version, a half-installed update can
   never masquerade as ready: v1.3.0 asks for the v1.3.0 cache, and until that
   cache is complete the answer is no — while the previously installed version
   keeps working from its own cache.

   The decision itself is a pure function (evaluate) so it can be tested
   without a browser; check() only gathers the facts. */

var Offline = (function () {

  var state = {
    ready: false,
    checked: false,
    title: 'OFFLINE NOT READY',
    detail: 'Connect once before deployment',
    reason: 'unknown',
    hint: 'Not checked yet.',
    missing: [],
    controlled: false,
    persisted: null,          // navigator.storage.persisted(), or null if unsupported
    checkedAt: null
  };

  /* facts in, verdict out. No I/O, no globals.
       supported   — Cache Storage + service worker API present
       cacheExists — a cache named WM_CACHE_NAME exists
       missing     — asset paths absent from that cache
       controlled  — navigator.serviceWorker.controller is set
       version     — the running app version, for the message           */
  function evaluate(f) {
    var version = f.version || WM_VERSION;

    if (!f.supported) {
      return {
        ready: false, reason: 'unsupported',
        title: 'OFFLINE NOT READY',
        detail: 'Connect once before deployment',
        hint: 'This browser cannot store the app for offline use. On iPhone use Safari, and add WindMark to the Home Screen.'
      };
    }
    if (!f.cacheExists) {
      return {
        ready: false, reason: 'no-cache',
        title: 'OFFLINE NOT READY',
        detail: 'Connect once before deployment',
        hint: 'WindMark v' + version + ' has not been stored on this phone yet. Open it once with a connection.'
      };
    }
    if (f.missing && f.missing.length) {
      return {
        ready: false, reason: 'incomplete',
        title: 'OFFLINE NOT READY',
        detail: 'Connect once before deployment',
        hint: 'v' + version + ' is only partly stored (' + f.missing.length + ' file' +
              (f.missing.length === 1 ? '' : 's') + ' missing). Reconnect and reopen to finish.'
      };
    }
    if (!f.controlled) {
      return {
        ready: false, reason: 'not-controlled',
        title: 'OFFLINE NOT READY',
        detail: 'Connect once before deployment',
        hint: 'v' + version + ' is stored but not yet in charge of the app. Close WindMark completely and reopen it once.'
      };
    }
    // The browser's own network flag is deliberately not consulted: having no
    // connection is the expected state in the field, not a failure.
    return {
      ready: true, reason: 'ok',
      title: 'OFFLINE READY ✓',
      detail: 'WindMark v' + version + ' cached locally',
      hint: 'All app files are on this phone. It will cold-start in airplane mode.'
    };
  }

  /* Gather the facts and evaluate. Always resolves; never throws. */
  function check() {
    var supported = (typeof caches !== 'undefined') && ('serviceWorker' in navigator);
    var controlled = supported && !!navigator.serviceWorker.controller;

    if (!supported) return Promise.resolve(apply(evaluate({ supported: false }), []));

    return caches.has(WM_CACHE_NAME).then(function (exists) {
      if (!exists) return apply(evaluate({ supported: true, cacheExists: false, controlled: controlled }), []);

      return caches.open(WM_CACHE_NAME).then(function (cache) {
        // ignoreSearch so a cache-busting query string never reads as missing.
        return Promise.all(WM_ASSETS.map(function (a) {
          return cache.match(a, { ignoreSearch: true }).then(function (hit) {
            return hit ? null : a;
          }).catch(function () { return a; });
        }));
      }).then(function (results) {
        var missing = results.filter(function (r) { return r !== null; });
        return apply(evaluate({
          supported: true, cacheExists: true, missing: missing, controlled: controlled
        }), missing);
      });
    }).catch(function (e) {
      return apply({
        ready: false, reason: 'error',
        title: 'OFFLINE NOT READY',
        detail: 'Connect once before deployment',
        hint: 'Could not read the app cache: ' + (e && e.message ? e.message : e)
      }, []);
    });
  }

  function apply(verdict, missing) {
    state.ready = verdict.ready;
    state.reason = verdict.reason;
    state.title = verdict.title;
    state.detail = verdict.detail;
    state.hint = verdict.hint;
    state.missing = missing || [];
    state.controlled = (typeof navigator !== 'undefined' && navigator.serviceWorker)
      ? !!navigator.serviceWorker.controller : false;
    state.checked = true;
    state.checkedAt = Date.now();
    return state;
  }

  /* ---------- persistent storage (progressive enhancement only) ----------
     Chrome grants this silently to installed PWAs; Safari does not implement
     it at all. Asked for at most once, never blocking, never depended on. */

  function requestPersistence(alreadyAsked, onDone) {
    if (!navigator.storage || !navigator.storage.persist) {
      state.persisted = null;
      if (onDone) onDone(null, false);
      return;
    }
    navigator.storage.persisted().then(function (already) {
      state.persisted = already;
      if (already || alreadyAsked) { if (onDone) onDone(already, false); return; }
      navigator.storage.persist().then(function (granted) {
        state.persisted = granted;
        if (onDone) onDone(granted, true);
      }).catch(function () { if (onDone) onDone(state.persisted, true); });
    }).catch(function () {
      state.persisted = null;
      if (onDone) onDone(null, false);
    });
  }

  function persistenceText() {
    if (state.persisted === null) return 'not supported by this browser';
    return state.persisted ? 'granted — the browser is less likely to evict local data'
                           : 'not granted — export CSV regularly, as always';
  }

  /* ---------- pre-search check ------------------------------------------

     Informational only. Nothing here blocks a capture, and a warn state is
     never a reason not to search — a warned compass just means a hand compass and
     hand entry do the work. Pure function, so the wording is testable.

       offlineReady  — Offline.state.ready
       storageError  — Store.selfTest(), null when storage works
       gps           — {supported, status, hasFix}
       compass       — {status}                                            */
  function preSearchChecks(f) {
    var out = [];

    out.push({
      key: 'offline',
      label: 'Offline ready',
      state: f.offlineReady ? 'pass' : 'warn',
      detail: f.offlineReady ? 'app cached locally' : 'connect once before deployment'
    });

    out.push({
      key: 'storage',
      label: 'Storage available',
      state: f.storageError ? 'warn' : 'pass',
      detail: f.storageError ? f.storageError : 'observations will persist on this phone'
    });

    var gps = f.gps || {};
    var gpsOk = !!gps.supported && (gps.hasFix || gps.status === 'waiting');
    out.push({
      key: 'gps',
      label: 'GPS available',
      state: gpsOk ? 'pass' : 'warn',
      // Indoors there is often no fix yet. That is not a failure: waiting for
      // one still counts as available.
      detail: !gps.supported ? 'no geolocation on this device — marks save without coordinates'
        : gps.hasFix ? 'fix acquired'
        : gps.status === 'waiting' ? 'waiting for first fix — normal indoors'
        : gps.status === 'denied' ? 'location denied — marks save without coordinates'
        : 'no fix and not searching — check location permission'
    });

    var compassOk = f.compass && f.compass.status === 'ok';
    out.push({
      key: 'compass',
      label: compassOk ? 'Compass available' : 'COMPASS NOT READY — manual bearing remains available',
      state: compassOk ? 'pass' : 'warn',
      detail: compassOk ? 'sensor heading usable' : (f.compass && f.compass.message) || 'sensor heading unusable'
    });

    return out;
  }

  return {
    state: state,
    evaluate: evaluate,
    check: check,
    preSearchChecks: preSearchChecks,
    requestPersistence: requestPersistence,
    persistenceText: persistenceText
  };
})();
