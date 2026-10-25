// Every file referenced by the manifest, the popup, or the service worker's
// script registrations exists, and every script parses.
"use strict";

const fs = require("fs");
const vm = require("vm");

let failures = 0;
function check(ok, label) {
  console.log((ok ? "  ✓ " : "  ✗ ") + label);
  if (!ok) failures++;
}

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));

const referenced = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
]);

// Scripts the service worker registers at runtime.
const background = fs.readFileSync("src/background.js", "utf8");
for (const match of background.matchAll(/"(src\/[\w\-/]+\.js)"/g)) referenced.add(match[1]);
for (const match of background.matchAll(/importScripts\(([^)]*)\)/g)) {
  for (const file of match[1].match(/"[^"]+"/g)) referenced.add("src/" + file.slice(1, -1));
}

// Files the popup loads.
const popup = fs.readFileSync("popup/popup.html", "utf8");
for (const match of popup.matchAll(/(?:src|href)="([^"]+)"/g)) {
  referenced.add(require("path").join("popup", match[1]));
}

for (const file of referenced) check(fs.existsSync(file), "exists: " + file);

for (const file of referenced) {
  if (!file.endsWith(".js")) continue;
  let ok = true;
  try {
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file });
  } catch (e) {
    ok = false;
    console.log("    " + e.message);
  }
  check(ok, "parses: " + file);
}

check(!("content_scripts" in manifest), "no static content scripts — the guard is registered per site");

if (failures) process.exit(1);
