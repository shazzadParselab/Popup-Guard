/**
 * Site matching + the one allow/block rule — pure functions, no DOM, no chrome.*.
 * ------------------------------------------------------------------------------
 * Loaded in the service worker, the popup, the isolated bridge, and the page
 * world just ahead of guard-main.js — which takes `PG_POLICY` and deletes the
 * global before any page script can see it.
 *
 * THE RULE. A page on a protected site may open a window, or move itself, to
 *   - its own site, always;
 *   - another site only if the user just pressed a real, visible link to that
 *     site (an "intent").
 * Anything else — a popup fired from a click on a play button, a redirect from
 * a timer, a tab opened by an ad iframe — is blocked. There is no domain
 * blocklist: "did the user ask for this?" is a better question than "is this
 * URL bad?", and it never goes out of date.
 */
(function (root) {
  "use strict";

  // Second-level labels that sit under a 2-letter country TLD — example.co.uk,
  // example.com.bd. Not a full public-suffix list: it only has to tell "same
  // site" from "somewhere else", and when unsure it says "somewhere else".
  const CC_SECOND_LEVEL = new Set([
    "ac", "co", "com", "edu", "gob", "go", "gov", "ne", "net", "nic", "or", "org",
  ]);

  const INTENT_MS = 2000;       // a link press vouches for a popup this long
  const MENU_INTENT_MS = 30000; // right-click → "Open link in new tab" is slower

  /** Lower-case hostname of an http(s) URL — "" for anything else. */
  function hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol === "blob:") return hostOf(u.pathname); // blob:https://site/uuid
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.hostname.toLowerCase();
    } catch (e) {
      return "";
    }
  }

  /** Registrable domain: "m.www.example.co.uk" → "example.co.uk". */
  function siteOf(host) {
    host = String(host || "").toLowerCase().replace(/\.$/, "");
    if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return host; // IP address
    const labels = host.split(".");
    const take = labels.length > 2 &&
      labels[labels.length - 1].length === 2 &&
      CC_SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
    return labels.slice(-take).join(".");
  }

  /** The protected-list key for a URL, or "" if it is not a web page. */
  function siteKey(url) {
    return siteOf(hostOf(url));
  }

  /** Match patterns covering a site and every subdomain of it. */
  function patternsFor(site) {
    return ["*://" + site + "/*", "*://*." + site + "/*"];
  }

  /**
   * May a page on `pageSite` open (or go to) `url`? `intent` is the user's
   * last real link press, `{ site, until }`, or null.
   */
  function allowed(url, pageSite, intent, now) {
    const site = siteKey(url);
    if (!site) return false; // about:blank, data:, javascript: — nothing a user clicks on
    if (site === pageSite) return true;
    return Boolean(intent && now <= intent.until && intent.site === site);
  }

  root.PG_POLICY = { INTENT_MS, MENU_INTENT_MS, hostOf, siteOf, siteKey, patternsFor, allowed };
})(typeof self !== "undefined" ? self : this);
