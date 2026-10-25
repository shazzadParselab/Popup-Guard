// Loads policy.js + guard-main.js into a minimal page-world stub and drives it
// the way a hostile page would: popups, redirects, synthetic link clicks,
// form submits, about:blank iframes and invisible click-traps.
"use strict";

const fs = require("fs");
const vm = require("vm");

const PAGE = "https://www.movies.example/watch/1";

// ── stubs ───────────────────────────────────────────────
class EventTarget {
  addEventListener(type, fn) {
    ((this._l ||= {})[type] ||= []).push(fn);
  }
  removeEventListener() {}
  dispatchEvent(event) {
    for (const fn of ((this._l || {})[event.type] || []).slice()) {
      fn.call(this, event);
      if (event._stopped) break;
    }
    return !event.defaultPrevented;
  }
}

class Element extends EventTarget {
  constructor(tag, attrs = {}) {
    super();
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.parentElement = null;
    this.attrs = { ...attrs };
    this.textContent = "";
    this.computed = null;
    this.rect = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  matches(selector) {
    return selector.split(",").some((part) => {
      const m = part.trim().match(/^(\w*)\[([\w-]+)\]$/);
      return Boolean(m) && (!m[1] || m[1].toUpperCase() === this.tagName) && this.hasAttribute(m[2]);
    });
  }
  closest(selector) {
    for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n;
    return null;
  }
  querySelector() { return null; }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: 10, bottom: 10 }; }
  appendChild(child) { child.parentElement = this; return child; }
}

class HTMLElement extends Element {
  click() { this.nativeClicks = (this.nativeClicks || 0) + 1; }
}
class HTMLAnchorElement extends HTMLElement {
  get href() {
    const h = this.getAttribute("href");
    return h == null ? "" : new URL(h, PAGE).href;
  }
  get target() { return this.getAttribute("target") || ""; }
}
class HTMLAreaElement extends HTMLElement {}
class HTMLFormElement extends HTMLElement {
  submit() { this.submitted = true; }
  requestSubmit() { this.submitted = true; }
}
class HTMLIFrameElement extends HTMLElement {}
Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
  configurable: true, enumerable: true, get() { return this._win || null; },
});
class Document extends EventTarget {
  elementFromPoint() { return this._point || null; }
  createElement(tag) { return new HTMLElement(tag); }
}

class Event {
  constructor(type, init = {}) {
    this.type = type;
    this.defaultPrevented = false;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopImmediatePropagation() { this._stopped = true; }
}
class CustomEvent extends Event {}
class MouseEvent extends Event {}

function el(tag, attrs) {
  const Ctor = { a: HTMLAnchorElement, form: HTMLFormElement, iframe: HTMLIFrameElement }[tag] || HTMLElement;
  const node = new Ctor(tag, attrs);
  body.appendChild(node);
  return node;
}

const document = new Document();
const html = new HTMLElement("html");
const body = new HTMLElement("body");
html.appendChild(body);
Object.assign(document, { documentElement: html, body, head: null });

let opened = [];
let reports = [];
let intents = [];
let navHandler = null;

function open(url) {
  opened.push(String(url));
  return {};
}

const sandbox = {
  console, URL,
  EventTarget, HTMLElement, HTMLAnchorElement, HTMLAreaElement, HTMLFormElement, HTMLIFrameElement,
  Document, CustomEvent, MouseEvent,
  MutationObserver: class { observe() {} },
  requestAnimationFrame: () => 0,
  innerWidth: 1000,
  innerHeight: 800,
  location: { href: PAGE, ancestorOrigins: [] },
  document,
  open,
  getComputedStyle: (node) => ({
    position: "static", opacity: "1", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none",
    ...(node.computed || {}),
  }),
  navigation: { addEventListener(type, fn) { navHandler = fn; } },
};
sandbox.window = sandbox;
sandbox.top = sandbox;

document.addEventListener("pg:report", (e) => reports.push(JSON.parse(e.detail)));
document.addEventListener("pg:intent", (e) => intents.push(JSON.parse(e.detail)));

vm.createContext(sandbox);
for (const file of ["src/core/policy.js", "src/guard-main.js"]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
}

// ── helpers ─────────────────────────────────────────────
let failures = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? "  ✓ " : "  ✗ ") + label + (ok ? "" : "  — got " + JSON.stringify(actual)));
  if (!ok) failures++;
}

function reset() {
  opened = [];
  reports = [];
  intents = [];
}

/** A trusted input event, delivered the way the browser would: window capture first. */
function press(type, path, extra = {}) {
  const event = new MouseEvent(type, { isTrusted: true, button: 0, clientX: 50, clientY: 60, ...extra });
  event.composedPath = () => [...path, body, html, document, sandbox];
  for (const fn of (sandbox._l[type] || [])) {
    fn(event);
    if (event._stopped) break;
  }
  return event;
}

function navigate(url, extra = {}) {
  const event = {
    destination: { url }, userInitiated: false, cancelable: true, hashChange: false,
    downloadRequest: null, navigationType: "push", defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...extra,
  };
  navHandler(event);
  return event.defaultPrevented;
}

// ── boot ────────────────────────────────────────────────
eq("PG_POLICY" in sandbox, false, "policy global is removed before page scripts run");
eq(sandbox.open.toString(), open.toString(), "wrapped window.open still reads as the original");

// ── window.open ─────────────────────────────────────────
reset();
eq(sandbox.open("https://ads.example/x"), null, "popup to another site returns null");
eq(opened, [], "…and never reaches the real window.open");
eq(reports, [{ kind: "popup", url: "https://ads.example/x" }], "…and is reported");

reset();
sandbox.open("/next");
eq(opened, ["/next"], "same-site popup passes");

reset();
eq(sandbox.open(), null, "blank popup is blocked");

reset();
sandbox.open("https://ads.example/", "_self");
eq(opened.length, 1, "_self is a navigation — left to the navigate guard");

// ── intent ──────────────────────────────────────────────
const link = el("a", { href: "https://files.example/dl", target: "_blank" });
const play = el("button");

reset();
press("pointerdown", [link]);
eq(intents, [{ site: "files.example", ms: 2000 }], "press on a cross-site link is reported as intent");
sandbox.open("https://files.example/dl");
eq(opened, ["https://files.example/dl"], "popup to the pressed link's site passes");
eq(sandbox.open("https://ads.example/"), null, "popup elsewhere during the same press is still blocked");

reset();
press("pointerdown", [play]);
eq(sandbox.open("https://files.example/dl"), null, "a press on a non-link clears the intent");

// ── navigation ──────────────────────────────────────────
eq(navigate("https://ads.example/"), true, "script redirect to another site is cancelled");
eq(navigate("https://ads.example/", { userInitiated: true }), false, "user's own navigation is untouched");
eq(navigate("https://www.movies.example/page/2"), false, "same-site navigation is untouched");
eq(navigate("https://ads.example/", { navigationType: "traverse" }), false, "back/forward is untouched");

// ── synthetic clicks + forms ────────────────────────────
reset();
link.click();
eq(link.nativeClicks || 0, 0, "script click on a new-window link to another site is blocked");
eq(link.dispatchEvent(new MouseEvent("click")), false, "dispatchEvent(click) on it is blocked too");
const internal = el("a", { href: "/movie/2", target: "_blank" });
internal.click();
eq(internal.nativeClicks, 1, "script click on a same-site link passes");
const sameTab = el("a", { href: "https://ads.example/" });
sameTab.click();
eq(sameTab.nativeClicks, 1, "same-tab link click is left to the navigate guard");

const form = el("form", { action: "https://ads.example/go", target: "_blank" });
form.submit();
eq(form.submitted, undefined, "form.submit() into a new window on another site is blocked");

// ── about:blank iframe ──────────────────────────────────
reset();
const frame = el("iframe");
frame._win = { open(url) { opened.push("frame:" + url); return {}; } };
eq(frame.contentWindow.open("https://ads.example/"), null, "iframe's own window.open is guarded too");
eq(opened, [], "…and never reaches the frame's real window.open");

// ── click-traps ─────────────────────────────────────────
const under = el("button");
let underClicks = 0;
under.addEventListener("click", () => underClicks++);
document._point = under;

const trap = el("div");
trap.computed = { position: "fixed", opacity: "0" };
trap.rect = { left: 0, top: 0, right: 1000, bottom: 800 };

reset();
const down = press("pointerdown", [trap]);
eq(Boolean(down.defaultPrevented && down._stopped), true, "press on an invisible full-screen layer is swallowed");
eq(trap.hasAttribute("data-pg-off"), true, "…the layer is switched off");
eq(reports.map((r) => r.kind), ["overlay"], "…and reported once");
press("click", [body]);
eq(underClicks, 1, "the click reaches what the layer was covering");

const adOnPlayer = el("a", { href: "https://ads.example/" });
adOnPlayer.computed = { position: "absolute", opacity: "0" };
adOnPlayer.rect = { left: 0, top: 0, right: 400, bottom: 225 };
eq(Boolean(press("pointerdown", [adOnPlayer])._stopped), true, "small invisible link to another site is a trap");

const cardLink = el("a", { href: "/movie/3" });
cardLink.computed = { position: "absolute", opacity: "0" };
cardLink.rect = { left: 0, top: 0, right: 300, bottom: 200 };
eq(Boolean(press("pointerdown", [cardLink])._stopped), false, "small invisible same-site card link is left alone");

const header = el("div");
header.computed = { position: "fixed", backgroundColor: "rgb(255, 255, 255)" };
header.rect = { left: 0, top: 0, right: 1000, bottom: 800 };
eq(Boolean(press("pointerdown", [header])._stopped), false, "visible full-screen layer is left alone");

// ── live pause from bridge.js ───────────────────────────
document.dispatchEvent(new CustomEvent("pg:config", { detail: JSON.stringify({ active: false }) }));
reset();
sandbox.open("https://ads.example/");
eq(opened.length, 1, "paused guard lets everything through");

if (failures) process.exit(1);
