/**
 * Shared, non-secret settings schema and migration.
 *
 * API keys live in chrome.storage.local, written by the options page. This file
 * defines the stored shape, validation, and the legacy migration only, so it is
 * safe to publish and safe to unit test on its own (no dependency on the
 * provider registry). Endpoints and model ids are never stored here; they are
 * always derived from ai-providers.js at request time.
 *
 * Stored shape:
 *   {
 *     provider: "deepseek",
 *     aiApiKeys: { deepseek: "", zhipu: "", dashscope: "",
 *                  "tencent-hymt": "", siliconflow: "", fireworks: "" },
 *     supadataApiKey: ""
 *   }
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULT_PROVIDER = "deepseek";

  // One key-map slot per registry provider id, including the fail-closed
  // tencent-hymt slot so a key a user pre-enters survives if that provider is
  // ever verified and enabled. Kept in sync with ai-providers.js by
  // tests/ai-providers.test.js.
  const AI_PROVIDER_IDS = Object.freeze([
    "deepseek",
    "zhipu",
    "dashscope",
    "tencent-hymt",
    "siliconflow",
    "fireworks",
  ]);

  // Providers a user may actually select as the active AI provider. tencent-hymt
  // is fail-closed (unverified official config) and never becomes active.
  const SELECTABLE_PROVIDER_IDS = Object.freeze([
    "deepseek",
    "zhipu",
    "dashscope",
    "siliconflow",
    "fireworks",
  ]);

  function emptyKeyMap() {
    const map = {};
    for (const id of AI_PROVIDER_IDS) map[id] = "";
    return map;
  }

  const DEFAULTS = Object.freeze({
    provider: DEFAULT_PROVIDER,
    aiApiKeys: Object.freeze(emptyKeyMap()),
    supadataApiKey: "",
  });

  function cleanKey(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function normalizeProvider(input = {}) {
    return SELECTABLE_PROVIDER_IDS.includes(input.provider)
      ? input.provider
      : DEFAULT_PROVIDER;
  }

  /**
   * Builds the six-slot key map from stored input.
   *
   * Idempotent: re-normalizing an already-migrated object yields the same map
   * and never drops a stored key. A legacy single `aiApiKey` migrates into the
   * deepseek slot, except when it came from the removed custom-endpoint mode
   * (that key targeted a user-supplied URL and must not be reused as a DeepSeek
   * key). An existing deepseek slot is never overwritten by the legacy value.
   */
  function normalizeApiKeys(input = {}) {
    const map = emptyKeyMap();
    const stored = input.aiApiKeys;
    if (stored && typeof stored === "object") {
      for (const id of AI_PROVIDER_IDS) map[id] = cleanKey(stored[id]);
    }
    if (!map.deepseek && !isLegacyCustom(input)) {
      const legacy = cleanKey(input.aiApiKey);
      if (legacy) map.deepseek = legacy;
    }
    return map;
  }

  function normalize(input = {}) {
    return {
      provider: normalizeProvider(input),
      aiApiKeys: normalizeApiKeys(input),
      supadataApiKey: cleanKey(input.supadataApiKey),
    };
  }

  /**
   * Normalizes and reports whether a legacy shape was rewritten. `migrated` is
   * true for the removed custom provider, any top-level aiApiKey/aiBaseUrl/
   * aiModel field, or a missing key map, so the options page can persist the
   * upgraded object once and surface a one-time notice.
   */
  function migrateLegacy(input = {}) {
    const hadLegacyShape =
      isLegacyCustom(input) ||
      typeof input.aiApiKey === "string" ||
      typeof input.aiBaseUrl === "string" ||
      typeof input.aiModel === "string" ||
      !input ||
      !input.aiApiKeys ||
      typeof input.aiApiKeys !== "object";
    return { settings: normalize(input), migrated: !!hadLegacyShape };
  }

  function apiKeyFor(settings, providerId) {
    const map = settings && settings.aiApiKeys ? settings.aiApiKeys : {};
    return cleanKey(map[providerId]);
  }

  function activeProvider(settings) {
    return normalizeProvider(settings || {});
  }

  function activeApiKey(settings) {
    return apiKeyFor(settings, activeProvider(settings));
  }

  function hasActiveApiKey(settings) {
    return !!activeApiKey(settings);
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    DEFAULT_PROVIDER,
    AI_PROVIDER_IDS,
    SELECTABLE_PROVIDER_IDS,
    emptyKeyMap,
    isLegacyCustom,
    normalizeProvider,
    normalize,
    migrateLegacy,
    // Back-compat alias for the options page and existing callers.
    migrateLegacyCustom: migrateLegacy,
    apiKeyFor,
    activeProvider,
    activeApiKey,
    hasActiveApiKey,
    canonicalYouTubeUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
