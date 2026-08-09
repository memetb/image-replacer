chrome.storage.local.get('enabled', (data) => {
    const enabled = data.enabled !== false; // default true
    const btn = document.getElementById('toggle');
    
    btn.textContent = enabled ? 'Disable Image Replacement' : 'Enable Image Replacement';
    
    btn.addEventListener('click', () => {
        chrome.storage.local.set({ enabled: !enabled });
        btn.textContent = !enabled ? 'Disable Image Replacement' : 'Enable Image Replacement';
        
        // Notify content script to reload
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: 'toggle' }).catch(() => {});
            });
        });
    });
});
