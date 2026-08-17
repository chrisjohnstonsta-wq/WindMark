/* WindMark — GPS and compass.

   This is the part of the app that must not lie. Everything here either
   produces a value we can defend, or reports that it cannot.

   ======================================================================
   COMPASS BACKGROUND (read before changing anything)
   ======================================================================

   Device orientation gives three Euler angles, applied in the intrinsic
   Z-X'-Y'' order (alpha about z, then beta about x, then gamma about y):

     device frame : x = right edge, y = top edge, z = out of the screen
     earth frame  : X = east,       Y = north,    Z = up            (ENU)

   The rotation matrix that takes a device-frame vector into the earth
   frame is R = Rz(alpha) * Rx(beta) * Ry(gamma):

     [ ca*cg - sa*sb*sg   -sa*cb    ca*sg + sa*sb*cg ]
     [ sa*cg + ca*sb*sg    ca*cb    sa*sg - ca*sb*cg ]
     [        -cb*sg         sb            cb*cg     ]

   The top edge of the phone is (0,1,0) in the device frame, so in the
   earth frame it is the middle column:

     east  component = -sin(alpha) * cos(beta)
     north component =  cos(alpha) * cos(beta)
     up    component =  sin(beta)

   Compass heading of the top edge = atan2(east, north). Note this is
   independent of gamma — gamma is roll about the top-edge axis itself, so
   rolling the phone does not change where its top points. Good. And when
   |beta| > 90 the cos(beta) factor is negative, which flips the horizontal
   projection by 180° — atan2 handles that correctly, because a phone tipped
   past vertical really is pointing its top backwards.

   Flat and level (beta = gamma = 0) this reduces to heading = 360 - alpha,
   the familiar formula.

   Degenerate case: with the top edge near vertical (|beta| near 90) the
   horizontal projection collapses and the heading is garbage. We detect
   that and tell the handler to hold the phone flatter rather than showing
   a confident wrong number.

   iOS is different: Safari exposes `webkitCompassHeading`, an already
   tilt-compensated compass heading for the top edge of the device, and its
   alpha is NOT absolute. When webkitCompassHeading is present we use it
   directly and ignore the matrix.

   WHICH NORTH? This is decided per source, not globally.

     ios      Apple documents webkitCompassHeading as a heading relative to
              MAGNETIC north, so this path is fixed to magnetic and the
              configured declination is always applied. It is deliberately
              NOT user-configurable — see refForSource().
     absolute The W3C spec does not say which north the earth frame uses,
              and Android's fused rotation vector is magnetic in practice.
              We assume magnetic, but leave the assumption configurable so
              the fallback can be settled in the field without a code change.

   Either way the raw platform number is kept for provenance and the TRUE
   bearing is what the app treats as authoritative. The SENSOR PROOF screen
   exists so all of this gets checked against a real Silva compass before
   anyone trusts a log. */

var Compass = (function () {

  var SMOOTH_MS = 500;        // circular-mean window
  var STALE_MS = 2000;        // no events for this long = sensor dropped out
  var FLAT_WARN_DEG = 65;     // |beta| beyond this: top edge too close to vertical

  var state = {
    status: 'idle',           // idle|unsupported|denied|waiting|ok|unreliable|stale
    message: 'Compass not started.',
    source: null,             // 'ios' | 'absolute' | 'relative'
    raw: null,                // heading as the platform reports it, degrees
    smoothed: null,           // circular mean of raw over SMOOTH_MS
    sourceRef: 'magnetic',    // which north `raw`/`smoothed` are in, for THIS source
    refLocked: false,         // true when the source fixes the reference (iOS)
    trueHeading: null,        // smoothed normalised to true
    accuracy: null,           // iOS webkitCompassAccuracy, degrees, or null
    consistency: null,        // 0..1 vector length of the circular mean
    alpha: null, beta: null, gamma: null, absolute: null,
    tiltWarn: false,
    lastEventAt: null,
    eventCount: 0,
    permission: 'unknown'     // unknown|granted|denied|not-required
  };

  var samples = [];           // [{t, deg}] within SMOOTH_MS
  var sawAbsoluteEvent = false;
  var sawIosHeading = false;
  var listening = false;
  var declination = 8;
  var configuredRef = 'magnetic';   // applies to the absolute-orientation fallback only

  function needsPermission() {
    return typeof DeviceOrientationEvent !== 'undefined' &&
           typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  function setConfig(dec, sensorRef) {
    declination = dec;
    configuredRef = (sensorRef === 'true') ? 'true' : 'magnetic';
    recompute();
  }

  /* Which north a given source's numbers are in.
     iOS is pinned to magnetic on Apple's documented behaviour and ignores the
     configured value; the absolute-orientation fallback honours it. Keeping
     this in one function is what makes the behaviour source-specific instead
     of one global assumption applied to every platform. */
  function refForSource(source, configured) {
    if (source === 'ios') return 'magnetic';
    return (configured === 'true') ? 'true' : 'magnetic';
  }

  /* A sensor heading WindMark is willing to write into a log as authoritative.
     Anything short of a clean 'ok' status is refused — uncalibrated, poor
     reported accuracy, excessive tilt, no smoothed heading, stale events, or
     relative-only orientation all fall back to hand entry. */
  function isAuthoritative(st) {
    st = st || state;
    return st.status === 'ok' && st.source !== 'relative' && st.trueHeading !== null;
  }

  function authoritativeTrueHeading(st) {
    st = st || state;
    return isAuthoritative(st) ? st.trueHeading : null;
  }

  /* Heading of the top edge from raw Euler angles. Returns null if the
     angles are missing. See the derivation in the header comment. */
  function headingFromEuler(alpha, beta, gamma) {
    if (alpha === null || alpha === undefined) return null;
    var b = (beta === null || beta === undefined) ? 0 : beta;
    var g = (gamma === null || gamma === undefined) ? 0 : gamma;
    var A = alpha * Math.PI / 180, B = b * Math.PI / 180, G = g * Math.PI / 180;
    var east = -Math.sin(A) * Math.cos(B);
    var north = Math.cos(A) * Math.cos(B);
    if (Math.abs(east) < 1e-12 && Math.abs(north) < 1e-12) return null; // straight up
    return norm360(Math.atan2(east, north) * 180 / Math.PI);
  }

  function pushSample(deg) {
    var now = Date.now();
    samples.push({ t: now, deg: deg });
    while (samples.length && now - samples[0].t > SMOOTH_MS) samples.shift();
  }

  function recompute() {
    var now = Date.now();
    state.sourceRef = refForSource(state.source, configuredRef);
    state.refLocked = (state.source === 'ios');
    while (samples.length && now - samples[0].t > SMOOTH_MS) samples.shift();

    if (!samples.length) {
      state.smoothed = null;
      state.trueHeading = null;
      state.consistency = null;
    } else {
      // Circular mean — arithmetic averaging of bearings is wrong across 0°.
      var m = circularMean(samples.map(function (s) { return { deg: s.deg, w: 1 }; }));
      if (m) {
        state.smoothed = m.deg;
        state.consistency = m.r;
        state.trueHeading = toTrueBearing(m.deg, state.sourceRef, declination);
      } else {
        state.smoothed = null;
        state.trueHeading = null;
        state.consistency = 0;
      }
    }

    if (state.status === 'ok' || state.status === 'unreliable' || state.status === 'stale') {
      if (state.lastEventAt && now - state.lastEventAt > STALE_MS) {
        state.status = 'stale';
        state.message = 'Compass stopped sending data. Use bearing by hand.';
        state.trueHeading = null;
      } else if (state.tiltWarn) {
        state.status = 'unreliable';
        state.message = 'Hold the phone flatter — top edge is nearly vertical.';
      } else if (state.smoothed === null) {
        // Events are still arriving but nothing usable landed in the last
        // SMOOTH_MS. Say so instead of leaving "Compass OK" over a blank
        // bearing.
        state.status = 'unreliable';
        state.message = 'No usable heading right now. Move the phone slightly, or use bearing by hand.';
      } else if (state.accuracy !== null && state.accuracy < 0) {
        state.status = 'unreliable';
        state.message = 'Compass uncalibrated. Figure-8 the phone, or use bearing by hand.';
      } else if (state.source === 'relative') {
        state.status = 'unreliable';
        state.message = 'Phone reports relative orientation only — not a compass. Use bearing by hand.';
      } else if (state.accuracy !== null && state.accuracy > 20) {
        state.status = 'unreliable';
        state.message = 'Compass accuracy ±' + Math.round(state.accuracy) + '° — check against your Silva.';
      } else {
        state.status = 'ok';
        state.message = state.source === 'ios' ? 'Compass OK (iOS heading)'
                                               : 'Compass OK (absolute orientation)';
      }
    }
  }

  function handleEvent(e, kind) {
    var now = Date.now();
    var heading = null, source = null;

    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      // iOS: already tilt-compensated, clockwise from north, top edge of device.
      heading = norm360(e.webkitCompassHeading);
      source = 'ios';
      sawIosHeading = true;
      state.accuracy = (typeof e.webkitCompassAccuracy === 'number') ? e.webkitCompassAccuracy : null;
    } else if (kind === 'absolute' || e.absolute === true) {
      heading = headingFromEuler(e.alpha, e.beta, e.gamma);
      source = 'absolute';
      sawAbsoluteEvent = true;
      state.accuracy = null;
    } else {
      // Relative orientation: alpha has an arbitrary zero. Unusable as a
      // compass. Only report it if nothing better has ever arrived.
      if (sawIosHeading || sawAbsoluteEvent) return;
      heading = headingFromEuler(e.alpha, e.beta, e.gamma);
      source = 'relative';
      state.accuracy = null;
    }

    // Once a real compass source exists, ignore the weaker one.
    if (source === 'absolute' && sawIosHeading) return;
    if (source === 'relative' && (sawIosHeading || sawAbsoluteEvent)) return;

    state.alpha = e.alpha; state.beta = e.beta; state.gamma = e.gamma;
    state.absolute = e.absolute;
    state.source = source;
    state.lastEventAt = now;
    state.eventCount++;

    // Top edge near vertical -> horizontal projection is meaningless.
    state.tiltWarn = (typeof e.beta === 'number') && Math.abs(e.beta) > FLAT_WARN_DEG;

    if (heading === null) {
      state.raw = null;
    } else {
      state.raw = heading;
      if (!state.tiltWarn) pushSample(heading);
    }

    if (state.status === 'waiting' || state.status === 'idle') state.status = 'ok';
    recompute();
  }

  function onAbsolute(e) { handleEvent(e, 'absolute'); }
  function onOrientation(e) { handleEvent(e, 'plain'); }

  function attach() {
    if (listening) return;
    listening = true;
    // Chrome/Android fires deviceorientationabsolute; iOS fires deviceorientation
    // with webkitCompassHeading. Listen to both and prefer the better source.
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', onAbsolute, false);
    }
    window.addEventListener('deviceorientation', onOrientation, false);

    state.status = 'waiting';
    state.message = 'Waiting for compass data…';
    setTimeout(function () {
      if (state.eventCount === 0) {
        state.status = 'unsupported';
        state.message = 'No compass data from this device. Use bearing by hand.';
      }
    }, 2500);
  }

  /* MUST be called from inside a user gesture on iOS. */
  function start() {
    if (typeof DeviceOrientationEvent === 'undefined' && typeof window.ondeviceorientation === 'undefined') {
      state.status = 'unsupported';
      state.message = 'This browser has no orientation sensor API. Use bearing by hand.';
      return Promise.resolve(state);
    }
    if (needsPermission()) {
      return DeviceOrientationEvent.requestPermission().then(function (res) {
        state.permission = res;
        if (res === 'granted') { attach(); }
        else {
          state.status = 'denied';
          state.message = 'Motion & Orientation access denied. Use bearing by hand, or enable it in Settings › Apps › Safari.';
        }
        return state;
      }).catch(function (err) {
        state.permission = 'denied';
        state.status = 'denied';
        state.message = 'Orientation permission failed: ' + (err && err.message ? err.message : err);
        return state;
      });
    }
    state.permission = 'not-required';
    attach();
    return Promise.resolve(state);
  }

  function retry() {
    // Detach and re-attach; also clears a stale/unreliable latch.
    if (listening) {
      if ('ondeviceorientationabsolute' in window) {
        window.removeEventListener('deviceorientationabsolute', onAbsolute, false);
      }
      window.removeEventListener('deviceorientation', onOrientation, false);
      listening = false;
    }
    samples = [];
    sawAbsoluteEvent = false;
    sawIosHeading = false;
    state.eventCount = 0;
    state.status = 'idle';
    state.raw = state.smoothed = state.trueHeading = null;
    return start();
  }

  function tick() { recompute(); return state; }

  return {
    state: state, start: start, retry: retry, tick: tick,
    setConfig: setConfig, needsPermission: needsPermission,
    refForSource: refForSource, isAuthoritative: isAuthoritative,
    authoritativeTrueHeading: authoritativeTrueHeading,
    headingFromEuler: headingFromEuler, SMOOTH_MS: SMOOTH_MS
  };
})();


/* ======================================================================
   GPS
   ======================================================================
   watchPosition with high accuracy, running continuously. We keep the most
   recent fix and never block a capture on accuracy or staleness — a flagged
   observation beats a lost observation. Quality is displayed and stored. */

var Gps = (function () {

  var state = {
    status: 'idle',        // idle|unsupported|waiting|ok|denied|error
    message: 'GPS not started.',
    lat: null, lon: null, acc: null,
    alt: null, altAcc: null,
    fixTime: null,         // epoch ms as reported by the fix
    receivedAt: null,      // epoch ms when we received it
    fixCount: 0
  };

  var watchId = null;

  function onPos(p) {
    state.lat = p.coords.latitude;
    state.lon = p.coords.longitude;
    state.acc = p.coords.accuracy;
    state.alt = p.coords.altitude;
    state.altAcc = p.coords.altitudeAccuracy;
    state.receivedAt = Date.now();

    // Some devices report an odd epoch for position.timestamp. If it is more
    // than a day away from now it is not trustworthy — fall back to arrival.
    var ts = p.timestamp;
    if (typeof ts !== 'number' || !isFinite(ts) || Math.abs(Date.now() - ts) > 86400000) {
      ts = state.receivedAt;
    }
    state.fixTime = ts;
    state.fixCount++;
    state.status = 'ok';
    state.message = 'GPS OK';
  }

  function onErr(err) {
    if (err && err.code === 1) {
      state.status = 'denied';
      state.message = 'Location denied. Marks will save without coordinates.';
    } else if (err && err.code === 3) {
      // Timeout: keep any previous fix, keep waiting.
      if (state.fixCount === 0) {
        state.status = 'waiting';
        state.message = 'Waiting for GPS fix…';
      }
    } else {
      state.status = 'error';
      state.message = 'GPS error: ' + (err && err.message ? err.message : 'unknown');
    }
  }

  function start() {
    if (!navigator.geolocation) {
      state.status = 'unsupported';
      state.message = 'No geolocation on this device. Marks save without coordinates.';
      return;
    }
    if (watchId !== null) return;
    state.status = 'waiting';
    state.message = 'Waiting for GPS fix…';
    watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 30000
    });
  }

  function retry() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    start();
  }

  function ageMs() {
    if (state.fixTime === null) return null;
    return Math.max(0, Date.now() - state.fixTime);
  }

  /* Freeze the freshest fix at mark time. */
  function snapshot() {
    return {
      lat: state.lat, lon: state.lon, acc: state.acc,
      fixTime: state.fixTime, ageMs: ageMs(), status: state.status
    };
  }

  return { state: state, start: start, retry: retry, ageMs: ageMs, snapshot: snapshot };
})();
