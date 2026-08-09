// indicator.js
//
// Shows whether the extension is doing anything, per tab, on the toolbar icon.
//
// Two signals, because they fail in different ways: a badge, which is
// unmistakable but small, and a desaturated icon when off, which reads at a
// glance without needing to be legible. The desaturated variants are generated
// at runtime from the shipped icons so there is no second set of files to keep
// in sync.

(() => {
  const BADGE_ON = 'ON';
  const BADGE_COLOR = '#2e7d32';

  const ICON_SIZES = [16, 48, 96];
  const ICON_PATHS = {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    96: 'icons/icon-96.png',
  };

  /** Generated ImageData for the "off" icon, built once and reused. */
  let dimmedIcons = null;
  let dimmedFailed = false;

  const swallow = () => void chrome.runtime.lastError;

  /** Desaturate towards luminance and fade, in place. */
  function dim(data) {
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      // Keep a trace of the original hue so the icon still looks like itself.
      data[i] = Math.round(lum * 0.8 + data[i] * 0.2);
      data[i + 1] = Math.round(lum * 0.8 + data[i + 1] * 0.2);
      data[i + 2] = Math.round(lum * 0.8 + data[i + 2] * 0.2);
      data[i + 3] = Math.round(data[i + 3] * 0.55);
    }
  }

  async function buildDimmedIcons() {
    if (dimmedIcons || dimmedFailed) return dimmedIcons;
    try {
      const out = {};
      for (const size of ICON_SIZES) {
        const resp = await fetch(chrome.runtime.getURL(ICON_PATHS[size]));
        const bitmap = await createImageBitmap(await resp.blob());
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, size, size);
        bitmap.close?.();
        const image = ctx.getImageData(0, 0, size, size);
        dim(image.data);
        out[size] = image;
      }
      dimmedIcons = out;
    } catch {
      // Not fatal: the badge and title still carry the state.
      dimmedFailed = true;
    }
    return dimmedIcons;
  }

  /**
   * Paint the indicator for one tab.
   *
   * `active` means the extension is replacing images in this tab. `site` is
   * null on pages that can't be opted in at all (browser-internal pages), which
   * gets its own title so the toolbar button doesn't look broken.
   */
  async function update(tabId, { active, site }) {
    if (typeof tabId !== 'number') return;

    try {
      chrome.action.setBadgeText({ tabId, text: active ? BADGE_ON : '' }, swallow);
      chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }, swallow);
      chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' }, swallow);

      chrome.action.setTitle(
        {
          tabId,
          title: !site
            ? 'Image Replacer: not available on this page'
            : active
              ? `Image Replacer: replacing images on ${site}`
              : `Image Replacer: off for ${site}`,
        },
        swallow,
      );

      if (active) {
        chrome.action.setIcon({ tabId, path: ICON_PATHS }, swallow);
      } else {
        const icons = await buildDimmedIcons();
        if (icons) chrome.action.setIcon({ tabId, imageData: icons }, swallow);
        else chrome.action.setIcon({ tabId, path: ICON_PATHS }, swallow);
      }
    } catch {
      // Tab closed mid-update.
    }
  }

  globalThis.ImageReplacerIndicator = { update, BADGE_ON };
})();
