/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube and Bilibili caption tracks locally, with optional Supadata fallback
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");
importScripts("youtube-transcript.js");
importScripts("bilibili.js");
importScripts("notes-backup.js");

const DEBUG = false;
const ANALYSIS_SCHEMA_VERSION = 3;
const RUNTIME_PROTOCOL_VERSION = 8;
const ANALYSIS_BASE_LANGUAGE = "zh-Hans";
const TRANSCRIPT_SOURCE_POLICY_VERSION = 3;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SAVED_NOTES = 100;
const NOTE_TRANSLATION_JOB_TIMEOUT_MS = 110_000;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

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
  if (!settings.aiApiKey) {
    const error = new Error(
      "尚未配置 DeepSeek API 密钥，请打开 DigestDock 设置。",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning traces.
  body.thinking = { type: "disabled" };

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
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves DeepSeek is still making progress. DeepSeek
    // may then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `DeepSeek error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const choice = data.choices?.[0];
    const finishReason = choice?.finish_reason;
    if (finishReason && finishReason !== "stop") {
      const codeByFinishReason = {
        length: "OUTPUT_TRUNCATED",
        content_filter: "CONTENT_FILTERED",
        insufficient_system_resource: "PROVIDER_UNAVAILABLE",
      };
      const finishError = new Error(
        `DeepSeek stopped before completing the response (${finishReason}).`,
      );
      finishError.code =
        codeByFinishReason[finishReason] || "UNEXPECTED_FINISH_REASON";
      throw finishError;
    }

    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings, finishReason: finishReason || "" };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "DeepSeek 请求已连续 50 秒没有响应，请重试。",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        `DeepSeek 请求超过 ${Math.ceil(effectiveHardTimeoutMs / 1000)} 秒，请重试。`,
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
      // Every received chunk is activity, including DeepSeek's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
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
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
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
  const metadata = {
    title,
    channelName,
    creator: safeString(
      mediaRef.creator || mediaRef.metadata?.creator || channelName,
      300,
    ),
    description: safeString(
      mediaRef.description || mediaRef.metadata?.description,
      10_000,
    ),
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
    return handleFetchYoutubeTranscriptLocalFirst(
      mediaRef.videoId,
      preferredLanguage,
      tabId,
      supadataConsent,
    );
  } catch (error) {
    return {
      success: false,
      error: error?.code || "TRANSCRIPT_ERROR",
      message: error?.message || "读取视频字幕失败。",
    };
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
  updatePanelForTab(tabId, changeInfo.url);
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
    handleFetchMediaTranscript(
      message.mediaRef || message.videoId,
      message.preferredLanguage,
      message.tabId ?? sender.tab?.id ?? null,
      message.supadataConsent === true,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
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
    handleTranslateNotes(message.notes)
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

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: !!settings.aiApiKey,
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        }),
      )
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
          if (!requestedTab || !isSupportedVideoUrl(requestedTab.url)) {
            sendResponse({
              success: false,
              error: "PAGE_CONTEXT_CHANGED",
              message: "目标视频页面已关闭或已导航，请重新打开摘要。",
            });
            return;
          }
          tab = requestedTab;
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

        if (!tabs[0] || !isSupportedVideoUrl(tabs[0].url)) {
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
          debugLog(
            "[DigestDock BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await sendMessageToContentWithRecovery(
            tabs[0].id,
            message.payload,
            {},
            tabs[0].url,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (
            message.payload?.action === "getVideoInfo" &&
            isYouTubeVideoUrl(tabs[0].url)
          ) {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                sourceLanguage:
                  playerInfo.sourceLanguage || response?.sourceLanguage || "",
                description:
                  playerInfo.description || response?.description || "",
              };
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
        } else if (isTransientTabContextError(err)) {
          debugLog("[DigestDock BG] Video tab context changed during relay");
          sendResponse({
            success: false,
            error: "PAGE_CONTEXT_CHANGED",
            message: "视频页面正在刷新，请稍后重试。",
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
          const playerResponse = player?.getPlayerResponse?.();
          const details = playerResponse?.videoDetails;
          if (!details) return null;
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
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
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

/**
 * Reads only the current video's caption-track metadata in YouTube's MAIN
 * world. Signed URLs stay in the service worker and are passed directly to the
 * bounded adapter; they are never logged, cached, or returned to the UI.
 */
async function readYouTubeCaptionSnapshot(tabId, expectedVideoId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [expectedVideoId],
      func: (expectedId) => {
        try {
          const player = document.getElementById("movie_player");
          const response =
            player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
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
          const sourceLanguage =
            response?.videoDetails?.defaultAudioLanguage ||
            response?.microformat?.playerMicroformatRenderer
              ?.defaultAudioLanguage ||
            rawTracks[defaultCaptionIndex]?.languageCode ||
            "";
          const readLabel = (name) =>
            String(
              name?.simpleText ||
                name?.runs?.map((run) => run?.text || "").join("") ||
                "",
            ).slice(0, 160);
          return {
            ok: true,
            videoId: actualVideoId,
            sourceLanguage,
            tracks: rawTracks
              .filter(
                (track) =>
                  typeof track?.baseUrl === "string" &&
                  track.baseUrl.trim(),
              )
              .map((track, index) => ({
                baseUrl: track.baseUrl,
                languageCode: String(track.languageCode || ""),
                kind: track.kind === "asr" ? "asr" : undefined,
                vssId: String(track.vssId || ""),
                name: { simpleText: readLabel(track.name) },
                isDefault: index === defaultCaptionIndex,
              })),
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
      "[DigestDock] Page caption snapshot unavailable:",
      error?.message,
    );
    return null;
  }
}

async function youtubeTabStillMatches(tabId, expectedVideoId) {
  if (!Number.isInteger(tabId)) return true;
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

async function handleFetchYoutubeTranscriptLocalFirst(
  videoId,
  preferredLanguage = "",
  tabId = null,
  supadataConsent = false,
) {
  let snapshot = null;
  try {
    snapshot = await readYouTubeCaptionSnapshot(tabId, videoId);
  } catch (error) {
    if (error?.code === "PAGE_CONTEXT_CHANGED") {
      return pageContextChangedResult();
    }
  }

  const requestedLanguage =
    normalizeLanguageCode(preferredLanguage) ||
    normalizeLanguageCode(snapshot?.sourceLanguage);
  let localError = null;
  try {
    const localInput = {
      videoId,
      preferredLanguage: requestedLanguage,
      kind: "manual-first",
    };
    if (snapshot) localInput.captionTracks = snapshot.tracks || [];
    const local = await YOUTUBE_TRANSCRIPT_ADAPTER.fetchTranscript(localInput);
    if (!(await youtubeTabStillMatches(tabId, videoId))) {
      return pageContextChangedResult();
    }
    return {
      success: true,
      source: "youtube-timedtext",
      ...local,
    };
  } catch (error) {
    localError = error;
  }

  // Never spend fallback quota for a video the user has already left.
  if (!(await youtubeTabStillMatches(tabId, videoId))) {
    return pageContextChangedResult();
  }

  const settings = await getSettings();
  const attempts = Array.isArray(localError?.attempts)
    ? localError.attempts
    : [];
  const localErrorCode = localError?.code || "LOCAL_TRANSCRIPT_FAILED";

  if (!settings.supadataApiKey) {
    return {
      success: false,
      error: "SUPADATA_NOT_CONFIGURED",
      message:
        "未能直接读取 YouTube 原生字幕。如要使用 Supadata，可先在设置中配置可选密钥。",
      localError: localErrorCode,
      attempts,
    };
  }

  // A saved key enables the choice, never an automatic third-party request.
  // Only the side-panel action shown after local failure may opt this one
  // attempt into Supadata. Note saves and ordinary transcript loads keep the
  // default false value and therefore cannot silently use the provider.
  if (supadataConsent !== true) {
    return {
      success: false,
      error: "SUPADATA_CONSENT_REQUIRED",
      message:
        "未能直接读取 YouTube 原生字幕。你可以选择本次使用 Supadata 提取。",
      localError: localErrorCode,
      attempts,
    };
  }

  const fallback = await handleFetchTranscript(
    videoId,
    requestedLanguage,
    () => youtubeTabStillMatches(tabId, videoId),
  );
  // Supadata can take long enough for a YouTube SPA navigation to finish
  // while the request (or async job) is in flight. Do not accept that old
  // video's result for the tab's new page or a cache-miss note save.
  if (!(await youtubeTabStillMatches(tabId, videoId))) {
    return pageContextChangedResult();
  }
  if (fallback.success) {
    return {
      ...fallback,
      source: "supadata",
      sourceAttempt: "SUPADATA",
      selectedTrack: null,
    };
  }

  return {
    ...fallback,
    localError: localErrorCode,
  };
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

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

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "x-api-key": settings.supadataApiKey,
      },
    });

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = await response.json();
      // Poll for the result
      return await pollTranscriptJob(
        jobData.jobId,
        settings.supadataApiKey,
        normalizedPreferredLanguage,
        shouldContinue,
      );
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "此视频没有可用的原生字幕轨道。",
      };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message: "Supadata API 密钥无效，请打开 DigestDock 设置。",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "未找到此视频的字幕。",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
          message:
            "Supadata 请求次数已达上限，请等待一分钟后重试。",
        };
      }
      throw new Error(
        errorData.message || `Supadata API error: ${response.status}`,
      );
    }

    const data = await response.json();

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
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "获取字幕失败",
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
) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (shouldContinue && !(await shouldContinue())) {
      return pageContextChangedResult();
    }
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    if (shouldContinue && !(await shouldContinue())) {
      return pageContextChangedResult();
    }

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

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
      throw new Error("字幕处理失败");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error("字幕处理超时");
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
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
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
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
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "尚未配置 DeepSeek API 密钥，请打开 DigestDock 设置。",
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
      settings.aiModel,
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
      throw new Error("DeepSeek 没有返回可用的中文概览，请重试。");
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
        message: "DeepSeek 拒绝了该 API 密钥。",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "DeepSeek 限制了本次请求，请稍后重试。",
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
  try {
    const mediaRef = await resolveMediaRef(mediaInput, sourceUrl);
    const mediaKey = mediaRef.mediaKey || mediaRef.videoId;
    const canonicalVideoUrl = mediaRef.canonicalUrl;
    const resolvedVideoTitle = videoTitle || mediaRef.title || "Untitled Video";
    const resolvedChannelName = channelName || mediaRef.channelName || "";
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${mediaKey}`);
      const digest = cached[`digest_${mediaKey}`];
      if (
        Array.isArray(digest?.transcript) &&
        digest.transcript.length > 0 &&
        digest.transcriptSourcePolicyVersion ===
          TRANSCRIPT_SOURCE_POLICY_VERSION
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
        return {
          success: false,
          error: transcriptResult.error || "Could not fetch transcript",
          message: transcriptResult.message || "无法读取字幕。",
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
  if (!settings.aiApiKey) {
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
      noteStorageGeneration += 1;
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
      noteStorageGeneration += 1;
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
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "尚未配置 DeepSeek API 密钥。",
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
    if (!settings.aiApiKey) {
      return { success: false, error: "尚未配置 DeepSeek API 密钥" };
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

function noteFailureCode(result, fallback = "PROVIDER_ERROR") {
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
    settings: null,
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

function noteTranslationResult(requestedNotes, validTranslations, failureById) {
  const successfulIds = new Set(validTranslations.map((note) => note.id));
  const failures = requestedNotes
    .filter((note) => !successfulIds.has(note.id))
    .map((note) => ({
      id: note.id,
      code: failureById.get(note.id) || "INVALID_TRANSLATION",
    }));
  const primaryFailureCode = failures[0]?.code || "";
  const errorByCode = {
    RATE_LIMITED: "DeepSeek 请求受限，请稍后重试。",
    PROVIDER_TIMEOUT: "DeepSeek 请求超时，请稍后重试。",
    NOTE_JOB_TIMEOUT: "笔记翻译任务超时，请重试。",
    OUTPUT_TRUNCATED: "DeepSeek 输出被截断，请重试。",
    CONTENT_FILTERED: "DeepSeek 未返回这条内容，请修改原文或稍后重试。",
    PROVIDER_UNAVAILABLE: "DeepSeek 暂时不可用，请稍后重试。",
    UNEXPECTED_FINISH_REASON: "DeepSeek 未正常完成响应，请重试。",
    EMPTY_RESPONSE: "DeepSeek 未返回有效内容，请重试。",
    RETRY_BUDGET_EXHAUSTED: "本轮笔记重试次数已达上限，请再次重试。",
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

function handleTranslateNotes(notes, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const requestDependencies = {
    ...dependencies,
    now,
    deadlineAt: Number.isFinite(dependencies.deadlineAt)
      ? dependencies.deadlineAt
      : now() + NOTE_TRANSLATION_JOB_TIMEOUT_MS,
  };
  const run = noteTranslationQueue.then(() =>
    runTranslateNotes(notes, requestDependencies),
  );
  noteTranslationQueue = run.catch(() => {});
  return run;
}

async function runTranslateNotes(notes, dependencies = {}) {
  let requestedNotes = [];
  const job = createNoteTranslationJob(dependencies);
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
      );
    }

    const settings = await waitForNoteJobDeadline(job, () => getSettings());
    if (!settings.aiApiKey) {
      return { success: false, error: "尚未配置 DeepSeek API 密钥" };
    }
    job.settings = settings;
    if (job.now() < noteTranslationCooldownUntil) {
      sourceNotes.forEach((note) => failureById.set(note.id, "RATE_LIMITED"));
      return noteTranslationResult(
        requestedNotes,
        existingTranslations,
        failureById,
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
    );
  } catch (error) {
    if (error?.code === "NOTE_JOB_TIMEOUT" && requestedNotes.length) {
      const failureById = new Map(
        requestedNotes.map((note) => [note.id, "NOTE_JOB_TIMEOUT"]),
      );
      return noteTranslationResult(requestedNotes, [], failureById);
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
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (contentType !== "transcriptBatch") {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "尚未配置 DeepSeek API 密钥" };
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
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "翻译结果中没有有效的中文片段",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[DigestDock] Translation error:", error);
    return { success: false, error: error.message || "翻译失败" };
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
  readYouTubeCaptionSnapshot,
  youtubeTabStillMatches,
  handleFetchYoutubeTranscriptLocalFirst,
  normalizeBilibiliMediaRef,
  resolveMediaRef,
  handleFetchMediaTranscript,
};
