/* WindMark offline / service-worker checks.

   Everything here needs a real browser, a real Cache Storage, and a real
   service worker, so it cannot live in tools/selfcheck.js. It serves the
   project from its own throwaway HTTP server (node's http module, no
   dependency) so it can also simulate a BROKEN update — the case that
   matters most: a failed install must never damage the version the phone is
   already relying on.

     npm i playwright     # or point at an existing install
     node tools/offlinecheck.js

   Override CHROMIUM_PATH if Playwright cannot find a browser itself.
   tools/selfcheck.js stays dependency-free and is the one to run by default. */

const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;

const TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

/* The server can be told to serve a deliberately broken service worker: one
   that claims a version whose asset list includes a file that does not exist,
   so cache.addAll rejects and the install fails. */
let breakUpdate = false;
// The real service worker, with its manifest swapped for a bogus version whose
// asset list contains a file that does not exist. Using the real source means
// the install/cleanup path under test is the one that ships.
const BROKEN_SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').replace(
  "importScripts('js/assets.js');",
  "var WM_VERSION = '9.9.9';\n" +
  "var WM_CACHE_NAME = 'windmark-v9.9.9';\n" +
  "var WM_ASSETS = ['index.html', 'js/this-file-does-not-exist.js'];"
);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  if (rel === 'sw.js' && breakUpdate) {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(BROKEN_SW);
    return;
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  const VERSION = /WM_VERSION = '([^']+)'/.exec(
    fs.readFileSync(path.join(ROOT, 'js/assets.js'), 'utf8'))[1];

  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) { pass++; return; }
    fail++;
    console.log('FAIL:', name, extra === undefined ? '' : '[' + extra + ']');
  };

  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const ctx = await browser.newContext({
    ...devices['iPhone 13'], permissions: ['geolocation'],
    geolocation: { latitude: 39.8, longitude: -105.2, accuracy: 6 },
    isMobile: true, hasTouch: true, serviceWorkers: 'allow'
  });

  // Every request the app makes, from the page or the worker.
  const requested = [];
  ctx.on('request', r => requested.push(r.url()));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  const readiness = () => page.evaluate(() => Offline.check().then(s => ({
    ready: s.ready, reason: s.reason, title: s.title, detail: s.detail, missing: s.missing
  })));

  // ---- first visit, connected: install and cache ----
  await page.goto(ORIGIN + '/index.html');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller,
    null, { timeout: 15000 }).catch(() => {});
  await page.reload();                       // ensure the worker is controlling
  await page.waitForTimeout(500);

  let r = await readiness();
  ok('after one connected visit the app reports OFFLINE READY', r.ready === true, r.reason + ' ' + r.missing);
  ok('ready title is exactly "OFFLINE READY ✓"', r.title === 'OFFLINE READY ✓', r.title);
  ok('ready detail names the running version', r.detail === `WindMark v${VERSION} cached locally`, r.detail);

  const cacheNames = await page.evaluate(() => caches.keys());
  ok('exactly one WindMark cache exists', cacheNames.filter(n => n.startsWith('windmark-')).length === 1,
    cacheNames.join(','));
  ok('the cache is named for this version', cacheNames.indexOf('windmark-v' + VERSION) >= 0, cacheNames.join(','));

  // ---- the readiness check is not navigator.onLine in disguise ----
  await ctx.setOffline(true);
  r = await readiness();
  ok('still OFFLINE READY with the network down', r.ready === true, r.reason);
  ok('the browser really is offline', (await page.evaluate(() => navigator.onLine)) === false);

  // ---- cold start with no network at all ----
  const cold = await ctx.newPage();
  const coldErrors = [];
  cold.on('pageerror', e => coldErrors.push(e.message));
  await cold.goto(ORIGIN + '/index.html');
  await cold.waitForTimeout(400);
  ok('cached app cold-starts with the network unavailable', await cold.isVisible('#btn-start'));
  ok('the offline cold start has no page errors', coldErrors.length === 0, coldErrors.join(' | '));
  const gateText = await cold.textContent('#gate-ready');
  ok('the START screen shows readiness', /OFFLINE READY/.test(gateText), gateText);

  await cold.click('#btn-start');
  await cold.waitForTimeout(600);
  ok('capture screen works offline', await cold.isVisible('#btn-mark'));

  // Five observations, entirely offline.
  for (let i = 0; i < 5; i++) {
    await cold.click('#btn-mark'); await cold.waitForTimeout(100);
    await cold.click('[data-intensity="none"]'); await cold.waitForTimeout(150);
    await cold.click('#btn-ov-done');
  }
  const stored = await cold.evaluate(() => JSON.parse(localStorage.getItem('windmark.v1.observations') || '[]').length);
  ok('five observations captured offline', stored >= 5, String(stored));

  const csv = await cold.evaluate(() => Store.toCSV(Store.getAllObservations()));
  ok('operational CSV is generated offline', csv.trim().split('\r\n').length >= 6);
  ok('offline CSV header still carries only true bearings',
    /wind_from_deg_true/.test(csv) && !/magnetic/i.test(csv.split('\r\n')[0]));

  // CalTopo GeoJSON is built from stored observations alone — no connectivity.
  const geo = await cold.evaluate(() => {
    const ses = Store.getActiveSession();
    const built = CalTopo.build(Store.getObservations(ses.id), {
      searchName: ses.name, folderName: Store.folderName(ses.folder_id)
    });
    return { text: JSON.stringify(built.geojson), exported: built.exported, skipped: built.skipped,
             name: CalTopo.filename({ searchName: ses.name }, new Date()) };
  });
  const gjOffline = JSON.parse(geo.text);
  ok('CalTopo GeoJSON is generated with the network down',
    gjOffline.type === 'FeatureCollection' && Array.isArray(gjOffline.features));
  ok('every offline observation with a fix became a feature',
    gjOffline.features.length === geo.exported && geo.exported > 0,
    geo.exported + '/' + geo.skipped);
  ok('the offline filename is a .json for this search', /^WindMark_.*\.json$/.test(geo.name), geo.name);

  // ---- pre-search check renders, and reflects reality ----
  await cold.click('#btn-to-settings'); await cold.waitForTimeout(500);
  const checks = await cold.$$eval('#set-checks .check', els => els.map(e => ({
    state: e.className.replace('check ', ''), text: e.innerText.replace(/\n/g, ' | ')
  })));
  ok('four pre-search rows in Settings', checks.length === 4, JSON.stringify(checks.map(c => c.state)));
  ok('offline row passes offline', checks[0].state === 'pass' && /Offline ready/.test(checks[0].text), checks[0].text);
  ok('storage row passes', checks[1].state === 'pass', checks[1].text);
  ok('GPS row does not fail merely for lacking a fix', checks[2].state === 'pass', checks[2].text);
  ok('compass row offers the manual fallback when not ready',
    checks[3].state === 'pass' || /manual bearing remains available/.test(checks[3].text), checks[3].text);
  const setReady = await cold.textContent('#set-ready');
  ok('Settings shows the readiness box', /OFFLINE READY/.test(setReady), setReady.slice(0, 40));
  await cold.click('#btn-settings-back');
  await cold.click('#btn-to-diag'); await cold.waitForTimeout(500);
  ok('Sensor Proof shows the readiness box', /OFFLINE READY/.test(await cold.textContent('#diag-ready')));
  ok('Sensor Proof shows the pre-search rows', (await cold.$$('#diag-checks .check')).length === 4);
  ok('Sensor Proof dump names the cache', /app cache\s+windmark-v/.test(await cold.textContent('#diag-body')));
  await cold.close();

  // ---- a failed update must not damage the working version ----
  await ctx.setOffline(false);
  breakUpdate = true;
  const upd = await ctx.newPage();
  await upd.goto(ORIGIN + '/index.html');
  await upd.waitForTimeout(1500);            // let the broken worker try to install
  await upd.reload();
  await upd.waitForTimeout(1500);

  const namesAfter = await upd.evaluate(() => caches.keys());
  ok('the broken update left no cache of its own',
    namesAfter.indexOf('windmark-v9.9.9') < 0, namesAfter.join(','));
  ok('the working version cache survived the failed update',
    namesAfter.indexOf('windmark-v' + VERSION) >= 0, namesAfter.join(','));
  const rAfter = await upd.evaluate(() => Offline.check().then(s => ({ ready: s.ready, reason: s.reason })));
  ok('still OFFLINE READY after a failed update', rAfter.ready === true, rAfter.reason);

  await ctx.setOffline(true);
  const cold2 = await ctx.newPage();
  await cold2.goto(ORIGIN + '/index.html');
  await cold2.waitForTimeout(400);
  ok('previously cached version still cold-starts offline after the failed update',
    await cold2.isVisible('#btn-start'));
  const kept = await cold2.evaluate(() => JSON.parse(localStorage.getItem('windmark.v1.observations') || '[]').length);
  ok('observations survived the failed update', kept >= 5, String(kept));
  await cold2.close();
  await upd.close();
  breakUpdate = false;
  await ctx.setOffline(false);

  // ---- an incomplete cache must read as NOT READY ----
  const tamper = await ctx.newPage();
  await tamper.goto(ORIGIN + '/index.html');
  await tamper.waitForTimeout(400);
  const deleted = await tamper.evaluate((v) => caches.open('windmark-v' + v)
    .then(c => c.delete('js/app.js')), VERSION);
  ok('removed one asset from the cache for the test', deleted === true);
  const rGap = await tamper.evaluate(() => Offline.check().then(s => ({
    ready: s.ready, reason: s.reason, title: s.title, detail: s.detail, missing: s.missing
  })));
  ok('a missing asset reads as OFFLINE NOT READY', rGap.ready === false && rGap.reason === 'incomplete',
    rGap.reason);
  ok('not-ready title is exactly "OFFLINE NOT READY"', rGap.title === 'OFFLINE NOT READY', rGap.title);
  ok('not-ready detail is exactly "Connect once before deployment"',
    rGap.detail === 'Connect once before deployment', rGap.detail);
  ok('the missing file is named', rGap.missing.indexOf('js/app.js') >= 0, rGap.missing.join(','));

  // A cache belonging to some other version must not count as this one.
  const rOther = await tamper.evaluate(() => caches.open('windmark-v0.0.1')
    .then(c => c.put('index.html', new Response('x')))
    .then(() => Offline.check().then(s => ({ ready: s.ready, reason: s.reason }))));
  ok('another version\'s cache does not make this version ready',
    rOther.ready === false && rOther.reason === 'incomplete', rOther.reason);
  await tamper.close();

  // ---- no third-party origin was ever contacted ----
  const foreign = requested.filter(u => !u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:'));
  ok('no request to any third-party origin', foreign.length === 0, foreign.slice(0, 5).join(', '));

  console.log(pass + ' passed, ' + fail + ' failed');
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
