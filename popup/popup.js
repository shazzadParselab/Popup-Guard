/**
 * Popup — master switch, "Protect this site", and the protected-site list.
 * -----------------------------------------------------------------------
 * Every action is a storage write plus, when adding, a permission request.
 * background.js does the rest (registers the guard, reloads the tab) and the
 * popup just re-renders from storage. That split matters: the permission
 * prompt can close the popup mid-flow, and nothing here has to survive for
 * the change to land.
 *
 * To promote a setting to the popup, add its key to QUICK below.
 */
(function () {
  "use strict";

  const P = self.PG_POLICY;

  const QUICK = [
    { key: "showToast", label: "Show a notice on the page" },
    { key: "debug", label: "Log decisions to the console" },
  ];

  const $ = (id) => document.getElementById(id);
  const enabled = $("enabled");

  let settings = { ...self.PG_DEFAULTS };
  let stats = { ...self.PG_STAT_DEFAULTS };
  let granted = new Set(); // listed sites whose permission is actually held
  let currentSite = "";

  // ── Data ────────────────────────────────────────────
  async function load() {
    const [synced, local, [tab]] = await Promise.all([
      chrome.storage.sync.get(self.PG_DEFAULTS),
      chrome.storage.local.get(self.PG_STAT_DEFAULTS),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    settings = { ...self.PG_DEFAULTS, ...synced };
    stats = { ...self.PG_STAT_DEFAULTS, ...local };
    currentSite = P.siteKey((tab && (tab.url || tab.pendingUrl)) || "");

    const checks = await Promise.all(
      settings.sites.map((site) => chrome.permissions.contains({ origins: P.patternsFor(site) }))
    );
    granted = new Set(settings.sites.filter((_, i) => checks[i]));
    render();
  }

  function count(site) {
    return (stats.bySite && stats.bySite[site]) || 0;
  }

  // ── Actions ─────────────────────────────────────────
  function protect(site) {
    // Both calls go out in the same tick as the click: the permission request
    // needs the user gesture, and if the prompt closes the popup the site is
    // already saved — background.js picks it up from permissions.onAdded.
    if (!settings.sites.includes(site)) {
      chrome.storage.sync.set({ sites: [...settings.sites, site].sort() });
    }
    chrome.permissions.request({ origins: P.patternsFor(site) }).then(load, load);
  }

  function unprotect(site) {
    chrome.storage.sync.set({ sites: settings.sites.filter((s) => s !== site) });
    chrome.permissions.remove({ origins: P.patternsFor(site) }).catch(() => {});
  }

  // ── Render ──────────────────────────────────────────
  function render() {
    enabled.checked = settings.enabled;
    document.body.classList.toggle("off", !settings.enabled);
    renderCurrent();
    renderList();
    for (const [key, input] of quickInputs) input.checked = Boolean(settings[key]);
    $("total").textContent = String(stats.blocked || 0);
  }

  function renderCurrent() {
    const status = $("current-status");
    const button = $("protect");
    status.className = "current-status";
    button.className = "protect";

    if (!currentSite) {
      $("current-host").textContent = "This page";
      status.textContent = "Only regular websites can be protected.";
      button.hidden = true;
      return;
    }

    $("current-host").textContent = currentSite;
    button.hidden = false;

    if (!settings.sites.includes(currentSite)) {
      status.textContent = "Not protected";
      button.textContent = "Protect this site";
    } else if (!granted.has(currentSite)) {
      status.textContent = "Waiting for permission";
      status.classList.add("warn");
      button.textContent = "Grant access";
      button.classList.add("warn");
    } else {
      status.textContent = "Protected · " + count(currentSite) + " blocked";
      status.classList.add("on");
      button.textContent = "Stop protecting";
      button.classList.add("secondary");
    }
  }

  function renderList() {
    const list = $("site-list");
    list.textContent = "";
    $("empty").hidden = settings.sites.length > 0;
    $("site-count").textContent = settings.sites.length ? "(" + settings.sites.length + ")" : "";

    for (const site of settings.sites) {
      const row = document.createElement("li");
      row.className = "site" + (site === currentSite ? " is-current" : "");

      const dot = document.createElement("span");
      dot.className = "dot" + (granted.has(site) ? "" : " warn");
      dot.title = granted.has(site) ? "Protected" : "Waiting for permission";

      const name = document.createElement("span");
      name.className = "site-name";
      name.textContent = site;

      const blocked = document.createElement("span");
      blocked.className = "site-count";
      blocked.textContent = String(count(site));
      blocked.title = "Blocked on this site";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.textContent = "×";
      remove.title = "Stop protecting " + site;
      remove.addEventListener("click", () => unprotect(site));

      row.append(dot, name, blocked, remove);
      list.appendChild(row);
    }
  }

  // ── Build the quick rows ────────────────────────────
  const quickInputs = new Map();

  for (const item of QUICK) {
    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = item.label;

    const wrap = document.createElement("label");
    wrap.className = "switch";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      chrome.storage.sync.set({ [item.key]: input.checked });
    });

    const slider = document.createElement("span");
    slider.className = "slider";

    wrap.append(input, slider);
    row.append(label, wrap);
    $("quick").appendChild(row);
    quickInputs.set(item.key, input);
  }

  // ── Wiring ──────────────────────────────────────────
  enabled.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: enabled.checked });
  });

  $("protect").addEventListener("click", () => {
    if (!currentSite) return;
    if (settings.sites.includes(currentSite) && granted.has(currentSite)) unprotect(currentSite);
    else protect(currentSite);
  });

  $("reset").addEventListener("click", () => {
    chrome.storage.local.set({ ...self.PG_STAT_DEFAULTS });
  });

  chrome.storage.onChanged.addListener(load);
  chrome.permissions.onAdded.addListener(load);
  chrome.permissions.onRemoved.addListener(load);

  load();
})();
