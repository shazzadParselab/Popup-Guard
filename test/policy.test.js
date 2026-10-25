// Site matching and the allow/block rule in src/core/policy.js.
"use strict";

const fs = require("fs");
const vm = require("vm");

const sandbox = { URL };
vm.runInNewContext(fs.readFileSync("src/core/policy.js", "utf8"), sandbox);
const P = sandbox.PG_POLICY;

let failures = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? "  ✓ " : "  ✗ ") + label + (ok ? "" : "  — got " + JSON.stringify(actual)));
  if (!ok) failures++;
}

// ── siteOf / siteKey ─────────────────────────────────
eq(P.siteOf("www.example.com"), "example.com", "www. collapses");
eq(P.siteOf("a.b.example.com"), "example.com", "deep subdomain collapses");
eq(P.siteOf("example.com"), "example.com", "bare domain stays");
eq(P.siteOf("news.example.co.uk"), "example.co.uk", "co.uk keeps three labels");
eq(P.siteOf("shop.example.com.bd"), "example.com.bd", "com.bd keeps three labels");
eq(P.siteOf("x.io"), "x.io", "short two-label domain stays");
eq(P.siteOf("192.168.0.10"), "192.168.0.10", "IP address is its own site");
eq(P.siteOf("EXAMPLE.com."), "example.com", "case and trailing dot normalised");

eq(P.siteKey("https://m.movies.example/watch?v=1"), "movies.example", "siteKey from URL");
eq(P.siteKey("about:blank"), "", "about:blank has no site");
eq(P.siteKey("javascript:void(0)"), "", "javascript: has no site");
eq(P.siteKey("chrome://extensions"), "", "chrome:// has no site");
eq(P.siteKey("blob:https://www.movies.example/1234"), "movies.example", "blob: belongs to its origin");
eq(P.siteKey("not a url"), "", "garbage has no site");

eq(P.patternsFor("example.com"), ["*://example.com/*", "*://*.example.com/*"], "patterns cover subdomains");

// ── allowed ──────────────────────────────────────────
const now = 1000000;
const intent = { site: "files.example", until: now + 500 };

eq(P.allowed("https://cdn.movies.example/x", "movies.example", null, now), true, "same site always allowed");
eq(P.allowed("https://ads.example/", "movies.example", null, now), false, "other site, no intent → blocked");
eq(P.allowed("https://files.example/dl", "movies.example", intent, now), true, "other site the user pressed a link to → allowed");
eq(P.allowed("https://ads.example/", "movies.example", intent, now), false, "intent for one site does not cover another");
eq(P.allowed("https://files.example/dl", "movies.example", intent, now + 501), false, "expired intent → blocked");
eq(P.allowed("about:blank", "movies.example", intent, now), false, "blank window → blocked");

if (failures) process.exit(1);
