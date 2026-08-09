# Image Replacer

An MV3 browser extension for Chrome and Firefox that replaces images with a
colour mosaic built from each image's own palette, and lets you bring any of
them back with a right-click.

It is **off by default and everywhere**. Nothing is touched until you switch a
site on, and that choice is remembered per site. On a site that is switched on,
replacement happens in two passes: an image is blanked the instant it is seen,
then upgraded to its mosaic when that is ready.

## Install

**Chrome / Edge** — `chrome://extensions` → enable Developer mode → **Load
unpacked** → pick this folder.

**Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → pick `manifest.json`.

> **Firefox users: grant host permissions.** Firefox MV3 treats
> `host_permissions` as opt-in, so they are *not* granted on install. Open
> `about:addons` → Image Replacer → Permissions → enable **Access your data for
> all websites**.
>
> Without them the extension cannot work at all on Firefox: the tab's URL is
> withheld, so it can't tell which site you're on, and the toolbar button will
> say the page isn't available. Granting them also unblocks the background
> fetch — otherwise mosaics get synthesized from the image URL rather than
> sampled from the image's own palette.

## Using it

Nothing happens until you switch a site on. Two ways to do it, and they are the
same switch:

- **Right-click anywhere → Image Replacer → Always Replace Images from this
  site.** It is a checkbox; clicking it again switches the site back off.
- **The toolbar button**, which reads *Replace images on this site* or *Disable
  for this site* depending on where you are.

The toolbar icon shows the state at a glance: a green **ON** badge and a
full-colour icon where the extension is working, a faded icon where it isn't.

Once a site is on, its images are replaced automatically, including ones the
page adds later. Each one blanks immediately and fills in with its mosaic a
moment later. The rest of the right-click menu acts on individual images:

- **Restore** puts back the image under the cursor.
- **Restore all images on this page** puts back everything.
- **Replace again** re-replaces something you restored.

Those three are greyed out when they would do nothing — the menu can be opened
anywhere, so most of the time there is no image under the cursor to act on.

### Which sites

A site is a **hostname**. `example.com` and `docs.example.com` are separate
entries, because they are frequently unrelated; `http://` and `https://` of the
same host are one entry.

Every frame in a tab follows the site in the address bar, so switching on a site
also covers the images in its cross-origin iframes. Browser-internal pages
(`chrome://`, `about:`) can't be switched on at all, and the toolbar button says
so.

## What counts as an image

| Asset | Handled by |
| --- | --- |
| `<img>`, including `srcset` and `<picture>`/`<source>` | `imgAdapter` |
| `<input type="image">` | `inputImageAdapter` |
| `<video poster>` | `posterAdapter` |
| SVG `<image>` (`href` and `xlink:href`) | `svgImageAdapter` |
| `<object>` / `<embed>` pointing at an image | `embeddedAdapter` |
| CSS `background-image`, including multi-layer values | `backgroundAdapter` |

Also covered: open shadow roots, every frame on the page, `data:` and `blob:`
sources, and images the page swaps in after load.

`<canvas>` is deliberately left alone — overwriting it would break pages that
draw to it as part of their normal operation.

## How it fits together

```
                 adapters.js         pipeline.js            blank.js
   DOM  ──read──▶ per-type   ──1──▶  the common  ──sync──▶  fast pass
        ◀─write── plumbing   ──2──▶  path        ──msg───▶  replacement.js
                                                            slow pass (bg)
```

### Deciding whether to run at all

`src/sites.js` owns the list and the hostname rule. Everything else asks it.

A content script cannot make this decision itself. A subframe only knows its own
URL, and "this site" means the site in the address bar — so at `document_start`
each content script asks the background context, which reads `sender.tab.url`,
and does nothing until the answer arrives. That is also why the extension being
off costs a page essentially nothing: one message, no scanning, no observers
doing work.

Writing the list is the only thing a toggle does. `chrome.storage.onChanged` in
the background is the single fan-out point, so the context menu, the popup, and
a second window's copy of either all take the same path: it re-evaluates every
open tab, pushes the new state into each one's frames, and repaints the icons.
Switching a site off restores its pages; switching it back on replaces again.

### The two passes

`runAdapter()` runs both, in order, for every asset:

| | fast pass | slow pass |
| --- | --- | --- |
| produces | a transparent image of the same size | the palette mosaic |
| defined in | `src/content/blank.js` | `src/replacement.js` |
| runs in | the page, synchronously | the background context |
| cost | a string concat | a fetch, a decode and a rasterize |
| when | the moment the element is discovered | when the round-trip returns |

The fast pass exists because the slow one cannot be immediate: it needs a
message round-trip and a network fetch, and until it returns the original would
otherwise still be on screen. So the original is swapped for an empty SVG of the
same intrinsic size — a string, so there is no canvas, no encoding and no async
step — and the mosaic paints over it when it arrives.

Both are reached through the same `runAdapter()`, which does the fast pass
before its first `await`. Callers get it just by calling `runAdapter` without
awaiting; there is no separate fast-pass entry point to forget.

Two consequences worth knowing:

- **Sizing.** The blank matches the original's box whenever the size is knowable
  — `naturalWidth`, a `width`/`height` attribute, or a laid-out box. At
  `document_start` an image with none of those has no knowable size, so the
  blank falls back to a 1×1 pixel and the box settles when the mosaic lands with
  the true dimensions. It errs small, so the page expands into place rather than
  collapsing.
- **The preload scanner still fetches the original.** It starts requesting
  images while the HTML is being parsed, before the element is in the DOM and
  before any content script can see it. The fast pass guarantees the response is
  never *displayed*; it cannot stop the request. Blocking that would need
  `declarativeNetRequest`, which is a much bigger hammer.

Discovery is split to match. Adapters whose `match()` is a cheap tag test are
run synchronously as elements appear, so the fast pass beats first paint. The
CSS background adapter can't be — matching it means a `getComputedStyle` per
element, far too expensive to do synchronously during parsing — so it goes
through the idle queue.

**`src/replacement.js` is the single slow-pass routine**, and
`src/content/blank.js` the single fast-pass one. Every asset type, without
exception, gets its mosaic from `replacementFor()` and its placeholder from
`blank()`. Changing how a replaced image looks means editing one of those two
files.

**`src/content/pipeline.js` is the single common path.** `runAdapter()` is the
only code that writes a replacement into the page — either pass, every asset
type — and `restoreRecord()` is the only code that undoes one. It owns the bookkeeping in between: what has been
replaced, what the original looked like, and what must not be touched again.

**`src/content/adapters.js` is pure plumbing.** An adapter says how to read
source URLs off an element and how to write them back — `sources`, `capture`,
`apply`, `restore`. It contains no image logic and never decides what a
replacement looks like. Supporting a new asset type means adding an adapter
here and nothing else.

**`src/menus.js` and `src/indicator.js` are the two bits of chrome-facing UI.**
menus.js defines the right-click items and applies state to them; indicator.js
paints the toolbar badge, title and icon per tab. The faded "off" icon is
generated at runtime from the shipped PNGs, so there is no second set of image
files to keep in sync.

The restore items are kept in the right state by the content script reporting
what is under the pointer as it moves, rather than when the menu opens. Chrome
has no "menu is about to show" event, and computing it on the `contextmenu`
event alone races with the menu being built — `mouseover` fires when the pointer
crosses into a new element, and the report is skipped unless the answer changed,
so the state is already correct by the time anyone right-clicks.

**`src/background.js` runs the modification in the background context**, not the
page. This is what makes replacement work at all: a content-script
`fetch(url, { mode: 'cors' })` against a typical cross-origin image is rejected
outright (`Failed to fetch`), because image hosts don't send
`Access-Control-Allow-Origin`. An extension-origin fetch uses `host_permissions`
and isn't subject to the page's CORS rules. The worker also caches results
across frames and tabs.

If a source still can't be read — 404, opaque redirect, a `blob:` that has been
revoked, Firefox host permissions not yet granted — the background context
synthesizes a mosaic from a hash of the URL instead of giving up, so an asset is
never left un-replaced.

### Running in both browsers

Chrome MV3 wants a single `background.service_worker`; Firefox doesn't support
that key at all and requires `background.scripts`. Rather than maintain two
builds, the manifest declares both and they load the same classic scripts in the
same order — Firefox straight from `background.scripts`, Chrome through
`src/sw.js`, which is just an `importScripts` shim. Each browser ignores the key
it doesn't use.

That's also why the background code is classic scripts publishing a global
rather than ES modules: `"type": "module"` for background scripts only landed in
recent Firefox, while `importScripts` works everywhere MV3 does.

The one other portability trap is the API namespace. Firefox exposes promises on
`browser.*` but keeps `chrome.*` callback-only, so every extension API call here
uses the callback form with a `chrome.runtime.lastError` check — that shape works
identically in both.

### Restore

Replacing an asset snapshots the exact attributes it is about to overwrite
(`src`, `srcset`, `sizes`, each `<source>` in a `<picture>`, the inline
`background-image`…). Restore replays that snapshot, so the page gets its
original markup back rather than an approximation.

The right-click target is captured in the content script from the `contextmenu`
event's `composedPath()` — the background context only learns which menu item was
clicked, not what was under the cursor, and `composedPath()` keeps this working
inside shadow DOM. Restore looks for the nearest replaced ancestor first, then
falls back to replaced descendants, so clicking the padding around an image
still does what you meant.

Restore works from either pass. The snapshot is taken before the fast pass, so
an asset still showing its blank restores just as well as one showing its
mosaic; if its slow pass is still in flight, the mosaic is discarded when it
arrives rather than painted over the restored original.

A restored asset stays restored: the `MutationObserver` won't re-replace it
until you ask via "Replace again" or toggle the extension.

## Tests

```
npm install
npm test              # end-to-end, in Chromium
npm run lint:firefox  # validates the manifest against Firefox's schema
```

`test/e2e.js` loads the unpacked extension into Chromium and drives a real page
whose images are served **from a different port with no CORS headers** — the
exact case that silently failed before. It checks every asset type in the table
above, plus both passes, restore, restore-all, replace-again, the per-site
switch, and the unfetchable-source fallback.

It starts by checking that a fresh profile replaces nothing, then switches the
site on through `handleMenuClick` — the same function Chrome calls, since a menu
item cannot be clicked programmatically — and checks the badge, title and menu
state that follow.

The fast pass is checked against images whose responses the fixture server holds
open, so the blank is observably in place before the mosaic can exist. Note that
the blank's fallback placeholder is itself a `data:image/png` URL, so the test
reads that constant out of `blank.js` — asserting only "is a PNG data URL" would
pass on the placeholder and never notice a broken slow pass.

Set `IR_CHROMIUM` to point at a specific Chromium binary if Playwright's bundled
one isn't what you want to test against.

`npm run lint:firefox` runs `addons-linter` over the shippable files. It should
report **0 errors**. Two warnings are expected:

- `BACKGROUND_SERVICE_WORKER_IGNORED` — intentional, and the thing that makes
  the dual-manifest approach work. It confirms Firefox is falling through to
  `background.scripts`.
- `MISSING_DATA_COLLECTION_PERMISSIONS` — only required to list on AMO. Adding
  the key would force `strict_min_version` up to 140, which isn't worth dropping
  Firefox 115–139 support for an extension that isn't listed.

The e2e suite only exercises Chromium; there's no Firefox binary in the
development container. Firefox coverage is schema validation plus manual
testing.
