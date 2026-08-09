// sites.js
//
// Which sites the extension is switched on for.
//
// The extension is off everywhere until a site is added to the list, so this is
// an opt-in list: a site that isn't on it is not replaced. Loaded as a classic
// script in the background context and in the popup, so it publishes a global.
//
// A "site" is a hostname. That matches how people think about "this site", and
// it keeps http/https variants of the same host together. Subdomains are
// separate entries, because docs.example.com and example.com are frequently
// unrelated.

(() => {
  const KEY = 'sites';

  const storageGet = (keys) =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (data) => {
          void chrome.runtime.lastError;
          resolve(data || {});
        });
      } catch {
        resolve({});
      }
    });

  const storageSet = (items) =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.set(items, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch {
        resolve();
      }
    });

  /**
   * The site key for a URL, or null when there isn't one the user could
   * meaningfully opt in: browser-internal pages, the new tab page, file://.
   */
  function siteOf(url) {
    if (!url) return null;
    try {
      const { protocol, hostname } = new URL(url);
      if (protocol !== 'http:' && protocol !== 'https:') return null;
      return hostname || null;
    } catch {
      return null;
    }
  }

  async function allowedSites() {
    const data = await storageGet(KEY);
    const sites = data[KEY];
    return sites && typeof sites === 'object' ? sites : {};
  }

  async function isAllowed(site) {
    if (!site) return false;
    return (await allowedSites())[site] === true;
  }

  /** Add or remove a site. Returns the state it ended up in. */
  async function setAllowed(site, allowed) {
    if (!site) return false;
    const sites = await allowedSites();
    if (allowed) sites[site] = true;
    else delete sites[site];
    await storageSet({ [KEY]: sites });
    return allowed;
  }

  async function toggle(site) {
    if (!site) return false;
    return setAllowed(site, !(await isAllowed(site)));
  }

  globalThis.ImageReplacerSites = {
    KEY,
    siteOf,
    allowedSites,
    isAllowed,
    setAllowed,
    toggle,
  };
})();
