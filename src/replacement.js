// replacement.js
//
// THE image modification routine. Every asset type in this extension -- <img>,
// <picture>, CSS backgrounds, <video> posters, SVG <image>, <input type=image>,
// <object>/<embed> -- funnels through `replacementFor()`. Nothing else in the
// codebase is allowed to synthesize a replacement, so changing the look of a
// replaced asset means editing this file and only this file.
//
// It runs in the background context rather than the page for two reasons:
//   1. Extension-origin fetches use host_permissions, so they are not subject
//      to the page's CORS rules. A content script fetch fails on most
//      cross-origin images; this one does not.
//   2. The results cache is shared across every frame and tab.
//
// Loaded as a classic script (Chrome: importScripts from src/sw.js, Firefox:
// background.scripts), so it publishes one global instead of using ES exports.

(() => {
  const TILE_SIZE = 24;

  // Caps on the canvas we rasterize. Flat-colour mosaics compress well, but the
  // backing store is 4 bytes/pixel while we are drawing it.
  const MAX_DIM = 4096;
  const MAX_PIXELS = 16 * 1024 * 1024;

  // The palette is sampled from a downscale of the source: a few thousand
  // pixels is plenty to pick tile colours from, and it keeps peak memory flat
  // regardless of how large the original image was.
  const SAMPLE_DIM = 256;

  // Used when the source cannot be decoded at all and the caller told us how
  // much space the asset occupies on screen.
  const FALLBACK_DIM = 300;
  const MIN_FALLBACK = 32;
  const MAX_FALLBACK = 1024;

  const CACHE_LIMIT = 240;

  /** @type {Map<string, object>} LRU of finished replacements. */
  const cache = new Map();
  /** @type {Map<string, Promise<object>>} De-dupes concurrent requests. */
  const inflight = new Map();

  /**
   * Produce a replacement for one source URL.
   *
   * Always resolves. If the source cannot be fetched or decoded we still return
   * a replacement -- one synthesized from the URL -- because the contract this
   * extension makes with the user is that *every* asset gets replaced, not
   * every asset we happen to be able to read.
   *
   * @param {{url: string, width?: number, height?: number}} request
   *   `width`/`height` are the asset's on-screen size, used only as a fallback
   *   when the real intrinsic size is unavailable.
   * @returns {Promise<{dataUrl: string, width: number, height: number, synthetic: boolean}>}
   */
  function replacementFor(request) {
    const key = cacheKey(request);

    const hit = cache.get(key);
    if (hit) {
      cache.delete(key); // re-insert to keep LRU ordering
      cache.set(key, hit);
      return Promise.resolve(hit);
    }

    const pending = inflight.get(key);
    if (pending) return pending;

    const job = build(request)
      .then((result) => {
        inflight.delete(key);
        remember(key, result);
        return result;
      })
      .catch((err) => {
        inflight.delete(key);
        throw err;
      });

    inflight.set(key, job);
    return job;
  }

  function clearReplacementCache() {
    cache.clear();
  }

  async function build({ url, width, height }) {
    const sample = await sampleSource(url);

    if (sample) {
      const { canvasWidth, canvasHeight } = fitCanvas(sample.width, sample.height);
      const dataUrl = await paintMosaic(canvasWidth, canvasHeight, sample.colors);
      return { dataUrl, width: canvasWidth, height: canvasHeight, synthetic: false };
    }

    // Nothing decodable. Fall back to the on-screen box and a palette derived
    // from the URL, so the same unreachable asset always looks the same.
    const w = clampFallback(width);
    const h = clampFallback(height);
    const colors = syntheticPalette(url, tileCount(w, h));
    const dataUrl = await paintMosaic(w, h, colors);
    return { dataUrl, width: w, height: h, synthetic: true };
  }

  /**
   * Fetch and decode the source, returning its intrinsic size plus the palette
   * the mosaic will be built from. Returns null if the source is unusable.
   */
  async function sampleSource(url) {
    let bitmap = null;
    try {
      const resp = await fetch(url, { credentials: 'omit', redirect: 'follow' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (!blob.size) return null;
      bitmap = await createImageBitmap(blob);
    } catch {
      return null;
    }

    try {
      const width = bitmap.width;
      const height = bitmap.height;
      if (!width || !height) return null;

      // Downscale into a small canvas purely to read pixels from.
      const scale = Math.min(1, SAMPLE_DIM / Math.max(width, height));
      const sw = Math.max(1, Math.round(width * scale));
      const sh = Math.max(1, Math.round(height * scale));

      const canvas = new OffscreenCanvas(sw, sh);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, sw, sh);
      const { data } = ctx.getImageData(0, 0, sw, sh);

      return { width, height, colors: extractPalette(data, tileCount(width, height)) };
    } catch {
      // Tainted canvas, decode failure, OOM -- treat as unusable.
      return null;
    } finally {
      bitmap.close?.();
    }
  }

  /**
   * Pull up to `n` colours out of raw RGBA pixels using a fixed stride.
   *
   * The stride is deliberate: walking the image at a coarse, regular interval
   * gathers colours that belong to the original while scrambling where they
   * sit, so the mosaic reads as "same palette, no content". Sampling in place
   * -- or averaging per tile -- would reproduce a recognizable pixelation of
   * the source, which is exactly what this extension exists to prevent.
   */
  function extractPalette(data, n) {
    const pixels = data.length / 4;
    if (!pixels) return ['rgb(0,0,0)'];

    const colors = [];
    const step = Math.max(1, Math.floor(pixels / n));

    for (let p = 0; p < pixels && colors.length < n; p += step) {
      const i = p * 4;
      // Composite against white so transparent regions don't read as black.
      const a = data[i + 3] / 255;
      const r = Math.round(data[i] * a + 255 * (1 - a));
      const g = Math.round(data[i + 1] * a + 255 * (1 - a));
      const b = Math.round(data[i + 2] * a + 255 * (1 - a));
      colors.push(`rgb(${r},${g},${b})`);
    }

    return colors.length ? colors : ['rgb(0,0,0)'];
  }

  /**
   * A stable palette for sources we could not read, derived from the URL so a
   * given asset keeps a consistent appearance across reloads and tabs.
   */
  function syntheticPalette(url, n) {
    let seed = hash32(url);
    const next = () => {
      // xorshift32
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 0xffffffff;
    };

    const baseHue = Math.floor(next() * 360);
    const colors = [];
    for (let i = 0; i < n; i++) {
      const hue = (baseHue + next() * 60) % 360;
      const sat = 25 + next() * 35;
      const light = 45 + next() * 35;
      colors.push(`hsl(${hue.toFixed(0)},${sat.toFixed(0)}%,${light.toFixed(0)}%)`);
    }
    return colors;
  }

  /** Rasterize the tile grid. This is the only place pixels are drawn. */
  async function paintMosaic(width, height, colors) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);

    const tilesX = Math.ceil(width / TILE_SIZE);
    const tilesY = Math.ceil(height / TILE_SIZE);

    let i = 0;
    for (let y = 0; y < tilesY; y++) {
      for (let x = 0; x < tilesX; x++) {
        ctx.fillStyle = colors[i % colors.length];
        ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        i++;
      }
    }

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return blobToDataUrl(blob);
  }

  function tileCount(width, height) {
    return Math.ceil(width / TILE_SIZE) * Math.ceil(height / TILE_SIZE);
  }

  /** Keep the replacement at the source's intrinsic size where we safely can. */
  function fitCanvas(width, height) {
    let w = width;
    let h = height;

    const longest = Math.max(w, h);
    if (longest > MAX_DIM) {
      const s = MAX_DIM / longest;
      w = Math.round(w * s);
      h = Math.round(h * s);
    }

    if (w * h > MAX_PIXELS) {
      const s = Math.sqrt(MAX_PIXELS / (w * h));
      w = Math.round(w * s);
      h = Math.round(h * s);
    }

    return { canvasWidth: Math.max(1, w), canvasHeight: Math.max(1, h) };
  }

  function clampFallback(value) {
    const v = Math.round(Number(value) || 0);
    if (!v) return FALLBACK_DIM;
    return Math.min(MAX_FALLBACK, Math.max(MIN_FALLBACK, v));
  }

  // `URL.createObjectURL` is unavailable in a service worker and `FileReader`
  // is unavailable in Chrome's, so base64 is assembled by hand. This works
  // unchanged in Firefox's background page.
  async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
  }

  function cacheKey({ url, width, height }) {
    // data:/blob:-derived URLs can be megabytes; don't retain them as map keys.
    const id = url.length > 256 ? `#${hash32(url)}:${url.length}` : url;
    return `${id}|${clampFallback(width)}x${clampFallback(height)}`;
  }

  function remember(key, value) {
    cache.set(key, value);
    while (cache.size > CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
  }

  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  globalThis.ImageReplacement = { replacementFor, clearReplacementCache };
})();
