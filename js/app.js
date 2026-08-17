/* WindMark — UI and capture flow.

   Convention used everywhere, without exception:
     downwind_true = the true bearing the wind is blowing TOWARD
                     (the way a talc puff travels, the way the top of the
                      phone is pointed at mark time)
     from_true     = (downwind_true + 180) % 360, the meteorological
                     "wind from" bearing shown in review.

   Capture shows the downwind bearing big (because that is what the handler
   is physically aiming) and the "wind from" bearing underneath (because
   that is what gets written in the log). */

var App = (function () {

  var settings = null;
  var session = null;
  var screen = 'gate';
  var pending = null;        // in-progress mark, see startMark()
  var detailId = null;       // observation open on the detail screen
  var manualCtx = null;      // 'new' | 'change' | 'edit'
  var lastSavedId = null;
  var overlayTimer = null;
  var uiTimer = null;

  /* ---------- tiny helpers ---------------------------------------------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function show(name) {
    screen = name;
    var all = document.querySelectorAll('.screen');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
    var s = el('screen-' + name);
    if (s) s.classList.add('active');
    window.scrollTo(0, 0);
    if (name === 'list') renderList();
    if (name === 'sessions') renderSessions();
    if (name === 'settings') renderSettings();
    if (name === 'detail') renderDetail();
  }

  /* ---------- confirmation feedback -------------------------------------- */

  var Beeper = {
    ctx: null,
    init: function () {
      // Must be created/resumed inside a user gesture or iOS keeps it suspended.
      try {
        var C = window.AudioContext || window.webkitAudioContext;
        if (!C) return;
        if (!this.ctx) this.ctx = new C();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { this.ctx = null; }
    },
    beep: function (ok) {
      if (!settings.sound || !this.ctx) return;
      try {
        var t = this.ctx.currentTime;
        var o = this.ctx.createOscillator();
        var g = this.ctx.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(ok ? 880 : 220, t);
        if (ok) o.frequency.setValueAtTime(1320, t + 0.09);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (ok ? 0.20 : 0.45));
        o.connect(g); g.connect(this.ctx.destination);
        o.start(t); o.stop(t + (ok ? 0.22 : 0.5));
      } catch (e) { /* audio is a nice-to-have, never a failure path */ }
    }
  };

  function buzz(pattern) {
    // Progressive enhancement only — iOS Safari has no vibration.
    if (!settings.vibrate) return;
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
  }

  /* ---------- live capture screen ---------------------------------------- */

  function gpsLineText() {
    var st = Gps.state;
    if (st.status === 'ok') {
      var acc = st.acc === null ? '±?' : '±' + Math.round(st.acc) + ' m';
      return 'GPS ' + acc + ' · fix ' + ageText(Gps.ageMs());
    }
    return 'GPS: ' + st.message;
  }

  function updateCapture() {
    var st = Compass.tick();

    var g = el('gps-line');
    g.textContent = gpsLineText();
    var poor = (Gps.state.status !== 'ok') ||
               (Gps.state.acc !== null && Gps.state.acc > 20) ||
               (Gps.ageMs() !== null && Gps.ageMs() > 20000);
    g.classList.toggle('warn', poor);

    var c = el('compass-line');
    c.textContent = st.message;
    c.classList.toggle('warn', st.status !== 'ok');
    c.classList.toggle('ok', st.status === 'ok');

    var usable = usableSensorHeading(st);
    el('heading-big').textContent = usable === null ? '---°T' : deg3(usable) + '°T';
    el('wind-from').textContent = usable === null
      ? 'WIND FROM ---°T'
      : 'WIND FROM ' + deg3(reciprocal(usable)) + '°T';
    el('heading-big').classList.toggle('dead', usable === null);

    el('dec-line').textContent = decText(settings.declination) +
      (settings.sensor_ref === 'true' ? ' · sensor reads TRUE' : '');

    el('top-session').textContent = session ? session.name : '—';
    el('top-count').textContent = String(Store.getObservations(session.id).length);
  }

  /* A sensor heading we are willing to write into a log. Relative
     orientation (arbitrary alpha zero) is never acceptable. */
  function usableSensorHeading(st) {
    if (!st) st = Compass.state;
    if (st.trueHeading === null) return null;
    if (st.source === 'relative') return null;
    if (st.status === 'denied' || st.status === 'unsupported' || st.status === 'stale') return null;
    return st.trueHeading;
  }

  /* ---------- mark flow --------------------------------------------------- */

  /* MARK WIND: freeze heading, freeze the freshest GPS fix, stamp the time,
     then ask for intensity. Nothing is auto-captured and nothing is saved
     until an intensity button is tapped. */
  function startMark(withManual) {
    var st = Compass.tick();
    var h = usableSensorHeading(st);

    pending = {
      t: new Date(),
      gps: Gps.snapshot(),
      bearing: null,
      gusty: false,
      mph: null,
      compassWarn: (st.status === 'unreliable' ? st.message : null)
    };

    if (h !== null) {
      pending.bearing = {
        downwind_true: Math.round(h) % 360,
        heading_magnetic_raw: settings.sensor_ref === 'true'
          ? null                                  // sensor already true; no magnetic reading exists
          : Math.round(st.smoothed) % 360,
        source: 'sensor',
        input_ref: settings.sensor_ref,
        declination_applied: settings.sensor_ref !== 'true'
      };
    }

    el('in-mph').value = '';
    el('btn-gusty').textContent = 'GUSTY: OFF';
    el('btn-gusty').classList.remove('on');
    renderMarkHead();
    buzz(20);

    if (withManual || pending.bearing === null) {
      manualCtx = 'new';
      openManual(pending.bearing ? pending.bearing.downwind_true : null);
    } else {
      show('intensity');
    }
  }

  function renderMarkHead() {
    if (!pending) return;
    el('mark-time').textContent = 'MARKED ' + hhmmss(pending.t);
    if (pending.bearing) {
      el('mark-bearing').textContent = 'WIND FROM ' + deg3(reciprocal(pending.bearing.downwind_true)) + '°T';
      el('mark-sub').textContent = 'blowing toward ' + deg3(pending.bearing.downwind_true) + '°T · ' +
        (pending.bearing.source === 'sensor' ? 'phone compass' : 'by hand') +
        (pending.compassWarn ? ' · CHECK COMPASS' : '');
    } else {
      el('mark-bearing').textContent = 'NO BEARING';
      el('mark-sub').textContent = 'Only NO DISCERNIBLE WIND can be saved without a bearing.';
    }
    el('mark-sub').classList.toggle('warn', !pending.bearing || !!pending.compassWarn);
  }

  function cancelMark() {
    pending = null;
    show('capture');
  }

  /* Tapping an intensity commits the observation. */
  function commitIntensity(intensity) {
    if (!pending) { show('capture'); return; }

    if (intensity !== 'none' && !pending.bearing) {
      // Directional intensity with no bearing: send them to manual entry
      // rather than inventing a direction.
      pending.pendingIntensity = intensity;
      manualCtx = 'new';
      openManual(null);
      return;
    }

    var mphRaw = el('in-mph').value;
    var mph = (mphRaw === '' || mphRaw === null) ? null : parseFloat(mphRaw);
    if (mph !== null && (!isFinite(mph) || mph < 0)) mph = null;

    var t = pending.t;
    var gps = pending.gps;
    var b = (intensity === 'none') ? null : pending.bearing;

    var rec = {
      schema_version: WM_SCHEMA_VERSION,
      id: uuid(),
      session_id: session.id,
      session_name: session.name,
      t: isoLocal(t),

      lat: gps.lat,
      lon: gps.lon,
      acc_m: gps.acc === null ? null : Math.round(gps.acc * 10) / 10,
      gps_fix_t: gps.fixTime === null ? null : isoLocal(new Date(gps.fixTime)),
      gps_fix_age_s: gps.ageMs === null ? null : Math.round(gps.ageMs / 100) / 10,

      downwind_true: b ? b.downwind_true : null,
      from_true: b ? reciprocal(b.downwind_true) : null,
      heading_magnetic_raw: b ? b.heading_magnetic_raw : null,
      declination: settings.declination,
      declination_applied: b ? b.declination_applied : false,
      bearing_source: b ? b.source : null,
      bearing_input_ref: b ? b.input_ref : null,

      intensity: intensity,
      speed_mph: mph,
      speed_source: mph === null ? 'estimated' : 'kestrel',
      gusty: !!pending.gusty,
      note: '',
      app_version: WM_VERSION
    };

    // Persist FIRST. The confirmation must never be shown for data that is
    // not already on disk.
    var err = Store.addObservation(rec);
    if (err) {
      showOverlay(false, 'NOT SAVED', err, null);
      Beeper.beep(false);
      buzz([100, 60, 100, 60, 100]);
      return;
    }

    lastSavedId = rec.id;
    pending = null;

    var main = (intensity === 'none')
      ? 'NO DISCERNIBLE WIND'
      : 'FROM ' + deg3(rec.from_true) + '°T · ' + INTENSITY_LABEL[intensity];
    var sub = [];
    if (rec.gusty) sub.push('GUSTY');
    if (rec.speed_mph !== null) sub.push(rec.speed_mph + ' mph (Kestrel)');
    sub.push(rec.acc_m === null ? 'no GPS' : '±' + Math.round(rec.acc_m) + ' m');
    if (rec.bearing_source === 'manual') sub.push('bearing by hand');

    show('capture');
    showOverlay(true, 'SAVED', main, sub.join(' · '));
    Beeper.beep(true);
    buzz([40, 40, 40]);
  }

  /* ---------- save confirmation overlay ------------------------------------ */

  function showOverlay(ok, title, main, sub) {
    var ov = el('overlay');
    ov.classList.add('visible');
    ov.classList.toggle('bad', !ok);
    el('ov-title').textContent = title;
    el('ov-main').textContent = main;
    el('ov-sub').textContent = sub || '';
    el('btn-undo').style.display = (ok && lastSavedId) ? '' : 'none';
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayTimer = setTimeout(hideOverlay, ok ? 5000 : 12000);
  }

  function hideOverlay() {
    if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
    el('overlay').classList.remove('visible');
  }

  function undoLast() {
    if (!lastSavedId) { hideOverlay(); return; }
    var err = Store.deleteObservation(lastSavedId);
    lastSavedId = null;
    hideOverlay();
    if (err) alert(err);
    updateCapture();
  }

  /* ---------- manual bearing entry ------------------------------------------ */

  function openManual(prefill) {
    el('in-manual').value = (prefill === null || prefill === undefined) ? '' : String(Math.round(prefill));
    updateManualPreview();
    show('manual');
    setTimeout(function () { try { el('in-manual').focus(); } catch (e) {} }, 100);
  }

  /* Applies declination only when the handler said their reading is magnetic.
     A true (declination-adjusted) reading must NOT be corrected twice. */
  function manualToTrue(entered) {
    return toTrueBearing(entered, settings.manual_ref, settings.declination);
  }

  function readManual() {
    var v = parseFloat(el('in-manual').value);
    if (!isFinite(v)) return null;
    return norm360(v);
  }

  function updateManualPreview() {
    el('manual-ref-line').textContent = settings.manual_ref === 'magnetic'
      ? 'Readings entered as MAGNETIC · ' + decText(settings.declination) + ' will be applied'
      : 'Readings entered as TRUE · no declination correction applied';
    var v = readManual();
    var p = el('manual-preview');
    if (v === null) { p.textContent = '—'; return; }
    var t = manualToTrue(v);
    p.innerHTML = 'blowing toward <b>' + deg3(t) + '°T</b><br>WIND FROM <b>' + deg3(reciprocal(t)) + '°T</b>';
  }

  function acceptManual() {
    var v = readManual();
    if (v === null) { alert('Enter a bearing from 0 to 360.'); return; }
    var t = Math.round(manualToTrue(v)) % 360;
    var b = {
      downwind_true: t,
      heading_magnetic_raw: settings.manual_ref === 'magnetic' ? Math.round(v) % 360 : null,
      source: 'manual',
      input_ref: settings.manual_ref,
      declination_applied: settings.manual_ref === 'magnetic'
    };

    if (manualCtx === 'edit' && detailId) {
      var err = Store.updateObservation(detailId, {
        downwind_true: b.downwind_true,
        from_true: reciprocal(b.downwind_true),
        heading_magnetic_raw: b.heading_magnetic_raw,
        declination: settings.declination,
        declination_applied: b.declination_applied,
        bearing_source: 'manual',
        bearing_input_ref: b.input_ref
      });
      if (err) alert(err);
      show('detail');
      return;
    }

    if (!pending) { show('capture'); return; }
    pending.bearing = b;
    pending.compassWarn = null;
    renderMarkHead();

    if (pending.pendingIntensity) {
      var i = pending.pendingIntensity;
      pending.pendingIntensity = null;
      commitIntensity(i);
      return;
    }
    show('intensity');
  }

  /* ---------- list ------------------------------------------------------------ */

  function renderList() {
    el('list-title').textContent = session.name;
    var obs = Store.getObservations(session.id).slice().reverse(); // newest first
    var body = el('list-body');
    if (!obs.length) {
      body.innerHTML = '<div class="empty">No observations in this search yet.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      var time = o.t ? o.t.slice(11, 16) : '--:--';
      var dir = (o.from_true === null || o.from_true === undefined)
        ? 'No wind' : 'From ' + deg3(o.from_true) + '°T';
      var inten = o.intensity === 'none' ? '—' : INTENSITY_LABEL[o.intensity] || o.intensity;
      var extra = '';
      if (o.gusty) extra += ' G';
      if (o.speed_mph !== null && o.speed_mph !== undefined) extra += ' ' + o.speed_mph + 'mph';
      if (o.bearing_source === 'manual') extra += ' ✎';
      var acc = (o.acc_m === null || o.acc_m === undefined) ? '—' : '±' + Math.round(o.acc_m) + 'm';
      html += '<button class="row" data-obs="' + esc(o.id) + '">' +
        '<span class="c-time">' + esc(time) + '</span>' +
        '<span class="c-dir">' + esc(dir) + '</span>' +
        '<span class="c-int">' + esc(inten) + esc(extra) + '</span>' +
        '<span class="c-acc">' + esc(acc) + '</span>' +
        '</button>';
    }
    body.innerHTML = html;
    var rows = body.querySelectorAll('.row');
    for (var j = 0; j < rows.length; j++) {
      rows[j].addEventListener('click', function () {
        detailId = this.getAttribute('data-obs');
        show('detail');
      });
    }
  }

  /* ---------- detail ------------------------------------------------------------ */

  function renderDetail() {
    var o = Store.getObservation(detailId);
    var body = el('detail-body');
    if (!o) { body.innerHTML = '<div class="empty">Observation not found.</div>'; return; }

    function row(k, v) {
      return '<div class="dl"><span class="dk">' + esc(k) + '</span><span class="dv">' +
        esc(v === null || v === undefined ? '—' : v) + '</span></div>';
    }

    var html = '';
    html += '<div class="detail-head">' +
      (o.from_true === null || o.from_true === undefined ? 'NO DISCERNIBLE WIND'
        : 'WIND FROM ' + deg3(o.from_true) + '°T') + '</div>';
    html += '<div class="detail-sub">' + esc(INTENSITY_LABEL[o.intensity] || o.intensity) +
      (o.gusty ? ' · GUSTY' : '') +
      (o.speed_mph !== null && o.speed_mph !== undefined ? ' · ' + o.speed_mph + ' mph Kestrel' : '') +
      '</div>';

    html += row('time', o.t);
    html += row('blowing toward', o.downwind_true === null || o.downwind_true === undefined ? '—' : deg3(o.downwind_true) + '°T');
    html += row('wind from', o.from_true === null || o.from_true === undefined ? '—' : deg3(o.from_true) + '°T');
    html += row('bearing source', o.bearing_source);
    html += row('reading entered as', o.bearing_input_ref);
    html += row('raw magnetic', o.heading_magnetic_raw === null || o.heading_magnetic_raw === undefined ? '—' : deg3(o.heading_magnetic_raw) + '°M');
    html += row('declination', o.declination + '°' + (o.declination_applied ? ' (applied)' : ' (not applied)'));
    html += row('speed source', o.speed_source);
    html += row('lat, lon', (o.lat === null || o.lat === undefined) ? '—' :
      (Math.round(o.lat * 1e6) / 1e6) + ', ' + (Math.round(o.lon * 1e6) / 1e6));
    html += row('gps accuracy', o.acc_m === null || o.acc_m === undefined ? '—' : '±' + o.acc_m + ' m');
    html += row('gps fix time', o.gps_fix_t);
    html += row('gps fix age', o.gps_fix_age_s === null || o.gps_fix_age_s === undefined ? '—' : o.gps_fix_age_s + ' s');
    html += row('search', o.session_name);
    html += row('id', o.id);

    html += '<div class="set-label">CORRECT INTENSITY</div><div class="fix-grid">';
    ['none', 'calm', 'light', 'moderate', 'strong'].forEach(function (k) {
      html += '<button class="btn btn-fix' + (o.intensity === k ? ' on' : '') +
        '" data-fixint="' + k + '">' + INTENSITY_LABEL[k] + '</button>';
    });
    html += '</div>';

    html += '<div class="fix-grid2">' +
      '<button class="btn btn-fix" id="btn-fix-bearing">CORRECT BEARING</button>' +
      '<button class="btn btn-fix' + (o.gusty ? ' on' : '') + '" id="btn-fix-gusty">GUSTY: ' + (o.gusty ? 'ON' : 'OFF') + '</button>' +
      '</div>';

    html += '<div class="set-label">KESTREL mph</div>' +
      '<div class="fix-grid2"><input id="fix-mph" class="mph-input wide" type="number" inputmode="decimal" step="0.1" min="0" value="' +
      (o.speed_mph === null || o.speed_mph === undefined ? '' : esc(o.speed_mph)) +
      '" placeholder="—"><button class="btn btn-fix" id="btn-fix-mph">SET SPEED</button></div>';

    html += '<div class="set-label">NOTE</div>' +
      '<textarea id="fix-note" class="note-input" rows="3">' + esc(o.note || '') + '</textarea>' +
      '<button class="btn btn-wide" id="btn-fix-note">SAVE NOTE</button>';

    html += '<button class="btn btn-wide btn-danger" id="btn-delete-obs">DELETE OBSERVATION</button>';

    body.innerHTML = html;

    var ints = body.querySelectorAll('[data-fixint]');
    for (var i = 0; i < ints.length; i++) {
      ints[i].addEventListener('click', function () {
        var k = this.getAttribute('data-fixint');
        var patch = { intensity: k };
        if (k === 'none') {
          // "No discernible wind" must not retain a direction.
          patch.downwind_true = null;
          patch.from_true = null;
          patch.heading_magnetic_raw = null;
          patch.bearing_source = null;
          patch.bearing_input_ref = null;
          patch.declination_applied = false;
        }
        var err = Store.updateObservation(detailId, patch);
        if (err) alert(err);
        renderDetail();
      });
    }

    el('btn-fix-bearing').addEventListener('click', function () {
      manualCtx = 'edit';
      var cur = Store.getObservation(detailId);
      // Prefill with the entered value where we know it, else the true bearing.
      var pre = (cur.bearing_input_ref === 'magnetic' && cur.heading_magnetic_raw !== null &&
                 cur.heading_magnetic_raw !== undefined && settings.manual_ref === 'magnetic')
        ? cur.heading_magnetic_raw : cur.downwind_true;
      openManual(pre === undefined ? null : pre);
    });

    el('btn-fix-gusty').addEventListener('click', function () {
      var cur = Store.getObservation(detailId);
      var err = Store.updateObservation(detailId, { gusty: !cur.gusty });
      if (err) alert(err);
      renderDetail();
    });

    el('btn-fix-mph').addEventListener('click', function () {
      var raw = el('fix-mph').value;
      var v = (raw === '') ? null : parseFloat(raw);
      if (v !== null && (!isFinite(v) || v < 0)) { alert('Enter a valid speed.'); return; }
      var err = Store.updateObservation(detailId, {
        speed_mph: v,
        speed_source: v === null ? 'estimated' : 'kestrel'
      });
      if (err) alert(err);
      renderDetail();
    });

    el('btn-fix-note').addEventListener('click', function () {
      var err = Store.updateObservation(detailId, { note: el('fix-note').value });
      if (err) alert(err); else flash('NOTE SAVED');
    });

    el('btn-delete-obs').addEventListener('click', function () {
      if (!confirm('Delete this observation? This cannot be undone.')) return;
      var err = Store.deleteObservation(detailId);
      if (err) alert(err);
      detailId = null;
      show('list');
    });
  }

  function flash(msg) {
    showOverlay(true, msg, '', '');
    el('btn-undo').style.display = 'none';
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayTimer = setTimeout(hideOverlay, 1200);
  }

  /* ---------- sessions ---------------------------------------------------------- */

  function renderSessions() {
    var list = Store.getSessions().slice().reverse();
    var all = Store.getAllObservations();
    var html = '';
    list.forEach(function (s) {
      var n = all.filter(function (o) { return o.session_id === s.id; }).length;
      var active = s.id === session.id;
      html += '<div class="sess' + (active ? ' active' : '') + '">' +
        '<div class="sess-name">' + esc(s.name) + (active ? ' <span class="pill">ACTIVE</span>' : '') + '</div>' +
        '<div class="sess-meta">' + esc(s.started) + ' · ' + n + ' obs' + (s.ended ? ' · ENDED' : '') + '</div>' +
        '<div class="sess-actions">' +
        (active ? '' : '<button class="btn btn-sub" data-use="' + esc(s.id) + '">USE</button>') +
        '<button class="btn btn-sub" data-rename="' + esc(s.id) + '">RENAME</button>' +
        (s.ended ? '' : '<button class="btn btn-sub" data-end="' + esc(s.id) + '">END</button>') +
        '<button class="btn btn-sub btn-danger" data-del="' + esc(s.id) + '">DELETE</button>' +
        '</div></div>';
    });
    el('sessions-body').innerHTML = html;

    function bind(attr, fn) {
      var nodes = el('sessions-body').querySelectorAll('[data-' + attr + ']');
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].addEventListener('click', function () { fn(this.getAttribute('data-' + attr)); });
      }
    }
    bind('use', function (id) {
      Store.setActiveSession(id);
      session = Store.getActiveSession();
      renderSessions(); updateCapture();
    });
    bind('rename', function (id) {
      var cur = Store.getSessions().filter(function (s) { return s.id === id; })[0];
      var name = prompt('Search name:', cur ? cur.name : '');
      if (name === null) return;
      name = name.trim();
      if (!name) return;
      var err = Store.renameSession(id, name);
      if (err) alert(err);
      session = Store.getActiveSession();
      renderSessions(); updateCapture();
    });
    bind('end', function (id) {
      if (!confirm('End this search? Its observations are kept. You can start a new search afterwards.')) return;
      var err = Store.endSession(id);
      if (err) alert(err);
      renderSessions();
    });
    bind('del', function (id) {
      var cur = Store.getSessions().filter(function (s) { return s.id === id; })[0];
      var n = Store.getObservations(id).length;
      if (!confirm('DELETE "' + (cur ? cur.name : '') + '" and its ' + n + ' observation(s)?\n\nThis cannot be undone. Export CSV first if you need the data.')) return;
      if (!confirm('Really delete? Last chance.')) return;
      var err = Store.deleteSession(id);
      if (err) { alert(err); return; }
      session = Store.getActiveSession();
      renderSessions(); updateCapture();
    });
  }

  /* ---------- settings ------------------------------------------------------------ */

  function renderSettings() {
    el('in-dec').value = settings.declination;
    var mr = document.querySelectorAll('[data-manualref]');
    for (var i = 0; i < mr.length; i++) {
      mr[i].classList.toggle('on', mr[i].getAttribute('data-manualref') === settings.manual_ref);
    }
    var sr = document.querySelectorAll('[data-sensorref]');
    for (var j = 0; j < sr.length; j++) {
      sr[j].classList.toggle('on', sr[j].getAttribute('data-sensorref') === settings.sensor_ref);
    }
    el('btn-sound').classList.toggle('on', !!settings.sound);
    el('btn-sound').textContent = 'SOUND: ' + (settings.sound ? 'ON' : 'OFF');
    el('btn-vibe').classList.toggle('on', !!settings.vibrate);
    el('btn-vibe').textContent = 'VIBRATE: ' + (settings.vibrate ? 'ON' : 'OFF');

    var all = Store.getAllObservations();
    el('storage-info').textContent = all.length + ' observation(s) across ' +
      Store.getSessions().length + ' search(es) · ~' + Math.round(Store.usageBytes() / 1024) + ' KB stored locally';
    el('about-info').textContent = 'WindMark ' + WM_VERSION + ' · schema v' + WM_SCHEMA_VERSION +
      ' · offline · data stays on this phone. Export CSV regularly.';
  }

  function saveSettings() {
    var err = Store.saveSettings(settings);
    if (err) alert(err);
    Compass.setConfig(settings.declination, settings.sensor_ref);
    renderSettings();
    updateCapture();
  }

  /* ---------- CSV export --------------------------------------------------------- */

  function csvFilename(label) {
    var d = new Date();
    var slug = String(label || 'windmark').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return 'windmark_' + (slug || 'export') + '_' +
      d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + '.csv';
  }

  function exportCSV(observations, label) {
    if (!observations.length) { alert('Nothing to export in ' + label + '.'); return; }
    var csv = Store.toCSV(observations);
    var name = csvFilename(label);
    var blob = new Blob([csv], { type: 'text/csv' });

    // Preferred on iOS: share sheet with the file attached (Save to Files,
    // Mail, AirDrop). Works with no connectivity.
    try {
      if (navigator.canShare && window.File) {
        var file = new File([blob], name, { type: 'text/csv' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: name }).catch(function (e) {
            if (e && e.name === 'AbortError') return;
            downloadBlob(blob, name);
          });
          return;
        }
      }
    } catch (e) { /* fall through to download */ }
    downloadBlob(blob, name);
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /* ---------- diagnostics (Phase 0 sensor proof) ------------------------------------ */

  function renderDiag() {
    var c = Compass.state;
    var g = Gps.state;
    var usable = usableSensorHeading(c);
    el('diag-heading').textContent = usable === null ? '---°T' : deg3(usable) + '°T';

    function n(v, dp) {
      if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return '—';
      if (typeof v === 'number') return v.toFixed(dp === undefined ? 1 : dp);
      return String(v);
    }

    var so = (window.screen && window.screen.orientation) ? window.screen.orientation : null;
    var lines = [];
    lines.push('COMPASS');
    lines.push('  status        ' + c.status);
    lines.push('  message       ' + c.message);
    lines.push('  source        ' + (c.source || '—'));
    lines.push('  permission    ' + c.permission);
    lines.push('  events        ' + c.eventCount + (c.lastEventAt ? ' (last ' + Math.round((Date.now() - c.lastEventAt)) + ' ms ago)' : ''));
    lines.push('  alpha         ' + n(c.alpha));
    lines.push('  beta          ' + n(c.beta));
    lines.push('  gamma         ' + n(c.gamma));
    lines.push('  absolute flag ' + (c.absolute === null || c.absolute === undefined ? '—' : String(c.absolute)));
    lines.push('  raw heading   ' + n(c.raw) + '   (as reported by platform)');
    lines.push('  smoothed      ' + n(c.smoothed) + '   (circular mean, ' + Compass.SMOOTH_MS + ' ms)');
    lines.push('  consistency   ' + n(c.consistency, 2) + '   (1.00 = steady, low = jittery)');
    lines.push('  reported as   ' + settings.sensor_ref.toUpperCase());
    lines.push('  declination   ' + (settings.declination >= 0 ? '+' : '') + settings.declination + '°');
    lines.push('  TRUE heading  ' + n(c.trueHeading) + '   ' + (settings.sensor_ref === 'magnetic' ? '= raw + declination' : '= raw (no correction)'));
    lines.push('  compass acc   ' + (c.accuracy === null ? 'not reported' : n(c.accuracy) + '°' + (c.accuracy < 0 ? ' (INVALID / uncalibrated)' : '')));
    lines.push('  tilt warning  ' + (c.tiltWarn ? 'YES — top edge near vertical' : 'no'));
    lines.push('');
    lines.push('GPS');
    lines.push('  status        ' + g.status);
    lines.push('  message       ' + g.message);
    lines.push('  latitude      ' + n(g.lat, 6));
    lines.push('  longitude     ' + n(g.lon, 6));
    lines.push('  accuracy      ' + (g.acc === null ? '—' : '±' + n(g.acc) + ' m'));
    lines.push('  altitude      ' + (g.alt === null ? '—' : n(g.alt) + ' m ±' + n(g.altAcc)));
    lines.push('  fix time      ' + (g.fixTime ? isoLocal(new Date(g.fixTime)) : '—'));
    lines.push('  fix age       ' + (Gps.ageMs() === null ? '—' : (Gps.ageMs() / 1000).toFixed(1) + ' s'));
    lines.push('  fixes         ' + g.fixCount);
    lines.push('');
    lines.push('SCREEN / PLATFORM');
    lines.push('  orientation   ' + (so ? so.type + ' ' + so.angle + '°' : (window.orientation !== undefined ? window.orientation + '°' : '—')));
    lines.push('  size          ' + window.innerWidth + '×' + window.innerHeight);
    lines.push('  standalone    ' + (window.matchMedia('(display-mode: standalone)').matches ||
                                     window.navigator.standalone === true ? 'YES (installed)' : 'no (browser tab)'));
    lines.push('  online        ' + (navigator.onLine ? 'yes' : 'NO (offline)'));
    lines.push('  serviceworker ' + ('serviceWorker' in navigator
      ? (navigator.serviceWorker.controller ? 'active' : 'registered/not controlling') : 'unsupported'));
    lines.push('  storage       ' + (Store.selfTest() || 'OK') + ' · ' + Math.round(Store.usageBytes() / 1024) + ' KB');
    lines.push('  version       WindMark ' + WM_VERSION);

    el('diag-body').textContent = lines.join('\n');
  }

  /* ---------- start-up ----------------------------------------------------------------- */

  function tickUI() {
    if (screen === 'capture') updateCapture();
    else if (screen === 'diag') { Compass.tick(); renderDiag(); }
    else if (screen === 'manual') updateManualPreview();
  }

  function begin() {
    Beeper.init();
    Gps.start();
    Compass.setConfig(settings.declination, settings.sensor_ref);
    Compass.start().then(function () { updateCapture(); });
    show('capture');
    updateCapture();
  }

  function wire() {
    el('btn-start').addEventListener('click', begin);

    // capture
    el('btn-mark').addEventListener('click', function () { startMark(false); });
    el('btn-manual-entry').addEventListener('click', function () { startMark(true); });
    el('btn-to-list').addEventListener('click', function () { show('list'); });
    el('btn-to-settings').addEventListener('click', function () { show('settings'); });
    el('btn-to-sessions').addEventListener('click', function () { show('sessions'); });
    el('btn-to-diag').addEventListener('click', function () { renderDiag(); show('diag'); });

    // intensity
    var ints = document.querySelectorAll('[data-intensity]');
    for (var i = 0; i < ints.length; i++) {
      ints[i].addEventListener('click', function () {
        commitIntensity(this.getAttribute('data-intensity'));
      });
    }
    el('btn-gusty').addEventListener('click', function () {
      if (!pending) return;
      pending.gusty = !pending.gusty;
      this.textContent = 'GUSTY: ' + (pending.gusty ? 'ON' : 'OFF');
      this.classList.toggle('on', pending.gusty);
    });
    el('btn-cancel-mark').addEventListener('click', cancelMark);
    el('btn-change-bearing').addEventListener('click', function () {
      manualCtx = 'change';
      openManual(pending && pending.bearing ? pending.bearing.downwind_true : null);
    });

    // manual bearing
    el('in-manual').addEventListener('input', updateManualPreview);
    var nudges = document.querySelectorAll('[data-nudge]');
    for (var k = 0; k < nudges.length; k++) {
      nudges[k].addEventListener('click', function () {
        var d = parseFloat(this.getAttribute('data-nudge'));
        var cur = readManual();
        el('in-manual').value = String(Math.round(norm360((cur === null ? 0 : cur) + d)));
        updateManualPreview();
      });
    }
    el('btn-manual-ok').addEventListener('click', acceptManual);
    el('btn-manual-back').addEventListener('click', function () {
      if (manualCtx === 'edit') { show('detail'); return; }
      if (pending && pending.bearing) { show('intensity'); return; }
      pending = null;
      show('capture');
    });

    // list / detail
    el('btn-list-back').addEventListener('click', function () { show('capture'); });
    el('btn-detail-back').addEventListener('click', function () { show('list'); });
    el('btn-export').addEventListener('click', function () {
      exportCSV(Store.getObservations(session.id), session.name);
    });

    // sessions
    el('btn-sessions-back').addEventListener('click', function () { show('capture'); });
    el('btn-new-session').addEventListener('click', function () {
      var name = prompt('Name for the new search:', 'Search ' + (Store.getSessions().length + 1));
      if (name === null) return;
      var r = Store.newSession(name.trim() || undefined);
      if (r.error) { alert(r.error); return; }
      session = Store.getActiveSession();
      renderSessions();
      updateCapture();
    });

    // settings
    el('btn-settings-back').addEventListener('click', function () { show('capture'); });
    el('in-dec').addEventListener('change', function () {
      var v = parseFloat(this.value);
      if (!isFinite(v) || v < -40 || v > 40) { alert('Declination must be between -40 and +40.'); this.value = settings.declination; return; }
      settings.declination = v;
      saveSettings();
    });
    var decs = document.querySelectorAll('[data-dec]');
    for (var d = 0; d < decs.length; d++) {
      decs[d].addEventListener('click', function () {
        settings.declination = Math.round((settings.declination + parseFloat(this.getAttribute('data-dec'))) * 10) / 10;
        if (settings.declination > 40) settings.declination = 40;
        if (settings.declination < -40) settings.declination = -40;
        saveSettings();
      });
    }
    var mrefs = document.querySelectorAll('[data-manualref]');
    for (var m = 0; m < mrefs.length; m++) {
      mrefs[m].addEventListener('click', function () {
        settings.manual_ref = this.getAttribute('data-manualref');
        saveSettings();
      });
    }
    var srefs = document.querySelectorAll('[data-sensorref]');
    for (var s = 0; s < srefs.length; s++) {
      srefs[s].addEventListener('click', function () {
        settings.sensor_ref = this.getAttribute('data-sensorref');
        saveSettings();
      });
    }
    el('btn-sound').addEventListener('click', function () {
      settings.sound = !settings.sound; Beeper.init(); saveSettings();
      if (settings.sound) Beeper.beep(true);
    });
    el('btn-vibe').addEventListener('click', function () {
      settings.vibrate = !settings.vibrate; saveSettings();
      if (settings.vibrate) buzz([40, 40, 40]);
    });
    el('btn-settings-export').addEventListener('click', function () {
      exportCSV(Store.getObservations(session.id), session.name);
    });
    el('btn-export-all').addEventListener('click', function () {
      exportCSV(Store.getAllObservations(), 'all-searches');
    });

    // diagnostics
    el('btn-diag-back').addEventListener('click', function () { show('capture'); });
    el('btn-diag-recheck').addEventListener('click', function () {
      Gps.retry();
      Compass.retry().then(renderDiag);
    });

    // overlay
    el('btn-undo').addEventListener('click', undoLast);
    el('btn-ov-done').addEventListener('click', hideOverlay);
    el('overlay').addEventListener('click', function (e) {
      if (e.target === el('overlay')) hideOverlay();
    });
  }

  function init() {
    settings = Store.getSettings();
    var storageErr = Store.selfTest();
    session = Store.getActiveSession();

    wire();

    if (storageErr || !session) {
      el('btn-start').textContent = 'STORAGE PROBLEM';
      var p = document.createElement('p');
      p.className = 'gate-error';
      p.textContent = (storageErr || 'Could not create a search.') +
        ' Observations may not survive. Turn off Private Browsing and reopen.';
      el('btn-start').parentNode.appendChild(p);
      if (!session) session = { id: 'temp', name: 'Search (unsaved)' };
    }

    uiTimer = setInterval(tickUI, 200);

    // Keep the compass honest after backgrounding: iOS pauses sensor events.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && screen !== 'gate') { Gps.start(); tickUI(); }
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function (e) {
          console.warn('Service worker registration failed:', e);
        });
      });
    }
  }

  return { init: init };
})();

document.addEventListener('DOMContentLoaded', App.init);
