/* WindMark browser regression checks.

   Drives the real UI in Chromium with a faked compass and GPS, then asserts
   what actually landed in storage. It covers the behaviour that cannot be
   reached from tools/selfcheck.js: screen flow, edit transitions, and input
   rejection.

   This is the only piece of the project that needs anything installed, and
   nothing in the app depends on it. Run it when you have Playwright to hand:

     npm i playwright            # or use an existing install
     python3 -m http.server 8765 # from the project root
     node tools/browsercheck.js

   Override with WINDMARK_URL and CHROMIUM_PATH if your setup differs.
   tools/selfcheck.js stays dependency-free and is the one to run by default. */

const { chromium, devices } = require('playwright');

const URL = process.env.WINDMARK_URL || 'http://127.0.0.1:8765/index.html';
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;

(async () => {
  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const ctx = await browser.newContext({ ...devices['iPhone 13'], permissions: ['geolocation'],
    geolocation: { latitude: 39.8, longitude: -105.2, accuracy: 6 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', name, extra === undefined ? '' : '[' + extra + ']'); } };

  // Dialogs: record and auto-dismiss.
  let lastDialog = null;
  // Dialogs: recorded, and answered from a plan when one is set so a
  // confirmation can be deliberately refused.
  const seen = [];
  let plan = null;          // e.g. [true, false] = accept the first, refuse the second
  let promptText = null;    // what a prompt() should return
  page.on('dialog', async d => {
    lastDialog = d.message();
    seen.push(d.message());
    let answer = true;
    if (plan && plan.length) answer = plan.shift();
    if (d.type() === 'prompt') { answer ? await d.accept(promptText || '') : await d.dismiss(); return; }
    answer ? await d.accept() : await d.dismiss();
  });

  await page.goto(URL);
  await page.click('#btn-start');
  await page.waitForTimeout(600);

  const feedIos = async (heading, accuracy = 5) => {
    await page.evaluate(([h, a]) => {
      if (window.__feed) clearInterval(window.__feed);
      const fire = () => { const e = new Event('deviceorientation');
        e.webkitCompassHeading = h; e.webkitCompassAccuracy = a; e.alpha = 12; e.beta = 8; e.gamma = 1;
        window.dispatchEvent(e); };
      fire(); window.__feed = setInterval(fire, 60);
    }, [heading, accuracy]);
    await page.waitForTimeout(700);
  };
  const stopFeed = async () => { await page.evaluate(() => { if (window.__feed) clearInterval(window.__feed); }); await page.waitForTimeout(2600); };
  const dump = () => page.evaluate(() => JSON.parse(localStorage.getItem('windmark.v1.observations') || '[]'));

  // ---- 1. iOS heading is magnetic even with the fallback set to TRUE ----
  await feedIos(97);
  await page.click('#btn-to-settings'); await page.waitForTimeout(150);
  const segHidden = await page.isHidden('#seg-sensor-ref');
  ok('sensor-ref control hidden once the iOS source is live', segHidden);
  const help = await page.textContent('#sensor-ref-help');
  ok('settings explain the iOS lock', /magnetic north/i.test(help) && /Not adjustable/i.test(help), help.slice(0, 60));
  await page.click('#btn-settings-back'); await page.waitForTimeout(150);
  ok('capture shows 105°T from 97°M + 8°E', (await page.textContent('#heading-big')) === '105°T',
    await page.textContent('#heading-big'));
  await page.click('#btn-to-diag'); await page.waitForTimeout(400);
  const diag = await page.textContent('#diag-body');
  ok('diag labels the raw sensor value °M', /raw sensor\s+97\.0°M/.test(diag), (diag.match(/raw sensor.*/) || [''])[0]);
  ok('diag shows declination +8°E', /declination\s+\+8°E/.test(diag), (diag.match(/declination.*/) || [''])[0]);
  ok('diag shows computed heading °T', /computed head\s+105\.0°T/.test(diag), (diag.match(/computed head.*/) || [''])[0]);
  ok('diag marks the iOS reference fixed', /fixed: iOS/.test(diag));
  ok('diag reports authoritative YES', /authoritative YES/.test(diag));
  await page.click('#btn-diag-back');

  // ---- 2. unreliable compass cannot produce a sensor bearing ----
  await feedIos(97, -1);   // uncalibrated
  ok('uncalibrated shows no heading', (await page.textContent('#heading-big')) === '---°T');
  ok('uncalibrated warns', /uncalibrated/i.test(await page.textContent('#compass-line')));
  await page.click('#btn-mark'); await page.waitForTimeout(150);
  ok('mark with uncalibrated compass reaches the intensity screen', await page.isVisible('[data-intensity="none"]'));
  ok('intensity screen says NO USABLE BEARING', (await page.textContent('#mark-bearing')) === 'NO USABLE BEARING');
  ok('intensity screen explains the rule', /No discernible wind can be saved as-is/.test(await page.textContent('#mark-sub')));

  // ---- 3. No discernible wind saves in two taps with no bearing ----
  await page.click('[data-intensity="none"]'); await page.waitForTimeout(250);
  ok('no-bearing none saves', (await page.textContent('#ov-title')) === 'SAVED', await page.textContent('#ov-title'));
  ok('confirmation wording', (await page.textContent('#ov-main')) === 'NO DISCERNIBLE WIND', await page.textContent('#ov-main'));
  await page.click('#btn-ov-done');
  let obs = await dump();
  const none = obs[obs.length - 1];
  ok('stored none has no direction at all',
    none.intensity === 'none' && none.downwind_true === null && none.from_true === null &&
    none.heading_magnetic_raw === null && none.bearing_source === null &&
    none.bearing_input_ref === null && none.declination_applied === false, JSON.stringify(none.bearing_source));

  // ---- 3b. a typed speed is "measured", with no brand name in sight ----
  await page.click('#btn-mark'); await page.waitForTimeout(120);
  ok('the speed field is labelled MEASURED',
    /MEASURED/.test(await page.textContent('.mph-label')), await page.textContent('.mph-label'));
  ok('no brand name on the intensity screen',
    !/kestrel/i.test(await page.textContent('#screen-intensity')));
  await page.fill('#in-mph', '7.8');
  await page.click('[data-entryref="true"]').catch(() => {});
  await page.click('#btn-change-bearing'); await page.waitForTimeout(150);
  await page.click('[data-entryref="true"]');
  await page.fill('#in-manual', '284');
  await page.click('#btn-manual-ok'); await page.waitForTimeout(150);
  await page.fill('#in-mph', '7.8');
  await page.click('[data-intensity="light"]'); await page.waitForTimeout(250);
  ok('the confirmation says the speed was measured',
    /7\.8 mph measured/.test(await page.textContent('#ov-sub')), await page.textContent('#ov-sub'));
  await page.click('#btn-ov-done');
  obs = await dump();
  const measured = obs[obs.length - 1];
  ok('a typed speed stores speed_source "measured"', measured.speed_source === 'measured',
    String(measured.speed_source));
  ok('the number itself is stored unchanged', measured.speed_mph === 7.8, String(measured.speed_mph));
  ok('no stored record mentions a brand name',
    !/kestrel/i.test(JSON.stringify(obs)));

  // ---- 4. directional with no bearing must go through manual entry ----
  await page.click('#btn-mark'); await page.waitForTimeout(120);
  await page.click('[data-intensity="moderate"]'); await page.waitForTimeout(250);
  ok('directional with no bearing diverts to hand entry', await page.isVisible('#in-manual'));

  // ---- 5. manual range rejection ----
  lastDialog = null;
  await page.fill('#in-manual', '999'); await page.waitForTimeout(150);
  ok('999 shows the range error in the preview', /000° to 360°/.test(await page.textContent('#manual-preview')),
    await page.textContent('#manual-preview'));
  await page.click('#btn-manual-ok'); await page.waitForTimeout(200);
  ok('999 is rejected with a message', lastDialog === 'Enter a bearing from 000° to 360°.', lastDialog);
  ok('999 did not become 279', await page.isVisible('#in-manual'));
  lastDialog = null;
  await page.fill('#in-manual', '-1'); await page.click('#btn-manual-ok'); await page.waitForTimeout(150);
  ok('-1 is rejected', lastDialog !== null && await page.isVisible('#in-manual'));
  lastDialog = null;
  await page.fill('#in-manual', '361'); await page.click('#btn-manual-ok'); await page.waitForTimeout(150);
  ok('361 is rejected', lastDialog !== null && await page.isVisible('#in-manual'));

  // 360 normalises to 000 (magnetic entry, +8 -> 008°T)
  await page.click('[data-entryref="magnetic"]');
  await page.fill('#in-manual', '360'); await page.waitForTimeout(200);
  const prev360 = (await page.textContent('#manual-preview')).replace(/\s+/g, ' ');
  ok('360 previews as 000°M', /000°M/.test(prev360), prev360);
  await page.click('#btn-manual-ok'); await page.waitForTimeout(250);
  obs = await dump();
  const saved360 = obs[obs.length - 1];
  ok('360°M entry saved as 008°T toward', saved360.downwind_true === 8, String(saved360.downwind_true));
  ok('360°M entry stored raw 000°M', saved360.heading_magnetic_raw === 0, String(saved360.heading_magnetic_raw));
  ok('360°M entry is the pending moderate intensity', saved360.intensity === 'moderate');
  await page.click('#btn-ov-done');

  // ---- 6. edit transitions ----
  await page.click('#btn-to-list'); await page.waitForTimeout(200);
  await page.click('.row'); await page.waitForTimeout(200);   // newest = the 008°T moderate
  ok('CORRECT BEARING exists for a directional observation', await page.isVisible('#btn-fix-bearing'));
  await page.click('[data-fixint="none"]'); await page.waitForTimeout(250);
  obs = await dump();
  const nowNone = obs.find(o => o.id === saved360.id);
  ok('moderate -> none clears direction',
    nowNone.intensity === 'none' && nowNone.downwind_true === null && nowNone.from_true === null &&
    nowNone.heading_magnetic_raw === null && nowNone.bearing_source === null &&
    nowNone.bearing_input_ref === null && nowNone.declination_applied === false);
  ok('CORRECT BEARING is gone for no discernible wind', !(await page.isVisible('#btn-fix-bearing')));
  ok('detail explains why', /No discernible wind carries no bearing/.test(await page.textContent('.detail-body')));

  await page.click('[data-fixint="moderate"]'); await page.waitForTimeout(250);
  ok('none -> moderate asks for a bearing first', await page.isVisible('#in-manual'));
  obs = await dump();
  ok('nothing changed while the bearing is pending',
    obs.find(o => o.id === saved360.id).intensity === 'none');
  await page.click('[data-entryref="true"]');
  await page.fill('#in-manual', '284');
  await page.click('#btn-manual-ok'); await page.waitForTimeout(300);
  obs = await dump();
  const fixed = obs.find(o => o.id === saved360.id);
  ok('none -> moderate applied with the bearing in one write',
    fixed.intensity === 'moderate' && fixed.downwind_true === 284 && fixed.from_true === 104 &&
    fixed.heading_magnetic_raw === null && fixed.declination_applied === false &&
    fixed.bearing_input_ref === 'true', JSON.stringify([fixed.intensity, fixed.downwind_true, fixed.from_true]));

  // Backing out of a pending intensity change must leave the record alone.
  await page.click('[data-fixint="none"]'); await page.waitForTimeout(200);
  await page.click('[data-fixint="strong"]'); await page.waitForTimeout(200);
  ok('pending change opened hand entry again', await page.isVisible('#in-manual'));
  await page.click('#btn-manual-back'); await page.waitForTimeout(200);
  obs = await dump();
  ok('cancelled edit left it as no discernible wind',
    obs.find(o => o.id === saved360.id).intensity === 'none');

  // ---- 7. list wording ----
  await page.click('#btn-detail-back'); await page.waitForTimeout(200);
  const rows = await page.$$eval('.row', rs => rs.map(r => r.innerText.replace(/\n/g, ' ')));
  ok('list says No discernible wind', rows.some(r => /No discernible wind/.test(r)), rows[0]);
  ok('list never says bare "no wind"', !rows.some(r => /\bno wind\b/i.test(r)));

  // ---- 8. search rename reaches the export ----
  await page.click('#btn-list-back');
  await page.click('#btn-to-sessions'); await page.waitForTimeout(250);
  ok('no END button on searches', (await page.$$('[data-end]')).length === 0);
  ok('row actions are not crowded onto the list rows',
    (await page.$$('#sessions-body .btn-danger')).length === 0);
  const activeId = await page.evaluate(() => Store.getActiveSession().id);
  await page.click(`#sessions-body [data-session="${activeId}"]`); await page.waitForTimeout(250);
  promptText = 'Drainage Sweep';
  await page.click('#btn-rename-search'); await page.waitForTimeout(250);
  const csv = await page.evaluate(() => Store.toCSV(Store.getAllObservations()));
  ok('renamed search appears in the export', /Drainage Sweep/.test(csv));
  ok('stored record keeps its capture-time name',
    (await dump()).some(o => o.session_name === 'Search 1'));
  await page.click('#btn-search-back'); await page.waitForTimeout(150);

  // ---- 9. stale sensor is refused ----
  await page.click('#btn-sessions-back');
  await feedIos(97);
  ok('live feed is authoritative again', (await page.textContent('#heading-big')) === '105°T');
  await stopFeed();
  ok('stale sensor shows no heading', (await page.textContent('#heading-big')) === '---°T');
  ok('stale sensor is explained', /stopped sending/i.test(await page.textContent('#compass-line')),
    await page.textContent('#compass-line'));
  await page.click('#btn-mark'); await page.waitForTimeout(150);
  ok('stale mark still offers no-discernible-wind', (await page.textContent('#mark-bearing')) === 'NO USABLE BEARING');
  await page.click('#btn-cancel-mark');

  // ---- 10. the capture screen fits one portrait viewport, no scrolling ----
  // Chromium reports env(safe-area-inset-*) as 0, so the insets are simulated
  // with a padding override: that keeps the rule under test (height 100dvh +
  // border-box) and proves the padding comes out of the viewport height
  // rather than being added to it.
  const SIZES = [
    { w: 390, h: 844, label: 'iPhone 13/14', insets: [47, 34] },
    { w: 393, h: 852, label: 'iPhone 15/16', insets: [59, 34] },
    { w: 430, h: 932, label: 'iPhone Pro Max', insets: [59, 34] },
    { w: 375, h: 667, label: 'iPhone SE', insets: [20, 0] },
    { w: 360, h: 640, label: 'small Android', insets: [24, 0] }
  ];

  await page.click('#btn-cancel-mark').catch(() => {});
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.addStyleTag({ content:
      `body { padding: ${s.insets[0]}px 0 ${s.insets[1]}px 0 !important; }` });
    await page.waitForTimeout(250);

    const m = await page.evaluate(() => {
      const cap = document.getElementById('screen-capture');
      const box = (id) => document.getElementById(id).getBoundingClientRect();
      return {
        innerH: window.innerHeight,
        docScroll: document.documentElement.scrollHeight,
        bodyH: document.body.getBoundingClientRect().height,
        screenScroll: cap.scrollHeight,
        screenClient: cap.clientHeight,
        mark: box('btn-mark'),
        manual: box('btn-manual-entry'),
        sensors: box('btn-to-diag'),
        topbar: box('btn-to-list'),
        bearingFont: parseFloat(getComputedStyle(document.getElementById('heading-big')).fontSize),
        windFrom: box('wind-from'),
        dec: box('dec-line')
      };
    });

    ok(`${s.label}: document does not scroll`, m.docScroll <= m.innerH + 1,
      `${m.docScroll} > ${m.innerH}`);
    ok(`${s.label}: capture screen does not scroll`, m.screenScroll <= m.screenClient + 1,
      `${m.screenScroll} > ${m.screenClient}`);
    ok(`${s.label}: body fits the viewport exactly`, Math.abs(m.bodyH - m.innerH) <= 1,
      `${m.bodyH} vs ${m.innerH}`);
    ok(`${s.label}: top bar is below the notch`, m.topbar.top >= s.insets[0] - 1,
      String(Math.round(m.topbar.top)));
    ok(`${s.label}: MARK WIND fully visible`, m.mark.bottom <= m.innerH + 1 && m.mark.top >= 0,
      `${Math.round(m.mark.top)}..${Math.round(m.mark.bottom)} of ${m.innerH}`);
    ok(`${s.label}: ENTER BEARING BY HAND fully visible`, m.manual.bottom <= m.innerH + 1,
      `${Math.round(m.manual.bottom)} of ${m.innerH}`);
    ok(`${s.label}: SENSORS fully visible`, m.sensors.bottom <= m.innerH + 1,
      `${Math.round(m.sensors.bottom)} of ${m.innerH}`);
    ok(`${s.label}: nothing sits under the Home indicator`,
      m.sensors.bottom <= m.innerH - s.insets[1] + 1,
      `${Math.round(m.sensors.bottom)} vs ${m.innerH - s.insets[1]}`);
    ok(`${s.label}: WIND FROM and declination visible`,
      m.windFrom.bottom <= m.innerH && m.dec.bottom <= m.innerH);
    ok(`${s.label}: MARK WIND stays dominant`, m.mark.height >= 110,
      String(Math.round(m.mark.height)));
    ok(`${s.label}: secondary controls stay glove-sized`,
      m.manual.height >= 60 && m.sensors.height >= 60,
      `${Math.round(m.manual.height)} / ${Math.round(m.sensors.height)}`);
    ok(`${s.label}: bearing stays large`, m.bearingFont >= 60, String(Math.round(m.bearingFont)));
  }

  // A long compass warning wraps to three lines: still no scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({ content: 'body { padding: 47px 0 34px 0 !important; }' });
  await page.evaluate(() => {
    document.getElementById('compass-line').textContent =
      'No usable heading right now. Move the phone slightly, or use bearing by hand.';
  });
  await page.waitForTimeout(200);
  const tight = await page.evaluate(() => ({
    innerH: window.innerHeight,
    docScroll: document.documentElement.scrollHeight,
    sensors: document.getElementById('btn-to-diag').getBoundingClientRect().bottom
  }));
  ok('a three-line compass warning still fits', tight.docScroll <= tight.innerH + 1,
    `${tight.docScroll} > ${tight.innerH}`);
  ok('SENSORS still visible with the warning shown', tight.sensors <= tight.innerH + 1);

  // Long screens must still reach their own bottom by scrolling inside.
  await page.click('#btn-to-settings');
  await page.waitForTimeout(300);
  const settings = await page.evaluate(() => {
    const el = document.getElementById('screen-settings');
    el.scrollTop = el.scrollHeight;
    return {
      scrollable: el.scrollHeight > el.clientHeight,
      reachedBottom: Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) <= 2,
      aboutVisible: document.getElementById('about-info').getBoundingClientRect().bottom <= window.innerHeight + 1
    };
  });
  ok('Settings scrolls inside its own screen', settings.scrollable);
  ok('Settings can be scrolled to the very bottom', settings.reachedBottom);
  ok('the last Settings line is reachable, not clipped', settings.aboutVisible);
  await page.click('#btn-settings-back');

  // ---- 11. folders, searches, and destructive safeguards ----
  const store = (fn, arg) => page.evaluate(fn, arg);
  const sessionsOf = () => page.evaluate(() => Store.getSessions().map(s => ({
    id: s.id, name: s.name, folder_id: s.folder_id })));
  const foldersOf = () => page.evaluate(() => Store.getFolders().map(f => ({ id: f.id, name: f.name })));
  const countIn = (id) => page.evaluate((i) => Store.countObservations(i), id);

  await page.setViewportSize({ width: 390, height: 844 });
  // A search written before folders existed, seeded straight into storage.
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('windmark.v1.sessions') || '[]');
    raw.push({ id: 'legacy-x', name: 'Legacy Search', started: '2026-08-01T09:00:00-06:00' });
    localStorage.setItem('windmark.v1.sessions', JSON.stringify(raw));
  });
  await page.click('#btn-to-sessions'); await page.waitForTimeout(300);
  let bodyText = await page.textContent('#sessions-body');
  ok('the searches list shows an UNFILED group', /UNFILED/.test(bodyText), bodyText.slice(0, 80));
  ok('a legacy search appears in the list', /Legacy Search/.test(bodyText));

  // NEW FOLDER
  plan = null; promptText = 'Handler Training';
  await page.click('#btn-new-folder'); await page.waitForTimeout(300);
  let folders = await foldersOf();
  ok('a folder can be created from the UI', folders.some(f => f.name === 'Handler Training'),
    JSON.stringify(folders));
  ok('the folder heading appears in the list',
    /Handler Training/.test(await page.textContent('#sessions-body')));

  // NEW SEARCH lands on its own management screen, where a folder can be set
  promptText = 'Bear Creek 8/17';
  await page.click('#btn-new-session'); await page.waitForTimeout(300);
  ok('a new search opens its management screen', await page.isVisible('#search-body'));
  ok('the management screen names the search',
    /Bear Creek 8\/17/.test(await page.textContent('#search-body .detail-head')));
  ok('a new search starts UNFILED', /UNFILED/.test(await page.textContent('#search-body .detail-sub')));
  ok('an empty search offers no CLEAR OBSERVATIONS', !(await page.isVisible('#btn-clear-obs')));

  const folderId = (await foldersOf()).find(f => f.name === 'Handler Training').id;
  await page.click(`#search-body [data-move="${folderId}"]`); await page.waitForTimeout(250);
  ok('the search moved into the folder',
    /Handler Training/.test(await page.textContent('#search-body .detail-sub')),
    await page.textContent('#search-body .detail-sub'));
  const bearId = (await sessionsOf()).find(s => s.name === 'Bear Creek 8/17').id;
  ok('the move is stored as a folder id, not a name',
    (await sessionsOf()).find(s => s.id === bearId).folder_id === folderId);

  // Capture three observations into it (it became the active search on creation)
  await page.click('#btn-search-back'); await page.click('#btn-sessions-back');
  await page.waitForTimeout(200);
  for (let i = 0; i < 3; i++) {
    await page.click('#btn-mark'); await page.waitForTimeout(120);
    await page.click('[data-intensity="none"]'); await page.waitForTimeout(150);
    await page.click('#btn-ov-done');
  }
  ok('observations land in the active search', (await countIn(bearId)) === 3,
    String(await countIn(bearId)));

  // Renaming does not touch observations
  const obsBefore = await page.evaluate(() => JSON.stringify(Store.getAllObservations()));
  await page.click('#btn-to-sessions'); await page.waitForTimeout(250);
  await page.click(`#sessions-body [data-session="${bearId}"]`); await page.waitForTimeout(250);
  promptText = 'Bear Creek 08-17';
  await page.click('#btn-rename-search'); await page.waitForTimeout(250);
  ok('the search renamed', /Bear Creek 08-17/.test(await page.textContent('#search-body .detail-head')));
  ok('renaming altered no observation',
    (await page.evaluate(() => JSON.stringify(Store.getAllObservations()))) === obsBefore);
  ok('the CSV follows the new search name',
    /Bear Creek 08-17/.test(await page.evaluate(() => Store.toCSV(Store.getAllObservations()))));
  ok('the CSV carries the folder name',
    /Handler Training/.test(await page.evaluate(() => Store.toCSV(Store.getAllObservations()))));

  // CLEAR OBSERVATIONS — nothing happens until the SECOND confirmation
  seen.length = 0; plan = [false];
  await page.click('#btn-clear-obs'); await page.waitForTimeout(250);
  ok('refusing the first confirmation clears nothing', (await countIn(bearId)) === 3);
  ok('the first prompt names the search and the exact count',
    /Clear all 3 observations from "Bear Creek 08-17"\?/.test(seen[0] || ''), seen[0]);
  ok('the first prompt says the search will remain',
    /The search itself will remain\./.test(seen[0] || ''), seen[0]);

  seen.length = 0; plan = [true, false];
  await page.click('#btn-clear-obs'); await page.waitForTimeout(250);
  ok('refusing the second confirmation still clears nothing', (await countIn(bearId)) === 3,
    String(await countIn(bearId)));
  ok('the second prompt warns it cannot be undone',
    /This cannot be undone\.\s*Really clear 3 observations\?/.test(seen[1] || ''), seen[1]);

  seen.length = 0; plan = [true, true];
  await page.click('#btn-clear-obs'); await page.waitForTimeout(300);
  ok('two confirmations clear the observations', (await countIn(bearId)) === 0);
  let bearNow = (await sessionsOf()).find(s => s.id === bearId);
  ok('the search survives the clear', !!bearNow);
  ok('its name survives the clear', bearNow.name === 'Bear Creek 08-17');
  ok('its folder survives the clear', bearNow.folder_id === folderId);
  ok('CLEAR OBSERVATIONS disappears once the search is empty',
    !(await page.isVisible('#btn-clear-obs')));

  // DELETE SEARCH — same two-step rule
  await page.click('#btn-search-back'); await page.waitForTimeout(200);
  promptText = 'North Table 8/24';
  plan = null;
  await page.click('#btn-new-session'); await page.waitForTimeout(300);
  const northId = (await sessionsOf()).find(s => s.name === 'North Table 8/24').id;
  await page.click('#btn-search-back'); await page.click('#btn-sessions-back'); await page.waitForTimeout(200);
  for (let i = 0; i < 2; i++) {
    await page.click('#btn-mark'); await page.waitForTimeout(120);
    await page.click('[data-intensity="none"]'); await page.waitForTimeout(150);
    await page.click('#btn-ov-done');
  }
  ok('the second search has its own observations', (await countIn(northId)) === 2);

  await page.click('#btn-to-sessions'); await page.waitForTimeout(250);
  await page.click(`#sessions-body [data-session="${northId}"]`); await page.waitForTimeout(250);
  seen.length = 0; plan = [true, false];
  await page.click('#btn-delete-search'); await page.waitForTimeout(250);
  ok('refusing the second confirmation deletes nothing',
    (await sessionsOf()).some(s => s.id === northId) && (await countIn(northId)) === 2);
  ok('the delete prompt names the search and its count',
    /Delete "North Table 8\/24" and its 2 observations\?/.test(seen[0] || ''), seen[0]);
  ok('the second delete prompt spells out the loss',
    /permanently deletes the search and all 2 observations/.test(seen[1] || ''), seen[1]);

  seen.length = 0; plan = [true, true];
  await page.click('#btn-delete-search'); await page.waitForTimeout(350);
  ok('two confirmations delete the search', !(await sessionsOf()).some(s => s.id === northId));
  ok('its observations went with it', (await countIn(northId)) === 0);
  ok('the other search is untouched',
    (await sessionsOf()).some(s => s.id === bearId));
  const activeAfter = await page.evaluate(() => Store.getActiveSession().id);
  ok('a valid active search remains after deleting the active one',
    (await sessionsOf()).some(s => s.id === activeAfter), activeAfter);
  ok('the app returned to the searches list', await page.isVisible('#sessions-body'));

  // FOLDER: rename, and refuse deletion while it holds searches
  await page.click(`#sessions-body [data-folder="${folderId}"]`); await page.waitForTimeout(250);
  ok('the folder screen lists the searches it holds',
    /Bear Creek 08-17/.test(await page.textContent('#folder-body')));
  seen.length = 0; plan = null;
  await page.click('#btn-delete-folder'); await page.waitForTimeout(250);
  ok('a non-empty folder is refused, with a count and instructions',
    /This folder contains 1 search\./.test(seen[0] || '') && /Move or delete/.test(seen[0] || ''), seen[0]);
  ok('the folder still exists', (await foldersOf()).some(f => f.id === folderId));
  ok('its searches still exist', (await sessionsOf()).some(s => s.id === bearId));

  promptText = 'Training 2026';
  await page.click('#btn-rename-folder'); await page.waitForTimeout(250);
  ok('the folder renamed', /Training 2026/.test(await page.textContent('#folder-body .detail-head')));
  // That search is empty by now, so resolve the columns for one synthetic row
  // rather than asserting against observations that no longer exist.
  ok('the CSV follows the new folder name',
    /Training 2026/.test(await page.evaluate((id) => Store.toCSV([{ session_id: id }]), bearId)));

  // Empty it, then delete it — still two confirmations
  await page.click(`#folder-body [data-session="${bearId}"]`); await page.waitForTimeout(250);
  await page.click('#search-body [data-move=""]'); await page.waitForTimeout(250);
  ok('the search is unfiled again', /UNFILED/.test(await page.textContent('#search-body .detail-sub')));
  await page.click('#btn-search-back'); await page.waitForTimeout(200);
  await page.click(`#sessions-body [data-folder="${folderId}"]`); await page.waitForTimeout(250);
  seen.length = 0; plan = [true, false];
  await page.click('#btn-delete-folder'); await page.waitForTimeout(250);
  ok('refusing the second confirmation keeps the empty folder',
    (await foldersOf()).some(f => f.id === folderId));
  seen.length = 0; plan = [true, true];
  await page.click('#btn-delete-folder'); await page.waitForTimeout(300);
  ok('two confirmations delete an empty folder', !(await foldersOf()).some(f => f.id === folderId));
  ok('the search that used to be in it survives', (await sessionsOf()).some(s => s.id === bearId));
  plan = null;

  // ---- 12. CalTopo export from the real UI ----
  const seeded = await page.evaluate(() => {
    const fol = Store.newFolder('Export Test').folder;
    const ses = Store.newSession('Arrow Search', fol.id).session;
    const base = {
      schema_version: 1, session_id: ses.id, session_name: 'Arrow Search',
      lat: 39.865811, lon: -105.216763, acc_m: 6,
      gps_fix_t: '2026-08-17T14:32:04-06:00', gps_fix_age_s: 1, declination: 8,
      declination_applied: true, bearing_source: 'sensor', bearing_input_ref: 'magnetic',
      speed_source: 'estimated', gusty: false, note: '', app_version: 'test'
    };
    const mk = (o) => Object.assign({}, base, o);
    Store.addObservation(mk({ id: 'ct-line', t: '2026-08-17T14:32:05-06:00',
      intensity: 'light', downwind_true: 105, from_true: 285, heading_magnetic_raw: 97 }));
    Store.addObservation(mk({ id: 'ct-point', t: '2026-08-17T14:45:00-06:00',
      intensity: 'none', downwind_true: null, from_true: null, heading_magnetic_raw: null,
      bearing_source: null, bearing_input_ref: null, declination_applied: false }));
    Store.addObservation(mk({ id: 'ct-nogps', t: '2026-08-17T14:51:00-06:00',
      intensity: 'strong', downwind_true: 332, from_true: 152, lat: null, lon: null }));
    return { sesId: ses.id, folderId: fol.id };
  });

  // The folder tests above leave us on the searches list; get back to capture
  // first so the entry point under test is the real one.
  if (await page.isVisible('#btn-new-folder')) {
    await page.click('#btn-sessions-back'); await page.waitForTimeout(200);
  }
  await page.click('#btn-to-sessions'); await page.waitForTimeout(300);
  await page.click(`#sessions-body [data-session="${seeded.sesId}"]`); await page.waitForTimeout(300);
  ok('the search screen offers a CalTopo export', await page.isVisible('#btn-export-caltopo'));
  ok('the search screen still offers both CSVs',
    (await page.isVisible('#btn-export-op')) && (await page.isVisible('#btn-export-prov-one')));
  ok('the export block explains that length is not a distance',
    /not a scent distance|not a .*distance/i.test(await page.textContent('#search-body')));

  // Clicking it really produces a file, through the same path the CSVs use.
  seen.length = 0; plan = null;
  let download = null;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }),
      page.click('#btn-export-caltopo')
    ]);
    download = dl;
  } catch (e) { /* reported below */ }
  ok('exporting produces a downloadable file', !!download);
  if (download) {
    const name = download.suggestedFilename();
    ok('the file is named for the folder, search and date',
      /^WindMark_Export-Test_Arrow-Search_\d{4}-\d{2}-\d{2}\.json$/.test(name), name);
    const fsp = require('fs');
    const p = await download.path();
    const text = fsp.readFileSync(p, 'utf8');
    const gj = JSON.parse(text);
    ok('the exported file parses as a FeatureCollection',
      gj.type === 'FeatureCollection' && Array.isArray(gj.features));
    ok('the observation without GPS produced no geometry', gj.features.length === 2,
      String(gj.features.length));
    const line = gj.features.find(f => f.geometry.type === 'LineString');
    const point = gj.features.find(f => f.geometry.type === 'Point');
    ok('the directional observation is a 5-point LineString',
      !!line && line.geometry.coordinates.length === 5);
    ok('no discernible wind is a Point titled as such',
      !!point && /No discernible wind/.test(point.properties.title), point && point.properties.title);
    ok('the arrow points downwind, not upwind', (() => {
      const c = line.geometry.coordinates;
      return c[1][0] > c[0][0] && c[1][1] < c[0][1];   // 105°T = east-south-east
    })());
    ok('the arrow tips exactly on the recorded coordinate', (() => {
      const c = line.geometry.coordinates;
      return c[1][0] === -105.216763 && c[1][1] === 39.865811;
    })(), JSON.stringify(line.geometry.coordinates[1]));
    ok('the glyph hangs upwind of the recorded coordinate', (() => {
      const c = line.geometry.coordinates;
      return c[0][0] < c[1][0] && c[0][1] > c[1][1];   // tail to the west-north-west
    })());
    ok('the no-wind point is exactly the recorded coordinate',
      point.geometry.coordinates[0] === -105.216763 &&
      point.geometry.coordinates[1] === 39.865811,
      JSON.stringify(point.geometry.coordinates));
    ok('the description carries the current folder and search',
      /Folder: Export Test/.test(line.properties.description) &&
      /Search: Arrow Search/.test(line.properties.description));
  }
  ok('the handler is told an observation could not be mapped',
    seen.some(m => /1 observation had no GPS coordinates/.test(m)), seen.join(' | '));

  console.log(pass + ' passed, ' + fail + ' failed');
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
