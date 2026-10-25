/**
 * Popup Guard — site diagnostic.
 * ------------------------------
 * For working out HOW a site throws its popups, so the guard can be tuned.
 *
 *   1. Turn Popup Guard OFF for the site (or remove it from the list) and
 *      reload — otherwise the guard eats the events this wants to see.
 *   2. DevTools → Console → tick "Preserve log". Paste this whole file, Enter.
 *   3. Use the page normally: click play, a thumbnail, empty space — whatever
 *      usually throws the popup. Popups and cross-site redirects are stopped
 *      while this runs, so the page stays put.
 *   4. Run   copy(pgReport())   and paste the result back.
 *
 * Players usually live in an iframe on a different domain. If the popup comes
 * from inside the player, switch the console's context dropdown (top-left,
 * "top") to that iframe and paste this again there too.
 */
(() => {
  const BLOCK = true; // stop popups/redirects while diagnosing
  const started = performance.now();
  const events = [];

  function since() {
    return Math.round(performance.now() - started) + "ms";
  }

  // Which script did it — the useful part of the report.
  function caller() {
    return (new Error().stack || "")
      .split("\n")
      .slice(3, 9)
      .map((line) => line.trim().replace(/^at /, ""))
      .filter((line) => !line.includes("<anonymous>"));
  }

  function note(kind, data) {
    const entry = { at: since(), kind, ...data, stack: caller() };
    events.push(entry);
    console.log("%c[pg-diag] " + kind, "color:#22c55e;font-weight:bold", data, entry.stack);
  }

  function describe(el) {
    if (!(el instanceof Element)) return String(el && el.nodeName);
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    let name = el.tagName.toLowerCase();
    if (el.id) name += "#" + el.id;
    if (typeof el.className === "string" && el.className.trim()) {
      name += "." + el.className.trim().split(/\s+/).slice(0, 3).join(".");
    }
    return name + " [" + [
      style.position,
      "z=" + style.zIndex,
      "op=" + style.opacity,
      "bg=" + style.backgroundColor,
      Math.round(r.width) + "x" + Math.round(r.height),
      el.href ? "href=" + el.href : "",
    ].filter(Boolean).join(" ") + "]";
  }

  function isOffsite(url) {
    try {
      return new URL(url, location.href).hostname !== location.hostname;
    } catch (e) {
      return false;
    }
  }

  // ── Layers big enough to be click-traps ───────────────
  function overlays() {
    const area = innerWidth * innerHeight;
    return Array.from(document.querySelectorAll("body *")).filter((el) => {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "absolute") return false;
      const r = el.getBoundingClientRect();
      return r.width * r.height >= area * 0.3;
    }).map((el) => ({
      element: describe(el),
      text: el.textContent.trim().slice(0, 40),
      hasMedia: Boolean(el.querySelector("img,video,iframe,canvas")),
    }));
  }

  // ── Hooks ─────────────────────────────────────────────
  const open = window.open;
  window.open = function (url, target, features) {
    note("window.open", { url: String(url), target: String(target), features: String(features) });
    return BLOCK ? null : open.apply(this, arguments);
  };

  const click = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function () {
    const link = this.closest && this.closest("a[href]");
    if (link) {
      note("script a.click()", { href: link.href, target: link.target });
      if (BLOCK && isOffsite(link.href)) return;
    }
    return click.apply(this, arguments);
  };

  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    const link = event && event.type === "click" && this.closest && this.closest("a[href]");
    if (link) {
      note("script dispatchEvent(click) on a link", { href: link.href, target: link.target });
      if (BLOCK && isOffsite(link.href)) return false;
    }
    return dispatch.apply(this, arguments);
  };

  if (window.navigation) {
    navigation.addEventListener("navigate", (event) => {
      if (event.hashChange) return;
      const url = event.destination.url;
      note("navigate", {
        url, userInitiated: event.userInitiated, cancelable: event.cancelable, type: event.navigationType,
      });
      if (BLOCK && !event.userInitiated && event.cancelable && isOffsite(url)) event.preventDefault();
    });
  }

  for (const type of ["pointerdown", "mousedown", "click"]) {
    window.addEventListener(type, (event) => {
      if (!event.isTrusted) return;
      const path = event.composedPath().filter((n) => n instanceof Element).slice(0, 10);
      note(type, { target: describe(event.target), path: path.map(describe) });
    }, true);
  }

  // ── Who listens for clicks (DevTools console only) ────
  const listeners = {};
  if (typeof getEventListeners === "function") {
    for (const [name, target] of [["window", window], ["document", document], ["body", document.body]]) {
      const found = getEventListeners(target);
      for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"]) {
        for (const l of found[type] || []) {
          (listeners[name + " " + type] ||= []).push(String(l.listener).slice(0, 160));
        }
      }
    }
  }

  const before = overlays();
  console.log("%c[pg-diag] ready — click around, then run copy(pgReport())", "color:#22c55e;font-weight:bold");
  console.table(before);

  window.pgReport = () => JSON.stringify({
    url: location.href,
    userAgent: navigator.userAgent,
    frames: Array.from(document.querySelectorAll("iframe")).map((f) => f.src || "(about:blank)").slice(0, 20),
    scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean),
    overlaysAtStart: before,
    overlaysNow: overlays(),
    clickListeners: listeners,
    events,
  }, null, 2);
})();
