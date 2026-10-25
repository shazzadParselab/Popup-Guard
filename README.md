# Popup Guard

A personal Chrome/Edge extension (Manifest V3, no build step, no dependencies)
that stops pop-unders, redirect hijacks and invisible click-trap overlays —
**only on the sites you choose**.

Every other site never sees it: no script is injected and no permission is held
until you press **Protect this site** in the popup.

---

## What it stops

| Trick | What the site does | What happens instead |
|---|---|---|
| **Pop-under** | Your click on Play also runs `window.open(ad)` | `window.open` returns `null`, as if Chrome's popup blocker caught it |
| **Click-trap** | An invisible layer covers the page, so every click hits the ad | The layer is switched off and your click goes to what you aimed at |
| **Tab-under / redirect** | The page sends itself to an ad (`location = …`) | The navigation is cancelled |
| **Synthetic link** | A script builds `<a target=_blank>` and clicks it | The click is dropped |
| **Iframe popup** | A cross-origin ad iframe opens a tab | The new tab is closed straight away |

Anything blocked shows a small notice on the page with an **Open** button, so a
false positive costs one click.

## The rule

There is no blocklist. A protected page may open a window, or move itself, to:

- **its own site** — always;
- **another site** — only if you just pressed a real, visible link to that site.

So a download link to a file host still works, and an ad fired from a press on
a play button does not. The rule lives in [`src/core/policy.js`](src/core/policy.js).

---

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this folder.
4. Pin it. On a problem site, open the popup → **Protect this site** → allow.
   The tab reloads with protection on.

Requires Chrome/Edge **111+**.

---

## Project structure

```
manifest.json
src/
  core/
    defaults.js   every setting + its default
    policy.js     ★ site matching and the allow/block rule (pure functions)
  guard-main.js   ★ page world: window.open, navigation, synthetic clicks, click-traps
  bridge.js       isolated world: relays guard ↔ extension, draws the on-page notice
  background.js   service worker: per-site registration, tab watcher, stats
popup/            master switch, "Protect this site", protected-site list
tools/
  diagnose.js     console snippet for working out how a site throws popups
test/             node scripts — `node test/run.js`
```

★ = the two files you will edit most.

## How it works

**Per-site registration.** Nothing is in the manifest's `content_scripts`. The
service worker registers the guard with `chrome.scripting` for exactly the
listed sites whose permission is granted (`optional_host_permissions`), and
reconciles that on every list, permission or master-switch change.

**Three layers.**
1. **`guard-main.js`** runs in the page world at `document_start`, before any
   page script, and wraps the natives that open windows or move the page.
   It also remembers each press on a real link (an "intent") — the rule above
   is decided against that.
2. **`bridge.js`** runs in the isolated world. The page world cannot use
   `chrome.*`, so blocks and intents come through here as DOM events.
3. **`background.js`** watches `webNavigation.onCreatedNavigationTarget`.
   It catches what the page-world guard cannot see — mostly popups opened
   from inside a cross-origin ad iframe.

**No polling.** Everything is event-driven. The only observer watches direct
children of `<body>`/`<html>` for new overlays, coalesced to one check per
frame.

---

## When a site still gets through

1. In the popup, turn on **Log decisions to the console** and reload the site —
   every block is logged as `[Popup Guard]`.
2. Remove the site from the list, reload, and paste
   [`tools/diagnose.js`](tools/diagnose.js) into the DevTools console. Click
   around the way that normally triggers the popup, then run `copy(pgReport())`.
   The report shows which script called what, and every overlay on the page.
3. If the popup comes from inside the video player, it is probably an iframe on
   another domain. Add that domain to the list too: open the iframe's URL in a
   tab and press **Protect this site**.

## Tests

`node test/run.js` — no framework, no install. It checks that every referenced
file exists and parses, the site-matching rules, and that the page-world guard
really blocks popups, redirects, synthetic clicks, iframe popups and
click-traps while letting real link presses through. Everything else needs a
real browser.

---

## Notes / limitations

- "Same site" uses a short built-in list of country second-level domains
  (`co.uk`, `com.bd`, …) rather than the full public-suffix list. When unsure it
  treats a domain as a different site, which errs towards blocking.
- The guard and the bridge talk over DOM events, which a page could forge. The
  worst a page can do with that is pause the guard or inflate the counter.
- A same-tab navigation started by script on a protected site is blocked even
  when it is legitimate (for example "Sign in with Google" done via JS). Use
  **Open** on the notice.
- `webNavigation` shows up in Chrome's install prompt as "read your browsing
  history"; it is only used to see which tab opened which.
