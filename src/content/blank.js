// blank.js -- the fast pass.
//
// Replacement happens in two passes:
//
//   fast (this file)  synchronous, in-page, no I/O. Swaps the source for a
//                     transparent image of the same size, so the original is
//                     never painted. Runs the instant an element is discovered.
//   slow (mosaic)     the palette mosaic from src/replacement.js, fetched from
//                     the background context and applied when it arrives.
//
// This is the single definition of what a fast-pass replacement looks like, the
// way src/replacement.js is the single definition of the slow one. It lives in
// the content script rather than the background because "immediately" rules out
// a message round-trip.

(() => {
  const IR = (globalThis.__IMAGE_REPLACER__ ||= {});
  if (IR.blank) return;

  // 1x1 fully transparent PNG. Used when the asset's size cannot be determined
  // yet -- see `blank()`.
  const PIXEL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

  const cache = new Map();
  const CACHE_LIMIT = 64;

  /**
   * A transparent image with the given intrinsic size.
   *
   * An empty SVG is the cheapest way to mint one at an arbitrary size: it is a
   * string, so there is no canvas, no encoding and no async step, and the
   * browser treats its width/height as the intrinsic size. That keeps the
   * element's layout box identical to the original for anything sized by its
   * image rather than by CSS.
   *
   * When the size isn't known -- an <img> that has neither loaded nor declared
   * width/height, which is common at document_start -- fall back to a 1x1
   * pixel. It cannot match the original box, but it errs small, so the page
   * settles by expanding when the mosaic lands rather than collapsing.
   */
  function blank(width, height) {
    const w = Math.round(Number(width) || 0);
    const h = Math.round(Number(height) || 0);
    if (w <= 0 || h <= 0) return PIXEL;

    const key = `${w}x${h}`;
    let url = cache.get(key);
    if (!url) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`;
      url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(key, url);
    }
    return url;
  }

  IR.blank = blank;
  IR.BLANK_PIXEL = PIXEL;
})();
