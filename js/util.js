/* WindMark — small shared helpers.
   Deliberately plain: no modules, no build step, no dependencies. */

var WM_VERSION = '1.1.0';
var WM_SCHEMA_VERSION = 1;

/* ---------- numbers / bearings ---------------------------------------- */

/* Normalise any angle into [0, 360). Handles negatives and >360 so that
   0/360 wraparound never produces a negative or a 360 display. */
function norm360(deg) {
  if (deg === null || deg === undefined || !isFinite(deg)) return null;
  var d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/* Reciprocal bearing. downwind -> from, or from -> downwind. */
function reciprocal(deg) {
  if (deg === null || deg === undefined) return null;
  return norm360(deg + 180);
}

/* Convert a compass reading into a TRUE bearing.
     true = magnetic + declination        (east declination positive)
   `ref` is what the reading already is: 'magnetic' or 'true'. A reading that
   is already true-referenced — e.g. a Silva set with a declination scale —
   must NOT be corrected a second time. This is the single place that rule
   lives, so both the phone sensor and hand-entered bearings obey it. */
function toTrueBearing(reading, ref, declination) {
  if (reading === null || reading === undefined) return null;
  return norm360(reading + (ref === 'true' ? 0 : declination));
}

/* Smallest signed difference a-b, in (-180, 180]. Used for tests/diagnostics. */
function angleDiff(a, b) {
  var d = ((a - b + 540) % 360) - 180;
  return d;
}

/* Whole-degree bearing string, always three digits: "007", "284".
   Bare digits are NOT a legal bearing display on their own — always pass
   them through bearingText(), or append the reference yourself. */
function deg3(deg) {
  if (deg === null || deg === undefined) return '---';
  var d = Math.round(norm360(deg)) % 360;
  return ('00' + d).slice(-3);
}

/* The one and only way a directional bearing is written in the UI.
   Every bearing carries its reference — °T (true) or °M (magnetic) — so a
   number on screen can never be misread as the other kind.
     bearingText(284, 'true')     -> "284°T"
     bearingText(276, 'magnetic') -> "276°M"
     bearingText(null, 'true')    -> "---°T"                              */
function bearingText(deg, ref) {
  return deg3(deg) + refSuffix(ref);
}

/* "°T" / "°M". Anything that is not explicitly magnetic is true, because
   true is what WindMark stores and shows as authoritative. */
function refSuffix(ref) {
  return (ref === 'magnetic' || ref === 'M') ? '°M' : '°T';
}

function refWord(ref) {
  return (ref === 'magnetic' || ref === 'M') ? 'MAGNETIC' : 'TRUE';
}

/* Circular (vector) mean of bearings in degrees.
   NEVER average bearings arithmetically: (359 + 1) / 2 = 180, which is
   exactly backwards. Summing unit vectors and taking atan2 is correct
   across the 0/360 seam.
   samples: [{deg: <number>, w: <weight>}]
   Returns {deg, r} where r is 0..1 vector length (1 = perfectly consistent,
   near 0 = samples disagree / meaningless mean), or null. */
function circularMean(samples) {
  var sx = 0, sy = 0, wsum = 0;
  for (var i = 0; i < samples.length; i++) {
    var w = samples[i].w === undefined ? 1 : samples[i].w;
    var r = samples[i].deg * Math.PI / 180;
    sx += Math.sin(r) * w;
    sy += Math.cos(r) * w;
    wsum += w;
  }
  if (wsum === 0) return null;
  sx /= wsum; sy /= wsum;
  var len = Math.sqrt(sx * sx + sy * sy);
  if (len < 1e-9) return null;           // opposing samples cancelled out
  return { deg: norm360(Math.atan2(sx, sy) * 180 / Math.PI), r: len };
}

/* ---------- time ------------------------------------------------------- */

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* ISO 8601 with the phone's local UTC offset, e.g. 2026-08-16T20:32:05-06:00.
   Local time is what the handler reads off their watch, and the offset keeps
   it unambiguous when it is overlaid on a CalTopo track later. */
function isoLocal(d) {
  var off = -d.getTimezoneOffset();          // minutes east of UTC
  var sign = off >= 0 ? '+' : '-';
  var a = Math.abs(off);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
}

function hhmmss(d) {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function hhmm(d) {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* "1 sec ago" / "14 sec ago" / "3 min ago" */
function ageText(ms) {
  if (ms === null || ms === undefined) return '—';
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return s + ' sec ago';
  return Math.round(s / 60) + ' min ago';
}

/* ---------- misc ------------------------------------------------------- */

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older Safari.
  var b = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var h = [];
  for (var j = 0; j < 16; j++) h.push(('0' + b[j].toString(16)).slice(-2));
  return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
         h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' +
         h.slice(10, 16).join('');
}

function decText(dec) {
  var v = Math.round(dec * 10) / 10;
  if (v === 0) return 'DEC 0°';
  return 'DEC ' + (v > 0 ? '+' : '−') + Math.abs(v) + '°' + (v > 0 ? 'E' : 'W');
}

var INTENSITY_LABEL = {
  none: 'NO WIND',
  calm: 'CALM',
  light: 'LIGHT',
  moderate: 'MODERATE',
  strong: 'STRONG'
};

function el(id) { return document.getElementById(id); }
