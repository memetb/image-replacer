// background.js -- service worker.
//
// Two jobs:
//   1. Own the right-click menu and forward its actions to the frame that was
//      clicked.
//   2. Serve replacement images to content scripts. Content scripts cannot do
//      this themselves: a page-context fetch of a cross-origin image is subject
//      to CORS and fails for the large majority of real images.

import { replacementFor } from './replacement.js';

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

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create(
        { id: item.id, title: item.title, contexts: ['all'] },
        () => void chrome.runtime.lastError,
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
  chrome.tabs
    .sendMessage(tab.id, { type: 'ir:menu', action }, options)
    .catch(() => {
      // No content script in that frame (chrome:// page, PDF viewer, ...).
    });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ir:replace') return undefined;

  replacementFor({ url: msg.url, width: msg.width, height: msg.height })
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true; // response is async
});
