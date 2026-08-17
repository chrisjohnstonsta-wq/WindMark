/* WindMark — what the app is made of, and which version it is.

   One source of truth, loaded by BOTH the page (a plain <script>) and the
   service worker (importScripts). That is deliberate: the offline-readiness
   check asks whether exactly these files are in exactly this version's cache,
   and it would be worthless if the page and the worker disagreed about the
   list.

   Bump WM_VERSION whenever any cached file changes. The cache name is derived
   from it, so a new version always installs into its own cache and can never
   be reported as offline-ready until that cache is complete. */

var WM_VERSION = '1.4.0';
var WM_CACHE_NAME = 'windmark-v' + WM_VERSION;

var WM_ASSETS = [
  './',
  'index.html',
  'css/windmark.css',
  'js/assets.js',
  'js/util.js',
  'js/store.js',
  'js/sensors.js',
  'js/offline.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png'
];
