// pipeline.js
//
// The common path. Every asset -- whatever its type -- is replaced by
// `runAdapter()` and undone by `restoreRecord()`. Adapters supply the read/write
// plumbing; the service worker supplies the pixels; this file owns the
// bookkeeping that sits between them: what has been touched, what the original
// looked like, and what must not be touched again.

(() => {
  const IR = (globalThis.__IMAGE_REPLACER__ ||= {});
  if (IR.pipeline) return;

  const MAX_CONCURRENT = 6;

  /** Every data: URL this frame has applied, so we never replace a replacement. */
  const applied = new Set();

  /** element -> adapter name -> record */
  const records = new WeakMap();

  /** Live records, for "restore all". Pruned as elements leave the document. */
  const live = new Set();

  /** Elements we're already waiting on a `load` event for. */
  const awaitingLoad = new WeakSet();

  let active = 0;
  const queue = [];
  let contextValid = true;

  // ------------------------------------------------------------------ state

  const getRecord = (el, name) => records.get(el)?.get(name);

  function setRecord(el, name, record) {
    let byName = records.get(el);
    if (!byName) records.set(el, (byName = new Map()));
    byName.set(name, record);
    live.add(record);
  }

  const isOurs = (url) => applied.has(url);

  // ------------------------------------------------------- worker round-trip

  const DEAD_CONTEXT = /context invalidated|receiving end does not exist|extension context/i;

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        // Callback form, not the promise form: Chrome supports both, but
        // Firefox's chrome.* namespace is callback-only and returns undefined.
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            if (DEAD_CONTEXT.test(err.message || '')) contextValid = false;
            reject(new Error(err.message || 'sendMessage failed'));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        // Thrown synchronously once the extension is reloaded/updated.
        contextValid = false;
        reject(err);
      }
    });
  }

  /**
   * blob: URLs are scoped to the page's origin and are invisible to the service
   * worker, so they get inlined here before the round-trip.
   */
  async function resolveForWorker(url) {
    if (!url.startsWith('blob:')) return url;
    try {
      const blob = await (await fetch(url)).blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch {
      // Let the worker fail on it and emit a synthetic replacement instead.
      return url;
    }
  }

  async function fetchReplacement(url, hint) {
    const resolved = await resolveForWorker(url);
    const res = await sendMessage({
      type: 'ir:replace',
      url: resolved,
      width: hint.width,
      height: hint.height,
    });
    if (!res?.ok || !res.dataUrl) throw new Error(res?.error || 'no replacement produced');
    return res.dataUrl;
  }

  // ------------------------------------------------------------- concurrency

  function schedule(task) {
    return new Promise((resolve) => {
      queue.push(() => task().then(resolve, resolve));
      pump();
    });
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => {
        active--;
        pump();
      });
    }
  }

  // ------------------------------------------------------------ the pipeline

  /**
   * Replace one asset. This is the only function that writes a replacement into
   * the page, for every asset type.
   */
  async function runAdapter(el, adapter, { force = false } = {}) {
    if (!contextValid) return false;

    const record = getRecord(el, adapter.name);
    if (record?.state === 'working') return false;
    // A restored asset stays restored until the user explicitly asks otherwise.
    if (record?.state === 'restored' && !force) return false;

    let sources;
    try {
      sources = adapter.sources(el) || [];
    } catch {
      return false;
    }

    if (!sources.length) {
      waitForLoad(el, adapter);
      return false;
    }

    const stale = sources.filter((s) => s.url && !isOurs(s.url));
    if (!stale.length && !force) return false; // already fully replaced

    const working = record || { el, adapter, state: 'working', applied: new Set() };
    working.state = 'working';
    setRecord(el, adapter.name, working);

    try {
      const hint = adapter.hint?.(el) || { width: 0, height: 0 };
      const replacements = new Map();

      await Promise.all(
        sources.map(async (source) => {
          // Layers already carrying our own output are passed through untouched
          // so multi-layer values (CSS backgrounds) rebuild in the right order.
          if (isOurs(source.url) && !force) {
            replacements.set(source.key, source.url);
            return;
          }
          const dataUrl = await schedule(() => fetchReplacement(source.url, hint));
          if (typeof dataUrl === 'string') replacements.set(source.key, dataUrl);
        }),
      );

      // Bail rather than write a partial value; a half-applied CSS background
      // is worse than an untouched one.
      if (replacements.size !== sources.length) {
        working.state = record?.snapshot ? 'replaced' : 'idle';
        return false;
      }

      // Snapshot only from an authentic page state. If some sources are already
      // ours the DOM is half-ours, so the earlier snapshot is the real original.
      const authentic = stale.length === sources.length;
      if (!working.snapshot || authentic) working.snapshot = adapter.capture(el);

      adapter.apply(el, replacements);

      for (const value of replacements.values()) {
        applied.add(value);
        working.applied.add(value);
      }
      // The inline style we just wrote, so self-inflicted mutations are ignored.
      // Only when non-empty: recording '' would make every later style change
      // on an element without an inline background look like one of ours.
      const inlineBg = el.style?.getPropertyValue('background-image');
      if (inlineBg) working.applied.add(inlineBg);

      working.state = 'replaced';
      return true;
    } catch (err) {
      working.state = 'idle';
      if (!contextValid) return false;
      console.debug('[image-replacer] could not replace', adapter.name, err?.message || err);
      return false;
    }
  }

  /** Undo one replacement, returning the element to its captured original. */
  function restoreRecord(record) {
    if (!record || record.state !== 'replaced' || !record.snapshot) return false;
    try {
      record.adapter.restore(record.el, record.snapshot);
      record.state = 'restored';
      record.applied.clear();
      return true;
    } catch (err) {
      console.debug('[image-replacer] could not restore', record.adapter.name, err?.message || err);
      return false;
    }
  }

  /** Run every adapter that claims this element. */
  function process(el, options) {
    if (!IR.state?.enabled && !options?.force) return;
    if (el.nodeType !== 1) return;

    for (const adapter of IR.adapters) {
      let matched = false;
      try {
        matched = adapter.match(el);
      } catch {
        continue;
      }
      if (matched) runAdapter(el, adapter, options);
    }
  }

  /**
   * Some elements have no resolvable source yet -- an <img> carrying only a
   * srcset the browser hasn't picked from. Retry once the browser resolves one.
   */
  function waitForLoad(el, adapter) {
    if (awaitingLoad.has(el)) return;
    if (!('src' in el || 'currentSrc' in el)) return;
    awaitingLoad.add(el);
    el.addEventListener(
      'load',
      () => {
        awaitingLoad.delete(el);
        if (IR.state?.enabled) runAdapter(el, adapter);
      },
      { once: true },
    );
  }

  // ---------------------------------------------------------------- restore

  function recordsFor(el) {
    const byName = records.get(el);
    return byName ? [...byName.values()] : [];
  }

  const replacedRecordsFor = (el) => recordsFor(el).filter((r) => r.state === 'replaced');

  /**
   * Resolve a right-click into something to restore.
   *
   * Nearest-ancestor-first: the element under the cursor, then its containers.
   * Only if nothing on that path was replaced do we look downward, which covers
   * right-clicking the padding of a wrapper around a replaced image.
   */
  function restoreFromPath(path) {
    for (const node of path) {
      if (node?.nodeType !== 1) continue;
      const hits = replacedRecordsFor(node);
      if (hits.length) return hits.filter(restoreRecord).length;
    }

    const target = path.find((n) => n?.nodeType === 1);
    if (!target?.querySelectorAll) return 0;

    let count = 0;
    for (const el of target.querySelectorAll('*')) {
      count += replacedRecordsFor(el).filter(restoreRecord).length;
    }
    return count;
  }

  function restoreAll() {
    let count = 0;
    for (const record of [...live]) {
      if (!record.el.isConnected) {
        live.delete(record);
        continue;
      }
      if (restoreRecord(record)) count++;
    }
    return count;
  }

  /** Re-replace assets the user previously restored. */
  function replaceFromPath(path) {
    for (const node of path) {
      if (node?.nodeType !== 1) continue;
      if (recordsFor(node).some((r) => r.state === 'restored')) {
        process(node, { force: true });
        return 1;
      }
    }
    return 0;
  }

  function replaceAll() {
    let count = 0;
    for (const record of [...live]) {
      if (!record.el.isConnected) {
        live.delete(record);
        continue;
      }
      if (record.state === 'restored') {
        runAdapter(record.el, record.adapter, { force: true });
        count++;
      }
    }
    return count;
  }

  /**
   * Did *we* write this attribute? Used to keep our own DOM writes from
   * re-entering the pipeline through the MutationObserver.
   */
  function isSelfInflicted(el, attrName) {
    const byName = records.get(el);
    if (!byName) return false;
    const current =
      attrName === 'style'
        ? el.style?.getPropertyValue('background-image')
        : el.getAttribute(attrName);
    if (current == null) return false;
    for (const record of byName.values()) {
      if (record.applied.has(current)) return true;
    }
    return false;
  }

  IR.pipeline = {
    process,
    runAdapter,
    restoreFromPath,
    restoreAll,
    replaceFromPath,
    replaceAll,
    isSelfInflicted,
    isOurs,
    get contextValid() {
      return contextValid;
    },
  };
})();
