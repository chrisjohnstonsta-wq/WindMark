/* WindMark math self-check.  Run: node tools/selfcheck.js
   Plain node, no dependencies, no test framework. It checks the arithmetic
   that acceptance criteria 5-11 depend on — wraparound, circular averaging,
   declination, and the downwind/from convention. It cannot check the
   physical sensor: that still needs a compass and a walk outside. */

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

/* --- folders: one optional level above searches ---------------------------- */
mem = {};

/* A search written before folders existed has no folder_id at all. It must
   read as unfiled, without any migration touching it. */
S.localStorage.setItem('windmark.v1.sessions', JSON.stringify([
  { id: 'legacy-1', name: 'Old Search', started: '2026-08-01T09:00:00-06:00' }
]));
var legacy = S.Store.getSessions()[0];
ok('a legacy search survives', legacy && legacy.name === 'Old Search');
ok('a legacy search reads as unfiled', legacy.folder_id === null, String(legacy.folder_id));
ok('a legacy search is listed under UNFILED',
  S.Store.sessionsInFolder(null).some(function (x) { return x.id === 'legacy-1'; }));
ok('legacy folder_id is not written back to storage',
  JSON.parse(S.localStorage.getItem('windmark.v1.sessions'))[0].folder_id === undefined);
var grouped = S.Store.groupedSessions();
ok('grouping always ends with the unfiled group',
  grouped[grouped.length - 1].folder === null);

/* create / rename folders */
var trainRes = S.Store.newFolder('Handler Training');
ok('a folder can be created', !trainRes.error && !!trainRes.folder.id);
var train = trainRes.folder;
ok('the folder has a stable id, not a name relationship', typeof train.id === 'string' && train.id.length > 8);
ok('the folder records when it was created', !!train.created);
ok('an unnamed folder is refused', !!S.Store.newFolder('   ').error);
var missions = S.Store.newFolder('Missions').folder;
ok('a second folder can be created', S.Store.getFolders().length === 2);

/* create a search inside a folder */
var bear = S.Store.newSession('Bear Creek 8/17', train.id).session;
ok('a search can be created inside a folder', bear.folder_id === train.id);
ok('the folder lists it', S.Store.sessionsInFolder(train.id).length === 1);
var north = S.Store.newSession('North Table 8/24', train.id).session;
var mission = S.Store.newSession('Mission 2026-014', missions.id).session;
ok('folders keep their own searches',
  S.Store.sessionsInFolder(train.id).length === 2 &&
  S.Store.sessionsInFolder(missions.id).length === 1);

function obsFor(id, sesId, name) {
  return {
    schema_version: 1, id: id, session_id: sesId, session_name: name,
    t: '2026-08-17T10:00:00-06:00', lat: 39.8, lon: -105.2, acc_m: 6,
    gps_fix_t: '2026-08-17T10:00:00-06:00', gps_fix_age_s: 1,
    downwind_true: 105, from_true: 285, heading_magnetic_raw: 97, declination: 8,
    declination_applied: true, bearing_source: 'sensor', bearing_input_ref: 'magnetic',
    intensity: 'moderate', speed_mph: null, speed_source: 'estimated', gusty: false,
    note: '', app_version: 'test'
  };
}
S.Store.addObservation(obsFor('b1', bear.id, 'Bear Creek 8/17'));
S.Store.addObservation(obsFor('b2', bear.id, 'Bear Creek 8/17'));
S.Store.addObservation(obsFor('b3', bear.id, 'Bear Creek 8/17'));
S.Store.addObservation(obsFor('n1', north.id, 'North Table 8/24'));
ok('observation counts are per search',
  S.Store.countObservations(bear.id) === 3 && S.Store.countObservations(north.id) === 1);

/* moving a search never touches its observations */
var beforeMove = JSON.stringify(S.Store.getObservations(bear.id));
ok('a search moves to another folder', S.Store.moveSession(bear.id, missions.id) === null);
ok('the move is recorded on the search',
  S.Store.getSessions().filter(function (x) { return x.id === bear.id; })[0].folder_id === missions.id);
ok('moving a search leaves its observations untouched',
  JSON.stringify(S.Store.getObservations(bear.id)) === beforeMove);
ok('the old folder no longer lists it', S.Store.sessionsInFolder(train.id).length === 1);
ok('a search moves back to UNFILED', S.Store.moveSession(bear.id, null) === null);
ok('UNFILED now holds it', S.Store.sessionsInFolder(null).some(function (x) { return x.id === bear.id; }));
ok('unfiling still leaves observations untouched',
  JSON.stringify(S.Store.getObservations(bear.id)) === beforeMove);
S.Store.moveSession(bear.id, train.id);

/* renames touch labels only */
var beforeRename = JSON.stringify(S.Store.getAllObservations());
ok('a folder can be renamed', S.Store.renameFolder(train.id, 'Training 2026') === null);
ok('the new folder name resolves', S.Store.folderName(train.id) === 'Training 2026');
ok('renaming a folder alters no observation',
  JSON.stringify(S.Store.getAllObservations()) === beforeRename);
ok('a search can be renamed', S.Store.renameSession(bear.id, 'Bear Creek 08-17') === null);
ok('renaming a search alters no observation',
  JSON.stringify(S.Store.getAllObservations()) === beforeRename);
ok('an unnamed folder rename is refused', !!S.Store.renameFolder(train.id, '  '));
ok('renaming a missing folder reports it', !!S.Store.renameFolder('nope', 'x'));

/* CSV carries the CURRENT organisational names */
var orgHead = S.Store.toCSV([]).split('\r\n')[0].split(',');
ok('operational CSV has a folder_name column', orgHead.indexOf('folder_name') >= 0);
ok('operational CSV has a search_name column', orgHead.indexOf('search_name') >= 0);
var bearRow = S.Store.toCSV(S.Store.getObservations(bear.id)).split('\r\n')[1].split(',');
ok('CSV folder_name is the current folder name',
  bearRow[orgHead.indexOf('folder_name')] === 'Training 2026', bearRow[orgHead.indexOf('folder_name')]);
ok('CSV search_name is the current search name',
  bearRow[orgHead.indexOf('search_name')] === 'Bear Creek 08-17', bearRow[orgHead.indexOf('search_name')]);
var unfiledSes = S.Store.newSession('Loose Search').session;
S.Store.addObservation(obsFor('u1', unfiledSes.id, 'Loose Search'));
var unfiledRow = S.Store.toCSV(S.Store.getObservations(unfiledSes.id)).split('\r\n')[1].split(',');
ok('an unfiled search exports an empty folder_name',
  unfiledRow[orgHead.indexOf('folder_name')] === '', unfiledRow[orgHead.indexOf('folder_name')]);
var prHead2 = S.Store.toProvenanceCSV([]).split('\r\n')[0].split(',');
ok('provenance keeps the capture-time search name for audit',
  prHead2.indexOf('search_name_at_capture') >= 0);
var orphanObs = obsFor('orph', 'no-such-search', 'Vanished Search');
ok('an orphan observation falls back to its stored name',
  S.Store.toCSV([orphanObs]).split('\r\n')[1].split(',')[orgHead.indexOf('search_name')] === 'Vanished Search');
ok('an orphan observation exports no folder',
  S.Store.toCSV([orphanObs]).split('\r\n')[1].split(',')[orgHead.indexOf('folder_name')] === '');

/* clear observations: the search survives, its neighbours are untouched */
var bearFolderBefore = S.Store.getSessions().filter(function (x) { return x.id === bear.id; })[0].folder_id;
ok('clearing a search removes its observations', S.Store.clearObservations(bear.id) === null);
ok('the cleared search now has none', S.Store.countObservations(bear.id) === 0);
ok('the search itself survives',
  S.Store.getSessions().some(function (x) { return x.id === bear.id; }));
ok('its name survives',
  S.Store.getSessions().filter(function (x) { return x.id === bear.id; })[0].name === 'Bear Creek 08-17');
ok('its folder assignment survives',
  S.Store.getSessions().filter(function (x) { return x.id === bear.id; })[0].folder_id === bearFolderBefore);
ok('another search keeps its observations', S.Store.countObservations(north.id) === 1);
ok('the emptied search can be reused', S.Store.addObservation(obsFor('b4', bear.id, 'Bear Creek 08-17')) === null);
ok('and counts again', S.Store.countObservations(bear.id) === 1);

/* deleting a search takes only its own observations */
ok('deleting a search succeeds', S.Store.deleteSession(bear.id) === null);
ok('the search is gone', !S.Store.getSessions().some(function (x) { return x.id === bear.id; }));
ok('its observations are gone', S.Store.countObservations(bear.id) === 0);
ok('another search is unaffected', S.Store.countObservations(north.id) === 1);
ok('another search still exists',
  S.Store.getSessions().some(function (x) { return x.id === north.id; }));

/* a folder holding searches cannot be deleted */
var busy = S.Store.deleteFolder(train.id);
ok('a non-empty folder is refused', typeof busy === 'string' && busy.length > 0);
ok('the refusal counts the searches and says what to do',
  /contains 1 search\b/.test(busy) && /Move or delete/.test(busy), busy);
ok('the folder is still there', !!S.Store.getFolder(train.id));
ok('its searches are still there', S.Store.sessionsInFolder(train.id).length === 1);
ok('four searches means "searches", not "searchs"',
  /contains 4 searches/.test(S.Store.folderNotEmptyMessage('X', 4)), S.Store.folderNotEmptyMessage('X', 4));

/* an empty folder can be deleted */
S.Store.moveSession(north.id, null);
ok('the folder is now empty', S.Store.sessionsInFolder(train.id).length === 0);
ok('an empty folder deletes', S.Store.deleteFolder(train.id) === null);
ok('it is gone', !S.Store.getFolder(train.id));
ok('the search it held survives', S.Store.getSessions().some(function (x) { return x.id === north.id; }));
ok('a dangling folder_id reads as unfiled', S.Store.folderName('deleted-folder-id') === '');

/* active-search handling stays valid after a deletion */
S.Store.setActiveSession(mission.id);
ok('the active search is the one just set', S.Store.getActiveSession().id === mission.id);
S.Store.deleteSession(mission.id);
var fallback = S.Store.getActiveSession();
ok('a valid active search is chosen after deleting the active one', !!fallback && !!fallback.id);
ok('the replacement actually exists',
  S.Store.getSessions().some(function (x) { return x.id === fallback.id; }));
mem = {};
var lonely = S.Store.newSession('Only One').session;
S.Store.setActiveSession(lonely.id);
S.Store.deleteSession(lonely.id);
var recreated = S.Store.getActiveSession();
ok('deleting the last search creates a fresh one rather than leaving none', !!recreated && !!recreated.id);
ok('the fresh search is empty and unfiled',
  S.Store.countObservations(recreated.id) === 0 && recreated.folder_id === null);

/* the exact wording of every destructive prompt */
var cp = S.Store.clearPrompts('Bear Creek 8/17', 37);
ok('clear prompt 1 names the search and the count',
  cp[0] === 'Clear all 37 observations from "Bear Creek 8/17"?\nThe search itself will remain.', cp[0]);
ok('clear prompt 2 warns it cannot be undone',
  cp[1] === 'This cannot be undone.\nReally clear 37 observations?', cp[1]);
ok('a single observation is not pluralised',
  S.Store.clearPrompts('X', 1)[0].indexOf('1 observation from') > 0, S.Store.clearPrompts('X', 1)[0]);
var dp = S.Store.deleteSearchPrompts('Bear Creek 8/17', 37);
ok('delete prompt 1 names the search and the count',
  dp[0] === 'Delete "Bear Creek 8/17" and its 37 observations?', dp[0]);
ok('delete prompt 2 spells out what is lost',
  dp[1] === 'This permanently deletes the search and all 37 observations.\nReally delete?', dp[1]);
var fp = S.Store.deleteFolderPrompts('Missions');
ok('folder delete asks twice, naming the folder',
  /Missions/.test(fp[0]) && /Missions/.test(fp[1]) && /cannot be undone/.test(fp[1]), fp.join(' | '));

/* --- speed source: measured, never a brand name --------------------------- */
mem = {};
var spdSes = S.Store.newSession('Speeds').session;
function speedRec(id, src, mph) {
  return {
    schema_version: 1, id: id, session_id: spdSes.id, session_name: 'Speeds',
    t: '2026-08-16T20:00:00-06:00', lat: null, lon: null, acc_m: null,
    gps_fix_t: null, gps_fix_age_s: null,
    downwind_true: 105, from_true: 285, heading_magnetic_raw: 97, declination: 8,
    declination_applied: true, bearing_source: 'sensor', bearing_input_ref: 'magnetic',
    intensity: 'moderate', speed_mph: mph, speed_source: src, gusty: false,
    note: '', app_version: 'test'
  };
}
ok('legacy "kestrel" normalises to "measured"', S.Store.normalizeSpeedSource('kestrel') === 'measured');
ok('"measured" is left alone', S.Store.normalizeSpeedSource('measured') === 'measured');
ok('"estimated" is left alone', S.Store.normalizeSpeedSource('estimated') === 'estimated');

S.Store.addObservation(speedRec('spd-legacy', 'kestrel', 7.8));
S.Store.addObservation(speedRec('spd-new', 'measured', 4.2));
S.Store.addObservation(speedRec('spd-est', 'estimated', null));

var opCsv = S.Store.toCSV(S.Store.getObservations(spdSes.id));
var prCsv = S.Store.toProvenanceCSV(S.Store.getObservations(spdSes.id));
ok('operational CSV never exports a brand name', !/kestrel/i.test(opCsv), opCsv.slice(0, 120));
ok('provenance CSV never exports a brand name', !/kestrel/i.test(prCsv));
ok('operational CSV reports measured speeds as "measured"',
  (opCsv.match(/measured/g) || []).length === 2, String((opCsv.match(/measured/g) || []).length));
ok('estimated rows stay estimated', /estimated/.test(opCsv));

ok('migration rewrites legacy records', S.Store.migrateSpeedSource() === null);
ok('the legacy record now stores "measured"',
  S.Store.getObservation('spd-legacy').speed_source === 'measured');
ok('the already-correct record is untouched',
  S.Store.getObservation('spd-new').speed_source === 'measured');
ok('an estimated record is untouched',
  S.Store.getObservation('spd-est').speed_source === 'estimated');
ok('the measured number itself is never altered',
  S.Store.getObservation('spd-legacy').speed_mph === 7.8);
ok('migration is a no-op the second time', S.Store.migrateSpeedSource() === null);
ok('no stored record mentions a brand name',
  !/kestrel/i.test(JSON.stringify(S.Store.getAllObservations())));

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

/* Instrument brands tell the handler nothing: the app says "compass" and
   "measured". The only allowed mention of the old value is the migration that
   rewrites it. Organisation names have no place in it either — WindMark is a
   plain instrument, not any one team's app. */
['index.html', 'js/app.js', 'js/util.js', 'js/sensors.js', 'js/offline.js',
 'js/assets.js', 'js/store.js', 'css/windmark.css', 'manifest.webmanifest',
 'sw.js'].forEach(function (f) {
  var text = fs.readFileSync(path.join(root, f), 'utf8');
  if (f !== 'js/store.js') {   // store.js names the legacy value it migrates
    ok('no instrument brand names in ' + f, !/silva|kestrel/i.test(text),
      (text.match(/silva|kestrel/gi) || []).join(', '));
  }
  ok('no organisation name in ' + f, !/frrd|front range/i.test(text),
    (text.match(/frrd|front range/gi) || []).join(', '));
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

/* Compass failure must always point at the manual-bearing fallback. */
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
