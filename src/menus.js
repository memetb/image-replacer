// menus.js
//
// The right-click menu: what's in it, and what state each item is in.
//
// The site toggle sits at the top, above a separator, because it is the only
// item that is always meaningful -- the menu can be opened anywhere, including
// on a page with nothing replaced on it. The restore items below it are
// disabled unless there is actually something under the cursor to act on.
//
// Behaviour lives in background.js; this file only defines the items and
// applies state to them.

(() => {
  const ID = {
    site: 'ir-site',
    separator: 'ir-separator',
    restore: 'ir-restore',
    restoreAll: 'ir-restore-all',
    replace: 'ir-replace',
  };

  const swallow = () => void chrome.runtime.lastError;

  // Last state pushed to each item, so repeated refreshes are cheap no-ops and
  // tests have something to assert against.
  const applied = {
    siteChecked: false,
    siteEnabled: true,
    restore: false,
    restoreAll: false,
    replace: false,
  };

  function install() {
    chrome.contextMenus.removeAll(() => {
      swallow();
      const create = (props) => chrome.contextMenus.create({ contexts: ['all'], ...props }, swallow);

      create({
        id: ID.site,
        type: 'checkbox',
        title: 'Always Replace Images from this site',
        checked: applied.siteChecked,
      });
      create({ id: ID.separator, type: 'separator' });
      create({ id: ID.restore, title: 'Restore', enabled: applied.restore });
      create({
        id: ID.restoreAll,
        title: 'Restore all images on this page',
        enabled: applied.restoreAll,
      });
      create({ id: ID.replace, title: 'Replace again', enabled: applied.replace });
    });
  }

  function update(id, props) {
    try {
      chrome.contextMenus.update(id, props, swallow);
    } catch {
      // Menu not created yet, or already gone.
    }
  }

  /** Reflect whether the current tab's site is opted in. */
  function setSite({ checked, enabled }) {
    if (applied.siteChecked !== checked) {
      applied.siteChecked = checked;
      update(ID.site, { checked });
    }
    if (applied.siteEnabled !== enabled) {
      applied.siteEnabled = enabled;
      update(ID.site, { enabled });
    }
  }

  /**
   * Enable only the restore items that would do something.
   *
   * The content script reports this as the pointer moves, so the state is
   * already correct by the time the menu opens. Chrome has no "menu is about to
   * show" event to compute it in, and computing it on the contextmenu event
   * alone races with the menu being built.
   */
  function setTargets({ restore, restoreAll, replace }) {
    if (applied.restore !== restore) {
      applied.restore = restore;
      update(ID.restore, { enabled: restore });
    }
    if (applied.restoreAll !== restoreAll) {
      applied.restoreAll = restoreAll;
      update(ID.restoreAll, { enabled: restoreAll });
    }
    if (applied.replace !== replace) {
      applied.replace = replace;
      update(ID.replace, { enabled: replace });
    }
  }

  globalThis.ImageReplacerMenus = {
    ID,
    install,
    setSite,
    setTargets,
    state: () => ({ ...applied }),
  };
})();
