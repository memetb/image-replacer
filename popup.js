const button = document.getElementById('toggle');

let enabled = true;

function render() {
  button.textContent = enabled ? 'Disable image replacement' : 'Enable image replacement';
  button.dataset.state = enabled ? 'on' : 'off';
}

chrome.storage.local.get('enabled', (data) => {
  enabled = data?.enabled !== false; // default on
  render();
});

// Content scripts pick this up via chrome.storage.onChanged, so there's no
// separate broadcast to keep in sync with the stored value.
button.addEventListener('click', () => {
  enabled = !enabled;
  chrome.storage.local.set({ enabled });
  render();
});
