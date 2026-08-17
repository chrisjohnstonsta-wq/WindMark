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

var sandbox = {
  window: { addEventListener: function () {}, removeEventListener: function () {}, crypto: undefined },
  navigator: {},
  document: { addEventListener: function () {} },
  localStorage: fakeStorage,
  console: console
};
sandbox.self = sandbox;
vm.createContext(sandbox);
['js/util.js', 'js/store.js', 'js/sensors.js'].forEach(function (f) {
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

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
