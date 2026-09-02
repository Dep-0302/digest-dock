/**
 * Reading-display preferences shared by the side panel and Options.
 *
 * The preference is deliberately separate from API/provider settings: changing
 * typography must never refresh transcript configuration or touch credentials.
 * chrome.storage.local is authoritative; a tiny localStorage mirror prevents a
 * visible typography flash while an extension page is starting.
 */
(function attachReadingDisplay(root, factory) {
  "use strict";

  const api = factory(root || {});
  if (root) root.YTD_READING_DISPLAY = api;
  if (typeof module === "object" && module.exports) {
    module.exports = Object.freeze({
      ...api,
      createReadingDisplayApi: factory,
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi(root) {
  "use strict";

  const STORAGE_KEY = "ytd_reading_display";
  const MIRROR_KEY = "ddk_reading_display_mirror";
  const SIZE_IDS = Object.freeze(["small", "standard", "large", "xlarge"]);
  const WEIGHT_IDS = Object.freeze(["regular", "bold"]);
  const DEFAULT_VALUE = Object.freeze({ size: "standard", weight: "regular" });
  let mutationRevision = 0;
  let bootPromise = null;
  let writeQueue = Promise.resolve();
  let pendingWriteCount = 0;
  let latestDesiredValue = DEFAULT_VALUE;

  function normalizeReadingDisplay(value = {}) {
    const size = SIZE_IDS.includes(value?.size) ? value.size : DEFAULT_VALUE.size;
    const weight = WEIGHT_IDS.includes(value?.weight)
      ? value.weight
      : DEFAULT_VALUE.weight;
    return Object.freeze({ size, weight });
  }

  function rootElement() {
    return root.document?.documentElement || null;
  }

  function applyReadingDisplay(value, target = rootElement()) {
    const normalized = normalizeReadingDisplay(value);
    if (target?.setAttribute) {
      target.setAttribute("data-reading-size", normalized.size);
      target.setAttribute("data-reading-weight", normalized.weight);
    }
    mutationRevision += 1;
    latestDesiredValue = normalized;
    return normalized;
  }

  function sameReadingDisplay(left, right) {
    const normalizedLeft = normalizeReadingDisplay(left);
    const normalizedRight = normalizeReadingDisplay(right);
    return (
      normalizedLeft.size === normalizedRight.size &&
      normalizedLeft.weight === normalizedRight.weight
    );
  }

  function currentReadingDisplay(target = rootElement()) {
    return normalizeReadingDisplay({
      size: target?.getAttribute?.("data-reading-size"),
      weight: target?.getAttribute?.("data-reading-weight"),
    });
  }

  function readMirror() {
    try {
      const serialized = root.localStorage?.getItem?.(MIRROR_KEY);
      return serialized
        ? normalizeReadingDisplay(JSON.parse(serialized))
        : null;
    } catch (_error) {
      return null;
    }
  }

  function writeMirror(value) {
    const normalized = normalizeReadingDisplay(value);
    try {
      root.localStorage?.setItem?.(MIRROR_KEY, JSON.stringify(normalized));
    } catch (_error) {
      // The mirror is only a first-paint hint; chrome.storage remains primary.
    }
    return normalized;
  }

  function chromeLocalStorage() {
    try {
      return root.chrome?.storage?.local || null;
    } catch (_error) {
      return null;
    }
  }

  async function readStoredReadingDisplay() {
    const storage = chromeLocalStorage();
    if (storage?.get) {
      try {
        const stored = await storage.get(STORAGE_KEY);
        if (stored && Object.hasOwn(stored, STORAGE_KEY)) {
          return normalizeReadingDisplay(stored[STORAGE_KEY]);
        }
      } catch (_error) {
        // Fall back to the paint mirror/default without blocking the UI.
      }
    }
    return readMirror() || DEFAULT_VALUE;
  }

  async function persistReadingDisplay(value) {
    const next = normalizeReadingDisplay(value);
    const previous = currentReadingDisplay();
    applyReadingDisplay(next);
    writeMirror(next);
    const storage = chromeLocalStorage();
    if (!storage?.set) return next;
    const writeRevision = mutationRevision;
    pendingWriteCount += 1;
    const operation = writeQueue
      .catch(() => undefined)
      .then(() => storage.set({ [STORAGE_KEY]: next }));
    writeQueue = operation;
    try {
      await operation;
      return next;
    } catch (error) {
      // A failed older write must not undo a newer optimistic selection.
      if (
        mutationRevision === writeRevision &&
        sameReadingDisplay(latestDesiredValue, next)
      ) {
        applyReadingDisplay(previous);
        writeMirror(previous);
      }
      throw error;
    } finally {
      pendingWriteCount = Math.max(0, pendingWriteCount - 1);
    }
  }

  function watchStoredReadingDisplay(onApplied = null) {
    const changes = root.chrome?.storage?.onChanged;
    if (!changes?.addListener) return false;
    changes.addListener((records, areaName) => {
      if (areaName !== "local" || !records || !records[STORAGE_KEY]) return;
      const next = normalizeReadingDisplay(
        records[STORAGE_KEY].newValue || DEFAULT_VALUE,
      );
      // Chrome can echo an earlier serialized write while a newer local choice
      // is queued. Keep the newest optimistic value until its write settles.
      if (
        pendingWriteCount > 0 &&
        !sameReadingDisplay(next, latestDesiredValue)
      ) {
        return;
      }
      const applied = applyReadingDisplay(
        next,
      );
      writeMirror(applied);
      if (typeof onApplied === "function") onApplied(applied);
    });
    return true;
  }

  function boot() {
    if (bootPromise) return bootPromise;
    const startingRevision = mutationRevision;
    bootPromise = readStoredReadingDisplay().then((stored) => {
      // Never let a slow initial read overwrite a choice the user made while
      // the page was becoming interactive.
      if (mutationRevision !== startingRevision) {
        return currentReadingDisplay();
      }
      const applied = applyReadingDisplay(stored);
      writeMirror(applied);
      return applied;
    });
    return bootPromise;
  }

  const mirrored = readMirror();
  if (mirrored) applyReadingDisplay(mirrored);

  if (root.document) {
    void boot();
    watchStoredReadingDisplay();
  }

  return Object.freeze({
    STORAGE_KEY,
    MIRROR_KEY,
    SIZE_IDS,
    WEIGHT_IDS,
    DEFAULT_VALUE,
    normalizeReadingDisplay,
    sameReadingDisplay,
    applyReadingDisplay,
    currentReadingDisplay,
    readMirror,
    readStoredReadingDisplay,
    persistReadingDisplay,
    watchStoredReadingDisplay,
    boot,
  });
});
