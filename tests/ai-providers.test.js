const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const providers = require("../ai-providers.js");
const settings = require("../settings.js");

const root = path.resolve(__dirname, "..");

const VERIFIED = {
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
  },
  zhipu: {
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4.7-flash",
  },
  dashscope: {
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-flash",
  },
  siliconflow: {
    url: "https://api.siliconflow.cn/v1/chat/completions",
    model: "Qwen/Qwen3-8B",
  },
  fireworks: {
    url: "https://api.fireworks.ai/inference/v1/chat/completions",
    model: "accounts/fireworks/models/deepseek-v4-flash-0731",
  },
};

const request = {
  apiKey: "test-key",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
  temperature: 0.2,
  responseFormat: { type: "json_object" },
};

test("selectable providers are exactly the five verified OpenAI-compatible services", () => {
  const ids = providers.listSelectableProviders().map((p) => p.id);
  assert.deepEqual([...ids].sort(), Object.keys(VERIFIED).sort());
  assert.equal(providers.DEFAULT_PROVIDER_ID, "deepseek");
});

test("provider presentation list includes the disabled Tencent entry and all six icons", () => {
  const presented = providers.listProviderDescriptions();
  assert.equal(presented.length, 6);
  const tencent = presented.find((provider) => provider.id === "tencent-hymt");
  assert.ok(tencent);
  assert.equal(tencent.selectable, false);
  assert.equal(tencent.configVerified, false);
  assert.match(tencent.blockedReason, /未核实|专有签名 API/);
  assert.equal(tencent.iconPath, "icons/providers/tencent-hunyuan.svg");
  for (const provider of presented) assert.ok(provider.iconPath);
});

test("each verified provider builds the correct URL, auth header, model, and body", () => {
  for (const [id, expected] of Object.entries(VERIFIED)) {
    const provider = providers.getProvider(id);
    assert.ok(provider, `${id} exists`);
    const built = provider.buildRequest(request);
    assert.equal(built.url, expected.url, `${id} url`);
    assert.equal(
      built.headers.Authorization,
      "Bearer test-key",
      `${id} auth header`,
    );
    assert.equal(
      built.headers["Content-Type"],
      "application/json",
      `${id} content-type`,
    );
    assert.equal(built.body.model, expected.model, `${id} model`);
    assert.deepEqual(built.body.messages, request.messages, `${id} messages`);
    assert.equal(built.body.max_tokens, 100, `${id} max_tokens`);
    assert.equal(built.body.temperature, 0.2, `${id} temperature`);
  }
});

test("DeepSeek-only fields never leak onto other providers", () => {
  const deepseek = providers.getProvider("deepseek").buildRequest(request);
  // DeepSeek documents thinking-disable and exercises JSON mode.
  assert.deepEqual(deepseek.body.thinking, { type: "disabled" });
  assert.deepEqual(deepseek.body.response_format, { type: "json_object" });

  for (const id of ["zhipu", "dashscope", "siliconflow", "fireworks"]) {
    const built = providers.getProvider(id).buildRequest(request);
    assert.equal(
      Object.hasOwn(built.body, "thinking"),
      false,
      `${id} must not receive DeepSeek's thinking field`,
    );
    // JSON mode defaults off for unverified-quality providers; they rely on the
    // strict prompt + loose JSON parser instead of an unproven response_format.
    assert.equal(
      Object.hasOwn(built.body, "response_format"),
      false,
      `${id} must not receive response_format until JSON mode is verified`,
    );
  }
});

test("temperature and JSON mode are gated by capability flags", () => {
  const noTemp = providers.getProvider("deepseek").buildRequest({
    ...request,
    temperature: undefined,
  });
  assert.equal(Object.hasOwn(noTemp.body, "temperature"), false);

  const noJson = providers.getProvider("deepseek").buildRequest({
    ...request,
    responseFormat: undefined,
  });
  assert.equal(Object.hasOwn(noJson.body, "response_format"), false);
});

test("responses parse and errors normalize to product codes", () => {
  const provider = providers.getProvider("siliconflow");
  const parsed = provider.parseResponse({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  });
  assert.equal(parsed.text, "ok");
  assert.equal(parsed.finishReason, "stop");

  assert.equal(provider.normalizeError({ status: 401 }), "INVALID_KEY");
  assert.equal(provider.normalizeError({ status: 403 }), "INVALID_KEY");
  assert.equal(provider.normalizeError({ status: 429 }), "RATE_LIMITED");
  assert.equal(provider.normalizeError({ status: 503 }), "PROVIDER_UNAVAILABLE");
  assert.equal(provider.normalizeError({ status: 400 }), "PROVIDER_ERROR");
  assert.equal(provider.normalizeError({ status: 200 }), "");
});

test("an unknown or fail-closed provider never adopts another provider's key", () => {
  // resolveProviderId falls back to the default id; it never returns a
  // different selectable id, so a caller keyed by that id cannot silently reuse
  // a key that belongs to another provider.
  assert.equal(providers.resolveProviderId("does-not-exist"), "deepseek");
  assert.equal(providers.resolveProviderId("tencent-hymt"), "deepseek");
  assert.equal(providers.isSelectableProvider("tencent-hymt"), false);
});

test("Tencent Hunyuan MT is present but fail-closed and translation-only", () => {
  const provider = providers.getProvider("tencent-hymt");
  assert.ok(provider, "entry exists for a future verified config");
  assert.equal(provider.configVerified, false);
  assert.equal(provider.selectable, false);
  assert.ok(provider.blockedReason, "records why it is fail-closed");
  assert.deepEqual(provider.capabilities, ["translate"]);
  assert.equal(providers.supportsCapability("tencent-hymt", "overview"), false);
  assert.equal(providers.supportsCapability("tencent-hymt", "translate"), true);
  // It must never build a live request while unverified.
  assert.throws(
    () => provider.buildRequest(request),
    /未通过官方核实|未.*可用|PROVIDER_NOT_CONFIGURED/,
  );
});

test("capability gate: verified providers serve every product capability", () => {
  for (const id of Object.keys(VERIFIED)) {
    for (const cap of ["overview", "explain", "translate", "notes"]) {
      assert.equal(providers.supportsCapability(id, cap), true, `${id}:${cap}`);
    }
  }
});

test("every provider icon path is local, never a remote or data URL", () => {
  for (const provider of [
    ...providers.listSelectableProviders(),
    providers.getProvider("tencent-hymt"),
  ]) {
    const iconPath = provider.iconPath;
    assert.ok(iconPath, `${provider.id} declares an iconPath`);
    assert.doesNotMatch(
      iconPath,
      /^[a-z]+:|^\/\//i,
      `${provider.id} iconPath must not be a remote/data URL`,
    );
    assert.match(
      iconPath,
      /^icons\/providers\/[a-z0-9-]+\.(?:svg|png)$/,
      `${provider.id} iconPath is a bundled local asset`,
    );
    assert.equal(
      fs.existsSync(path.join(root, iconPath)),
      true,
      `${provider.id} icon file exists on disk`,
    );
  }
});

test("provider brand provenance is documented and no bundled icon is pending", () => {
  const provenance = fs.readFileSync(
    path.join(root, "icons/providers/PROVENANCE.md"),
    "utf8",
  );
  for (const provider of providers.listSelectableProviders()) {
    // Each provider's official brand-source domain is recorded for traceability.
    const host = new URL(provider.brandSourceUrl).host;
    assert.ok(
      provenance.includes(host),
      `PROVENANCE.md documents ${provider.id} (${host})`,
    );
  }
  assert.doesNotMatch(provenance, /\|\s*pending\s*\|/i);
});

test("describeProvider exposes UI fields but never a key or adapter function", () => {
  const described = providers.describeProvider("deepseek");
  assert.equal(described.id, "deepseek");
  assert.equal(described.displayName, "DeepSeek");
  assert.ok(Array.isArray(described.capabilities));
  assert.equal(typeof described.buildRequest, "undefined");
  assert.equal(Object.hasOwn(described, "model"), false);
});

test("settings key-map slots stay in sync with the registry provider ids", () => {
  const registryIds = [
    ...providers.listSelectableProviders().map((p) => p.id),
    "tencent-hymt",
  ].sort();
  assert.deepEqual([...settings.AI_PROVIDER_IDS].sort(), registryIds);
  assert.deepEqual(
    [...settings.SELECTABLE_PROVIDER_IDS].sort(),
    providers
      .listSelectableProviders()
      .map((p) => p.id)
      .sort(),
  );
});
