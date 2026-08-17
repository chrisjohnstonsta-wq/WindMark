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
    vibrate: true
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
      started: isoLocal(new Date()),
      ended: null
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

  function endSession(id) {
    var list = getSessions();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) list[i].ended = isoLocal(new Date());
    }
    return saveSessions(list);
  }

  function deleteSession(id) {
    var list = getSessions().filter(function (s) { return s.id !== id; });
    var obs = getAllObservations().filter(function (o) { return o.session_id !== id; });
    var e1 = writeJSON(K_OBS, obs);
    if (e1) return e1;
    return saveSessions(list);
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
    var all = getAllObservations();
    all.push(rec);
    return writeJSON(K_OBS, all);
  }

  function updateObservation(id, patch) {
    var all = getAllObservations();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) {
        for (var k in patch) all[i][k] = patch[k];
      }
    }
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

  /* ---------- CSV -------------------------------------------------------- */

  /* Every stored field, unmodified. Blank cell for null/undefined so that a
     missing bearing stays visibly missing rather than becoming 0. */
  var CSV_FIELDS = [
    'schema_version', 'id', 'session_id', 'session_name', 't',
    'lat', 'lon', 'acc_m', 'gps_fix_t', 'gps_fix_age_s',
    'downwind_true', 'from_true', 'heading_magnetic_raw',
    'declination', 'declination_applied', 'bearing_source', 'bearing_input_ref',
    'intensity', 'speed_mph', 'speed_source', 'gusty', 'note', 'app_version'
  ];

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(observations) {
    var sessions = getSessions();
    var nameById = {};
    sessions.forEach(function (s) { nameById[s.id] = s.name; });

    var lines = [CSV_FIELDS.join(',')];
    observations.forEach(function (o) {
      var row = CSV_FIELDS.map(function (f) {
        if (f === 'session_name') return csvCell(o.session_name || nameById[o.session_id] || '');
        return csvCell(o[f]);
      });
      lines.push(row.join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

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
    renameSession: renameSession, endSession: endSession, deleteSession: deleteSession,
    getAllObservations: getAllObservations, getObservations: getObservations,
    getObservation: getObservation, addObservation: addObservation,
    updateObservation: updateObservation, deleteObservation: deleteObservation,
    toCSV: toCSV, usageBytes: usageBytes, selfTest: selfTest
  };
})();
