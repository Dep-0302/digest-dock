/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for DigestDock: supported-video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const REQUIRED_RUNTIME_PROTOCOL_VERSION = 9;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

/**
 * Formats a playback offset for the time rail.
 * Below one hour: MM:SS (e.g. 00:37, 59:18). At or above one hour: H:MM:SS
 * (e.g. 1:00:27, 3:02:58). Minutes and seconds are always two digits; hours
 * are shown without padding. Uses tabular numerals in CSS so widths align.
 */
function formatTimecode(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function createSingleFlight() {
  const activeByKey = new Map();
  return (key, task) => {
    if (activeByKey.has(key)) return activeByKey.get(key);
    let promise;
    promise = Promise.resolve()
      .then(task)
      .finally(() => {
        if (activeByKey.get(key) === promise) activeByKey.delete(key);
      });
    activeByKey.set(key, promise);
    return promise;
  };
}

const runDigestSingleFlight = createSingleFlight();

// ============================================================
// STATE
// ============================================================

let currentVideoId = null; // YouTube video ID or resolved cross-platform mediaKey.
let currentVideoUrl = null;
let currentMediaRef = null;
let currentRouteKey = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentTranscriptSource = "";
let currentTranscriptSelectedTrack = null;
let currentTranscriptSourceAttempt = "";
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let currentVideoSourceLanguage = "";
let isAnalysisLoading = false; // Track if analysis is in progress
let videoTabId = null; // Exact supported video tab for seek/playback messaging.
let currentConfigStatus = null;
let errorAction = null;
let errorSecondaryAction = null;
let tabCheckGeneration = 0;
let digestGeneration = 0;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let currentOverviewMode = "zh";
let currentNotesMode = "bilingual";
let currentNotes = [];
let currentNotesFilterVideoId;
let notesFilterShowAll = false;
let isOverviewTranslationLoading = false;
let isNotesTranslationLoading = false;
let isNotesLoading = false;
let notesTranslationGeneration = 0;
let notesLoadGeneration = 0;
let lastNotesManualRetryAt = 0;
let noteTranslationAttemptCountById = new Map();
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;
const NOTES_MANUAL_RETRY_DEBOUNCE_MS = 400;
const NOTE_TRANSLATION_VALIDATION_VERSION = 1;
const TRANSCRIPT_TRANSLATION_CACHE_VERSION = 2;
const TRANSCRIPT_SOURCE_POLICY_VERSION = 4;

function sanitizeTranscriptSelectedTrack(track) {
  if (!track || typeof track !== "object") return null;
  const language = normalizeLanguageCode(
    track.language || track.languageCode,
  );
  const kind = track.kind === "asr" ? "asr" : "manual";
  return {
    ...(Number.isInteger(track.index) ? { index: track.index } : {}),
    language: language || null,
    kind,
    isGenerated: kind === "asr" || track.isGenerated === true,
    label:
      typeof track.label === "string"
        ? track.label.trim().slice(0, 100)
        : null,
  };
}

function transcriptSourceLabel() {
  if (currentTranscriptSource === "supadata") return "Supadata 原生字幕";
  if (currentTranscriptSource === "bilibili") return "B 站视频字幕";
  return "来自视频字幕";
}

function normalizeLanguageCode(value) {
  const language = String(value || "")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();
  return language.length <= 35 &&
    /^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,3}$/.test(language)
    ? language
    : "";
}

function isChineseLanguage(value) {
  const primary = normalizeLanguageCode(value).split("-")[0];
  return [
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
  ].includes(primary);
}

function languagesSharePrimary(value, otherValue) {
  if (isChineseLanguage(value) && isChineseLanguage(otherValue)) return true;
  const primary = normalizeLanguageCode(value).split("-")[0];
  const otherPrimary = normalizeLanguageCode(otherValue).split("-")[0];
  return Boolean(primary && primary === otherPrimary);
}

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * translation UI stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      const timeoutError = new Error(
        "翻译请求在 130 秒后超时，请重试。",
      );
      timeoutError.code = "TRANSLATION_MESSAGE_TIMEOUT";
      finish(
        reject,
        timeoutError,
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});
const COMPACT_CJK_SEGMENT_LIMITS = Object.freeze({
  minChars: 28,
  idealChars: 72,
  maxChars: 120,
  maxSeconds: 12,
});
const SENTENCE_PUNCTUATION_PATTERN = /[.!?;:,。！？；：，]/;
const COMPACT_CJK_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g;

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

function transcriptSegmentProfile(text, fallback = TRANSCRIPT_SEGMENT_LIMITS) {
  const normalized = normalizeCaptionText(text);
  const visible = normalized.replace(/\s/g, "");
  const cjkCount = (visible.match(COMPACT_CJK_PATTERN) || []).length;
  const compactCjk =
    cjkCount >= 6 &&
    cjkCount / Math.max(1, visible.length) >= 0.45 &&
    !SENTENCE_PUNCTUATION_PATTERN.test(normalized);
  return compactCjk ? COMPACT_CJK_SEGMENT_LIMITS : fallback;
}

function splitCaptionPiece(text, start, duration, profile) {
  const normalized = normalizeCaptionText(text);
  if (!normalized) return [];
  const compactCjk = profile === COMPACT_CJK_SEGMENT_LIMITS;
  const countByChars = Math.ceil(
    normalized.length / (compactCjk ? profile.idealChars : profile.maxChars),
  );
  const countByTime = Math.ceil(duration / profile.maxSeconds);
  const maxReadableParts = Math.max(
    1,
    Math.floor(normalized.length / profile.minChars),
  );
  const partCount = Math.max(
    1,
    countByChars,
    Math.min(countByTime, maxReadableParts),
  );
  const targetChars = Math.min(
    profile.maxChars,
    Math.ceil(normalized.length / partCount),
  );
  const parts = splitOversizedThought(normalized, targetChars);
  let consumedChars = 0;
  return parts.map((part) => {
    const startRatio = normalized.length
      ? Math.min(1, consumedChars / normalized.length)
      : 0;
    consumedChars += part.length;
    const endRatio = normalized.length
      ? Math.min(1, consumedChars / normalized.length)
      : 1;
    return {
      text: part,
      start: start + duration * startRatio,
      end: start + duration * endRatio,
      semanticEnd:
        /[.!?。！？]["')\]”’）】」』]*$/.test(part) || parts.length > 1,
      clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
      compactCjk,
    };
  });
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
      const sentenceDuration = text.length
        ? duration * (cleanPart.length / text.length)
        : duration;
      const profile = transcriptSegmentProfile(cleanPart, limits);
      splitCaptionPiece(
        cleanPart,
        start + duration * ratio,
        sentenceDuration,
        profile,
      ).forEach((piece, partIndex) => {
        pieces.push({ ...piece, sourceOrder: `${entryIndex}:${partIndex}` });
      });
      consumedChars += cleanPart.length;
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (current) {
      const candidateText = normalizeCaptionText(`${current.text} ${piece.text}`);
      const candidateProfile = transcriptSegmentProfile(candidateText, limits);
      const candidateElapsed = Math.max(0, piece.end - current.start);
      if (
        candidateText.length > candidateProfile.maxChars ||
        candidateElapsed > candidateProfile.maxSeconds
      ) {
        flush();
      }
    }

    if (!current) current = { start: piece.start, end: piece.end, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    current.end = Math.max(current.end, piece.end);
    const profile = transcriptSegmentProfile(current.text, limits);
    const elapsed = Math.max(0, current.end - current.start);
    const comfortablySized = current.text.length >= profile.minChars;
    const reachedIdeal = current.text.length >= profile.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= profile.maxChars ||
          elapsed >= profile.maxSeconds));
    const reachedHardGuardrail =
      current.text.length >= profile.maxChars || elapsed >= profile.maxSeconds;
    const reachedCompactIdeal = piece.compactCjk && reachedIdeal;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedCompactIdeal ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await evictOldCacheEntries(20);

  currentConfigStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (
    currentConfigStatus?.runtimeProtocolVersion !==
    REQUIRED_RUNTIME_PROTOCOL_VERSION
  ) {
    showRuntimeVersionError();
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved" || message.action === "notesChanged") {
    // Refresh after a save, import, clear, or reset. Only a freshly saved note
    // may retry its missing Chinese version automatically.
    loadNotes(notesFilterShowAll ? null : currentVideoId, {
      translateMissing: message.action === "noteSaved",
    });
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

function extractMediaLocator(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (
      parsed.protocol === "https:" &&
      parsed.hostname === "www.youtube.com" &&
      parsed.pathname === "/watch" &&
      parsed.searchParams.has("v")
    ) {
      const videoId = parsed.searchParams.get("v");
      return {
        platform: "youtube",
        videoId,
        mediaKey: videoId,
        routeKey: `youtube:${videoId}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      };
    }

    const bili = BILIBILI_ADAPTER.parseBilibiliVideoUrl(parsed.href);
    return {
      platform: "bilibili",
      bvid: bili.bvid,
      page: bili.page,
      routeKey: `bilibili:${bili.bvid}:p${bili.page}`,
      canonicalUrl: bili.canonicalUrl,
    };
  } catch {
    return null;
  }
}

function isBilibiliChineseMedia() {
  return (
    currentMediaRef?.platform === "bilibili" &&
    isConfirmedSimplifiedChineseSource(currentTranscriptLanguage)
  );
}

function applyMediaLanguageDefaults() {
  const directChinese = isBilibiliChineseMedia();
  currentTranscriptMode = "original";
  // The current product contract is Chinese-first on every platform. Bilibili
  // Chinese tracks additionally hide controls that would only duplicate the
  // same text.
  currentOverviewMode = "zh";
  currentNotesMode = directChinese ? "zh" : "bilingual";
  setTranscriptModeButtons(currentTranscriptMode);
  setOverviewModeButtons(currentOverviewMode);
  setNotesModeButtons(currentNotesMode);

  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.hidden = directChinese && button.dataset.transcriptMode !== "original";
  });
  document.querySelectorAll(".overview-mode-btn").forEach((button) => {
    button.hidden = directChinese && button.dataset.overviewMode !== "zh";
  });
  document.querySelectorAll(".notes-mode-btn").forEach((button) => {
    button.hidden = directChinese && button.dataset.notesMode !== "zh";
  });
}

function updateHeaderLanguageControlsVisibility() {
  const transcriptControl = document.getElementById("transcriptModeControl");
  const overviewControl = document.getElementById("overviewModeControl");
  const notesControl = document.getElementById("notesModeControl");
  const activeTab = document.querySelector(".tab.active")?.dataset.tab;
  const showingResults = panelIsShowingResults();
  if (transcriptControl) {
    transcriptControl.hidden = !(showingResults && activeTab === "transcript");
  }
  if (overviewControl) {
    overviewControl.hidden = !(showingResults && activeTab === "overview");
  }
  if (notesControl) {
    notesControl.hidden = !(showingResults && activeTab === "notes");
  }
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url) {
  const locator = extractMediaLocator(url);
  if (!locator) {
    window.close();
    return;
  }

  const newRouteKey = locator.routeKey;
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newRouteKey !== currentRouteKey || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  if (changeInfo.url) {
    handleFrontTabUrl(changeInfo.url);
    return;
  }
  if (changeInfo.status === "complete" && tabId === videoTabId) {
    scheduleDigestRefresh();
  }
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.pendingUrl || tab.url || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      return errorAction();
    }
    if (currentVideoId) {
      return startDigest(currentVideoId, currentVideoUrl).catch((error) => {
        console.error("[DigestDock Panel] Retry error:", error);
        showError(
          "无法打开摘要",
          error?.message || "重新加载当前 YouTube 视频失败，请刷新页面后重试。",
        );
      });
    }
  });
  document
    .getElementById("errorSecondaryBtn")
    ?.addEventListener("click", () => {
      if (errorSecondaryAction) return errorSecondaryAction();
    });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscriptModeChange(button.dataset.transcriptMode);
    });
  });
  document.querySelectorAll(".overview-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleOverviewModeChange(button.dataset.overviewMode);
    });
  });
  document.querySelectorAll(".notes-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleNotesModeChange(button.dataset.notesMode);
    });
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
}

function setNotesFilter(showAll) {
  notesFilterShowAll = showAll;
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

function checkCurrentTab() {
  const generation = ++tabCheckGeneration;
  return runCheckCurrentTab(generation);
}

function isTransientTabLookupError(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("No tab with id") ||
    message.includes("Tab was closed") ||
    message.includes("Invalid tab ID")
  );
}

async function runCheckCurrentTab(generation) {
  const isLatestCheck = () => generation === tabCheckGeneration;
  try {
    let tab = null;
    let tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!isLatestCheck()) return;
    if (extractMediaLocator(tabs[0]?.url)) tab = tabs[0];

    if (!tab) {
      tabs = await chrome.tabs.query({
        url: [
          "https://www.youtube.com/watch*",
          "https://www.bilibili.com/video/BV*",
        ],
        active: true,
      });
      if (!isLatestCheck()) return;
      if (tabs[0]) tab = tabs[0];
    }

    if (!tab) {
      tabs = await chrome.tabs.query({
        url: [
          "https://www.youtube.com/watch*",
          "https://www.bilibili.com/video/BV*",
        ],
      });
      if (!isLatestCheck()) return;
      if (tabs[0]) tab = tabs[0];
    }

    debugLog("[DigestDock Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      if (isLatestCheck()) showState("welcome");
      return;
    }

    const locator = extractMediaLocator(tab.url);
    if (!locator) {
      showState("welcome");
      return;
    }

    if (!currentConfigStatus?.hasAiKey) {
      showConfigError(currentConfigStatus || {});
      return;
    }

    // Capture the exact supported tab before any content relay so a
    // refresh-required response can reload the tab that actually failed.
    videoTabId = tab.id;

    let nextMediaRef = locator;
    let nextVideoUrl = tab.url;
    let nextVideoTitle = "";
    let nextChannelName = "";
    let nextVideoDescription = "";
    let nextVideoDuration = 0;
    let nextSourceLanguage = "";

    if (locator.platform === "bilibili") {
      const resolved = await chrome.runtime.sendMessage({
        action: "resolveBilibiliMedia",
        url: tab.url,
      });
      if (!isLatestCheck()) return;
      if (!resolved?.success || !resolved.mediaRef) {
        showError(
          "无法读取 B 站视频",
          resolved?.message || resolved?.error || "媒体解析失败。",
        );
        return;
      }
      nextMediaRef = resolved.mediaRef;
      nextVideoTitle = nextMediaRef.title || "";
      nextChannelName = nextMediaRef.channelName || "";
      nextVideoDescription = nextMediaRef.description || "";
      nextVideoDuration = nextMediaRef.duration || 0;
    } else {
      let videoInfo = null;
      try {
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          tabId: tab.id,
          payload: { action: "getVideoInfo" },
        });
        if (!isLatestCheck()) return;
        debugLog("[DigestDock Panel] getVideoInfo result:", result);
        if (
          result?.error === "PAGE_REFRESH_REQUIRED" ||
          result?.error === "PAGE_CONTEXT_CHANGED"
        ) {
          const refreshError = new Error(
            result.message ||
              "DigestDock 已更新，请刷新当前 YouTube 页面后重试。",
          );
          refreshError.code = "PAGE_REFRESH_REQUIRED";
          throw refreshError;
        }
        if (result.success && result.response) {
          videoInfo = result.response;
        }
      } catch (e) {
        if (!isLatestCheck()) return;
        if (e?.code === "PAGE_REFRESH_REQUIRED") throw e;
        console.error("[DigestDock Panel] getVideoInfo error:", e);
      }
      nextVideoTitle = videoInfo?.title || "";
      nextChannelName = videoInfo?.channelName || "";
      nextVideoDescription = videoInfo?.description || "";
      nextVideoDuration = videoInfo?.duration || 0;
      nextSourceLanguage = normalizeLanguageCode(videoInfo?.sourceLanguage);
    }

    // Resolve/relay crosses an async boundary. Re-read the exact tab and apply
    // state only when it is still on the same BV + part or YouTube video. This
    // also protects A -> B -> A navigation from a late response owned by the
    // first A request.
    const latestTab = await chrome.tabs.get(tab.id);
    if (!isLatestCheck()) return;
    nextVideoUrl = latestTab.pendingUrl || latestTab.url || "";
    const latestLocator = extractMediaLocator(nextVideoUrl);
    if (!latestLocator || latestLocator.routeKey !== locator.routeKey) {
      scheduleDigestRefresh();
      return;
    }

    currentVideoTitle = nextVideoTitle;
    currentChannelName = nextChannelName;
    currentVideoDescription = nextVideoDescription;
    currentVideoDuration = nextVideoDuration;
    currentVideoSourceLanguage = nextSourceLanguage;

    await startDigest(
      nextMediaRef.mediaKey,
      nextVideoUrl,
      nextMediaRef,
      locator.routeKey,
    );
  } catch (error) {
    if (!isLatestCheck()) return;
    if (isTransientTabLookupError(error)) {
      debugLog("[DigestDock Panel] Active tab changed during inspection");
      scheduleDigestRefresh();
      return;
    }
    if (error?.code === "PAGE_REFRESH_REQUIRED") {
      debugLog("[DigestDock Panel] Video page refresh required");
      showPageRefreshRequired(videoTabId, error.message);
      return;
    }
    console.error("Tab check error:", error);
    showError(
      "无法打开摘要",
      error?.message || "读取当前视频失败，请刷新页面后重试。",
    );
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

function startDigest(
  videoId,
  videoUrl,
  mediaRef = currentMediaRef,
  routeKey = currentRouteKey,
) {
  const nextMediaRef = mediaRef || currentMediaRef;
  const nextRouteKey = routeKey || currentRouteKey;
  const sourceTrackChanged =
    nextMediaRef?.platform !== "bilibili" &&
    videoId === currentVideoId &&
    currentVideoSourceLanguage &&
    currentTranscript &&
    (!currentTranscriptLanguage ||
      !languagesSharePrimary(
        currentVideoSourceLanguage,
        currentTranscriptLanguage,
      ));
  const videoChanged =
    videoId !== currentVideoId ||
    nextRouteKey !== currentRouteKey ||
    sourceTrackChanged;
  if (videoChanged) {
    digestGeneration += 1;
    translationGeneration += 1;
    notesLoadGeneration += 1;
    notesTranslationGeneration += 1;
    isOverviewTranslationLoading = false;
    isAnalysisLoading = false;
    isNotesLoading = false;
    isNotesTranslationLoading = false;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentMediaRef = nextMediaRef;
    currentRouteKey = nextRouteKey;
    currentAnalysis = null;
    currentTranscript = null;
    currentTranscriptText = null;
    currentTranscriptTimestamped = null;
    currentTranscriptLanguage = null;
    currentOverviewMode = "zh";
    setOverviewModeButtons(currentOverviewMode);
    clearOverviewResults();
  } else {
    currentVideoUrl = videoUrl;
    currentMediaRef = nextMediaRef;
    currentRouteKey = nextRouteKey;
  }

  const generation = digestGeneration;
  const requestKey = `${generation}:${videoId}`;
  return runDigestSingleFlight(requestKey, () =>
    runDigestLoad(
      videoId,
      generation,
      videoChanged,
      nextMediaRef,
      nextRouteKey,
    ),
  );
}

function isCurrentDigest(
  videoId,
  generation,
  routeKey = currentRouteKey,
) {
  return (
    videoId === currentVideoId &&
    generation === digestGeneration &&
    routeKey === currentRouteKey
  );
}

function clearOverviewResults() {
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");
  if (chapterList) chapterList.innerHTML = "";
  if (quotesList) quotesList.innerHTML = "";
  setOverviewTranslationStatus();
  setOverviewTranslationLoading(false);
}

function refreshOverviewForCurrentVideoIfVisible() {
  const activeTab = document.querySelector(".tab.active")?.dataset.tab;
  if (activeTab !== "overview") return;
  if (!currentAnalysis && currentTranscriptTimestamped && !isAnalysisLoading) {
    void triggerAnalysis();
  } else if (currentAnalysis && currentOverviewMode !== "zh") {
    void ensureOverviewOriginal();
  }
}

async function runDigestLoad(
  videoId,
  generation,
  videoChanged,
  mediaRef = currentMediaRef,
  routeKey = currentRouteKey,
  supadataConsent = false,
) {
  if (!isCurrentDigest(videoId, generation, routeKey)) return;

  // Check if we already have this video loaded in memory
  if (!videoChanged && videoId === currentVideoId && currentAnalysis) {
    showState("results");
    refreshOverviewForCurrentVideoIfVisible();
    return;
  }

  // Check cache for this video
  let cached = await loadFromCache(videoId);
  if (!isCurrentDigest(videoId, generation, routeKey)) return;
  if (
    cached &&
    ((cached.routeKey && cached.routeKey !== routeKey) ||
      (cached.mediaRef?.mediaKey && cached.mediaRef.mediaKey !== videoId))
  ) {
    cached = null;
  }
  if (
    cached &&
    mediaRef?.platform === "youtube" &&
    currentVideoSourceLanguage &&
    (!cached.transcriptLanguage ||
      !languagesSharePrimary(
        currentVideoSourceLanguage,
        cached.transcriptLanguage,
      ))
  ) {
    cached = null;
  }
  if (cached) {
    debugLog("Loading from cache:", videoId);
    const cachedTranscriptLanguage = normalizeLanguageCode(
      cached.transcriptLanguage ||
        cached.transcript?.find((entry) => entry?.language)?.language,
    );
    const cachedAnalysisLanguage = normalizeLanguageCode(
      cached.analysis?.sourceLanguage,
    );
    currentAnalysis =
      cached.analysisVideoId === videoId &&
      cached.analysis?.schemaVersion === 3 &&
      (!cachedTranscriptLanguage ||
        cachedAnalysisLanguage === cachedTranscriptLanguage) &&
      hasUsableChineseAnalysis(cached.analysis)
      ? cached.analysis
      : null;
    currentMediaRef = cached.mediaRef || mediaRef;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage =
      cachedTranscriptLanguage || cachedAnalysisLanguage || null;
    currentTranscriptSource = String(cached.transcriptSource || "");
    currentTranscriptSelectedTrack = sanitizeTranscriptSelectedTrack(
      cached.transcriptSelectedTrack,
    );
    currentTranscriptSourceAttempt = String(
      cached.transcriptSourceAttempt || "",
    ).slice(0, 40);
    applyMediaLanguageDefaults();
    isAnalysisLoading = false;

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      const cachePrefix = transcriptTranslationCachePrefix(videoId);
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        if (key.startsWith(cachePrefix)) {
          transcriptParagraphCache.set(key, value);
        }
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      updateVideoMetaLine();
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    refreshOverviewForCurrentVideoIfVisible();
    return;
  }

  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  currentTranscriptSource = "";
  currentTranscriptSelectedTrack = null;
  currentTranscriptSourceAttempt = "";

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("正在获取字幕", "");

  const requestMediaRef = currentMediaRef || mediaRef;
  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: requestMediaRef?.videoId || videoId,
    mediaRef: requestMediaRef,
    preferredLanguage: currentVideoSourceLanguage,
    tabId: videoTabId,
    supadataConsent: supadataConsent === true,
  });
  if (!isCurrentDigest(videoId, generation, routeKey)) return;

  if (!transcriptResult.success) {
    if (
      transcriptResult.error === "SUPADATA_CONSENT_REQUIRED" &&
      supadataConsent !== true
    ) {
      showSupadataConsent(async () => {
        if (!isCurrentDigest(videoId, generation, routeKey)) return;
        const requestKey = `${generation}:${videoId}`;
        // A same-video refresh may already own the ordinary consent-gated
        // single-flight. Wait for it to finish, then start a fresh consented
        // attempt. This preserves ordering without running the unconsented
        // probe and the Supadata-authorized request in parallel or swallowing
        // the click.
        await runDigestSingleFlight(
          requestKey,
          async () => undefined,
        );
        if (!isCurrentDigest(videoId, generation, routeKey)) return;
        await runDigestSingleFlight(
          requestKey,
          () =>
            runDigestLoad(
              videoId,
              generation,
              false,
              requestMediaRef,
              routeKey,
              true,
            ),
        );
      });
      return;
    }
    if (transcriptResult.error === "SUPADATA_NOT_CONFIGURED") {
      showSupadataNotConfigured(
        transcriptResult.message ||
          "新的 YouTube 字幕需要 Supadata。请在设置中配置密钥后逐次授权。",
      );
      return;
    }
    if (transcriptResult.error === "RATE_LIMITED") {
      showSupadataRateLimited(
        transcriptResult.message ||
          "Supadata 请求已达速率上限，请稍后再授权重试。",
      );
      return;
    }
    if (transcriptResult.error === "INVALID_SUPADATA_KEY") {
      showSupadataInvalidKey(transcriptResult.message);
      return;
    }
    if (
      [
        "PROVIDER_TIMEOUT",
        "RESPONSE_TOO_LARGE",
        "NETWORK_ERROR",
        "PROVIDER_HTTP_ERROR",
        "PROVIDER_FAILED",
        "PROVIDER_ERROR",
      ].includes(transcriptResult.error)
    ) {
      showSupadataProviderError(transcriptResult.message);
      return;
    }
    showError(
      "未找到字幕",
      transcriptResult.message || transcriptResult.error,
    );
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = normalizeLanguageCode(transcriptResult.language) || null;
  currentTranscriptSource = String(transcriptResult.source || "");
  currentTranscriptSelectedTrack = sanitizeTranscriptSelectedTrack(
    transcriptResult.selectedTrack,
  );
  currentTranscriptSourceAttempt = String(
    transcriptResult.sourceAttempt || "",
  ).slice(0, 40);
  if (transcriptResult.mediaRef) currentMediaRef = transcriptResult.mediaRef;
  if (
    currentMediaRef?.platform === "bilibili" &&
    !currentVideoSourceLanguage
  ) {
    currentVideoSourceLanguage = currentTranscriptLanguage || "";
  }
  applyMediaLanguageDefaults();

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);
  if (!isCurrentDigest(videoId, generation, routeKey)) return;

  refreshOverviewForCurrentVideoIfVisible();

  // Generate analysis only when Overview is the active tab. Otherwise keep the
  // original lazy-load behavior so transcript-only use does not spend AI tokens.
}

// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function hasUsableChineseAnalysis(analysis) {
  return (
    analysis?.schemaVersion === 3 &&
    analysis?.baseLanguage === "zh-Hans" &&
    Array.isArray(analysis?.chapters) &&
    analysis.chapters.length > 0 &&
    analysis.chapters.every(
      (chapter) =>
        [chapter?.titleZh, chapter?.summaryZh].every(
          (value) => typeof value === "string" && value.trim(),
        ) && /[\u3400-\u9fff]/.test(chapter.summaryZh),
    ) &&
    Array.isArray(analysis?.keyQuotes) &&
    analysis.keyQuotes.length > 0 &&
    analysis.keyQuotes.every(
      (quote) =>
        [quote?.quoteOriginal, quote?.quoteZh].every(
          (value) => typeof value === "string" && value.trim(),
        ) && /[\u3400-\u9fff]/.test(quote.quoteZh),
    )
  );
}

function hasCompleteOriginalAnalysis(analysis) {
  if (!hasUsableChineseAnalysis(analysis)) return false;
  if (isConfirmedSimplifiedChineseSource(analysis.sourceLanguage)) return true;
  return (
    analysis.chapters.every(
      (chapter) =>
        [chapter?.titleOriginal, chapter?.summaryOriginal].every(
          (value) => typeof value === "string" && value.trim(),
        ),
    )
  );
}

function setOverviewTranslationStatus(message = "", isError = false) {
  const status = document.getElementById("overviewTranslationStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", isError);
  status.hidden = !message;
}

function setOverviewTranslationLoading(show) {
  isOverviewTranslationLoading = show;
  const spinner = document.getElementById("overviewLangSpinner");
  spinner?.classList.toggle("visible", show);
}

function renderChapterLanguageContent(
  chapter,
  mode = currentOverviewMode,
  sourceLanguage = currentAnalysis?.sourceLanguage,
) {
  const normalizedSourceLanguage = normalizeLanguageCode(sourceLanguage);
  const chineseSource = isConfirmedSimplifiedChineseSource(
    normalizedSourceLanguage,
  );
  const renderBlock = (language, title, summary, lang) => `
    <span class="overview-language-block overview-language-block--${language}" lang="${lang}">
      <span class="chapter-title">${escapeHtml(title || "")}</span>
      <span class="chapter-summary">${escapeHtml(summary || "")}</span>
    </span>
  `;

  const chinese = renderBlock(
    "zh",
    chapter.titleZh,
    chapter.summaryZh,
    "zh-CN",
  );
  if (mode === "zh" || chineseSource) return chinese;
  const hasOriginal = [chapter.titleOriginal, chapter.summaryOriginal].every(
    (value) => typeof value === "string" && value.trim(),
  );
  if (!hasOriginal) return chinese;
  const original = renderBlock(
    "original",
    chapter.titleOriginal,
    chapter.summaryOriginal,
    normalizedSourceLanguage || "und",
  );
  return mode === "bilingual" ? original + chinese : original;
}

function renderQuoteLanguageContent(
  quote,
  mode = currentOverviewMode,
  sourceLanguage = currentAnalysis?.sourceLanguage,
) {
  const normalizedSourceLanguage = normalizeLanguageCode(sourceLanguage);
  const chineseSource = isConfirmedSimplifiedChineseSource(
    normalizedSourceLanguage,
  );
  const renderBlock = (language, text, lang) => `
    <span class="overview-language-block overview-language-block--${language}" lang="${lang}">${escapeHtml(text || "")}</span>
  `;

  const chinese = renderBlock("zh", quote.quoteZh, "zh-CN");
  if (mode === "zh" || chineseSource) return chinese;
  const original = renderBlock(
    "original",
    quote.quoteOriginal,
    normalizedSourceLanguage || "und",
  );
  return mode === "bilingual" ? original + chinese : original;
}

function overviewQuoteCopyText(
  quote,
  mode = currentOverviewMode,
  sourceLanguage = currentAnalysis?.sourceLanguage,
) {
  if (mode === "zh" || isConfirmedSimplifiedChineseSource(sourceLanguage)) {
    return quote.quoteZh || quote.quoteOriginal || "";
  }
  if (mode === "bilingual") {
    return [quote.quoteOriginal, quote.quoteZh].filter(Boolean).join("\n");
  }
  return quote.quoteOriginal || quote.quoteZh || "";
}

function setOverviewModeButtons(mode) {
  document.querySelectorAll(".overview-mode-btn").forEach((button) => {
    const active = button.dataset.overviewMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function handleOverviewModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentOverviewMode) return;
  currentOverviewMode = mode;
  setOverviewModeButtons(mode);
  if (currentAnalysis) renderAnalysisResults(currentAnalysis);
  if (mode === "zh") {
    setOverviewTranslationStatus();
  } else {
    void ensureOverviewOriginal();
  }
}

async function ensureOverviewOriginal() {
  if (
    !currentAnalysis ||
    isConfirmedSimplifiedChineseSource(currentAnalysis.sourceLanguage) ||
    hasCompleteOriginalAnalysis(currentAnalysis) ||
    isOverviewTranslationLoading
  ) {
    return;
  }

  const sourceAnalysis = currentAnalysis;
  const videoId = currentVideoId;
  const generation = digestGeneration;
  const sourceLanguage = normalizeLanguageCode(sourceAnalysis.sourceLanguage);
  const sourcePrimaryLanguage = sourceLanguage.split("-")[0];
  if (
    !sourceLanguage ||
    ["und", "mul", "zxx"].includes(sourcePrimaryLanguage)
  ) {
    setOverviewTranslationStatus(
      "无法确认原字幕语言，已保留中文概览。",
      true,
    );
    return;
  }
  let appliedAnalysis = null;
  const ownsRequest = () =>
    isCurrentDigest(videoId, generation) &&
    (currentAnalysis === sourceAnalysis || currentAnalysis === appliedAnalysis);
  setOverviewTranslationLoading(true);
  setOverviewTranslationStatus("正在生成原文概览…");

  try {
    const result = await chrome.runtime.sendMessage({
      action: "translateOverviewOriginal",
      analysis: sourceAnalysis,
      videoTitle: currentVideoTitle,
      targetLanguage: sourceLanguage,
    });
    if (!ownsRequest()) return;
    if (!result) {
      throw new Error("扩展后台未响应原文翻译请求，请重新加载扩展。");
    }
    if (!result?.success) {
      throw new Error(result?.error || "原文概览生成失败");
    }

    const translatedById = new Map(
      (result.originalOverview?.chapters || []).map((chapter) => [
        chapter.id,
        chapter,
      ]),
    );
    const merged = {
      ...sourceAnalysis,
      chapters: sourceAnalysis.chapters.map((chapter, index) => ({
        ...chapter,
        titleOriginal:
          translatedById.get(`chapter-${index}`)?.titleOriginal || "",
        summaryOriginal:
          translatedById.get(`chapter-${index}`)?.summaryOriginal || "",
      })),
    };
    if (!hasCompleteOriginalAnalysis(merged)) {
      throw new Error("原文概览返回不完整，请重试。");
    }

    appliedAnalysis = merged;
    currentAnalysis = merged;
    setOverviewTranslationStatus();
    renderAnalysisResults(currentAnalysis);
    await saveToCache(videoId);
  } catch (error) {
    if (!ownsRequest()) return;
    setOverviewTranslationStatus(
      `原文概览生成失败，已保留中文内容。${error.message || "请稍后重试。"}`,
      true,
    );
  } finally {
    if (ownsRequest()) setOverviewTranslationLoading(false);
  }
}

function renderAnalysisResults(analysis) {
  if (!hasUsableChineseAnalysis(analysis)) return;
  setOverviewModeButtons(currentOverviewMode);

  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    const chapterTime = formatTimecode(chapter.timestampSeconds);
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapterTime)}</span>
      <div class="chapter-content">
        ${renderChapterLanguageContent(chapter, currentOverviewMode, analysis.sourceLanguage)}
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[DigestDock Panel] Chapter clicked:",
        chapterTime,
        chapter.timestampSeconds,
      );
      setActiveChapter(li);
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    const quoteCopyText = overviewQuoteCopyText(
      quote,
      currentOverviewMode,
      analysis.sourceLanguage,
    );
    const quoteTime = formatTimecode(quote.timestampSeconds);
    div.innerHTML = `
      <div class="quote-text">${renderQuoteLanguageContent(quote, currentOverviewMode, analysis.sourceLanguage)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quoteTime)}</span>
        <div class="quote-actions">
          <button class="icon-btn quote-save-note-btn" type="button" title="把这条语句保存为笔记" aria-label="把这条语句保存为笔记">${UI_ICONS.bookmarkPlus}</button>
          <button class="icon-btn quote-copy-btn" type="button" title="复制这条语句" aria-label="复制这条语句">${UI_ICONS.copy}</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[DigestDock Panel] Quote clicked:",
        quoteTime,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(quoteCopyText);
        flashIconDone(quoteCopyBtn, "已复制", "复制这条语句");
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const restoreTitle = btn.getAttribute("title") || "把这条语句保存为笔记";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      mediaRef: currentMediaRef,
      videoUrl: currentMediaRef?.canonicalUrl || currentVideoUrl,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      tabId: videoTabId,
      preferredLanguage:
        currentVideoSourceLanguage || currentTranscriptLanguage || "",
    });

    if (result.success) {
      btn.disabled = false;
      flashIconDone(btn, "已保存为笔记", restoreTitle);
      // The background noteSaved broadcast owns the Notes refresh. Calling
      // loadNotes here as well can start two translation jobs for one save.
    } else {
      console.error("[DigestDock] Save quote as note failed:", result.error);
      btn.disabled = false;
      btn.setAttribute("title", "保存失败");
      setTimeout(() => btn.setAttribute("title", restoreTitle), 1500);
    }
  } catch (error) {
    console.error("[DigestDock] Save quote as note error:", error);
    btn.disabled = false;
    btn.setAttribute("title", "保存失败");
    setTimeout(() => btn.setAttribute("title", restoreTitle), 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Seeks from a time-rail click while keeping any in-progress text selection
 * inert. Only the time code carries this handler; the transcript body stays
 * natively selectable and never seeks.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

/**
 * Keyboard activation for the time-rail seek target (Enter / Space).
 */
function seekFromTranscriptTimeKey(event, seconds) {
  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
    return;
  }
  event.preventDefault();
  seekTo(seconds);
}

/**
 * Builds the time-rail markup for a transcript card. The time code is the only
 * seek target (keyboard-focusable button); the body remains selectable text.
 */
function transcriptTimeCellMarkup(seconds) {
  const timestamp = formatTimecode(seconds);
  return `<span class="transcript-time" role="button" tabindex="0" title="跳转到 ${timestamp}" aria-label="跳转到 ${timestamp}">${timestamp}</span>`;
}

/**
 * Wires the time-rail seek handlers on a freshly rendered transcript card.
 */
function attachTranscriptTimeSeek(cardEl, seconds) {
  const timeEl = cardEl.querySelector(".transcript-time");
  if (!timeEl) return;
  timeEl.addEventListener("click", (event) =>
    seekFromTranscriptEntryClick(event, seconds),
  );
  timeEl.addEventListener("keydown", (event) =>
    seekFromTranscriptTimeKey(event, seconds),
  );
}

/**
 * Marks the clicked overview chapter as selected (cool fill + short blue-cyan
 * accent) and clears the state from its siblings. Presentation only.
 */
function setActiveChapter(activeItem) {
  const chapterList = document.getElementById("chapterList");
  if (!chapterList) return;
  chapterList
    .querySelectorAll(".chapter-item.active-chapter")
    .forEach((item) => item.classList.remove("active-chapter"));
  activeItem?.classList.add("active-chapter");
}

// Inline line icons for compact action buttons. Kept as small stroke SVGs so
// they inherit currentColor and stay crisp at 15px. No emoji, no play triangle.
const UI_ICONS = Object.freeze({
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14z"></path></svg>`,
  bookmarkPlus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h6"></path><line x1="18" y1="3" x2="18" y2="9"></line><line x1="15" y1="6" x2="21" y2="6"></line></svg>`,
  more: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>`,
});

/**
 * Briefly flags an icon button as "done" (success color) without disturbing
 * its icon, then restores it. Used for copy/save feedback on icon-only buttons.
 */
function flashIconDone(btn, doneTitle, restoreTitle, ms = 1600) {
  if (!btn) return;
  btn.classList.add("is-done");
  if (doneTitle) {
    btn.setAttribute("title", doneTitle);
    btn.setAttribute("aria-label", doneTitle);
  }
  setTimeout(() => {
    btn.classList.remove("is-done");
    if (restoreTitle) {
      btn.setAttribute("title", restoreTitle);
      btn.setAttribute("aria-label", restoreTitle);
    }
  }, ms);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show a small badge indicating the transcript came from the video's
  // existing subtitles. (We no longer AI-transcribe audio, so subtitles
  // are the only source.)
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> ${escapeHtml(transcriptSourceLabel())} · ${escapeHtml(getOriginalTranscriptLabel())}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    div.innerHTML = `
      ${transcriptTimeCellMarkup(group.start)}
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    attachTranscriptTimeSeek(div, group.start);
    transcriptList.appendChild(div);
  });

  // Keep the Chinese / bilingual buttons disabled for confirmed Simplified
  // sources and re-enabled for every other (incl. Traditional) video.
  updateTranscriptModeAvailability();

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function copyTranscript() {
  copyToClipboardWithFeedback(currentTranscriptText || "", "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = currentTranscriptText || "";
  const videoUrl =
    currentMediaRef?.canonicalUrl || currentVideoUrl || "";

  let exportText = "";
  exportText += `字幕\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `标题：${currentVideoTitle || "未知"}\n`;
  exportText += `频道：${currentChannelName || "未知"}\n`;
  exportText += `网址：${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `视频简介：\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `字幕：\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `由 DigestDock 导出\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

/**
 * Composes the compact meta line under the video title: channel, then the
 * total duration (H:MM:SS) when it is known. Presentation only.
 */
function updateVideoMetaLine() {
  const channelEl = document.getElementById("videoChannel");
  if (!channelEl) return;
  const parts = [];
  if (currentChannelName) parts.push(currentChannelName);
  if (Number(currentVideoDuration) > 0) {
    parts.push(formatTimecode(currentVideoDuration));
  }
  channelEl.textContent = parts.join(" · ");
}

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";
  updateHeaderLanguageControlsVisibility();

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  errorSecondaryAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  const primaryButton = document.getElementById("errorBtn");
  const secondaryButton = document.getElementById("errorSecondaryBtn");
  primaryButton.textContent = "重试";
  primaryButton.disabled = false;
  if (secondaryButton) {
    secondaryButton.textContent = "不使用";
    secondaryButton.disabled = false;
    secondaryButton.hidden = true;
  }
}

function showSupadataConsent(onConfirm) {
  showError(
    "是否使用 Supadata 获取字幕？",
    "此视频将通过 Supadata 获取 YouTube 原生字幕。点击后会把此视频的标准 YouTube 链接发送给 Supadata，并可能消耗你的 API 额度。",
  );
  const primaryButton = document.getElementById("errorBtn");
  const secondaryButton = document.getElementById("errorSecondaryBtn");
  primaryButton.textContent = "本次使用 Supadata";
  if (secondaryButton) {
    secondaryButton.textContent = "不使用第三方服务";
    secondaryButton.hidden = false;
  }

  errorAction = async () => {
    primaryButton.disabled = true;
    if (secondaryButton) secondaryButton.disabled = true;
    showState("loading");
    updateLoading(
      "正在通过 Supadata 提取字幕",
      "本次请求会使用你的 Supadata API 额度…",
    );
    try {
      await onConfirm();
    } catch (error) {
      showError(
        "Supadata 提取失败",
        error?.message || "第三方字幕请求未能完成，请稍后重试。",
      );
    }
  };
  errorSecondaryAction = () => {
    showSupadataDeclined();
  };
  primaryButton.focus();
}

// After the user declines the third-party request, stay in a safe no-transcript
// state. Do NOT offer a native retry that would immediately send a request; the
// mainline has no local YouTube caption path. The default primary re-opens the
// same single-attempt consent prompt (it never sends a request on its own).
function showSupadataDeclined() {
  showError(
    "已跳过 Supadata 字幕",
    "没有向 Supadata 发送视频链接。此视频暂时没有可用字幕。如需字幕，可重新在侧栏本次授权 Supadata，或在设置中调整可选配置。",
  );
  const secondaryButton = document.getElementById("errorSecondaryBtn");
  if (secondaryButton) {
    secondaryButton.textContent = "打开设置";
    secondaryButton.hidden = false;
  }
  errorSecondaryAction = () =>
    chrome.runtime.sendMessage({ action: "openOptions" });
}

// A Supadata 429. The message must make clear this is Supadata's rate limit,
// never YouTube's. The background keeps a bounded cooldown, so an immediate
// retry stays local until it clears.
function showSupadataRateLimited(message) {
  showError(
    "Supadata 暂时限流",
    message ||
      "Supadata 请求已达速率上限，请稍后再授权重试。这是 Supadata 的限流，并非 YouTube。",
  );
}

function showSupadataNotConfigured(message) {
  showError(
    "未配置 Supadata",
    message ||
      "新的 YouTube 字幕需要 Supadata。请在设置中配置可选的 Supadata 密钥，然后回到侧栏逐次授权。",
  );
  const primaryButton = document.getElementById("errorBtn");
  primaryButton.textContent = "打开设置";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

function showSupadataInvalidKey(message) {
  showError(
    "Supadata 密钥无效",
    message || "请在设置中更新 Supadata API 密钥后重新授权。",
  );
  const primaryButton = document.getElementById("errorBtn");
  primaryButton.textContent = "打开设置";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

function showSupadataProviderError(message) {
  showError(
    "Supadata 获取失败",
    message || "Supadata 暂时不可用，请稍后重新授权重试。",
  );
}

function showPageRefreshRequired(tabId, message) {
  showError(
    "请刷新 YouTube 页面",
    message || "DigestDock 已更新，请刷新当前 YouTube 页面后重试。",
  );
  document.getElementById("errorBtn").textContent = "刷新页面";
  errorAction = () => {
    if (Number.isInteger(tabId)) return chrome.tabs.reload(tabId);
    return window.location.reload();
  };
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasAiKey) missingKeys.push("DeepSeek");

  showError(
    "缺少 API 密钥",
    `请在 DigestDock 设置中添加 ${missingKeys.join(" 和 ")} API 密钥。`,
  );
  document.getElementById("errorBtn").textContent = "打开设置";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

function showRuntimeVersionError() {
  showError(
    "扩展需要重新加载",
    "侧边栏与后台版本不一致。请在 chrome://extensions 中重新加载 DigestDock，然后关闭并重新打开侧边栏。",
  );
  document.getElementById("errorBtn").textContent = "重新检测";
  errorAction = () => window.location.reload();
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });
  updateHeaderLanguageControlsVisibility();

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Lazy-load LLM analysis when user switches to Overview tab
  if (tabName === "overview") {
    refreshOverviewForCurrentVideoIfVisible();
  }
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || isAnalysisLoading || currentAnalysis)
    return;

  const videoId = currentVideoId;
  const generation = digestGeneration;
  const routeKey = currentRouteKey;
  const mediaRef = currentMediaRef;
  const transcriptTimestamped = currentTranscriptTimestamped;
  const sourceLanguage = currentTranscriptLanguage;
  const videoTitle = currentVideoTitle;
  const channelName = currentChannelName;
  const videoDescription = currentVideoDescription;
  const videoDuration = currentVideoDuration;
  const ownsRequest = () =>
    isCurrentDigest(videoId, generation, routeKey) &&
    currentMediaRef?.mediaKey === mediaRef?.mediaKey &&
    currentTranscriptTimestamped === transcriptTimestamped;

  isAnalysisLoading = true;

  // Show loading indicators in the Overview tab
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");

  if (chapterList)
    chapterList.innerHTML =
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">正在生成章节…</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">正在提取关键语句…</div>';

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: transcriptTimestamped,
      videoTitle,
      channelName,
      videoDescription,
      videoDuration,
      platform: mediaRef?.platform || "youtube",
      sourceLanguage: sourceLanguage || "",
    });
    if (!ownsRequest()) return;

    if (!analysisResult.success) {
      const message = escapeHtml(
        analysisResult.message || analysisResult.error || "未知错误",
      );
      if (chapterList) {
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--danger); border: none;">分析失败：${message}</li>`;
      }
      if (quotesList) {
        quotesList.innerHTML = `<div class="quote-item" style="color: var(--danger); border-left-color: var(--border);">关键语句生成失败：${message}</div>`;
      }
      return;
    }

    if (!hasUsableChineseAnalysis(analysisResult.analysis)) {
      throw new Error("概览没有返回可用的中文内容，请重试。");
    }
    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis
    await saveToCache(videoId);
    if (!ownsRequest()) return;
    if (currentOverviewMode !== "zh") void ensureOverviewOriginal();
  } catch (error) {
    if (!ownsRequest()) return;
    console.error("[DigestDock Panel] Analysis error:", error);
    if (chapterList) {
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--danger); border: none;">出错了：${escapeHtml(error.message)}</li>`;
    }
    if (quotesList) {
      quotesList.innerHTML = `<div class="quote-item" style="color: var(--danger); border-left-color: var(--border);">出错了：${escapeHtml(error.message)}</div>`;
    }
  } finally {
    if (ownsRequest()) isAnalysisLoading = false;
  }
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[DigestDock Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[DigestDock Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored supported-video tab first.
    if (videoTabId) {
      try {
        await chrome.tabs.sendMessage(videoTabId, payload);
        debugLog("[DigestDock Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[DigestDock Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      tabId: videoTabId,
      payload,
    });
    debugLog("[DigestDock Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[DigestDock Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  const noteMediaKey = note?.mediaKey || note?.videoId;
  if (noteMediaKey && noteMediaKey === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
      tabId: videoTabId,
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  const restoreTitle = btn.getAttribute("title") || "";

  const success = await copyToClipboard(text);
  if (success) {
    flashIconDone(btn, "已复制", restoreTitle, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "未命名")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows an "Explain" button.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create the explain tooltip/button
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = `<button class="explain-btn">💡 解释</button>`;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";

  // Interacting with Explain must preserve the transcript selection and stay
  // isolated from document/row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener("mouseup", (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Only show if selecting within transcript
    const isInTranscript = transcriptList.contains(selection.anchorNode);

    // Allow any selection length (removed 10+ char requirement)
    if (text.length > 0 && isInTranscript) {
      selectedText = text;

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = "block";
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
    } else {
      tooltip.style.display = "none";
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  });

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">内容解释</div>
        <button class="explain-modal-close" id="closeExplain" aria-label="关闭解释">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>正在分析…</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">无法获取解释：${escapeHtml(result.message || result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">出错了：${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || videoId !== currentVideoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    const cachePrefix = transcriptTranslationCachePrefix(videoId);
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(cachePrefix)) {
        paragraphCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      analysisVideoId: currentAnalysis ? videoId : null,
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      transcriptSource: currentTranscriptSource,
      transcriptSelectedTrack: sanitizeTranscriptSelectedTrack(
        currentTranscriptSelectedTrack,
      ),
      transcriptSourceAttempt: currentTranscriptSourceAttempt,
      mediaRef: currentMediaRef,
      routeKey: currentRouteKey,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      transcriptSourcePolicyVersion: TRANSCRIPT_SOURCE_POLICY_VERSION,
      transcriptRequestedLanguage: currentVideoSourceLanguage || null,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[DigestDock] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;
    if (
      cached.transcriptSourcePolicyVersion !== TRANSCRIPT_SOURCE_POLICY_VERSION
    ) {
      return null;
    }
    // v4 binds every cached transcript to the active platform provider. A
    // legacy or unknown YouTube source must never masquerade as an authorized
    // Supadata result; Bilibili caches remain isolated to their own adapter.
    const cachedPlatform =
      cached.mediaRef?.platform ||
      (String(videoId).startsWith("bilibili:") ? "bilibili" : "youtube");
    const expectedSource =
      cachedPlatform === "bilibili" ? "bilibili" : "supadata";
    if (cached.transcriptSource !== expectedSource) {
      return null;
    }

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

function setNotesModeButtons(mode) {
  document.querySelectorAll(".notes-mode-btn").forEach((button) => {
    const active = button.dataset.notesMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
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
  return (
    !/[\u3040-\u30ff\uac00-\ud7af]/.test(heuristicText) &&
    cjkCount >= 1 &&
    cjkCount * 2 >= latinCount
  );
}

function noteHasPolishedChineseText(note) {
  return Boolean(
    isConfirmedSimplifiedChineseSource(note?.textLanguage) &&
    typeof note?.text === "string" &&
    note.text.trim()
  );
}

function noteOriginalText(note) {
  if (noteHasPolishedChineseText(note)) {
    return note.text.trim();
  }
  if (noteHasChineseSource(note)) {
    return String(note?.rawText || note?.text || "").trim();
  }
  return String(note?.text || note?.rawText || "").trim();
}

function canonicalStoredNoteText(text) {
  return String(text || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function looksLikeLegacyChineseNote(text) {
  const value = stripQuotedNonChineseScripts(text);
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(value)) return false;
  const cjkCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (value.match(/[A-Za-z]/g) || []).length;
  return cjkCount >= 1 && (latinCount === 0 || cjkCount * 2 >= latinCount);
}

function noteChineseText(note) {
  if (noteHasPolishedChineseText(note)) return note.text.trim();
  if (noteHasChineseSource(note)) return noteOriginalText(note);
  const translated = String(note?.translatedText || "").trim();
  if (!translated) return "";
  if (
    note?.translatedValidated === true &&
    note?.translatedValidationVersion === NOTE_TRANSLATION_VALIDATION_VERSION
  ) {
    if (note?.translatedUnchanged === true) {
      return canonicalStoredNoteText(translated) ===
        canonicalStoredNoteText(noteOriginalText(note))
        ? translated
        : "";
    }
    return translated;
  }
  return looksLikeLegacyChineseNote(translated) ? translated : "";
}

function renderNoteLanguageContent(note, mode = currentNotesMode) {
  const original = noteOriginalText(note);
  const chinese = noteChineseText(note);
  const renderBlock = (language, text) => {
    const contentLanguage =
      language === "zh" ||
      (language === "original" && noteHasChineseSource(note))
        ? "zh-CN"
        : "en";
    return `<span class="note-language-block note-language-block--${language}" lang="${contentLanguage}">“${escapeHtml(text)}”</span>`;
  };

  if (mode === "original") return renderBlock("original", original);
  if (mode === "zh") {
    return chinese
      ? renderBlock("zh", chinese)
      : renderBlock("original", original);
  }
  if (chinese && chinese === original) return renderBlock("zh", chinese);
  return chinese
    ? renderBlock("original", original) + renderBlock("zh", chinese)
    : renderBlock("original", original);
}

function noteCopyTextForMode(note, mode = currentNotesMode) {
  const original = noteOriginalText(note);
  const chinese = noteChineseText(note);
  if (mode === "original") return original;
  if (mode === "zh") return chinese || original;
  if (chinese && chinese === original) return original;
  return [original, chinese].filter(Boolean).join("\n");
}

function setNotesTranslationStatus(message = "", isError = false) {
  const status = document.getElementById("notesLanguageStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", isError);
  status.hidden = !message;
}

function setNotesTranslationLoading(show) {
  isNotesTranslationLoading = show;
  document
    .getElementById("notesLangSpinner")
    ?.classList.toggle("visible", show);
}

function summarizeNoteTranslationFailures(failures = []) {
  const codes = new Set(
    failures
      .map((failure) => String(failure?.code || ""))
      .filter(Boolean),
  );
  if (codes.has("RATE_LIMITED")) {
    return "DeepSeek 请求受限，请稍后再次点击当前语言重试。";
  }
  if (codes.has("PROVIDER_TIMEOUT")) {
    return "DeepSeek 请求超时，请再次点击当前语言重试。";
  }
  if (codes.has("NOTE_JOB_TIMEOUT")) {
    return "笔记翻译任务等待超时，请再次点击当前语言重试。";
  }
  if (codes.has("PROVIDER_ERROR")) {
    return "DeepSeek 请求失败，请检查网络或稍后再次点击当前语言重试。";
  }
  if (codes.has("OUTPUT_TRUNCATED")) {
    return "DeepSeek 输出被截断，请再次点击当前语言重试。";
  }
  if (codes.has("CONTENT_FILTERED")) {
    return "DeepSeek 未返回这条内容，已保留原文。";
  }
  if (codes.has("PROVIDER_UNAVAILABLE")) {
    return "DeepSeek 暂时不可用，请稍后再次点击当前语言重试。";
  }
  if (codes.has("UNEXPECTED_FINISH_REASON")) {
    return "DeepSeek 未正常完成响应，请再次点击当前语言重试。";
  }
  if (codes.has("RETRY_BUDGET_EXHAUSTED")) {
    return "本轮重试次数已达上限，请再次点击当前语言继续。";
  }
  if (codes.has("EMPTY_RESPONSE")) {
    return "DeepSeek 返回了空内容，请再次点击当前语言重试。";
  }
  if (codes.has("INVALID_JSON")) {
    return "DeepSeek 返回格式无法解析，请再次点击当前语言重试。";
  }
  if (codes.has("MISSING_ITEM")) {
    return "DeepSeek 返回结果漏掉了这条笔记，请再次点击当前语言重试。";
  }
  if (codes.has("MULTIPLE_CANDIDATES")) {
    return "DeepSeek 返回了多个冲突结果，请再次点击当前语言重试。";
  }
  if (codes.has("INVALID_TRANSLATION")) {
    return "返回内容仍主要为英文或含非中文脚本，已保留原文。";
  }
  if (codes.size) {
    return "模型未返回有效中文，请再次点击当前语言重试。";
  }
  return "再次点击当前的中文或双语即可重试。";
}

async function ensureNotesChinese() {
  if (
    currentNotesMode === "original" ||
    isNotesLoading ||
    isNotesTranslationLoading
  ) {
    return;
  }
  const missingNotes = currentNotes
    .map((note, index) => ({ note, index }))
    .filter(
      ({ note }) => noteOriginalText(note) && !noteChineseText(note),
    )
    .sort(
      (left, right) =>
        (noteTranslationAttemptCountById.get(left.note.id) || 0) -
          (noteTranslationAttemptCountById.get(right.note.id) || 0) ||
        left.index - right.index,
    )
    .map(({ note }) => note);
  if (!missingNotes.length) {
    setNotesTranslationStatus();
    return;
  }

  const generation = ++notesTranslationGeneration;
  const failureById = new Map();
  setNotesTranslationLoading(true);
  setNotesTranslationStatus(`正在生成 ${missingNotes.length} 条中文笔记…`);
  try {
    for (let index = 0; index < missingNotes.length; index += 10) {
      const batch = missingNotes.slice(index, index + 10);
      const result = await sendTranslationMessage({
        action: "translateNotes",
        notes: batch.map((note) => ({
          id: note.id,
          text: noteOriginalText(note),
          videoTitle: note.videoTitle || "",
          rawText: note.rawText || "",
          sourceLanguage: note.sourceLanguage || "",
          platform: note.platform === "bilibili" ? "bilibili" : "youtube",
          textLanguage: note.textLanguage || "",
        })),
      });
      if (generation !== notesTranslationGeneration) return;
      const translatedById = new Map(
        (result.translations || []).map((note) => [note.id, note]),
      );
      translatedById.forEach((_translation, id) => {
        noteTranslationAttemptCountById.delete(id);
      });
      (result.failures || []).forEach((failure) => {
        if (typeof failure?.id === "string" && failure.id) {
          failureById.set(failure.id, failure);
          if (
            [
              "EMPTY_RESPONSE",
              "INVALID_JSON",
              "MISSING_ITEM",
              "MULTIPLE_CANDIDATES",
              "ID_MISMATCH",
              "INVALID_TRANSLATION",
            ].includes(failure.code)
          ) {
            noteTranslationAttemptCountById.set(
              failure.id,
              (noteTranslationAttemptCountById.get(failure.id) || 0) + 1,
            );
          }
        }
      });
      currentNotes = currentNotes.map((note) =>
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
      renderNotes(currentNotes, currentNotesFilterVideoId);
      if (!result?.success) {
        if (!result?.failures?.length) {
          throw new Error(result?.error || "中文笔记生成失败");
        }
        break;
      }
      if (
        (result.failures || []).some((failure) =>
          [
            "RATE_LIMITED",
            "PROVIDER_TIMEOUT",
            "RETRY_BUDGET_EXHAUSTED",
          ].includes(failure?.code),
        )
      ) {
        break;
      }
      // One user action owns one bounded backend job (up to ten notes and five
      // provider calls). Remaining notes continue only after an explicit
      // retry, preventing large libraries from multiplying requests silently.
      break;
    }
    const remainingNotes = currentNotes.filter(
      (note) => noteOriginalText(note) && !noteChineseText(note),
    );
    if (remainingNotes.length) {
      const remainingFailures = remainingNotes
        .map((note) => failureById.get(note.id))
        .filter(Boolean);
      setNotesTranslationStatus(
        `${remainingNotes.length} 条中文笔记仍未生成，已保留原文。${summarizeNoteTranslationFailures(remainingFailures)}`,
        true,
      );
    } else {
      setNotesTranslationStatus();
    }
  } catch (error) {
    if (generation !== notesTranslationGeneration) return;
    setNotesTranslationStatus(
      `中文笔记生成失败，已保留原文。${error.message || "请稍后重试。"}`,
      true,
    );
  } finally {
    if (generation === notesTranslationGeneration) {
      setNotesTranslationLoading(false);
    }
  }
}

function retryMissingNotesFromUser() {
  if (
    currentNotesMode === "original" ||
    isNotesLoading ||
    isNotesTranslationLoading ||
    !currentNotes.some(
      (note) => noteOriginalText(note) && !noteChineseText(note),
    )
  ) {
    return;
  }
  const now = Date.now();
  if (now - lastNotesManualRetryAt < NOTES_MANUAL_RETRY_DEBOUNCE_MS) return;
  lastNotesManualRetryAt = now;
  void ensureNotesChinese();
}

function handleNotesModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentNotesMode) {
    retryMissingNotesFromUser();
    return;
  }
  currentNotesMode = mode;
  setNotesModeButtons(mode);
  renderNotes(currentNotes, currentNotesFilterVideoId);
  if (mode === "original") {
    notesTranslationGeneration += 1;
    setNotesTranslationLoading(false);
    setNotesTranslationStatus();
  } else {
    lastNotesManualRetryAt = Date.now();
    void ensureNotesChinese();
  }
}

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 * @param {{translateMissing?: boolean}} options - Whether this refresh may
 * generate missing Chinese note content. Storage-change refreshes stay local.
 */
async function loadNotes(videoId, { translateMissing = true } = {}) {
  const loadGeneration = ++notesLoadGeneration;
  const digestSnapshot = digestGeneration;
  const previousShowAll = currentNotesFilterVideoId === null;
  const ownsLoad = () =>
    loadGeneration === notesLoadGeneration &&
    (videoId === null ||
      (digestSnapshot === digestGeneration && videoId === currentVideoId));
  setNotesFilter(videoId === null);
  notesTranslationGeneration += 1;
  isNotesLoading = true;
  setNotesTranslationLoading(false);
  setNotesTranslationStatus();
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });
    if (!ownsLoad()) return;

    if (result.success) {
      currentNotes = Array.isArray(result.notes) ? result.notes : [];
      currentNotesFilterVideoId = videoId;
      isNotesLoading = false;
      renderNotes(currentNotes, videoId);
      if (translateMissing && currentNotesMode !== "original") {
        void ensureNotesChinese();
      }
    } else {
      setNotesFilter(previousShowAll);
    }
  } catch (error) {
    if (!ownsLoad()) return;
    setNotesFilter(previousShowAll);
    console.error("[DigestDock Panel] Load notes error:", error);
  } finally {
    if (ownsLoad()) isNotesLoading = false;
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");
  const languageStatus = document.getElementById("notesLanguageStatus");

  if (!notesList) return;

  notesList.innerHTML = "";
  setNotesModeButtons(currentNotesMode);

  if (!notes || notes.length === 0) {
    setNotesTranslationStatus();
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "当前视频还没有笔记。将鼠标移到视频上，点击书签图标即可保存。"
      : "还没有保存任何笔记。将鼠标移到视频上，点击书签图标即可保存。";
    return;
  }

  notesIntro.style.display = "none";
  if (languageStatus && !isNotesTranslationLoading) {
    const missingCount =
      currentNotesMode === "original"
        ? 0
        : notes.filter((note) => !noteChineseText(note)).length;
    if (!missingCount) setNotesTranslationStatus();
  }

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    const noteCopyText = noteCopyTextForMode(note);
    const noteTime = formatTimecode(note.timestampSeconds);
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" role="button" tabindex="0" data-seconds="${Number(note.timestampSeconds) || 0}" title="从 ${escapeHtml(noteTime)} 播放" aria-label="从 ${escapeHtml(noteTime)} 播放">${escapeHtml(noteTime)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <div class="note-more">
          <button class="note-more-btn" type="button" aria-haspopup="true" aria-expanded="false" title="更多操作" aria-label="更多操作">${UI_ICONS.more}</button>
          <div class="note-more-menu" role="menu" hidden>
            <button class="note-menu-item danger note-delete" type="button" role="menuitem" data-id="${escapeHtml(note.id)}">删除笔记</button>
          </div>
        </div>
      </div>
      <div class="note-text">${renderNoteLanguageContent(note)}</div>
      <div class="note-actions">
        <button class="icon-btn primary note-play" type="button" title="从此处播放" aria-label="从此处播放">${UI_ICONS.play}</button>
        <button class="icon-btn note-copy-text" type="button" title="复制文字" aria-label="复制文字">${UI_ICONS.copy}</button>
        <button class="icon-btn note-copy-link" type="button" title="复制时间戳链接" aria-label="复制时间戳链接">${UI_ICONS.link}</button>
      </div>
    `;

    // Timestamp click / keyboard - play from this point (in this tab or a new one)
    const timestampEl = noteEl.querySelector(".note-timestamp");
    timestampEl.addEventListener("click", () => playNote(note));
    timestampEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        playNote(note);
      }
    });

    // More menu — holds the destructive delete action
    const moreBtn = noteEl.querySelector(".note-more-btn");
    const moreMenu = noteEl.querySelector(".note-more-menu");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = moreMenu.hidden;
      closeAllNoteMenus();
      if (willOpen) {
        moreMenu.hidden = false;
        moreBtn.setAttribute("aria-expanded", "true");
      }
    });

    // Delete lives inside the more menu
    noteEl.querySelector(".note-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      closeAllNoteMenus();
      await deleteNote(note.id);
      loadNotes(filteredVideoId);
    });

    // Copy text button — copies just the note's text
    const copyTextBtn = noteEl.querySelector(".note-copy-text");
    copyTextBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(noteCopyText);
        flashIconDone(copyTextBtn, "已复制", "复制文字", 2000);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    // Copy timestamp button — copies the timestamped link
    const copyLinkBtn = noteEl.querySelector(".note-copy-link");
    copyLinkBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(note.timestampedUrl);
        flashIconDone(copyLinkBtn, "已复制链接", "复制时间戳链接", 2000);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () =>
      playNote(note),
    );

    notesList.appendChild(noteEl);
  });

  ensureNoteMenuDismissHandler();
}

/**
 * Closes any open note "more" menu and resets its trigger's expanded state.
 */
function closeAllNoteMenus() {
  document.querySelectorAll(".note-more-menu").forEach((menu) => {
    menu.hidden = true;
  });
  document.querySelectorAll(".note-more-btn").forEach((btn) => {
    btn.setAttribute("aria-expanded", "false");
  });
}

let noteMenuDismissHandlerAdded = false;

/**
 * Registers one-time listeners so an outside click or Escape closes any open
 * note "more" menu.
 */
function ensureNoteMenuDismissHandler() {
  if (noteMenuDismissHandlerAdded) return;
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".note-more")) closeAllNoteMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllNoteMenus();
  });
  noteMenuDismissHandlerAdded = true;
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[DigestDock Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      tabId: videoTabId,
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `原文（${language}）`
    : "原文";
}

/**
 * True only for a caption track we can positively identify as Simplified
 * Chinese: a `zh` primary tag paired with an explicit Simplified script/region
 * subtag (zh-Hans, zh-CN, zh-SG). A bare `zh` and every Traditional tag
 * (zh-Hant, zh-TW, zh-HK, zh-MO) — plus other varieties like yue — stay
 * translatable, so Traditional → Simplified conversion keeps working.
 */
function isConfirmedSimplifiedChineseSource(value) {
  const normalized = normalizeLanguageCode(value);
  if (!normalized) return false;
  const [primary, ...subtags] = normalized.split("-");
  if (primary !== "zh") return false;

  // An explicit script is stronger evidence than a region. For example,
  // zh-Hant-CN is still Traditional even though its region is CN.
  if (subtags.includes("hant")) return false;
  if (subtags.includes("hans")) return true;
  return subtags.includes("cn") || subtags.includes("sg");
}

function currentVideoIsChinese() {
  return isChineseLanguage(currentTranscriptLanguage);
}

/**
 * Reflects whether Chinese / bilingual transcript translation applies to the
 * current video. The user reads both Simplified and Traditional Chinese, so any
 * Chinese transcript is already in the target language. Disable those buttons
 * rather than issuing a redundant, billable translation.
 */
function updateTranscriptModeAvailability() {
  const unavailable = currentVideoIsChinese();
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    if (button.dataset.transcriptMode === "original") {
      button.disabled = false;
      button.removeAttribute("aria-disabled");
      button.removeAttribute("title");
      return;
    }
    button.disabled = unavailable;
    if (unavailable) {
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("title", "字幕已是中文，无需翻译。");
    } else {
      button.removeAttribute("aria-disabled");
      button.removeAttribute("title");
    }
  });
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCachePrefix(videoId) {
  return `${videoId}:zh:semantic:v${TRANSCRIPT_TRANSLATION_CACHE_VERSION}:`;
}

function transcriptTextFingerprint(text) {
  const normalized = normalizeCaptionText(text);
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

function transcriptTranslationCacheKey(videoId, segment) {
  return `${transcriptTranslationCachePrefix(videoId)}${segment.id}:${transcriptTextFingerprint(segment.text)}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleTranscriptModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentTranscriptMode) return;

  // Any Chinese transcript is already readable in the requested target
  // language. Never switch it into a duplicated view or send it for
  // translation. The controls are also disabled, but this guards the state
  // directly in case a change is triggered another way.
  if (mode !== "original" && currentVideoIsChinese()) {
    return;
  }

  const previousMode = currentTranscriptMode;
  currentTranscriptMode = mode;

  // Chinese-only and bilingual are two presentations of the same translated
  // segments. Keep the active queue and observer alive, and only re-render the
  // row content. Restarting translateTranscript here would discard an in-flight
  // provider response and issue the same billable request again.
  if (previousMode !== "original" && mode !== "original") {
    setTranscriptModeButtons(mode);
    renderTranscriptTranslationMode(mode);
    return;
  }

  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);

  if (mode === "original") {
    renderTranscript();
    return;
  }

  await translateTranscript();
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">重试</button>`;
  } else {
    translationHtml = "等待翻译…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptTranslationBadge(mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? `${originalLabel} + 简体中文`
      : `简体中文 · 译自${originalLabel}`;
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> ${escapeHtml(transcriptSourceLabel())} · ${modeLabel}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);
}

function attachTranslationRetry(row, index, generation) {
  const retry = row.querySelector(".translation-retry-btn");
  if (!retry) return;
  ["mousedown", "mouseup"].forEach((eventName) => {
    retry.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  });
  retry.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    retryTranslationSegment(index, generation);
  });
}

function renderTranscriptTranslationMode(mode) {
  const segments = getActiveTranscriptSegments();
  renderTranscriptTranslationBadge(mode);
  segments.forEach((segment, index) => {
    const row = document.querySelector(
      `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
    );
    if (!row) return;
    const translated = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(currentVideoId, segment),
    );
    const error = row.classList.contains("translation-failed")
      ? "翻译失败。"
      : "";
    const copy = row.querySelector(".transcript-copy");
    if (copy) {
      copy.outerHTML = renderTranscriptSegmentContent(
        segment,
        mode,
        translated,
        error,
      );
    }
    attachTranslationRetry(row, index, translationGeneration);
  });
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  renderTranscriptTranslationBadge(mode);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(currentVideoId, segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    div.innerHTML = `
      ${transcriptTimeCellMarkup(segment.start)}
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    attachTranscriptTimeSeek(div, segment.start);
    transcriptList.appendChild(div);
    rows.push(div);
  });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "暂时无法获得翻译。",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(currentVideoId, segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  attachTranslationRetry(row, index, generation);
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration || videoId !== currentVideoId;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.message || result?.error || "翻译失败。";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "翻译失败。" },
        generation,
      );
    });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "正在重试…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  // Fail-safe: any Chinese transcript needs no translation. Collapse back to
  // the original view so no entry point (mode change, cache reload, retry) can
  // emit a redundant translateContent request or leave a duplicated row behind.
  if (currentVideoIsChinese()) {
    if (currentTranscriptMode !== "original") {
      currentTranscriptMode = "original";
      setTranscriptModeButtons("original");
    }
    renderTranscript();
    return;
  }

  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  translationGeneration += 1;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, 3);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(videoId, segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < 3) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  createSingleFlight,
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  loadNotes,
  hasUsableChineseAnalysis,
  hasCompleteOriginalAnalysis,
  normalizeLanguageCode,
  isChineseLanguage,
  isConfirmedSimplifiedChineseSource,
  isTransientTabLookupError,
  noteHasChineseSource,
  noteHasPolishedChineseText,
  noteOriginalText,
  noteChineseText,
  noteCopyTextForMode,
  summarizeNoteTranslationFailures,
  renderNoteLanguageContent,
  renderChapterLanguageContent,
  renderQuoteLanguageContent,
  overviewQuoteCopyText,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
  extractMediaLocator,
  transcriptTranslationCacheKey,
  formatTimecode,
};
