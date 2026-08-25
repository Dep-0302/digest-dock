const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("defaults expose a six-slot key map and the DeepSeek default provider", () => {
  assert.equal(settings.DEFAULTS.provider, "deepseek");
  assert.deepEqual(Object.keys(settings.DEFAULTS.aiApiKeys).sort(), [
    "dashscope",
    "deepseek",
    "fireworks",
    "siliconflow",
    "tencent-hymt",
    "zhipu",
  ]);
  for (const value of Object.values(settings.DEFAULTS.aiApiKeys)) {
    assert.equal(value, "");
  }
  // Endpoints and models are never stored in settings; they come from the
  // provider registry.
  assert.equal(Object.hasOwn(settings.DEFAULTS, "aiBaseUrl"), false);
  assert.equal(Object.hasOwn(settings.DEFAULTS, "aiModel"), false);
});

test("legacy single aiApiKey migrates into the deepseek slot", () => {
  const { settings: normalized, migrated } = settings.migrateLegacy({
    provider: "deepseek",
    aiApiKey: "  legacy-deepseek-key  ",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "  supa  ",
  });
  assert.equal(migrated, true);
  assert.equal(normalized.aiApiKeys.deepseek, "legacy-deepseek-key");
  assert.equal(normalized.supadataApiKey, "supa");
  assert.equal(normalized.provider, "deepseek");
});

test("each provider key is stored independently and trimmed", () => {
  const normalized = settings.normalize({
    provider: "zhipu",
    aiApiKeys: {
      deepseek: " ds ",
      zhipu: " zp ",
      siliconflow: "sf",
      fireworks: "",
      dashscope: "  ",
    },
    supadataApiKey: "sd",
  });
  assert.equal(normalized.provider, "zhipu");
  assert.equal(normalized.aiApiKeys.deepseek, "ds");
  assert.equal(normalized.aiApiKeys.zhipu, "zp");
  assert.equal(normalized.aiApiKeys.siliconflow, "sf");
  assert.equal(normalized.aiApiKeys.fireworks, "");
  assert.equal(normalized.aiApiKeys.dashscope, "");
  assert.equal(settings.apiKeyFor(normalized, "zhipu"), "zp");
  assert.equal(settings.activeApiKey(normalized), "zp");
  assert.equal(settings.hasActiveApiKey(normalized), true);
});

test("switching provider does not lose another provider's saved key", () => {
  const stored = {
    provider: "fireworks",
    aiApiKeys: { deepseek: "keep-ds", fireworks: "keep-fw" },
  };
  const asFireworks = settings.normalize(stored);
  assert.equal(settings.activeApiKey(asFireworks), "keep-fw");
  // Switch the active provider only; both keys survive.
  const asDeepseek = settings.normalize({ ...stored, provider: "deepseek" });
  assert.equal(asDeepseek.aiApiKeys.deepseek, "keep-ds");
  assert.equal(asDeepseek.aiApiKeys.fireworks, "keep-fw");
  assert.equal(settings.activeApiKey(asDeepseek), "keep-ds");
});

test("an unknown or fail-closed provider falls back to deepseek without misusing keys", () => {
  const normalized = settings.normalize({
    provider: "totally-unknown",
    aiApiKeys: { deepseek: "", zhipu: "zhipu-key" },
  });
  // Falls back to the default provider...
  assert.equal(normalized.provider, "deepseek");
  // ...and the active key is the DeepSeek slot (empty), never the zhipu key.
  assert.equal(settings.activeApiKey(normalized), "");
  assert.notEqual(settings.activeApiKey(normalized), "zhipu-key");

  // tencent-hymt is fail-closed and cannot become the active provider.
  const asTencent = settings.normalize({
    provider: "tencent-hymt",
    aiApiKeys: { deepseek: "ds", "tencent-hymt": "held" },
  });
  assert.equal(asTencent.provider, "deepseek");
  // The pre-entered tencent key is preserved in its own slot, never activated.
  assert.equal(asTencent.aiApiKeys["tencent-hymt"], "held");
  assert.equal(settings.activeApiKey(asTencent), "ds");
});

test("legacy custom provider clears only the custom key and is idempotent", () => {
  const legacy = {
    provider: "custom",
    aiApiKey: "custom-endpoint-secret",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: " supadata-secret ",
  };
  const first = settings.migrateLegacy(legacy);
  assert.equal(first.migrated, true);
  assert.equal(first.settings.provider, "deepseek");
  // The custom key targeted a user URL and must NOT be reused as a DeepSeek key.
  assert.equal(first.settings.aiApiKeys.deepseek, "");
  assert.equal(first.settings.supadataApiKey, "supadata-secret");

  const second = settings.migrateLegacy(first.settings);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);
});

test("re-normalizing an already migrated key map is idempotent and never drops keys", () => {
  const migrated = settings.normalize({
    provider: "siliconflow",
    aiApiKeys: {
      deepseek: "ds",
      zhipu: "zp",
      dashscope: "qw",
      siliconflow: "sf",
      fireworks: "fw",
      "tencent-hymt": "hy",
    },
    supadataApiKey: "sd",
  });
  const again = settings.migrateLegacy(migrated);
  assert.equal(again.migrated, false);
  assert.deepEqual(again.settings, migrated);
});

test("Supadata blank values clear the saved key", () => {
  const normalized = settings.normalize({
    aiApiKeys: { deepseek: "ds" },
    supadataApiKey: "   ",
  });
  assert.equal(normalized.supadataApiKey, "");
});

test("Supadata receives a canonical YouTube URL", () => {
  assert.equal(
    settings.canonicalYouTubeUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.throws(
    () => settings.canonicalYouTubeUrl('"><script>'),
    /Invalid YouTube video ID/,
  );
});
