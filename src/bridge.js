/**
 * Isolated-world bridge — the guard's line to the extension.
 * ----------------------------------------------------------
 * guard-main.js lives in the page world and cannot use chrome.*, so this
 * relays for it, both ways:
 *   page → extension   "pg:report"  something was blocked
 *                      "pg:intent"  the user pressed a link to another site —
 *                                   background.js's tab watcher needs to know
 *   extension → page   "pg:config"  live on/off + debug, from storage
 * It also draws the small on-page notice (top frame only).
 */
(function () {
  "use strict";

  const P = self.PG_POLICY;
  const site = P.siteKey(location.href) || topSite();
  let settings = { ...self.PG_DEFAULTS };

  function topSite() {
    const origins = location.ancestorOrigins;
    return origins && origins.length ? P.siteKey(origins[origins.length - 1]) : "";
  }

  // After an extension reload this script keeps running with a dead chrome.*
  // connection; every call would throw "Extension context invalidated".
  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function message(msg) {
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      /* context died between the check and the call */
    }
  }

  function read(event) {
    try {
      return JSON.parse(event.detail);
    } catch (e) {
      return null;
    }
  }

  // ── Page → extension ────────────────────────────────
  document.addEventListener("pg:ready", pushConfig);

  document.addEventListener("pg:report", (event) => {
    const data = read(event);
    if (data) message({ type: "pg:blocked", kind: String(data.kind), url: String(data.url || "") });
  });

  document.addEventListener("pg:intent", (event) => {
    const data = read(event);
    if (data) message({ type: "pg:intent", site: String(data.site), ms: Number(data.ms) || 0 });
  });

  // ── Extension → page ────────────────────────────────
  function pushConfig() {
    const detail = JSON.stringify({
      active: Boolean(settings.enabled && settings.sites.includes(site)),
      debug: Boolean(settings.debug),
    });
    document.dispatchEvent(new CustomEvent("pg:config", { detail }));
  }

  chrome.storage.sync.get(self.PG_DEFAULTS, (stored) => {
    settings = { ...self.PG_DEFAULTS, ...stored };
    pushConfig();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !alive()) return;
    for (const [key, change] of Object.entries(changes)) {
      settings[key] = "newValue" in change ? change.newValue : self.PG_DEFAULTS[key];
    }
    pushConfig();
  });

  if (window !== window.top) return;

  // ─────────────────────────────────────────────────────────────
  // On-page notice
  // ─────────────────────────────────────────────────────────────
  const LABELS = {
    popup: "Blocked a popup",
    tab: "Closed a pop-under tab",
    redirect: "Stopped a redirect",
    overlay: "Removed an invisible click-trap",
  };
  const VISIBLE_MS = 5000;
  const MAX_SHOWN = 3;

  const CSS = `
    :host { all: initial; }
    .stack {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font: 13px/1.35 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    }
    .toast {
      display: flex; align-items: center; gap: 10px;
      width: 320px; max-width: calc(100vw - 32px); box-sizing: border-box;
      padding: 10px 10px 10px 12px; border-radius: 10px;
      background: #18181b; color: #f4f4f5; border: 1px solid #2e2e33;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .35);
      animation: in 160ms ease-out;
    }
    .icon { flex: none; color: #22c55e; }
    .text { flex: 1; min-width: 0; }
    .label { font-weight: 600; }
    .count { margin-left: 4px; color: #22c55e; }
    .host { color: #a1a1aa; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button {
      all: unset; cursor: pointer; flex: none;
      padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600;
    }
    .open { color: #22c55e; }
    .open:hover { background: rgba(34, 197, 94, .14); }
    .close { color: #71717a; font-size: 16px; line-height: 1; }
    .close:hover { color: #f4f4f5; }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } }
  `;

  const ICON = '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>';

  let stack = null;
  const shown = new Map(); // kind|host → { el, count, timer }

  function ensureStack() {
    if (stack && stack.isConnected) return stack;
    const host = document.createElement("pg-notice");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    stack = document.createElement("div");
    stack.className = "stack";
    root.append(style, stack);
    document.documentElement.appendChild(host);
    return stack;
  }

  function dismiss(key) {
    const entry = shown.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.el.remove();
    shown.delete(key);
  }

  function toast({ kind, url }) {
    if (!settings.showToast || !LABELS[kind]) return;
    const host = P.hostOf(url);
    const key = kind + "|" + host;

    // The same thing blocked again just bumps the counter on its notice.
    const existing = shown.get(key);
    if (existing) {
      existing.count++;
      existing.el.querySelector(".count").textContent = "×" + existing.count;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => dismiss(key), VISIBLE_MS);
      return;
    }

    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = ICON +
      '<div class="text"><div><span class="label"></span><span class="count"></span></div>' +
      '<div class="host"></div></div>';
    el.querySelector(".label").textContent = LABELS[kind];
    el.querySelector(".host").textContent = host ? "→ " + host : "";
    el.querySelector(".host").hidden = !host;

    // Blocked by mistake? One click opens it in a new tab, on purpose this time.
    if (host && kind !== "overlay") {
      const open = document.createElement("button");
      open.className = "open";
      open.textContent = "Open";
      open.title = url;
      open.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        message({ type: "pg:open", url });
        dismiss(key);
      });
      el.appendChild(open);
    }

    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.title = "Dismiss";
    close.addEventListener("click", () => dismiss(key));
    el.appendChild(close);

    const container = ensureStack();
    container.appendChild(el);
    shown.set(key, { el, count: 1, timer: setTimeout(() => dismiss(key), VISIBLE_MS) });

    while (shown.size > MAX_SHOWN) dismiss(shown.keys().next().value);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "pg:toast") toast(msg);
  });
})();
