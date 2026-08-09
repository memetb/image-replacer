// background.js -- the background context.
//
// Runs as a service worker in Chrome (via src/sw.js) and as an event page in
// Firefox (via background.scripts). It is a classic script in both, and reaches
// its collaborators through the globals they publish.
//
// Jobs:
//   1. Decide whether the extension is active for a given tab, and tell that
//      tab's content scripts. Content scripts can't decide this themselves: a
//      subframe only knows its own URL, and "this site" means the site in the
//      address bar.
//   2. Own the right-click menu and the toolbar indicator.
//   3. Serve replacement images. Content scripts can't do this either: a
//      page-context fetch of a cross-origin image is subject to CORS and fails
//      for the large majority of real images.

(() => {
  const Sites = globalThis.ImageReplacerSites;
  const Menus = globalThis.ImageReplacerMenus;
  const Indicator = globalThis.ImageReplacerIndicator;

  const swallow = () => void chrome.runtime.lastError;

  const tabsQuery = (query) =>
    new Promise((resolve) => {
      try {
        chrome.tabs.query(query, (tabs) => {
          swallow();
          resolve(tabs || []);
        });
      } catch {
        resolve([]);
      }
    });

  const getTab = (tabId) =>
    new Promise((resolve) => {
      try {
        chrome.tabs.get(tabId, (tab) => {
          swallow();
          resolve(tab || null);
        });
      } catch {
        resolve(null);
      }
    });

  // ------------------------------------------------------------ active state

  /** Is the extension switched on for the site this tab is showing? */
  async function activeForTab(tab) {
    const site = Sites.siteOf(tab?.url);
    return { site, active: await Sites.isAllowed(site) };
  }

  /** Push the current state to every frame in a tab, and repaint its icon. */
  async function syncTab(tabId) {
    const tab = await getTab(tabId);
    if (!tab) return null;

    const state = await activeForTab(tab);
    await Indicator.update(tabId, state);
    // No frameId: every frame in the tab, including cross-origin subframes,
    // follows the top-level site.
    chrome.tabs.sendMessage(tabId, { type: 'ir:setActive', active: state.active }, swallow);
    return state;
  }

  /** Repaint the menu for whichever tab the user is looking at. */
  async function syncMenusForActiveTab() {
    const [tab] = await tabsQuery({ active: true, currentWindow: true });
    const state = tab ? await activeForTab(tab) : { site: null, active: false };
    Menus.setSite({ checked: state.active, enabled: !!state.site });
    if (!state.active) Menus.setTargets({ restore: false, restoreAll: false, replace: false });
    return state;
  }

  /** Bring every open tab in line with the list as it now stands. */
  async function syncAllTabs() {
    const tabs = await tabsQuery({});
    await Promise.all(tabs.map((tab) => syncTab(tab.id)));
    await syncMenusForActiveTab();
  }

  /**
   * Flip a site. Writing the list is the whole job: the storage listener below
   * fans the change out, so the menu and the popup share one path rather than
   * each remembering to notify everybody.
   */
  async function toggleSite(site) {
    if (!site) return false;
    return Sites.toggle(site);
  }

  // -------------------------------------------------------------- menu clicks

  /**
   * The contextMenus.onClicked handler, named so the e2e test can drive the
   * real code path -- a menu item cannot be clicked programmatically.
   */
  async function handleMenuClick(info, tab) {
    if (!tab?.id) return;

    if (info.menuItemId === Menus.ID.site) {
      await toggleSite(Sites.siteOf(tab.url));
      return;
    }

    const actions = {
      [Menus.ID.restore]: 'restore',
      [Menus.ID.restoreAll]: 'restore-all',
      [Menus.ID.replace]: 'replace',
    };
    const action = actions[info.menuItemId];
    if (!action) return;

    // Deliver to the exact frame that was right-clicked; the element the user
    // targeted only exists there.
    const options = typeof info.frameId === 'number' ? { frameId: info.frameId } : {};
    chrome.tabs.sendMessage(tab.id, { type: 'ir:menu', action }, options, swallow);
  }

  // ----------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ir:replace') {
      globalThis.ImageReplacement.replacementFor({
        url: msg.url,
        width: msg.width,
        height: msg.height,
      })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }

    // A content script asking, at document_start, whether to do anything here.
    if (msg?.type === 'ir:active') {
      activeForTab(sender?.tab).then(
        (state) => sendResponse(state),
        () => sendResponse({ site: null, active: false }),
      );
      return true;
    }

    // The content script reporting what is under the pointer, so the menu items
    // are already in the right state when the menu opens.
    if (msg?.type === 'ir:targets') {
      Menus.setTargets({
        restore: !!msg.restore,
        restoreAll: !!msg.restoreAll,
        replace: !!msg.replace,
      });
      return undefined;
    }

    return undefined;
  });

  // ------------------------------------------------------------------- events

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleMenuClick(info, tab);
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    syncTab(tabId);
    syncMenusForActiveTab();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // A navigation can change the site under the same tab id.
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    syncTab(tabId);
    syncMenusForActiveTab();
  });

  // The single fan-out point for a list change, whoever made it -- the context
  // menu, the popup, or another window's copy of either.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[Sites.KEY]) syncAllTabs();
  });

  function boot() {
    Menus.install();
    syncAllTabs();
  }

  chrome.runtime.onInstalled.addListener(boot);
  chrome.runtime.onStartup.addListener(boot);
  // The worker also restarts on demand, after the events above have fired.
  boot();

  globalThis.ImageReplacerBackground = {
    handleMenuClick,
    syncTab,
    syncAllTabs,
    toggleSite,
    activeForTab,
  };
})();
