/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");

const DEBUG = false;
const ANALYSIS_SCHEMA_VERSION = 3;
const RUNTIME_PROTOCOL_VERSION = 4;
const ANALYSIS_BASE_LANGUAGE = "zh-Hans";
const TRANSCRIPT_SOURCE_POLICY_VERSION = 2;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
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

      // A full content-script reinjection can coexist with the orphaned
      // observer from the pre-reload extension context. Both instances then
      // remove and recreate each other's watch-page buttons, starving
      // YouTube's renderer. A few message-only retries cover normal
      // document_idle startup; refreshing is the only safe recovery after
      // those retries still find no live receiver.
      const refreshError = new Error(
        "YouTube Digest 已更新，请刷新当前 YouTube 页面后重试。",
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
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "尚未配置 DeepSeek API 密钥，请打开 YouTube Digest 设置。",
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
    AI_PROVIDER_HARD_TIMEOUT_MS,
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

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
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
        "DeepSeek 请求超过 120 秒，请重试。",
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
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
function updatePanelForTab(tabId, url) {
  const isYouTube = (url || "").startsWith("https://www.youtube.com");
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: isYouTube })
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
    updatePanelForTab(tabId, tab.url);
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
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId, message.preferredLanguage)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
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
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
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
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

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
          console.error("[YouTube Digest BG] openSidePanel error:", err);
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
                "[YouTube Digest BG] openSidePanel fallback error:",
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
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no YouTube tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("youtube.com")) {
          tabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
            active: true,
          });
          debugLog("[YouTube Digest BG] Active YouTube tabs:", tabs.length);
        }

        // Still nothing? Try any YouTube tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
          debugLog("[YouTube Digest BG] Any YouTube tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await sendMessageToContentWithRecovery(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (message.payload?.action === "getVideoInfo") {
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

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        if (isPageRefreshRequiredError(err)) {
          debugLog("[YouTube Digest BG] Page refresh required after reload");
          sendResponse({
            success: false,
            error: "PAGE_REFRESH_REQUIRED",
            message: err.message,
          });
        } else if (isTransientTabContextError(err)) {
          debugLog("[YouTube Digest BG] YouTube tab context changed during relay");
          sendResponse({
            success: false,
            error: "PAGE_CONTEXT_CHANGED",
            message: "YouTube 页面正在刷新，请稍后重试。",
          });
        } else {
          console.error("[YouTube Digest BG] Relay error:", err.message);
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
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
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
async function handleFetchTranscript(videoId, preferredLanguage) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "尚未配置 Supadata API 密钥，请打开 YouTube Digest 设置。",
      };
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
          message: "Supadata API 密钥无效，请打开 YouTube Digest 设置。",
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
async function pollTranscriptJob(jobId, supadataApiKey, preferredLanguage = "") {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

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

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @param {string} sourceLanguage - The actual Supadata caption-track language
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
  sourceLanguage,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "尚未配置 DeepSeek API 密钥，请打开 YouTube Digest 设置。",
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

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      sourceLanguage: normalizedSourceLanguage,
      transcriptText,
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

    debugLog("[YouTube Digest] Requesting video analysis", settings.aiModel);
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
  const sourceIsChinese = isChineseLanguage(normalizedSourceLanguage);

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
      const quoteZh = sourceIsChinese ? quoteOriginal : proposedQuoteZh;
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
  videoId,
  timestamp,
  videoTitle,
  channelName,
) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      const digest = cached[`digest_${videoId}`];
      if (
        digest?.transcriptSourcePolicyVersion ===
          TRANSCRIPT_SOURCE_POLICY_VERSION &&
        digest.transcript
      ) {
        transcript = digest.transcript;
        debugLog("[YouTube Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[YouTube Digest] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(videoId);
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
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
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      translatedText: "",
      rawText: matchedLine.text,
      sourceLanguage:
        typeof matchedLine.language === "string" ? matchedLine.language : "",
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Generate the Chinese note separately. Failure never blocks the English
    // note; the Notes tab can retry missing translations later in small batches.
    const translationResult = await handleTranslateNotes([note]);
    if (translationResult.success) {
      note.translatedText = translationResult.translations[0]?.textZh || "";
    }

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Save note error:", error);
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
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
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
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
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
    console.error("[YouTube Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
let noteStorageWriteQueue = Promise.resolve();

function withNoteStorageWrite(task) {
  const run = noteStorageWriteQueue.then(task);
  noteStorageWriteQueue = run.catch(() => {});
  return run;
}

function saveNoteToStorage(note) {
  return withNoteStorageWrite(async () => {
    const result = await chrome.storage.local.get("ytd_notes");
    const notes = Array.isArray(result.ytd_notes) ? result.ytd_notes : [];
    notes.unshift(note); // Add to beginning (newest first)

    // Keep only last 100 notes to prevent storage bloat
    if (notes.length > 100) {
      notes.splice(100);
    }

    await chrome.storage.local.set({ ytd_notes: notes });
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

    debugLog("[YouTube Digest] Requesting selection explanation");
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
  if (isChineseLanguage(sourceLanguage)) {
    throw new Error("Chinese source overviews do not require translation");
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

function noteHasChineseSource(note) {
  const language = String(note?.sourceLanguage || "").trim();
  const rawText = String(note?.rawText || "");
  if (language) return isChineseLanguage(language);
  return /[\u3400-\u9fff]/.test(rawText);
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
    return { id, text, videoTitle, rawText, sourceLanguage };
  });
  if (totalCharacters > 30_000) {
    throw new Error("Note translation input is too large");
  }
  return normalized;
}

function normalizeNoteTranslation(parsed, sourceNotes) {
  const candidates = new Map(
    (Array.isArray(parsed?.notes) ? parsed.notes : [])
      .filter((note) => typeof note?.id === "string")
      .map((note) => [note.id, note]),
  );
  return sourceNotes.map((source) => {
    const candidate = candidates.get(source.id);
    const textZh =
      typeof candidate?.textZh === "string" ? candidate.textZh.trim() : "";
    return {
      id: source.id,
      textZh: looksLikeChineseTranslation(textZh, source.text) ? textZh : "",
    };
  });
}

function noteTranslationUserContent(notes) {
  return JSON.stringify({
    notes: notes.map(({ id, text, videoTitle }) => ({ id, text, videoTitle })),
  });
}

function persistNoteTranslations(translatedById) {
  return withNoteStorageWrite(async () => {
    const stored = await chrome.storage.local.get("ytd_notes");
    const storedNotes = Array.isArray(stored.ytd_notes) ? stored.ytd_notes : [];
    const updatedNotes = storedNotes.map((note) =>
      translatedById.has(note.id)
        ? { ...note, translatedText: translatedById.get(note.id) }
        : note,
    );
    await chrome.storage.local.set({ ytd_notes: updatedNotes });
  });
}

let noteTranslationQueue = Promise.resolve();

function handleTranslateNotes(notes) {
  const run = noteTranslationQueue.then(() => runTranslateNotes(notes));
  noteTranslationQueue = run.catch(() => {});
  return run;
}

async function runTranslateNotes(notes) {
  try {
    const requestedNotes = validateNoteTranslationRequest(notes);
    const storedBefore = await chrome.storage.local.get("ytd_notes");
    const storedNotesBefore = Array.isArray(storedBefore.ytd_notes)
      ? storedBefore.ytd_notes
      : [];
    const storedTranslationById = new Map(
      storedNotesBefore
        .filter(
          (note) =>
            typeof note?.id === "string" &&
            typeof note?.translatedText === "string" &&
            note.translatedText.trim(),
        )
        .map((note) => [note.id, note.translatedText.trim()]),
    );
    const existingTranslationById = new Map();
    requestedNotes.forEach((note) => {
      if (noteHasChineseSource(note)) {
        existingTranslationById.set(note.id, note.rawText || note.text);
      } else if (storedTranslationById.has(note.id)) {
        existingTranslationById.set(note.id, storedTranslationById.get(note.id));
      }
    });
    const existingTranslations = requestedNotes
      .filter((note) => existingTranslationById.has(note.id))
      .map((note) => ({
        id: note.id,
        textZh: existingTranslationById.get(note.id),
      }));
    const sourceNotes = requestedNotes.filter(
      (note) => !existingTranslationById.has(note.id),
    );
    if (!sourceNotes.length) {
      await persistNoteTranslations(existingTranslationById);
      return { success: true, translations: existingTranslations, missingIds: [] };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "尚未配置 DeepSeek API 密钥" };
    }
    const baseRules = await getTranslationBaseRules("zh");
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Notes translation",
      {
        langName: "Simplified Chinese",
        baseRules,
      },
    );
    const options = {
      temperature: 0.2,
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
    };
    const batchUserContent = noteTranslationUserContent(sourceNotes);
    let result = await callAiTranslation(systemPrompt, batchUserContent, options);
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(
        systemPrompt,
        batchUserContent,
        { temperature: options.temperature, maxTokens: options.maxTokens },
      );
    }
    if (!result.success) return result;

    let translations;
    try {
      translations = normalizeNoteTranslation(
        parseLooseJson(result.text),
        sourceNotes,
      );
    } catch (_error) {
      translations = sourceNotes.map((note) => ({ id: note.id, textZh: "" }));
    }

    // Keep every valid item from the batch. Retry only missing items once,
    // individually, so one malformed model entry cannot discard its siblings.
    for (let index = 0; index < translations.length; index += 1) {
      if (translations[index].textZh) continue;
      const source = sourceNotes[index];
      const retryUserContent = noteTranslationUserContent([source]);
      let retry = await callAiTranslation(
        systemPrompt,
        retryUserContent,
        options,
      );
      if (!retry.success && retry.code === "EMPTY_AI_RESPONSE") {
        retry = await callAiTranslation(
          systemPrompt,
          retryUserContent,
          { temperature: options.temperature, maxTokens: options.maxTokens },
        );
      }
      if (!retry.success) continue;
      try {
        const [translated] = normalizeNoteTranslation(
          parseLooseJson(retry.text),
          [source],
        );
        if (translated?.textZh) translations[index] = translated;
      } catch (_error) {
        // Preserve the English note and continue with the remaining items.
      }
    }

    const validTranslations = [
      ...existingTranslations,
      ...translations.filter((note) => note.textZh),
    ];
    if (!validTranslations.length) {
      return { success: false, error: "中文笔记生成失败，请重试。" };
    }
    const translatedById = new Map(
      validTranslations.map((note) => [note.id, note.textZh]),
    );
    await persistNoteTranslations(translatedById);
    return {
      success: true,
      translations: validTranslations,
      missingIds: requestedNotes
        .filter(
          (note) =>
            !validTranslations.some((translated) => translated.id === note.id),
        )
        .map((note) => note.id),
    };
  } catch (error) {
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
    console.error("[YouTube Digest] Translation error:", error);
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
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
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
  handleAnalyzeTranscript,
  handleFetchTranscript,
  handleGetNotes,
  handleDeleteNote,
  handleTranslateOverviewOriginal,
  handleTranslateNotes,
  hasUsableChineseOverview,
  getSafeLanguageName,
  getSupadataTrackLanguage,
  isChineseLanguage,
  languagesSharePrimary,
  isMissingContentReceiverError,
  isPageRefreshRequiredError,
  isTransientTabContextError,
  looksLikeChineseTranscript,
  noteHasChineseSource,
  normalizeLanguageCode,
  normalizeOverviewOriginalTranslation,
  normalizeNoteTranslation,
  resolveSourceLanguage,
  saveNoteToStorage,
  sendMessageToContentWithRecovery,
  validateAndFixTimestamps,
  validateOverviewOriginalTranslationRequest,
  validateNoteTranslationRequest,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
};
