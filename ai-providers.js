/**
 * AI provider registry and request/response adapters.
 *
 * DigestDock is a bring-your-own-key extension. The user picks one provider and
 * pastes that provider's API key; everything else (endpoint, model, request
 * shape, auth, capability limits) is preset here so no endpoint or model text
 * box is ever exposed. This module is the single source of truth the service
 * worker, the options page, and the side panel all derive provider behavior
 * from, so provider-specific fields stay isolated and there is never a silent
 * fallback from one provider to another.
 *
 * Verification policy (frozen 2026-08-22): every selectable provider's endpoint
 * and model id below was confirmed against that provider's official
 * documentation. A provider whose official OpenAI-compatible configuration could
 * not be verified is kept in the registry as a fail-closed, non-selectable entry
 * (configVerified: false) rather than guessed. See icons/providers/PROVENANCE.md
 * for the per-provider source URLs and the brand-icon status.
 *
 * The module is pure logic: it never touches the network, chrome.* APIs, or the
 * DOM. buildRequest() returns a plain { url, headers, body } descriptor and
 * parseResponse()/normalizeError() only transform already-fetched data.
 */
var YTD_AI_PROVIDERS = (() => {
  // Product capabilities a provider may serve. A provider that lacks a
  // capability must have the matching feature blocked in the UI, never silently
  // rerouted to another provider.
  const CAPABILITIES = Object.freeze({
    OVERVIEW: "overview",
    EXPLAIN: "explain",
    TRANSLATE: "translate",
    NOTES: "notes",
  });
  const FULL_CAPABILITIES = Object.freeze([
    CAPABILITIES.OVERVIEW,
    CAPABILITIES.EXPLAIN,
    CAPABILITIES.TRANSLATE,
    CAPABILITIES.NOTES,
  ]);

  const DEFAULT_PROVIDER_ID = "deepseek";

  // Product error codes the rest of the extension already understands. Each
  // provider maps its raw HTTP status / error body onto one of these so the UI
  // copy and retry budget stay provider-agnostic.
  const ERROR_CODES = Object.freeze({
    RATE_LIMITED: "RATE_LIMITED",
    INVALID_KEY: "INVALID_KEY",
    PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
    PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
    OUTPUT_TRUNCATED: "OUTPUT_TRUNCATED",
    CONTENT_FILTERED: "CONTENT_FILTERED",
    PROVIDER_ERROR: "PROVIDER_ERROR",
  });

  // ----------------------------------------------------------------
  // Shared OpenAI-compatible adapter behavior
  // ----------------------------------------------------------------

  // All five verified providers speak the OpenAI chat-completions dialect
  // (Bearer auth, { choices: [{ message: { content } }] } responses), so they
  // share one builder/parser. Per-provider differences (endpoint, model, and
  // whether a JSON-mode / thinking-disable field is allowed) come from the
  // provider record, never from the shared code, which keeps a field like
  // DeepSeek's `thinking` from leaking onto a provider that does not accept it.
  function openAiCompatibleBuildRequest(provider, request) {
    const {
      apiKey,
      messages,
      maxTokens,
      temperature,
      responseFormat,
    } = request || {};
    const body = {
      model: provider.model,
      max_tokens: maxTokens,
      messages,
    };
    if (provider.supportsTemperature && typeof temperature === "number") {
      body.temperature = temperature;
    }
    if (provider.supportsJsonMode && responseFormat) {
      body.response_format = responseFormat;
    }
    if (provider.supportsThinkingDisabled) {
      // Product features need bounded latency rather than reasoning traces.
      // Only DeepSeek documents this field; it must not reach other providers.
      body.thinking = { type: "disabled" };
    }
    return {
      url: provider.endpoint,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    };
  }

  function openAiCompatibleParseResponse(data) {
    const choice = data && data.choices ? data.choices[0] : undefined;
    const message = choice && choice.message ? choice.message : undefined;
    return {
      text: message ? message.content : undefined,
      finishReason: choice && choice.finish_reason ? choice.finish_reason : "",
      raw: choice,
    };
  }

  // Maps a provider's raw failure (HTTP status and/or upstream error body) onto
  // one product error code. Auth failures and rate limits share the same status
  // conventions across the OpenAI-compatible providers, so this is shared too.
  function openAiCompatibleNormalizeError({ status } = {}) {
    if (status === 401 || status === 403) return ERROR_CODES.INVALID_KEY;
    if (status === 429) return ERROR_CODES.RATE_LIMITED;
    if (status === 408) return ERROR_CODES.PROVIDER_TIMEOUT;
    if (typeof status === "number" && status >= 500) {
      return ERROR_CODES.PROVIDER_UNAVAILABLE;
    }
    if (typeof status === "number" && status >= 400) {
      return ERROR_CODES.PROVIDER_ERROR;
    }
    return "";
  }

  // Attaches the shared adapter methods to a plain provider description so each
  // record is self-contained (record.buildRequest(request), etc.).
  function withOpenAiCompatibleAdapter(record) {
    const provider = {
      authType: "bearer",
      supportsTemperature: true,
      supportsJsonMode: false,
      supportsThinkingDisabled: false,
      configVerified: true,
      selectable: true,
      capabilities: FULL_CAPABILITIES.slice(),
      ...record,
    };
    provider.buildRequest = (request) =>
      openAiCompatibleBuildRequest(provider, request);
    provider.parseResponse = (data) => openAiCompatibleParseResponse(data);
    provider.normalizeError = (failure) =>
      openAiCompatibleNormalizeError(failure);
    return provider;
  }

  // ----------------------------------------------------------------
  // Provider records
  //
  // Endpoints and model ids below were each verified against the provider's
  // official docs on 2026-08-22. iconPath points at a locally bundled asset that
  // the UI loads with a neutral-monogram fallback when the file is absent; it is
  // never a remote URL. brandSourceUrl records where the official brand asset is
  // published (see PROVENANCE.md).
  // ----------------------------------------------------------------

  const PROVIDER_LIST = [
    withOpenAiCompatibleAdapter({
      id: "deepseek",
      displayName: "DeepSeek",
      // Verified: api-docs.deepseek.com — the retired default chat model gives
      // way to deepseek-v4-flash, the recommended flash model.
      model: "deepseek-v4-flash",
      modelLabel: "DeepSeek V4 Flash",
      endpoint: "https://api.deepseek.com/chat/completions",
      hostPermission: "https://api.deepseek.com/*",
      // DeepSeek is the only provider that documents the thinking-disable field
      // and JSON mode is exercised by the shipping product today.
      supportsJsonMode: true,
      supportsThinkingDisabled: true,
      apiKeyHelpUrl: "https://platform.deepseek.com/api_keys",
      iconPath: "icons/providers/deepseek.png",
      iconAlt: "DeepSeek",
      brandSourceUrl: "https://www.deepseek.com/",
    }),
    withOpenAiCompatibleAdapter({
      id: "zhipu",
      displayName: "智谱 GLM",
      // Verified: docs.bigmodel.cn — model code glm-4.7-flash.
      model: "glm-4.7-flash",
      modelLabel: "GLM-4.7-Flash",
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      hostPermission: "https://open.bigmodel.cn/*",
      apiKeyHelpUrl: "https://open.bigmodel.cn/usercenter/apikeys",
      iconPath: "icons/providers/zhipu.png",
      iconAlt: "智谱 GLM",
      brandSourceUrl: "https://www.bigmodel.cn/",
    }),
    withOpenAiCompatibleAdapter({
      id: "dashscope",
      displayName: "阿里云百炼 Qwen",
      // Verified: help.aliyun.com/zh/model-studio/qwen-flash — the official
      // model id is qwen-flash (the Qwen3-series flash model). No literal
      // "qwen3.7-flash" id exists, so qwen-flash is used as documented.
      model: "qwen-flash",
      modelLabel: "Qwen Flash (Qwen3)",
      endpoint:
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      hostPermission: "https://dashscope.aliyuncs.com/*",
      apiKeyHelpUrl: "https://bailian.console.aliyun.com/?apiKey=1",
      iconPath: "icons/providers/dashscope-qwen.png",
      iconAlt: "阿里云百炼 Qwen",
      brandSourceUrl: "https://www.aliyun.com/product/bailian",
    }),
    withOpenAiCompatibleAdapter({
      id: "siliconflow",
      displayName: "SiliconFlow",
      // Verified: docs.siliconflow.cn — HuggingFace-style id Qwen/Qwen3-8B.
      model: "Qwen/Qwen3-8B",
      modelLabel: "Qwen3-8B",
      endpoint: "https://api.siliconflow.cn/v1/chat/completions",
      hostPermission: "https://api.siliconflow.cn/*",
      apiKeyHelpUrl: "https://cloud.siliconflow.cn/account/ak",
      iconPath: "icons/providers/siliconflow.png",
      iconAlt: "SiliconFlow",
      brandSourceUrl: "https://www.siliconflow.cn/",
    }),
    withOpenAiCompatibleAdapter({
      id: "fireworks",
      displayName: "Fireworks",
      // Verified: docs.fireworks.ai / app.fireworks.ai — DeepSeek V4 Flash is
      // published as accounts/fireworks/models/deepseek-v4-flash-0731.
      model: "accounts/fireworks/models/deepseek-v4-flash-0731",
      modelLabel: "DeepSeek V4 Flash (Fireworks)",
      endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
      hostPermission: "https://api.fireworks.ai/*",
      apiKeyHelpUrl: "https://app.fireworks.ai/settings/users/api-keys",
      iconPath: "icons/providers/fireworks.svg",
      iconAlt: "Fireworks AI",
      brandSourceUrl: "https://fireworks.ai/",
    }),
    // Fail-closed entry. The official Tencent Hunyuan machine-translation models
    // (hunyuan-translation-lite) are served over Tencent Cloud's proprietary
    // TC3-HMAC-signed API (hunyuan.ai.tencentcloudapi.com), not the Bearer
    // OpenAI-compatible endpoint used here, and no model literally named
    // "hy-mt2-lite" could be confirmed on an OpenAI-compatible endpoint on
    // 2026-08-22. Rather than guess an endpoint, auth scheme, or model id, this
    // provider is kept defined (so its translation-only capability gate is ready
    // if the config is later verified) but is not selectable.
    {
      id: "tencent-hymt",
      displayName: "腾讯混元翻译",
      modelLabel: "hunyuan-translation-lite",
      capabilities: [CAPABILITIES.TRANSLATE],
      authType: "unverified",
      configVerified: false,
      selectable: false,
      blockedReason:
        "官方 OpenAI 兼容 Endpoint / 模型 ID 未核实（翻译模型走专有签名 API），已按 fail-closed 暂停接入。",
      supportsTemperature: false,
      supportsJsonMode: false,
      supportsThinkingDisabled: false,
      iconPath: "icons/providers/tencent-hunyuan.svg",
      iconAlt: "腾讯混元",
      brandSourceUrl: "https://cloud.tencent.com/product/hunyuan",
      buildRequest() {
        const error = new Error(
          "腾讯混元翻译预设未通过官方核实，暂不可用。",
        );
        error.code = "PROVIDER_NOT_CONFIGURED";
        throw error;
      },
      parseResponse: openAiCompatibleParseResponse,
      normalizeError: openAiCompatibleNormalizeError,
    },
  ];

  const PROVIDERS_BY_ID = new Map(
    PROVIDER_LIST.map((provider) => [provider.id, provider]),
  );

  function getProvider(id) {
    return PROVIDERS_BY_ID.get(String(id || "")) || null;
  }

  // Only verified, selectable providers appear in the picker. A stored provider
  // that is unknown or fail-closed resolves back to the default here without
  // ever adopting a different provider's key (the caller reads the key by id).
  function listSelectableProviders() {
    return PROVIDER_LIST.filter(
      (provider) => provider.selectable && provider.configVerified,
    );
  }

  function listProviderDescriptions() {
    return PROVIDER_LIST.map((provider) => describeProvider(provider.id));
  }

  function isSelectableProvider(id) {
    const provider = getProvider(id);
    return !!provider && provider.selectable && provider.configVerified;
  }

  function resolveProviderId(id) {
    return isSelectableProvider(id) ? String(id) : DEFAULT_PROVIDER_ID;
  }

  function supportsCapability(id, capability) {
    const provider = getProvider(id);
    return (
      !!provider &&
      Array.isArray(provider.capabilities) &&
      provider.capabilities.includes(capability)
    );
  }

  // Presentation-safe view (no functions, no secrets) for checkConfig responses
  // and the options/side-panel UI.
  function describeProvider(id) {
    const provider = getProvider(id);
    if (!provider) return null;
    return {
      id: provider.id,
      displayName: provider.displayName,
      modelLabel: provider.modelLabel || provider.model || "",
      capabilities: (provider.capabilities || []).slice(),
      supportsJsonMode: !!provider.supportsJsonMode,
      apiKeyHelpUrl: provider.apiKeyHelpUrl || "",
      iconPath: provider.iconPath || "",
      iconAlt: provider.iconAlt || provider.displayName,
      brandSourceUrl: provider.brandSourceUrl || "",
      selectable: !!provider.selectable,
      configVerified: !!provider.configVerified,
      blockedReason: provider.blockedReason || "",
    };
  }

  function providerLabel(id) {
    const provider = getProvider(id);
    return provider ? provider.displayName : "AI 服务";
  }

  return {
    CAPABILITIES,
    FULL_CAPABILITIES,
    ERROR_CODES,
    DEFAULT_PROVIDER_ID,
    getProvider,
    listProviderDescriptions,
    listSelectableProviders,
    isSelectableProvider,
    resolveProviderId,
    supportsCapability,
    describeProvider,
    providerLabel,
    // Exposed for focused adapter tests.
    openAiCompatibleBuildRequest,
    openAiCompatibleParseResponse,
    openAiCompatibleNormalizeError,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_AI_PROVIDERS;
}
