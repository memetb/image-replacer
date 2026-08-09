# Image Replacer

A Chrome (MV3) extension that replaces every image on a page with a colour
mosaic built from that image's own palette, and lets you bring any of them back
with a right-click.

## Install

`chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
folder.

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
        ◀─write── plumbing    ◀─data:──  path                  routine (worker)
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

**`src/background.js` runs the modification in the service worker**, not the
page. This is what makes replacement work at all: a content-script
`fetch(url, { mode: 'cors' })` against a typical cross-origin image is rejected
outright (`Failed to fetch`), because image hosts don't send
`Access-Control-Allow-Origin`. An extension-origin fetch uses `host_permissions`
and isn't subject to the page's CORS rules. The worker also caches results
across frames and tabs.

If a source still can't be read — 404, opaque redirect, a `blob:` that has been
revoked — the worker synthesizes a mosaic from a hash of the URL instead of
giving up, so an asset is never left un-replaced.

### Restore

Replacing an asset snapshots the exact attributes it is about to overwrite
(`src`, `srcset`, `sizes`, each `<source>` in a `<picture>`, the inline
`background-image`…). Restore replays that snapshot, so the page gets its
original markup back rather than an approximation.

The right-click target is captured in the content script from the `contextmenu`
event's `composedPath()` — the service worker only learns which menu item was
clicked, not what was under the cursor, and `composedPath()` keeps this working
inside shadow DOM. Restore looks for the nearest replaced ancestor first, then
falls back to replaced descendants, so clicking the padding around an image
still does what you meant.

A restored asset stays restored: the `MutationObserver` won't re-replace it
until you ask via "Replace again" or toggle the extension.

## Tests

```
npm install     # playwright
npm test
```

`test/e2e.js` loads the unpacked extension into Chromium and drives a real page
whose images are served **from a different port with no CORS headers** — the
exact case that silently failed before. It checks every asset type in the table
above, plus restore, restore-all, replace-again, the enable/disable toggle, and
the unfetchable-source fallback.
