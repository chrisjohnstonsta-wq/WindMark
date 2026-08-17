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
  page.on('dialog', async d => { lastDialog = d.message(); await d.accept(); });

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

  // ---- 8. session rename reaches the export ----
  await page.click('#btn-list-back');
  await page.click('#btn-to-sessions'); await page.waitForTimeout(200);
  ok('no END button on searches', (await page.$$('[data-end]')).length === 0);
  await page.evaluate(() => { window.prompt = () => 'Drainage Sweep'; });
  await page.click('[data-rename]'); await page.waitForTimeout(250);
  const csv = await page.evaluate(() => Store.toCSV(Store.getAllObservations()));
  ok('renamed search appears in the export', /Drainage Sweep/.test(csv));
  ok('stored record keeps its capture-time name',
    (await dump()).some(o => o.session_name === 'Search 1'));

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

  console.log(pass + ' passed, ' + fail + ' failed');
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
