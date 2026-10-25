/**
 * Page-world guard (registered with world: "MAIN") — the first line of defence.
 * ----------------------------------------------------------------------------
 * Runs at document_start on protected sites only, before any page script, so
 * every native it wraps is still the real one. Three jobs:
 *
 *  1. INTENT. Every real press on a visible link is remembered for a moment as
 *     "the user wants <site>". policy.js decides everything against that.
 *  2. POPUPS & REDIRECTS. window.open, synthetic clicks on new-window links,
 *     form.submit() into a new window, and script navigations of the top page
 *     are let through only if policy allows. A blocked window.open returns
 *     null — exactly what Chrome's own popup blocker returns, so page scripts
 *     already cope with it.
 *  3. CLICK-TRAPS. An invisible layer laid over the page is switched off
 *     (pointer-events: none) and the click it swallowed is passed on to
 *     whatever was underneath, so one click still does what the user meant.
 *
 * Nothing here can use chrome.* — the page world has no access to it. Blocks
 * are reported to bridge.js over DOM events, and bridge.js sends back the live
 * on/off + debug state the same way.
 */
(function () {
  "use strict";

  const P = window.PG_POLICY;
  try { delete window.PG_POLICY; } catch (e) { /* stays visible — harmless */ }
  if (!P) return;

  // ── Natives, captured before any page script can replace them ──────────
  const native = {
    addEventListener: EventTarget.prototype.addEventListener,
    dispatchEvent: EventTarget.prototype.dispatchEvent,
    click: HTMLElement.prototype.click,
    submit: HTMLFormElement.prototype.submit,
    requestSubmit: HTMLFormElement.prototype.requestSubmit,
    contentWindow: Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow"),
    getComputedStyle: window.getComputedStyle,
    elementFromPoint: Document.prototype.elementFromPoint,
    toString: Function.prototype.toString,
  };
  const { apply } = Reflect;
  const { now } = Date;
  const CustomEvt = CustomEvent;
  const MouseEvt = MouseEvent;
  const debugLog = console.debug.bind(console);

  // The site this page belongs to. An about:blank frame has no site of its
  // own, so it inherits the top page's.
  const PAGE_SITE = P.siteKey(location.href) || topSite();

  function topSite() {
    const origins = location.ancestorOrigins;
    return origins && origins.length ? P.siteKey(origins[origins.length - 1]) : "";
  }

  let active = true;         // bridge.js turns this off live (site removed, master switch)
  let debug = false;
  let intent = null;         // { site, until } — see policy.js
  let pendingForward = null; // { x, y } of a press a click-trap swallowed

  // ─────────────────────────────────────────────────────────────
  // Plumbing
  // ─────────────────────────────────────────────────────────────

  // Wrapped natives report their original source, so `window.open.toString()`
  // still says "[native code]" — some sites refuse to work when it does not.
  const disguised = new WeakMap();
  function disguise(wrapper, original) {
    disguised.set(wrapper, original);
    return wrapper;
  }
  Function.prototype.toString = disguise(function toString() {
    return apply(native.toString, disguised.get(this) || this, []);
  }, native.toString);

  function log(...args) {
    if (debug) debugLog("%c[Popup Guard]", "color:#22c55e;font-weight:bold", ...args);
  }

  function send(type, data) {
    native.dispatchEvent.call(document, new CustomEvt(type, { detail: JSON.stringify(data) }));
  }

  function block(kind, url) {
    log("blocked", kind, url);
    send("pg:report", { kind, url: String(url || "") });
  }

  function resolve(url) {
    try {
      return new URL(url == null || url === "" ? "about:blank" : String(url), location.href).href;
    } catch (e) {
      return "";
    }
  }

  function permits(url) {
    return P.allowed(url, PAGE_SITE, intent, now());
  }

  function isLink(node) {
    return node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement;
  }

  /** True for a target that makes a link or form open a new window. */
  function opensWindow(target) {
    const t = String(target || "").toLowerCase();
    return t !== "" && t !== "_self" && t !== "_top" && t !== "_parent";
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Intent
  // ─────────────────────────────────────────────────────────────
  function setIntent(href, ms) {
    const site = href ? P.siteKey(href) : "";
    intent = site ? { site, until: now() + ms } : null;
    // background.js judges new tabs too, and needs to know this press happened.
    if (site && site !== PAGE_SITE) send("pg:intent", { site, ms });
  }

  function linkIn(path) {
    for (const node of path) {
      if (node === document.body) break;
      if (isLink(node) && node.href) return node;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Popups & redirects
  // ─────────────────────────────────────────────────────────────
  const guardedWindows = new WeakSet();

  function guardWindow(win) {
    try {
      if (guardedWindows.has(win)) return;
      guardedWindows.add(win);
      const original = win.open;
      win.open = disguise(function open(url, target) {
        // _self/_top/_parent is a navigation, not a new window — the
        // navigate guard below has it.
        const t = target == null ? "" : String(target).toLowerCase();
        if (!active || t === "_self" || t === "_top" || t === "_parent") {
          return apply(original, win, arguments);
        }
        const href = resolve(url);
        if (permits(href)) return apply(original, win, arguments);
        block("popup", href);
        return null;
      }, original);
    } catch (e) {
      /* cross-origin window — not ours to guard */
    }
  }

  guardWindow(window);

  // A fresh about:blank iframe has its own, unguarded window.open — the classic
  // way around a popup guard. Guard it the moment the page reaches for it.
  // (matchOriginAsFallback injects this whole script into such frames as well;
  // this covers the gap before that happens.)
  if (native.contentWindow && native.contentWindow.get) {
    const getter = native.contentWindow.get;
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      configurable: true,
      enumerable: native.contentWindow.enumerable,
      get: disguise(function () {
        const win = apply(getter, this, []);
        if (win) guardWindow(win);
        return win;
      }, getter),
    });
  }

  /** Should a script-made click on `el` be stopped? Only new-window links count. */
  function stopsSynthetic(el) {
    if (!active || !el || typeof el.closest !== "function") return false;
    const link = el.closest("a[href],area[href]");
    if (!link || !opensWindow(link.target) || !P.siteKey(link.href) || permits(link.href)) {
      return false;
    }
    block("popup", link.href);
    return true;
  }

  HTMLElement.prototype.click = disguise(function click() {
    if (stopsSynthetic(this)) return;
    return apply(native.click, this, arguments);
  }, native.click);

  EventTarget.prototype.dispatchEvent = disguise(function dispatchEvent(event) {
    if (event && event.type === "click" && stopsSynthetic(this)) return false;
    return apply(native.dispatchEvent, this, arguments);
  }, native.dispatchEvent);

  function stopsSubmit(form) {
    if (!active || !opensWindow(form.getAttribute("target"))) return false;
    const action = resolve(form.getAttribute("action") || location.href);
    if (!P.siteKey(action) || permits(action)) return false;
    block("popup", action);
    return true;
  }

  HTMLFormElement.prototype.submit = disguise(function submit() {
    if (stopsSubmit(this)) return;
    return apply(native.submit, this, arguments);
  }, native.submit);

  if (native.requestSubmit) {
    HTMLFormElement.prototype.requestSubmit = disguise(function requestSubmit() {
      if (stopsSubmit(this)) return;
      return apply(native.requestSubmit, this, arguments);
    }, native.requestSubmit);
  }

  // Script-driven moves of the top page: location.href = …, location.replace,
  // meta refresh, synthetic same-tab link clicks, form.submit(). A real click
  // on a real link arrives with userInitiated and is never touched.
  if (window === window.top && window.navigation) {
    window.navigation.addEventListener("navigate", (event) => {
      if (!active || event.userInitiated || !event.cancelable || event.hashChange) return;
      if (event.downloadRequest !== null && event.downloadRequest !== undefined) return;
      if (event.navigationType === "reload" || event.navigationType === "traverse") return;
      const href = event.destination.url;
      if (!P.siteKey(href) || permits(href)) return;
      event.preventDefault();
      block("redirect", href);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Click-traps
  // ─────────────────────────────────────────────────────────────
  const OFF = "data-pg-off";
  const CONTENT = "img,video,canvas,svg,iframe,input,button,select,textarea,picture,object,embed";
  const trapped = new WeakSet();

  // One stylesheet rule switches a trap off, children included. pointer-events
  // rather than removal: page scripts that re-check or re-insert the element
  // find it still there and leave it alone, and it is invisible either way.
  function installStyle() {
    const style = document.createElement("style");
    style.textContent = "[" + OFF + "],[" + OFF + "] *{pointer-events:none!important}";
    (document.head || document.documentElement).appendChild(style);
  }

  function opacityOf(el) {
    let opacity = 1;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      opacity *= parseFloat(native.getComputedStyle.call(window, node).opacity) || 0;
    }
    return opacity;
  }

  function isClear(style) {
    return style.backgroundImage === "none" &&
      /^(transparent|rgba\(.*,\s*0\))$/.test(style.backgroundColor);
  }

  function coverage(el) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? (w * h) / (innerWidth * innerHeight) : 0;
  }

  function isTrap(el) {
    if (trapped.has(el)) return true;
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.body || el === document.documentElement) return false;

    const style = native.getComputedStyle.call(window, el);
    if (style.position !== "fixed" && style.position !== "absolute") return false;
    if (el.querySelector(CONTENT) || /\S/.test(el.textContent)) return false;
    if (opacityOf(el) >= 0.1 && !isClear(style)) return false;

    // An invisible link to another site is a trap at any size — that is how an
    // ad sits on top of a video player. Anything else must cover most of the
    // screen: small invisible layers are everywhere in normal pages.
    const offsite = isLink(el) && P.siteKey(el.href) !== "" && P.siteKey(el.href) !== PAGE_SITE;
    return coverage(el) >= (offsite ? 0.02 : 0.5);
  }

  function findTrap(path) {
    for (const node of path) {
      if (node === document.body || node === document.documentElement || node === document) break;
      if (isTrap(node)) return node;
    }
    return null;
  }

  function disarm(el) {
    const fresh = !trapped.has(el);
    trapped.add(el);
    el.setAttribute(OFF, ""); // again, in case the page stripped it
    if (fresh) block("overlay", isLink(el) ? el.href : "");
  }

  /** Deliver a swallowed click to whatever the trap was covering. */
  function forward(x, y) {
    const el = native.elementFromPoint.call(document, x, y);
    if (!el || el.closest("[" + OFF + "]")) return;
    const link = el.closest("a[href],area[href]");
    setIntent(link ? link.href : "", P.INTENT_MS);
    log("click passed through to", el);
    native.dispatchEvent.call(el, new MouseEvt("click", {
      bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y,
    }));
  }

  // Overlays are almost always appended straight to <body> or <html>; watch
  // just those two for additions, and catch everything else at press time.
  const queued = new Set();
  let scanQueued = false;

  function scan() {
    scanQueued = false;
    const nodes = Array.from(queued);
    queued.clear();
    if (!active) return;
    for (const node of nodes) if (!trapped.has(node) && isTrap(node)) disarm(node);
  }

  function queue(nodes) {
    for (const node of nodes) {
      if (node.nodeType === 1 && queued.size < 200) queued.add(node);
    }
    if (queued.size && !scanQueued) {
      scanQueued = true;
      requestAnimationFrame(scan);
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node === document.body) observer.observe(node, { childList: true });
      }
      queue(record.addedNodes);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Input
  // ─────────────────────────────────────────────────────────────
  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPress(event) {
    if (!active || !event.isTrusted) return;
    if (event.type === "pointerdown") pendingForward = null;

    // The click that ends a press a trap swallowed lands on <body> or similar —
    // hand it to the element the user was actually aiming at instead.
    if (event.type === "click" && pendingForward) {
      const { x, y } = pendingForward;
      pendingForward = null;
      swallow(event);
      forward(x, y);
      return;
    }

    const path = event.composedPath();
    const trap = findTrap(path);
    if (trap) {
      disarm(trap);
      swallow(event);
      intent = null;
      if (event.type === "click") forward(event.clientX, event.clientY);
      else if (event.type === "pointerdown" && event.button === 0) {
        pendingForward = { x: event.clientX, y: event.clientY };
      }
      return;
    }

    const link = linkIn(path);
    setIntent(link ? link.href : "", event.type === "contextmenu" ? P.MENU_INTENT_MS : P.INTENT_MS);
  }

  function onKey(event) {
    if (!active || !event.isTrusted || (event.key !== "Enter" && event.key !== " ")) return;
    const link = linkIn(event.composedPath());
    setIntent(link ? link.href : "", P.INTENT_MS);
  }

  // ─────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────
  for (const type of ["pointerdown", "mousedown", "click", "auxclick", "contextmenu"]) {
    native.addEventListener.call(window, type, onPress, true);
  }
  native.addEventListener.call(window, "keydown", onKey, true);

  native.addEventListener.call(document, "pg:config", (event) => {
    let config;
    try { config = JSON.parse(event.detail); } catch (e) { return; }
    active = config.active !== false;
    debug = Boolean(config.debug);
    log(active ? "active on " + PAGE_SITE : "paused");
  });

  if (document.documentElement) {
    installStyle();
    observer.observe(document.documentElement, { childList: true });
    if (document.body) observer.observe(document.body, { childList: true });
  }

  // Late-styled overlays get one sweep once the page has settled.
  native.addEventListener.call(window, "load", () => {
    if (document.body) queue(document.body.children);
  }, { once: true });

  // bridge.js may have loaded first and sent its config to nobody — ask again.
  send("pg:ready", {});
})();
