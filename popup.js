const button = document.getElementById('toggle');
const note = document.getElementById('note');

const Sites = globalThis.ImageReplacerSites;

let site = null;
let active = false;

function render() {
  if (!site) {
    button.textContent = 'Not available here';
    button.disabled = true;
    note.textContent = 'This page cannot be opted in.';
    return;
  }

  button.disabled = false;
  button.textContent = active ? 'Disable for this site' : 'Replace images on this site';
  button.dataset.state = active ? 'on' : 'off';
  note.textContent = active
    ? `Replacing images on ${site}. Right-click a replaced image to restore it.`
    : `${site} is not replaced. Turn it on here, or right-click the page.`;
}

function currentTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      void chrome.runtime.lastError;
      resolve(tabs?.[0] || null);
    });
  });
}

(async () => {
  const tab = await currentTab();
  site = Sites.siteOf(tab?.url);
  active = await Sites.isAllowed(site);
  render();
})();

// The background context watches storage and pushes the change out to the
// tab's content scripts, so writing the list is all the popup has to do.
button.addEventListener('click', async () => {
  if (!site) return;
  active = await Sites.setAllowed(site, !active);
  render();
});
