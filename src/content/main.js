// main.js
//
// Finds work and hands it to the pipeline: an initial sweep, a MutationObserver
// for everything the page adds later, and the right-click actions.
//
// Discovery is split to match the two passes. Adapters whose `match()` is a
// cheap tag test run the moment an element is seen, synchronously, so the fast
// pass blanks it before it can paint -- usually before the browser has even
// started fetching the original. The CSS background adapter can't: matching it
// means a getComputedStyle call per element, which is far too expensive to do
// synchronously while the document is still parsing, so it goes through the
// idle queue with everything else.

(() => {
  const IR = (globalThis.__IMAGE_REPLACER__ ||= {});
  if (IR.state) return;

  IR.state = { enabled: true };

  const CHUNK = 120;

  // `class` and `style` are watched because CSS backgrounds move with them.
  const WATCHED_ATTRS = [
    'src', 'srcset', 'sizes', 'poster', 'href', 'xlink:href', 'data', 'style', 'class',
  ];

  const pending = new Set();
  const observedRoots = new WeakSet();
  let draining = false;
  let toastHost = null;

  const idle =
    globalThis.requestIdleCallback?.bind(globalThis) ||
    ((fn) => setTimeout(() => fn({ timeRemaining: () => 0 }), 16));

  // ------------------------------------------------------------- discovery

  /** Queue an element tree, descending into open shadow roots. */
  function collect(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)) return;
    if (root === toastHost) return;

    observeRoot(root);
    if (root.nodeType === 1) {
      pending.add(root);
      fastPass(root);
    }

    let all;
    try {
      all = root.querySelectorAll('*');
    } catch {
      return;
    }

    for (const el of all) {
      if (el === toastHost) continue;
      pending.add(el);
      fastPass(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }

    drainSoon();
  }

  /**
   * Run the cheap-to-match adapters right now. `runAdapter` blanks the element
   * before its first await, so not awaiting it here still guarantees the
   * original is gone by the time this returns; the mosaic follows later.
   */
  function fastPass(el) {
    if (!IR.state.enabled || !IR.pipeline.contextValid) return;

    for (const adapter of IR.adapters) {
      if (!adapter.eager) continue;
      let matched = false;
      try {
        matched = adapter.match(el);
      } catch {
        continue;
      }
      if (matched) IR.pipeline.runAdapter(el, adapter);
    }
  }

  function drainSoon() {
    if (draining || !pending.size) return;
    draining = true;
    idle(drain);
  }

  function drain() {
    draining = false;
    if (!IR.state.enabled || !IR.pipeline.contextValid) {
      pending.clear();
      return;
    }

    let n = 0;
    for (const el of pending) {
      pending.delete(el);
      if (el.isConnected) IR.pipeline.process(el);
      if (++n >= CHUNK) break;
    }

    if (pending.size) drainSoon();
  }

  // -------------------------------------------------------------- observing

  const observer = new MutationObserver((mutations) => {
    if (!IR.state.enabled) return;

    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) collect(node);
      } else if (m.type === 'attributes') {
        const el = m.target;
        // Skip the mutations our own writes generate, or we'd loop.
        if (IR.pipeline.isSelfInflicted(el, m.attributeName)) continue;
        if (el === toastHost) continue;
        // A page swapping an image's src (carousels, lazy loaders) gets the
        // same immediate blanking as one that was there at parse time.
        fastPass(el);
        pending.add(el);
      }
    }

    drainSoon();
  });

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    // Only document/shadow roots are worth a subtree observer of their own;
    // elements are already covered by an ancestor's.
    if (root.nodeType !== 9 && root.nodeType !== 11) return;
    observedRoots.add(root);
    try {
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: WATCHED_ATTRS,
      });
    } catch {
      /* detached root */
    }
  }

  // --------------------------------------------------------- right-click UX

  // The context menu fires in the service worker, by which time the event is
  // long gone -- so remember what was under the cursor. `composedPath()` keeps
  // this working for elements inside shadow DOM.
  let lastPath = [];
  addEventListener(
    'contextmenu',
    (event) => {
      lastPath = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'ir:menu') return;

    if (msg.action === 'restore') {
      const n = IR.pipeline.restoreFromPath(lastPath);
      toast(n ? `Restored ${n} image${n === 1 ? '' : 's'}` : 'No replaced image here');
    } else if (msg.action === 'restore-all') {
      const n = IR.pipeline.restoreAll();
      toast(n ? `Restored ${n} image${n === 1 ? '' : 's'}` : 'Nothing to restore');
    } else if (msg.action === 'replace') {
      const n = IR.pipeline.replaceFromPath(lastPath);
      toast(n ? 'Replacing again' : 'Nothing to replace here');
    }
  });

  /** Brief confirmation, isolated in a shadow root so page CSS can't reach it. */
  function toast(text) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.attachShadow({ mode: 'open' });
      Object.assign(toastHost.style, {
        position: 'fixed',
        zIndex: '2147483647',
        left: '0',
        bottom: '0',
        width: '0',
        height: '0',
      });
    }
    if (!toastHost.isConnected) {
      (document.body || document.documentElement).appendChild(toastHost);
    }

    toastHost.shadowRoot.innerHTML = '';
    const bubble = document.createElement('div');
    bubble.textContent = text;
    Object.assign(bubble.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      padding: '8px 14px',
      background: 'rgba(20,20,20,0.92)',
      color: '#fff',
      font: '13px/1.4 system-ui, sans-serif',
      borderRadius: '6px',
      boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
      pointerEvents: 'none',
    });
    toastHost.shadowRoot.appendChild(bubble);

    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastHost?.remove(), 1800);
  }

  // ------------------------------------------------------------------- boot

  function setEnabled(next) {
    if (next === IR.state.enabled) return;
    IR.state.enabled = next;

    if (next) {
      IR.pipeline.replaceAll(); // undo any user restores
      collect(document);
    } else {
      IR.pipeline.restoreAll();
      pending.clear();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) setEnabled(changes.enabled.newValue !== false);
  });

  chrome.storage.local.get('enabled', (data) => {
    IR.state.enabled = data?.enabled !== false;
    collect(document);
  });

  // We start at document_start, so most of the page doesn't exist yet. Sweep
  // again at the points where large amounts of markup have landed.
  document.addEventListener('DOMContentLoaded', () => collect(document), { once: true });
  addEventListener('load', () => collect(document), { once: true });
})();
