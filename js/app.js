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
  var manualRef = 'magnetic'; // reference for the bearing being entered RIGHT NOW;
                              // seeded from the last choice, changeable per entry
  var pendingEditIntensity = null; // intensity waiting on a bearing during a correction
  var lastSavedId = null;
  var overlayTimer = null;
  var uiTimer = null;
  var obsCount = 0;          // cached: the capture screen redraws 5x/sec and
                             // must not re-parse stored observations each time

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
    if (name === 'capture') refreshCount();
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
    // Always true-referenced and always labelled: the sensor reading has
    // already been normalised by Compass before it reaches here.
    el('heading-big').textContent = bearingText(usable, 'true');
    el('wind-from').textContent = 'WIND FROM ' + bearingText(reciprocal(usable), 'true');
    el('heading-big').classList.toggle('dead', usable === null);

    // Show the reference actually in force for the live source, not the
    // configured guess — on iOS the source pins it to magnetic.
    el('dec-line').textContent = decText(settings.declination) +
      (st.source ? ' · sensor ' + refSuffix(st.sourceRef) : '') +
      (st.sourceRef === 'true' ? ' (no correction)' : '');

    el('top-session').textContent = session ? session.name : '—';
    el('top-count').textContent = String(obsCount);
  }

  function refreshCount() {
    obsCount = session ? Store.getObservations(session.id).length : 0;
  }

  /* A sensor heading we are willing to write into a log. The rule lives in
     Compass.isAuthoritative: status must be a clean 'ok'. Uncalibrated, poor
     reported accuracy, too much tilt, stale events, or relative-only
     orientation all mean the handler enters the bearing by hand instead. */
  function usableSensorHeading(st) {
    return Compass.authoritativeTrueHeading(st || Compass.state);
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
      // st.sourceRef is decided by the source (iOS = magnetic, always), not
      // by a global setting.
      var magneticRaw = (st.sourceRef === 'magnetic');
      pending.bearing = {
        downwind_true: Math.round(h) % 360,
        heading_magnetic_raw: magneticRaw ? Math.round(st.smoothed) % 360 : null,
        source: 'sensor',
        input_ref: st.sourceRef,
        declination_applied: magneticRaw
      };
    }

    el('in-mph').value = '';
    el('btn-gusty').textContent = 'GUSTY: OFF';
    el('btn-gusty').classList.remove('on');
    renderMarkHead();
    buzz(20);

    // Always go to the intensity screen. "No discernible wind" needs no
    // bearing, so a dead compass must not cost the handler the two-tap
    // workflow; hand entry is only demanded for a directional intensity.
    if (withManual) {
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
      el('mark-bearing').textContent = 'WIND FROM ' + bearingText(reciprocal(pending.bearing.downwind_true), 'true');
      el('mark-sub').textContent = 'blowing toward ' + bearingText(pending.bearing.downwind_true, 'true') + ' · ' +
        markSourceText(pending.bearing) +
        (pending.compassWarn ? ' · CHECK COMPASS' : '');
    } else {
      el('mark-bearing').textContent = 'NO USABLE BEARING';
      el('mark-sub').textContent =
        'No discernible wind can be saved as-is. Directional observations require a hand-entered bearing.';
    }
    el('btn-change-bearing').textContent = pending.bearing ? 'CHANGE BEARING' : 'ENTER BEARING BY HAND';
    el('mark-sub').classList.toggle('warn', !pending.bearing || !!pending.compassWarn);
  }

  /* Where the frozen bearing came from, stated with its reference so the
     handler can see the correction that was applied. */
  function markSourceText(b) {
    var src = b.source === 'sensor' ? 'phone compass' : 'by hand';
    if (b.declination_applied && b.heading_magnetic_raw !== null && b.heading_magnetic_raw !== undefined) {
      return src + ' ' + bearingText(b.heading_magnetic_raw, 'magnetic') +
             ' ' + (settings.declination >= 0 ? '+' : '−') + Math.abs(settings.declination) + '°';
    }
    return src + ' (read as TRUE °T)';
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
    refreshCount();

    var main = (intensity === 'none')
      ? 'NO DISCERNIBLE WIND'
      : 'FROM ' + bearingText(rec.from_true, 'true') + ' · ' + INTENSITY_LABEL[intensity];
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
    refreshCount();
    updateCapture();
  }

  /* ---------- manual bearing entry ------------------------------------------ */

  /* ref is optional: pass it when the prefilled number is known to be in a
     particular reference (correcting an existing observation). Otherwise the
     handler's last choice is used as the default. */
  function openManual(prefill, ref) {
    manualRef = (ref === 'magnetic' || ref === 'true') ? ref : settings.manual_ref;
    el('in-manual').value = (prefill === null || prefill === undefined) ? '' : String(Math.round(prefill));
    updateManualPreview();
    show('manual');
    setTimeout(function () { try { el('in-manual').focus(); } catch (e) {} }, 100);
  }

  /* Applies declination only when the handler said their reading is magnetic.
     A true (declination-adjusted) reading must NOT be corrected twice. */
  function manualToTrue(entered) {
    return toTrueBearing(entered, manualRef, settings.declination);
  }

  /* null when the field is empty or the typed value is outside 0..360.
     Out-of-range input is rejected, never wrapped: turning 999 into 279
     would invent a bearing nobody read. */
  function readManual() {
    return parseManualBearing(el('in-manual').value);
  }

  function manualIsBlank() { return String(el('in-manual').value).trim() === ''; }

  function updateManualPreview() {
    var mag = manualRef === 'magnetic';

    var segs = document.querySelectorAll('[data-entryref]');
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle('on', segs[i].getAttribute('data-entryref') === manualRef);
    }
    el('manual-suffix').textContent = refSuffix(manualRef);
    el('manual-ref-line').textContent = mag
      ? 'degrees MAGNETIC · ' + decText(settings.declination) + ' will be applied'
      : 'degrees TRUE · no declination correction applied';

    var v = readManual();
    var p = el('manual-preview');
    if (v === null) {
      p.innerHTML = manualIsBlank() ? '—'
        : '<span class="bad-text">' + esc(MANUAL_RANGE_MESSAGE) + '</span>';
      return;
    }
    var t = manualToTrue(v);
    // Show the conversion, not just the result, so a wrong M/T choice is
    // obvious before it is committed.
    p.innerHTML = (mag ? '<span class="conv">' + esc(bearingText(v, 'magnetic')) + ' &rarr; </span>' : '') +
      'blowing toward <b>' + esc(bearingText(t, 'true')) + '</b><br>WIND FROM <b>' +
      esc(bearingText(reciprocal(t), 'true')) + '</b>';
  }

  function acceptManual() {
    var v = readManual();
    if (v === null) { alert(MANUAL_RANGE_MESSAGE); return; }
    var t = Math.round(manualToTrue(v)) % 360;
    var b = {
      downwind_true: t,
      // Raw magnetic is provenance only. A true-referenced entry has no
      // magnetic reading, and we will not back-compute a fake one.
      heading_magnetic_raw: manualRef === 'magnetic' ? Math.round(v) % 360 : null,
      source: 'manual',
      input_ref: manualRef,
      declination_applied: manualRef === 'magnetic'
    };

    // Remember this choice as the default for the next hand entry.
    if (settings.manual_ref !== manualRef) {
      settings.manual_ref = manualRef;
      Store.saveSettings(settings);
    }

    if (manualCtx === 'edit' && detailId) {
      var patch = {
        downwind_true: b.downwind_true,
        from_true: reciprocal(b.downwind_true),
        heading_magnetic_raw: b.heading_magnetic_raw,
        declination: settings.declination,
        declination_applied: b.declination_applied,
        bearing_source: 'manual',
        bearing_input_ref: b.input_ref
      };
      // A bearing may only be attached together with a directional intensity,
      // so switching "no discernible wind" to a directional category carries
      // the new intensity in the same write.
      if (pendingEditIntensity) patch.intensity = pendingEditIntensity;
      pendingEditIntensity = null;
      var err = Store.updateObservation(detailId, patch);
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
      var nodir = (o.from_true === null || o.from_true === undefined);
      var dir = nodir ? 'No discernible wind' : 'From ' + bearingText(o.from_true, 'true');
      var inten = o.intensity === 'none' ? '—' : INTENSITY_LABEL[o.intensity] || o.intensity;
      var extra = '';
      if (o.gusty) extra += ' G';
      if (o.speed_mph !== null && o.speed_mph !== undefined) extra += ' ' + o.speed_mph + 'mph';
      if (o.bearing_source === 'manual') extra += ' ✎';
      var acc = (o.acc_m === null || o.acc_m === undefined) ? '—' : '±' + Math.round(o.acc_m) + 'm';
      html += '<button class="row" data-obs="' + esc(o.id) + '">' +
        '<span class="c-time">' + esc(time) + '</span>' +
        '<span class="c-dir' + (nodir ? ' nodir' : '') + '">' + esc(dir) + '</span>' +
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
        : 'WIND FROM ' + bearingText(o.from_true, 'true')) + '</div>';
    html += '<div class="detail-sub">' + esc(INTENSITY_LABEL[o.intensity] || o.intensity) +
      (o.gusty ? ' · GUSTY' : '') +
      (o.speed_mph !== null && o.speed_mph !== undefined ? ' · ' + o.speed_mph + ' mph Kestrel' : '') +
      '</div>';

    html += row('time', o.t);
    html += row('wind toward (true)', o.downwind_true === null || o.downwind_true === undefined
      ? '—' : bearingText(o.downwind_true, 'true'));
    html += row('wind from (true)', o.from_true === null || o.from_true === undefined
      ? '—' : bearingText(o.from_true, 'true'));
    html += row('bearing source', o.bearing_source);
    html += row('reading taken as', o.bearing_input_ref ? refWord(o.bearing_input_ref) + ' ' + refSuffix(o.bearing_input_ref) : '—');
    html += row('raw input (provenance)', o.heading_magnetic_raw === null || o.heading_magnetic_raw === undefined
      ? '—' : bearingText(o.heading_magnetic_raw, 'magnetic'));
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

    // No bearing control for "no discernible wind" — attaching a direction
    // to it would be a contradiction, so the path does not exist.
    html += '<div class="fix-grid2">' +
      (o.intensity === 'none' ? ''
        : '<button class="btn btn-fix" id="btn-fix-bearing">CORRECT BEARING</button>') +
      '<button class="btn btn-fix' + (o.gusty ? ' on' : '') + '" id="btn-fix-gusty">GUSTY: ' + (o.gusty ? 'ON' : 'OFF') + '</button>' +
      '</div>' +
      (o.intensity === 'none'
        ? '<div class="set-help">No discernible wind carries no bearing. Choose a directional intensity above to add one.</div>'
        : '');

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
        var cur = Store.getObservation(detailId);
        if (!cur || cur.intensity === k) return;

        if (k === 'none') {
          // "No discernible wind" must not retain a direction: clear the
          // bearing and its whole provenance trail in one write.
          var patch = { intensity: 'none' };
          var nulls = Store.noDirectionFields();
          for (var n in nulls) patch[n] = nulls[n];
          var e1 = Store.updateObservation(detailId, patch);
          if (e1) alert(e1);
          renderDetail();
          return;
        }

        if (!Store.hasBearing(cur)) {
          // Directional intensity on an observation with no direction: the
          // handler must supply a bearing before the change can be accepted.
          pendingEditIntensity = k;
          manualCtx = 'edit';
          openManual(null);
          return;
        }

        var e2 = Store.updateObservation(detailId, { intensity: k });
        if (e2) alert(e2);
        renderDetail();
      });
    }

    if (el('btn-fix-bearing')) {
      el('btn-fix-bearing').addEventListener('click', function () {
        var cur = Store.getObservation(detailId);
        // Guarded by the button not existing for 'none', but never trust one
        // guard for an invariant this important.
        if (!cur || cur.intensity === 'none') {
          alert('Set a directional intensity first — no discernible wind carries no bearing.');
          return;
        }
        manualCtx = 'edit';
        pendingEditIntensity = null;
        if (cur.bearing_input_ref === 'magnetic' && cur.heading_magnetic_raw !== null &&
            cur.heading_magnetic_raw !== undefined) {
          openManual(cur.heading_magnetic_raw, 'magnetic');   // re-edit the reading as taken
        } else {
          openManual(cur.downwind_true === undefined ? null : cur.downwind_true, 'true');
        }
      });
    }

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
        '<div class="sess-meta">' + esc(s.started) + ' · ' + n + ' obs</div>' +
        '<div class="sess-actions">' +
        (active ? '' : '<button class="btn btn-sub" data-use="' + esc(s.id) + '">USE</button>') +
        '<button class="btn btn-sub" data-rename="' + esc(s.id) + '">RENAME</button>' +
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
      refreshCount();
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
      // Exports read the current name by session_id, so a rename shows up in
      // the next CSV without rewriting any stored observation.
      session = Store.getActiveSession();
      renderSessions(); updateCapture();
    });
    bind('del', function (id) {
      var cur = Store.getSessions().filter(function (s) { return s.id === id; })[0];
      var n = Store.getObservations(id).length;
      if (!confirm('DELETE "' + (cur ? cur.name : '') + '" and its ' + n + ' observation(s)?\n\nThis cannot be undone. Export CSV first if you need the data.')) return;
      if (!confirm('Really delete? Last chance.')) return;
      var err = Store.deleteSession(id);
      if (err) { alert(err); return; }
      session = Store.getActiveSession();
      refreshCount();
      renderSessions(); updateCapture();
    });
  }

  /* ---------- settings ------------------------------------------------------------ */

  function renderSettings() {
    el('in-dec').value = settings.declination;

    // The iOS heading is magnetic by Apple's documentation, so there is
    // nothing to choose: hide the control and say why. needsPermission() is
    // an Apple-only API, so it identifies the platform even before the first
    // orientation event has arrived.
    var iosLocked = (Compass.state.source === 'ios') || Compass.needsPermission();
    el('seg-sensor-ref').style.display = iosLocked ? 'none' : '';
    el('sensor-ref-help').innerHTML = iosLocked
      ? 'This iPhone reports <b>webkitCompassHeading</b>, which Apple documents as relative to ' +
        '<b>magnetic north</b>. WindMark always treats it as MAGNETIC °M and applies the declination ' +
        'above to get the true bearing. Not adjustable.'
      : 'Applies only to the Android / absolute-orientation fallback, whose reference the ' +
        'browser does not document. Default MAGNETIC °M (declination applied). Check it on the ' +
        'SENSOR PROOF screen against your Silva; if the phone already matches true bearings ' +
        'without the correction, switch to TRUE °T. It has no effect on iPhone.';
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
    el('persist-info').textContent = 'Persistent storage: ' + Offline.persistenceText() + '.';
    el('about-info').textContent = 'WindMark ' + WM_VERSION + ' · schema v' + WM_SCHEMA_VERSION +
      ' · cache ' + WM_CACHE_NAME + ' · data stays on this phone.';
    renderReadyBox('set-ready');
    renderChecks('set-checks');
  }

  function saveSettings() {
    var err = Store.saveSettings(settings);
    if (err) alert(err);
    Compass.setConfig(settings.declination, settings.sensor_ref);
    renderSettings();
    updateCapture();
  }

  /* ---------- offline readiness / pre-search check --------------------------------

     Rendered into Settings, the Sensor Proof screen, and one compact line on
     the START screen. Deliberately NOT on the capture screen: that screen
     stays Point -> MARK WIND -> intensity. */

  function renderReadyBox(id) {
    var box = el(id);
    if (!box) return;
    var st = Offline.state;
    box.classList.toggle('ready', st.ready);
    box.classList.toggle('notready', !st.ready);
    box.querySelector('.ready-title').textContent = st.title;
    box.querySelector('.ready-detail').textContent = st.detail;
    box.querySelector('.ready-hint').textContent = st.hint;
  }

  function renderChecks(id) {
    var host = el(id);
    if (!host) return;
    var rows = Offline.preSearchChecks({
      offlineReady: Offline.state.ready,
      storageError: Store.selfTest(),
      gps: {
        supported: !!navigator.geolocation,
        status: Gps.state.status,
        hasFix: Gps.state.fixCount > 0
      },
      compass: { status: Compass.state.status, message: Compass.state.message }
    });
    var html = '';
    rows.forEach(function (r) {
      html += '<div class="check ' + r.state + '">' +
        '<span class="check-mark">' + (r.state === 'pass' ? '✓' : '!') + '</span>' +
        '<span class="check-body"><span class="check-label">' + esc(r.label) + '</span>' +
        '<span class="check-detail">' + esc(r.detail) + '</span></span></div>';
    });
    host.innerHTML = html;
  }

  function renderReadiness() {
    renderReadyBox('set-ready');
    renderReadyBox('diag-ready');
    renderChecks('set-checks');
    renderChecks('diag-checks');
    var gate = el('gate-ready');
    if (gate) {
      gate.textContent = Offline.state.checked
        ? Offline.state.title + ' · ' + Offline.state.detail
        : 'Checking offline readiness…';
      gate.classList.toggle('ready', Offline.state.ready);
      gate.classList.toggle('notready', Offline.state.checked && !Offline.state.ready);
    }
  }

  /* Re-reads the cache rather than trusting a cached verdict. */
  function refreshReadiness() {
    return Offline.check().then(function () {
      renderReadiness();
      return Offline.state;
    });
  }

  /* ---------- CSV export --------------------------------------------------------- */

  function csvFilename(label) {
    var d = new Date();
    var slug = String(label || 'windmark').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return 'windmark_' + (slug || 'export') + '_' +
      d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + '.csv';
  }

  /* provenance = true exports the debugging file (raw magnetic included).
     The default export carries true-referenced wind bearings only. */
  function exportCSV(observations, label, provenance) {
    if (!observations.length) { alert('Nothing to export in ' + label + '.'); return; }
    var csv = provenance ? Store.toProvenanceCSV(observations) : Store.toCSV(observations);
    var name = csvFilename(label + (provenance ? '-provenance' : ''));
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
    el('diag-heading').textContent = bearingText(usable, 'true');

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
    lines.push('  -- raw orientation angles below are not bearings --');
    lines.push('  alpha         ' + n(c.alpha));
    lines.push('  beta          ' + n(c.beta));
    lines.push('  gamma         ' + n(c.gamma));
    lines.push('  absolute flag ' + (c.absolute === null || c.absolute === undefined ? '—' : String(c.absolute)));
    // The reference is a property of the source, not of a global setting.
    var sref = c.sourceRef;
    lines.push('  raw sensor    ' + n(c.raw) + refSuffix(sref) + '   (as reported by platform)');
    lines.push('  smoothed      ' + n(c.smoothed) + refSuffix(sref) + '   (circular mean, ' + Compass.SMOOTH_MS + ' ms)');
    lines.push('  consistency   ' + n(c.consistency, 2) + '   (1.00 = steady, low = jittery)');
    lines.push('  reference     ' + refWord(sref) + ' ' + refSuffix(sref) +
      (c.refLocked ? '   (fixed: iOS webkitCompassHeading is magnetic)' : '   (configurable fallback)'));
    lines.push('  declination   ' + (settings.declination >= 0 ? '+' : '−') +
      Math.abs(settings.declination) + '°' + (settings.declination >= 0 ? 'E' : 'W'));
    lines.push('  computed head ' + n(c.trueHeading) + '°T   ' +
      (sref === 'magnetic' ? '= raw°M + declination' : '= raw°T (no correction)'));
    lines.push('  authoritative ' + (Compass.isAuthoritative(c)
      ? 'YES — may be saved as a wind bearing'
      : 'NO — status must be ok; use bearing by hand'));
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
    lines.push('  offline ready ' + (Offline.state.checked ? (Offline.state.ready ? 'YES' : 'NO — ' + Offline.state.reason) : 'not checked'));
    lines.push('  app cache     ' + WM_CACHE_NAME + ' · ' + WM_ASSETS.length + ' files' +
      (Offline.state.missing.length ? ' · MISSING: ' + Offline.state.missing.join(', ') : ''));
    lines.push('  persistent    ' + Offline.persistenceText());
    lines.push('  storage       ' + (Store.selfTest() || 'OK') + ' · ' + Math.round(Store.usageBytes() / 1024) + ' KB');
    lines.push('  version       WindMark ' + WM_VERSION);

    el('diag-body').textContent = lines.join('\n');
    renderReadyBox('diag-ready');
    renderChecks('diag-checks');
  }

  /* ---------- start-up ----------------------------------------------------------------- */

  function tickUI() {
    if (screen === 'capture') updateCapture();
    else if (screen === 'diag') { Compass.tick(); renderDiag(); }
    else if (screen === 'manual') updateManualPreview();
  }

  function begin() {
    Beeper.init();

    // Ask for persistent storage at most once, from this user gesture. Chrome
    // grants it silently to installed PWAs; Safari does not implement it. The
    // app never depends on the answer.
    Offline.requestPersistence(!!settings.persist_asked, function (granted, didAsk) {
      if (didAsk) {
        settings.persist_asked = true;
        Store.saveSettings(settings);
      }
    });

    Gps.start();
    Compass.setConfig(settings.declination, settings.sensor_ref);
    Compass.start().then(function () { updateCapture(); });
    show('capture');
    updateCapture();
    refreshReadiness();
  }

  function wire() {
    el('btn-start').addEventListener('click', begin);

    // capture
    el('btn-mark').addEventListener('click', function () { startMark(false); });
    el('btn-manual-entry').addEventListener('click', function () { startMark(true); });
    el('btn-to-list').addEventListener('click', function () { show('list'); });
    el('btn-to-settings').addEventListener('click', function () { show('settings'); refreshReadiness(); });
    el('btn-to-sessions').addEventListener('click', function () { show('sessions'); });
    el('btn-to-diag').addEventListener('click', function () { renderDiag(); show('diag'); refreshReadiness(); });

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
    var erefs = document.querySelectorAll('[data-entryref]');
    for (var r = 0; r < erefs.length; r++) {
      erefs[r].addEventListener('click', function () {
        manualRef = this.getAttribute('data-entryref');
        updateManualPreview();
      });
    }
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
      if (manualCtx === 'edit') { pendingEditIntensity = null; show('detail'); return; }
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
      refreshCount();
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
    el('btn-export-prov').addEventListener('click', function () {
      exportCSV(Store.getAllObservations(), 'all-searches', true);
    });

    el('btn-recheck').addEventListener('click', function () {
      el('set-ready').querySelector('.ready-title').textContent = 'Checking…';
      refreshReadiness();
    });

    // diagnostics
    el('btn-diag-back').addEventListener('click', function () { show('capture'); });
    el('btn-diag-recheck').addEventListener('click', function () {
      Gps.retry();
      refreshReadiness();
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
    refreshCount();

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

    refreshReadiness();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function () {
          // The first install finishes after this call; re-check once it has
          // taken control so the START screen stops saying NOT READY.
          return navigator.serviceWorker.ready;
        }).then(function () {
          refreshReadiness();
        }).catch(function (e) {
          console.warn('Service worker registration failed:', e);
          refreshReadiness();
        });
        navigator.serviceWorker.addEventListener('controllerchange', refreshReadiness);
      });
    }
  }

  return { init: init };
})();

document.addEventListener('DOMContentLoaded', App.init);
