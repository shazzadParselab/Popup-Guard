/**
 * Service worker — three jobs.
 * ----------------------------
 * 1. SCRIPT REGISTRATION. The guard is not in the manifest. It is registered
 *    with chrome.scripting for exactly the protected sites the user has
 *    granted, and reconciled whenever that list, a permission, or the master
 *    switch changes. Every other site never sees it.
 *
 * 2. TAB WATCHER. The page-world guard cannot reach inside a cross-origin ad
 *    iframe, so a popup opened from one gets past it. Every new tab a protected
 *    tab opens is checked here against the same rule (policy.js), and closed if
 *    nothing the user did asked for it.
 *
 * 3. STATS + NOTICES. Every block from every layer is counted here — one
 *    writer, so no lost increments — and echoed to the tab as an on-page notice.
 */
"use strict";

importScripts("core/defaults.js", "core/policy.js");

const P = self.PG_POLICY;

const JUDGE_DELAY_MS = 250;  // the guard's report of a link press races this event; let it land
const BLANK_WATCH_MS = 5000; // a tab opened blank gets this long to reveal where it is going
const KINDS = new Set(["popup", "tab", "redirect", "overlay"]);

const allowances = new Map();   // tabId → [{ site, until }] — link presses reported by the guard
const pendingBlank = new Map(); // new tabId → { sourceTabId, site, until }

function getSettings() {
  return chrome.storage.sync.get(self.PG_DEFAULTS);
}

// ─────────────────────────────────────────────────────────────
// 1. Script registration
// ─────────────────────────────────────────────────────────────
async function grantedSites(sites) {
  const checks = await Promise.all(
    sites.map((site) => chrome.permissions.contains({ origins: P.patternsFor(site) }).catch(() => false))
  );
  return sites.filter((_, i) => checks[i]);
}

function scriptsFor(matches) {
  const common = {
    matches,
    runAt: "document_start",
    allFrames: true,
    matchOriginAsFallback: true, // about:blank / srcdoc frames a protected page creates
    persistAcrossSessions: true,
  };
  return [
    { id: "pg-guard", world: "MAIN", js: ["src/core/policy.js", "src/guard-main.js"], ...common },
    { id: "pg-bridge", js: ["src/core/defaults.js", "src/core/policy.js", "src/bridge.js"], ...common },
  ];
}

function fingerprint(scripts) {
  return scripts
    .map((s) => [s.id, s.js.join(","), s.matches.slice().sort().join(",")].join("|"))
    .sort()
    .join("\n");
}

async function reconcile() {
  const { enabled, sites } = await getSettings();
  const matches = enabled ? (await grantedSites(sites)).flatMap(P.patternsFor) : [];
  const wanted = matches.length ? scriptsFor(matches) : [];

  const existing = (await chrome.scripting.getRegisteredContentScripts())
    .filter((s) => s.id.startsWith("pg-"));

  // Runs on every worker wake, so only touch the registration when it is
  // actually wrong — re-registering leaves a gap where a page can load bare.
  if (fingerprint(existing) === fingerprint(wanted)) return;

  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  }
  if (!wanted.length) return;

  try {
    await chrome.scripting.registerContentScripts(wanted);
  } catch (e) {
    // matchOriginAsFallback needs a newer Chrome than world: "MAIN" does.
    // Without it every normal frame is still guarded, just not about:blank ones.
    await chrome.scripting.registerContentScripts(
      wanted.map(({ matchOriginAsFallback, ...rest }) => rest)
    );
  }
}

let syncQueue = Promise.resolve();
function sync() {
  syncQueue = syncQueue
    .then(reconcile)
    .catch((e) => console.warn("[Popup Guard] could not register scripts", e));
  return syncQueue;
}

/** Reload every open tab on these sites so the guard is there from the first byte. */
async function reloadSites(sites) {
  if (!sites.length) return;
  const tabs = await chrome.tabs.query({ url: sites.flatMap(P.patternsFor) });
  for (const tab of tabs) chrome.tabs.reload(tab.id).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  // Seed any setting never seen before without clobbering existing choices.
  const current = await chrome.storage.sync.get(null);
  const missing = {};
  for (const [key, value] of Object.entries(self.PG_DEFAULTS)) {
    if (!(key in current)) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
  sync();
});

chrome.runtime.onStartup.addListener(sync);
sync(); // every wake, including an unpacked reload, which does not always fire onInstalled

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync" || !("sites" in changes || "enabled" in changes)) return;
  await sync();

  // A site added with its permission already granted takes effect on reload
  // here. One still waiting for the prompt is reloaded from onAdded instead.
  if (changes.sites) {
    const before = changes.sites.oldValue || [];
    const added = (changes.sites.newValue || []).filter((site) => !before.includes(site));
    reloadSites(await grantedSites(added));
  }
});

chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  await sync();
  const { sites } = await getSettings();
  reloadSites(sites.filter((site) => P.patternsFor(site).some((p) => origins.includes(p))));
});

chrome.permissions.onRemoved.addListener(sync);

// ─────────────────────────────────────────────────────────────
// 2. Tab watcher
// ─────────────────────────────────────────────────────────────
async function protectedSiteOf(tabId) {
  const { enabled, sites } = await getSettings();
  if (!enabled) return "";
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return "";
  }
  // tab.url is only visible for sites we hold a permission for — which is
  // exactly the protected ones.
  const site = P.siteKey(tab.url || tab.pendingUrl || "");
  return sites.includes(site) ? site : "";
}

function remember(tabId, site, ms) {
  const time = Date.now();
  const list = (allowances.get(tabId) || []).filter((a) => a.until >= time);
  list.push({ site, until: time + Math.min(Math.max(ms, 0), P.MENU_INTENT_MS) });
  allowances.set(tabId, list);
}

function intentFor(tabId, site) {
  const time = Date.now();
  return (allowances.get(tabId) || []).find((a) => a.site === site && a.until >= time) || null;
}

function judge(tabId, sourceTabId, site, url) {
  setTimeout(async () => {
    if (P.allowed(url, site, intentFor(sourceTabId, P.siteKey(url)), Date.now())) return;
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      return; // already gone
    }
    recordBlock(sourceTabId, site, "tab", url);
  }, JUDGE_DELAY_MS);
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  const site = await protectedSiteOf(details.sourceTabId);
  if (!site) return;

  // window.open() with no URL, then pointed somewhere a moment later — judge
  // it on the first real address it heads for.
  if (!P.siteKey(details.url)) {
    pendingBlank.set(details.tabId, {
      sourceTabId: details.sourceTabId, site, until: Date.now() + BLANK_WATCH_MS,
    });
    return;
  }
  judge(details.tabId, details.sourceTabId, site, details.url);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  const pending = details.frameId === 0 && pendingBlank.get(details.tabId);
  if (!pending || !P.siteKey(details.url)) return;
  pendingBlank.delete(details.tabId);
  if (Date.now() <= pending.until) judge(details.tabId, pending.sourceTabId, pending.site, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  allowances.delete(tabId);
  pendingBlank.delete(tabId);
});

// ─────────────────────────────────────────────────────────────
// 3. Stats + notices
// ─────────────────────────────────────────────────────────────
let statsQueue = Promise.resolve();

function recordBlock(tabId, site, kind, url) {
  statsQueue = statsQueue.then(async () => {
    const stats = await chrome.storage.local.get(self.PG_STAT_DEFAULTS);
    const bySite = { ...stats.bySite };
    if (site) bySite[site] = (bySite[site] || 0) + 1;
    await chrome.storage.local.set({ blocked: (stats.blocked || 0) + 1, bySite });
  }).catch(() => {});

  chrome.tabs.sendMessage(tabId, { type: "pg:toast", kind, url }, { frameId: 0 }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tab = sender.tab;
  if (!msg || !tab) return;

  if (msg.type === "pg:intent" && msg.site) {
    remember(tab.id, String(msg.site), Number(msg.ms) || 0);
  } else if (msg.type === "pg:blocked" && KINDS.has(msg.kind)) {
    recordBlock(tab.id, P.siteKey(tab.url || ""), msg.kind, String(msg.url || ""));
  } else if (msg.type === "pg:open" && P.siteKey(msg.url)) {
    // "Open" on a notice. Created by the extension, so the watcher never sees it.
    chrome.tabs.create({ url: msg.url, index: tab.index + 1, openerTabId: tab.id });
  }
});
