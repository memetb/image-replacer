// background.js -- the background context.
//
// Runs as a service worker in Chrome (via src/sw.js) and as an event page in
// Firefox (via background.scripts). It is a classic script in both, and reaches
// the modification routine through the `ImageReplacement` global that
// src/replacement.js publishes.
//
// Two jobs:
//   1. Own the right-click menu and forward its actions to the frame that was
//      clicked.
//   2. Serve replacement images to content scripts. Content scripts cannot do
//      this themselves: a page-context fetch of a cross-origin image is subject
//      to CORS and fails for the large majority of real images.

(() => {
  const MENU_ITEMS = [
    { id: 'ir-restore', title: 'Restore' },
    { id: 'ir-restore-all', title: 'Restore all images on this page' },
    { id: 'ir-replace', title: 'Replace again' },
  ];

  const MENU_ACTIONS = {
    'ir-restore': 'restore',
    'ir-restore-all': 'restore-all',
    'ir-replace': 'replace',
  };

  // Reading lastError marks it handled; without this both browsers log an
  // "unchecked runtime.lastError" warning for benign races.
  const swallowError = () => void chrome.runtime.lastError;

  function installMenus() {
    chrome.contextMenus.removeAll(() => {
      swallowError();
      for (const item of MENU_ITEMS) {
        chrome.contextMenus.create(
          { id: item.id, title: item.title, contexts: ['all'] },
          swallowError,
        );
      }
    });
  }

  chrome.runtime.onInstalled.addListener(installMenus);
  chrome.runtime.onStartup.addListener(installMenus);

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const action = MENU_ACTIONS[info.menuItemId];
    if (!action || !tab?.id) return;

    // Deliver to the exact frame that was right-clicked; the element the user
    // targeted only exists there.
    const options = typeof info.frameId === 'number' ? { frameId: info.frameId } : {};

    // Callback form rather than the promise form: Firefox's chrome.* namespace
    // is callback-only. A missing content script (chrome:// page, PDF viewer,
    // view-source) surfaces as lastError, not a rejection.
    chrome.tabs.sendMessage(tab.id, { type: 'ir:menu', action }, options, swallowError);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'ir:replace') return undefined;

    globalThis.ImageReplacement.replacementFor({
      url: msg.url,
      width: msg.width,
      height: msg.height,
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

    return true; // response is async
  });
})();
