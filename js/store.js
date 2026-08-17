/* WindMark — persistence.

   localStorage only. No server, no account, no IndexedDB wrapper.
   Writes are synchronous, so a completed write has hit disk before we draw
   the SAVED confirmation — which is exactly the guarantee the field needs.

   Keys are versioned so a future schema change can migrate instead of guess. */

var Store = (function () {

  var K_OBS = 'windmark.v1.observations';
  var K_SESSIONS = 'windmark.v1.sessions';
  var K_ACTIVE = 'windmark.v1.active_session';
  var K_SETTINGS = 'windmark.v1.settings';

  var DEFAULT_SETTINGS = {
    declination: 8,            // degrees, east positive (field-test default)
    manual_ref: 'magnetic',    // how hand-entered bearings are interpreted
    sensor_ref: 'magnetic',    // how the phone's reported heading is interpreted
    sound: true,
    vibrate: true,
    persist_asked: false       // persistent storage is requested at most once
  };

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  /* Returns null on success, or an error string. Callers must surface the
     error: a silent failed write is the worst possible outcome here. */
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return null;
    } catch (e) {
      return (e && e.name === 'QuotaExceededError')
        ? 'Storage full — export CSV and clear old searches.'
        : ('Storage write failed: ' + (e && e.message ? e.message : e));
    }
  }

  /* ---------- settings ------------------------------------------------- */

  function getSettings() {
    var s = readJSON(K_SETTINGS, {});
    var out = {};
    for (var k in DEFAULT_SETTINGS) {
      out[k] = (s && s[k] !== undefined) ? s[k] : DEFAULT_SETTINGS[k];
    }
    if (typeof out.declination !== 'number' || !isFinite(out.declination)) {
      out.declination = DEFAULT_SETTINGS.declination;
    }
    if (out.manual_ref !== 'true') out.manual_ref = 'magnetic';
    if (out.sensor_ref !== 'true') out.sensor_ref = 'magnetic';
    return out;
  }

  function saveSettings(s) { return writeJSON(K_SETTINGS, s); }

  /* ---------- sessions -------------------------------------------------- */

  function getSessions() {
    var list = readJSON(K_SESSIONS, []);
    return Array.isArray(list) ? list : [];
  }

  function saveSessions(list) { return writeJSON(K_SESSIONS, list); }

  function newSession(name) {
    var list = getSessions();
    var s = {
      id: uuid(),
      name: name || ('Search ' + (list.length + 1)),
      started: isoLocal(new Date())
      // No 'ended' state: switching or creating a search is enough. An
      // `ended` field on older stored data is simply ignored.
    };
    list.push(s);
    var err = saveSessions(list);
    if (err) return { error: err };
    writeJSON(K_ACTIVE, s.id);
    return { session: s };
  }

  /* The active session, creating one on first run. */
  function getActiveSession() {
    var id = readJSON(K_ACTIVE, null);
    var list = getSessions();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    if (list.length) {                       // active id lost — use the newest
      writeJSON(K_ACTIVE, list[list.length - 1].id);
      return list[list.length - 1];
    }
    var r = newSession('Search 1');
    return r.session || null;
  }

  function setActiveSession(id) { return writeJSON(K_ACTIVE, id); }

  function renameSession(id, name) {
    var list = getSessions();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].name = name;
    return saveSessions(list);
  }

  function deleteSession(id) {
    var list = getSessions().filter(function (s) { return s.id !== id; });
    var obs = getAllObservations().filter(function (o) { return o.session_id !== id; });
    var e1 = writeJSON(K_OBS, obs);
    if (e1) return e1;
    return saveSessions(list);
  }

  /* ---------- the bearing / intensity invariant ---------------------------

     Two states, and nothing in between is representable:

       intensity 'none'  (no discernible wind)
         -> every direction and provenance field is null / false. The phone
            heading at that moment did not represent wind and is discarded.

       intensity calm|light|moderate|strong
         -> must carry a valid true bearing, with from_true the reciprocal
            of downwind_true.

     addObservation and updateObservation both refuse anything else, so no UI
     path — capture, correction, or otherwise — can persist a contradiction. */

  var DIRECTIONAL = ['calm', 'light', 'moderate', 'strong'];

  function isDirectional(intensity) { return DIRECTIONAL.indexOf(intensity) >= 0; }

  /* The patch that strips all direction and provenance from a record. */
  function noDirectionFields() {
    return {
      downwind_true: null,
      from_true: null,
      heading_magnetic_raw: null,
      bearing_source: null,
      bearing_input_ref: null,
      declination_applied: false
    };
  }

  function hasBearing(rec) {
    return rec && typeof rec.downwind_true === 'number' && isFinite(rec.downwind_true);
  }

  /* Returns null when the record is legal, otherwise a message. */
  function validateObservation(rec) {
    if (!rec) return 'Missing observation.';

    if (rec.intensity === 'none') {
      var dirty = [];
      ['downwind_true', 'from_true', 'heading_magnetic_raw',
       'bearing_source', 'bearing_input_ref'].forEach(function (k) {
        if (rec[k] !== null && rec[k] !== undefined) dirty.push(k);
      });
      if (rec.declination_applied) dirty.push('declination_applied');
      return dirty.length
        ? 'No discernible wind cannot carry direction data (' + dirty.join(', ') + ').'
        : null;
    }

    if (!isDirectional(rec.intensity)) return 'Unknown intensity "' + rec.intensity + '".';
    if (!hasBearing(rec)) return 'A directional observation needs a bearing.';
    if (typeof rec.from_true !== 'number' || !isFinite(rec.from_true)) {
      return 'A directional observation needs a bearing.';
    }
    if (norm360(rec.from_true) !== reciprocal(rec.downwind_true)) {
      return 'from_true must be the reciprocal of downwind_true.';
    }
    return null;
  }

  /* ---------- observations ---------------------------------------------- */

  function getAllObservations() {
    var list = readJSON(K_OBS, []);
    return Array.isArray(list) ? list : [];
  }

  function getObservations(sessionId) {
    return getAllObservations().filter(function (o) { return o.session_id === sessionId; });
  }

  /* Persist immediately. Returns null on success or an error string. */
  function addObservation(rec) {
    var bad = validateObservation(rec);
    if (bad) return bad;
    var all = getAllObservations();
    all.push(rec);
    return writeJSON(K_OBS, all);
  }

  /* Applies the patch to a copy first and refuses the whole write if the
     result would be contradictory — corrections are held to the same
     invariant as captures. */
  function updateObservation(id, patch) {
    var all = getAllObservations();
    var found = false;
    for (var i = 0; i < all.length; i++) {
      if (all[i].id !== id) continue;
      found = true;
      var merged = {};
      for (var k in all[i]) merged[k] = all[i][k];
      for (var j in patch) merged[j] = patch[j];
      var bad = validateObservation(merged);
      if (bad) return bad;
      all[i] = merged;
    }
    if (!found) return 'Observation not found.';
    return writeJSON(K_OBS, all);
  }

  function deleteObservation(id) {
    var all = getAllObservations().filter(function (o) { return o.id !== id; });
    return writeJSON(K_OBS, all);
  }

  function getObservation(id) {
    var all = getAllObservations();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* ---------- export ------------------------------------------------------

     Two exports, deliberately different in kind.

     The OPERATIONAL export is the one that goes to the map, the debrief, and
     anyone else's software. Every wind-direction bearing in it is TRUE, and
     every bearing column says so in its own name (..._deg_true). Raw
     magnetic readings are NOT in it: a magnetic bearing sitting next to a
     true one in a spreadsheet is exactly how a log gets misread, and nothing
     downstream should ever have to ask which north a column meant.

     The PROVENANCE export is for debugging and audit. It carries every
     stored field, including the raw magnetic reading, the declination, and
     whether that declination was applied — clearly named so it cannot be
     mistaken for the operational file.

     The same rule governs GPX and GeoJSON when they are added later: derive
     them from OPERATIONAL_FIELDS, never from the raw record.               */

  /* [ column name, function of (observation) ] */
  var OPERATIONAL_FIELDS = [
    ['schema_version', function (o) { return o.schema_version; }],
    ['id', function (o) { return o.id; }],
    ['session_id', function (o) { return o.session_id; }],
    ['session_name', function (o) { return o.session_name; }],
    ['t', function (o) { return o.t; }],
    ['lat', function (o) { return o.lat; }],
    ['lon', function (o) { return o.lon; }],
    ['acc_m', function (o) { return o.acc_m; }],
    ['gps_fix_t', function (o) { return o.gps_fix_t; }],
    ['gps_fix_age_s', function (o) { return o.gps_fix_age_s; }],
    // The authoritative wind direction, true-referenced, both senses.
    ['wind_from_deg_true', function (o) { return o.from_true; }],
    ['wind_toward_deg_true', function (o) { return o.downwind_true; }],
    ['bearing_source', function (o) { return o.bearing_source; }],
    ['intensity', function (o) { return o.intensity; }],
    ['speed_mph', function (o) { return o.speed_mph; }],
    ['speed_source', function (o) { return o.speed_source; }],
    ['gusty', function (o) { return o.gusty; }],
    ['note', function (o) { return o.note; }],
    ['app_version', function (o) { return o.app_version; }]
  ];

  var PROVENANCE_FIELDS = OPERATIONAL_FIELDS.concat([
    ['raw_input_deg_magnetic', function (o) { return o.heading_magnetic_raw; }],
    ['input_reference', function (o) { return o.bearing_input_ref; }],
    ['declination_deg_east', function (o) { return o.declination; }],
    ['declination_applied', function (o) { return o.declination_applied; }]
  ]);

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildCSV(observations, fields) {
    var nameById = {};
    getSessions().forEach(function (s) { nameById[s.id] = s.name; });

    var lines = [fields.map(function (f) { return f[0]; }).join(',')];
    observations.forEach(function (o) {
      lines.push(fields.map(function (f) {
        var v = f[1](o);
        // Renaming a search must show up in the next export, so the current
        // name wins; the name stored at capture time is only a fallback for
        // observations whose search no longer exists.
        if (f[0] === 'session_name') v = nameById[o.session_id] || v || '';
        return csvCell(v);
      }).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /* Operational: true bearings only. */
  function toCSV(observations) { return buildCSV(observations, OPERATIONAL_FIELDS); }

  /* Provenance: everything, including the raw magnetic reading. */
  function toProvenanceCSV(observations) { return buildCSV(observations, PROVENANCE_FIELDS); }

  /* ---------- diagnostics ------------------------------------------------ */

  function usageBytes() {
    var n = 0;
    [K_OBS, K_SESSIONS, K_ACTIVE, K_SETTINGS].forEach(function (k) {
      var v = localStorage.getItem(k);
      if (v) n += v.length + k.length;
    });
    return n;
  }

  /* Is localStorage actually usable? Called at startup so a private-mode or
     blocked-storage browser is reported loudly instead of eating data. */
  function selfTest() {
    try {
      var k = 'windmark.v1.selftest';
      localStorage.setItem(k, '1');
      var ok = localStorage.getItem(k) === '1';
      localStorage.removeItem(k);
      return ok ? null : 'Storage read-back failed.';
    } catch (e) {
      return 'Storage unavailable: ' + (e && e.message ? e.message : e);
    }
  }

  return {
    getSettings: getSettings, saveSettings: saveSettings,
    getSessions: getSessions, newSession: newSession,
    getActiveSession: getActiveSession, setActiveSession: setActiveSession,
    renameSession: renameSession, deleteSession: deleteSession,
    getAllObservations: getAllObservations, getObservations: getObservations,
    getObservation: getObservation, addObservation: addObservation,
    updateObservation: updateObservation, deleteObservation: deleteObservation,
    isDirectional: isDirectional, noDirectionFields: noDirectionFields,
    hasBearing: hasBearing, validateObservation: validateObservation,
    toCSV: toCSV, toProvenanceCSV: toProvenanceCSV,
    OPERATIONAL_FIELDS: OPERATIONAL_FIELDS, PROVENANCE_FIELDS: PROVENANCE_FIELDS,
    usageBytes: usageBytes, selfTest: selfTest
  };
})();
