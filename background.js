/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching Bilibili captions and routing YouTube captions through local
 *    cache/Passive capture, a user-facing CC prompt, then optional Supadata
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
// ai-providers.js loads first so settings and request logic can derive each
// provider's endpoint, model, and adapter from the registry.
importScripts("ai-providers.js");
importScripts("settings.js");
importScripts("bilibili.js");
importScripts("notes-backup.js");
importScripts("note-sources.js");
importScripts("export-jobs.js");

const DEBUG = false;
const ANALYSIS_SCHEMA_VERSION = 3;
const RUNTIME_PROTOCOL_VERSION = 12;
const ANALYSIS_BASE_LANGUAGE = "zh-Hans";
const TRANSCRIPT_SOURCE_POLICY_VERSION = 5;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SAVED_NOTES = 100;
const NOTE_TRANSLATION_JOB_TIMEOUT_MS = 110_000;
const EXPORT_SOURCE_BATCH_MAX_UNITS = 4;
const EXPORT_SOURCE_BATCH_MAX_CHARACTERS = 12_000;
const EXPORT_SOURCE_BATCH_LEASE_MS = 135_000;
// After a Supadata 429 the extension refuses to start another provider request
// for a bounded window. This is a Supadata-specific rate limit, never YouTube.
const SUPADATA_RATE_LIMIT_COOLDOWN_MS = 60_000;
const SUPADATA_COOLDOWN_STORAGE_KEY = "digestdock_supadata_cooldown_until";
// Bounds for every Supadata request and job poll: a hard timeout and a response
// body cap so a slow or oversized reply cannot hang or exhaust the worker.
const SUPADATA_REQUEST_TIMEOUT_MS = 20_000;
const SUPADATA_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SUPADATA_JOB_TIMEOUT_MS = 90_000;
const YOUTUBE_NATIVE_RATE_LIMIT_COOLDOWN_MS = 60_000;
const YOUTUBE_NATIVE_COOLDOWN_STORAGE_KEY =
  "youtube_native_cooldown_until";
const YOUTUBE_PASSIVE_SESSION_STORAGE_KEY =
  "youtube_passive_session_buffer";
const YOUTUBE_PASSIVE_WAIT_MS = 1_500;
const YOUTUBE_PASSIVE_MAX_BODY_BYTES = 8 * 1024 * 1024;
const YOUTUBE_PASSIVE_MAX_STATE_BYTES = 6 * 1024 * 1024;
const YOUTUBE_PASSIVE_MAX_ENTRIES = 6;
const YOUTUBE_ACTIVE_PRODUCT_FILE = "youtube-transcript-active.js";
const YOUTUBE_PANEL_PRODUCT_FILE = "youtube-transcript-panel.js";
const YOUTUBE_TRANSCRIPT_CACHE_SOURCES = new Set([
  "youtube-passive",
  "youtube-active",
  "youtube-panel",
  "supadata",
]);
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Background single-flight for authorized YouTube Supadata requests. Duplicate
// requests for the same tab, video, and preferred language (side-panel init,
// the in-page Digest button, a page "complete" broadcast, and multi-window
// side panels pointed at the same tab) share one in-flight provider call
// instead of each spending a separate Supadata credit.
const youtubeSupadataInFlight = new Map();
// The native free route is shared across tabs/windows by media identity. The
// leader tab performs the bounded Active/Panel work; every waiter keeps its own
// tab/run identity and independently revalidates the page before accepting the
// shared result.
const youtubeNativeInFlight = new Map();
const youtubeTabNavigationEpochs = new Map();
const youtubePassiveWaiters = new Set();
let youtubePassiveMutationQueue = Promise.resolve();
let youtubePassiveRevision = 0;
let youtubeNativeCooldownUntil = 0;
// A side panel can be closed and reopened while the MV3 service worker keeps an
// authorized export batch alive. Duplicate submissions for the same durable
// job/batch share this promise, so they never spend a second provider request.
const exportSourceBatchInFlight = new Map();
let exportSourceBatchQueueTail = Promise.resolve();
let exportSourceStorageGeneration = 0;
let youtubeSupadataCooldownUntil = 0;

function youtubeTabNavigationEpoch(tabId) {
  return Number.isInteger(tabId)
    ? Number(youtubeTabNavigationEpochs.get(tabId) || 0)
    : -1;
}

function bumpYoutubeTabNavigationEpoch(tabId) {
  if (!Number.isInteger(tabId)) return -1;
  const next = youtubeTabNavigationEpoch(tabId) + 1;
  youtubeTabNavigationEpochs.set(tabId, next);
  return next;
}

function youtubeTabEpochStillMatches(tabId, expectedEpoch) {
  return (
    Number.isInteger(tabId) &&
    youtubeTabNavigationEpoch(tabId) === expectedEpoch
  );
}

function runYoutubeSupadataSingleFlight(key, task) {
  const existing = youtubeSupadataInFlight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(task)
    .finally(() => {
      if (youtubeSupadataInFlight.get(key) === promise) {
        youtubeSupadataInFlight.delete(key);
      }
    });
  youtubeSupadataInFlight.set(key, promise);
  return promise;
}

async function readYoutubeSupadataCooldownUntil() {
  let cooldownUntil = youtubeSupadataCooldownUntil;
  const now = Date.now();
  try {
    const sessionStorage = chrome.storage?.session;
    if (typeof sessionStorage?.get === "function") {
      const stored = await sessionStorage.get(SUPADATA_COOLDOWN_STORAGE_KEY);
      const storedUntil = Number(stored?.[SUPADATA_COOLDOWN_STORAGE_KEY]);
      if (
        Number.isFinite(storedUntil) &&
        storedUntil > now &&
        storedUntil <= now + SUPADATA_RATE_LIMIT_COOLDOWN_MS
      ) {
        cooldownUntil = Math.max(cooldownUntil, storedUntil);
      }
    }
  } catch (_error) {
    // A transient storage failure must not bypass the in-memory cooldown.
  }
  youtubeSupadataCooldownUntil = cooldownUntil;
  return cooldownUntil;
}

async function startYoutubeSupadataCooldown() {
  const cooldownUntil = Date.now() + SUPADATA_RATE_LIMIT_COOLDOWN_MS;
  youtubeSupadataCooldownUntil = cooldownUntil;
  try {
    const sessionStorage = chrome.storage?.session;
    if (typeof sessionStorage?.set === "function") {
      await sessionStorage.set({
        [SUPADATA_COOLDOWN_STORAGE_KEY]: cooldownUntil,
      });
    }
  } catch (_error) {
    // The in-memory value still protects the current worker lifetime.
  }
  return cooldownUntil;
}

function runYoutubeNativeSingleFlight(key, task) {
  const existing = youtubeNativeInFlight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(task)
    .finally(() => {
      if (youtubeNativeInFlight.get(key) === promise) {
        youtubeNativeInFlight.delete(key);
      }
    });
  youtubeNativeInFlight.set(key, promise);
  return promise;
}

async function readYoutubeNativeCooldownUntil() {
  let cooldownUntil = youtubeNativeCooldownUntil;
  const now = Date.now();
  try {
    const sessionStorage = chrome.storage?.session;
    if (typeof sessionStorage?.get === "function") {
      const stored = await sessionStorage.get(
        YOUTUBE_NATIVE_COOLDOWN_STORAGE_KEY,
      );
      const storedUntil = Number(
        stored?.[YOUTUBE_NATIVE_COOLDOWN_STORAGE_KEY],
      );
      if (
        Number.isFinite(storedUntil) &&
        storedUntil > now &&
        storedUntil <= now + YOUTUBE_NATIVE_RATE_LIMIT_COOLDOWN_MS
      ) {
        cooldownUntil = Math.max(cooldownUntil, storedUntil);
      }
    }
  } catch (_error) {
    // The in-memory timestamp still protects this worker lifetime.
  }
  youtubeNativeCooldownUntil = cooldownUntil;
  return cooldownUntil;
}

async function startYoutubeNativeCooldown() {
  const cooldownUntil = Date.now() + YOUTUBE_NATIVE_RATE_LIMIT_COOLDOWN_MS;
  youtubeNativeCooldownUntil = cooldownUntil;
  try {
    const sessionStorage = chrome.storage?.session;
    if (typeof sessionStorage?.set === "function") {
      await sessionStorage.set({
        [YOUTUBE_NATIVE_COOLDOWN_STORAGE_KEY]: cooldownUntil,
      });
    }
  } catch (_error) {
    // The in-memory timestamp still protects this worker lifetime.
  }
  return cooldownUntil;
}

const CHINESE_LANGUAGE_CODES = new Set([
  "zh",
  "zho",
  "chi",
  "cmn",
  "yue",
  "wuu",
  "gan",
  "hak",
  "nan",
  "lzh",
]);
const NON_TRANSLATABLE_LANGUAGE_CODES = new Set(["und", "mul", "zxx"]);

/**
 * Accept only short, structurally valid BCP-47 language tags before a value is
 * stored or interpolated into an AI prompt. Supadata's language metadata is
 * external input, so a free-form value must never become prompt instructions.
 */
function normalizeLanguageCode(value) {
  const raw = typeof value === "string" ? value.trim().replace(/_/g, "-") : "";
  if (
    !raw ||
    raw.length > 35 ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(raw)
  ) {
    return "";
  }
  try {
    return Intl.getCanonicalLocales(raw)[0] || "";
  } catch (error) {
    return "";
  }
}

function isNonTranslatableLanguage(value) {
  const normalized = normalizeLanguageCode(value);
  return (
    !normalized ||
    NON_TRANSLATABLE_LANGUAGE_CODES.has(
      normalized.split("-")[0].toLowerCase(),
    )
  );
}

function isChineseLanguage(value) {
  const normalized = normalizeLanguageCode(value);
  if (!normalized) return false;
  return CHINESE_LANGUAGE_CODES.has(normalized.split("-")[0].toLowerCase());
}

function isConfirmedSimplifiedChineseSource(value) {
  const normalized = normalizeLanguageCode(value).toLowerCase();
  if (!normalized) return false;
  const [primary, ...subtags] = normalized.split("-");
  if (primary !== "zh") return false;
  if (subtags.includes("hant")) return false;
  if (subtags.includes("hans")) return true;
  return subtags.includes("cn") || subtags.includes("sg");
}

function languagesSharePrimary(value, otherValue) {
  if (isChineseLanguage(value) && isChineseLanguage(otherValue)) return true;
  const primary = normalizeLanguageCode(value).split("-")[0].toLowerCase();
  const otherPrimary = normalizeLanguageCode(otherValue)
    .split("-")[0]
    .toLowerCase();
  return Boolean(primary && primary === otherPrimary);
}

function looksLikeChineseTranscript(value) {
  const text = String(value || "");
  const hanCharacters = text.match(/[\u3400-\u9fff]/g) || [];
  if (hanCharacters.length < 4) return false;
  // Japanese transcripts normally contain hiragana or katakana alongside
  // kanji. Do not treat those shared Han characters as proof of Chinese.
  return !/[\u3040-\u30ff\u31f0-\u31ff]/.test(text);
}

function hasUsableChineseOverview(analysis) {
  return (
    Array.isArray(analysis?.chapters) &&
    analysis.chapters.length > 0 &&
    analysis.chapters.every((chapter) =>
      /[\u3400-\u9fff]/.test(String(chapter?.summaryZh || "")),
    ) &&
    Array.isArray(analysis?.keyQuotes) &&
    analysis.keyQuotes.length > 0 &&
    analysis.keyQuotes.every((quote) =>
      /[\u3400-\u9fff]/.test(String(quote?.quoteZh || "")),
    )
  );
}

function resolveSourceLanguage(value, transcriptText = "") {
  const normalized = normalizeLanguageCode(value);
  if (
    normalized &&
    !isNonTranslatableLanguage(normalized)
  ) {
    return normalized;
  }
  if (looksLikeChineseTranscript(transcriptText)) {
    return ANALYSIS_BASE_LANGUAGE;
  }
  return "und";
}

function getSafeLanguageName(value) {
  const normalized = normalizeLanguageCode(value);
  if (
    !normalized ||
    isNonTranslatableLanguage(normalized)
  ) {
    throw new Error("Overview source language is missing or unsupported");
  }
  try {
    const displayName = new Intl.DisplayNames(["en"], {
      type: "language",
      languageDisplay: "standard",
    }).of(normalized);
    if (
      typeof displayName === "string" &&
      displayName.length <= 100 &&
      /^[\p{L}\p{M}\p{N} ()'’,./-]+$/u.test(displayName)
    ) {
      return displayName;
    }
  } catch (error) {
    // Fall through to the normalized, character-restricted BCP-47 tag.
  }
  return `language ${normalized}`;
}

function getSupadataTrackLanguage(data) {
  const firstChunkLanguage = Array.isArray(data?.content)
    ? data.content.find((chunk) => normalizeLanguageCode(chunk?.lang))?.lang
    : "";
  return (
    normalizeLanguageCode(data?.lang) ||
    normalizeLanguageCode(firstChunkLanguage) ||
    null
  );
}

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[DigestDock] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

// Resolves the active provider record for a settings object. Always returns a
// verified, selectable provider (falling back to the default id, never adopting
// another provider's key), so request construction can rely on a valid adapter.
function resolveActiveProvider(settings) {
  const id = YTD_AI_PROVIDERS.resolveProviderId(settings?.provider);
  return YTD_AI_PROVIDERS.getProvider(id);
}

// User-facing provider name for error copy, so messages never hardcode
// "DeepSeek" once another provider is selected.
function providerDisplayLabel(settings) {
  return resolveActiveProvider(settings)?.displayName || "AI 服务";
}

function isMissingContentReceiverError(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("Could not establish connection") &&
    message.includes("Receiving end does not exist")
  );
}

function isTransientTabContextError(error) {
  const message = String(error?.message || error || "");
  return (
    (message.includes("Frame with ID") && message.includes("was removed")) ||
    message.includes("No tab with id")
  );
}

function isPageRefreshRequiredError(error) {
  return error?.code === "PAGE_REFRESH_REQUIRED";
}

async function sendMessageToContentWithRecovery(
  tabId,
  payload,
  dependencies = {},
  targetUrl = "",
) {
  const sendMessage =
    dependencies.sendMessage ||
    ((targetTabId, message) => chrome.tabs.sendMessage(targetTabId, message));
  const retryDelays = dependencies.retryDelays || [150, 350, 700];
  const wait =
    dependencies.wait ||
    ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sendMessage(tabId, payload);
    } catch (error) {
      if (!isMissingContentReceiverError(error)) throw error;
      const retryDelay = retryDelays[attempt];
      if (Number.isFinite(retryDelay)) {
        await wait(retryDelay);
        continue;
      }

      // A full content-script reinjection can coexist with an orphaned
      // observer from the pre-reload extension context. Both instances can
      // then fight over page controls. A few message-only retries cover normal
      // document_idle startup; refreshing is the only safe recovery after
      // those retries still find no live receiver.
      const pageLabel = isBilibiliVideoUrl(targetUrl) ? "B 站" : "YouTube";
      const refreshError = new Error(
        `DigestDock 已更新，请刷新当前 ${pageLabel} 页面后重试。`,
      );
      refreshError.code = "PAGE_REFRESH_REQUIRED";
      throw refreshError;
    }
  }
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
  hardTimeoutMs,
  settingsOverride,
}) {
  const settings = settingsOverride || (await getSettings());
  const provider = resolveActiveProvider(settings);
  const providerLabel = provider?.displayName || "AI 服务";
  const apiKey = YTD_SETTINGS.apiKeyFor(settings, provider?.id);
  if (!apiKey) {
    const error = new Error(
      `尚未配置${providerLabel} API 密钥，请打开 DigestDock 设置。`,
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  // The provider adapter owns endpoint, auth header, model field, and which
  // optional fields (JSON mode, thinking-disable) are allowed, so a field like
  // DeepSeek's `thinking` never leaks onto a provider that would reject it.
  const { url, headers, body } = provider.buildRequest({
    apiKey,
    messages,
    maxTokens,
    temperature,
    responseFormat,
  });

  const controller = new AbortController();
  const effectiveHardTimeoutMs =
    Number.isFinite(hardTimeoutMs) && hardTimeoutMs > 0
      ? Math.min(AI_PROVIDER_HARD_TIMEOUT_MS, Math.floor(hardTimeoutMs))
      : AI_PROVIDER_HARD_TIMEOUT_MS;
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    effectiveHardTimeoutMs,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Receiving headers proves the provider is still making progress. It may
    // then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `${providerLabel} error: ${response.status}`,
      );
      error.status = response.status;
      // Provider adapter maps the raw status onto a product error code.
      const normalized = provider.normalizeError({
        status: response.status,
        body: errorData,
      });
      if (normalized) error.code = normalized;
      throw error;
    }

    const parsed = provider.parseResponse(data);
    const finishReason = parsed.finishReason;
    if (finishReason && finishReason !== "stop") {
      const codeByFinishReason = {
        length: "OUTPUT_TRUNCATED",
        content_filter: "CONTENT_FILTERED",
        insufficient_system_resource: "PROVIDER_UNAVAILABLE",
      };
      const finishError = new Error(
        `${providerLabel} stopped before completing the response (${finishReason}).`,
      );
      finishError.code =
        codeByFinishReason[finishReason] || "UNEXPECTED_FINISH_REASON";
      throw finishError;
    }

    const text = parsed.text;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error(`${providerLabel} returned an empty response.`);
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings, finishReason: finishReason || "" };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        `${providerLabel} 请求已连续 50 秒没有响应，请重试。`,
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        `${providerLabel} 请求超过 ${Math.ceil(effectiveHardTimeoutMs / 1000)} 秒，请重试。`,
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including a provider's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("AI provider response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("AI provider response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// YOUTUBE PASSIVE SESSION BUFFER
// ============================================================

function validYoutubeVideoId(value) {
  const videoId = String(value || "").trim();
  return /^[0-9A-Za-z_-]{11}$/.test(videoId) ? videoId : "";
}

function normalizeYoutubeTrackKind(value) {
  return ["manual-first", "manual", "asr", "any"].includes(value)
    ? value
    : "manual-first";
}

function youtubePrimaryLanguage(value) {
  return normalizeLanguageCode(value).split("-")[0].toLowerCase();
}

function passiveIdentity(tabId, videoId, language, trackKind) {
  return [
    tabId,
    videoId,
    normalizeLanguageCode(language) || "und",
    trackKind === "asr" ? "asr" : "manual",
  ].join(":");
}

function decodePassiveEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, number) =>
      String.fromCodePoint(Number.parseInt(number, 16)),
    )
    .replace(/&#(\d+);/g, (_match, number) =>
      String.fromCodePoint(Number.parseInt(number, 10)),
    );
}

function cleanPassiveText(value) {
  return decodePassiveEntities(value)
    .replace(/<[^>]+>/g, "")
    .replace(/>> ?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePassiveSegments(rows, language) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const text = cleanPassiveText(row?.text);
      const start = Number(row?.start);
      const duration = Number(row?.duration);
      if (
        !text ||
        !Number.isFinite(start) ||
        !Number.isFinite(duration) ||
        start < 0 ||
        duration < 0
      ) {
        return null;
      }
      return {
        text,
        start,
        duration,
        language:
          normalizeLanguageCode(language) ||
          normalizeLanguageCode(row?.language) ||
          null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
}

function parsePassiveJson3(body, language) {
  let payload;
  try {
    payload = JSON.parse(String(body || ""));
  } catch (_error) {
    return [];
  }
  const rows = [];
  for (const event of Array.isArray(payload?.events) ? payload.events : []) {
    if (!Array.isArray(event?.segs) || event.aAppend === 1) continue;
    rows.push({
      text: event.segs.map((segment) => segment?.utf8 || "").join(""),
      start: Number(event.tStartMs || 0) / 1000,
      duration: Number(event.dDurationMs || 0) / 1000,
    });
  }
  return normalizePassiveSegments(rows, language);
}

function readPassiveXmlAttribute(source, name) {
  const match = String(source || "").match(
    new RegExp(`\\b${name}=["']([^"']+)["']`, "i"),
  );
  return match ? match[1] : null;
}

function parsePassiveXml(body, language) {
  const xml = String(body || "");
  const rows = [];
  const paragraphPattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = paragraphPattern.exec(xml))) {
    const start = readPassiveXmlAttribute(match[1], "t");
    const duration = readPassiveXmlAttribute(match[1], "d");
    if (start === null || duration === null) continue;
    const pieces = [...match[2].matchAll(/<s\b[^>]*>([\s\S]*?)<\/s>/gi)];
    rows.push({
      text: pieces.length
        ? pieces.map((piece) => piece[1]).join("")
        : match[2],
      start: Number(start) / 1000,
      duration: Number(duration) / 1000,
    });
  }
  if (!rows.length) {
    const classicPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    while ((match = classicPattern.exec(xml))) {
      const start = readPassiveXmlAttribute(match[1], "start");
      const duration = readPassiveXmlAttribute(match[1], "dur");
      if (start === null || duration === null) continue;
      rows.push({
        text: match[2],
        start: Number(start),
        duration: Number(duration),
      });
    }
  }
  return normalizePassiveSegments(rows, language);
}

function formatYoutubeTranscriptTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function buildYoutubeTranscriptResult(
  transcript,
  {
    source,
    sourceAttempt,
    language = "",
    selectedTrack = null,
    providerVariant = null,
    diagnostics = null,
  },
) {
  const normalized = normalizePassiveSegments(transcript, language);
  if (!normalized.length) return null;
  const resolvedLanguage =
    normalizeLanguageCode(language) ||
    normalizeLanguageCode(normalized.find((segment) => segment.language)?.language) ||
    null;
  return {
    success: true,
    routeOutcome: "HAVE_TRANSCRIPT",
    transcript: normalized,
    transcriptText: normalized.map((segment) => segment.text).join(" "),
    transcriptTextTimestamped: normalized
      .map(
        (segment) =>
          `[${formatYoutubeTranscriptTimestamp(segment.start)}] ${segment.text}`,
      )
      .join("\n"),
    language: resolvedLanguage,
    source,
    sourceAttempt,
    // Never invent a manual/ASR kind. Panel can prove complete rows and
    // language without always proving which native track kind rendered.
    selectedTrack: selectedTrack || null,
    providerVariant,
    diagnostics,
    supadataEligible: false,
  };
}

function normalizePassiveCapture(payload) {
  const videoId = validYoutubeVideoId(payload?.videoId);
  const language = normalizeLanguageCode(payload?.language) || null;
  const trackKind = payload?.kind === "asr" ? "asr" : "manual";
  const status = Number(payload?.status);
  const body = typeof payload?.body === "string" ? payload.body : "";
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  if (
    !videoId ||
    !Number.isInteger(status) ||
    status < 200 ||
    status >= 300 ||
    !bodyBytes ||
    bodyBytes > YOUTUBE_PASSIVE_MAX_BODY_BYTES
  ) {
    return null;
  }
  const trimmed = body.trimStart();
  const requestedFormat = String(payload?.format || "").toLowerCase();
  const transcript =
    requestedFormat === "json3" || trimmed.startsWith("{")
      ? parsePassiveJson3(body, language)
      : parsePassiveXml(body, language);
  const result = buildYoutubeTranscriptResult(transcript, {
    source: "youtube-passive",
    sourceAttempt: "YOUTUBE_PASSIVE",
    language,
    selectedTrack: { language, kind: trackKind },
    providerVariant: "page-observed-timedtext",
    diagnostics: {
      providerInitiated: {
        youtubePlayer: 0,
        youtubeTimedtext: 0,
        thirdParty: 0,
        loopback: 0,
      },
      pageObserved: { youtubeTimedtext: 1 },
      status,
      format:
        requestedFormat || (trimmed.startsWith("{") ? "json3" : "xml"),
      bodyBytes,
      trackKind,
    },
  });
  return result ? { result, videoId, language, trackKind } : null;
}

async function readYoutubePassiveEntries() {
  try {
    const stored = await chrome.storage?.session?.get?.(
      YOUTUBE_PASSIVE_SESSION_STORAGE_KEY,
    );
    const value = stored?.[YOUTUBE_PASSIVE_SESSION_STORAGE_KEY];
    return Array.isArray(value) ? value : [];
  } catch (_error) {
    return [];
  }
}

async function writeYoutubePassiveEntries(entries) {
  const bounded = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && Number.isInteger(entry.tabId))
    .sort((left, right) => Number(left.updatedAt) - Number(right.updatedAt));
  while (
    bounded.length > YOUTUBE_PASSIVE_MAX_ENTRIES ||
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength >
      YOUTUBE_PASSIVE_MAX_STATE_BYTES
  ) {
    bounded.shift();
  }
  await chrome.storage?.session?.set?.({
    [YOUTUBE_PASSIVE_SESSION_STORAGE_KEY]: bounded,
  });
  return bounded;
}

function queueYoutubePassiveMutation(operation) {
  const task = youtubePassiveMutationQueue.then(operation, operation);
  youtubePassiveMutationQueue = task.catch(() => {});
  return task;
}

function notifyYoutubePassiveWaiters() {
  youtubePassiveRevision += 1;
  for (const resolve of [...youtubePassiveWaiters]) resolve();
  youtubePassiveWaiters.clear();
}

function waitForYoutubePassiveChange(maxWaitMs, observedRevision) {
  return new Promise((resolve) => {
    let timeoutId;
    const done = () => {
      clearTimeout(timeoutId);
      youtubePassiveWaiters.delete(done);
      resolve();
    };
    if (youtubePassiveRevision !== observedRevision) {
      done();
      return;
    }
    youtubePassiveWaiters.add(done);
    timeoutId = setTimeout(done, maxWaitMs);
  });
}

async function handleYoutubePassiveState(payload, sender) {
  const type = String(payload?.type || "");
  const tabId = sender?.tab?.id;
  const videoId = validYoutubeVideoId(payload?.videoId);
  const language = normalizeLanguageCode(payload?.language) || null;
  const trackKind = payload?.kind === "asr" ? "asr" : "manual";
  if (
    !Number.isInteger(tabId) ||
    !videoId ||
    !["inflight", "capture", "clear"].includes(type)
  ) {
    return { ok: false, error: "INVALID_PASSIVE_STATE" };
  }
  // A stale SPA identity is allowed to clear only its exact old entry. It may
  // never create or replace a capture for the tab's newly active video.
  if (type !== "clear" && !(await youtubeTabStillMatches(tabId, videoId))) {
    return { ok: false, error: "PAGE_CONTEXT_CHANGED" };
  }

  return queueYoutubePassiveMutation(async () => {
    const entries = await readYoutubePassiveEntries();
    const identity = passiveIdentity(tabId, videoId, language, trackKind);
    const previous = entries.find((entry) => entry.identity === identity);
    let next = entries.filter((entry) => entry.identity !== identity);
    const observedStatus = Number(payload?.status);
    if (
      (type === "capture" || type === "clear") &&
      observedStatus === 429 &&
      previous
    ) {
      await writeYoutubePassiveEntries(next);
      await startYoutubeNativeCooldown();
      notifyYoutubePassiveWaiters();
      return { ok: true, state: "rate-limited" };
    }
    if (type === "inflight") {
      next.push({
        identity,
        tabId,
        videoId,
        language,
        trackKind,
        state: "inflight",
        inFlight: true,
        updatedAt: Date.now(),
      });
    } else if (type === "capture") {
      if (
        !previous ||
        !(
          previous.state === "inflight" ||
          (previous.state === "capture" && previous.inFlight === true)
        )
      ) {
        return { ok: false, error: "PASSIVE_CAPTURE_NOT_INFLIGHT" };
      }
      const capture = normalizePassiveCapture(payload);
      if (!capture || capture.videoId !== videoId) {
        return { ok: false, error: "INVALID_PASSIVE_CAPTURE" };
      }
      next.push({
        identity,
        tabId,
        videoId,
        language: capture.language,
        trackKind: capture.trackKind,
        state: "capture",
        inFlight:
          payload?.inFlight === true || Number(payload?.inFlight) > 0,
        capture: capture.result,
        updatedAt: Date.now(),
      });
    }
    const stored = await writeYoutubePassiveEntries(next);
    notifyYoutubePassiveWaiters();
    if (type === "clear") return { ok: true, cleared: true };
    const retained = stored.some((entry) => entry.identity === identity);
    return retained
      ? { ok: true, state: type }
      : { ok: false, error: "PASSIVE_CAPTURE_TOO_LARGE" };
  });
}

async function clearYoutubePassiveTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  return queueYoutubePassiveMutation(async () => {
    const entries = await readYoutubePassiveEntries();
    const next = entries.filter((entry) => entry.tabId !== tabId);
    if (next.length !== entries.length) {
      await writeYoutubePassiveEntries(next);
      notifyYoutubePassiveWaiters();
    }
  });
}

function passiveEntryMatches(entry, request) {
  if (
    entry?.tabId !== request.tabId ||
    entry?.videoId !== request.videoId
  ) {
    return false;
  }
  const requestedLanguage = youtubePrimaryLanguage(request.preferredLanguage);
  const entryLanguage = youtubePrimaryLanguage(entry.language);
  if (requestedLanguage && requestedLanguage !== entryLanguage) return false;
  const requestedKind = normalizeYoutubeTrackKind(request.trackKind);
  if (requestedKind === "manual" && entry.trackKind !== "manual") return false;
  if (requestedKind === "asr" && entry.trackKind !== "asr") return false;
  return true;
}

async function readYoutubePassiveGate(request) {
  await youtubePassiveMutationQueue.catch(() => {});
  const entries = (await readYoutubePassiveEntries())
    .filter((entry) => passiveEntryMatches(entry, request))
    .sort((left, right) => {
      const requestedLanguage = normalizeLanguageCode(
        request.preferredLanguage,
      );
      const exactLanguageRank = (entry) =>
        requestedLanguage &&
        normalizeLanguageCode(entry.language) !== requestedLanguage
          ? 1
          : 0;
      const manualRank = (entry) =>
        normalizeYoutubeTrackKind(request.trackKind) === "manual-first" &&
        entry.trackKind !== "manual"
          ? 1
          : 0;
      return (
        exactLanguageRank(left) - exactLanguageRank(right) ||
        manualRank(left) - manualRank(right) ||
        Number(right.updatedAt) - Number(left.updatedAt)
      );
    });
  const capture = entries.find(
    (entry) => entry.state === "capture" && entry.capture?.success === true,
  );
  return {
    capture: capture?.capture || null,
    inFlight: entries.some(
      (entry) =>
        entry.state === "inflight" ||
        (entry.state === "capture" && entry.inFlight === true),
    ),
  };
}

async function awaitYoutubePassiveGate(request) {
  const startedAt = Date.now();
  let gate = await readYoutubePassiveGate(request);
  if (gate.capture || !gate.inFlight) return gate.capture;
  while (gate.inFlight) {
    const remaining = YOUTUBE_PASSIVE_WAIT_MS - (Date.now() - startedAt);
    if (remaining <= 0) return null;
    const observedRevision = youtubePassiveRevision;
    // Re-read before sleeping: if a capture arrived between the previous read
    // and waiter registration, the revision check resolves immediately.
    gate = await readYoutubePassiveGate(request);
    if (gate.capture || !gate.inFlight) return gate.capture;
    await waitForYoutubePassiveChange(remaining, observedRevision);
    gate = await readYoutubePassiveGate(request);
    if (gate.capture) return gate.capture;
  }
  return null;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel action while per-tab options keep it on supported videos.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const SUPPORTED_VIDEO_TAB_PATTERNS = [
  "https://www.youtube.com/*",
  "https://www.bilibili.com/video/BV*",
];

function isYouTubeVideoUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "www.youtube.com" &&
      parsed.pathname === "/watch" &&
      parsed.searchParams.has("v")
    );
  } catch {
    return false;
  }
}

function youtubeVideoIdFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!isYouTubeVideoUrl(parsed.href)) return "";
    return String(parsed.searchParams.get("v") || "").trim();
  } catch {
    return "";
  }
}

function effectiveTabUrl(tab) {
  return String(tab?.pendingUrl || tab?.url || "");
}

function contentVideoInfoHasCompletenessContract(info) {
  return (
    typeof info?.descriptionTruncated === "boolean" &&
    ["present", "confirmed-empty", "unknown"].includes(info?.descriptionStatus)
  );
}

function mergeYouTubeVideoInfo(playerInfo, contentInfo, expectedVideoId) {
  const expectedId = String(expectedVideoId || "").trim();
  const playerId = String(playerInfo?.videoId || "").trim();
  const contentId = String(contentInfo?.videoId || "").trim();
  const playerMatches = !!playerInfo && !!expectedId && playerId === expectedId;
  const contentMatches = !!contentInfo && !!expectedId && contentId === expectedId;
  if (!playerMatches && !contentMatches) return null;

  const player = playerMatches ? playerInfo : null;
  const content = contentMatches ? contentInfo : {};
  const playerDescriptionIsExact =
    player && ["present", "confirmed-empty"].includes(player.descriptionStatus);
  const contentHasCompletenessContract =
    contentVideoInfoHasCompletenessContract(content);
  const contentDescriptionStatus = contentHasCompletenessContract
    ? content.descriptionStatus
    : "unknown";

  return {
    ...content,
    videoId: expectedId,
    title: player?.title || content.title || "",
    channelName: player?.channelName || content.channelName || "",
    duration: player?.duration || content.duration || 0,
    sourceLanguage: player?.sourceLanguage || content.sourceLanguage || "",
    description: playerDescriptionIsExact
      ? String(player.description || "")
      : String(content.description || ""),
    descriptionStatus: playerDescriptionIsExact
      ? player.descriptionStatus
      : contentDescriptionStatus,
    descriptionTruncated: playerDescriptionIsExact
      ? false
      : contentHasCompletenessContract
        ? content.descriptionTruncated === true
        : true,
  };
}

function youtubeVideoInfoIsComplete(info) {
  return (
    !!String(info?.videoId || "").trim() &&
    !!String(info?.title || "").trim() &&
    !!String(info?.channelName || "").trim() &&
    ["present", "confirmed-empty"].includes(info?.descriptionStatus) &&
    info?.descriptionTruncated !== true
  );
}

function isBilibiliVideoUrl(url) {
  try {
    if (!globalThis.BILIBILI_ADAPTER) return false;
    BILIBILI_ADAPTER.parseBilibiliVideoUrl(url);
    return true;
  } catch {
    return false;
  }
}

function isSupportedVideoUrl(url) {
  return isYouTubeVideoUrl(url) || isBilibiliVideoUrl(url);
}

function youtubeMediaRef(videoId) {
  const canonicalUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
  return {
    platform: "youtube",
    videoId,
    mediaKey: videoId,
    canonicalUrl,
  };
}

function normalizeBilibiliMediaRef(mediaRef) {
  const bvid = String(mediaRef?.bvid || "").trim();
  const aid = Number(mediaRef?.aid);
  const cid = Number(mediaRef?.cid);
  const page = Number(mediaRef?.page || 1);
  if (
    !Number.isSafeInteger(aid) ||
    aid < 1 ||
    !Number.isSafeInteger(cid) ||
    cid < 1 ||
    !Number.isSafeInteger(page) ||
    page < 1
  ) {
    const error = new Error("B 站媒体引用缺少有效的 AID、CID 或分P。");
    error.code = "API";
    throw error;
  }
  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const title = safeString(mediaRef.title || mediaRef.metadata?.title, 500);
  const channelName = safeString(
    mediaRef.channelName || mediaRef.metadata?.channelName,
    300,
  );
  const rawDuration = Number(
    mediaRef.duration || mediaRef.metadata?.duration,
  );
  const rawDescription = safeString(
    mediaRef.description || mediaRef.metadata?.description,
    Number.MAX_SAFE_INTEGER,
  );
  const description = rawDescription.slice(0, 10_000);
  const metadata = {
    title,
    channelName,
    creator: safeString(
      mediaRef.creator || mediaRef.metadata?.creator || channelName,
      300,
    ),
    description,
    descriptionStatus: ["unknown", "confirmed-empty", "present"].includes(
      mediaRef.descriptionStatus || mediaRef.metadata?.descriptionStatus,
    )
      ? mediaRef.descriptionStatus || mediaRef.metadata?.descriptionStatus
      : "unknown",
    descriptionTruncated:
      mediaRef.descriptionTruncated === true ||
      mediaRef.metadata?.descriptionTruncated === true ||
      rawDescription.length > description.length,
    duration:
      Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0,
    partTitle: safeString(
      mediaRef.partTitle || mediaRef.metadata?.partTitle,
      500,
    ),
  };
  return {
    platform: "bilibili",
    bvid,
    aid,
    cid,
    page,
    mediaKey: `bilibili:${bvid}:${cid}`,
    canonicalUrl: BILIBILI_ADAPTER.canonicalVideoUrl(bvid, page),
    metadata,
    ...metadata,
  };
}

function bilibiliFailure(error) {
  return {
    success: false,
    error: error?.code || "BILIBILI_ERROR",
    message: error?.message || "读取 B 站视频失败。",
  };
}

async function resolveMediaRef(mediaInput, sourceUrl = "") {
  if (mediaInput && typeof mediaInput === "object") {
    if (mediaInput.platform === "bilibili") {
      if (mediaInput.bvid && mediaInput.aid && mediaInput.cid) {
        return normalizeBilibiliMediaRef(mediaInput);
      }
      const resolved = await BILIBILI_ADAPTER.resolveMedia(
        mediaInput.canonicalUrl || mediaInput.url || sourceUrl,
      );
      return normalizeBilibiliMediaRef(resolved);
    }
    if (mediaInput.platform === "youtube" && mediaInput.videoId) {
      return youtubeMediaRef(mediaInput.videoId);
    }
  }

  if (sourceUrl && isBilibiliVideoUrl(sourceUrl)) {
    return normalizeBilibiliMediaRef(
      await BILIBILI_ADAPTER.resolveMedia(sourceUrl),
    );
  }

  const videoId = String(mediaInput || "").trim();
  return youtubeMediaRef(videoId);
}

async function handleFetchMediaTranscript(
  mediaInput,
  preferredLanguage = "",
  tabId = null,
  supadataConsent = false,
  routeOptions = {},
) {
  try {
    const mediaRef = await resolveMediaRef(mediaInput);
    if (mediaRef.platform === "bilibili") {
      const result = await BILIBILI_ADAPTER.fetchTranscript(mediaRef);
      return {
        success: true,
        mediaRef,
        ...result,
        source: "bilibili",
        sourceAttempt: "BILIBILI",
      };
    }
    return handleFetchYoutubeTranscript(
      mediaRef.videoId,
      preferredLanguage,
      tabId,
      supadataConsent,
      routeOptions,
    );
  } catch (error) {
    const failure = {
      success: false,
      error: error?.code || "TRANSCRIPT_ERROR",
      message: error?.message || "读取视频字幕失败。",
    };
    const firstYoutubeMiss =
      mediaInput?.platform !== "bilibili" &&
      supadataConsent !== true &&
      routeOptions.captionRetry !== true;
    return mediaInput?.platform === "bilibili"
      ? failure
      : withYoutubeRouteIdentity(
          {
            ...failure,
            error: firstYoutubeMiss
              ? "YOUTUBE_CAPTIONS_REQUIRED"
              : failure.error,
            routeOutcome: "UNKNOWN",
            message: firstYoutubeMiss
              ? "DigestDock 尚未从当前页面读取到字幕。请打开 YouTube 字幕后重新读取。"
              : failure.message,
            requiresCaptionEnable: firstYoutubeMiss,
            supadataEligible:
              supadataConsent !== true && routeOptions.captionRetry === true,
          },
          youtubeRouteIdentity(routeOptions),
        );
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to supported video tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. We enable the panel on supported YouTube or Bilibili video
 * tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded unsupported tab.
 */
function updatePanelForTab(tabId, url) {
  const isSupported = isSupportedVideoUrl(url);
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: isSupported })
    .catch(() => {});
}

// A tab navigated to a new URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  bumpYoutubeTabNavigationEpoch(tabId);
  clearYoutubePassiveTab(tabId).catch(() => {});
  updatePanelForTab(tabId, changeInfo.url);
});

chrome.tabs.onRemoved?.addListener?.((tabId) => {
  youtubeTabNavigationEpochs.delete(tabId);
  clearYoutubePassiveTab(tabId).catch(() => {});
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, tab.pendingUrl || tab.url);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "youtubePassiveState") {
    handleYoutubePassiveState(message.payload, sender)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.code || "PASSIVE_STATE_FAILED").slice(0, 80),
        }),
      );
    return true;
  }

  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "resolveBilibiliMedia") {
    BILIBILI_ADAPTER.resolveMedia(message.url)
      .then((mediaRef) =>
        sendResponse({
          success: true,
          mediaRef: normalizeBilibiliMediaRef(mediaRef),
        }),
      )
      .catch((error) => sendResponse(bilibiliFailure(error)));
    return true;
  }

  if (message.action === "fetchTranscript") {
    const routeOptions = {
      runId: message.runId,
      digestGeneration: message.digestGeneration,
      routeKey: message.routeKey,
      trackKind: message.trackKind,
      captionRetry: message.captionRetry === true,
    };
    const youtubeRequest =
      (message.mediaRef?.platform || "youtube") === "youtube";
    handleFetchMediaTranscript(
      message.mediaRef || message.videoId,
      message.preferredLanguage,
      message.tabId ?? sender.tab?.id ?? null,
      message.supadataConsent === true,
      routeOptions,
    )
      .then(sendResponse)
      .catch((err) =>
        sendResponse(
          youtubeRequest
            ? withYoutubeRouteIdentity(
                {
                  success: false,
                  error:
                    message.supadataConsent !== true &&
                    routeOptions.captionRetry !== true
                      ? "YOUTUBE_CAPTIONS_REQUIRED"
                      : "TRANSCRIPT_ERROR",
                  routeOutcome: "UNKNOWN",
                  message:
                    message.supadataConsent !== true &&
                    routeOptions.captionRetry !== true
                      ? "DigestDock 尚未从当前页面读取到字幕。请打开 YouTube 字幕后重新读取。"
                      : String(err?.message || "读取字幕失败。").slice(0, 500),
                  requiresCaptionEnable:
                    message.supadataConsent !== true &&
                    routeOptions.captionRetry !== true,
                  supadataEligible:
                    message.supadataConsent !== true &&
                    routeOptions.captionRetry === true,
                },
                youtubeRouteIdentity(routeOptions),
              )
            : {
                success: false,
                error: err?.message || "读取字幕失败。",
              },
        ),
      );
    return true; // Keep the message channel open for async response
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
      message.sourceLanguage,
      message.platform,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "translateOverviewOriginal") {
    handleTranslateOverviewOriginal(
      message.analysis,
      message.videoTitle,
      message.targetLanguage,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "translateNotes") {
    handleTranslateNotes({ notes: message.notes, titles: message.titles })
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp
    handleSaveNote(
      message.mediaRef || message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.videoUrl || sender.tab?.url || "",
      message.tabId ?? sender.tab?.id ?? null,
      message.preferredLanguage || "",
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.mediaKey || message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "exportNotesBackup") {
    handleExportNotesBackup()
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, code: err.code || "NOTES_EXPORT_FAILED" }),
      );
    return true;
  }

  if (message.action === "importNotesBackup") {
    handleImportNotesBackup(message.backupText)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, code: err.code || "NOTES_IMPORT_FAILED" }),
      );
    return true;
  }

  if (message.action === "clearAllNotes") {
    handleClearAllNotes()
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, code: err.code || "NOTES_CLEAR_FAILED" }),
      );
    return true;
  }

  if (message.action === "resetAllExtensionData") {
    handleResetAllExtensionData(message.preferredLanguage)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, code: err.code || "RESET_DATA_FAILED" }),
      );
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // A user-confirmed export batch is translated and committed entirely in the
  // service worker. It does not depend on the side panel remaining open, and
  // it never accepts or returns provider credentials.
  if (message.action === "translateExportSourceBatch") {
    handleTranslateExportSourceBatch(message)
      .then(sendResponse)
      .catch((error) => sendResponse(exportSourceBatchFailure(error)));
    return true;
  }

  if (message.action === "translateExportNotesBatch") {
    handleTranslateExportNotesBatch(message)
      .then(sendResponse)
      .catch((error) => sendResponse(exportSourceBatchFailure(error)));
    return true;
  }

  if (message.action === "cancelExportTranslationJob") {
    handleCancelExportTranslationJob(message.jobId)
      .then(sendResponse)
      .catch((error) => sendResponse(exportSourceBatchFailure(error)));
    return true;
  }

  if (message.action === "getExportJob") {
    handleGetExportTranslationJob(message.jobId)
      .then(sendResponse)
      .catch((error) => sendResponse(exportSourceBatchFailure(error)));
    return true;
  }

  if (message.action === "listExportJobs") {
    handleListExportTranslationJobs()
      .then(sendResponse)
      .catch((error) => sendResponse(exportSourceBatchFailure(error)));
    return true;
  }

  if (message.action === "createOrResumeExportJob") {
    handleCreateOrResumeExportJob(message.job)
      .then(sendResponse)
      .catch((error) => sendResponse(exportSourceBatchFailure(error)));
    return true;
  }

  if (message.action === "checkpointExportJob") {
    handleCheckpointExportJob(message.jobId, message.patch)
      .then(sendResponse)
      .catch((error) => sendResponse(exportSourceBatchFailure(error)));
    return true;
  }

  if (
    message.action === "upsertNoteSource" ||
    message.action === "persistNoteSource"
  ) {
    handleUpsertNoteSource(message.source)
      .then(sendResponse)
      .catch((error) => sendResponse(exportSourceBatchFailure(error)));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) => {
        const provider = resolveActiveProvider(settings);
        const providerDescription = YTD_AI_PROVIDERS.describeProvider(
          provider?.id,
        );
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: YTD_SETTINGS.hasActiveApiKey(settings),
          // Provider identity and capabilities (never the key itself) so the
          // side panel can label the active service and gate unsupported
          // features without a second round trip.
          provider: providerDescription
            ? {
                ...providerDescription,
                modelId: provider?.model || "",
                routeKey: `${provider?.id || ""}:${provider?.model || ""}`,
              }
            : null,
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        });
      })
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[DigestDock BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[DigestDock BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[DigestDock BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[DigestDock BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        let tab = null;
        const hasExplicitTab = Number.isInteger(message.tabId);
        if (hasExplicitTab) {
          const requestedTab = await chrome.tabs.get(message.tabId).catch(() => null);
          const requestedUrl = effectiveTabUrl(requestedTab);
          if (!requestedTab || !isSupportedVideoUrl(requestedUrl)) {
            sendResponse({
              success: false,
              error: "PAGE_CONTEXT_CHANGED",
              message: "目标视频页面已关闭或已导航，请重新打开摘要。",
            });
            return;
          }
          tab = { ...requestedTab, url: requestedUrl };
        }

        let tabs = tab
          ? [tab]
          : await chrome.tabs.query({
              active: true,
              lastFocusedWindow: true,
            });
        debugLog(
          "[DigestDock BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        if (!tabs[0] || !isSupportedVideoUrl(effectiveTabUrl(tabs[0]))) {
          tabs = await chrome.tabs.query({
            url: SUPPORTED_VIDEO_TAB_PATTERNS,
            active: true,
          });
          debugLog("[DigestDock BG] Active supported tabs:", tabs.length);
        }

        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: SUPPORTED_VIDEO_TAB_PATTERNS });
          debugLog("[DigestDock BG] Any supported tabs:", tabs.length);
        }

        if (tabs[0]) {
          const targetUrl = effectiveTabUrl(tabs[0]);
          debugLog(
            "[DigestDock BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            targetUrl,
          );
          const isYouTubeInfoRequest =
            message.payload?.action === "getVideoInfo" &&
            isYouTubeVideoUrl(targetUrl);
          const expectedVideoId = isYouTubeInfoRequest
            ? youtubeVideoIdFromUrl(targetUrl)
            : "";
          let playerInfo = null;
          let response = null;

          // The MAIN-world player response is canonical and does not depend on
          // a content script having reached document_idle. This matters when a
          // note opens a brand-new YouTube tab and metadata capture begins while
          // the page is still committing. The exact videoId gate prevents stale
          // SPA player data from being written to the newly opened video.
          if (isYouTubeInfoRequest) {
            playerInfo = await getPlayerVideoDetails(tabs[0].id);
            const playerResponse = mergeYouTubeVideoInfo(
              playerInfo,
              null,
              expectedVideoId,
            );
            if (youtubeVideoInfoIsComplete(playerResponse)) {
              response = playerResponse;
            }
          }

          if (!response) {
            const contentResponse = await sendMessageToContentWithRecovery(
              tabs[0].id,
              message.payload,
              {},
              targetUrl,
            );
            if (isYouTubeInfoRequest) {
              const contentVideoId = String(
                contentResponse?.videoId || "",
              ).trim();
              if (contentVideoId && contentVideoId !== expectedVideoId) {
                const pageChangedError = new Error(
                  "YouTube 页面已切换，未读取其他视频的资料。",
                );
                pageChangedError.code = "PAGE_CONTEXT_CHANGED";
                throw pageChangedError;
              }
              const mergedResponse = mergeYouTubeVideoInfo(
                playerInfo,
                contentResponse,
                expectedVideoId,
              );
              if (!mergedResponse) {
                const relayError = new Error(
                  contentVideoId
                    ? "YouTube 页面已切换，未读取其他视频的资料。"
                    : "当前视频页尚未加载新版 DigestDock 内容脚本，请刷新页面后再补充。",
                );
                relayError.code = contentVideoId
                  ? "PAGE_CONTEXT_CHANGED"
                  : "PAGE_REFRESH_REQUIRED";
                throw relayError;
              }
              if (
                !youtubeVideoInfoIsComplete(mergedResponse) &&
                !contentVideoInfoHasCompletenessContract(contentResponse)
              ) {
                const refreshError = new Error(
                  "当前视频页尚未加载新版 DigestDock 内容脚本，请刷新页面后再补充。",
                );
                refreshError.code = "PAGE_REFRESH_REQUIRED";
                throw refreshError;
              }
              response = mergedResponse;
            } else {
              response = contentResponse;
            }
          }

          debugLog("[DigestDock BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[DigestDock BG] No supported video tab found");
          sendResponse({ success: false, error: "No supported video tab found" });
        }
      } catch (err) {
        if (isPageRefreshRequiredError(err)) {
          debugLog("[DigestDock BG] Page refresh required after reload");
          sendResponse({
            success: false,
            error: "PAGE_REFRESH_REQUIRED",
            message: err.message,
          });
        } else if (
          err?.code === "PAGE_CONTEXT_CHANGED" ||
          isTransientTabContextError(err)
        ) {
          debugLog("[DigestDock BG] Video tab context changed during relay");
          sendResponse({
            success: false,
            error: "PAGE_CONTEXT_CHANGED",
            message:
              err?.code === "PAGE_CONTEXT_CHANGED"
                ? err.message
                : "视频页面正在刷新，请稍后重试。",
          });
        } else {
          console.error("[DigestDock BG] Relay error:", err.message);
          sendResponse({ success: false, error: err.message });
        }
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const playerResponse =
            player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
          const details = playerResponse?.videoDetails;
          if (!details) return null;
          const videoId = String(details.videoId || "").trim();
          if (!videoId) return null;
          const hasDescription = Object.prototype.hasOwnProperty.call(
            details,
            "shortDescription",
          );
          const description = hasDescription
            ? String(details.shortDescription || "")
            : "";
          const captionRenderer =
            playerResponse?.captions?.playerCaptionsTracklistRenderer;
          const captionTracks = Array.isArray(captionRenderer?.captionTracks)
            ? captionRenderer.captionTracks
            : [];
          const audioTracks = Array.isArray(captionRenderer?.audioTracks)
            ? captionRenderer.audioTracks
            : [];
          const defaultAudioTrack =
            audioTracks[captionRenderer?.defaultAudioTrackIndex] ||
            audioTracks.find((track) => track?.hasDefaultTrack) ||
            audioTracks[0];
          const defaultCaptionIndex =
            defaultAudioTrack?.defaultCaptionTrackIndex ??
            defaultAudioTrack?.captionTrackIndices?.[0];
          const defaultCaptionTrack =
            captionTracks[defaultCaptionIndex] ||
            null;
          return {
            videoId,
            title: details.title || "",
            channelName: details.author || "",
            description,
            descriptionStatus: hasDescription
              ? description
                ? "present"
                : "confirmed-empty"
              : "unknown",
            descriptionTruncated: false,
            duration: Number(details.lengthSeconds) || 0,
            sourceLanguage:
              details.defaultAudioLanguage ||
              playerResponse?.microformat?.playerMicroformatRenderer
                ?.defaultAudioLanguage ||
              defaultCaptionTrack?.languageCode ||
              "",
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[DigestDock BG] Player details unavailable:", e.message);
    return null;
  }
}

// YouTube caption work is owned by the background router. Passive observations
// are the only automatic free route. A miss asks the user to enable YouTube CC;
// only a user-driven retry may reveal the explicit-consent Supadata fallback.
// Active and Panel remain repository experiments and are not product routes.

/**
 * Read-only, no-network YouTube page gate. Runs in the page MAIN world to
 * confirm the tab still shows the exact video we are about to authorize, to
 * read the default audio language, playability status, and a text-free caption
 * track summary. It deliberately does NOT read caption-track request URLs;
 * those never enter the mainline. A current, playable, non-live player response
 * can confirm zero tracks without another YouTube request.
 */
async function readYouTubePlayabilitySnapshot(tabId, expectedVideoId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [expectedVideoId],
      func: (expectedId) => {
        try {
          const player = document.getElementById("movie_player");
          const livePlayerResponse = player?.getPlayerResponse?.() || null;
          const response =
            livePlayerResponse || window.ytInitialPlayerResponse;
          const actualVideoId = response?.videoDetails?.videoId || "";
          if (!actualVideoId) {
            return { ok: false, error: "PAGE_CONTEXT_UNAVAILABLE" };
          }
          if (actualVideoId !== expectedId) {
            return { ok: false, error: "PAGE_CONTEXT_CHANGED" };
          }
          const renderer =
            response?.captions?.playerCaptionsTracklistRenderer;
          const rawTracks = Array.isArray(renderer?.captionTracks)
            ? renderer.captionTracks
            : [];
          const audioTracks = Array.isArray(renderer?.audioTracks)
            ? renderer.audioTracks
            : [];
          const defaultAudio =
            audioTracks[renderer?.defaultAudioTrackIndex] ||
            audioTracks.find((track) => track?.hasDefaultTrack) ||
            audioTracks[0];
          const defaultCaptionIndex =
            defaultAudio?.defaultCaptionTrackIndex ??
            defaultAudio?.captionTrackIndices?.[0];
          const defaultCaptionTrack =
            rawTracks[defaultCaptionIndex] ||
            rawTracks.find((track) => track?.isDefault === true) ||
            (rawTracks.length === 1 ? rawTracks[0] : null);
          const playability = String(
            response?.playabilityStatus?.status || "",
          ).slice(0, 80);
          const captionTrackCountKnown =
            Boolean(livePlayerResponse) &&
            playability === "OK" &&
            response?.videoDetails?.isLiveContent === false &&
            (!renderer || Array.isArray(renderer?.captionTracks));
          const defaultTrackLanguage = String(
            defaultCaptionTrack?.languageCode || "",
          )
            .trim()
            .replace(/_/g, "-")
            .slice(0, 35);
          const defaultTrackKind =
            defaultCaptionTrack?.kind === "asr" ||
            /^a\./i.test(String(defaultCaptionTrack?.vssId || ""))
              ? "asr"
              : "manual";
          // Only the language code, never a signed caption request URL.
          const sourceLanguage =
            response?.videoDetails?.defaultAudioLanguage ||
            response?.microformat?.playerMicroformatRenderer
              ?.defaultAudioLanguage ||
            defaultCaptionTrack?.languageCode ||
            "";
          return {
            ok: true,
            videoId: actualVideoId,
            playability,
            playabilityReason: String(
              response?.playabilityStatus?.reason || "",
            ).slice(0, 200),
            sourceLanguage: String(sourceLanguage || "").slice(0, 35),
            captionTrackCountKnown,
            captionTrackCount: captionTrackCountKnown
              ? rawTracks.length
              : null,
            pageDefaultTrack:
              captionTrackCountKnown &&
              rawTracks.length > 0 &&
              defaultTrackLanguage
                ? {
                    language: defaultTrackLanguage,
                    kind: defaultTrackKind,
                  }
                : null,
          };
        } catch (_error) {
          return { ok: false, error: "PAGE_CONTEXT_UNAVAILABLE" };
        }
      },
    });
    const snapshot = results?.[0]?.result || null;
    if (snapshot?.error === "PAGE_CONTEXT_CHANGED") {
      const error = new Error("YouTube 页面已切换到其他视频，请重试。");
      error.code = "PAGE_CONTEXT_CHANGED";
      throw error;
    }
    return snapshot?.ok ? snapshot : null;
  } catch (error) {
    if (error?.code === "PAGE_CONTEXT_CHANGED") throw error;
    debugLog(
      "[DigestDock] Page playability snapshot unavailable:",
      error?.message,
    );
    return null;
  }
}

function normalizeYoutubePageCaptionEvidence(snapshot) {
  if (snapshot?.captionTrackCountKnown !== true) return null;
  const captionTrackCount = Number(snapshot.captionTrackCount);
  if (
    !Number.isSafeInteger(captionTrackCount) ||
    captionTrackCount < 0 ||
    captionTrackCount > 100
  ) {
    return null;
  }
  const language = normalizeLanguageCode(snapshot?.pageDefaultTrack?.language);
  const kind = snapshot?.pageDefaultTrack?.kind;
  const selectedTrack =
    captionTrackCount > 0 &&
    language &&
    (kind === "manual" || kind === "asr")
      ? { language, kind }
      : null;
  return {
    captionTrackCountKnown: true,
    captionTrackCount,
    selectedTrack,
  };
}

/**
 * Classify a YouTube playabilityStatus into a terminal caption-source decision.
 * Clear login, age, members-only, region, and unavailable states are terminal:
 * the mainline returns a stable error and never sends the video to Supadata.
 * Anything else (including a normal "OK" or an unknown status) is allowed to
 * proceed to the authorized provider.
 */
function classifyYouTubePlayability(status, reason = "") {
  const normalized = String(status || "").toUpperCase();
  const haystack = `${normalized} ${String(reason || "").toUpperCase()}`;
  if (!normalized || normalized === "OK") return null;
  if (
    normalized === "LOGIN_REQUIRED" ||
    normalized === "AGE_CHECK_REQUIRED" ||
    normalized === "AGE_VERIFICATION_REQUIRED" ||
    normalized === "CONTENT_CHECK_REQUIRED" ||
    /\bAGE\b|SIGN IN|LOG IN|MEMBER|MEMBERS-ONLY|CONFIRM YOUR AGE/.test(haystack)
  ) {
    return "LOGIN_REQUIRED";
  }
  if (
    normalized === "UNPLAYABLE" ||
    normalized === "ERROR" ||
    normalized === "LIVE_STREAM_OFFLINE"
  ) {
    return "VIDEO_UNAVAILABLE";
  }
  // Unknown, non-OK statuses are not treated as terminal here; the mode=native
  // provider makes the final call so a transient status never hides captions.
  return null;
}

async function youtubeTabStillMatches(tabId, expectedVideoId) {
  // Paid/side-effecting routes must never treat missing tab identity as a
  // match. Callers that intentionally do not have a tab do not use this gate.
  if (!Number.isInteger(tabId)) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    // During navigation Chrome can expose the old committed URL together with
    // the new pending target. Prefer the pending target so a consent granted
    // for the old video cannot start a third-party request after the user has
    // already left that page.
    const url = new URL(String(tab?.pendingUrl || tab?.url || ""));
    return (
      url.protocol === "https:" &&
      url.hostname === "www.youtube.com" &&
      url.pathname === "/watch" &&
      url.searchParams.get("v") === expectedVideoId
    );
  } catch (_error) {
    return false;
  }
}

function pageContextChangedResult() {
  return {
    success: false,
    error: "PAGE_CONTEXT_CHANGED",
    message: "YouTube 页面已切换到其他视频，请重试。",
  };
}

/**
 * Explicit-consent Supadata fallback.
 *
 * Order: read-only page gate (identity + playability) -> terminal restriction
 * check -> Supadata key check -> strict per-attempt consent check -> bounded
 * Supadata rate-limit cooldown -> single-flighted Supadata provider request.
 * The free native route is intentionally not run from this function.
 */
async function handleFetchYoutubeSupadataTranscript(
  videoId,
  preferredLanguage = "",
  tabId = null,
  supadataConsent = false,
) {
  // Read-only, no-network page gate. Binds the current tab to this exact video
  // so an SPA navigation cannot send an old video to Supadata, and surfaces
  // clear login/age/members/unavailable states before any provider request.
  let snapshot = null;
  try {
    snapshot = await readYouTubePlayabilitySnapshot(tabId, videoId);
  } catch (error) {
    if (error?.code === "PAGE_CONTEXT_CHANGED") {
      return pageContextChangedResult();
    }
  }

  const terminalPlayabilityMessages = {
    LOGIN_REQUIRED:
      "此视频需要登录、年龄验证或其他访问权限，DigestDock 不会把它发送给 Supadata。",
    VIDEO_UNAVAILABLE:
      "此视频当前不可用，DigestDock 不会把它发送给 Supadata。",
  };
  const terminalCode = snapshot
    ? classifyYouTubePlayability(
        snapshot.playability,
        snapshot.playabilityReason,
      )
    : null;
  if (terminalCode && Object.hasOwn(terminalPlayabilityMessages, terminalCode)) {
    return {
      success: false,
      error: terminalCode,
      message: terminalPlayabilityMessages[terminalCode],
      supadataEligible: false,
    };
  }

  const requestedLanguage =
    normalizeLanguageCode(preferredLanguage) ||
    normalizeLanguageCode(snapshot?.sourceLanguage);

  const settings = await getSettings();
  if (!settings.supadataApiKey) {
    return {
      success: false,
      error: "SUPADATA_NOT_CONFIGURED",
      message:
        "Supadata 后备尚未配置。请在免费路线最终失败后，从侧栏入口配置密钥并逐视频授权。",
    };
  }

  // A saved key is not consent. Only the explicit side-panel authorization for
  // this attempt sets supadataConsent to the strict boolean true. Note saves,
  // page loads, navigation, and error retries keep the default false and can
  // never silently spend a Supadata credit.
  if (supadataConsent !== true) {
    return {
      success: false,
      error: "SUPADATA_CONSENT_REQUIRED",
      message:
        "此视频将通过 Supadata 获取 YouTube 原生字幕。请在侧栏本次授权后继续。",
    };
  }

  // Consent was granted for THIS video and tab. If the tab already moved on,
  // do not open a provider request for a video the user has left.
  if (!(await youtubeTabStillMatches(tabId, videoId))) {
    return pageContextChangedResult();
  }

  // A prior Supadata 429 puts the provider in a bounded cooldown. Refuse to
  // start another request until it clears; this keeps the network-call count
  // flat and never confuses the user with a YouTube rate-limit message.
  const cooldownUntil = await readYoutubeSupadataCooldownUntil();
  if (Date.now() < cooldownUntil) {
    return {
      success: false,
      error: "RATE_LIMITED",
      message:
        "Supadata 刚刚返回了速率限制，正在冷却，请稍后再授权重试。这是 Supadata 的限流，并非 YouTube。",
    };
  }

  // Collapse duplicate authorized requests (init, button, page-complete,
  // multi-window) for the same tab+video+language into one provider call.
  const flightKey = `${Number.isInteger(tabId) ? tabId : "no-tab"}::${videoId}::${requestedLanguage}`;
  const result = await runYoutubeSupadataSingleFlight(flightKey, () =>
    handleFetchTranscript(videoId, requestedLanguage, () =>
      youtubeTabStillMatches(tabId, videoId),
    ),
  );

  // Preserve a provider 429 even if the user navigated at the same moment.
  // The stale caller still receives PAGE_CONTEXT_CHANGED below, but the
  // provider cooldown must prevent another paid request from starting.
  if (result?.error === "RATE_LIMITED") {
    await startYoutubeSupadataCooldown();
  }

  // Supadata (or its async job polling) can outlast a YouTube SPA navigation.
  // Never accept an old video's result for the tab's new page.
  if (!(await youtubeTabStillMatches(tabId, videoId))) {
    return pageContextChangedResult();
  }

  if (result.success) {
    return {
      ...result,
      source: "supadata",
      sourceAttempt: "SUPADATA",
      selectedTrack: null,
    };
  }

  return result;
}

function youtubeRouteIdentity(options = {}) {
  const generation = options.digestGeneration;
  const runId = String(
    options.runId ??
      (generation === undefined || generation === null ? "" : generation),
  ).slice(0, 120);
  return {
    runId,
    routeKey: String(options.routeKey || "").slice(0, 2_000),
    trackKind: normalizeYoutubeTrackKind(options.trackKind),
  };
}

function withYoutubeRouteIdentity(result, routeIdentity) {
  return {
    ...result,
    runId: routeIdentity.runId,
    routeKey: routeIdentity.routeKey,
  };
}

function youtubeNativeErrorCode(result) {
  return String(
    result?.error || result?.errorCode || result?.code || "UNKNOWN",
  )
    .trim()
    .slice(0, 80);
}

function youtubeNativeDiagnostics(result, route) {
  const providerInitiated =
    result?.diagnostics?.providerInitiated ||
    result?.providerInitiated ||
    result?.requestCounts ||
    null;
  return {
    route,
    providerVariant: String(result?.providerVariant || "").slice(0, 80) || null,
    providerInitiated,
    sawTracks:
      result?.sawTracks === true ||
      result?.diagnostics?.sawTracks === true ||
      Boolean(result?.selectedTrack) ||
      (Array.isArray(result?.diagnostics?.attempts) &&
        result.diagnostics.attempts.some(
          (attempt) => Number(attempt?.trackCount) > 0,
        )) ||
      Number(result?.availableTrackCount) > 0,
    complete:
      result?.complete === true || result?.diagnostics?.complete === true,
  };
}

function youtubePanelRows(result) {
  const rows = Array.isArray(result?.transcript)
    ? result.transcript
    : Array.isArray(result?.rows)
      ? result.rows
      : [];
  return rows.map((row, index) => {
    const start = Number(row?.start);
    const nextStart = Number(rows[index + 1]?.start);
    const suppliedDuration = Number(row?.duration);
    return {
      text: row?.text,
      start,
      duration: Number.isFinite(suppliedDuration)
        ? suppliedDuration
        : Number.isFinite(nextStart) && nextStart >= start
          ? nextStart - start
          : 0,
      language: row?.language || result?.language,
    };
  });
}

function normalizeYoutubeNativeProviderResult(result, route) {
  const error = youtubeNativeErrorCode(result);
  const diagnostics = youtubeNativeDiagnostics(result, route);
  const transcript = youtubePanelRows(result);
  const selectedTrack = result?.selectedTrack
    ? {
        language:
          normalizeLanguageCode(result.selectedTrack.language) || null,
        kind: result.selectedTrack.kind === "asr" ? "asr" : "manual",
      }
    : null;
  if (
    (result?.success === true ||
      result?.ok === true ||
      result?.status === "HAVE_TRANSCRIPT") &&
    transcript.length > 0
  ) {
    const success = buildYoutubeTranscriptResult(transcript, {
      source: route === "active" ? "youtube-active" : "youtube-panel",
      sourceAttempt:
        route === "active" ? "YOUTUBE_ACTIVE" : "YOUTUBE_PANEL",
      language: result?.language || selectedTrack?.language,
      selectedTrack,
      providerVariant:
        result?.providerVariant ||
        (route === "active" ? "isolated-tab" : "automatic-panel"),
      diagnostics,
    });
    if (success) return success;
  }

  if (
    result?.routeOutcome === "PAGE_CONTEXT_CHANGED" ||
    result?.status === "PAGE_CONTEXT_CHANGED" ||
    error === "PAGE_CONTEXT_CHANGED"
  ) {
    return {
      ...pageContextChangedResult(),
      routeOutcome: "PAGE_CONTEXT_CHANGED",
      sourceAttempt:
        route === "active" ? "YOUTUBE_ACTIVE" : "YOUTUBE_PANEL",
      selectedTrack,
      diagnostics,
      supadataEligible: false,
    };
  }
  if (
    result?.routeOutcome === "RATE_LIMITED" ||
    result?.status === "RATE_LIMITED" ||
    error === "RATE_LIMITED"
  ) {
    return {
      success: false,
      error: "RATE_LIMITED",
      routeOutcome: "RATE_LIMITED",
      message:
        "YouTube 原生字幕请求受到速率限制，本次不会继续尝试页面后备。",
      sourceAttempt:
        route === "active" ? "YOUTUBE_ACTIVE" : "YOUTUBE_PANEL",
      selectedTrack,
      diagnostics,
      supadataEligible: true,
    };
  }
  const confirmedUnavailable = new Set([
    "NO_TRANSCRIPT",
    "TRACK_UNAVAILABLE",
    "LOGIN_REQUIRED",
    "AGE_CHECK_REQUIRED",
    "AGE_VERIFICATION_REQUIRED",
    "CONTENT_CHECK_REQUIRED",
    "MEMBERS_ONLY",
    "REGION_BLOCKED",
    "VIDEO_UNAVAILABLE",
    "UNPLAYABLE",
  ]);
  if (
    result?.routeOutcome === "CONFIRMED_UNAVAILABLE" ||
    result?.status === "CONFIRMED_UNAVAILABLE" ||
    confirmedUnavailable.has(error)
  ) {
    return {
      success: false,
      error,
      routeOutcome: "CONFIRMED_UNAVAILABLE",
      message: String(
        result?.message ||
          (error === "TRACK_UNAVAILABLE"
            ? "当前视频没有符合所选语言和字幕类型的轨道。"
            : "当前视频没有可用字幕，或需要额外访问权限。"),
      ).slice(0, 500),
      sourceAttempt:
        route === "active" ? "YOUTUBE_ACTIVE" : "YOUTUBE_PANEL",
      selectedTrack,
      diagnostics,
      supadataEligible: false,
    };
  }
  return {
    success: false,
    error,
    routeOutcome: "UNKNOWN",
    message: String(result?.message || "暂时无法取得 YouTube 字幕。").slice(
      0,
      500,
    ),
    sourceAttempt:
      route === "active" ? "YOUTUBE_ACTIVE" : "YOUTUBE_PANEL",
    selectedTrack,
    diagnostics,
    supadataEligible: true,
  };
}

async function runYoutubeProductModule(
  tabId,
  file,
  globalName,
  request,
) {
  try {
    if (!(await youtubeTabStillMatches(tabId, request.videoId))) {
      return {
        success: false,
        error: "PAGE_CONTEXT_CHANGED",
        routeOutcome: "PAGE_CONTEXT_CHANGED",
      };
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: [file],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      args: [globalName, request],
      func: async (providerGlobalName, providerRequest) => {
        const provider = globalThis[providerGlobalName];
        if (!provider || typeof provider.run !== "function") {
          return {
            success: false,
            error: "PROVIDER_UNAVAILABLE",
            message: "YouTube transcript provider module is unavailable.",
          };
        }
        try {
          return await provider.run(providerRequest);
        } catch (error) {
          return {
            success: false,
            error: String(error?.code || "PROVIDER_FAILED").slice(0, 80),
            message: String(error?.message || "Provider failed.").slice(0, 500),
          };
        }
      },
    });
    const providerResult =
      results?.[0]?.result || {
        success: false,
        error: "INVALID_RESPONSE",
        message: "YouTube transcript provider returned no result.",
      };
    // A first observed 429 must survive a simultaneous navigation long enough
    // for the leader to write cooldown. The requester's stale-page result is
    // still rejected later by its independent tab/epoch check.
    if (
      providerResult?.status === "RATE_LIMITED" ||
      providerResult?.routeOutcome === "RATE_LIMITED" ||
      youtubeNativeErrorCode(providerResult) === "RATE_LIMITED"
    ) {
      return providerResult;
    }
    if (!(await youtubeTabStillMatches(tabId, request.videoId))) {
      return {
        success: false,
        error: "PAGE_CONTEXT_CHANGED",
        routeOutcome: "PAGE_CONTEXT_CHANGED",
      };
    }
    return providerResult;
  } catch (error) {
    if (!(await youtubeTabStillMatches(tabId, request.videoId))) {
      return {
        success: false,
        error: "PAGE_CONTEXT_CHANGED",
        routeOutcome: "PAGE_CONTEXT_CHANGED",
      };
    }
    return {
      success: false,
      error: "PROVIDER_UNAVAILABLE",
      message: String(error?.message || "Provider injection failed.").slice(
        0,
        500,
      ),
    };
  }
}

async function runYoutubeNativeRouteLeader(request) {
  const activeRaw = await runYoutubeProductModule(
    request.tabId,
    YOUTUBE_ACTIVE_PRODUCT_FILE,
    "DIGESTDOCK_YOUTUBE_ACTIVE",
    request,
  );
  const active = normalizeYoutubeNativeProviderResult(activeRaw, "active");
  if (active.routeOutcome === "RATE_LIMITED") {
    await startYoutubeNativeCooldown();
    return {
      ...active,
      routeOutcome: "UNKNOWN",
      skipPanel: true,
    };
  }
  if (active.routeOutcome !== "UNKNOWN") return active;

  const panelRaw = await runYoutubeProductModule(
    request.tabId,
    YOUTUBE_PANEL_PRODUCT_FILE,
    "DIGESTDOCK_YOUTUBE_PANEL",
    {
      ...request,
      eligibility: {
        activeFoundCaptionTrack:
          active.diagnostics?.sawTracks === true,
        captionTrackCount:
          request.pageCaptionEvidence?.captionTrackCount ?? null,
        selectedTrack:
          active.selectedTrack ||
          request.pageCaptionEvidence?.selectedTrack ||
          null,
        selectedTrackEvidence: active.selectedTrack
          ? "active"
          : request.pageCaptionEvidence?.selectedTrack
            ? "page-default"
            : null,
      },
    },
  );
  return normalizeYoutubeNativeProviderResult(panelRaw, "panel");
}

async function youtubeUnknownFallbackResult(nativeResult) {
  const settings = await getSettings();
  const hasSupadataKey = Boolean(settings.supadataApiKey);
  const nativeError = youtubeNativeErrorCode(nativeResult);
  if (nativeError === "RATE_LIMITED") {
    return {
      ...nativeResult,
      success: false,
      error: "RATE_LIMITED",
      routeOutcome: "UNKNOWN",
      supadataEligible: true,
      hasSupadataKey,
    };
  }
  return {
    ...nativeResult,
    success: false,
    error: hasSupadataKey
      ? "SUPADATA_CONSENT_REQUIRED"
      : "SUPADATA_NOT_CONFIGURED",
    nativeError,
    routeOutcome: "UNKNOWN",
    message: hasSupadataKey
      ? "免费字幕路线未能取得结果，可为当前视频选择使用 Supadata。"
      : "免费字幕路线未能取得结果；如需第三方后备，可先注册并配置 Supadata。",
    supadataEligible: true,
    hasSupadataKey,
  };
}

async function handleFetchYoutubeNativeTranscript(
  videoId,
  preferredLanguage,
  tabId,
  options = {},
) {
  const routeIdentity = youtubeRouteIdentity(options);
  const request = {
    videoId: validYoutubeVideoId(videoId),
    preferredLanguage: normalizeLanguageCode(preferredLanguage) || "",
    trackKind: routeIdentity.trackKind,
    tabId,
    runId: routeIdentity.runId,
  };
  request.language = request.preferredLanguage;
  if (!request.videoId || !Number.isInteger(tabId)) {
    return withYoutubeRouteIdentity(
      {
        success: false,
        error: "PAGE_CONTEXT_CHANGED",
        routeOutcome: "PAGE_CONTEXT_CHANGED",
        message: "当前 YouTube 页面不可用，请重新打开视频。",
        supadataEligible: false,
      },
      routeIdentity,
    );
  }
  const requestTabEpoch = youtubeTabNavigationEpoch(tabId);
  const requestStillCurrent = async () =>
    youtubeTabEpochStillMatches(tabId, requestTabEpoch) &&
    (await youtubeTabStillMatches(tabId, request.videoId));
  if (!(await requestStillCurrent())) {
    return withYoutubeRouteIdentity(
      {
        ...pageContextChangedResult(),
        routeOutcome: "PAGE_CONTEXT_CHANGED",
        supadataEligible: false,
      },
      routeIdentity,
    );
  }

  const passive = await awaitYoutubePassiveGate(request);
  if (!(await requestStillCurrent())) {
    return withYoutubeRouteIdentity(
      {
        ...pageContextChangedResult(),
        routeOutcome: "PAGE_CONTEXT_CHANGED",
        supadataEligible: false,
      },
      routeIdentity,
    );
  }
  if (passive?.success) {
    return withYoutubeRouteIdentity(passive, routeIdentity);
  }

  let pageCaptionEvidence = null;
  let pageSnapshot = null;
  try {
    pageSnapshot = await readYouTubePlayabilitySnapshot(
      tabId,
      request.videoId,
    );
    pageCaptionEvidence = normalizeYoutubePageCaptionEvidence(pageSnapshot);
  } catch (error) {
    if (error?.code === "PAGE_CONTEXT_CHANGED") {
      return withYoutubeRouteIdentity(
        {
          ...pageContextChangedResult(),
          routeOutcome: "PAGE_CONTEXT_CHANGED",
          supadataEligible: false,
        },
        routeIdentity,
      );
    }
  }
  if (!(await requestStillCurrent())) {
    return withYoutubeRouteIdentity(
      {
        ...pageContextChangedResult(),
        routeOutcome: "PAGE_CONTEXT_CHANGED",
        supadataEligible: false,
      },
      routeIdentity,
    );
  }
  const terminalPlayabilityMessages = {
    LOGIN_REQUIRED:
      "此视频需要登录、年龄验证或其他访问权限，DigestDock 不会继续获取字幕。",
    VIDEO_UNAVAILABLE: "此视频当前不可用，DigestDock 不会继续获取字幕。",
  };
  const terminalCode = pageSnapshot
    ? classifyYouTubePlayability(
        pageSnapshot.playability,
        pageSnapshot.playabilityReason,
      )
    : null;
  if (terminalCode && Object.hasOwn(terminalPlayabilityMessages, terminalCode)) {
    return withYoutubeRouteIdentity(
      {
        success: false,
        error: terminalCode,
        routeOutcome: "CONFIRMED_UNAVAILABLE",
        message: terminalPlayabilityMessages[terminalCode],
        sourceAttempt: "YOUTUBE_PAGE_GATE",
        selectedTrack: null,
        supadataEligible: false,
      },
      routeIdentity,
    );
  }
  if (
    pageCaptionEvidence?.captionTrackCountKnown === true &&
    pageCaptionEvidence.captionTrackCount === 0
  ) {
    return withYoutubeRouteIdentity(
      {
        success: false,
        error: "NO_TRANSCRIPT",
        routeOutcome: "CONFIRMED_UNAVAILABLE",
        message: "当前 YouTube 页面确认没有可用字幕轨。",
        sourceAttempt: "YOUTUBE_PAGE_GATE",
        selectedTrack: null,
        diagnostics: {
          providerInitiated: {
            youtubePlayer: 0,
            youtubeTimedtext: 0,
            thirdParty: 0,
            loopback: 0,
          },
          pageEvidence: {
            captionTrackCountKnown: true,
            captionTrackCount: 0,
          },
        },
        supadataEligible: false,
      },
      routeIdentity,
    );
  }
  request.pageCaptionEvidence = pageCaptionEvidence;

  const cooldownUntil = await readYoutubeNativeCooldownUntil();
  if (options.captionRetry === true && Date.now() < cooldownUntil) {
    return withYoutubeRouteIdentity(
      await youtubeUnknownFallbackResult({
        success: false,
        error: "RATE_LIMITED",
        routeOutcome: "UNKNOWN",
        skipPanel: true,
        message:
          "YouTube 原生字幕路线正在短暂冷却；本次不会自动重试。",
        sourceAttempt: "YOUTUBE_ACTIVE",
        supadataEligible: true,
      }),
      routeIdentity,
    );
  }

  // Product policy is deliberately simpler than the retained experiments:
  // cache/Passive is the only automatic free route. A first miss asks the user
  // to enable YouTube captions; only a user-driven retry may reveal Supadata.
  // The Active and Panel modules remain in the repository as experiment
  // evidence, but the shipping background never invokes them automatically.
  if (options.captionRetry !== true) {
    return withYoutubeRouteIdentity(
      {
        success: false,
        error: "YOUTUBE_CAPTIONS_REQUIRED",
        routeOutcome: "UNKNOWN",
        message:
          "DigestDock 尚未从当前页面读取到字幕。请打开 YouTube 字幕后重新读取。",
        sourceAttempt: "YOUTUBE_PASSIVE",
        requiresCaptionEnable: true,
        supadataEligible: false,
        diagnostics: {
          providerInitiated: {
            youtubePlayer: 0,
            youtubeTimedtext: 0,
            thirdParty: 0,
            loopback: 0,
          },
        },
      },
      routeIdentity,
    );
  }

  return withYoutubeRouteIdentity(
    await youtubeUnknownFallbackResult({
      success: false,
      error: "YOUTUBE_CAPTIONS_STILL_UNAVAILABLE",
      routeOutcome: "UNKNOWN",
      message:
        "打开 YouTube 字幕后仍未读取到字幕；如有需要，可选择 Supadata 第三方后备。",
      sourceAttempt: "YOUTUBE_PASSIVE_RETRY",
      supadataEligible: true,
    }),
    routeIdentity,
  );
}

function classifySupadataRouteOutcome(result) {
  if (result?.success === true) return "HAVE_TRANSCRIPT";
  const error = youtubeNativeErrorCode(result);
  if (error === "PAGE_CONTEXT_CHANGED") return "PAGE_CONTEXT_CHANGED";
  if (
    [
      "NO_TRANSCRIPT",
      "TRACK_UNAVAILABLE",
      "LOGIN_REQUIRED",
      "VIDEO_UNAVAILABLE",
    ].includes(error)
  ) {
    return "CONFIRMED_UNAVAILABLE";
  }
  return "UNKNOWN";
}

async function handleFetchYoutubeTranscript(
  videoId,
  preferredLanguage = "",
  tabId = null,
  supadataConsent = false,
  options = {},
) {
  const routeIdentity = youtubeRouteIdentity(options);
  if (supadataConsent === true) {
    const result = await handleFetchYoutubeSupadataTranscript(
      videoId,
      preferredLanguage,
      tabId,
      true,
    );
    return withYoutubeRouteIdentity(
      {
        ...result,
        routeOutcome: classifySupadataRouteOutcome(result),
        supadataEligible:
          classifySupadataRouteOutcome(result) === "UNKNOWN",
      },
      routeIdentity,
    );
  }

  // Unscoped legacy/background callers (for example note-save cache misses)
  // must not silently start Active or Panel. A real DigestDock transcript task
  // always carries the side panel's runId/digestGeneration.
  if (!routeIdentity.runId) {
    return handleFetchYoutubeSupadataTranscript(
      videoId,
      preferredLanguage,
      tabId,
      false,
    );
  }
  return handleFetchYoutubeNativeTranscript(
    videoId,
    preferredLanguage,
    tabId,
    options,
  );
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

/**
 * Reads a response body with a hard byte cap so an oversized or malformed
 * reply cannot exhaust the worker. Streams when a ReadableStream is available;
 * otherwise falls back to text() (or a test double's json()). Throws a coded
 * RESPONSE_TOO_LARGE error when the cap is exceeded. The raw body is never
 * logged.
 */
async function readBoundedResponseText(response, maxBytes) {
  const tooLarge = () => {
    const error = new Error("Supadata response exceeded the size limit.");
    error.code = "RESPONSE_TOO_LARGE";
    return error;
  };
  if (response?.body?.getReader && typeof TextDecoder === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock?.();
    }
    return text;
  }
  if (typeof response?.text === "function") {
    const text = await response.text();
    const bytes =
      typeof TextEncoder === "function"
        ? new TextEncoder().encode(text).byteLength
        : String(text).length;
    if (bytes > maxBytes) throw tooLarge();
    return text;
  }
  if (typeof response?.json === "function") {
    // Test doubles and minimal responses only expose json(). There is no raw
    // body to cap here; production responses always go through the paths above.
    return JSON.stringify(await response.json());
  }
  return "";
}

/**
 * Performs one bounded Supadata GET: hard timeout via AbortController, response
 * size cap, and tolerant JSON parsing. Returns { ok, status, data } where data
 * is null when the body is absent or not valid JSON. Throws a coded error
 * (TIMEOUT, NETWORK, RESPONSE_TOO_LARGE) for transport-level failures. The API
 * key and raw body are never logged.
 */
async function fetchSupadataJson(url, apiKey, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : SUPADATA_REQUEST_TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxResponseBytes)
    ? options.maxResponseBytes
    : SUPADATA_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const coded = new Error("Supadata request failed.");
    coded.code = error?.name === "AbortError" ? "TIMEOUT" : "NETWORK";
    throw coded;
  }
  try {
    const text = await readBoundedResponseText(response, maxBytes);
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        data = null;
      }
    }
    return { ok: response.ok === true, status: Number(response.status) || 0, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Maps a Supadata transport-level failure code to the shared error contract.
 */
function supadataTransportFailure(error) {
  const code = error?.code;
  if (code === "TIMEOUT") {
    return {
      success: false,
      error: "PROVIDER_TIMEOUT",
      message: "Supadata 请求超时，请稍后重试。",
    };
  }
  if (code === "RESPONSE_TOO_LARGE") {
    return {
      success: false,
      error: "RESPONSE_TOO_LARGE",
      message: "Supadata 返回的数据过大，已中止。",
    };
  }
  return {
    success: false,
    error: "NETWORK_ERROR",
    message: "无法连接 Supadata，请检查网络后重试。",
  };
}

function supadataHttpFailure(status) {
  if (status === 401) {
    return {
      success: false,
      error: "INVALID_SUPADATA_KEY",
      message: "Supadata API 密钥无效，请打开 DigestDock 设置。",
    };
  }
  if (status === 404 || status === 206) {
    return {
      success: false,
      error: "NO_TRANSCRIPT",
      message: "未找到此视频的原生字幕。",
    };
  }
  if (status === 429) {
    return {
      success: false,
      error: "RATE_LIMITED",
      message: "Supadata 请求次数已达上限，请等待一分钟后重试。",
    };
  }
  return {
    success: false,
    error: "PROVIDER_HTTP_ERROR",
    message: `Supadata 暂时不可用（HTTP ${Number(status) || 0}），请稍后重试。`,
  };
}

function supadataJobTimeoutResult() {
  return {
    success: false,
    error: "PROVIDER_TIMEOUT",
    message: "Supadata 字幕任务超时，请稍后重新授权重试。",
  };
}

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function handleFetchTranscript(
  videoId,
  preferredLanguage,
  shouldContinue = null,
  options = {},
) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "尚未配置 Supadata API 密钥，请打开 DigestDock 设置。",
      };
    }

    if (shouldContinue && !(await shouldContinue())) {
      return pageContextChangedResult();
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    const normalizedPreferredLanguage = normalizeLanguageCode(preferredLanguage);
    if (
      normalizedPreferredLanguage &&
      !isNonTranslatableLanguage(normalizedPreferredLanguage)
    ) {
      apiUrl.searchParams.set("lang", normalizedPreferredLanguage);
    }
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // Make the bounded API request (timeout + size cap + safe parse).
    let response;
    try {
      response = await fetchSupadataJson(
        apiUrl.toString(),
        settings.supadataApiKey,
        options,
      );
    } catch (error) {
      return supadataTransportFailure(error);
    }

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      // Poll for the result
      return await pollTranscriptJob(
        response.data?.jobId,
        settings.supadataApiKey,
        normalizedPreferredLanguage,
        shouldContinue,
        options,
      );
    }

    if (response.status === 206) {
      return supadataHttpFailure(response.status);
    }

    if (!response.ok) {
      return supadataHttpFailure(response.status);
    }

    const data = response.data || {};

    // Parse the response into our internal format
    // Supadata returns: { content: [{ text, offset, duration, lang }], lang, availableLangs }
    const transcript = [];
    let transcriptTextPlain = ""; // Plain text for display/export
    let transcriptTextTimestamped = ""; // Timestamped text for AI analysis
    const trackLanguage = getSupadataTrackLanguage(data);
    if (
      normalizedPreferredLanguage &&
      (!trackLanguage ||
        !languagesSharePrimary(normalizedPreferredLanguage, trackLanguage))
    ) {
      return {
        success: false,
        error: "SOURCE_TRANSCRIPT_UNAVAILABLE",
        message: "未能取得视频默认语言的原生字幕轨。",
      };
    }

    if (data.content && Array.isArray(data.content)) {
      for (const chunk of data.content) {
        if (chunk.text) {
          // Clean up caption artifacts:
          // ">>" = speaker change marker from YouTube auto-captions
          const cleanText = chunk.text.replace(/>> ?/g, "").trim();
          if (!cleanText) continue; // Skip if nothing left after cleanup

          // offset is in milliseconds, convert to seconds
          const startSeconds = Math.floor((chunk.offset || 0) / 1000);
          const minutes = Math.floor(startSeconds / 60);
          const seconds = startSeconds % 60;
          const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

          transcript.push({
            text: cleanText,
            start: startSeconds,
            duration: Math.floor((chunk.duration || 0) / 1000),
            language: normalizeLanguageCode(chunk.lang) || trackLanguage,
          });

          // Plain text without timestamps (for display/export)
          transcriptTextPlain += cleanText + " ";

          // Timestamped text for DeepSeek (format: [MM:SS] text)
          // This allows the model to reference actual transcript positions.
          transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
        }
      }
    }

    if (transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Supadata 返回了空字幕。",
      };
    }

    return {
      success: true,
      transcript: transcript,
      transcriptText: transcriptTextPlain.trim(), // For display
      transcriptTextTimestamped: transcriptTextTimestamped.trim(), // For AI
      language: trackLanguage,
    };
  } catch (_error) {
    return {
      success: false,
      error: "PROVIDER_ERROR",
      message: "Supadata 字幕处理失败，请稍后重试。",
    };
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(
  jobId,
  supadataApiKey,
  preferredLanguage = "",
  shouldContinue = null,
  options = {},
) {
  if (!jobId) {
    return {
      success: false,
      error: "EMPTY_TRANSCRIPT",
      message: "Supadata 返回了空字幕。",
    };
  }
  const maxAttempts = Number.isInteger(options.maxPollAttempts)
    ? Math.max(1, Math.min(options.maxPollAttempts, 60))
    : 60;
  const pollInterval = 1000; // Poll every 1 second
  const now = typeof options.now === "function" ? options.now : Date.now;
  const jobTimeoutMs = Number.isFinite(options.jobTimeoutMs)
    ? Math.max(1, options.jobTimeoutMs)
    : SUPADATA_JOB_TIMEOUT_MS;
  const deadlineAt = now() + jobTimeoutMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (now() >= deadlineAt) return supadataJobTimeoutResult();
    if (shouldContinue && !(await shouldContinue())) {
      return pageContextChangedResult();
    }
    // Wait before polling
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollInterval, Math.max(1, deadlineAt - now()))),
    );
    if (now() >= deadlineAt) return supadataJobTimeoutResult();
    if (shouldContinue && !(await shouldContinue())) {
      return pageContextChangedResult();
    }

    let response;
    try {
      response = await fetchSupadataJson(
        `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
        supadataApiKey,
        {
          ...options,
          timeoutMs: Math.min(
            Number.isFinite(options.timeoutMs)
              ? options.timeoutMs
              : SUPADATA_REQUEST_TIMEOUT_MS,
            Math.max(1, deadlineAt - now()),
          ),
        },
      );
    } catch (error) {
      return supadataTransportFailure(error);
    }

    // Propagate the same provider-specific codes the initial request uses so
    // the same authorization surfaces stable errors during async polling.
    if (!response.ok) {
      return supadataHttpFailure(response.status);
    }

    const data = response.data || {};

    if (data.status === "completed") {
      // Parse the completed transcript
      const transcript = [];
      let transcriptTextPlain = "";
      let transcriptTextTimestamped = "";
      const trackLanguage = getSupadataTrackLanguage(data);
      if (
        preferredLanguage &&
        (!trackLanguage ||
          !languagesSharePrimary(preferredLanguage, trackLanguage))
      ) {
        return {
          success: false,
          error: "SOURCE_TRANSCRIPT_UNAVAILABLE",
          message: "未能取得视频默认语言的原生字幕轨。",
        };
      }

      if (data.content && Array.isArray(data.content)) {
        for (const chunk of data.content) {
          if (chunk.text) {
            // Clean up caption artifacts (">>" = speaker change marker)
            const cleanText = chunk.text.replace(/>> ?/g, "").trim();
            if (!cleanText) continue;

            const startSeconds = Math.floor((chunk.offset || 0) / 1000);
            const minutes = Math.floor(startSeconds / 60);
            const seconds = startSeconds % 60;
            const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

            transcript.push({
              text: cleanText,
              start: startSeconds,
              duration: Math.floor((chunk.duration || 0) / 1000),
              language: normalizeLanguageCode(chunk.lang) || trackLanguage,
            });
            transcriptTextPlain += cleanText + " ";
            transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
          }
        }
      }

      if (transcript.length === 0) {
        return {
          success: false,
          error: "EMPTY_TRANSCRIPT",
          message: "Supadata 返回了空字幕。",
        };
      }

      return {
        success: true,
        transcript: transcript,
        transcriptText: transcriptTextPlain.trim(),
        transcriptTextTimestamped: transcriptTextTimestamped.trim(),
        language: trackLanguage,
      };
    }

    if (data.status === "failed") {
      return {
        success: false,
        error: "PROVIDER_FAILED",
        message: "Supadata 字幕任务失败，请稍后重新授权重试。",
      };
    }

    // Status is 'queued' or 'active' — keep polling
  }

  return supadataJobTimeoutResult();
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing comma before a ] or }, wrap
 * the JSON in prose / code fences, or place a literal control character inside
 * a quoted value. Plain JSON.parse throws on those, which is what caused the
 * Overview tab errors. This function strips fences, isolates the outer JSON
 * object, and applies only those bounded repairs before parsing again.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (_firstError) {
    // Common LLM slips: a trailing comma before a closing delimiter, or a raw
    // newline/tab inside a quoted value. Keep both repairs string-aware so
    // quoted text such as `,}` is never mistaken for JSON syntax.
    let repaired = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < cleaned.length; index += 1) {
      const character = cleaned[index];
      if (!inString) {
        if (character === ",") {
          let nextIndex = index + 1;
          while (nextIndex < cleaned.length && /\s/.test(cleaned[nextIndex])) {
            nextIndex += 1;
          }
          if (cleaned[nextIndex] === "}" || cleaned[nextIndex] === "]") {
            continue;
          }
        }
        repaired += character;
        if (character === '"') inString = true;
        continue;
      }
      const codeUnit = character.charCodeAt(0);
      if (codeUnit <= 0x1f) {
        const unicodeEscape = `u${codeUnit.toString(16).padStart(4, "0")}`;
        repaired += escaped ? unicodeEscape : `\\${unicodeEscape}`;
        escaped = false;
        continue;
      }
      if (escaped) {
        repaired += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        repaired += character;
        escaped = true;
        continue;
      }
      if (character === '"') {
        repaired += character;
        inString = false;
        continue;
      }
      repaired += character;
    }
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

function shouldUseBilibiliChinese(platform, sourceLanguage) {
  return (
    platform === "bilibili" &&
    isConfirmedSimplifiedChineseSource(sourceLanguage)
  );
}

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @param {string} sourceLanguage - The actual caption-track language
 * @param {string} platform - Source platform (`youtube` or `bilibili`)
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
  sourceLanguage = "",
  platform = "youtube",
) {
  // Hoisted so the catch block can name the active provider in error copy.
  let settings;
  try {
    settings = await getSettings();
    if (!YTD_SETTINGS.hasActiveApiKey(settings)) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: `尚未配置${providerDisplayLabel(settings)} API 密钥，请打开 DigestDock 设置。`,
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;
    const normalizedSourceLanguage = resolveSourceLanguage(
      sourceLanguage,
      transcriptText,
    );

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const normalizedPlatform = platform === "bilibili" ? "bilibili" : "youtube";
    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      sourceLanguage: normalizedSourceLanguage,
      transcriptText,
      platform: normalizedPlatform,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog(
      "[DigestDock] Requesting video analysis",
      normalizedPlatform,
      resolveActiveProvider(settings)?.model,
    );
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(
      analysis,
      maxTimestampSeconds,
      normalizedSourceLanguage,
    );
    if (!hasUsableChineseOverview(analysis)) {
      throw new Error(
        `${providerDisplayLabel(settings)} 没有返回可用的中文概览，请重试。`,
      );
    }

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: `${providerDisplayLabel(settings)} 拒绝了该 API 密钥。`,
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: `${providerDisplayLabel(settings)} 限制了本次请求，请稍后重试。`,
      };
    }
    return {
      success: false,
      error: error.message || "分析字幕失败",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from DeepSeek
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @param {string} sourceLanguage - Trusted source caption language
 * @returns {Object} - Analysis with validated timestamps and language metadata
 */
function validateAndFixTimestamps(analysis, maxSeconds, sourceLanguage) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };
  let normalizedSourceLanguage = resolveSourceLanguage(sourceLanguage);
  const detectedSourceLanguage = normalizeLanguageCode(
    analysis?.detectedSourceLanguage,
  );
  if (
    normalizedSourceLanguage.toLowerCase() === "und" &&
    detectedSourceLanguage &&
    !isNonTranslatableLanguage(detectedSourceLanguage)
  ) {
    normalizedSourceLanguage = detectedSourceLanguage;
  }
  const sourceIsSimplifiedChinese = isConfirmedSimplifiedChineseSource(
    normalizedSourceLanguage,
  );

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const titleZh = safeString(chapter?.titleZh, 300);
      const summaryZh = safeString(chapter?.summaryZh, 1500);
      if (seconds === null || !titleZh || !summaryZh) {
        return null;
      }
      return {
        titleZh,
        summaryZh,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const quoteOriginal = safeString(quote?.quoteOriginal, 3000);
      const proposedQuoteZh = safeString(quote?.quoteZh, 3000);
      const quoteZh = sourceIsSimplifiedChinese
        ? quoteOriginal
        : proposedQuoteZh;
      if (seconds === null || !quoteOriginal || !quoteZh) return null;
      return {
        quoteOriginal,
        quoteZh,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    baseLanguage: ANALYSIS_BASE_LANGUAGE,
    sourceLanguage: normalizedSourceLanguage,
    chapters,
    keyQuotes,
    keyMoments,
  };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at the current timestamp.
 * Fetches the transcript if needed, finds the relevant line, and cleans it up.
 */
async function handleSaveNote(
  mediaInput,
  timestamp,
  videoTitle,
  channelName,
  sourceUrl = "",
  tabId = null,
  preferredLanguage = "",
) {
  const saveGeneration = noteStorageGeneration;
  const sourceStorageGeneration = exportSourceStorageGeneration;
  try {
    const mediaRef = await resolveMediaRef(mediaInput, sourceUrl);
    const mediaKey = mediaRef.mediaKey || mediaRef.videoId;
    const canonicalVideoUrl = mediaRef.canonicalUrl;
    const resolvedVideoTitle = videoTitle || mediaRef.title || "Untitled Video";
    const resolvedChannelName = channelName || mediaRef.channelName || "";
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and could
    // start another provider path for every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${mediaKey}`);
      const digest = cached[`digest_${mediaKey}`];
      const transcriptSourceMatchesPlatform =
        mediaRef.platform === "youtube"
          ? YOUTUBE_TRANSCRIPT_CACHE_SOURCES.has(digest?.transcriptSource)
          : digest?.transcriptSource === "bilibili";
      const transcriptPolicyMatchesPlatform =
        mediaRef.platform === "youtube"
          ? digest?.transcriptSourcePolicyVersion ===
            TRANSCRIPT_SOURCE_POLICY_VERSION
          : [4, TRANSCRIPT_SOURCE_POLICY_VERSION].includes(
              digest?.transcriptSourcePolicyVersion,
            );
      if (
        Array.isArray(digest?.transcript) &&
        digest.transcript.length > 0 &&
        transcriptPolicyMatchesPlatform &&
        transcriptSourceMatchesPlatform
      ) {
        transcript = digest.transcript;
        debugLog("[DigestDock] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[DigestDock] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      let resolvedPreferredLanguage = normalizeLanguageCode(preferredLanguage);
      if (
        mediaRef.platform === "youtube" &&
        !resolvedPreferredLanguage &&
        Number.isInteger(tabId)
      ) {
        const playerDetails = await getPlayerVideoDetails(tabId);
        resolvedPreferredLanguage = normalizeLanguageCode(
          playerDetails?.sourceLanguage,
        );
      }
      const transcriptResult = await handleFetchMediaTranscript(
        mediaRef,
        resolvedPreferredLanguage,
        tabId,
      );
      if (!transcriptResult.success) {
        // Merely saving a note must not silently start Active, Panel, or
        // Supadata. Ask the user to start the current video's transcript task
        // in the side panel; that task owns the native-first route and any
        // later third-party choice.
        if (mediaRef.platform === "youtube") {
          return {
            success: false,
            error: "TRANSCRIPT_TASK_REQUIRED",
            message:
              "请先在侧栏启动当前视频的字幕任务；取得字幕后再保存笔记。",
          };
        }
        return {
          success: false,
          error: transcriptResult.error || "Could not fetch transcript",
          message:
            transcriptResult.message || "无法读取字幕。",
        };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Before the first caption, use the first line. Only a timestamp beyond
      // the available transcript should fall back to the final line.
      const firstStart = Number(transcript[0]?.start);
      matchedIndex =
        Number.isFinite(firstStart) && safeTimestamp < firstStart
          ? 0
          : transcript.length - 1;
      matchedLine = transcript[matchedIndex];

      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const afterLines = [];
      for (let j = 1; j <= 4 && matchedIndex + j < transcript.length; j++) {
        afterLines.push(transcript[matchedIndex + j].text);
      }
      if (afterLines.length > 0) {
        afterLine = afterLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      const endIdx = Math.min(transcript.length - 1, matchedIndex + 12);
      for (let j = startIdx; j <= endIdx; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    const matchedLanguage = normalizeLanguageCode(matchedLine.language);
    const storedSourceLanguage =
      matchedLanguage.length <= 20 ? matchedLanguage : "";
    const directBilibiliChineseNote = shouldUseBilibiliChinese(
      mediaRef.platform,
      matchedLanguage,
    );

    // YouTube's definitively Chinese captions already match the product's
    // target language, so retain the mainline zero-cleanup behavior. Bilibili
    // Chinese captions intentionally get one Chinese cleanup call to repair
    // sentence boundaries and punctuation; the Notes panel remains the sole
    // owner of any later translation work.
    const cleanedText =
      isChineseLanguage(matchedLanguage) && !directBilibiliChineseNote
        ? String(matchedLine.text || "").trim()
      : await cleanupNoteText(
          matchedLine.text,
          beforeLine,
          afterLine,
          contextLines.join(" "),
          resolvedVideoTitle,
          mediaRef.platform,
          matchedLanguage,
        );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl =
      mediaRef.platform === "bilibili"
        ? BILIBILI_ADAPTER.timestampUrl(mediaRef, safeTimestamp)
        : `${canonicalVideoUrl}&t=${safeTimestamp}s`;
    const normalizedNoteText = String(cleanedText || matchedLine.text || "")
      .trim()
      .slice(0, 3000);
    const normalizedVideoTitle =
      typeof resolvedVideoTitle === "string" && resolvedVideoTitle.trim()
        ? resolvedVideoTitle.trim().slice(0, 500)
        : "Untitled Video";

    // Create the note object
    const note = {
      id: createNoteId(),
      videoId: mediaKey,
      mediaKey,
      platform: mediaRef.platform,
      canonicalUrl: canonicalVideoUrl,
      bvid: mediaRef.bvid || "",
      cid: mediaRef.cid || null,
      page: mediaRef.page || null,
      videoTitle: normalizedVideoTitle,
      channelName:
        typeof resolvedChannelName === "string"
          ? resolvedChannelName.trim().slice(0, 300)
          : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: normalizedNoteText,
      translatedText: "",
      translatedValidated: false,
      translatedValidationVersion: 0,
      translatedUnchanged: false,
      rawText: String(matchedLine.text || "").trim().slice(0, 3000),
      sourceLanguage: storedSourceLanguage,
      textLanguage: directBilibiliChineseNote ? "zh-CN" : "",
      createdAt: Date.now(),
    };

    // Save to storage
    const saved = await saveNoteToStorage(note, saveGeneration);
    if (!saved) {
      return {
        success: false,
        code: "NOTE_SAVE_CANCELED",
        error: "笔记保存已因清空或重置操作取消。",
      };
    }

    // A note and the material needed to export it belong to the same user
    // action. Persist the source immediately while the exact video tab is
    // still available, instead of relying on a later side-panel lifecycle.
    // This is deliberately best-effort: the note is already durable, and a
    // transient page/storage failure must never turn a successful save into a
    // failed note. No transcript/provider call is made here; `transcript` is
    // the local material already used to create the note.
    await persistSavedNoteSourceBestEffort({
      mediaRef,
      note,
      transcript,
      tabId,
      sourceLanguage: storedSourceLanguage,
      expectedNoteGeneration: saveGeneration,
      expectedSourceGeneration: sourceStorageGeneration,
    });

    // Chinese generation is triggered by the Notes panel after this save
    // notification. Keeping one owner prevents a failed save-time translation
    // from being retried immediately by noteSaved -> loadNotes.

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[DigestDock] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Best-effort source persistence for one successfully saved note.
 *
 * YouTube metadata is accepted only from the exact tab/player video identity;
 * stale SPA state therefore cannot be attached to another note. Bilibili's
 * resolved media reference already carries the API-backed metadata and is
 * reused without another request.
 *
 * The final write is serialized with note clear/reset. Holding the shared note
 * queue while calling the existing note-source upsert means a later clear runs
 * after this write and removes it, while an earlier clear changes the captured
 * generations and prevents this write from resurrecting cleared data.
 */
async function persistSavedNoteSourceBestEffort({
  mediaRef,
  note,
  transcript,
  tabId,
  sourceLanguage = "",
  expectedNoteGeneration,
  expectedSourceGeneration,
}) {
  try {
    let metadata = null;
    if (mediaRef?.platform === "youtube") {
      if (!Number.isInteger(tabId)) return null;
      const playerDetails = await getPlayerVideoDetails(tabId);
      const expectedVideoId = String(mediaRef.videoId || "").trim();
      const actualVideoId = String(playerDetails?.videoId || "").trim();
      if (!expectedVideoId || actualVideoId !== expectedVideoId) {
        debugLog(
          "[DigestDock] Skipping note source: YouTube player identity changed",
        );
        return null;
      }
      metadata = playerDetails;
    } else if (mediaRef?.platform === "bilibili") {
      metadata = mediaRef;
    } else {
      return null;
    }

    const description = String(
      metadata.description || metadata.metadata?.description || "",
    ).trim();
    const explicitDescriptionStatus =
      metadata.descriptionStatus || metadata.metadata?.descriptionStatus;
    const descriptionStatus = [
      "present",
      "confirmed-empty",
      "unknown",
    ].includes(explicitDescriptionStatus)
      ? explicitDescriptionStatus
      : description
        ? "present"
        : "unknown";
    const source = YTD_NOTE_SOURCES.normalizeNoteSource({
      mediaKey: note.mediaKey,
      platform: note.platform,
      canonicalUrl: note.canonicalUrl,
      titleOriginal: String(metadata.title || note.videoTitle || "").trim(),
      channelName: String(
        metadata.channelName ||
          metadata.metadata?.channelName ||
          note.channelName ||
          "",
      ).trim(),
      descriptionOriginal: description,
      descriptionStatus,
      descriptionTruncated:
        metadata.descriptionTruncated === true ||
        metadata.metadata?.descriptionTruncated === true,
      sourceLanguage: String(
        sourceLanguage || note.sourceLanguage || metadata.sourceLanguage || "",
      ).trim(),
      transcriptOriginal: Array.isArray(transcript) ? transcript : [],
      transcriptZh: [],
      transcriptTruncated: false,
    });
    if (!source) return null;

    return await withNoteStorageWrite(async () => {
      if (
        expectedNoteGeneration !== noteStorageGeneration ||
        expectedSourceGeneration !== exportSourceStorageGeneration
      ) {
        return null;
      }
      const persisted = await handleUpsertNoteSource(source);
      return persisted?.success ? persisted.source : null;
    });
  } catch (error) {
    debugLog(
      "[DigestDock] Note source persistence skipped:",
      error?.code || error?.message || "unknown error",
    );
    return null;
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
  platform = "youtube",
  sourceLanguage = "",
) {
  const settings = await getSettings();
  if (!YTD_SETTINGS.hasActiveApiKey(settings)) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[DigestDock] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
      platform,
      sourceLanguage: sourceLanguage || "unknown",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      shouldUseBilibiliChinese(platform, sourceLanguage)
        ? "Chinese system prompt"
        : "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[DigestDock] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[DigestDock] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
let noteStorageWriteQueue = Promise.resolve();
let noteStorageGeneration = 0;

function createNoteId({
  now = Date.now,
  randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
  random = Math.random,
} = {}) {
  if (typeof randomUUID === "function") {
    return `note_${randomUUID()}`;
  }
  return `note_${now()}_${random().toString(36).slice(2, 12)}`;
}

function getNoteStorageGeneration() {
  return noteStorageGeneration;
}

function withNoteStorageWrite(task) {
  const run = noteStorageWriteQueue.then(task);
  noteStorageWriteQueue = run.catch(() => {});
  return run;
}

function saveNoteToStorage(note, expectedGeneration = noteStorageGeneration) {
  return withNoteStorageWrite(async () => {
    if (expectedGeneration !== noteStorageGeneration) return false;
    const result = await chrome.storage.local.get("ytd_notes");
    const notes = Array.isArray(result.ytd_notes) ? result.ytd_notes : [];
    notes.unshift(note); // Add to beginning (newest first)

    // Keep only the newest notes to prevent storage bloat.
    if (notes.length > MAX_SAVED_NOTES) {
      notes.splice(MAX_SAVED_NOTES);
    }

    await chrome.storage.local.set({ ytd_notes: notes });
    return true;
  });
}

function notesBackupFailure(error, fallbackCode) {
  return {
    success: false,
    code: error?.code || fallbackCode,
    overBy: Number(error?.details?.overBy) || 0,
  };
}

function notifyNotesChanged() {
  try {
    const notification = chrome.runtime.sendMessage?.({ action: "notesChanged" });
    notification?.catch?.(() => {});
  } catch (_error) {
    // The next Notes-tab load will still read the current storage state.
  }
}

/**
 * Creates a consistent notes-only snapshot after all earlier note writes finish.
 */
function handleExportNotesBackup() {
  return withNoteStorageWrite(async () => {
    try {
      const stored = await chrome.storage.local.get("ytd_notes");
      const notes = Array.isArray(stored.ytd_notes) ? stored.ytd_notes : [];
      const extensionVersion = chrome.runtime.getManifest?.().version || "";
      const backup = YTD_NOTES_BACKUP.createBackup(notes, { extensionVersion });
      return { success: true, backup, count: backup.notes.length };
    } catch (error) {
      return notesBackupFailure(error, "NOTES_EXPORT_FAILED");
    }
  });
}

/**
 * Validates and atomically merges an uploaded backup through the shared note
 * storage queue. A failure never partially updates the stored notes.
 */
function handleImportNotesBackup(backupText) {
  return withNoteStorageWrite(async () => {
    try {
      const importedNotes = YTD_NOTES_BACKUP.parseBackupText(backupText);
      const stored = await chrome.storage.local.get("ytd_notes");
      const existingNotes = Array.isArray(stored.ytd_notes)
        ? stored.ytd_notes
        : [];
      const result = YTD_NOTES_BACKUP.mergeNotes(existingNotes, importedNotes);

      if (result.changed) {
        await chrome.storage.local.set({ ytd_notes: result.notes });
        notifyNotesChanged();
      }

      const { notes: _notes, ...summary } = result;
      return { success: true, ...summary };
    } catch (error) {
      return notesBackupFailure(error, "NOTES_IMPORT_FAILED");
    }
  });
}

function handleClearAllNotes() {
  return withNoteStorageWrite(async () => {
    try {
      await preflightExportTranslationStorage();
      noteStorageGeneration += 1;
      exportSourceStorageGeneration += 1;
      if (
        typeof YTD_EXPORT_JOBS !== "undefined" &&
        typeof YTD_EXPORT_JOBS.clearExportJobs === "function"
      ) {
        await YTD_EXPORT_JOBS.clearExportJobs(chrome.storage.local);
      }
      if (
        typeof YTD_NOTE_SOURCES !== "undefined" &&
        typeof YTD_NOTE_SOURCES.clearNoteSources === "function"
      ) {
        await YTD_NOTE_SOURCES.clearNoteSources(chrome.storage.local);
      }
      await chrome.storage.local.remove("ytd_notes");
      notifyNotesChanged();
      return { success: true };
    } catch (error) {
      return notesBackupFailure(error, "NOTES_CLEAR_FAILED");
    }
  });
}

function handleResetAllExtensionData(preferredLanguage) {
  return withNoteStorageWrite(async () => {
    try {
      await preflightExportTranslationStorage();
      noteStorageGeneration += 1;
      exportSourceStorageGeneration += 1;
      if (
        typeof YTD_EXPORT_JOBS !== "undefined" &&
        typeof YTD_EXPORT_JOBS.clearExportJobs === "function"
      ) {
        await YTD_EXPORT_JOBS.clearExportJobs(chrome.storage.local);
      }
      if (
        typeof YTD_NOTE_SOURCES !== "undefined" &&
        typeof YTD_NOTE_SOURCES.clearNoteSources === "function"
      ) {
        await YTD_NOTE_SOURCES.clearNoteSources(chrome.storage.local);
      }
      const safeLanguage = preferredLanguage === "en" ? "en" : "zh-CN";
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ ytd_options_language: safeLanguage });
      notifyNotesChanged();
      return { success: true };
    } catch (error) {
      return notesBackupFailure(error, "RESET_DATA_FAILED");
    }
  });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = Array.isArray(result.ytd_notes) ? result.ytd_notes : [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    return await withNoteStorageWrite(async () => {
      const result = await chrome.storage.local.get("ytd_notes");
      const notes = Array.isArray(result.ytd_notes) ? result.ytd_notes : [];
      await chrome.storage.local.set({
        ytd_notes: notes.filter((note) => note.id !== noteId),
      });
      return { success: true };
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!YTD_SETTINGS.hasActiveApiKey(settings)) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: `尚未配置${providerDisplayLabel(settings)} API 密钥。`,
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[DigestDock] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "解释所选内容失败",
    };
  }
}

// ============================================================
// RESUMABLE EXPORT SOURCE TRANSLATION
// ============================================================

function exportSourceBatchError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

const EXPORT_SOURCE_SAFE_ERROR_CODES = new Set([
  "INVALID_EXPORT_SOURCE_BATCH",
  "INVALID_EXPORT_JOB",
  "INVALID_EXPORT_JOB_PATCH",
  "INVALID_EXPORT_JOB_PROGRESS",
  "INVALID_EXPORT_JOB_TRANSITION",
  "EXPORT_JOB_ALREADY_CLAIMED",
  "EXPORT_JOB_NOT_FOUND",
  "EXPORT_JOB_NOT_RUNNING",
  "EXPORT_JOB_NOT_RESUMABLE",
  "EXPORT_JOB_MEDIA_MISMATCH",
  "EXPORT_JOB_SOURCE_REVISION_MISMATCH",
  "EXPORT_JOB_UNIT_MISMATCH",
  "EXPORT_JOB_BATCH_BUSY",
  "EXPORT_JOB_PROVIDER_MISMATCH",
  "EXPORT_SOURCE_NOT_FOUND",
  "EXPORT_SOURCE_STALE",
  "EXPORT_SOURCE_UNIT_MISMATCH",
  "EXPORT_BATCH_PROGRESS_STALE",
  "EXPORT_SOURCE_BATCH_PARTIAL",
  "EXPORT_SOURCE_BATCH_COMMIT_FAILED",
  "EXPORT_SOURCE_PROVIDER_FAILED",
  "EXPORT_SOURCE_MODULE_UNAVAILABLE",
  "EXPORT_JOB_MODULE_UNAVAILABLE",
  "EXPORT_SOURCE_BATCH_FAILED",
]);

function normalizeExportSourceBatchCode(value) {
  const code = String(value || "");
  return EXPORT_SOURCE_SAFE_ERROR_CODES.has(code)
    ? code
    : "EXPORT_SOURCE_BATCH_FAILED";
}

function exportSourceBatchSafeMessage(code) {
  const messages = {
    INVALID_EXPORT_SOURCE_BATCH: "补译批次无效，请刷新后重试。",
    EXPORT_JOB_NOT_FOUND: "补译任务不存在或已被清理，请重新开始导出。",
    EXPORT_JOB_NOT_RUNNING: "补译任务当前未运行，不会启动新的翻译请求。",
    EXPORT_JOB_NOT_RESUMABLE: "补译任务已结束，不能继续运行。",
    EXPORT_JOB_ALREADY_CLAIMED: "该导出任务已由另一个侧栏实例接管。",
    EXPORT_JOB_MEDIA_MISMATCH: "补译任务与当前视频不匹配，请重新预检。",
    EXPORT_JOB_SOURCE_REVISION_MISMATCH:
      "视频原始资料已变化，本批次未写入，请重新预检。",
    EXPORT_JOB_UNIT_MISMATCH: "补译单元不属于当前任务，请重新预检。",
    EXPORT_JOB_BATCH_BUSY: "该补译任务已有另一批正在处理，请稍候。",
    EXPORT_JOB_PROVIDER_MISMATCH:
      "当前翻译服务或模型已变化，本批次未调用，请重新确认。",
    EXPORT_SOURCE_NOT_FOUND: "本地没有这段视频资料，请重新打开视频后再试。",
    EXPORT_SOURCE_STALE: "视频原始资料已变化，本批次未写入，请重新预检。",
    EXPORT_SOURCE_UNIT_MISMATCH:
      "补译单元与本地原文不一致，未调用翻译服务。",
    EXPORT_BATCH_PROGRESS_STALE:
      "本地补译进度已变化，请刷新后继续，已完成内容不会重译。",
    EXPORT_SOURCE_BATCH_PARTIAL:
      "翻译服务未返回完整批次，本批次未写入，请重试。",
    EXPORT_SOURCE_BATCH_COMMIT_FAILED:
      "补译结果未能安全保存，本批次未计入进度，请重试。",
    EXPORT_SOURCE_PROVIDER_FAILED: "翻译服务未完成本批次，请稍后重试。",
    EXPORT_SOURCE_MODULE_UNAVAILABLE:
      "补译资料模块不可用，请重新加载扩展后再试。",
    EXPORT_JOB_MODULE_UNAVAILABLE:
      "补译任务模块不可用，请重新加载扩展后再试。",
  };
  return messages[code] || "补译批次失败，请重试。";
}

function exportSourceBatchFailure(error, overrides = {}) {
  const code = normalizeExportSourceBatchCode(error?.code);
  const message = exportSourceBatchSafeMessage(code);
  return {
    success: false,
    code,
    error: message,
    jobState: overrides.jobState || error?.jobState || "",
    completedUnitKeys: Array.isArray(overrides.completedUnitKeys)
      ? overrides.completedUnitKeys
      : [],
    remainingCount: Number.isSafeInteger(overrides.remainingCount)
      ? overrides.remainingCount
      : null,
    actualProviderCalls: Number.isSafeInteger(overrides.actualProviderCalls)
      ? overrides.actualProviderCalls
      : Number.isSafeInteger(error?.actualProviderCalls)
        ? error.actualProviderCalls
        : 0,
  };
}

function requireExportSourceModules() {
  if (
    typeof YTD_NOTE_SOURCES !== "object" ||
    typeof YTD_NOTE_SOURCES.readNoteSource !== "function" ||
    typeof YTD_NOTE_SOURCES.validateExportSourceTranslationUnits !==
      "function" ||
    typeof YTD_NOTE_SOURCES.commitExportSourceTranslationBatch !== "function" ||
    typeof YTD_NOTE_SOURCES.normalizeNoteSource !== "function" ||
    typeof YTD_NOTE_SOURCES.writeNoteSource !== "function"
  ) {
    throw exportSourceBatchError(
      "EXPORT_SOURCE_MODULE_UNAVAILABLE",
      "The note-source translation module is unavailable.",
    );
  }
  if (
    typeof YTD_EXPORT_JOBS !== "object" ||
    typeof YTD_EXPORT_JOBS.readExportJob !== "function" ||
    typeof YTD_EXPORT_JOBS.checkpointExportJob !== "function" ||
    typeof YTD_EXPORT_JOBS.normalizeExportJob !== "function" ||
    typeof YTD_EXPORT_JOBS.createExportJob !== "function" ||
    typeof YTD_EXPORT_JOBS.upsertExportJob !== "function"
  ) {
    throw exportSourceBatchError(
      "EXPORT_JOB_MODULE_UNAVAILABLE",
      "The export-job module is unavailable.",
    );
  }
}

async function preflightExportTranslationStorage() {
  requireExportSourceModules();
  if (
    typeof YTD_NOTE_SOURCES.preflightNoteSourceStorage !== "function" ||
    typeof YTD_EXPORT_JOBS.preflightExportJobs !== "function"
  ) {
    throw exportSourceBatchError(
      "EXPORT_SOURCE_MODULE_UNAVAILABLE",
      "Export translation storage cannot be validated safely.",
    );
  }
  await YTD_EXPORT_JOBS.preflightExportJobs(chrome.storage.local);
  await YTD_NOTE_SOURCES.preflightNoteSourceStorage(chrome.storage.local);
}

function assertExportSourceStorageGeneration(expectedGeneration) {
  if (expectedGeneration !== exportSourceStorageGeneration) {
    throw exportSourceBatchError(
      "EXPORT_JOB_NOT_FOUND",
      "Export translation state was cleared before this request could commit.",
    );
  }
}

function normalizeExportBatchToken(value, maxLength) {
  if (typeof value !== "string") return "";
  const token = value.normalize("NFC").trim();
  return token &&
    token.length <= maxLength &&
    !/[\s\u0000-\u001f\u007f]/.test(token)
    ? token
    : "";
}

function normalizeExportSourceRevision(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return normalizeExportBatchToken(value, 128);
}

/**
 * Applies the public 1–4 unit / 12k character boundary before any storage or
 * provider work. Only allowlisted fields survive normalization.
 */
function validateExportSourceBatchRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw exportSourceBatchError(
      "INVALID_EXPORT_SOURCE_BATCH",
      "Export source batch must be an object.",
    );
  }
  for (const secretField of [
    "apiKey",
    "aiApiKey",
    "providerApiKey",
    "authorization",
    "credentials",
    "settings",
    "key",
  ]) {
    if (Object.prototype.hasOwnProperty.call(message, secretField)) {
      throw exportSourceBatchError(
        "INVALID_EXPORT_SOURCE_BATCH",
        "Provider credentials are not accepted by this action.",
      );
    }
  }
  const jobId = normalizeExportBatchToken(message.jobId, 80);
  const mediaKey = normalizeExportBatchToken(message.mediaKey, 64);
  const sourceRevision = normalizeExportSourceRevision(message.sourceRevision);
  const requestedUnits = message.units;
  if (
    !jobId ||
    !mediaKey ||
    sourceRevision === "" ||
    !Array.isArray(requestedUnits) ||
    requestedUnits.length < 1 ||
    requestedUnits.length > EXPORT_SOURCE_BATCH_MAX_UNITS
  ) {
    throw exportSourceBatchError(
      "INVALID_EXPORT_SOURCE_BATCH",
      "Export source batch identity or unit count is invalid.",
    );
  }

  const seenUnitKeys = new Set();
  let totalCharacters = 0;
  const units = requestedUnits.map((unit) => {
    const unitKey = normalizeExportBatchToken(unit?.unitKey || unit?.id, 256);
    const sourceHash =
      typeof unit?.sourceHash === "string" ? unit.sourceHash.trim() : "";
    const text = typeof unit?.text === "string" ? unit.text.trim() : "";
    const kind = unit?.kind;
    if (
      !unitKey ||
      seenUnitKeys.has(unitKey) ||
      !/^fnv1a-[0-9a-f]{16}$/.test(sourceHash) ||
      !text ||
      text.length > 4000 ||
      !["description", "transcript"].includes(kind)
    ) {
      throw exportSourceBatchError(
        "INVALID_EXPORT_SOURCE_BATCH",
        "Export source unit identity, hash, kind, or text is invalid.",
      );
    }
    seenUnitKeys.add(unitKey);
    totalCharacters += text.length;
    const normalized = {
      id: unitKey,
      unitKey,
      mediaKey,
      sourceRevision,
      sourceHash,
      text,
      kind,
    };
    if (kind === "description") {
      if (
        !Number.isSafeInteger(unit.chunkIndex) ||
        unit.chunkIndex < 0 ||
        unit.chunkIndex > 9999
      ) {
        throw exportSourceBatchError(
          "INVALID_EXPORT_SOURCE_BATCH",
          "Description chunk identity is invalid.",
        );
      }
      normalized.chunkIndex = unit.chunkIndex;
    } else {
      const segmentId = normalizeExportBatchToken(unit.segmentId, 300);
      const start = Number(unit.start);
      if (!segmentId || !Number.isFinite(start) || start < 0 || start > 86400) {
        throw exportSourceBatchError(
          "INVALID_EXPORT_SOURCE_BATCH",
          "Transcript segment identity is invalid.",
        );
      }
      normalized.segmentId = segmentId;
      normalized.start = Math.round(start * 1000) / 1000;
      normalized.startMs = Math.round(start * 1000);
    }
    return normalized;
  });
  if (totalCharacters > EXPORT_SOURCE_BATCH_MAX_CHARACTERS) {
    throw exportSourceBatchError(
      "INVALID_EXPORT_SOURCE_BATCH",
      "Export source batch exceeds 12000 characters.",
    );
  }
  return {
    jobId,
    mediaKey,
    sourceRevision,
    units,
    unitKeys: units.map((unit) => unit.unitKey),
  };
}

function exportSourceBatchFlightKey(request) {
  return `${request.jobId}\u0000${[...request.unitKeys].sort().join("\u0001")}`;
}

function shortExportBatchHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const exportJobActiveBatch = new Map();

function enqueueExportSourceBatch(task) {
  const pending = exportSourceBatchQueueTail.catch(() => undefined).then(task);
  exportSourceBatchQueueTail = pending.catch(() => undefined);
  return pending;
}

function runExportSourceBatchSingleFlight(request) {
  const flightKey = exportSourceBatchFlightKey(request);
  const existing = exportSourceBatchInFlight.get(flightKey);
  if (existing) return existing;
  const activeKey = exportJobActiveBatch.get(request.jobId);
  if (activeKey && activeKey !== flightKey) {
    return Promise.resolve(
      exportSourceBatchFailure(
        exportSourceBatchError(
          "EXPORT_JOB_BATCH_BUSY",
          "Another source batch is already running for this export job.",
        ),
      ),
    );
  }
  const promise = enqueueExportSourceBatch(() => executeExportSourceBatch(request))
    .catch(async (error) => {
      let checkpointedJob = null;
      if (error?.checkpoint === true || request.batchClaimed === true) {
        checkpointedJob = await checkpointExportBatchError(
          request.jobId,
          error,
        );
      }
      return exportSourceBatchFailure(error, {
        jobState: checkpointedJob?.state || error?.jobState || "",
        completedUnitKeys: checkpointedJob?.completedUnitKeys || [],
        remainingCount: checkpointedJob
          ? exportJobRemainingCount(checkpointedJob)
          : null,
        actualProviderCalls: Number.isSafeInteger(error?.actualProviderCalls)
          ? error.actualProviderCalls
          : 0,
      });
    })
    .finally(() => {
      if (exportSourceBatchInFlight.get(flightKey) === promise) {
        exportSourceBatchInFlight.delete(flightKey);
      }
      if (exportJobActiveBatch.get(request.jobId) === flightKey) {
        exportJobActiveBatch.delete(request.jobId);
      }
    });
  exportSourceBatchInFlight.set(flightKey, promise);
  exportJobActiveBatch.set(request.jobId, flightKey);
  return promise;
}

function revisionsMatch(left, right) {
  return left === right;
}

function exportJobRemainingCount(job) {
  const completed = new Set(job?.completedUnitKeys || []);
  return (job?.orderedUnitKeys || []).reduce(
    (count, unitKey) => count + (completed.has(unitKey) ? 0 : 1),
    0,
  );
}

function exportJobCursor(job, completedUnitKeys = job?.completedUnitKeys || []) {
  const completed = new Set(completedUnitKeys);
  const ordered = job?.orderedUnitKeys || [];
  let cursor = 0;
  while (cursor < ordered.length && completed.has(ordered[cursor])) cursor += 1;
  return cursor;
}

function assertExportJobMatchesRequest(job, request, { mustRun = true } = {}) {
  if (!job) {
    throw exportSourceBatchError(
      "EXPORT_JOB_NOT_FOUND",
      "Export translation job was not found.",
    );
  }
  if (mustRun && job.state !== "running") {
    throw exportSourceBatchError(
      "EXPORT_JOB_NOT_RUNNING",
      "Export translation job is not running.",
      { jobState: job.state },
    );
  }
  if (!job.intent?.mediaKeys?.includes(request.mediaKey)) {
    throw exportSourceBatchError(
      "EXPORT_JOB_MEDIA_MISMATCH",
      "Export job does not include this media source.",
      { jobState: job.state },
    );
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      job.sourceRevisions || {},
      request.mediaKey,
    ) ||
    !revisionsMatch(job.sourceRevisions[request.mediaKey], request.sourceRevision)
  ) {
    throw exportSourceBatchError(
      "EXPORT_JOB_SOURCE_REVISION_MISMATCH",
      "Export job source revision no longer matches.",
      { jobState: job.state },
    );
  }
  const ordered = new Set(job.orderedUnitKeys || []);
  if (request.unitKeys.some((unitKey) => !ordered.has(unitKey))) {
    throw exportSourceBatchError(
      "EXPORT_JOB_UNIT_MISMATCH",
      "Export source units do not belong to this job.",
      { jobState: job.state },
    );
  }
  return job;
}

function sameUnitKeyList(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function exportStoredNoteOriginalText(note) {
  if (
    isConfirmedSimplifiedChineseSource(note?.textLanguage) &&
    typeof note?.text === "string" &&
    note.text.trim()
  ) {
    return note.text.trim();
  }
  if (noteHasChineseSource(note)) {
    return String(note?.rawText || note?.text || "").trim();
  }
  return String(note?.text || note?.rawText || "").trim();
}

function exportStoredNoteTitle(note) {
  return String(note?.videoTitle || "").trim() || "Untitled Video";
}

function exportStoredNotesRevision(notes, mediaKeys) {
  const allowed = new Set(mediaKeys || []);
  const originals = (Array.isArray(notes) ? notes : [])
    .filter((note) =>
      allowed.has(String(note?.mediaKey || note?.videoId || "").trim()),
    )
    .map((note) => [
      String(note?.id || ""),
      String(note?.mediaKey || note?.videoId || ""),
      exportStoredNoteOriginalText(note),
      exportStoredNoteTitle(note),
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return YTD_NOTE_SOURCES.hashSourceText(JSON.stringify(originals));
}

function exportStoredNoteUnitKey(note) {
  return `note:${YTD_NOTE_SOURCES.hashSourceText(String(note?.id || ""))}:${YTD_NOTE_SOURCES.hashSourceText(exportStoredNoteOriginalText(note))}`;
}

function exportStoredTitleUnitKey(mediaKey, title) {
  return `title:${YTD_NOTE_SOURCES.hashSourceText(mediaKey)}:${YTD_NOTE_SOURCES.hashSourceText(title)}`;
}

async function assertExportNotesJobCurrent(jobId, storageGeneration) {
  assertExportSourceStorageGeneration(storageGeneration);
  const job = await YTD_EXPORT_JOBS.readExportJob(chrome.storage.local, jobId);
  if (!job || job.state !== "running") {
    throw exportSourceBatchError(
      job ? "EXPORT_JOB_NOT_RUNNING" : "EXPORT_JOB_NOT_FOUND",
      "Export note job is no longer running.",
      { jobState: job?.state || "" },
    );
  }
  const stored = await chrome.storage.local.get("ytd_notes");
  const notes = Array.isArray(stored?.ytd_notes) ? stored.ytd_notes : [];
  if (exportStoredNotesRevision(notes, job.intent.mediaKeys) !== job.notesRevision) {
    throw exportSourceBatchError(
      "EXPORT_JOB_SOURCE_REVISION_MISMATCH",
      "Stored notes changed after the export job was authorized.",
      { jobState: job.state },
    );
  }
  for (const [mediaKey, revision] of Object.entries(job.sourceRevisions || {})) {
    const source = await YTD_NOTE_SOURCES.readNoteSource(
      chrome.storage.local,
      mediaKey,
    );
    if (!source || !revisionsMatch(source.sourceRevision, revision)) {
      throw exportSourceBatchError(
        "EXPORT_JOB_SOURCE_REVISION_MISMATCH",
        "Stored video material changed after the export job was authorized.",
        { jobState: job.state },
      );
    }
  }
  const settings = await getSettings();
  assertExportSourceStorageGeneration(storageGeneration);
  assertExportProviderSnapshot(job, settings);
  return { job, notes, settings };
}

async function handleTranslateExportNotesBatch(message) {
  requireExportSourceModules();
  const storageGeneration = exportSourceStorageGeneration;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw exportSourceBatchError(
      "INVALID_EXPORT_SOURCE_BATCH",
      "Export note batch must be an object.",
    );
  }
  for (const secretField of [
    "apiKey",
    "aiApiKey",
    "providerApiKey",
    "authorization",
    "credentials",
    "settings",
    "key",
  ]) {
    if (Object.prototype.hasOwnProperty.call(message, secretField)) {
      throw exportSourceBatchError(
        "INVALID_EXPORT_SOURCE_BATCH",
        "Provider credentials are not accepted by this action.",
      );
    }
  }
  const jobId = normalizeExportBatchToken(message.jobId, 80);
  const requestedKeys = Array.isArray(message.unitKeys)
    ? message.unitKeys.map((key) => normalizeExportBatchToken(key, 1024))
    : [];
  const notesRequest = Array.isArray(message.notes) ? message.notes : [];
  const titlesRequest = Array.isArray(message.titles) ? message.titles : [];
  if (
    !jobId ||
    requestedKeys.length < 1 ||
    requestedKeys.length > 10 ||
    requestedKeys.some((key) => !key) ||
    new Set(requestedKeys).size !== requestedKeys.length ||
    (notesRequest.length > 0) === (titlesRequest.length > 0) ||
    requestedKeys.length !== (notesRequest.length || titlesRequest.length)
  ) {
    throw exportSourceBatchError(
      "INVALID_EXPORT_SOURCE_BATCH",
      "Export note batch identity is invalid.",
    );
  }

  let frozen = await assertExportNotesJobCurrent(jobId, storageGeneration);
  const ordered = new Set(frozen.job.orderedUnitKeys || []);
  const completed = new Set(frozen.job.completedUnitKeys || []);
  if (requestedKeys.some((key) => !ordered.has(key) || completed.has(key))) {
    throw exportSourceBatchError(
      "EXPORT_JOB_UNIT_MISMATCH",
      "Export note units do not belong to the current job gap.",
      { jobState: frozen.job.state },
    );
  }

  let canonicalNotes = [];
  let canonicalTitles = [];
  if (notesRequest.length) {
    const byId = new Map(
      frozen.notes.map((note) => [String(note?.id || ""), note]),
    );
    canonicalNotes = notesRequest.map((requested, index) => {
      const stored = byId.get(String(requested?.id || ""));
      if (!stored || exportStoredNoteUnitKey(stored) !== requestedKeys[index]) {
        throw exportSourceBatchError(
          "EXPORT_JOB_UNIT_MISMATCH",
          "Export note text no longer matches its frozen unit.",
          { jobState: frozen.job.state },
        );
      }
      return {
        id: String(stored.id),
        text: exportStoredNoteOriginalText(stored),
        videoTitle: exportStoredNoteTitle(stored),
        rawText: String(stored.rawText || ""),
        sourceLanguage: String(stored.sourceLanguage || ""),
        platform: stored.platform === "bilibili" ? "bilibili" : "youtube",
        textLanguage: String(stored.textLanguage || ""),
      };
    });
  } else {
    const sources = await YTD_NOTE_SOURCES.readAllSources(chrome.storage.local);
    const firstNoteByMedia = new Map();
    frozen.notes.forEach((note) => {
      const mediaKey = String(note?.mediaKey || note?.videoId || "");
      if (mediaKey && !firstNoteByMedia.has(mediaKey)) {
        firstNoteByMedia.set(mediaKey, note);
      }
    });
    canonicalTitles = titlesRequest.map((requested, index) => {
      const mediaKey = normalizeExportBatchToken(requested?.mediaKey, 128);
      const title = String(
        sources[mediaKey]?.titleOriginal ||
          firstNoteByMedia.get(mediaKey)?.videoTitle ||
          "",
      ).trim();
      if (
        !mediaKey ||
        !frozen.job.intent.mediaKeys.includes(mediaKey) ||
        !title ||
        exportStoredTitleUnitKey(mediaKey, title) !== requestedKeys[index]
      ) {
        throw exportSourceBatchError(
          "EXPORT_JOB_UNIT_MISMATCH",
          "Export title no longer matches its frozen unit.",
          { jobState: frozen.job.state },
        );
      }
      return { mediaKey, title };
    });
  }

  const beforeProviderCall = async () => {
    frozen = await assertExportNotesJobCurrent(jobId, storageGeneration);
    if (requestedKeys.some((key) => frozen.job.completedUnitKeys.includes(key))) {
      throw exportSourceBatchError(
        "EXPORT_BATCH_PROGRESS_STALE",
        "Export note progress changed before the provider request.",
        { jobState: frozen.job.state },
      );
    }
    return frozen.settings;
  };
  const result = await handleTranslateNotes(
    { notes: canonicalNotes, titles: canonicalTitles },
    { settings: frozen.settings, beforeProviderCall },
  );
  const translatedCount =
    (Array.isArray(result?.translations) ? result.translations.length : 0) +
    (Array.isArray(result?.titles) ? result.titles.length : 0);
  if (!result?.success || translatedCount !== requestedKeys.length) {
    const failureCode =
      result?.code || result?.titleFailures?.[0]?.code || "";
    return {
      ...result,
      success: translatedCount > 0,
      code: normalizeExportSourceBatchCode(failureCode),
      error: exportSourceBatchSafeMessage(failureCode),
    };
  }
  return { ...result, success: true, code: "OK", error: "" };
}

function sourceUnitHasTranslation(source, unit) {
  if (unit.kind === "description") {
    return (source.descriptionZhChunks || []).some(
      (chunk) =>
        chunk.index === unit.chunkIndex && chunk.sourceHash === unit.sourceHash,
    );
  }
  return (source.transcriptZh || []).some(
    (entry) =>
      entry.segmentId === unit.segmentId &&
      entry.startMs === unit.startMs &&
      entry.sourceHash === unit.sourceHash,
  );
}

function assertExportProviderSnapshot(job, settings) {
  const snapshot = job?.providerSnapshot;
  const provider = resolveActiveProvider(settings);
  const providerId = String(provider?.id || "");
  const modelId = String(provider?.model || "");
  const expectedProviderId = String(
    snapshot?.providerId || snapshot?.provider || "",
  );
  const expectedModelId = String(snapshot?.modelId || snapshot?.model || "");
  const routeKey = `${providerId}:${modelId}`;
  if (
    !snapshot ||
    !expectedProviderId ||
    !expectedModelId ||
    expectedProviderId !== providerId ||
    expectedModelId !== modelId ||
    snapshot.routeKey !== routeKey ||
    snapshot.targetLanguage !== "zh" ||
    snapshot.translationVersion !== "export-v2" ||
    !YTD_SETTINGS.hasActiveApiKey(settings)
  ) {
    throw exportSourceBatchError(
      "EXPORT_JOB_PROVIDER_MISMATCH",
      "The active provider route no longer matches the authorized export job.",
      { jobState: job?.state || "", checkpoint: true },
    );
  }
  return settings;
}

async function authorizeExportSourceProviderCall(
  request,
  batchId,
  storageGeneration,
) {
  if (storageGeneration !== exportSourceStorageGeneration) {
    throw exportSourceBatchError(
      "EXPORT_JOB_NOT_FOUND",
      "Export source storage was cleared before the provider request.",
      { checkpoint: true },
    );
  }
  const source = await YTD_NOTE_SOURCES.readNoteSource(
    chrome.storage.local,
    request.mediaKey,
  );
  const validation = YTD_NOTE_SOURCES.validateExportSourceTranslationUnits(
    source,
    request,
  );
  if (!validation?.valid) {
    throw exportSourceBatchError(
      validation?.code === "REVISION_MISMATCH"
        ? "EXPORT_SOURCE_STALE"
        : "EXPORT_SOURCE_UNIT_MISMATCH",
      `Export source changed before the provider call: ${String(validation?.code || "UNKNOWN")}.`,
      { checkpoint: true },
    );
  }
  const settings = await getSettings();
  const job = assertExportJobMatchesRequest(
    await YTD_EXPORT_JOBS.readExportJob(chrome.storage.local, request.jobId),
    request,
  );
  if (
    job.currentBatch?.batchId !== batchId ||
    !sameUnitKeyList(job.currentBatch?.unitKeys, request.unitKeys)
  ) {
    throw exportSourceBatchError(
      "EXPORT_JOB_NOT_RUNNING",
      "The claimed export batch is no longer active.",
      { jobState: job.state, checkpoint: true },
    );
  }
  if (storageGeneration !== exportSourceStorageGeneration) {
    throw exportSourceBatchError(
      "EXPORT_JOB_NOT_FOUND",
      "Export source storage was cleared before the provider request.",
      { jobState: job.state, checkpoint: true },
    );
  }
  return assertExportProviderSnapshot(job, settings);
}

async function checkpointExportBatchError(jobId, error) {
  try {
    const job = await YTD_EXPORT_JOBS.readExportJob(
      chrome.storage.local,
      jobId,
    );
    if (!job) return null;
    let nextState = null;
    if (job.state === "running") {
      if (error?.code === "EXPORT_JOB_PROVIDER_MISMATCH") {
        nextState = "paused";
      } else if (
        [
          "EXPORT_SOURCE_STALE",
          "EXPORT_JOB_SOURCE_REVISION_MISMATCH",
        ].includes(error?.code)
      ) {
        nextState = "stale";
      } else {
        nextState = "failed";
      }
    }
    const result = await YTD_EXPORT_JOBS.checkpointExportJob(
      chrome.storage.local,
      jobId,
      {
        ...(nextState ? { state: nextState } : {}),
        currentBatch: null,
        lastError: {
          code: normalizeExportSourceBatchCode(error?.code),
          message: exportSourceBatchSafeMessage(
            normalizeExportSourceBatchCode(error?.code),
          ),
          retryable: true,
          at: Date.now(),
        },
      },
    );
    return result.job;
  } catch (_checkpointError) {
    return null;
  }
}

async function executeExportSourceBatch(request) {
  requireExportSourceModules();
  const storageGeneration = exportSourceStorageGeneration;
  let job = assertExportJobMatchesRequest(
    await YTD_EXPORT_JOBS.readExportJob(chrome.storage.local, request.jobId),
    request,
  );
  const completed = new Set(job.completedUnitKeys || []);
  const completedRequestKeys = request.unitKeys.filter((unitKey) =>
    completed.has(unitKey),
  );

  let source = await YTD_NOTE_SOURCES.readNoteSource(
    chrome.storage.local,
    request.mediaKey,
  );
  if (!source) {
    throw exportSourceBatchError(
      "EXPORT_SOURCE_NOT_FOUND",
      "Export source was not found in local storage.",
      { jobState: job.state },
    );
  }
  if (!revisionsMatch(source.sourceRevision, request.sourceRevision)) {
    throw exportSourceBatchError(
      "EXPORT_SOURCE_STALE",
      "Export source revision changed before translation.",
      { jobState: job.state, checkpoint: true },
    );
  }
  let validation = YTD_NOTE_SOURCES.validateExportSourceTranslationUnits(
    source,
    request,
  );
  if (!validation?.valid) {
    throw exportSourceBatchError(
      validation?.code === "REVISION_MISMATCH"
        ? "EXPORT_SOURCE_STALE"
        : validation?.code === "UNIT_ALREADY_TRANSLATED"
          ? "EXPORT_BATCH_PROGRESS_STALE"
          : "EXPORT_SOURCE_UNIT_MISMATCH",
      `Export source unit validation failed: ${String(validation?.code || "UNKNOWN")}.`,
      {
        jobState: job.state,
        checkpoint: validation?.code === "REVISION_MISMATCH",
      },
    );
  }
  let canonicalUnits = validation.units;
  const alreadyTranslated = canonicalUnits.filter((unit) =>
    sourceUnitHasTranslation(source, unit),
  );
  const translatedKeys = new Set(alreadyTranslated.map((unit) => unit.id));
  const durablyCompletedKeys = completedRequestKeys.filter((unitKey) =>
    translatedKeys.has(unitKey),
  );
  if (durablyCompletedKeys.length === request.unitKeys.length) {
    return {
      success: true,
      code: "EXPORT_BATCH_ALREADY_COMPLETED",
      jobState: job.state,
      completedUnitKeys: job.completedUnitKeys,
      remainingCount: exportJobRemainingCount(job),
      actualProviderCalls: 0,
    };
  }
  if (durablyCompletedKeys.length) {
    throw exportSourceBatchError(
      "EXPORT_BATCH_PROGRESS_STALE",
      "This batch mixes durably completed units with units still pending.",
      { jobState: job.state },
    );
  }
  if (alreadyTranslated.length) {
    if (alreadyTranslated.length !== canonicalUnits.length) {
      throw exportSourceBatchError(
        "EXPORT_BATCH_PROGRESS_STALE",
        "The source batch contains a mix of completed and pending units.",
        { jobState: job.state },
      );
    }
    const checkpoint = await YTD_EXPORT_JOBS.checkpointExportJob(
      chrome.storage.local,
      request.jobId,
      {
        completedUnitKeys: request.unitKeys,
        cursor: exportJobCursor(job, [
          ...(job.completedUnitKeys || []),
          ...request.unitKeys,
        ]),
        currentBatch: null,
        lastError: null,
      },
    );
    return {
      success: true,
      code: "EXPORT_BATCH_ALREADY_COMPLETED",
      jobState: checkpoint.job.state,
      completedUnitKeys: checkpoint.job.completedUnitKeys,
      remainingCount: exportJobRemainingCount(checkpoint.job),
      actualProviderCalls: 0,
    };
  }

  const now = Date.now();
  if (
    job.currentBatch?.unitKeys?.length &&
    !sameUnitKeyList(job.currentBatch.unitKeys, request.unitKeys) &&
    job.currentBatch.leaseUntil > now
  ) {
    throw exportSourceBatchError(
      "EXPORT_JOB_BATCH_BUSY",
      "A different export batch still holds the durable lease.",
      { jobState: job.state },
    );
  }
  const batchId = `source-batch-${shortExportBatchHash(
    request.unitKeys.join("\u0000"),
  )}`;
  const claim = await YTD_EXPORT_JOBS.checkpointExportJob(
    chrome.storage.local,
    request.jobId,
    {
      currentBatch: {
        batchId,
        unitKeys: request.unitKeys,
        leaseUntil: now + EXPORT_SOURCE_BATCH_LEASE_MS,
      },
      lastError: null,
    },
  );
  request.batchClaimed = true;
  job = assertExportJobMatchesRequest(claim.job, request);

  // Re-hydrate after claiming the durable batch. The atomic commit performs
  // this validation once more after the provider returns.
  source = await YTD_NOTE_SOURCES.readNoteSource(
    chrome.storage.local,
    request.mediaKey,
  );
  validation = YTD_NOTE_SOURCES.validateExportSourceTranslationUnits(
    source,
    request,
  );
  if (!validation?.valid) {
    throw exportSourceBatchError(
      validation?.code === "REVISION_MISMATCH"
        ? "EXPORT_SOURCE_STALE"
        : validation?.code === "UNIT_ALREADY_TRANSLATED"
          ? "EXPORT_BATCH_PROGRESS_STALE"
          : "EXPORT_SOURCE_UNIT_MISMATCH",
      `Export source changed before provider request: ${String(validation?.code || "UNKNOWN")}.`,
      { jobState: job.state, checkpoint: true },
    );
  }
  canonicalUnits = validation.units;
  const providerSegments = canonicalUnits.map((unit, index) => ({
    id: `export_${index}`,
    text: unit.text,
  }));
  const translated = await handleTranslateContent(
    { segments: providerSegments },
    "transcriptBatch",
    "zh",
    canonicalUnits[0]?.videoTitle || "",
    () =>
      authorizeExportSourceProviderCall(
        request,
        batchId,
        storageGeneration,
      ),
  );
  const actualProviderCalls = Number.isSafeInteger(translated.actualProviderCalls)
    ? translated.actualProviderCalls
    : translated.success
      ? 1
      : 0;
  if (!translated.success) {
    const providerFailureCode = EXPORT_SOURCE_SAFE_ERROR_CODES.has(
      translated.code,
    )
      ? translated.code
      : "EXPORT_SOURCE_PROVIDER_FAILED";
    const error = exportSourceBatchError(
      providerFailureCode,
      translated.error || "The translation provider rejected this batch.",
      { actualProviderCalls, jobState: job.state },
    );
    const failedJob = await checkpointExportBatchError(
      request.jobId,
      error,
    );
    return exportSourceBatchFailure(error, {
      jobState: failedJob?.state || job.state,
      completedUnitKeys: failedJob?.completedUnitKeys || job.completedUnitKeys,
      remainingCount: exportJobRemainingCount(failedJob || job),
      actualProviderCalls,
    });
  }

  const translationsById = new Map();
  const translatedSegments = Array.isArray(translated.translatedContent?.segments)
    ? translated.translatedContent.segments
    : [];
  providerSegments.forEach((providerSegment, index) => {
    const candidate = translatedSegments.find(
      (segment) => segment?.id === providerSegment.id,
    );
    const text = typeof candidate?.text === "string" ? candidate.text.trim() : "";
    if (text) translationsById.set(canonicalUnits[index].id, text);
  });
  if (translationsById.size !== canonicalUnits.length) {
    const error = exportSourceBatchError(
      "EXPORT_SOURCE_BATCH_PARTIAL",
      "The translation provider returned an incomplete source batch.",
      { actualProviderCalls, jobState: job.state },
    );
    const failedJob = await checkpointExportBatchError(
      request.jobId,
      error,
    );
    return exportSourceBatchFailure(error, {
      jobState: failedJob?.state || job.state,
      completedUnitKeys: failedJob?.completedUnitKeys || job.completedUnitKeys,
      remainingCount: exportJobRemainingCount(failedJob || job),
      actualProviderCalls,
    });
  }

  let latestJob;
  try {
    latestJob = assertExportJobMatchesRequest(
      await YTD_EXPORT_JOBS.readExportJob(chrome.storage.local, request.jobId),
      request,
      { mustRun: false },
    );
  } catch (error) {
    error.actualProviderCalls = actualProviderCalls;
    error.checkpoint = true;
    throw error;
  }
  if (!["running", "cancelled"].includes(latestJob.state)) {
    throw exportSourceBatchError(
      "EXPORT_JOB_NOT_RUNNING",
      "The export job stopped before this response could be committed.",
      {
        actualProviderCalls,
        jobState: latestJob.state,
        checkpoint: true,
      },
    );
  }
  if (storageGeneration !== exportSourceStorageGeneration) {
    throw exportSourceBatchError(
      "EXPORT_JOB_NOT_FOUND",
      "Export source storage was cleared while the request was in flight.",
      {
        actualProviderCalls,
        jobState: latestJob.state,
        checkpoint: true,
      },
    );
  }

  const commit = await YTD_NOTE_SOURCES.commitExportSourceTranslationBatch(
    chrome.storage.local,
    {
      mediaKey: request.mediaKey,
      expectedRevision: request.sourceRevision,
      units: canonicalUnits,
      translationsById,
    },
    { protectedKeys: new Set(latestJob.intent.mediaKeys) },
  );
  if (commit?.stale) {
    throw exportSourceBatchError(
      "EXPORT_SOURCE_STALE",
      "The export source changed while the provider request was in flight.",
      {
        actualProviderCalls,
        jobState: latestJob.state,
        checkpoint: true,
      },
    );
  }
  if (
    commit?.code !== "OK" ||
    commit.appliedUnitIds?.length !== canonicalUnits.length
  ) {
    throw exportSourceBatchError(
      "EXPORT_SOURCE_BATCH_COMMIT_FAILED",
      `The source batch was not committed: ${String(commit?.code || "UNKNOWN")}.`,
      {
        actualProviderCalls,
        jobState: latestJob.state,
        checkpoint: true,
      },
    );
  }

  // Deliberately omit a state patch. If cancellation won the race, the export
  // job module unions this progress while preserving `cancelled`; no next batch
  // or auto-export can be started by this background action.
  const completedUnitKeys = [
    ...(latestJob.completedUnitKeys || []),
    ...request.unitKeys,
  ];
  const checkpoint = await YTD_EXPORT_JOBS.checkpointExportJob(
    chrome.storage.local,
    request.jobId,
    {
      completedUnitKeys: request.unitKeys,
      cursor: exportJobCursor(latestJob, completedUnitKeys),
      currentBatch: null,
      lastError: null,
    },
  );
  return {
    success: true,
    code:
      checkpoint.job.state === "cancelled"
        ? "EXPORT_CANCELLED_BATCH_COMMITTED"
        : "OK",
    jobState: checkpoint.job.state,
    completedUnitKeys: checkpoint.job.completedUnitKeys,
    remainingCount: exportJobRemainingCount(checkpoint.job),
    actualProviderCalls,
  };
}

async function handleTranslateExportSourceBatch(message) {
  let request;
  try {
    request = validateExportSourceBatchRequest(message);
  } catch (error) {
    return exportSourceBatchFailure(error);
  }
  return runExportSourceBatchSingleFlight(request);
}

async function handleCancelExportTranslationJob(jobId) {
  requireExportSourceModules();
  const normalizedJobId = normalizeExportBatchToken(jobId, 80);
  if (!normalizedJobId) {
    return exportSourceBatchFailure(
      exportSourceBatchError("INVALID_EXPORT_SOURCE_BATCH", "Invalid job id."),
    );
  }
  const job = await YTD_EXPORT_JOBS.readExportJob(
    chrome.storage.local,
    normalizedJobId,
  );
  if (!job) {
    return exportSourceBatchFailure(
      exportSourceBatchError("EXPORT_JOB_NOT_FOUND", "Export job not found."),
    );
  }
  if (job.state === "cancelled") {
    return {
      success: true,
      code: "EXPORT_JOB_CANCELLED",
      jobState: job.state,
      completedUnitKeys: job.completedUnitKeys,
      remainingCount: exportJobRemainingCount(job),
      actualProviderCalls: 0,
    };
  }
  if (!["planned", "running", "paused", "failed"].includes(job.state)) {
    return exportSourceBatchFailure(
      exportSourceBatchError(
        "EXPORT_JOB_NOT_RUNNING",
        `Export job cannot be cancelled from ${job.state}.`,
        { jobState: job.state },
      ),
      {
        jobState: job.state,
        completedUnitKeys: job.completedUnitKeys,
        remainingCount: exportJobRemainingCount(job),
      },
    );
  }
  const checkpoint = await YTD_EXPORT_JOBS.checkpointExportJob(
    chrome.storage.local,
    normalizedJobId,
    { state: "cancelled", currentBatch: null, exportClaim: null },
  );
  return {
    success: true,
    code: "EXPORT_JOB_CANCELLED",
    jobState: checkpoint.job.state,
    completedUnitKeys: checkpoint.job.completedUnitKeys,
    remainingCount: exportJobRemainingCount(checkpoint.job),
    actualProviderCalls: 0,
  };
}

async function handleGetExportTranslationJob(jobId) {
  requireExportSourceModules();
  const normalizedJobId = normalizeExportBatchToken(jobId, 80);
  if (!normalizedJobId) {
    return exportSourceBatchFailure(
      exportSourceBatchError("INVALID_EXPORT_SOURCE_BATCH", "Invalid job id."),
    );
  }
  const job = await YTD_EXPORT_JOBS.readExportJob(
    chrome.storage.local,
    normalizedJobId,
  );
  if (!job) {
    return exportSourceBatchFailure(
      exportSourceBatchError("EXPORT_JOB_NOT_FOUND", "Export job not found."),
    );
  }
  return { success: true, code: "OK", job };
}

async function handleListExportTranslationJobs() {
  requireExportSourceModules();
  const jobs = await YTD_EXPORT_JOBS.readExportJobs(chrome.storage.local);
  return {
    success: true,
    code: "OK",
    jobs: Object.values(jobs || {}).sort(
      (left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0),
    ),
  };
}

function assertOnlyExportJobFields(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw exportSourceBatchError(code, "Export job metadata must be an object.");
  }
  if (Object.keys(value).some((field) => !allowed.includes(field))) {
    throw exportSourceBatchError(
      code,
      "Export job metadata contains an unsupported field.",
    );
  }
  return value;
}

const EXPORT_JOB_INPUT_FIELDS = [
  "schemaVersion",
  "jobId",
  "state",
  "intent",
  "sourceRevisions",
  "notesRevision",
  "orderedUnitKeys",
  "completedUnitKeys",
  "currentBatch",
  "cursor",
  "roundBudget",
  "providerSnapshot",
  "exportClaim",
  "lastError",
  "updatedAt",
];
const EXPORT_JOB_PATCH_FIELDS = [
  "state",
  "completedUnitKeys",
  "currentBatch",
  "cursor",
  "exportClaim",
  "lastError",
];

async function handleCreateOrResumeExportJob(jobInput) {
  requireExportSourceModules();
  const storageGeneration = exportSourceStorageGeneration;
  assertOnlyExportJobFields(
    jobInput,
    EXPORT_JOB_INPUT_FIELDS,
    "INVALID_EXPORT_JOB",
  );
  let candidate = YTD_EXPORT_JOBS.normalizeExportJob(jobInput);
  if (!candidate) candidate = YTD_EXPORT_JOBS.createExportJob(jobInput);
  const existing = await YTD_EXPORT_JOBS.readExportJob(
    chrome.storage.local,
    candidate.jobId,
  );
  assertExportSourceStorageGeneration(storageGeneration);
  let result = await YTD_EXPORT_JOBS.upsertExportJob(
    chrome.storage.local,
    candidate,
  );
  assertExportSourceStorageGeneration(storageGeneration);
  const stored = result.job;
  if (stored && existing) {
    // Never clear a running job's durable lease/claim from a duplicate resume.
    // Resuming a stopped job is an explicit state transition after the frozen
    // fields have been revalidated by upsertExportJob above.
    if (stored.state === "running") {
      return {
        success: true,
        code: "OK",
        changed: result.changed === true,
        job: stored,
      };
    }
    if (["ready_to_export", "completed", "stale"].includes(stored.state)) {
      if (candidate.state !== stored.state) {
        throw exportSourceBatchError(
          "EXPORT_JOB_NOT_RESUMABLE",
          `Export job cannot resume from ${stored.state}.`,
          { jobState: stored.state },
        );
      }
    } else if (
      ["planned", "paused", "failed", "cancelled"].includes(stored.state) &&
      ["planned", "running", "paused"].includes(candidate.state)
    ) {
      assertExportSourceStorageGeneration(storageGeneration);
      result = await YTD_EXPORT_JOBS.checkpointExportJob(
        chrome.storage.local,
        candidate.jobId,
        {
          state: candidate.state,
          completedUnitKeys: candidate.completedUnitKeys,
          currentBatch: null,
          cursor: candidate.cursor,
          exportClaim: null,
          lastError: null,
        },
        { allowCancelledResume: stored.state === "cancelled" },
      );
    }
  }
  return {
    success: true,
    code: "OK",
    changed: result.changed === true,
    job: result.job,
  };
}

async function handleCheckpointExportJob(jobId, patchInput) {
  requireExportSourceModules();
  const normalizedJobId = normalizeExportBatchToken(jobId, 80);
  if (!normalizedJobId) {
    throw exportSourceBatchError("INVALID_EXPORT_JOB", "Invalid export job id.");
  }
  assertOnlyExportJobFields(
    patchInput,
    EXPORT_JOB_PATCH_FIELDS,
    "INVALID_EXPORT_JOB_PATCH",
  );
  const patch = {};
  EXPORT_JOB_PATCH_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(patchInput, field)) {
      patch[field] = patchInput[field];
    }
  });
  if (patch.lastError) {
    const code = normalizeExportSourceBatchCode(patch.lastError.code);
    patch.lastError = {
      code,
      message: exportSourceBatchSafeMessage(code),
      retryable: patch.lastError.retryable !== false,
      at:
        Number.isSafeInteger(patch.lastError.at) && patch.lastError.at >= 0
          ? patch.lastError.at
          : Date.now(),
    };
  }
  const result = await YTD_EXPORT_JOBS.checkpointExportJob(
    chrome.storage.local,
    normalizedJobId,
    patch,
    {
      requireEmptyExportClaim:
        patch.state === "ready_to_export" && !!patch.exportClaim,
    },
  );
  return {
    success: true,
    code: "OK",
    changed: result.changed === true,
    job: result.job,
  };
}

async function handleUpsertNoteSource(sourceInput) {
  requireExportSourceModules();
  const storageGeneration = exportSourceStorageGeneration;
  const source = YTD_NOTE_SOURCES.normalizeNoteSource(sourceInput);
  if (!source) {
    return exportSourceBatchFailure(
      exportSourceBatchError(
        "INVALID_EXPORT_SOURCE_BATCH",
        "Note source is invalid.",
      ),
    );
  }
  const stored = await chrome.storage.local.get("ytd_notes");
  assertExportSourceStorageGeneration(storageGeneration);
  const protectedKeys = new Set(
    (Array.isArray(stored?.ytd_notes) ? stored.ytd_notes : [])
      .map((note) => String(note?.mediaKey || note?.videoId || "").trim())
      .filter(Boolean),
  );
  protectedKeys.add(source.mediaKey);
  const result = await YTD_NOTE_SOURCES.writeNoteSource(
    chrome.storage.local,
    source,
    { protectedKeys },
  );
  assertExportSourceStorageGeneration(storageGeneration);
  const persisted = await YTD_NOTE_SOURCES.readNoteSource(
    chrome.storage.local,
    source.mediaKey,
  );
  if (!persisted) {
    throw exportSourceBatchError(
      "EXPORT_SOURCE_BATCH_COMMIT_FAILED",
      "Note source was not persisted.",
    );
  }
  return {
    success: true,
    code: "OK",
    changed: result?.changed === true,
    mediaKey: persisted.mediaKey,
    sourceRevision: persisted.sourceRevision,
    source: persisted,
  };
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - A safe BCP-47 translation target
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  const normalizedTarget = normalizeLanguageCode(targetLanguage);
  if (
    !normalizedTarget ||
    isNonTranslatableLanguage(normalizedTarget)
  ) {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = isChineseLanguage(normalizedTarget)
    ? "Simplified Chinese"
    : getSafeLanguageName(normalizedTarget);
  const langSpecific = isChineseLanguage(normalizedTarget)
    ? await loadPromptSection("translation.md", "Chinese rules")
    : "";
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

function transcriptTranslationMaxTokens(sourceSegments) {
  const totalCharacters = sourceSegments.reduce(
    (sum, segment) => sum + segment.text.length,
    0,
  );
  // Short on-screen batches keep the established 1536-token budget. Export
  // completion can legitimately send up to 12k source characters, so scale the
  // output allowance rather than truncating a valid JSON object mid-string.
  return Math.min(
    8192,
    Math.max(1536, Math.ceil(totalCharacters * 0.8) + 512),
  );
}

function parseTranscriptTranslation(text, sourceSegments) {
  try {
    const parsed = parseLooseJson(text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    return {
      success: aligned.segments.some((segment) => segment.text),
      translatedContent: aligned,
    };
  } catch (_error) {
    return { success: false, translatedContent: null };
  }
}

function validateOverviewOriginalTranslationRequest(analysis, targetLanguage) {
  if (
    analysis?.schemaVersion !== ANALYSIS_SCHEMA_VERSION ||
    analysis?.baseLanguage !== ANALYSIS_BASE_LANGUAGE ||
    !hasUsableChineseOverview(analysis)
  ) {
    throw new Error("Overview translation requires the current Chinese-base schema");
  }
  const sourceLanguage = normalizeLanguageCode(analysis?.sourceLanguage);
  const normalizedTarget = normalizeLanguageCode(targetLanguage);
  if (
    !sourceLanguage ||
    isNonTranslatableLanguage(sourceLanguage) ||
    !normalizedTarget ||
    normalizedTarget !== sourceLanguage
  ) {
    throw new Error(
      "Overview translation target must match the source caption language",
    );
  }
  if (isConfirmedSimplifiedChineseSource(sourceLanguage)) {
    throw new Error(
      "Simplified Chinese source overviews do not require translation",
    );
  }

  const chapters = Array.isArray(analysis?.chapters)
    ? analysis.chapters.slice(0, 100)
    : [];
  if (!chapters.length) {
    throw new Error("Overview translation requires chapters");
  }

  let totalCharacters = 0;
  const normalizedChapters = chapters.map((chapter, index) => {
    const titleZh =
      typeof chapter?.titleZh === "string"
        ? chapter.titleZh.trim().slice(0, 300)
        : "";
    const summaryZh =
      typeof chapter?.summaryZh === "string"
        ? chapter.summaryZh.trim().slice(0, 1500)
        : "";
    if (!titleZh || !summaryZh) {
      throw new Error("Overview chapter text is missing or invalid");
    }
    totalCharacters += titleZh.length + summaryZh.length;
    return { id: `chapter-${index}`, titleZh, summaryZh };
  });
  if (totalCharacters > 80_000) {
    throw new Error("Overview translation input is too large");
  }
  return { targetLanguage: sourceLanguage, chapters: normalizedChapters };
}

function normalizeOverviewOriginalTranslation(parsed, source) {
  const chapterCandidates = new Map(
    (Array.isArray(parsed?.chapters) ? parsed.chapters : [])
      .filter((item) => typeof item?.id === "string")
      .map((item) => [item.id, item]),
  );

  return {
    chapters: source.chapters.map((chapter) => {
      const candidate = chapterCandidates.get(chapter.id);
      const titleOriginal =
        typeof candidate?.titleOriginal === "string"
          ? candidate.titleOriginal.trim().slice(0, 300)
          : "";
      const summaryOriginal =
        typeof candidate?.summaryOriginal === "string"
          ? candidate.summaryOriginal.trim().slice(0, 1500)
          : "";
      const targetPrimary = source.targetLanguage.split("-")[0].toLowerCase();
      const targetPattern =
        targetPrimary === "en"
          ? /[A-Za-z]/
          : targetPrimary === "ja"
            ? /[\u3040-\u30ff]/
            : targetPrimary === "ko"
              ? /[\uac00-\ud7af]/
              : null;
      const validSummary =
        summaryOriginal &&
        summaryOriginal !== chapter.summaryZh &&
        (!targetPattern || targetPattern.test(summaryOriginal));
      return {
        id: chapter.id,
        titleOriginal,
        summaryOriginal: validSummary ? summaryOriginal : "",
      };
    }),
  };
}

async function handleTranslateOverviewOriginal(
  analysis,
  videoTitle,
  targetLanguage,
) {
  try {
    const settings = await getSettings();
    if (!YTD_SETTINGS.hasActiveApiKey(settings)) {
      return {
        success: false,
        error: `尚未配置${providerDisplayLabel(settings)} API 密钥`,
      };
    }

    const source = validateOverviewOriginalTranslationRequest(
      analysis,
      targetLanguage,
    );
    const langName = getSafeLanguageName(source.targetLanguage);
    const baseRules = await getTranslationBaseRules(source.targetLanguage);
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Overview original translation",
      {
        langName,
        languageCode: source.targetLanguage,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const options = {
      temperature: 0.2,
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      JSON.stringify(source),
      options,
    );
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, JSON.stringify(source), {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      });
    }
    if (!result.success) return result;

    const originalOverview = normalizeOverviewOriginalTranslation(
      parseLooseJson(result.text),
      source,
    );
    const complete = originalOverview.chapters.every(
      (chapter) => chapter.titleOriginal && chapter.summaryOriginal,
    );
    if (!complete) {
      return { success: false, error: "原文概览翻译不完整，请重试。" };
    }
    return { success: true, originalOverview };
  } catch (error) {
    return { success: false, error: error.message || "原文概览生成失败" };
  }
}

function stripQuotedNonChineseScripts(text) {
  return String(text || "").replace(
    /《[^》]*》|「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g,
    (quoted) =>
      /[\u3040-\u30ff\uac00-\ud7af]/.test(quoted) ? "" : quoted,
  );
}

function noteHasChineseSource(note) {
  if (isChineseLanguage(note?.textLanguage)) {
    return note?.platform === "bilibili"
      ? isConfirmedSimplifiedChineseSource(note.textLanguage)
      : true;
  }
  const language = String(note?.sourceLanguage || "").trim();
  const rawText = String(note?.rawText || "");
  const primary = normalizeLanguageCode(language).split("-")[0];
  if (primary && !["und", "mul", "zxx"].includes(primary)) {
    if (note?.platform === "bilibili" && isChineseLanguage(language)) {
      return isConfirmedSimplifiedChineseSource(language);
    }
    return isChineseLanguage(language);
  }
  const heuristicText = stripQuotedNonChineseScripts(rawText);
  const cjkCount = (heuristicText.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (heuristicText.match(/[A-Za-z]/g) || []).length;
  const hasJapaneseKana = /[\u3040-\u30ff]/.test(heuristicText);
  const hasHangul = /[\uac00-\ud7af]/.test(heuristicText);
  return (
    !hasJapaneseKana &&
    !hasHangul &&
    cjkCount >= 1 &&
    cjkCount * 2 >= latinCount
  );
}

function validateNoteTranslationRequest(notes) {
  if (!Array.isArray(notes) || notes.length < 1 || notes.length > 10) {
    throw new Error("Note translation requires 1 to 10 notes");
  }
  let totalCharacters = 0;
  const seenIds = new Set();
  const normalized = notes.map((note) => {
    const id = typeof note?.id === "string" ? note.id.trim() : "";
    const text = typeof note?.text === "string" ? note.text.trim() : "";
    const videoTitle =
      typeof note?.videoTitle === "string"
        ? note.videoTitle.trim().slice(0, 500)
        : "";
    const rawText =
      typeof note?.rawText === "string" ? note.rawText.trim().slice(0, 3000) : "";
    const sourceLanguage =
      typeof note?.sourceLanguage === "string"
        ? note.sourceLanguage.trim().slice(0, 20)
        : "";
    const textLanguage = normalizeLanguageCode(note?.textLanguage);
    const rawPlatform =
      typeof note?.platform === "string" ? note.platform.trim() : "";
    if (rawPlatform && !["youtube", "bilibili"].includes(rawPlatform)) {
      throw new Error("Note translation platform is invalid");
    }
    const platform = rawPlatform || "youtube";
    if (
      !/^[A-Za-z0-9:_-]{1,128}$/.test(id) ||
      seenIds.has(id) ||
      !text ||
      text.length > 3000
    ) {
      throw new Error("Note translation input is missing or invalid");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return {
      id,
      text,
      videoTitle,
      rawText,
      sourceLanguage,
      platform,
      textLanguage,
    };
  });
  if (totalCharacters > 30_000) {
    throw new Error("Note translation input is too large");
  }
  return normalized;
}

function canonicalNoteText(text) {
  return String(text || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function notePhraseAppearsInTitle(text, videoTitle) {
  const phraseTokens =
    canonicalNoteText(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const titleTokens =
    canonicalNoteText(videoTitle).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!phraseTokens.length || phraseTokens.length > titleTokens.length) {
    return false;
  }
  return titleTokens.some((_, start) =>
    phraseTokens.every(
      (token, offset) => titleTokens[start + offset] === token,
    ),
  );
}

const NOTE_UNCHANGED_TERMS = new Set([
  "ai",
  "api",
  "bash",
  "builder",
  "chrome",
  "claude",
  "code",
  "codex",
  "css",
  "deepseek",
  "deck",
  "dev",
  "feature",
  "flag",
  "git",
  "github",
  "gpt",
  "gpt-4o",
  "html",
  "http",
  "https",
  "javascript",
  "json",
  "llm",
  "localhost",
  "mcp",
  "node",
  "npm",
  "npx",
  "openai",
  "pnpm",
  "python",
  "rollout",
  "skill",
  "sql",
  "test",
  "typescript",
  "ui",
  "url",
  "ux",
  "yarn",
  "youtube",
  "zsh",
]);

const NOTE_COMMON_ENGLISH_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "be",
  "but",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "not",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "use",
  "was",
  "we",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

function noteMayRemainUnchanged(text, videoTitle, unchangedKind) {
  const value = String(text || "");
  const tokens = value.match(/[A-Za-z][A-Za-z0-9.+#-]*/g) || [];
  if (unchangedKind === "technical") {
    return tokens.length
      ? tokens.every(isNoteTechnicalToken)
      : /^[\d\s:./+\-]+$/.test(value.trim());
  }
  if (unchangedKind !== "proper_noun") return false;
  const properTokens =
    canonicalNoteText(value).match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  return (
    notePhraseAppearsInTitle(text, videoTitle) &&
    properTokens.length > 0 &&
    properTokens.length <= 6 &&
    properTokens.every(
      (token) =>
        /^\p{Lu}[\p{L}\p{M}]*$/u.test(token) &&
        !NOTE_COMMON_ENGLISH_WORDS.has(token.toLowerCase()),
    )
  );
}

function isNoteTechnicalToken(token) {
  const lower = String(token || "").toLowerCase();
  if (NOTE_COMMON_ENGLISH_WORDS.has(lower)) return false;
  return (
    NOTE_UNCHANGED_TERMS.has(lower) ||
    /[a-z][A-Z]/.test(token) ||
    /\d/.test(token)
  );
}

function looksLikeUsableChineseNote(text) {
  const value = stripQuotedNonChineseScripts(text);
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(value)) return false;
  const cjkCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
  if (cjkCount < 1) return false;
  const nonTechnicalLatinCount = (
    value.match(/[A-Za-z][A-Za-z0-9.+#-]*/g) || []
  )
    .filter((token) => !isNoteTechnicalToken(token))
    .join("").length;
  return nonTechnicalLatinCount <= cjkCount * 2;
}

function extractSingleLabeledChineseText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chineseLines = lines
    .map((line) =>
      line.match(/^(?:中文(?:翻译)?|译文)\s*[:：]\s*(.+?)\s*$/i),
    )
    .filter(Boolean);
  if (chineseLines.length !== 1) return "";
  if (lines.length === 1) return chineseLines[0][1].trim();

  const labeledLineCount = lines.filter((line) =>
    /^(?:(?:中文(?:翻译)?|译文)|(?:English|Original|原文))\s*[:：]/i.test(
      line,
    ),
  ).length;
  const hasOriginalLabel = lines.some((line) =>
    /^(?:English|Original|原文)\s*[:：]/i.test(line),
  );
  return hasOriginalLabel && labeledLineCount === lines.length
    ? chineseLines[0][1].trim()
    : "";
}

function hasExplicitBilingualLabels(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.some((line) => /^(?:English|Original|原文)\s*[:：]/i.test(line)) &&
    lines.some((line) => /^(?:中文(?:翻译)?|译文)\s*[:：]/i.test(line))
  );
}

function validateNoteTranslationCandidate(candidate, source) {
  let textZh =
    typeof candidate?.textZh === "string" ? candidate.textZh.trim() : "";
  if (!textZh) return { textZh: "", failureCode: "EMPTY_RESPONSE" };
  if (hasExplicitBilingualLabels(textZh)) {
    return { textZh: "", unchanged: false, failureCode: "INVALID_TRANSLATION" };
  }
  if (looksLikeUsableChineseNote(textZh)) {
    return { textZh, unchanged: false, failureCode: "" };
  }

  // A note made entirely of proper nouns, code, product names, or timestamps
  // may legitimately remain unchanged. The model must opt into that narrow
  // case explicitly, and the value must still equal the source exactly after
  // harmless Unicode/whitespace normalization.
  if (
    candidate?.unchanged === true &&
    ["technical", "proper_noun"].includes(candidate?.unchangedKind) &&
    canonicalNoteText(textZh) === canonicalNoteText(source.text) &&
    noteMayRemainUnchanged(
      source.text,
      source.videoTitle,
      candidate.unchangedKind,
    )
  ) {
    return { textZh: source.text, unchanged: true, failureCode: "" };
  }
  return { textZh: "", unchanged: false, failureCode: "INVALID_TRANSLATION" };
}

function normalizeNoteTranslation(
  parsed,
  sourceNotes,
  { allowSingletonIdRecovery = false } = {},
) {
  const rawCandidates = Array.isArray(parsed?.notes) ? parsed.notes : [];
  const candidates = new Map();
  const duplicateIds = new Set();
  rawCandidates.forEach((candidate) => {
    const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
    if (!id) return;
    if (candidates.has(id)) {
      duplicateIds.add(id);
      return;
    }
    candidates.set(id, candidate);
  });

  return sourceNotes.map((source) => {
    let candidate = duplicateIds.has(source.id)
      ? null
      : candidates.get(source.id);
    let failureCode = duplicateIds.has(source.id)
      ? "MULTIPLE_CANDIDATES"
      : candidate
        ? ""
        : "MISSING_ITEM";
    if (
      !candidate &&
      allowSingletonIdRecovery &&
      sourceNotes.length === 1 &&
      rawCandidates.length === 1
    ) {
      candidate = rawCandidates[0];
      failureCode = "ID_MISMATCH";
    }
    if (!candidate) {
      return { id: source.id, textZh: "", unchanged: false, failureCode };
    }

    const validated = validateNoteTranslationCandidate(candidate, source);
    return {
      id: source.id,
      textZh: validated.textZh,
      unchanged: validated.unchanged === true,
      failureCode: validated.failureCode || "",
    };
  });
}

function parseSingletonNoteJson(text) {
  let cleaned = String(text || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch (_error) {
    return parseLooseJson(text);
  }
}

function singletonNoteCandidate(parsed) {
  if (typeof parsed === "string") return { textZh: parsed };
  let candidate = parsed;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) return null;
    [candidate] = parsed;
  } else if (Array.isArray(parsed?.notes)) {
    if (parsed.notes.length !== 1) return null;
    [candidate] = parsed.notes;
  } else if (parsed?.note && typeof parsed.note === "object") {
    candidate = parsed.note;
  }
  if (!candidate || typeof candidate !== "object") return null;

  const values = [
    candidate.textZh,
    candidate.translation,
    candidate.translatedText,
    candidate.translated,
    candidate.text,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  const uniqueValues = [...new Set(values.map(canonicalNoteText))];
  if (uniqueValues.length !== 1) return null;
  return { ...candidate, textZh: values[0] };
}

function plainSingletonNoteText(text) {
  let cleaned = String(text || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:text|markdown)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }
  // Never reinterpret malformed structured output as prose; braces or array
  // delimiters could otherwise be persisted verbatim as a "translation".
  if (/[{}\[\]]/.test(cleaned)) return "";
  const labeledChinese = extractSingleLabeledChineseText(cleaned);
  if (labeledChinese) return labeledChinese;
  cleaned = cleaned
    .replace(/^(?:以下是(?:中文)?翻译|翻译结果|中文翻译|翻译|译文)\s*[:：]\s*/i, "")
    .trim();
  const matchingQuotes = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
  ];
  for (const [start, end] of matchingQuotes) {
    if (cleaned.startsWith(start) && cleaned.endsWith(end)) {
      cleaned = cleaned.slice(start.length, -end.length).trim();
      break;
    }
  }
  return cleaned;
}

function normalizeSingletonNoteTranslationResponse(text, source) {
  let parsed;
  try {
    parsed = parseSingletonNoteJson(text);
    if (
      (Array.isArray(parsed) && parsed.length !== 1) ||
      (Array.isArray(parsed?.notes) && parsed.notes.length !== 1)
    ) {
      return {
        id: source.id,
        textZh: "",
        unchanged: false,
        failureCode: "MULTIPLE_CANDIDATES",
      };
    }
    const standard = normalizeNoteTranslation(parsed, [source], {
      allowSingletonIdRecovery: true,
    })[0];
    if (standard?.textZh) return standard;

    let candidate = singletonNoteCandidate(parsed);
    if (!candidate) {
      return {
        id: source.id,
        textZh: "",
        unchanged: false,
        failureCode: standard?.failureCode || "MISSING_ITEM",
      };
    }
    const labeledChinese = extractSingleLabeledChineseText(candidate.textZh);
    if (labeledChinese) candidate = { ...candidate, textZh: labeledChinese };
    const validated = validateNoteTranslationCandidate(candidate, source);
    return {
      id: source.id,
      textZh: validated.textZh,
      unchanged: validated.unchanged === true,
      failureCode: validated.failureCode || "",
    };
  } catch (_error) {
    const plainText = plainSingletonNoteText(text);
    if (!plainText) {
      return {
        id: source.id,
        textZh: "",
        unchanged: false,
        failureCode: "INVALID_JSON",
      };
    }
    const validated = validateNoteTranslationCandidate(
      { textZh: plainText },
      source,
    );
    return {
      id: source.id,
      textZh: validated.textZh,
      unchanged: false,
      failureCode: validated.failureCode || "",
    };
  }
}

function noteTranslationUserContent(notes) {
  return JSON.stringify({
    notes: notes.map(({ id, text, videoTitle }) => ({ id, text, videoTitle })),
  });
}

function persistNoteTranslations(translatedById, job) {
  return withNoteStorageWrite(async () => {
    const stored = job
      ? await waitForNoteJobDeadline(
          job,
          () => chrome.storage.local.get("ytd_notes"),
        )
      : await chrome.storage.local.get("ytd_notes");
    const storedNotes = Array.isArray(stored.ytd_notes) ? stored.ytd_notes : [];
    const updatedNotes = storedNotes.map((note) =>
      translatedById.has(note.id)
        ? {
            ...note,
            translatedText: translatedById.get(note.id).textZh,
            translatedUnchanged:
              translatedById.get(note.id).unchanged === true,
            translatedValidated: true,
            translatedValidationVersion:
              NOTE_TRANSLATION_VALIDATION_VERSION,
          }
        : note,
    );
    if (job && noteJobRemainingMs(job) <= 0) {
      const error = new Error("笔记翻译任务超时，请重试。");
      error.code = "NOTE_JOB_TIMEOUT";
      job.stopCode = error.code;
      throw error;
    }
    // Once the commit starts it must remain inside the shared storage queue.
    // Chrome Storage has no cancellation API; releasing the queue early could
    // let a later delete/save race with a late translation write.
    await chrome.storage.local.set({ ytd_notes: updatedNotes });
  });
}

let noteTranslationQueue = Promise.resolve();
let noteTranslationCooldownUntil = 0;

const NOTE_TRANSLATION_MAX_PROVIDER_CALLS = 5;
const NOTE_TRANSLATION_RATE_LIMIT_BACKOFF_MS = 1_000;
const NOTE_TRANSLATION_RATE_LIMIT_COOLDOWN_MS = 5_000;
const NOTE_TRANSLATION_VALIDATION_VERSION = 1;
const NOTE_TITLE_TRANSLATION_VALIDATION_VERSION = 1;
const NOTE_TITLE_MEDIA_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
const NOTE_TITLE_TRANSLATION_MAX_TITLES = 10;

function noteFailureCode(result, fallback = "PROVIDER_ERROR") {
  if (EXPORT_SOURCE_SAFE_ERROR_CODES.has(result?.code)) return result.code;
  if (result?.code === "RATE_LIMITED") return "RATE_LIMITED";
  if (result?.code === "NOTE_JOB_TIMEOUT") return "NOTE_JOB_TIMEOUT";
  if (result?.code === "PROVIDER_TIMEOUT") return "PROVIDER_TIMEOUT";
  if (
    [
      "OUTPUT_TRUNCATED",
      "CONTENT_FILTERED",
      "PROVIDER_UNAVAILABLE",
      "UNEXPECTED_FINISH_REASON",
    ].includes(result?.code)
  ) {
    return result.code;
  }
  if (
    result?.code === "AI_IDLE_TIMEOUT" ||
    result?.code === "AI_HARD_TIMEOUT"
  ) {
    return "PROVIDER_TIMEOUT";
  }
  if (result?.code === "EMPTY_AI_RESPONSE") return "EMPTY_RESPONSE";
  if (result?.code === "RETRY_BUDGET_EXHAUSTED") {
    return "RETRY_BUDGET_EXHAUSTED";
  }
  return fallback;
}

function createNoteTranslationJob(dependencies = {}) {
  const now = dependencies.now || Date.now;
  return {
    providerCalls: 0,
    rateLimitRetries: 0,
    emptyFallbacks: 0,
    stopCode: "",
    settings: dependencies.settings || null,
    beforeProviderCall:
      typeof dependencies.beforeProviderCall === "function"
        ? dependencies.beforeProviderCall
        : null,
    deadlineAt:
      Number.isFinite(dependencies.deadlineAt)
        ? dependencies.deadlineAt
        : now() + NOTE_TRANSLATION_JOB_TIMEOUT_MS,
    now,
    wait:
      dependencies.wait ||
      ((delay) => new Promise((resolve) => setTimeout(resolve, delay))),
  };
}

function noteJobRemainingMs(job) {
  return Math.max(0, job.deadlineAt - job.now());
}

function stopNoteJobForTimeout(job) {
  job.stopCode = "NOTE_JOB_TIMEOUT";
  return {
    success: false,
    code: job.stopCode,
    error: "笔记翻译任务超时，请重试。",
  };
}

function waitForNoteJobDeadline(job, operation) {
  const remainingMs = noteJobRemainingMs(job);
  if (remainingMs <= 0) {
    const error = new Error("笔记翻译任务超时，请重试。");
    error.code = "NOTE_JOB_TIMEOUT";
    job.stopCode = error.code;
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };
    const timeoutId = setTimeout(() => {
      const error = new Error("笔记翻译任务超时，请重试。");
      error.code = "NOTE_JOB_TIMEOUT";
      job.stopCode = error.code;
      finish(reject, error);
    }, remainingMs);
    let operationPromise;
    try {
      operationPromise = operation();
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(operationPromise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function callNoteTranslationProvider(
  job,
  systemPrompt,
  userContent,
  options,
) {
  if (job.stopCode) {
    return { success: false, code: job.stopCode, error: job.stopCode };
  }
  const remainingMs = noteJobRemainingMs(job);
  if (remainingMs <= 0) return stopNoteJobForTimeout(job);
  if (job.providerCalls >= NOTE_TRANSLATION_MAX_PROVIDER_CALLS) {
    job.stopCode = "RETRY_BUDGET_EXHAUSTED";
    return {
      success: false,
      code: job.stopCode,
      error: "笔记翻译重试次数已达上限",
    };
  }

  if (job.beforeProviderCall) {
    try {
      const settings = await waitForNoteJobDeadline(job, () =>
        job.beforeProviderCall(),
      );
      if (settings) job.settings = settings;
    } catch (error) {
      job.stopCode = normalizeExportSourceBatchCode(error?.code);
      return {
        success: false,
        code: job.stopCode,
        error: exportSourceBatchSafeMessage(job.stopCode),
      };
    }
  }

  job.providerCalls += 1;
  let result = await waitForNoteJobDeadline(
    job,
    () =>
      callAiTranslation(systemPrompt, userContent, {
        ...options,
        settings: options.settings || job.settings,
        hardTimeoutMs: Math.min(AI_PROVIDER_HARD_TIMEOUT_MS, remainingMs),
      }),
  ).catch((error) => ({
    success: false,
    code: error?.code || "PROVIDER_ERROR",
    error: error?.message || "笔记翻译请求失败",
  }));
  if (noteJobRemainingMs(job) <= 0) return stopNoteJobForTimeout(job);
  if (!result.success && result.code === "RATE_LIMITED") {
    if (
      job.rateLimitRetries >= 1 ||
      job.providerCalls >= NOTE_TRANSLATION_MAX_PROVIDER_CALLS
    ) {
      job.stopCode = "RATE_LIMITED";
      noteTranslationCooldownUntil =
        job.now() + NOTE_TRANSLATION_RATE_LIMIT_COOLDOWN_MS;
      return result;
    }
    job.rateLimitRetries += 1;
    if (noteJobRemainingMs(job) <= NOTE_TRANSLATION_RATE_LIMIT_BACKOFF_MS) {
      return stopNoteJobForTimeout(job);
    }
    const waited = await waitForNoteJobDeadline(
      job,
      () => job.wait(NOTE_TRANSLATION_RATE_LIMIT_BACKOFF_MS),
    ).then(
      () => true,
      () => false,
    );
    if (!waited) return stopNoteJobForTimeout(job);
    if (noteJobRemainingMs(job) <= 0) return stopNoteJobForTimeout(job);
    job.providerCalls += 1;
    result = await waitForNoteJobDeadline(
      job,
      () =>
        callAiTranslation(systemPrompt, userContent, {
          ...options,
          settings: options.settings || job.settings,
          hardTimeoutMs: Math.min(
            AI_PROVIDER_HARD_TIMEOUT_MS,
            noteJobRemainingMs(job),
          ),
        }),
    ).catch((error) => ({
      success: false,
      code: error?.code || "PROVIDER_ERROR",
      error: error?.message || "笔记翻译请求失败",
    }));
    if (noteJobRemainingMs(job) <= 0) return stopNoteJobForTimeout(job);
    if (!result.success && result.code === "RATE_LIMITED") {
      job.stopCode = "RATE_LIMITED";
      noteTranslationCooldownUntil =
        job.now() + NOTE_TRANSLATION_RATE_LIMIT_COOLDOWN_MS;
    }
  }
  if (
    !result.success &&
    (result.code === "AI_IDLE_TIMEOUT" || result.code === "AI_HARD_TIMEOUT")
  ) {
    job.stopCode = "PROVIDER_TIMEOUT";
  }
  return result;
}

async function callStructuredNoteTranslation(
  job,
  systemPrompt,
  userContent,
  options,
) {
  let result = await callNoteTranslationProvider(
    job,
    systemPrompt,
    userContent,
    options,
  );
  if (
    !result.success &&
    result.code === "EMPTY_AI_RESPONSE" &&
    options.responseFormat &&
    job.emptyFallbacks < 1 &&
    !job.stopCode
  ) {
    job.emptyFallbacks += 1;
    result = await callNoteTranslationProvider(job, systemPrompt, userContent, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
  }
  return result;
}

function noteTranslationResult(
  requestedNotes,
  validTranslations,
  failureById,
  providerLabel = "AI 服务",
) {
  const successfulIds = new Set(validTranslations.map((note) => note.id));
  const failures = requestedNotes
    .filter((note) => !successfulIds.has(note.id))
    .map((note) => ({
      id: note.id,
      code: failureById.get(note.id) || "INVALID_TRANSLATION",
    }));
  const primaryFailureCode = failures[0]?.code || "";
  const errorByCode = {
    RATE_LIMITED: `${providerLabel} 请求受限，请稍后重试。`,
    PROVIDER_TIMEOUT: `${providerLabel} 请求超时，请稍后重试。`,
    NOTE_JOB_TIMEOUT: "笔记翻译任务超时，请重试。",
    OUTPUT_TRUNCATED: `${providerLabel} 输出被截断，请重试。`,
    CONTENT_FILTERED: `${providerLabel} 未返回这条内容，请修改原文或稍后重试。`,
    PROVIDER_UNAVAILABLE: `${providerLabel} 暂时不可用，请稍后重试。`,
    UNEXPECTED_FINISH_REASON: `${providerLabel} 未正常完成响应，请重试。`,
    EMPTY_RESPONSE: `${providerLabel} 未返回有效内容，请重试。`,
    RETRY_BUDGET_EXHAUSTED: "本轮笔记重试次数已达上限，请再次重试。",
    EXPORT_JOB_PROVIDER_MISMATCH:
      "当前翻译服务或模型已变化，本批次未调用，请重新确认。",
    EXPORT_JOB_NOT_RUNNING: "补译任务已停止，不会启动新的翻译请求。",
    EXPORT_JOB_SOURCE_REVISION_MISMATCH:
      "笔记或视频资料已变化，请重新预检。",
  };
  return {
    success: validTranslations.length > 0,
    translations: validTranslations,
    missingIds: failures.map((failure) => failure.id),
    failures,
    code: primaryFailureCode,
    error: failures.length
      ? errorByCode[primaryFailureCode] || "部分中文笔记仍未生成，请重试。"
      : "",
  };
}

// ============================================================
// NOTE VIDEO TITLE TRANSLATION
// Titles are translated once per stable media identity and validated
// independently of the note bodies, so a failed title never blocks a note's
// body (and vice versa). Every note sharing the mediaKey is backfilled with the
// same validated Chinese title.
// ============================================================

function noteTitleMediaKey(note) {
  return String(note?.mediaKey || note?.videoId || "").trim();
}

/**
 * Normalizes and de-duplicates the optional `titles` request array. Invalid or
 * duplicate entries are skipped rather than throwing, so a malformed auxiliary
 * title can never reject the note-body translation it travels with.
 */
function validateNoteTitleTranslationRequest(titles) {
  if (!Array.isArray(titles) || !titles.length) return [];
  const seen = new Set();
  const normalized = [];
  for (const entry of titles) {
    const mediaKey =
      typeof entry?.mediaKey === "string" ? entry.mediaKey.trim() : "";
    const title =
      typeof entry?.title === "string" ? entry.title.trim().slice(0, 500) : "";
    if (!NOTE_TITLE_MEDIA_KEY_PATTERN.test(mediaKey) || !title) continue;
    if (seen.has(mediaKey)) continue;
    seen.add(mediaKey);
    normalized.push({ mediaKey, title });
    if (normalized.length >= NOTE_TITLE_TRANSLATION_MAX_TITLES) break;
  }
  return normalized;
}

function noteTitleTranslationUserContent(titles) {
  return JSON.stringify({
    titles: titles.map(({ mediaKey, title }) => ({ mediaKey, title })),
  });
}

function validateNoteTitleCandidate(candidate) {
  const titleZh =
    typeof candidate?.titleZh === "string" ? candidate.titleZh.trim() : "";
  if (!titleZh) return { titleZh: "", failureCode: "EMPTY_RESPONSE" };
  if (titleZh.length > 500 || hasExplicitBilingualLabels(titleZh)) {
    return { titleZh: "", failureCode: "INVALID_TRANSLATION" };
  }
  if (looksLikeUsableChineseNote(titleZh)) {
    return { titleZh, failureCode: "" };
  }
  return { titleZh: "", failureCode: "INVALID_TRANSLATION" };
}

function normalizeNoteTitleTranslation(parsed, sourceTitles) {
  const raw = Array.isArray(parsed?.titles) ? parsed.titles : [];
  const byKey = new Map();
  const duplicateKeys = new Set();
  raw.forEach((candidate) => {
    const key =
      typeof candidate?.mediaKey === "string" ? candidate.mediaKey.trim() : "";
    if (!key) return;
    if (byKey.has(key)) {
      duplicateKeys.add(key);
      return;
    }
    byKey.set(key, candidate);
  });
  return sourceTitles.map((source) => {
    if (duplicateKeys.has(source.mediaKey)) {
      return {
        mediaKey: source.mediaKey,
        titleZh: "",
        failureCode: "MULTIPLE_CANDIDATES",
      };
    }
    const candidate = byKey.get(source.mediaKey);
    if (!candidate) {
      return {
        mediaKey: source.mediaKey,
        titleZh: "",
        failureCode: "MISSING_ITEM",
      };
    }
    const validated = validateNoteTitleCandidate(candidate);
    return {
      mediaKey: source.mediaKey,
      titleZh: validated.titleZh,
      failureCode: validated.failureCode,
    };
  });
}

function persistNoteTitleTranslations(titleByMediaKey, job) {
  return withNoteStorageWrite(async () => {
    const stored = job
      ? await waitForNoteJobDeadline(job, () =>
          chrome.storage.local.get("ytd_notes"),
        )
      : await chrome.storage.local.get("ytd_notes");
    const storedNotes = Array.isArray(stored.ytd_notes) ? stored.ytd_notes : [];
    const updatedNotes = storedNotes.map((note) => {
      const key = noteTitleMediaKey(note);
      if (!key || !titleByMediaKey.has(key)) return note;
      const translated = titleByMediaKey.get(key);
      return {
        ...note,
        videoTitleZh: translated.titleZh,
        videoTitleZhSourceHash: translated.sourceHash,
        videoTitleZhValidated: true,
        videoTitleZhValidationVersion: NOTE_TITLE_TRANSLATION_VALIDATION_VERSION,
      };
    });
    if (job && noteJobRemainingMs(job) <= 0) {
      const error = new Error("笔记翻译任务超时，请重试。");
      error.code = "NOTE_JOB_TIMEOUT";
      job.stopCode = error.code;
      throw error;
    }
    await chrome.storage.local.set({ ytd_notes: updatedNotes });
  });
}

/**
 * Translates a de-duplicated batch of titles inside an existing note-translation
 * job, sharing that job's provider-call budget, rate-limit cooldown and
 * deadline. Returns valid titles plus a per-mediaKey failure map. Never throws.
 */
async function translateNoteTitlesInJob(job, sourceTitles) {
  const failureByKey = new Map();
  if (!sourceTitles.length) return { titles: [], failureByKey };
  const failAll = (code) => {
    sourceTitles.forEach((title) => failureByKey.set(title.mediaKey, code));
    return { titles: [], failureByKey };
  };
  if (job.stopCode) return failAll(job.stopCode);
  if (noteJobRemainingMs(job) <= 0) return failAll("NOTE_JOB_TIMEOUT");
  if (job.now() < noteTranslationCooldownUntil) return failAll("RATE_LIMITED");

  const options = {
    temperature: 0.2,
    maxTokens: 1024,
    responseFormat: { type: "json_object" },
  };
  let systemPrompt;
  try {
    const baseRules = await waitForNoteJobDeadline(job, () =>
      getTranslationBaseRules("zh"),
    );
    systemPrompt = await waitForNoteJobDeadline(job, () =>
      loadPromptSection("translation.md", "Note title translation", {
        langName: "Simplified Chinese",
        baseRules,
      }),
    );
  } catch (error) {
    return failAll(error?.code === "NOTE_JOB_TIMEOUT" ? error.code : "PROVIDER_ERROR");
  }

  const result = await callStructuredNoteTranslation(
    job,
    systemPrompt,
    noteTitleTranslationUserContent(sourceTitles),
    options,
  );
  if (!result.success) return failAll(noteFailureCode(result));

  let normalized;
  try {
    normalized = normalizeNoteTitleTranslation(
      parseLooseJson(result.text),
      sourceTitles,
    );
  } catch (_error) {
    normalized = sourceTitles.map((title) => ({
      mediaKey: title.mediaKey,
      titleZh: "",
      failureCode: "INVALID_JSON",
    }));
  }

  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index].titleZh) continue;
    if (job.stopCode) {
      normalized[index].failureCode = job.stopCode;
      continue;
    }
    const retry = await callStructuredNoteTranslation(
      job,
      systemPrompt,
      noteTitleTranslationUserContent([sourceTitles[index]]),
      options,
    );
    if (!retry.success) {
      normalized[index].failureCode = noteFailureCode(retry);
      continue;
    }
    let retryNormalized;
    try {
      retryNormalized = normalizeNoteTitleTranslation(parseLooseJson(retry.text), [
        sourceTitles[index],
      ]);
    } catch (_error) {
      retryNormalized = [
        { mediaKey: sourceTitles[index].mediaKey, titleZh: "", failureCode: "INVALID_JSON" },
      ];
    }
    normalized[index] = retryNormalized[0];
  }

  const titles = normalized
    .filter((title) => title.titleZh)
    .map(({ mediaKey, titleZh }) => ({ mediaKey, titleZh }));
  normalized.forEach((title) => {
    if (!title.titleZh) {
      failureByKey.set(
        title.mediaKey,
        title.failureCode || job.stopCode || "INVALID_TRANSLATION",
      );
    }
  });
  return { titles, failureByKey };
}

function handleTranslateNotes(request, dependencies = {}) {
  // Backward compatible: an array is a notes-only request; an object may carry
  // an optional de-duplicated `titles` batch translated in the same job.
  const notes = Array.isArray(request) ? request : request?.notes || [];
  const titles = Array.isArray(request) ? [] : request?.titles || [];
  const now = dependencies.now || Date.now;
  const requestDependencies = {
    ...dependencies,
    now,
    deadlineAt: Number.isFinite(dependencies.deadlineAt)
      ? dependencies.deadlineAt
      : now() + NOTE_TRANSLATION_JOB_TIMEOUT_MS,
  };
  const run = noteTranslationQueue.then(() =>
    runTranslateNotes(notes, titles, requestDependencies),
  );
  noteTranslationQueue = run.catch(() => {});
  return run;
}

async function runTranslateNotes(notes, titles, dependencies = {}) {
  const job = createNoteTranslationJob(dependencies);
  const normalizedTitles = validateNoteTitleTranslationRequest(titles);
  const bodyResult = (notes || []).length
    ? await runTranslateNoteBodies(notes, job)
    : { success: true, translations: [], missingIds: [], failures: [] };
  if (!normalizedTitles.length) return bodyResult;

  let titleOutcome = { titles: [], failureByKey: new Map() };
  try {
    if (!job.settings) {
      const settings = await waitForNoteJobDeadline(job, () => getSettings());
      if (YTD_SETTINGS.hasActiveApiKey(settings)) job.settings = settings;
    }
    if (job.settings && YTD_SETTINGS.hasActiveApiKey(job.settings)) {
      titleOutcome = await translateNoteTitlesInJob(job, normalizedTitles);
      if (titleOutcome.titles.length) {
        const sourceByMediaKey = new Map(
          normalizedTitles.map((title) => [title.mediaKey, title.title]),
        );
        await persistNoteTitleTranslations(
          new Map(
            titleOutcome.titles.map((translated) => [
              translated.mediaKey,
              {
                titleZh: translated.titleZh,
                sourceHash: YTD_NOTE_SOURCES.hashSourceText(
                  sourceByMediaKey.get(translated.mediaKey) || "",
                ),
              },
            ]),
          ),
          job,
        );
      }
    } else {
      normalizedTitles.forEach((t) =>
        titleOutcome.failureByKey.set(t.mediaKey, "NO_AI_KEY"),
      );
    }
  } catch (error) {
    // A title failure must never corrupt the body result.
    normalizedTitles.forEach((t) => {
      if (!titleOutcome.failureByKey.has(t.mediaKey)) {
        titleOutcome.failureByKey.set(t.mediaKey, error?.code || "PROVIDER_ERROR");
      }
    });
  }

  const successfulTitleKeys = new Set(
    titleOutcome.titles.map((t) => t.mediaKey),
  );
  return {
    ...bodyResult,
    success: bodyResult.success || titleOutcome.titles.length > 0,
    titles: titleOutcome.titles,
    titleFailures: normalizedTitles
      .filter((t) => !successfulTitleKeys.has(t.mediaKey))
      .map((t) => ({
        mediaKey: t.mediaKey,
        code: titleOutcome.failureByKey.get(t.mediaKey) || "INVALID_TRANSLATION",
      })),
  };
}

async function runTranslateNoteBodies(notes, job) {
  let requestedNotes = [];
  try {
    requestedNotes = validateNoteTranslationRequest(notes);
    const storedBefore = await waitForNoteJobDeadline(
      job,
      () => chrome.storage.local.get("ytd_notes"),
    );
    const storedNotesBefore = Array.isArray(storedBefore.ytd_notes)
      ? storedBefore.ytd_notes
      : [];
    const storedTranslationById = new Map();
    storedNotesBefore.forEach((note) => {
      if (
        typeof note?.id !== "string" ||
        typeof note?.translatedText !== "string" ||
        !note.translatedText.trim()
      ) {
        return;
      }
      const sourceText = note.text || note.rawText || "";
      let validated;
      if (
        note.translatedValidated === true &&
        note.translatedValidationVersion ===
          NOTE_TRANSLATION_VALIDATION_VERSION
      ) {
        const unchangedValid =
          note.translatedUnchanged !== true ||
          canonicalNoteText(note.translatedText) ===
            canonicalNoteText(sourceText);
        validated = unchangedValid
          ? {
              textZh: note.translatedText.trim(),
              unchanged: note.translatedUnchanged === true,
            }
          : { textZh: "", unchanged: false };
      } else {
        validated = validateNoteTranslationCandidate(
          { textZh: note.translatedText },
          { text: sourceText, videoTitle: note.videoTitle || "" },
        );
      }
      if (validated.textZh) {
        storedTranslationById.set(note.id, {
          textZh: validated.textZh,
          unchanged: validated.unchanged === true,
        });
      }
    });
    const existingTranslationById = new Map();
    requestedNotes.forEach((note) => {
      if (noteHasChineseSource(note)) {
        const reuseText =
          isChineseLanguage(note.textLanguage) && note.text
            ? note.text
            : note.rawText || note.text;
        existingTranslationById.set(note.id, {
          textZh: reuseText,
          unchanged: false,
        });
      } else if (storedTranslationById.has(note.id)) {
        existingTranslationById.set(note.id, storedTranslationById.get(note.id));
      }
    });
    const existingTranslations = requestedNotes
      .filter((note) => existingTranslationById.has(note.id))
      .map((note) => ({
        id: note.id,
        ...existingTranslationById.get(note.id),
      }));
    const sourceNotes = requestedNotes.filter(
      (note) => !existingTranslationById.has(note.id),
    );
    if (!sourceNotes.length) {
      await persistNoteTranslations(existingTranslationById, job);
      return {
        success: true,
        translations: existingTranslations,
        missingIds: [],
        failures: [],
      };
    }

    const failureById = new Map();
    if (noteJobRemainingMs(job) <= 0) {
      sourceNotes.forEach((note) =>
        failureById.set(note.id, "NOTE_JOB_TIMEOUT"),
      );
      return noteTranslationResult(
        requestedNotes,
        existingTranslations,
        failureById,
        providerDisplayLabel(job.settings),
      );
    }

    const settings =
      job.settings ||
      (await waitForNoteJobDeadline(job, () => getSettings()));
    if (!YTD_SETTINGS.hasActiveApiKey(settings)) {
      return {
        success: false,
        error: `尚未配置${providerDisplayLabel(settings)} API 密钥`,
      };
    }
    job.settings = settings;
    if (job.now() < noteTranslationCooldownUntil) {
      sourceNotes.forEach((note) => failureById.set(note.id, "RATE_LIMITED"));
      return noteTranslationResult(
        requestedNotes,
        existingTranslations,
        failureById,
        providerDisplayLabel(job.settings),
      );
    }

    const baseRules = await waitForNoteJobDeadline(
      job,
      () => getTranslationBaseRules("zh"),
    );
    const systemPrompt = await waitForNoteJobDeadline(
      job,
      () =>
        loadPromptSection("translation.md", "Notes translation", {
          langName: "Simplified Chinese",
          baseRules,
        }),
    );
    const options = {
      temperature: 0.2,
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
    };
    const batchUserContent = noteTranslationUserContent(sourceNotes);
    const result = await callStructuredNoteTranslation(
      job,
      systemPrompt,
      batchUserContent,
      options,
    );
    if (!result.success) {
      const code = noteFailureCode(result);
      sourceNotes.forEach((note) => failureById.set(note.id, code));
      return noteTranslationResult(
        requestedNotes,
        existingTranslations,
        failureById,
        providerDisplayLabel(job.settings),
      );
    }

    let translations;
    try {
      translations = normalizeNoteTranslation(
        parseLooseJson(result.text),
        sourceNotes,
      );
    } catch (_error) {
      translations = sourceNotes.map((note) => ({
        id: note.id,
        textZh: "",
        failureCode: "INVALID_JSON",
      }));
    }

    // Keep every valid item from the batch. Missing items get bounded singleton
    // recovery; all provider calls share one budget so malformed output cannot
    // fan out into an unbounded request storm.
    for (let index = 0; index < translations.length; index += 1) {
      if (translations[index].textZh) continue;
      const source = sourceNotes[index];
      if (job.stopCode) {
        translations[index].failureCode = job.stopCode;
        continue;
      }
      const retryUserContent = noteTranslationUserContent([source]);
      const retry = await callStructuredNoteTranslation(
        job,
        systemPrompt,
        retryUserContent,
        options,
      );
      if (!retry.success) {
        translations[index].failureCode = noteFailureCode(retry);
        continue;
      }

      const translated = normalizeSingletonNoteTranslationResponse(
        retry.text,
        source,
      );
      if (translated?.textZh) {
        translations[index] = translated;
        continue;
      }

      // One correction attempt without JSON mode helps when the provider
      // returned syntactically valid JSON with a missing field or unusable
      // value. The same job budget and rate-limit stop still apply.
      const correctionPrompt = `${systemPrompt}\n\nRETRY CORRECTION: Return exactly one notes item. Copy the supplied id exactly. textZh must be natural Simplified Chinese. Only a technical-only source may be copied with unchanged:true and unchangedKind:"technical"; only a proper name present in the video title may use unchangedKind:"proper_noun".`;
      const correction = await callNoteTranslationProvider(
        job,
        correctionPrompt,
        retryUserContent,
        { temperature: options.temperature, maxTokens: options.maxTokens },
      );
      if (!correction.success) {
        translations[index].failureCode = noteFailureCode(correction);
        continue;
      }
      translations[index] = normalizeSingletonNoteTranslationResponse(
        correction.text,
        source,
      );
    }

    const validTranslations = [
      ...existingTranslations,
      ...translations
        .filter((note) => note.textZh)
        .map(({ id, textZh, unchanged }) => ({
          id,
          textZh,
          unchanged: unchanged === true,
        })),
    ];
    translations.forEach((note) => {
      if (!note.textZh) {
        failureById.set(
          note.id,
          note.failureCode || job.stopCode || "INVALID_TRANSLATION",
        );
      }
    });
    const translatedById = new Map(
      validTranslations.map((note) => [note.id, note]),
    );
    if (translatedById.size) {
      await persistNoteTranslations(translatedById, job);
    }
    return noteTranslationResult(
      requestedNotes,
      validTranslations,
      failureById,
      providerDisplayLabel(job.settings),
    );
  } catch (error) {
    if (error?.code === "NOTE_JOB_TIMEOUT" && requestedNotes.length) {
      const failureById = new Map(
        requestedNotes.map((note) => [note.id, "NOTE_JOB_TIMEOUT"]),
      );
      return noteTranslationResult(
        requestedNotes,
        [],
        failureById,
        providerDisplayLabel(job.settings),
      );
    }
    return { success: false, error: error.message || "中文笔记生成失败" };
  }
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - Must be 'transcriptBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
  beforeProviderCall,
) {
  let actualProviderCalls = 0;
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
        actualProviderCalls,
      };
    }
    if (contentType !== "transcriptBatch") {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
        actualProviderCalls,
      };
    }

    const settings = await getSettings();
    if (!YTD_SETTINGS.hasActiveApiKey(settings)) {
      return {
        success: false,
        error: `尚未配置${providerDisplayLabel(settings)} API 密钥`,
        actualProviderCalls,
      };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Transcript batch translation",
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: transcriptTranslationMaxTokens(sourceSegments),
      responseFormat: { type: "json_object" },
    };
    const callAuthorizedTranslation = async (prompt, options) => {
      const authorizedSettings =
        typeof beforeProviderCall === "function"
          ? await beforeProviderCall()
          : settings;
      if (!YTD_SETTINGS.hasActiveApiKey(authorizedSettings)) {
        throw exportSourceBatchError(
          "NO_AI_KEY",
          `尚未配置${providerDisplayLabel(authorizedSettings)} API 密钥`,
        );
      }
      actualProviderCalls += 1;
      return callAiTranslation(prompt, userContent, {
        ...options,
        settings: authorizedSettings,
      });
    };
    let result = await callAuthorizedTranslation(
      systemPrompt,
      translationOptions,
    );
    let retried = false;

    // A provider may return an empty response or signal an output-length stop.
    // Retry once with a larger budget and without response_format. The prompt
    // still requires exact JSON, while the one-retry bound prevents cost fanout.
    if (
      !result.success &&
      ["EMPTY_AI_RESPONSE", "OUTPUT_TRUNCATED"].includes(result.code)
    ) {
      result = await callAuthorizedTranslation(systemPrompt, {
        temperature: translationOptions.temperature,
        maxTokens: Math.min(8192, translationOptions.maxTokens * 2),
      });
      retried = true;
    }
    if (!result.success) return { ...result, actualProviderCalls };

    let parsed = parseTranscriptTranslation(result.text, sourceSegments);
    // Some OpenAI-compatible providers report finish_reason=stop even when the
    // JSON text ends inside a quoted string. Treat that as untrusted provider
    // output, not an extension runtime exception, and recover exactly once.
    if (!parsed.success && !retried) {
      result = await callAuthorizedTranslation(
        `${systemPrompt}\nReturn one complete JSON object. Do not stop inside a string or omit the final brackets.`,
        {
          temperature: translationOptions.temperature,
          maxTokens: Math.min(8192, translationOptions.maxTokens * 2),
        },
      );
      retried = true;
      if (!result.success) return { ...result, actualProviderCalls };
      parsed = parseTranscriptTranslation(result.text, sourceSegments);
    }
    if (!parsed.success) {
      return {
        success: false,
        code: "INVALID_JSON",
        error: "AI 返回的翻译 JSON 不完整，请重试该段。",
        actualProviderCalls,
      };
    }
    return {
      success: true,
      translatedContent: parsed.translatedContent,
      actualProviderCalls,
    };
  } catch (error) {
    if (!String(error?.code || "").startsWith("EXPORT_")) {
      console.error("[DigestDock] Translation error:", error);
    }
    return {
      success: false,
      code: error?.code,
      error: error.message || "翻译失败",
      actualProviderCalls,
    };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  {
    temperature = 0.3,
    maxTokens = 8192,
    responseFormat,
    hardTimeoutMs,
    settings,
  } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      hardTimeoutMs,
      settingsOverride: settings,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  cleanupNoteText,
  handleAnalyzeTranscript,
  handleFetchTranscript,
  handleGetNotes,
  handleDeleteNote,
  handleExportNotesBackup,
  handleImportNotesBackup,
  handleClearAllNotes,
  handleResetAllExtensionData,
  createNoteId,
  getNoteStorageGeneration,
  handleSaveNote,
  persistSavedNoteSourceBestEffort,
  handleTranslateOverviewOriginal,
  handleTranslateNotes,
  hasUsableChineseOverview,
  getSafeLanguageName,
  getSupadataTrackLanguage,
  isChineseLanguage,
  isConfirmedSimplifiedChineseSource,
  languagesSharePrimary,
  isMissingContentReceiverError,
  isPageRefreshRequiredError,
  isTransientTabContextError,
  looksLikeChineseTranscript,
  noteHasChineseSource,
  shouldUseBilibiliChinese,
  normalizeLanguageCode,
  normalizeOverviewOriginalTranslation,
  normalizeNoteTranslation,
  normalizeSingletonNoteTranslationResponse,
  validateNoteTranslationCandidate,
  validateNoteTitleTranslationRequest,
  validateNoteTitleCandidate,
  normalizeNoteTitleTranslation,
  noteTitleTranslationUserContent,
  noteTitleMediaKey,
  validateExportSourceBatchRequest,
  handleTranslateExportSourceBatch,
  handleCancelExportTranslationJob,
  handleGetExportTranslationJob,
  handleListExportTranslationJobs,
  handleCreateOrResumeExportJob,
  handleCheckpointExportJob,
  handleUpsertNoteSource,
  resolveSourceLanguage,
  saveNoteToStorage,
  sendMessageToContentWithRecovery,
  validateAndFixTimestamps,
  validateOverviewOriginalTranslationRequest,
  validateNoteTranslationRequest,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
  isSupportedVideoUrl,
  readYouTubePlayabilitySnapshot,
  classifyYouTubePlayability,
  youtubeTabStillMatches,
  youtubeTabNavigationEpoch,
  bumpYoutubeTabNavigationEpoch,
  handleYoutubePassiveState,
  readYoutubePassiveGate,
  awaitYoutubePassiveGate,
  normalizePassiveCapture,
  normalizeYoutubeNativeProviderResult,
  runYoutubeProductModule,
  runYoutubeNativeRouteLeader,
  handleFetchYoutubeNativeTranscript,
  readYoutubeNativeCooldownUntil,
  startYoutubeNativeCooldown,
  readYoutubeSupadataCooldownUntil,
  startYoutubeSupadataCooldown,
  readBoundedResponseText,
  fetchSupadataJson,
  supadataHttpFailure,
  pollTranscriptJob,
  handleFetchYoutubeSupadataTranscript,
  handleFetchYoutubeTranscript,
  normalizeBilibiliMediaRef,
  resolveMediaRef,
  handleFetchMediaTranscript,
};
