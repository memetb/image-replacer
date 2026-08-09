// sw.js -- Chrome's service worker entry point.
//
// Chrome takes a single `background.service_worker` file, Firefox takes a
// `background.scripts` list. Rather than maintain two builds, both load the
// same classic scripts in the same order: Firefox straight from the manifest,
// Chrome through this shim.
//
// Paths are root-relative so they resolve the same regardless of where this
// file sits.
importScripts(
  '/src/replacement.js',
  '/src/sites.js',
  '/src/indicator.js',
  '/src/menus.js',
  '/src/background.js',
);
