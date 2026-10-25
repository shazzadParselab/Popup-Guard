/**
 * Test runner — `node test/run.js` from the repo root.
 *
 * No build step and no test framework on purpose: these are plain node scripts
 * that load the real source files against stubs. They cover what cannot be
 * checked by reading the code —
 *   files.test.js    every file the manifest, popup and service worker point
 *                    at exists and parses
 *   policy.test.js   site matching and the allow/block rule
 *   guard.test.js    the page-world guard really blocks popups, redirects,
 *                    synthetic link clicks and click-traps — and lets real
 *                    link presses through
 * Everything else needs a real browser.
 */
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const suites = ["files.test.js", "policy.test.js", "guard.test.js"];
let failed = 0;

for (const suite of suites) {
  console.log("\n── " + suite + " " + "─".repeat(Math.max(0, 50 - suite.length)));
  try {
    execFileSync(process.execPath, [path.join(__dirname, suite)], {
      cwd: path.join(__dirname, ".."),
      stdio: "inherit",
    });
  } catch (e) {
    failed++;
  }
}

console.log(failed ? "\n" + failed + " suite(s) failed" : "\nAll suites passed");
process.exit(failed ? 1 : 0);
