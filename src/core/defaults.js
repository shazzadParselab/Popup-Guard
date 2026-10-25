/**
 * Single source of truth for every setting.
 * -----------------------------------------
 * Loaded in the service worker, the popup and the isolated content script, so
 * it uses `self` — which is `window` in a page and the global scope in a worker.
 */
(function (root) {
  "use strict";

  root.PG_DEFAULTS = {
    enabled: true,   // master switch
    sites: [],       // protected sites, as registrable domains ("example.com")
    showToast: true, // small on-page notice whenever something is blocked
    debug: false,    // log every decision to the page console
  };

  // Stats live in storage.local (device-specific); settings live in storage.sync.
  root.PG_STAT_DEFAULTS = {
    blocked: 0, // everything, all sites
    bySite: {}, // site → count
  };
})(typeof self !== "undefined" ? self : this);
