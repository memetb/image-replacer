// adapters.js
//
// One adapter per asset type. An adapter is pure plumbing: it knows how to read
// the source URLs off an element, how to write replacements back, and how to
// undo that. It never decides *what* the replacement looks like -- that lives
// in blank.js (fast pass) and src/replacement.js (slow pass), and every adapter
// reaches both through the single pipeline in pipeline.js. `apply()` is called
// once per pass with whatever that pass produced.
//
// `eager: true` means match() is cheap enough to run synchronously on every
// element as the document parses, which is what lets the fast pass blank an
// asset before it paints. Only the CSS background adapter opts out: matching it
// costs a getComputedStyle per element.
//
// Adding support for a new asset type means adding an adapter here and nothing
// else.

(() => {
  const IR = (globalThis.__IMAGE_REPLACER__ ||= {});
  if (IR.adapters) return;

  // ---------------------------------------------------------------- helpers

  const absolute = (url, el) => {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (!trimmed) return '';
    try {
      return new URL(trimmed, el?.ownerDocument?.baseURI || location.href).href;
    } catch {
      return '';
    }
  };

  const snapshotAttrs = (el, names) => names.map((n) => [n, el.getAttribute(n)]);

  const restoreAttrs = (el, snap) => {
    for (const [name, value] of snap) {
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
  };

  const boxOf = (el) => {
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    return { width: Math.round(rect?.width || 0), height: Math.round(rect?.height || 0) };
  };

  const positiveInt = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  /**
   * Best-effort intrinsic size, used to size the fast pass's transparent
   * placeholder. Ordered most to least authoritative. All of these can be zero
   * at document_start, before layout and before the image has loaded -- that is
   * expected, and blank() handles it.
   */
  const intrinsicSize = (el) => {
    const box = boxOf(el);
    return {
      width: el.naturalWidth || positiveInt(el.getAttribute('width')) || box.width,
      height: el.naturalHeight || positiveInt(el.getAttribute('height')) || box.height,
    };
  };

  /**
   * First candidate URL in a srcset, so an <img> carrying only a srcset can be
   * blanked immediately instead of waiting for the browser to resolve one.
   *
   * Splitting on commas is not the full srcset grammar and will mangle a
   * candidate whose URL contains an unencoded comma. That costs a palette --
   * the slow pass falls back to a synthesized mosaic -- and never a correct
   * blank, so it is the right trade for not showing the original.
   */
  const firstSrcsetCandidate = (el) => {
    const raw =
      el.getAttribute('srcset') ||
      el.closest?.('picture')?.querySelector('source[srcset]')?.getAttribute('srcset') ||
      '';
    for (const part of raw.split(',')) {
      const candidate = part.trim().split(/\s+/)[0];
      const url = absolute(candidate, el);
      if (url) return url;
    }
    return '';
  };

  const looksLikeImage = (type, url) =>
    (type && /^image\//i.test(type)) ||
    /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(\?|#|$)/i.test(url || '');

  // Matches every url(...) token in a CSS value, quoted or bare.
  const CSS_URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s][^)]*?))\s*\)/g;

  const cssUrls = (value) => {
    if (!value || value === 'none') return [];
    const out = [];
    CSS_URL_RE.lastIndex = 0;
    let m;
    while ((m = CSS_URL_RE.exec(value)) !== null) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (raw) out.push(raw);
    }
    return out;
  };

  /** Rewrite the Nth url(...) token using `pick(index, originalUrl)`. */
  const replaceCssUrls = (value, pick) => {
    let i = 0;
    CSS_URL_RE.lastIndex = 0;
    return value.replace(CSS_URL_RE, (match, dq, sq, bare) => {
      const raw = (dq ?? sq ?? bare ?? '').trim();
      if (!raw) return match;
      const next = pick(i++, raw);
      return next ? `url("${next}")` : match;
    });
  };

  // ---------------------------------------------------------------- adapters

  /** Plain <img>, including the <picture> wrapper and any srcset variants. */
  const imgAdapter = {
    name: 'img',
    eager: true,
    match: (el) => el.tagName === 'IMG',

    sources(el) {
      const url = el.currentSrc || el.src || absolute(el.getAttribute('src'), el);
      if (url) return [{ key: 'src', url }];
      const fromSrcset = firstSrcsetCandidate(el);
      return fromSrcset ? [{ key: 'src', url: fromSrcset }] : [];
    },

    hint: intrinsicSize,

    capture(el) {
      const snap = { img: snapshotAttrs(el, ['src', 'srcset', 'sizes']), sources: [] };
      const picture = el.closest?.('picture');
      if (picture) {
        for (const source of picture.querySelectorAll('source')) {
          snap.sources.push([source, snapshotAttrs(source, ['srcset', 'src', 'sizes'])]);
        }
      }
      return snap;
    },

    apply(el, replacements) {
      // A <picture>'s <source> elements outrank the <img>'s own src, and srcset
      // would let the browser swap our replacement back out on resize. Both have
      // to go, and both are restored from the snapshot.
      const picture = el.closest?.('picture');
      if (picture) {
        for (const source of picture.querySelectorAll('source')) {
          source.removeAttribute('srcset');
          source.removeAttribute('src');
        }
      }
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
      el.setAttribute('src', replacements.get('src'));
    },

    restore(el, snap) {
      for (const [source, attrs] of snap.sources) restoreAttrs(source, attrs);
      restoreAttrs(el, snap.img);
    },
  };

  /** <input type="image"> -- a submit button rendered as an image. */
  const inputImageAdapter = {
    name: 'input-image',
    eager: true,
    match: (el) => el.tagName === 'INPUT' && el.type === 'image',
    sources: (el) => {
      const url = el.src || absolute(el.getAttribute('src'), el);
      return url ? [{ key: 'src', url }] : [];
    },
    hint: intrinsicSize,
    capture: (el) => snapshotAttrs(el, ['src']),
    apply: (el, replacements) => el.setAttribute('src', replacements.get('src')),
    restore: restoreAttrs,
  };

  /** <video poster="..."> -- the still frame shown before playback. */
  const posterAdapter = {
    name: 'video-poster',
    eager: true,
    match: (el) => el.tagName === 'VIDEO' && !!el.getAttribute('poster'),
    sources: (el) => {
      const url = el.poster || absolute(el.getAttribute('poster'), el);
      return url ? [{ key: 'poster', url }] : [];
    },
    hint: intrinsicSize,
    capture: (el) => snapshotAttrs(el, ['poster']),
    apply: (el, replacements) => el.setAttribute('poster', replacements.get('poster')),
    restore: restoreAttrs,
  };

  /** SVG <image>, which uses href and/or the legacy xlink:href. */
  const svgImageAdapter = {
    name: 'svg-image',
    eager: true,
    match: (el) => el.namespaceURI === 'http://www.w3.org/2000/svg' && el.localName === 'image',

    sources(el) {
      const raw = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      const url = absolute(raw, el);
      return url ? [{ key: 'href', url }] : [];
    },

    hint: intrinsicSize,
    capture: (el) => snapshotAttrs(el, ['href', 'xlink:href']),

    apply(el, replacements) {
      const dataUrl = replacements.get('href');
      if (el.hasAttribute('href')) el.setAttribute('href', dataUrl);
      if (el.hasAttribute('xlink:href')) {
        el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', dataUrl);
      }
      if (!el.hasAttribute('href') && !el.hasAttribute('xlink:href')) {
        el.setAttribute('href', dataUrl);
      }
    },

    restore: restoreAttrs,
  };

  /** <object> / <embed> pointing at an image. */
  const embeddedAdapter = {
    name: 'embedded',
    eager: true,
    match(el) {
      if (el.tagName === 'OBJECT') return looksLikeImage(el.type, el.getAttribute('data'));
      if (el.tagName === 'EMBED') return looksLikeImage(el.type, el.getAttribute('src'));
      return false;
    },
    sources(el) {
      const attr = el.tagName === 'OBJECT' ? 'data' : 'src';
      const url = absolute(el.getAttribute(attr), el);
      return url ? [{ key: attr, url }] : [];
    },
    hint: intrinsicSize,
    capture: (el) => snapshotAttrs(el, ['data', 'src']),
    apply(el, replacements) {
      const attr = el.tagName === 'OBJECT' ? 'data' : 'src';
      el.setAttribute(attr, replacements.get(attr));
    },
    restore: restoreAttrs,
  };

  /**
   * CSS background-image on any element, including multi-layer values that mix
   * images with gradients. Only the url() layers are touched; gradients survive
   * untouched and in position.
   */
  const NON_VISUAL = new Set([
    'SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'TITLE', 'NOSCRIPT',
    'TEMPLATE', 'BASE', 'BR', 'PARAM', 'TRACK', 'SOURCE',
  ]);

  const backgroundAdapter = {
    name: 'background',
    // Background images move around as classes change, so this adapter's
    // matches are rechecked when class/style mutate (see pipeline.js).
    volatile: true,

    match(el) {
      if (NON_VISUAL.has(el.tagName)) return false;
      if (typeof el.getBoundingClientRect !== 'function') return false;
      const computed = getComputedStyle(el);
      if (!computed) return false;
      return cssUrls(computed.backgroundImage).length > 0;
    },

    sources(el) {
      const value = getComputedStyle(el)?.backgroundImage || '';
      // Computed values are already absolute in Chrome.
      return cssUrls(value).map((url, i) => ({ key: `bg${i}`, url }));
    },

    hint: boxOf,

    capture: (el) => ({
      value: el.style.getPropertyValue('background-image'),
      priority: el.style.getPropertyPriority('background-image'),
    }),

    apply(el, replacements) {
      const computed = getComputedStyle(el)?.backgroundImage || '';
      const next = replaceCssUrls(computed, (i) => replacements.get(`bg${i}`));
      el.style.setProperty('background-image', next, 'important');
    },

    restore(el, snap) {
      if (snap.value) el.style.setProperty('background-image', snap.value, snap.priority);
      else el.style.removeProperty('background-image');
    },
  };

  // Order matters only in that the first match wins per element *per adapter*;
  // an element can legitimately be handled by several (an <img> with a CSS
  // background gets both).
  IR.adapters = [
    imgAdapter,
    inputImageAdapter,
    posterAdapter,
    svgImageAdapter,
    embeddedAdapter,
    backgroundAdapter,
  ];

  IR.dom = { absolute, snapshotAttrs, restoreAttrs, boxOf, cssUrls, replaceCssUrls };
})();
