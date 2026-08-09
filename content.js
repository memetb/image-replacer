// content.js
let isEnabled = true;

chrome.storage.local.get('enabled', (data) => {
  isEnabled = data.enabled !== false;
  start();
});

function neutralizePicture(img) {
  const picture = img.closest('picture');
  if (picture) {
    picture.querySelectorAll('source').forEach(s => {
      s.removeAttribute('srcset');
      s.removeAttribute('src');
    });
  }
  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
}

function extractPalette(data, n) {
  const colors = [];
  const step = Math.max(1, Math.floor((data.length / 4) / n));
  for (let p = 0; p < data.length / 4 && colors.length < n; p += step) {
    const idx = p * 4;
    colors.push(`rgb(${data[idx]},${data[idx + 1]},${data[idx + 2]})`);
  }
  while (colors.length < n) colors.push('rgb(0,0,0)');
  return colors.slice(0, n);
}

async function manipulateImage(img) {
  if (!isEnabled) return;
  if (img.dataset.replaced === '1') return;

  // Defer if the browser hasn't resolved a source yet (esp. <picture>)
  if (!img.complete && !img.currentSrc) {
    img.addEventListener('load', () => {
      img.dataset.replaced = '';
      manipulateImage(img);
    }, { once: true });
    return;
  }

  const srcUrl = img.currentSrc || img.src;
  if (!srcUrl || srcUrl.startsWith('data:')) return;

  img.dataset.replaced = '1';
  neutralizePicture(img);

  try {
    const resp = await fetch(srcUrl, { mode: 'cors' });
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);

    const width = bitmap.width;
    const height = bitmap.height;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);

    const data = ctx.getImageData(0, 0, width, height).data;

    const tileSize = 24;
    const tilesX = Math.ceil(width / tileSize);
    const tilesY = Math.ceil(height / tileSize);
    const n = tilesX * tilesY;

    const colors = extractPalette(data, n);

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);

    let i = 0;
    for (let y = 0; y < tilesY; y++) {
      for (let x = 0; x < tilesX; x++) {
        ctx.fillStyle = colors[i % colors.length];
        ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
        i++;
      }
    }

    img.src = canvas.toDataURL('image/png');
  } catch (e) {
    console.warn('Skip image:', srcUrl, e.message);
    img.dataset.replaced = '';
  }
}

function processAll(root = document) {
  root.querySelectorAll('img').forEach(manipulateImage);
}

function start() {
  processAll();

  const observer = new MutationObserver((mutations) => {
    if (!isEnabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') manipulateImage(node);
        node.querySelectorAll?.('img').forEach(manipulateImage);
      }
      if (m.type === 'attributes' && m.target.tagName === 'IMG') {
        m.target.dataset.replaced = '';
        manipulateImage(m.target);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset']
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'toggle') {
    chrome.storage.local.get('enabled', (data) => {
      isEnabled = data.enabled !== false;
      sendResponse({ enabled: isEnabled });
    });
    return true;
  }
});
