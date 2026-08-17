/* WindMark math self-check.  Run: node tools/selfcheck.js
   Plain node, no dependencies, no test framework. It checks the arithmetic
   that acceptance criteria 5-11 depend on — wraparound, circular averaging,
   declination, and the downwind/from convention. It cannot check the
   physical sensor: that still needs a Silva compass and a walk outside. */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.dirname(__dirname);

/* Minimal localStorage so store.js can be exercised outside a browser. */
var mem = {};
var fakeStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
  setItem: function (k, v) { mem[k] = String(v); },
  removeItem: function (k) { delete mem[k]; }
};

/* A window stub that records listeners, so the compass can be driven with
   synthetic orientation events exactly as a browser would deliver them. */
var listeners = {};
var fakeWindow = {
  addEventListener: function (type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
  },
  removeEventListener: function (type, fn) {
    listeners[type] = (listeners[type] || []).filter(function (f) { return f !== fn; });
  },
  crypto: undefined,
  // Present so sensors.js attaches the absolute-orientation listener, the
  // same feature-detect a Chrome/Android browser passes.
  ondeviceorientationabsolute: null
};

var sandbox = {
  window: fakeWindow,
  navigator: {},
  document: { addEventListener: function () {} },
  localStorage: fakeStorage,
  setTimeout: function () { return 0; },
  clearTimeout: function () {},
  // Present but with no requestPermission: the non-iOS-gesture path.
  DeviceOrientationEvent: function () {},
  console: console
};
sandbox.self = sandbox;
vm.createContext(sandbox);
['js/assets.js', 'js/util.js', 'js/store.js', 'js/sensors.js', 'js/offline.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
});

var fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; return; }
  fails++;
  console.log('FAIL: ' + name + (extra === undefined ? '' : '  [' + extra + ']'));
}
function near(name, got, want, tol) {
  var d = Math.abs(sandbox.angleDiff(got, want));
  ok(name + ' (got ' + (got === null ? 'null' : got.toFixed(2)) + ', want ' + want + ')', d <= (tol || 0.5), 'diff ' + d.toFixed(2));
}

var S = sandbox;

/* --- wraparound -------------------------------------------------------- */
ok('norm360(-1) = 359', S.norm360(-1) === 359);
ok('norm360(361) = 1', S.norm360(361) === 1);
ok('norm360(360) = 0', S.norm360(360) === 0);
ok('norm360(-370) = 350', S.norm360(-370) === 350);

/* --- downwind / from convention ---------------------------------------- */
ok('from(104) = 284', S.reciprocal(104) === 284);
ok('from(284) = 104', S.reciprocal(284) === 104);
ok('from(0) = 180', S.reciprocal(0) === 180);
ok('from(180) = 0', S.reciprocal(180) === 0);
ok('from(350) = 170', S.reciprocal(350) === 170);
ok('double reciprocal is identity', S.reciprocal(S.reciprocal(37)) === 37);

/* --- circular mean across the 0/360 seam -------------------------------- */
var m = S.circularMean([358, 359, 0, 1, 2].map(function (d) { return { deg: d }; }));
near('circular mean of 358..2 is 0', m.deg, 0, 0.5);
ok('circular mean is not the arithmetic 144', Math.abs(S.angleDiff(m.deg, 144)) > 100);
ok('circular mean consistency ~1', m.r > 0.99);
near('circular mean of 350,10 is 0', S.circularMean([{ deg: 350 }, { deg: 10 }]).deg, 0, 0.5);
near('circular mean of 89,91 is 90', S.circularMean([{ deg: 89 }, { deg: 91 }]).deg, 90, 0.5);
ok('opposed samples give no mean', S.circularMean([{ deg: 0 }, { deg: 180 }]) === null);

/* --- declination -------------------------------------------------------- */
near('magnetic 97 + 8E = 105 true', S.toTrueBearing(97, 'magnetic', 8), 105);
near('magnetic 355 + 8E wraps to 3', S.toTrueBearing(355, 'magnetic', 8), 3);
near('magnetic 2 - 8W wraps to 354', S.toTrueBearing(2, 'magnetic', -8), 354);
near('true reading is NOT corrected again', S.toTrueBearing(105, 'true', 8), 105);
ok('null reading stays null', S.toTrueBearing(null, 'magnetic', 8) === null);

/* --- heading from Euler angles ------------------------------------------
   Flat and level, heading of the top edge = 360 - alpha.                  */
var h = S.Compass.headingFromEuler;
near('alpha 0 flat -> 0', h(0, 0, 0), 0);
near('alpha 90 flat -> 270', h(90, 0, 0), 270);
near('alpha 270 flat -> 90', h(270, 0, 0), 90);
near('alpha 1 flat -> 359', h(1, 0, 0), 359);
near('alpha 359 flat -> 1', h(359, 0, 0), 1);
/* Gamma is roll about the top-edge axis: it must not move the heading. */
near('gamma 45 does not change heading', h(30, 0, 45), 330);
near('gamma -80 does not change heading', h(30, 0, -80), 330);
/* Modest tilt of the top edge keeps the same horizontal direction. */
near('beta 30 keeps heading', h(30, 30, 0), 330);
near('beta -30 keeps heading', h(30, -30, 0), 330);
/* Tipped past vertical, the top edge really does point the other way. */
near('beta 120 flips heading', h(30, 120, 0), 150);

/* --- full chain: point the phone, log the wind --------------------------- */
function observe(rawHeading, ref, dec) {
  var t = Math.round(S.toTrueBearing(rawHeading, ref, dec)) % 360;
  return { downwind_true: t, from_true: S.reciprocal(t) };
}
var o = observe(97, 'magnetic', 8);
ok('sensor 97M/+8 -> downwind 105T', o.downwind_true === 105);
ok('sensor 97M/+8 -> from 285T', o.from_true === 285);
var o2 = observe(276, 'magnetic', 8);
ok('manual magnetic 276/+8 -> downwind 284T', o2.downwind_true === 284);
ok('manual magnetic 276/+8 -> from 104T', o2.from_true === 104);
var o3 = observe(284, 'true', 8);
ok('manual true 284 -> downwind 284T (no double correction)', o3.downwind_true === 284);
ok('manual true 284 -> from 104T', o3.from_true === 104);

/* --- formatting ---------------------------------------------------------- */
ok('deg3(7) = 007', S.deg3(7) === '007');
ok('deg3(360) = 000', S.deg3(360) === '000');
ok('deg3(359.6) = 000', S.deg3(359.6) === '000');
ok('deg3(null) = ---', S.deg3(null) === '---');
ok('decText(+8) reads DEC +8°E', S.decText(8) === 'DEC +8°E');
ok('decText(-13) reads west', S.decText(-13).indexOf('W') > 0);

/* --- every displayed bearing carries its reference ------------------------ */
ok('bearingText(284, true) = 284°T', S.bearingText(284, 'true') === '284°T');
ok('bearingText(276, magnetic) = 276°M', S.bearingText(276, 'magnetic') === '276°M');
ok('bearingText(7, true) = 007°T', S.bearingText(7, 'true') === '007°T');
ok('bearingText(null, true) = ---°T', S.bearingText(null, 'true') === '---°T');
ok('unknown reference falls back to true', S.bearingText(10, undefined) === '010°T');
ok('refWord(magnetic) = MAGNETIC', S.refWord('magnetic') === 'MAGNETIC');
ok('refWord(true) = TRUE', S.refWord('true') === 'TRUE');

/* --- exports: operational files are true-only ----------------------------- */
var rec = {
  schema_version: 1, id: 'obs-1', session_id: 'ses-1', session_name: 'Drainage, north',
  t: '2026-08-16T20:32:05-06:00', lat: 39.8, lon: -105.2, acc_m: 6,
  gps_fix_t: '2026-08-16T20:32:04-06:00', gps_fix_age_s: 1.2,
  downwind_true: 105, from_true: 285, heading_magnetic_raw: 97,
  declination: 8, declination_applied: true, bearing_source: 'manual',
  bearing_input_ref: 'magnetic', intensity: 'moderate', speed_mph: null,
  speed_source: 'estimated', gusty: false, note: 'ridge "spine", swirling',
  app_version: '1.0.0'
};
var opHead = S.Store.toCSV([rec]).split('\r\n')[0].split(',');
var opRow = S.Store.toCSV([rec]).split('\r\n')[1];

ok('operational header names the true bearing columns',
  opHead.indexOf('wind_from_deg_true') >= 0 && opHead.indexOf('wind_toward_deg_true') >= 0);
ok('operational header mentions no magnetic column',
  opHead.filter(function (h) { return /magnetic|_deg_m$|raw/.test(h); }).length === 0, opHead.join('|'));
ok('operational header has no unqualified bearing column',
  opHead.indexOf('downwind_true') < 0 && opHead.indexOf('from_true') < 0 &&
  opHead.indexOf('heading_magnetic_raw') < 0);
ok('operational row carries the true bearings',
  opRow.split(',').indexOf('285') >= 0 && opRow.split(',').indexOf('105') >= 0);
ok('operational row does not carry the raw magnetic value',
  opRow.indexOf(',97,') < 0 && opRow.split(',').indexOf('97') < 0, opRow);
ok('csv quotes a note containing a comma and quotes',
  opRow.indexOf('"ridge ""spine"", swirling"') > 0, opRow);

// Plain note here so the row can be split on commas without a CSV parser.
var recPlain = {}; for (var k in rec) recPlain[k] = rec[k]; recPlain.note = 'swirling'; recPlain.session_name = 'Drainage';
var prHead = S.Store.toProvenanceCSV([recPlain]).split('\r\n')[0].split(',');
var prRow = S.Store.toProvenanceCSV([recPlain]).split('\r\n')[1].split(',');
ok('provenance keeps every operational column',
  opHead.every(function (h) { return prHead.indexOf(h) >= 0; }));
ok('provenance adds the raw magnetic reading, explicitly named',
  prHead.indexOf('raw_input_deg_magnetic') >= 0);
ok('provenance carries the raw magnetic value',
  prRow[prHead.indexOf('raw_input_deg_magnetic')] === '97');
ok('provenance records the input reference and declination',
  prRow[prHead.indexOf('input_reference')] === 'magnetic' &&
  prRow[prHead.indexOf('declination_deg_east')] === '8' &&
  prRow[prHead.indexOf('declination_applied')] === 'true');

/* A no-wind observation exports blank bearings, never a zero. */
var none = { intensity: 'none', downwind_true: null, from_true: null, id: 'obs-2' };
var noneRow = S.Store.toCSV([none]).split('\r\n')[1].split(',');
ok('no-wind exports empty true bearings',
  noneRow[opHead.indexOf('wind_from_deg_true')] === '' &&
  noneRow[opHead.indexOf('wind_toward_deg_true')] === '');

/* --- compass: the iOS path is magnetic, full stop ------------------------- */
function fireOrientation(props) {
  (listeners['deviceorientation'] || []).forEach(function (h) { h(props); });
}
function fireAbsolute(props) {
  (listeners['deviceorientationabsolute'] || []).forEach(function (h) { h(props); });
}

S.Compass.start();                       // attaches listeners in the stub window

// Configure the *fallback* reference to TRUE — iOS must ignore it entirely.
S.Compass.setConfig(8, 'true');
fireOrientation({ webkitCompassHeading: 97, webkitCompassAccuracy: 12, alpha: 20, beta: 5, gamma: 0 });
var cs = S.Compass.tick();
ok('webkitCompassHeading is detected as the iOS source', cs.source === 'ios', cs.source);
ok('iOS heading is treated as MAGNETIC even when the fallback is set to TRUE',
  cs.sourceRef === 'magnetic', cs.sourceRef);
ok('iOS reference is marked as locked', cs.refLocked === true);
near('iOS 97°M + 8°E declination = 105°T', cs.trueHeading, 105);
near('raw magnetic value is kept for provenance', cs.smoothed, 97);
ok('refForSource pins ios to magnetic whatever is configured',
  S.Compass.refForSource('ios', 'true') === 'magnetic' &&
  S.Compass.refForSource('ios', 'magnetic') === 'magnetic');
ok('refForSource honours the setting for the absolute fallback',
  S.Compass.refForSource('absolute', 'true') === 'true' &&
  S.Compass.refForSource('absolute', 'magnetic') === 'magnetic');
ok('a clean iOS fix is authoritative', S.Compass.isAuthoritative(cs) === true, cs.status);

/* --- only status 'ok' may be saved as a sensor bearing --------------------- */
fireOrientation({ webkitCompassHeading: 97, webkitCompassAccuracy: -1, alpha: 20, beta: 5, gamma: 0 });
cs = S.Compass.tick();
ok('uncalibrated compass (accuracy -1) is not ok', cs.status === 'unreliable', cs.status);
ok('uncalibrated compass yields no authoritative heading',
  S.Compass.authoritativeTrueHeading(cs) === null);

fireOrientation({ webkitCompassHeading: 97, webkitCompassAccuracy: 35, alpha: 20, beta: 5, gamma: 0 });
cs = S.Compass.tick();
ok('poor reported accuracy is not ok', cs.status === 'unreliable', cs.status);
ok('poor reported accuracy yields no authoritative heading',
  S.Compass.authoritativeTrueHeading(cs) === null);

fireOrientation({ webkitCompassHeading: 97, webkitCompassAccuracy: 5, alpha: 20, beta: 88, gamma: 0 });
cs = S.Compass.tick();
ok('excessive tilt is not ok', cs.status === 'unreliable', cs.status);
ok('excessive tilt yields no authoritative heading',
  S.Compass.authoritativeTrueHeading(cs) === null);

['idle', 'waiting', 'unsupported', 'denied', 'unreliable', 'stale'].forEach(function (st) {
  ok('status "' + st + '" is never authoritative',
    S.Compass.isAuthoritative({ status: st, source: 'ios', trueHeading: 105 }) === false);
});
ok('status "ok" with a heading is authoritative',
  S.Compass.isAuthoritative({ status: 'ok', source: 'ios', trueHeading: 105 }) === true);

/* --- relative-only orientation stays unusable ----------------------------- */
S.Compass.retry();
S.Compass.setConfig(8, 'magnetic');
fireOrientation({ alpha: 263, beta: 0, gamma: 0, absolute: false });
cs = S.Compass.tick();
ok('relative orientation is recognised as relative', cs.source === 'relative', cs.source);
ok('relative orientation is never authoritative',
  S.Compass.authoritativeTrueHeading(cs) === null && !S.Compass.isAuthoritative(cs));

/* --- absolute fallback still works, honouring the setting ------------------ */
S.Compass.retry();
S.Compass.setConfig(8, 'magnetic');
fireAbsolute({ alpha: 263, beta: 0, gamma: 0, absolute: true });
cs = S.Compass.tick();
ok('absolute orientation is usable', cs.source === 'absolute' && S.Compass.isAuthoritative(cs), cs.status);
near('absolute 097°M + 8°E = 105°T', cs.trueHeading, 105);
S.Compass.setConfig(8, 'true');
cs = S.Compass.tick();
near('absolute fallback set to TRUE applies no correction', cs.trueHeading, 97);
S.Compass.setConfig(8, 'magnetic');

/* --- the bearing / intensity invariant ------------------------------------ */
function freshRecord(over) {
  var r = {
    schema_version: 1, id: 'inv-' + (freshRecord.n = (freshRecord.n || 0) + 1),
    session_id: 'ses-inv', session_name: 'Invariant', t: '2026-08-16T20:00:00-06:00',
    lat: null, lon: null, acc_m: null, gps_fix_t: null, gps_fix_age_s: null,
    downwind_true: 105, from_true: 285, heading_magnetic_raw: 97,
    declination: 8, declination_applied: true, bearing_source: 'sensor',
    bearing_input_ref: 'magnetic', intensity: 'moderate', speed_mph: null,
    speed_source: 'estimated', gusty: false, note: '', app_version: 'test'
  };
  for (var k in (over || {})) r[k] = over[k];
  return r;
}

ok('a valid directional record passes validation',
  S.Store.validateObservation(freshRecord()) === null);
ok('directional record with no bearing is rejected',
  S.Store.validateObservation(freshRecord({ downwind_true: null, from_true: null })) !== null);
ok('from_true must be the reciprocal of downwind_true',
  S.Store.validateObservation(freshRecord({ from_true: 100 })) !== null);
ok('no-discernible-wind with a leftover bearing is rejected',
  S.Store.validateObservation(freshRecord({ intensity: 'none' })) !== null);
var cleanNone = freshRecord({ intensity: 'none' });
var nulls = S.Store.noDirectionFields();
for (var nk in nulls) cleanNone[nk] = nulls[nk];
ok('no-discernible-wind with everything cleared passes',
  S.Store.validateObservation(cleanNone) === null);
ok('unknown intensity is rejected',
  S.Store.validateObservation(freshRecord({ intensity: 'breezy' })) !== null);

/* Storage refuses to persist a contradiction, on capture and on edit alike. */
mem = {}; // fresh store
var ses = S.Store.newSession('Search 1').session;

var dirRec = freshRecord({ id: 'obs-dir', session_id: ses.id, session_name: 'Search 1' });
ok('a directional observation saves', S.Store.addObservation(dirRec) === null);

var noneRec = freshRecord({ id: 'obs-none', session_id: ses.id, intensity: 'none' });
ok('addObservation refuses no-discernible-wind carrying a bearing',
  S.Store.addObservation(noneRec) !== null);
for (var nk2 in nulls) noneRec[nk2] = nulls[nk2];
ok('addObservation accepts no-discernible-wind with no bearing at all',
  S.Store.addObservation(noneRec) === null);

ok('editing moderate -> none without clearing direction is refused',
  S.Store.updateObservation('obs-dir', { intensity: 'none' }) !== null);
var clearPatch = { intensity: 'none' };
for (var nk3 in nulls) clearPatch[nk3] = nulls[nk3];
ok('editing moderate -> none with the clearing patch succeeds',
  S.Store.updateObservation('obs-dir', clearPatch) === null);
var afterClear = S.Store.getObservation('obs-dir');
ok('moderate -> none clears every direction and provenance field',
  afterClear.downwind_true === null && afterClear.from_true === null &&
  afterClear.heading_magnetic_raw === null && afterClear.bearing_source === null &&
  afterClear.bearing_input_ref === null && afterClear.declination_applied === false);

ok('editing none -> moderate without a bearing is refused',
  S.Store.updateObservation('obs-none', { intensity: 'moderate' }) !== null);
ok('editing none -> moderate with a bearing in the same write succeeds',
  S.Store.updateObservation('obs-none', {
    intensity: 'moderate', downwind_true: 284, from_true: 104,
    heading_magnetic_raw: 276, bearing_source: 'manual',
    bearing_input_ref: 'magnetic', declination_applied: true
  }) === null);
ok('attaching a bearing alone to a none observation is refused',
  S.Store.updateObservation('obs-dir', { downwind_true: 10, from_true: 190 }) !== null);

/* --- session rename shows up in the next export --------------------------- */
mem = {};
var ses2 = S.Store.newSession('Search 1').session;
S.Store.addObservation(freshRecord({ id: 'obs-ren', session_id: ses2.id, session_name: 'Search 1' }));
var csvBefore = S.Store.toCSV(S.Store.getObservations(ses2.id));
ok('export shows the original search name', csvBefore.indexOf('Search 1') > 0);
S.Store.renameSession(ses2.id, 'Drainage Sweep');
var csvAfter = S.Store.toCSV(S.Store.getObservations(ses2.id));
ok('export follows the renamed search', csvAfter.indexOf('Drainage Sweep') > 0, csvAfter.split('\r\n')[1]);
ok('stored observation keeps its capture-time name for provenance',
  S.Store.getObservation('obs-ren').session_name === 'Search 1');
var orphan = freshRecord({ id: 'obs-orphan', session_id: 'gone', session_name: 'Old Search' });
S.Store.addObservation(orphan);
ok('an observation whose search is gone falls back to the stored name',
  S.Store.toCSV([S.Store.getObservation('obs-orphan')]).indexOf('Old Search') > 0);

/* --- wording: "No discernible wind", never "no wind" ----------------------- */
ok('intensity label is NO DISCERNIBLE WIND', S.INTENSITY_LABEL.none === 'NO DISCERNIBLE WIND');
['index.html', 'js/app.js', 'js/util.js', 'js/store.js', 'js/sensors.js', 'README.md'].forEach(function (f) {
  var text = fs.readFileSync(path.join(root, f), 'utf8');
  var hits = text.match(/\bno wind\b/gi);
  ok('no "no wind" shorthand in ' + f, !hits, hits ? hits.join(', ') : '');
});

/* --- manual entry rejects out-of-range values ------------------------------ */
ok('manual 0 is accepted', S.parseManualBearing('0') === 0);
ok('manual 284 is accepted', S.parseManualBearing('284') === 284);
ok('manual 360 normalises to 0', S.parseManualBearing('360') === 0);
ok('manual 359.5 is accepted', S.parseManualBearing('359.5') === 359.5);
ok('manual -1 is rejected', S.parseManualBearing('-1') === null);
ok('manual 361 is rejected', S.parseManualBearing('361') === null);
ok('manual 999 is rejected, not wrapped to 279', S.parseManualBearing('999') === null);
ok('manual empty is rejected', S.parseManualBearing('') === null);
ok('manual junk is rejected', S.parseManualBearing('28x') === null);
ok('rejection message names the range', /000.*360/.test(S.MANUAL_RANGE_MESSAGE), S.MANUAL_RANGE_MESSAGE);

/* --- manual M/T paths still do not double-correct -------------------------- */
near('manual 276°M with +8°E becomes 284°T', S.toTrueBearing(276, 'magnetic', 8), 284);
near('manual 284°T stays 284°T', S.toTrueBearing(284, 'true', 8), 284);
ok('manual 360°M normalises then corrects to 008°T',
  Math.round(S.toTrueBearing(S.parseManualBearing('360'), 'magnetic', 8)) === 8);

/* --- sessions have no ended state ----------------------------------------- */
ok('Store exposes no endSession', S.Store.endSession === undefined);
ok('a new search carries no ended field',
  !('ended' in S.Store.newSession('Search x').session));

/* --- offline readiness ------------------------------------------------------
   The verdict is a pure function of four facts, so it can be checked here
   without a browser. The browser-level half (real Cache Storage, a real
   service worker, a real airplane-mode cold start) lives in
   tools/browsercheck.js. */

var ready = S.Offline.evaluate({
  supported: true, cacheExists: true, missing: [], controlled: true, version: '9.9.9'
});
ok('complete cache + controlling worker = OFFLINE READY', ready.ready === true);
ok('ready title is exactly "OFFLINE READY ✓"', ready.title === 'OFFLINE READY ✓', ready.title);
ok('ready detail names the version', ready.detail === 'WindMark v9.9.9 cached locally', ready.detail);

var noCache = S.Offline.evaluate({ supported: true, cacheExists: false, controlled: true, version: '9.9.9' });
ok('no cache for this version = NOT READY', noCache.ready === false && noCache.reason === 'no-cache');
ok('not-ready title is exactly "OFFLINE NOT READY"', noCache.title === 'OFFLINE NOT READY', noCache.title);
ok('not-ready detail is exactly "Connect once before deployment"',
  noCache.detail === 'Connect once before deployment', noCache.detail);
ok('no-cache hint names the version that is missing', /9\.9\.9/.test(noCache.hint), noCache.hint);

var partial = S.Offline.evaluate({
  supported: true, cacheExists: true, missing: ['js/app.js', 'css/windmark.css'],
  controlled: true, version: '9.9.9'
});
ok('incomplete cache = NOT READY', partial.ready === false && partial.reason === 'incomplete');
ok('incomplete hint counts the missing files', /2 files missing/.test(partial.hint), partial.hint);

var uncontrolled = S.Offline.evaluate({
  supported: true, cacheExists: true, missing: [], controlled: false, version: '9.9.9'
});
ok('cached but not controlling = NOT READY', uncontrolled.ready === false && uncontrolled.reason === 'not-controlled');
ok('uncontrolled hint says to reopen', /reopen/i.test(uncontrolled.hint), uncontrolled.hint);

ok('no cache API at all = NOT READY',
  S.Offline.evaluate({ supported: false }).reason === 'unsupported');

/* Being offline is the expected field state, never a failure by itself. */
var offlineButCached = S.Offline.evaluate({
  supported: true, cacheExists: true, missing: [], controlled: true, online: false
});
ok('navigator.onLine === false does not make it NOT READY', offlineButCached.ready === true);
var onlineButUncached = S.Offline.evaluate({
  supported: true, cacheExists: false, controlled: true, online: true
});
ok('being online does not make an uncached app READY', onlineButUncached.ready === false);
ok('the readiness verdict never consults navigator.onLine',
  S.Offline.evaluate.toString().indexOf('onLine') < 0);

/* A new version must not inherit the old version's readiness. */
ok('cache name carries the version', S.WM_CACHE_NAME === 'windmark-v' + S.WM_VERSION);
ok('a different version asks for a different cache',
  ('windmark-v' + S.WM_VERSION + '.1') !== S.WM_CACHE_NAME);

/* --- the asset manifest matches what is on disk ---------------------------- */
S.WM_ASSETS.forEach(function (a) {
  if (a === './') return;
  ok('cached asset exists on disk: ' + a, fs.existsSync(path.join(root, a)));
});
(function () {
  // Every script the page loads must be in the cache list, or an offline
  // cold start would 404 on it.
  var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  var srcs = (html.match(/src="([^"]+)"/g) || []).map(function (m) { return m.slice(5, -1); });
  srcs.concat(['css/windmark.css', 'manifest.webmanifest']).forEach(function (f) {
    ok('page asset is precached: ' + f, S.WM_ASSETS.indexOf(f) >= 0);
  });
})();
(function () {
  var sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  ok('service worker imports the shared manifest', /importScripts\('js\/assets\.js'\)/.test(sw));
  ok('service worker caches WM_ASSETS under WM_CACHE_NAME',
    /cache\.addAll\(WM_ASSETS\)/.test(sw) && /caches\.open\(WM_CACHE_NAME\)/.test(sw));
  ok('service worker does not skipWaiting past a running search',
    !/self\.skipWaiting\s*\(/.test(sw));
  ok('service worker deletes only its own old caches', /indexOf\('windmark-'\) === 0/.test(sw));
  // A cache hit must be returned as-is: no fetch(), no cache.put() on that path.
  ok('service worker never background-refreshes a cached asset',
    /if \(hit\) return hit;/.test(sw));
  ok('service worker ignores off-origin requests', /url\.origin !== self\.location\.origin/.test(sw));
  // A failed install cleans up only the cache it created — never one that was
  // already there, which would be the running version's.
  ok('a failed install only deletes a cache it created itself',
    /if \(existed\) throw err;/.test(sw) && /caches\.has\(WM_CACHE_NAME\)/.test(sw));
})();

/* --- no third-party origins anywhere in the app ---------------------------- */
['index.html', 'js/app.js', 'js/util.js', 'js/store.js', 'js/sensors.js', 'js/offline.js',
 'js/assets.js', 'sw.js', 'css/windmark.css', 'manifest.webmanifest'].forEach(function (f) {
  var text = fs.readFileSync(path.join(root, f), 'utf8');
  var urls = text.match(/https?:\/\/[^\s"'`)]+/g) || [];
  // Only comments/documentation may mention a URL; nothing may be fetched.
  var loaded = (text.match(/(src|href)="https?:[^"]*"/g) || []);
  ok('no remote asset loaded in ' + f, loaded.length === 0, loaded.join(', '));
  var apiCalls = text.match(/(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(\s*['"`]https?:/g) || [];
  ok('no third-party request in ' + f, apiCalls.length === 0, apiCalls.join(', '));
  if (urls.length) {
    // Documentation links are fine; make sure each one is in a comment line.
    var bad = text.split('\n').filter(function (line) {
      return /https?:\/\//.test(line) && !/^\s*(\*|\/\/|\/\*|<!--|#)/.test(line) &&
             !/^\s*[a-z-]+:\s*$/.test(line);
    });
    ok('any URL in ' + f + ' is only documentation', bad.length === 0, bad.join(' | ').slice(0, 120));
  }
});

/* --- pre-search check ------------------------------------------------------- */
function checkFor(input) {
  var rows = S.Offline.preSearchChecks(input);
  var by = {};
  rows.forEach(function (r) { by[r.key] = r; });
  return by;
}

var allGood = checkFor({
  offlineReady: true, storageError: null,
  gps: { supported: true, status: 'ok', hasFix: true },
  compass: { status: 'ok' }
});
ok('all four checks are reported', Object.keys(allGood).length === 4);
ok('offline pass', allGood.offline.state === 'pass');
ok('storage pass', allGood.storage.state === 'pass');
ok('gps pass with a fix', allGood.gps.state === 'pass');
ok('compass pass when status is ok', allGood.compass.state === 'pass');
ok('compass label is plain when ready', allGood.compass.label === 'Compass available');

/* Waiting for a first fix indoors is not a failure. */
var waiting = checkFor({
  offlineReady: true, storageError: null,
  gps: { supported: true, status: 'waiting', hasFix: false },
  compass: { status: 'ok' }
});
ok('gps still passes while waiting for a first fix', waiting.gps.state === 'pass', waiting.gps.detail);
ok('waiting detail says it is normal indoors', /indoors/.test(waiting.gps.detail), waiting.gps.detail);
ok('a waiting GPS does not warn any other check',
  waiting.offline.state === 'pass' && waiting.storage.state === 'pass' && waiting.compass.state === 'pass');

var denied = checkFor({
  offlineReady: true, storageError: null,
  gps: { supported: true, status: 'denied', hasFix: false },
  compass: { status: 'ok' }
});
ok('denied location warns', denied.gps.state === 'warn');
ok('denied location says marks still save', /save without coordinates/.test(denied.gps.detail), denied.gps.detail);

var noGeo = checkFor({
  offlineReady: true, storageError: null,
  gps: { supported: false }, compass: { status: 'ok' }
});
ok('missing geolocation warns', noGeo.gps.state === 'warn');

/* Storage self-test result is reflected, not guessed. */
var badStore = checkFor({
  offlineReady: true, storageError: 'Storage unavailable: private mode',
  gps: { supported: true, status: 'ok', hasFix: true }, compass: { status: 'ok' }
});
ok('a failing storage self-test warns', badStore.storage.state === 'warn');
ok('the storage warning repeats the real reason',
  badStore.storage.detail === 'Storage unavailable: private mode', badStore.storage.detail);
ok('a live storage self-test passes here', S.Store.selfTest() === null);

/* Compass failure must always point at the Silva fallback. */
['unreliable', 'denied', 'stale', 'unsupported', 'waiting', 'idle'].forEach(function (st) {
  var c = checkFor({
    offlineReady: true, storageError: null,
    gps: { supported: true, status: 'ok', hasFix: true },
    compass: { status: st, message: 'x' }
  });
  ok('compass status "' + st + '" warns', c.compass.state === 'warn');
  ok('compass status "' + st + '" offers the manual fallback',
    c.compass.label === 'COMPASS NOT READY — manual bearing remains available', c.compass.label);
});

/* Not being offline-ready never blocks anything else. */
var notReady = checkFor({
  offlineReady: false, storageError: null,
  gps: { supported: true, status: 'ok', hasFix: true }, compass: { status: 'ok' }
});
ok('offline warn does not drag down the other checks',
  notReady.offline.state === 'warn' && notReady.storage.state === 'pass' &&
  notReady.gps.state === 'pass' && notReady.compass.state === 'pass');

/* --- CSV still works with no network involved ------------------------------- */
(function () {
  mem = {};
  var s2 = S.Store.newSession('Airplane Mode').session;
  for (var i = 0; i < 3; i++) {
    S.Store.addObservation({
      schema_version: 1, id: 'off-' + i, session_id: s2.id, session_name: s2.name,
      t: '2026-08-16T20:0' + i + ':00-06:00', lat: 39.8, lon: -105.2, acc_m: 7,
      gps_fix_t: '2026-08-16T20:0' + i + ':00-06:00', gps_fix_age_s: 1,
      downwind_true: 105, from_true: 285, heading_magnetic_raw: 97, declination: 8,
      declination_applied: true, bearing_source: 'sensor', bearing_input_ref: 'magnetic',
      intensity: 'moderate', speed_mph: null, speed_source: 'estimated', gusty: false,
      note: '', app_version: S.WM_VERSION
    });
  }
  var csv = S.Store.toCSV(S.Store.getObservations(s2.id));
  ok('CSV is produced from local data alone', csv.trim().split('\r\n').length === 4);
  ok('offline CSV still carries true bearings only',
    csv.indexOf('wind_from_deg_true') > 0 && !/magnetic/i.test(csv.split('\r\n')[0]));
})();

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
