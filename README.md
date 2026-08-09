# Image Replacer

An MV3 browser extension for Chrome and Firefox that replaces every image on a
page with a colour mosaic built from that image's own palette, and lets you
bring any of them back with a right-click.

## Install

**Chrome / Edge** — `chrome://extensions` → enable Developer mode → **Load
unpacked** → pick this folder.

**Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → pick `manifest.json`.

> **Firefox users: grant host permissions.** Firefox MV3 treats
> `host_permissions` as opt-in, so they are *not* granted on install. Open
> `about:addons` → Image Replacer → Permissions → enable **Access your data for
> all websites**. Without it the extension still replaces every image, but the
> background fetch is blocked by CORS, so mosaics are synthesized from the image
> URL rather than sampled from the image's own palette.

## Using it

- Images are replaced automatically on every page, including ones the page adds
  later.
- **Right-click → Restore** puts back the image under the cursor.
- **Right-click → Restore all images on this page** puts back everything.
- **Right-click → Replace again** re-replaces something you restored.
- The toolbar button toggles the extension. Turning it off restores the current
  page; turning it back on replaces again.

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
                 adapters.js            pipeline.js           replacement.js
   DOM  ──read──▶ per-type    ──URLs──▶  the common  ──msg──▶  the modification
        ◀─write── plumbing    ◀─data:──  path                  routine (bg)
```

**`src/replacement.js` is the single modification routine.** Every asset type,
without exception, gets its replacement from `replacementFor()`. Changing how a
replaced image looks means editing that one file.

**`src/content/pipeline.js` is the single common path.** `runAdapter()` is the
only code that writes a replacement into the page, and `restoreRecord()` is the
only code that undoes one. It owns the bookkeeping in between: what has been
replaced, what the original looked like, and what must not be touched again.

**`src/content/adapters.js` is pure plumbing.** An adapter says how to read
source URLs off an element and how to write them back — `sources`, `capture`,
`apply`, `restore`. It contains no image logic and never decides what a
replacement looks like. Supporting a new asset type means adding an adapter
here and nothing else.

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
above, plus restore, restore-all, replace-again, the enable/disable toggle, and
the unfetchable-source fallback. Set `IR_CHROMIUM` to point at a specific
Chromium binary if Playwright's bundled one isn't what you want to test against.

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
