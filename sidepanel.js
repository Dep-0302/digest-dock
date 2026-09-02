/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for DigestDock: supported-video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const REQUIRED_RUNTIME_PROTOCOL_VERSION = 12;
const EXPORT_CONTENT_CONTRACT_VERSION = 4;
const OVERVIEW_CACHE_SCHEMA_VERSION = 2;
const ANALYSIS_TIMESTAMP_ANCHOR_VERSION = 1;
const OVERVIEW_CACHE_PREFIX = "overview_";
const OVERVIEW_CACHE_MAX_ENTRIES = 100;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// The MVP runtime is loaded by sidepanel.html before this legacy composition
// file. Node-only helper tests may intentionally omit it; production never does.
const SIDEPANEL_STATE_API = globalThis.DIGESTDOCK_SIDEPANEL_STATE || null;
const SIDEPANEL_EFFECTS_API = globalThis.DIGESTDOCK_SIDEPANEL_EFFECTS || null;
const SIDEPANEL_MVP_AVAILABLE = Boolean(
  SIDEPANEL_STATE_API && SIDEPANEL_EFFECTS_API,
);

let sidepanelMvpState = SIDEPANEL_MVP_AVAILABLE
  ? SIDEPANEL_STATE_API.createInitialState()
  : null;
let sidepanelMvpTaskSequence = 0;
let sidepanelMvpProgressOverride = null;
let sidepanelMvpSkeletonTimer = null;
let sidepanelMvpSkeletonVisible = false;
let sidepanelMvpCooldownTimer = null;
const sidepanelMvpTaskGate = SIDEPANEL_MVP_AVAILABLE
  ? SIDEPANEL_EFFECTS_API.createTaskGate()
  : null;
const sidepanelMvpConsentVault = SIDEPANEL_MVP_AVAILABLE
  ? SIDEPANEL_EFFECTS_API.createConsentTokenVault()
  : null;
const sidepanelMvpTranscriptFlight = SIDEPANEL_MVP_AVAILABLE
  ? SIDEPANEL_EFFECTS_API.createSingleFlight()
  : null;
const sidepanelMvpSupadataDispatcher = SIDEPANEL_MVP_AVAILABLE
  ? SIDEPANEL_EFFECTS_API.createSupadataDispatcher({
      tokenVault: sidepanelMvpConsentVault,
      send: (request) => chrome.runtime.sendMessage(request),
    })
  : null;

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
const runMetadataCaptureSingleFlight = createSingleFlight();

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
let currentVideoDescriptionZh = "";
let currentVideoDescriptionState = "unknown";
let currentVideoDescriptionTruncated = false;
let currentVideoDuration = 0;
let currentVideoSourceLanguage = "";
let currentVideoCaptionSelection = null;
let isAnalysisLoading = false; // Track if analysis is in progress
let videoTabId = null; // Exact supported video tab for seek/playback messaging.
let currentConfigStatus = null;
let errorAction = null;
let errorSecondaryAction = null;
let tabCheckGeneration = 0;
let digestGeneration = 0;

function hasConfiguredAiService(config = currentConfigStatus) {
  return config?.hasAiKey === true;
}

function activeAiServiceLabel(config = currentConfigStatus) {
  return String(config?.provider?.displayName || "当前 AI 服务").trim();
}

function aiFeatureSetupMessage(featureLabel) {
  return `字幕阅读、时间跳转和原文笔记无需 AI 密钥。${featureLabel}需要先在右上角设置中配置 ${activeAiServiceLabel()} API 密钥。`;
}

function openAiSettings() {
  return chrome.runtime.sendMessage({ action: "openOptions" });
}

// A cross-video click from the saved-notes library means "open this note",
// not "start acquiring subtitles".  Keep that intent in session storage so
// it survives Chrome swapping/recreating the global side-panel document while
// the new tab is activated.  The pending phase is short-lived and exact-tab
// bound; after it matches, the active phase lasts only while that tab remains
// on the same media route or until the user explicitly requests a digest tab.
const NOTE_NAVIGATION_SESSION_KEY = "ytd_note_navigation";
const NOTE_NAVIGATION_SCHEMA_VERSION = 1;
const NOTE_NAVIGATION_PENDING_TTL_MS = 15_000;
const NOTE_EXPORT_AUTHORIZATION_TTL_MS = 10 * 60_000;
let pendingNoteNavigation = null;
let activeNotesOnlyContext = null;
let noteNavigationResumePromise = null;
let noteNavigationStorageQueue = Promise.resolve();
let noteExportContinuationResumePromise = null;
let activeNoteExportAuthorization = null;
let noteExportAuthorizationGeneration = 0;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let currentOverviewMode = "zh";
let currentNotesMode = "bilingual";
let currentNotes = [];
let currentNotesFilterVideoId;
let notesFilterShowAll = false;
let noteExportPickerGroups = [];
let noteExportPickerPrecheck = null;
let noteExportPickerSourcesByKey = {};
let selectedNoteExportMediaKeys = new Set();
let isOverviewTranslationLoading = false;
let isNotesTranslationLoading = false;
let isNotesLoading = false;
let notesTranslationGeneration = 0;
let notesLoadGeneration = 0;
let lastNotesManualRetryAt = 0;
let noteTranslationAttemptCountById = new Map();
// Bounds re-requests of a persistently failing title translation (keyed by
// mediaKey) so repeated mode toggles cannot loop on the same failure.
let noteTitleTranslationAttemptByKey = new Map();
const NOTE_TITLE_TRANSLATION_MAX_ATTEMPTS = 3;
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
let exportTranslationGeneration = 0;
let isExportTranslationRunning = false;
let activeExportJobId = "";
let currentPersistedNoteSource = null;
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;
const NOTES_MANUAL_RETRY_DEBOUNCE_MS = 400;
const NOTE_TRANSLATION_VALIDATION_VERSION = 1;
const NOTE_TITLE_TRANSLATION_VALIDATION_VERSION = 1;
const TRANSCRIPT_TRANSLATION_CACHE_VERSION = 2;
const TRANSCRIPT_SOURCE_POLICY_VERSION = 5;
const YOUTUBE_TRANSCRIPT_SOURCES = new Set([
  "youtube-passive",
  "youtube-active",
  "youtube-panel",
  "supadata",
]);
const YOUTUBE_TRANSCRIPT_TRACK_KIND = "manual-first";

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

function transcriptSelectedTrackIdentity(track) {
  const selected = sanitizeTranscriptSelectedTrack(track);
  if (!selected) return "none";
  return [
    selected.language || "",
    selected.kind,
    selected.isGenerated ? "generated" : "manual",
    Number.isInteger(selected.index) ? String(selected.index) : "",
  ].join(":");
}

function transcriptContentFingerprint(transcriptTimestamped, transcriptText = "") {
  return overviewTranscriptFingerprint(
    String(transcriptTimestamped || transcriptText || ""),
  );
}

function transcriptArtifactIdentity({
  source = "",
  language = "",
  requestedLanguage = "",
  selectedTrack = null,
  fingerprint = "",
} = {}) {
  const normalizedSource = String(source || "").trim();
  const normalizedLanguage = normalizeLanguageCode(language);
  const normalizedRequestedLanguage = normalizeLanguageCode(requestedLanguage);
  const normalizedFingerprint = String(fingerprint || "").trim();
  if (!normalizedSource || !normalizedFingerprint) return "";
  return JSON.stringify({
    source: normalizedSource,
    language: normalizedLanguage,
    requestedLanguage: normalizedRequestedLanguage,
    selectedTrack: transcriptSelectedTrackIdentity(selectedTrack),
    fingerprint: normalizedFingerprint,
  });
}

function currentTranscriptArtifactIdentity() {
  return transcriptArtifactIdentity({
    source: currentTranscriptSource,
    language: currentTranscriptLanguage,
    requestedLanguage: currentVideoSourceLanguage,
    selectedTrack: currentTranscriptSelectedTrack,
    fingerprint: transcriptContentFingerprint(
      currentTranscriptTimestamped,
      currentTranscriptText,
    ),
  });
}

function cachedTranscriptArtifactIdentity(cached) {
  if (!cached || typeof cached !== "object") return "";
  const computedFingerprint = transcriptContentFingerprint(
    cached.transcriptTimestamped,
    cached.transcriptText,
  );
  if (
    cached.transcriptFingerprint &&
    cached.transcriptFingerprint !== computedFingerprint
  ) {
    return "";
  }
  return transcriptArtifactIdentity({
    source: cached.transcriptSource,
    language: cached.transcriptLanguage,
    requestedLanguage: cached.transcriptRequestedLanguage,
    selectedTrack: cached.transcriptSelectedTrack,
    fingerprint: computedFingerprint,
  });
}

function buildTranscriptFetchRequest({
  videoId,
  mediaRef,
  preferredLanguage = "",
  tabId = null,
  generation,
  routeKey,
  supadataConsent = false,
  captionRetry = false,
}) {
  const runId = String(generation);
  return {
    action: "fetchTranscript",
    videoId: mediaRef?.videoId || videoId,
    mediaRef,
    preferredLanguage,
    trackKind: YOUTUBE_TRANSCRIPT_TRACK_KIND,
    tabId,
    runId,
    digestGeneration: generation,
    routeKey,
    supadataConsent: supadataConsent === true,
    captionRetry: captionRetry === true,
  };
}

function transcriptResponseMatchesRequest(
  result,
  request,
  { platform = "youtube" } = {},
) {
  if (!result || !request) return false;
  // The run identity is part of the new YouTube native-chain contract only.
  // Bilibili keeps its independent, already-shipped response contract.
  if (platform === "bilibili") return true;
  return (
    String(result.runId ?? "") === String(request.runId ?? "") &&
    String(result.routeKey ?? "") === String(request.routeKey ?? "")
  );
}

function transcriptRouteOutcome(result) {
  const outcome = String(result?.routeOutcome || "").trim();
  if (
    [
      "HAVE_TRANSCRIPT",
      "CONFIRMED_UNAVAILABLE",
      "UNKNOWN",
      "PAGE_CONTEXT_CHANGED",
    ].includes(outcome)
  ) {
    return outcome;
  }
  if (result?.success) return "HAVE_TRANSCRIPT";
  if (result?.error === "PAGE_CONTEXT_CHANGED") return "PAGE_CONTEXT_CHANGED";
  return "";
}

function shouldOfferSupadata(result) {
  return (
    transcriptRouteOutcome(result) === "UNKNOWN" &&
    result?.supadataEligible !== false &&
    result?.requiresCaptionEnable !== true
  );
}

function sidepanelMvpCurrentIdentity() {
  if (!SIDEPANEL_MVP_AVAILABLE || !sidepanelMvpState?.session?.videoId) {
    return null;
  }
  return SIDEPANEL_STATE_API.normalizeIdentity(sidepanelMvpState.session);
}

function sidepanelMvpNextTaskId(origin = "task") {
  sidepanelMvpTaskSequence += 1;
  return `${String(origin).toLowerCase()}-${Date.now().toString(36)}-${sidepanelMvpTaskSequence}`;
}

function sidepanelMvpTaskResultEnvelope(task) {
  if (!task) return null;
  return {
    scope: "transcript",
    taskId: task.id,
    identity: task.identity,
  };
}

function sidepanelMvpRegisterCurrentTask() {
  const task = sidepanelMvpState?.transcript?.activeTask;
  if (!SIDEPANEL_MVP_AVAILABLE || !task) return null;
  return sidepanelMvpTaskGate.begin({
    scope: "transcript",
    taskId: task.id,
    taskOrigin: task.origin,
    identity: task.identity,
  });
}

function sidepanelMvpDispatch(event, { preserveProgress = false } = {}) {
  if (!SIDEPANEL_MVP_AVAILABLE) return null;
  const next = SIDEPANEL_STATE_API.reduceSidepanelState(sidepanelMvpState, event);
  if (next !== sidepanelMvpState && !preserveProgress) {
    sidepanelMvpProgressOverride = null;
  }
  sidepanelMvpState = next;
  renderSidepanelMvpTranscriptState();
  return sidepanelMvpState;
}

function sidepanelMvpBindSession(
  videoId,
  routeKey,
  { forceNewTask = false } = {},
) {
  if (!SIDEPANEL_MVP_AVAILABLE) return null;
  const previousIdentity = sidepanelMvpCurrentIdentity();
  const identityChanged =
    !previousIdentity ||
    previousIdentity.videoId !== videoId ||
    previousIdentity.routeKey !== routeKey;
  if (!identityChanged && !forceNewTask) {
    return sidepanelMvpState.transcript.activeTask;
  }

  clearTimeout(sidepanelMvpSkeletonTimer);
  clearTimeout(sidepanelMvpCooldownTimer);
  sidepanelMvpSkeletonTimer = null;
  sidepanelMvpCooldownTimer = null;
  sidepanelMvpSkeletonVisible = false;
  if (previousIdentity) sidepanelMvpConsentVault.revokeIdentity(previousIdentity);
  sidepanelMvpTaskGate.clear();

  if (!identityChanged) {
    const taskId = sidepanelMvpNextTaskId("generation");
    sidepanelMvpDispatch({
      type: SIDEPANEL_STATE_API.EVENTS.SESSION_BIND,
      videoId,
      routeKey,
      epoch: 0,
      forceGeneration: true,
      taskId,
      taskOrigin: SIDEPANEL_STATE_API.TASK_ORIGINS.INITIAL_LOAD,
    });
    return sidepanelMvpRegisterCurrentTask();
  }

  const taskId = sidepanelMvpNextTaskId("initial");
  sidepanelMvpDispatch({
    type: SIDEPANEL_STATE_API.EVENTS.SESSION_BIND,
    videoId,
    routeKey,
    epoch: 0,
    taskId,
    taskOrigin: SIDEPANEL_STATE_API.TASK_ORIGINS.INITIAL_LOAD,
  });
  return sidepanelMvpRegisterCurrentTask();
}

function sidepanelMvpBeginEvent(type, origin, extra = {}) {
  if (!SIDEPANEL_MVP_AVAILABLE) return null;
  const taskId = sidepanelMvpNextTaskId(origin);
  const previousState = sidepanelMvpState;
  sidepanelMvpDispatch({ type, taskId, ...extra });
  if (sidepanelMvpState === previousState) return null;

  const task = sidepanelMvpState?.transcript?.activeTask;
  const identity = sidepanelMvpCurrentIdentity();
  if (
    !task ||
    !identity ||
    task.id !== taskId ||
    task.origin !== origin ||
    !SIDEPANEL_STATE_API.sameIdentity(task.identity, identity)
  ) {
    return null;
  }
  return sidepanelMvpRegisterCurrentTask();
}

function sidepanelMvpResolveTranscript(result, task, { finishTask = true } = {}) {
  if (!SIDEPANEL_MVP_AVAILABLE || !task) return false;
  const envelope = sidepanelMvpTaskResultEnvelope(task);
  if (!sidepanelMvpTaskGate.isCurrent(envelope)) return false;
  sidepanelMvpDispatch({
    type: SIDEPANEL_STATE_API.EVENTS.TRANSCRIPT_RESULT,
    identity: task.identity,
    taskId: task.id,
    taskOrigin: task.origin,
    result,
  });
  if (finishTask) sidepanelMvpTaskGate.finish(envelope);
  return true;
}

function sidepanelMvpShowWorkspaceShell() {
  if (!SIDEPANEL_MVP_AVAILABLE || !sidepanelMvpState?.session?.videoId) return;
  const welcome = document.getElementById("welcomeState");
  const loading = document.getElementById("loadingState");
  const error = document.getElementById("errorState");
  const results = document.getElementById("resultsState");
  const tabs = document.getElementById("tabsNav");
  const videoInfo = document.getElementById("videoInfo");
  if (welcome) welcome.style.display = "none";
  if (loading) loading.style.display = "none";
  if (error) error.style.display = "none";
  if (results) results.style.display = "block";
  if (tabs) tabs.style.display = "flex";
  if (videoInfo) videoInfo.style.display = "block";
  const title = document.getElementById("videoTitle");
  if (title) title.textContent = currentVideoTitle || "当前视频";
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === sidepanelMvpState.activeTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle(
      "active",
      panel.dataset.panel === sidepanelMvpState.activeTab,
    );
  });
  updateVideoMetaLine();
  updateHeaderLanguageControlsVisibility();
}

function sidepanelMvpIconMarkup(component) {
  if (component.kind === SIDEPANEL_STATE_API.COMPONENT_KINDS.ERROR) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.8 19h18.4L12 3Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>';
  }
  if (component.kind === SIDEPANEL_STATE_API.COMPONENT_KINDS.CONSENT) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z"></path><path d="M9 12.2 11 14l4-4"></path></svg>';
  }
  if (component.kind === SIDEPANEL_STATE_API.COMPONENT_KINDS.TERMINAL) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path></svg>';
  }
  if (component.status === SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.NEEDS_CC) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="3"></rect><path d="M10 10.5a2 2 0 1 0 0 3"></path><path d="M17 10.5a2 2 0 1 0 0 3"></path></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h12"></path><path d="M8 12h12"></path><path d="M4 17h12"></path><circle cx="18" cy="7" r="1.5"></circle></svg>';
}

function appendSidepanelMvpSkeleton(region) {
  const list = document.createElement("div");
  list.className = "workspace-skeleton-list";
  list.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 4; index += 1) {
    const card = document.createElement("div");
    card.className = "workspace-skeleton-card";
    const time = document.createElement("div");
    time.className = "workspace-skeleton-time";
    const copy = document.createElement("div");
    copy.className = "workspace-skeleton-copy";
    const longLine = document.createElement("div");
    longLine.className = "workspace-skeleton-line";
    const shortLine = document.createElement("div");
    shortLine.className = "workspace-skeleton-line short";
    copy.append(longLine, shortLine);
    card.append(time, copy);
    list.append(card);
  }
  region.append(list);
}

function appendSidepanelMvpDetails(card, component) {
  if (component.status === SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.NEEDS_CC) {
    const steps = document.createElement("div");
    steps.className = "workspace-state-steps";
    for (const [number, text] of [
      ["01", "在 YouTube 播放器打开 CC"],
      ["02", "看到字幕后回到这里重新读取"],
    ]) {
      const step = document.createElement("div");
      step.className = "workspace-state-step";
      const marker = document.createElement("strong");
      marker.textContent = number;
      step.append(marker, document.createTextNode(text));
      steps.append(step);
    }
    card.append(steps);
  }

  if (
    component.status ===
    SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE
  ) {
    const scope = document.createElement("div");
    scope.className = "workspace-consent-scope";
    for (const text of ["仅当前视频", "仅本次调用", "可能消耗额度"]) {
      const item = document.createElement("div");
      item.className = "workspace-consent-item";
      item.textContent = text;
      scope.append(item);
    }
    card.append(scope);
  }
}

function renderSidepanelMvpTranscriptState() {
  if (!SIDEPANEL_MVP_AVAILABLE || typeof document === "undefined") return;
  const region = document.getElementById("transcriptStateRegion");
  const readyRegion = document.getElementById("transcriptReadyRegion");
  if (!region || !readyRegion || !sidepanelMvpState?.session?.videoId) return;

  sidepanelMvpShowWorkspaceShell();
  const view = SIDEPANEL_STATE_API.deriveView(sidepanelMvpState, {
    now: Date.now(),
    canReturnToNotes: isActiveNotesOnlyContext(),
  });
  const component = { ...view.transcript.component };
  if (
    sidepanelMvpProgressOverride &&
    component.kind === SIDEPANEL_STATE_API.COMPONENT_KINDS.PROGRESS
  ) {
    component.title = sidepanelMvpProgressOverride.title || component.title;
    component.message =
      sidepanelMvpProgressOverride.subtitle || component.message;
  }
  clearTimeout(sidepanelMvpCooldownTimer);
  sidepanelMvpCooldownTimer = null;
  if (component.cooldownRemainingMs > 0) {
    component.message = `${component.message}\n约 ${Math.max(
      1,
      Math.ceil(component.cooldownRemainingMs / 1000),
    )} 秒后可再次选择。`;
    sidepanelMvpCooldownTimer = setTimeout(() => {
      sidepanelMvpCooldownTimer = null;
      renderSidepanelMvpTranscriptState();
    }, component.cooldownRemainingMs + 25);
  }

  const isReady =
    component.status === SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.READY;
  const showRetainedReady =
    component.retainedReady === true && Boolean(currentTranscript?.length);
  readyRegion.hidden = !(isReady || showRetainedReady);
  readyRegion.classList.toggle("is-readonly", sidepanelMvpState.session.readOnly);
  const exportButton = document.getElementById("exportTranscriptBtn");
  if (exportButton) exportButton.disabled = sidepanelMvpState.session.readOnly;

  if (isReady) {
    clearTimeout(sidepanelMvpSkeletonTimer);
    sidepanelMvpSkeletonTimer = null;
    sidepanelMvpSkeletonVisible = false;
    region.hidden = true;
    region.replaceChildren();
    return;
  }

  region.hidden = false;
  region.className = `workspace-state-region kind-${component.kind.toLowerCase()}`;
  region.setAttribute(
    "aria-busy",
    String(component.kind === SIDEPANEL_STATE_API.COMPONENT_KINDS.PROGRESS),
  );
  region.setAttribute(
    "role",
    component.kind === SIDEPANEL_STATE_API.COMPONENT_KINDS.ERROR
      ? "alert"
      : "status",
  );
  region.setAttribute(
    "aria-live",
    component.kind === SIDEPANEL_STATE_API.COMPONENT_KINDS.ERROR
      ? "assertive"
      : "polite",
  );
  region.replaceChildren();

  const card = document.createElement("div");
  card.className = "workspace-state-card";
  const heading = document.createElement("div");
  heading.className = "workspace-state-heading";
  const icon = document.createElement("span");
  icon.className = "workspace-state-icon";
  icon.innerHTML = sidepanelMvpIconMarkup(component);
  const copy = document.createElement("div");
  copy.className = "workspace-state-copy";
  const title = document.createElement("div");
  title.className = "workspace-state-title";
  title.textContent = component.title;
  copy.append(title);
  if (component.message) {
    const message = document.createElement("div");
    message.className = "workspace-state-message";
    message.textContent = component.message;
    copy.append(message);
  }
  heading.append(icon, copy);
  card.append(heading);
  appendSidepanelMvpDetails(card, component);

  if (view.transcript.actions.length) {
    const actions = document.createElement("div");
    actions.className = "workspace-state-actions";
    const disabled = new Set(component.disabledActionIds || []);
    for (const model of view.transcript.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `workspace-state-action ${model.kind}`;
      button.dataset.mvpEvent = model.event.type;
      button.dataset.mvpActionId = model.id;
      button.textContent = model.label;
      button.disabled = disabled.has(model.id);
      actions.append(button);
    }
    card.append(actions);
  }
  region.append(card);

  const isInitialLoading =
    component.status === SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.LOADING;
  const showSkeletonNow =
    component.kind === SIDEPANEL_STATE_API.COMPONENT_KINDS.PROGRESS &&
    (!isInitialLoading || sidepanelMvpSkeletonVisible);
  if (showSkeletonNow) appendSidepanelMvpSkeleton(region);
  if (isInitialLoading && !sidepanelMvpSkeletonVisible && !sidepanelMvpSkeletonTimer) {
    sidepanelMvpSkeletonTimer = setTimeout(() => {
      sidepanelMvpSkeletonTimer = null;
      if (
        sidepanelMvpState?.transcript?.status ===
        SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.LOADING
      ) {
        sidepanelMvpSkeletonVisible = true;
        renderSidepanelMvpTranscriptState();
      }
    }, SIDEPANEL_STATE_API.TIMING.CACHE_SKELETON_DELAY_MS);
  }
}

async function sidepanelMvpRefreshConfig() {
  const config = await chrome.runtime.sendMessage({ action: "checkConfig" });
  if (config?.runtimeProtocolVersion === REQUIRED_RUNTIME_PROTOCOL_VERSION) {
    currentConfigStatus = config;
  }
  return currentConfigStatus || {};
}

function sidepanelMvpRunCurrentTask({ captionRetry = false, consentToken = null } = {}) {
  const task = sidepanelMvpState?.transcript?.activeTask;
  const identity = sidepanelMvpCurrentIdentity();
  if (!task || !identity) return Promise.resolve();
  const key = SIDEPANEL_EFFECTS_API.taskFlightKey("transcript", identity);
  return sidepanelMvpTranscriptFlight.run(key, () =>
    runDigestLoad(
      currentVideoId,
      digestGeneration,
      false,
      currentMediaRef,
      currentRouteKey,
      Boolean(consentToken),
      captionRetry,
      { mvpTask: task, consentToken },
    ),
  );
}

async function sidepanelMvpHandleAction(
  eventType,
  actionIdentity = sidepanelMvpCurrentIdentity(),
) {
  const events = SIDEPANEL_STATE_API.EVENTS;
  if (eventType === events.USER_RETRY_FREE) {
    const task = sidepanelMvpBeginEvent(
      events.USER_RETRY_FREE,
      SIDEPANEL_STATE_API.TASK_ORIGINS.USER_RETRY_FREE,
    );
    if (!task) return;
    return sidepanelMvpRunCurrentTask({ captionRetry: true });
  }
  if (eventType === events.USER_CONSENT) {
    const requestedIdentity = actionIdentity;
    if (
      !requestedIdentity ||
      !SIDEPANEL_STATE_API.sameIdentity(
        requestedIdentity,
        sidepanelMvpCurrentIdentity(),
      ) ||
      sidepanelMvpState?.transcript?.status !==
        SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE
    ) {
      return;
    }
    const requestedTranscript = sidepanelMvpState.transcript;
    let config;
    try {
      config = await sidepanelMvpRefreshConfig();
    } catch (error) {
      if (
        !SIDEPANEL_STATE_API.sameIdentity(
          requestedIdentity,
          sidepanelMvpCurrentIdentity(),
        ) ||
        sidepanelMvpState?.transcript !== requestedTranscript
      ) {
        return;
      }
      throw error;
    }
    if (
      !SIDEPANEL_STATE_API.sameIdentity(
        requestedIdentity,
        sidepanelMvpCurrentIdentity(),
      ) ||
      sidepanelMvpState?.transcript !== requestedTranscript ||
      sidepanelMvpState?.transcript?.status !==
        SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE
    ) {
      return;
    }
    if (!config.hasSupadataKey) {
      sidepanelMvpDispatch({
        type: events.USER_CONSENT,
        identity: requestedIdentity,
        hasKey: false,
        now: Date.now(),
      });
      return;
    }
    const consentToken = sidepanelMvpConsentVault.mint(requestedIdentity);
    const task = sidepanelMvpBeginEvent(
      events.USER_CONSENT,
      SIDEPANEL_STATE_API.TASK_ORIGINS.USER_CONSENT,
      {
        identity: requestedIdentity,
        hasKey: true,
        consentToken: consentToken.id,
        now: Date.now(),
      },
    );
    if (!task) {
      sidepanelMvpConsentVault.revoke(consentToken);
      return;
    }
    return sidepanelMvpRunCurrentTask({ consentToken });
  }
  if (eventType === events.OPEN_SUPADATA_SETTINGS) {
    return openSupadataOptions();
  }
  if (eventType === events.USER_RETURN_TO_NOTES) {
    return returnToNotesOnlyContext();
  }
  if (
    eventType === events.USER_RESOLVED ||
    eventType === events.USER_RECONNECT_CURRENT_VIDEO ||
    eventType === events.USER_RECOVER_ERROR
  ) {
    const origin =
      eventType === events.USER_RESOLVED
        ? SIDEPANEL_STATE_API.TASK_ORIGINS.USER_RESOLVED
        : eventType === events.USER_RECONNECT_CURRENT_VIDEO
          ? SIDEPANEL_STATE_API.TASK_ORIGINS.USER_RECONNECT_CURRENT_VIDEO
          : SIDEPANEL_STATE_API.TASK_ORIGINS.USER_RECOVER_ERROR;
    const task = sidepanelMvpBeginEvent(eventType, origin);
    if (task) return sidepanelMvpRunCurrentTask();
    return;
  }
  sidepanelMvpDispatch({ type: eventType });
}

async function sidepanelMvpHandleSettingsChanged() {
  if (!SIDEPANEL_MVP_AVAILABLE) return;
  const config = await sidepanelMvpRefreshConfig();
  if (
    config.hasSupadataKey &&
    sidepanelMvpState?.transcript?.status ===
      SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG
  ) {
    sidepanelMvpDispatch({ type: SIDEPANEL_STATE_API.EVENTS.KEY_SAVED });
    return;
  }
  renderSidepanelMvpTranscriptState();
}

function transcriptSourceLabel() {
  if (currentTranscriptSource === "supadata") return "Supadata 原生字幕";
  if (currentTranscriptSource === "bilibili") return "B 站视频字幕";
  return "来自视频字幕";
}

/**
 * Text for the original-mode transcript source badge. Bilibili has no language
 * control, so the language subtag folds into the source label itself
 * (`B 站视频字幕（zh-cn）`) rather than the redundant `原文（zh-cn）` mode word.
 * YouTube keeps its existing `<source> · 原文（<lang>）` form.
 */
function transcriptOriginalBadgeText() {
  if (currentPlatformIsBilibili()) {
    const language = String(currentTranscriptLanguage || "").trim();
    return /^[A-Za-z0-9-]{1,20}$/.test(language)
      ? `${transcriptSourceLabel()}（${language}）`
      : transcriptSourceLabel();
  }
  return `${transcriptSourceLabel()} · ${getOriginalTranscriptLabel()}`;
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
const FOLLOW_IDLE_RESUME_DELAY_MS = 5000;
const FOLLOW_PLAYBACK_READ_TIMEOUT_MS = 900;
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)
let playbackTrackingEpoch = 0;
let playbackTrackingRequestToken = 0;
let playbackTrackingRequestInFlight = false;
let followIdleController = null;
let followManualHoldTab = null;
let followIntentRevision = 0;

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

function needsVisualChineseQuotes(text) {
  const value = String(text || "").trim();
  if (!/[\u3400-\u9fff]/.test(value)) return false;
  if (/[，。！？；：、,.!?;:]/.test(value)) return false;
  return !/^[“「『\"]+[\s\S]*[”」』\"]+$/.test(value);
}

function chineseVisualQuoteClass(text) {
  return needsVisualChineseQuotes(text) ? " chinese-visual-quote" : "";
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

function splitCaptionPiece(text, start, duration, profile, seekStart = start) {
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
      seekStart,
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
        start,
      ).forEach((piece, partIndex) => {
        pieces.push({
          ...piece,
          sourceEntryIndex: entryIndex,
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
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
    const texts = current.visualFragments
      .map((fragment) => normalizeCaptionText(fragment.text))
      .filter(Boolean);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      seekStart: current.seekStart,
      text,
      texts: texts.length ? texts : [text],
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

    if (!current) {
      current = {
        start: piece.start,
        seekStart: piece.seekStart,
        end: piece.end,
        text: "",
        visualFragments: [],
      };
    }
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const previousFragment = current.visualFragments.at(-1);
    if (previousFragment?.sourceEntryIndex === piece.sourceEntryIndex) {
      previousFragment.text = normalizeCaptionText(
        `${previousFragment.text} ${piece.text}`,
      );
    } else {
      current.visualFragments.push({
        sourceEntryIndex: piece.sourceEntryIndex,
        text: piece.text,
      });
    }
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
  if (!SIDEPANEL_MVP_AVAILABLE) {
    showRuntimeVersionError();
    return;
  }
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
    // A page-level Digest click is an explicit request to leave a local-only
    // saved-note jump and start the current video's cache/Passive transcript
    // task. A miss first asks the user to enable CC; only the explicit retry
    // may later expose the Supadata choice.
    void clearNoteNavigationState()
      .then(() => checkCurrentTab())
      .catch((error) => {
        console.error("[DigestDock Panel] Digest button retry error:", error);
      });
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    if (
      SIDEPANEL_MVP_AVAILABLE &&
      sidepanelMvpState?.transcript?.status !==
        SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.READY
    ) {
      sidepanelMvpProgressOverride = {
        title: String(message.title || ""),
        subtitle: String(message.subtitle || ""),
      };
      renderSidepanelMvpTranscriptState();
    } else {
      updateLoading(message.title, message.subtitle);
    }
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved" || message.action === "notesChanged") {
    // Refresh after a save, import, clear, or reset. Only a freshly saved note
    // may retry its missing Chinese version automatically. The Notes empty-
    // state action is explicitly original-only, even when an AI key exists.
    loadNotes(notesFilterShowAll ? null : currentVideoId, {
      translateMissing:
        message.action === "noteSaved" &&
        message.preserveOriginalOnly !== true,
    });
    // Capture this video's export material once it has a note.
    if (message.action === "noteSaved") {
      const savedMediaKey = String(
        message.note?.mediaKey || message.note?.videoId || "",
      );
      const currentMediaKey = String(
        currentVideoId || currentMediaRef?.mediaKey || "",
      );
      if (savedMediaKey && savedMediaKey === currentMediaKey) {
        void persistCurrentVideoNoteSourceIfNoted();
      }
    }
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

function isDigestDockOptionsUrl(url) {
  try {
    const target = new URL(String(url || ""));
    const options = new URL(chrome.runtime.getURL("options.html"));
    return target.origin === options.origin && target.pathname === options.pathname;
  } catch (_error) {
    return false;
  }
}

function noteNavigationStorage() {
  return chrome.storage?.session || null;
}

function queueNoteNavigationStorage(task) {
  const queued = noteNavigationStorageQueue.then(task, task);
  noteNavigationStorageQueue = queued.catch(() => undefined);
  return queued;
}

function normalizeNoteExportContinuation(value) {
  if (!value || typeof value !== "object") return null;
  const mediaKeys = [
    ...new Set(
      (Array.isArray(value.mediaKeys) ? value.mediaKeys : [])
        .map((key) => String(key || "").trim().slice(0, 220))
        .filter(Boolean),
    ),
  ].sort();
  if (!mediaKeys.length || mediaKeys.length > 200) return null;
  const mode = ["original", "zh", "bilingual"].includes(value.mode)
    ? value.mode
    : "bilingual";
  return {
    mediaKeys,
    mode,
  };
}

function normalizeNoteNavigationState(value) {
  if (!value || typeof value !== "object") return null;
  const phase = value.phase === "active" ? "active" : "pending";
  const token = String(value.token || "").trim().slice(0, 120);
  const routeKey = String(value.routeKey || "").trim().slice(0, 220);
  const mediaKey = String(value.mediaKey || "").trim().slice(0, 220);
  const platform = value.platform === "bilibili" ? "bilibili" : "youtube";
  const tabId = Number(value.tabId);
  const createdAt = Number(value.createdAt);
  const expiresAt = Number(value.expiresAt);
  if (
    value.schemaVersion !== NOTE_NAVIGATION_SCHEMA_VERSION ||
    !token ||
    !routeKey ||
    !mediaKey ||
    !Number.isInteger(tabId) ||
    tabId < 0 ||
    !Number.isFinite(createdAt) ||
    createdAt <= 0
  ) {
    return null;
  }
  if (
    phase === "pending" &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
  ) {
    return null;
  }
  return {
    schemaVersion: NOTE_NAVIGATION_SCHEMA_VERSION,
    phase,
    token,
    tabId,
    routeKey,
    mediaKey,
    platform,
    canonicalUrl: String(value.canonicalUrl || "").trim().slice(0, 2_000),
    timestampedUrl: String(value.timestampedUrl || "").trim().slice(0, 2_000),
    videoTitle: String(value.videoTitle || "").trim().slice(0, 500),
    channelName: String(value.channelName || "").trim().slice(0, 300),
    sourceLanguage: normalizeLanguageCode(value.sourceLanguage),
    duration: Math.max(0, Number(value.duration) || 0),
    showAll: value.showAll === true,
    captureMetadata: value.captureMetadata === true,
    exportContinuation: normalizeNoteExportContinuation(
      value.exportContinuation,
    ),
    createdAt,
    expiresAt: phase === "pending" ? expiresAt : 0,
    activatedAt:
      phase === "active" ? Math.max(0, Number(value.activatedAt) || 0) : 0,
  };
}

async function persistNoteNavigationState(state) {
  const normalized = normalizeNoteNavigationState(state);
  if (!normalized) return false;
  if (normalized.phase === "active") {
    activeNotesOnlyContext = normalized;
    pendingNoteNavigation = null;
  } else {
    pendingNoteNavigation = normalized;
    activeNotesOnlyContext = null;
  }
  const storage = noteNavigationStorage();
  if (!storage?.set) return true;
  await queueNoteNavigationStorage(async () => {
    try {
      await storage.set({ [NOTE_NAVIGATION_SESSION_KEY]: normalized });
    } catch (error) {
      // The in-memory state still protects the current global panel instance.
      console.warn("[DigestDock] Could not persist note navigation:", error);
    }
  });
  return true;
}

async function hydrateNoteNavigationState() {
  if (activeNotesOnlyContext || pendingNoteNavigation) return;
  const storage = noteNavigationStorage();
  if (!storage?.get) return;
  await queueNoteNavigationStorage(async () => {
    if (activeNotesOnlyContext || pendingNoteNavigation) return;
    try {
      const stored = await storage.get(NOTE_NAVIGATION_SESSION_KEY);
      if (activeNotesOnlyContext || pendingNoteNavigation) return;
      const normalized = normalizeNoteNavigationState(
        stored?.[NOTE_NAVIGATION_SESSION_KEY],
      );
      if (!normalized) {
        if (stored?.[NOTE_NAVIGATION_SESSION_KEY] && storage.remove) {
          await storage.remove(NOTE_NAVIGATION_SESSION_KEY);
        }
        return;
      }
      if (normalized.phase === "active") {
        activeNotesOnlyContext = normalized;
      } else {
        pendingNoteNavigation = normalized;
      }
    } catch (error) {
      console.warn("[DigestDock] Could not restore note navigation:", error);
    }
  });
}

async function clearNoteNavigationState(expectedToken = "") {
  const token = String(expectedToken || "");
  if (
    token &&
    activeNotesOnlyContext?.token !== token &&
    pendingNoteNavigation?.token !== token
  ) {
    return false;
  }
  activeNotesOnlyContext = null;
  pendingNoteNavigation = null;
  const storage = noteNavigationStorage();
  if (!storage?.remove) return true;
  return queueNoteNavigationStorage(async () => {
    try {
      if (token && storage.get) {
        const stored = await storage.get(NOTE_NAVIGATION_SESSION_KEY);
        const storedToken = String(
          stored?.[NOTE_NAVIGATION_SESSION_KEY]?.token || "",
        );
        if (storedToken && storedToken !== token) return false;
      }
      await storage.remove(NOTE_NAVIGATION_SESSION_KEY);
    } catch (error) {
      console.warn("[DigestDock] Could not clear note navigation:", error);
    }
    return true;
  });
}

function noteNavigationMatches(state, tab, locator) {
  if (!state || !tab || !locator) return false;
  if (state.tabId !== tab.id || state.routeKey !== locator.routeKey) return false;
  if (state.platform !== locator.platform) return false;
  if (locator.platform === "youtube" && state.mediaKey !== locator.mediaKey) {
    return false;
  }
  return true;
}

async function resolveNoteNavigationForTab(tab, locator) {
  await hydrateNoteNavigationState();

  if (activeNotesOnlyContext) {
    if (noteNavigationMatches(activeNotesOnlyContext, tab, locator)) {
      return activeNotesOnlyContext;
    }
    // Once activated, leaving the exact tab or media route ends notes-only
    // mode. Returning later is an ordinary video visit and may request a
    // transcript only through the existing consent flow.
    await clearNoteNavigationState(activeNotesOnlyContext.token);
    return null;
  }

  const pending = normalizeNoteNavigationState(pendingNoteNavigation);
  if (!pending) {
    if (pendingNoteNavigation) {
      await clearNoteNavigationState(pendingNoteNavigation.token);
    }
    return null;
  }
  pendingNoteNavigation = pending;
  if (!noteNavigationMatches(pending, tab, locator)) return null;

  const active = {
    ...pending,
    phase: "active",
    expiresAt: 0,
    activatedAt: Date.now(),
  };
  await persistNoteNavigationState(active);
  return activeNotesOnlyContext;
}

function buildNoteNavigationIntent(
  note,
  tabId,
  { captureMetadata = false, exportContinuation = null } = {},
) {
  const timestampedUrl = String(
    note?.timestampedUrl || note?.canonicalUrl || "",
  ).trim();
  const locator = extractMediaLocator(timestampedUrl);
  const mediaKey = String(note?.mediaKey || note?.videoId || "").trim();
  if (!locator || !mediaKey || !Number.isInteger(tabId)) return null;
  if (locator.platform === "youtube" && mediaKey !== locator.mediaKey) {
    return null;
  }
  const now = Date.now();
  return {
    schemaVersion: NOTE_NAVIGATION_SCHEMA_VERSION,
    phase: "pending",
    token: `${now.toString(36)}:${Math.random().toString(36).slice(2)}`,
    tabId,
    routeKey: locator.routeKey,
    mediaKey,
    platform: locator.platform,
    canonicalUrl: String(note?.canonicalUrl || locator.canonicalUrl || ""),
    timestampedUrl,
    videoTitle: noteOriginalVideoTitle(note),
    channelName: String(note?.channelName || ""),
    sourceLanguage: String(note?.sourceLanguage || ""),
    duration: Number(note?.duration) || 0,
    showAll: notesFilterShowAll,
    captureMetadata: captureMetadata === true,
    exportContinuation: normalizeNoteExportContinuation(exportContinuation),
    createdAt: now,
    expiresAt: now + NOTE_NAVIGATION_PENDING_TTL_MS,
    activatedAt: 0,
  };
}

function isActiveNotesOnlyContext() {
  return (
    !!activeNotesOnlyContext &&
    activeNotesOnlyContext.tabId === videoTabId &&
    activeNotesOnlyContext.routeKey === currentRouteKey &&
    activeNotesOnlyContext.mediaKey === currentVideoId
  );
}

function isBilibiliChineseMedia() {
  return (
    currentMediaRef?.platform === "bilibili" &&
    isConfirmedSimplifiedChineseSource(currentTranscriptLanguage)
  );
}

/**
 * Whether the media currently in front of the panel is a Bilibili video.
 * Platform is the ONLY input for hiding Bilibili's subtitle/overview language
 * controls, so a plain `zh` tag and a `zh-CN` tag lay out identically instead
 * of the layout shifting with the language subtag.
 */
function currentPlatformIsBilibili() {
  return currentMediaRef?.platform === "bilibili";
}

function applyMediaLanguageDefaults() {
  currentTranscriptMode = "original";
  // The current product contract is Chinese-first on every platform.
  currentOverviewMode = "zh";
  // Free mode starts with the original note text and performs no background AI
  // work. A Chinese source is already readable, while configured users keep the
  // established bilingual default for non-Chinese videos.
  currentNotesMode = currentVideoIsChinese()
    ? "zh"
    : hasConfiguredAiService()
      ? "bilingual"
      : "original";
  setTranscriptModeButtons(currentTranscriptMode);
  setOverviewModeButtons(currentOverviewMode);
  setNotesModeButtons(currentNotesMode);

  // Whole containers are shown/hidden by platform in
  // updateHeaderLanguageControlsVisibility(); never leave per-button `hidden`
  // state behind that would survive a switch back to YouTube.
  document
    .querySelectorAll(
      ".transcript-mode-btn, .overview-mode-btn, .notes-mode-btn",
    )
    .forEach((button) => {
      button.hidden = false;
    });
}

function updateHeaderLanguageControlsVisibility() {
  const transcriptControl = document.getElementById("transcriptModeControl");
  const overviewControl = document.getElementById("overviewModeControl");
  const notesControl = document.getElementById("notesModeControl");
  const activeTab = document.querySelector(".tab.active")?.dataset.tab;
  const showingResults = panelIsShowingResults();
  const isBilibili = currentPlatformIsBilibili();
  // Bilibili subtitles and overview are Chinese-only, so their language pills
  // would be meaningless — hide the whole container by platform. Notes keep
  // their control on every platform.
  if (transcriptControl) {
    transcriptControl.hidden = !(
      showingResults &&
      activeTab === "transcript" &&
      !isBilibili
    );
  }
  if (overviewControl) {
    overviewControl.hidden = !(
      showingResults &&
      activeTab === "overview" &&
      !isBilibili
    );
  }
  if (notesControl) {
    notesControl.hidden = !(showingResults && activeTab === "notes");
  }
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url, tabId = null) {
  if (isDigestDockOptionsUrl(url)) return;
  const locator = extractMediaLocator(url);
  if (!locator) {
    const activeToken = activeNotesOnlyContext?.token || "";
    if (activeToken) {
      void clearNoteNavigationState(activeToken).finally(() => window.close());
    } else {
      window.close();
    }
    return;
  }

  const newRouteKey = locator.routeKey;
  const exactTabChanged =
    Number.isInteger(tabId) &&
    Number.isInteger(videoTabId) &&
    tabId !== videoTabId;
  if (
    activeNotesOnlyContext &&
    (activeNotesOnlyContext.routeKey !== newRouteKey ||
      (Number.isInteger(tabId) && activeNotesOnlyContext.tabId !== tabId))
  ) {
    void clearNoteNavigationState(activeNotesOnlyContext.token);
  }
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video), or
  // when another tab shows the same route. The latter must rebind videoTabId so
  // note seek/play messages never target a background copy of the video.
  if (
    newRouteKey !== currentRouteKey ||
    exactTabChanged ||
    !panelIsShowingResults()
  ) {
    scheduleDigestRefresh();
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  if (changeInfo.url) {
    handleFrontTabUrl(changeInfo.url, tabId);
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
    handleFrontTabUrl(tab.pendingUrl || tab.url || "", tabId);
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

chrome.tabs.onRemoved?.addListener((tabId) => {
  const state = activeNotesOnlyContext || pendingNoteNavigation;
  if (state?.tabId === tabId) {
    void clearNoteNavigationState(state.token);
  }
});

function setupEventListeners() {
  document
    .getElementById("transcriptStateRegion")
    ?.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-mvp-event]");
      if (!button || button.disabled) return;
      button.disabled = true;
      const eventType = String(button.dataset.mvpEvent || "");
      const actionIdentity = sidepanelMvpCurrentIdentity();
      Promise.resolve(
        sidepanelMvpHandleAction(eventType, actionIdentity),
      ).catch((error) => {
        console.error("[DigestDock Panel] MVP action failed:", error);
        if (
          !actionIdentity ||
          !SIDEPANEL_STATE_API.sameIdentity(
            actionIdentity,
            sidepanelMvpCurrentIdentity(),
          )
        ) {
          return;
        }
        const task = sidepanelMvpState?.transcript?.activeTask;
        if (
          task &&
          SIDEPANEL_STATE_API.sameIdentity(task.identity, actionIdentity)
        ) {
          sidepanelMvpResolveTranscript(
            {
              success: false,
              routeOutcome: "UNKNOWN",
              error: "TRANSCRIPT_ERROR",
              message: error?.message || "字幕操作未能完成，请稍后重试。",
            },
            task,
          );
        } else {
          renderSidepanelMvpTranscriptState();
        }
      });
    });

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (
      areaName === "local" &&
      Object.hasOwn(changes || {}, YTD_SETTINGS.STORAGE_KEY)
    ) {
      void sidepanelMvpHandleSettingsChanged();
    }
  });

  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      followIntentRevision += 1;
      const nextTab = tab.dataset.tab;
      const previousTab = currentWorkspaceTab();
      if (previousTab !== nextTab) followManualHoldTab = null;
      cancelFollowIdleResume({ clearHold: true });
      switchTab(nextTab);
    });
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
          "无法读取当前视频",
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
  document
    .getElementById("saveCurrentMomentBtn")
    ?.addEventListener("click", () => void saveCurrentMomentFromPanel());
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

  const contentArea = document.getElementById("contentArea");
  for (const eventName of ["pointerdown", "touchstart", "wheel", "keydown", "focusin"]) {
    contentArea?.addEventListener(eventName, onFollowWorkspaceInteraction);
  }
  contentArea?.addEventListener("scroll", onFollowWorkspaceInteraction, {
    passive: true,
  });
  document.addEventListener("selectionchange", onFollowWorkspaceInteraction);

  // Follow controls belong only to manual reading inside the Transcript tab.
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => void resumeFollowPlaybackNow());
  document.getElementById("followStayBtn")?.addEventListener("click", () => {
    if (currentWorkspaceTab() !== "transcript") return;
    followManualHoldTab = currentWorkspaceTab();
    cancelFollowIdleResume({ keepPrompt: true });
    showFollowPlaybackPrompt({ held: true });
    announceFollowPlayback("已暂停自动跟随。切回字幕或点击立即跟随即可恢复。");
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

  // Note export menu
  document
    .getElementById("notesExportBtn")
    ?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleNoteExportMenu();
    });
  document
    .getElementById("exportCurrentNotes")
    ?.addEventListener("click", exportCurrentVideoNotes);
  document
    .getElementById("selectNotesForExport")
    ?.addEventListener("click", () => void openNoteExportPicker());
  document
    .getElementById("exportAllNotes")
    ?.addEventListener("click", () => void openNoteExportPicker({ selectAll: true }));
  document
    .getElementById("notesExportSelectAll")
    ?.addEventListener("change", handleNoteExportSelectAll);
  document
    .getElementById("cancelNotesExportSelection")
    ?.addEventListener("click", () => closeNoteExportPicker({ restoreFocus: true }));
  document
    .getElementById("directNotesExportSelection")
    ?.addEventListener("click", () => {
      const frozenKeys = [...selectedNoteExportMediaKeys].sort();
      if (!frozenKeys.length) return;
      void exportAllNotes(frozenKeys, { direct: true });
    });
  document
    .getElementById("notesExportPicker")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const frozenKeys = [...selectedNoteExportMediaKeys].sort();
      if (!frozenKeys.length) return;
      void exportAllNotes(frozenKeys, {
        grantAuthorization: true,
        autoOpenMetadata: true,
      });
    });
  document.addEventListener("click", (event) => {
    const wrap = document.getElementById("notesExport");
    if (wrap && !wrap.contains(event.target)) hideNoteExportMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const picker = document.getElementById("notesExportPicker");
    if (picker && !picker.hidden) {
      event.preventDefault();
      closeNoteExportPicker({ restoreFocus: true });
      return;
    }
    const menu = document.getElementById("notesExportMenu");
    if (menu && !menu.hidden) {
      event.preventDefault();
      hideNoteExportMenu();
      document.getElementById("notesExportBtn")?.focus();
    }
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
  updateNoteExportMenuContext();
  if (!showAll) closeNoteExportPicker();
}

// ============================================================
// VIDEO DETECTION
// ============================================================

function checkCurrentTab(options = {}) {
  const generation = ++tabCheckGeneration;
  return runCheckCurrentTab(generation, options);
}

function isTransientTabLookupError(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("No tab with id") ||
    message.includes("Tab was closed") ||
    message.includes("Invalid tab ID")
  );
}

function requireContentRelayResponse(
  result,
  fallbackMessage = "YouTube 页面资料尚未就绪。",
) {
  if (result?.success && result.response) return result.response;
  const error = new Error(result?.message || fallbackMessage);
  if (
    result?.error === "PAGE_REFRESH_REQUIRED" ||
    result?.error === "PAGE_CONTEXT_CHANGED"
  ) {
    error.code = result.error;
  }
  throw error;
}

async function runCheckCurrentTab(generation, options = {}) {
  const isLatestCheck = () => generation === tabCheckGeneration;
  try {
    let tab = null;
    let tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!isLatestCheck()) return;
    const frontTabUrl = tabs[0]?.pendingUrl || tabs[0]?.url || "";
    if (extractMediaLocator(frontTabUrl)) {
      tab = { ...tabs[0], url: frontTabUrl };
    }

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

    const locator = extractMediaLocator(tab.pendingUrl || tab.url);
    if (!locator) {
      showState("welcome");
      return;
    }

    // Capture the exact supported tab before any navigation-intent lookup or
    // content relay. Viewing an already-saved note is a local action and must
    // remain available even when no AI key is configured.
    videoTabId = tab.id;
    const noteNavigation = await resolveNoteNavigationForTab(tab, locator);
    if (!isLatestCheck()) return;
    const resumeNoteNavigationToken = String(
      options?.resumeNoteNavigationToken || "",
    );
    const isExplicitNoteDigestResume =
      !!noteNavigation &&
      !!resumeNoteNavigationToken &&
      noteNavigation.token === resumeNoteNavigationToken;
    if (noteNavigation && !isExplicitNoteDigestResume) {
      await enterNotesOnlyView(noteNavigation, tab, locator);
      return;
    }

    let nextMediaRef = locator;
    let nextVideoUrl = tab.url;
    let nextVideoTitle = "";
    let nextChannelName = "";
    let nextVideoDescription = "";
    let nextVideoDescriptionState = "unknown";
    let nextVideoDescriptionTruncated = false;
    let nextVideoDuration = 0;
    let nextSourceLanguage = "";
    let nextCaptionSelection = null;

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
      nextVideoDescriptionState = ["unknown", "confirmed-empty", "present"].includes(
        nextMediaRef.descriptionStatus,
      )
        ? nextMediaRef.descriptionStatus
        : nextVideoDescription
          ? "present"
          : "unknown";
      nextVideoDescriptionTruncated = nextMediaRef.descriptionTruncated === true;
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
        videoInfo = requireContentRelayResponse(
          result,
          "YouTube 页面资料尚未就绪。",
        );
      } catch (e) {
        if (!isLatestCheck()) return;
        if (
          e?.code === "PAGE_REFRESH_REQUIRED" ||
          e?.code === "PAGE_CONTEXT_CHANGED"
        ) {
          throw e;
        }
        console.error("[DigestDock Panel] getVideoInfo error:", e);
      }
      nextVideoTitle = videoInfo?.title || "";
      nextChannelName = videoInfo?.channelName || "";
      nextVideoDescription = videoInfo?.description || "";
      nextVideoDescriptionState = ["unknown", "confirmed-empty", "present"].includes(
        videoInfo?.descriptionStatus,
      )
        ? videoInfo.descriptionStatus
        : nextVideoDescription
          ? "present"
          : "unknown";
      nextVideoDescriptionTruncated = videoInfo?.descriptionTruncated === true;
      nextVideoDuration = videoInfo?.duration || 0;
      nextSourceLanguage = normalizeLanguageCode(videoInfo?.sourceLanguage);
      nextCaptionSelection = sanitizeTranscriptSelectedTrack(
        videoInfo?.captionSelection,
      );
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
    currentVideoDescriptionState = nextVideoDescriptionState;
    currentVideoDescriptionTruncated = nextVideoDescriptionTruncated;
    currentVideoDescriptionZh = "";
    currentVideoDuration = nextVideoDuration;
    currentVideoSourceLanguage = nextSourceLanguage;
    currentVideoCaptionSelection = nextCaptionSelection;

    await startDigest(
      nextMediaRef.mediaKey,
      nextVideoUrl,
      nextMediaRef,
      locator.routeKey,
      nextCaptionSelection,
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
    if (error?.code === "PAGE_CONTEXT_CHANGED") {
      debugLog("[DigestDock Panel] Video page is still changing");
      scheduleDigestRefresh();
      return;
    }
    console.error("Tab check error:", error);
    showError(
      "无法读取当前视频",
      error?.message || "读取当前视频失败，请刷新页面后重试。",
    );
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

function resetDigestStateForVideo(videoId, videoUrl, mediaRef, routeKey) {
  const previousExportJobId = activeExportJobId;
  stopPlaybackTracking();
  cancelFollowIdleResume({ clearHold: true });
  digestGeneration += 1;
  translationGeneration += 1;
  exportTranslationGeneration += 1;
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
  currentMediaRef = mediaRef;
  currentRouteKey = routeKey;
  sidepanelMvpBindSession(videoId, routeKey, { forceNewTask: true });
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  currentTranscriptSource = "";
  currentTranscriptSelectedTrack = null;
  currentTranscriptSourceAttempt = "";
  currentVideoCaptionSelection = null;
  currentPersistedNoteSource = null;
  activeExportJobId = "";
  if (previousExportJobId) {
    chrome.runtime
      .sendMessage({
        action: "cancelExportTranslationJob",
        jobId: previousExportJobId,
      })
      .catch(() => {});
  }
  currentOverviewMode = "zh";
  setOverviewModeButtons(currentOverviewMode);
  clearOverviewResults();
}

async function captureNotesOnlyMetadata(
  context,
  tab,
  locator,
  { requireActiveContext = true } = {},
) {
  if (!context?.captureMetadata || !noteNavigationMatches(context, tab, locator)) {
    return null;
  }
  return runMetadataCaptureSingleFlight(context.token, async () => {
    const ownsCapture = () =>
      requireActiveContext
        ? activeNotesOnlyContext?.token === context.token &&
          isActiveNotesOnlyContext()
        : currentVideoId === context.mediaKey &&
          videoTabId === context.tabId &&
          currentRouteKey === context.routeKey;
    if (!ownsCapture()) return null;

    try {
      let metadata = null;
      let resolvedMediaRef = currentMediaRef;
      if (locator.platform === "bilibili") {
        const resolved = await chrome.runtime.sendMessage({
          action: "resolveBilibiliMedia",
          url: tab.pendingUrl || tab.url || context.timestampedUrl,
        });
        if (
          !resolved?.success ||
          !resolved.mediaRef ||
          resolved.mediaRef.mediaKey !== context.mediaKey
        ) {
          throw new Error("B 站页面资料尚未就绪。");
        }
        resolvedMediaRef = resolved.mediaRef;
        metadata = resolved.mediaRef;
      } else {
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          tabId: context.tabId,
          payload: { action: "getVideoInfo" },
        });
        const response = requireContentRelayResponse(
          result,
          "YouTube 页面资料尚未就绪。",
        );
        const responseVideoId = String(response.videoId || "").trim();
        if (responseVideoId && responseVideoId !== locator.videoId) {
          const pageChangedError = new Error(
            "YouTube 页面已切换，未写入旧视频资料。",
          );
          pageChangedError.code = "PAGE_CONTEXT_CHANGED";
          throw pageChangedError;
        }
        if (!responseVideoId) {
          const normalizeTitle = (value) =>
            String(value || "")
              .normalize("NFKC")
              .replace(/\s+/g, " ")
              .trim()
              .toLocaleLowerCase();
          const expectedTitle = normalizeTitle(context.videoTitle);
          const responseTitle = normalizeTitle(response.title);
          if (!expectedTitle || !responseTitle || expectedTitle !== responseTitle) {
            const staleError = new Error(
              "页面仍在使用旧版 DigestDock 内容脚本，请刷新当前视频页后再补充。",
            );
            staleError.code = "PAGE_REFRESH_REQUIRED";
            throw staleError;
          }
          const refreshError = new Error(
            "当前视频页尚未加载新版 DigestDock 内容脚本，请刷新页面后再补充。",
          );
          refreshError.code = "PAGE_REFRESH_REQUIRED";
          throw refreshError;
        }
        metadata = response;
      }

      const latestTab = await chrome.tabs.get(context.tabId);
      const latestLocator = extractMediaLocator(
        latestTab?.pendingUrl || latestTab?.url || "",
      );
      if (!ownsCapture() || !noteNavigationMatches(context, latestTab, latestLocator)) {
        return null;
      }

      currentMediaRef = {
        ...(resolvedMediaRef || locator),
        platform: context.platform,
        mediaKey: context.mediaKey,
        canonicalUrl:
          resolvedMediaRef?.canonicalUrl ||
          context.canonicalUrl ||
          locator.canonicalUrl,
      };
      currentVideoTitle = String(metadata.title || context.videoTitle || "");
      currentChannelName = String(
        metadata.channelName || context.channelName || "",
      );
      currentVideoDescription = String(metadata.description || "");
      currentVideoDescriptionState = ["unknown", "confirmed-empty", "present"].includes(
        metadata.descriptionStatus,
      )
        ? metadata.descriptionStatus
        : currentVideoDescription
          ? "present"
          : "unknown";
      currentVideoDescriptionTruncated = metadata.descriptionTruncated === true;
      currentVideoDuration = Math.max(0, Number(metadata.duration) || 0);
      currentVideoSourceLanguage = normalizeLanguageCode(
        metadata.sourceLanguage || context.sourceLanguage,
      );

      const stored = await YTD_NOTE_SOURCES.readNoteSource(
        chrome.storage.local,
        context.mediaKey,
      );
      if (!ownsCapture()) return null;
      const persisted = await upsertNoteSourceInBackground({
        mediaKey: context.mediaKey,
        platform: context.platform,
        canonicalUrl: currentMediaRef.canonicalUrl || "",
        titleOriginal: currentVideoTitle,
        titleZh: stored?.titleZh || currentVideoTitleZh(),
        channelName: currentChannelName,
        descriptionOriginal: currentVideoDescription,
        descriptionStatus: currentVideoDescriptionState,
        descriptionTruncated: currentVideoDescriptionTruncated,
        descriptionZh: stored?.descriptionZh || "",
        sourceLanguage:
          stored?.sourceLanguage || currentVideoSourceLanguage || "",
        transcriptOriginal: stored?.transcriptOriginal || [],
        transcriptZh: stored?.transcriptZh || [],
        transcriptTruncated: stored?.transcriptTruncated === true,
      });
      if (!ownsCapture()) return persisted;

      applyPersistedSourceToCurrentVideo(persisted);
      const videoTitle = document.getElementById("videoTitle");
      if (videoTitle) videoTitle.textContent = currentVideoTitle;
      updateVideoMetaLine();
      const metadataComplete =
        !!currentVideoTitle &&
        !!currentChannelName &&
        !!currentMediaRef.canonicalUrl &&
        currentVideoDescriptionState !== "unknown" &&
        !currentVideoDescriptionTruncated;
      if (requireActiveContext) {
        await persistNoteNavigationState({
          ...context,
          phase: "active",
          captureMetadata: !metadataComplete,
          videoTitle: currentVideoTitle,
          channelName: currentChannelName,
          duration: currentVideoDuration,
          sourceLanguage: currentVideoSourceLanguage,
          canonicalUrl: currentMediaRef.canonicalUrl || context.canonicalUrl,
        });
      }
      setNoteExportStatus(
        metadataComplete
          ? context.exportContinuation
            ? `已补充《${currentVideoTitle || "当前视频"}》的页面资料，正在继续完整导出…`
            : `已补充《${currentVideoTitle || "当前视频"}》的页面资料。`
          : "已保存当前可读取的资料，但页面仍未加载完整。请刷新视频页后再次补充。",
        !metadataComplete,
      );
      return persisted;
    } catch (error) {
      if (
        error?.code === "PAGE_REFRESH_REQUIRED" ||
        error?.code === "PAGE_CONTEXT_CHANGED"
      ) {
        debugLog("[DigestDock] Metadata page state not ready:", error.code);
      } else {
        console.warn("[DigestDock] Capture note metadata error:", error);
      }
      if (ownsCapture()) {
        setNoteExportStatus(
          error?.code === "PAGE_REFRESH_REQUIRED" ||
            error?.code === "PAGE_CONTEXT_CHANGED"
            ? error.message
            : "页面资料暂未读取完整。请等待页面加载后刷新，或稍后再次补充。",
          error?.code !== "PAGE_CONTEXT_CHANGED",
        );
      }
      return null;
    }
  });
}

async function enterNotesOnlyView(context, tab, locator) {
  if (!noteNavigationMatches(context, tab, locator)) return false;
  const mediaRef = {
    ...locator,
    platform: context.platform,
    mediaKey: context.mediaKey,
    canonicalUrl: context.canonicalUrl || locator.canonicalUrl,
  };
  const videoChanged =
    context.mediaKey !== currentVideoId ||
    context.routeKey !== currentRouteKey;

  currentVideoTitle = context.videoTitle || "";
  currentChannelName = context.channelName || "";
  currentVideoDescription = "";
  currentVideoDescriptionZh = "";
  currentVideoDescriptionState = "unknown";
  currentVideoDescriptionTruncated = false;
  currentVideoDuration = context.duration || 0;
  currentVideoSourceLanguage = context.sourceLanguage || "";

  if (videoChanged) {
    resetDigestStateForVideo(
      context.mediaKey,
      tab.pendingUrl || tab.url || context.timestampedUrl,
      mediaRef,
      context.routeKey,
    );
    applyMediaLanguageDefaults();
  } else {
    currentVideoUrl = tab.pendingUrl || tab.url || context.timestampedUrl;
    currentMediaRef = mediaRef;
    currentRouteKey = context.routeKey;
  }

  const videoInfo = document.getElementById("videoInfo");
  const videoTitle = document.getElementById("videoTitle");
  if (videoTitle) videoTitle.textContent = currentVideoTitle;
  updateVideoMetaLine();
  if (videoInfo) videoInfo.style.display = "block";

  showState("results");
  switchTab("notes");
  await loadNotes(context.showAll ? null : context.mediaKey, {
    translateMissing: false,
  });
  let capturedSource = null;
  if (context.captureMetadata) {
    capturedSource = await captureNotesOnlyMetadata(context, tab, locator);
  }
  if (
    context.exportContinuation &&
    (!context.captureMetadata || capturedSource)
  ) {
    Promise.resolve().then(() => {
      void resumeNoteExportContinuation(context.exportContinuation);
    });
  }
  return true;
}

function digestMediaIdentityChanged(
  nextVideoId,
  nextRouteKey,
  activeVideoId,
  activeRouteKey,
) {
  return nextVideoId !== activeVideoId || nextRouteKey !== activeRouteKey;
}

function startDigest(
  videoId,
  videoUrl,
  mediaRef = currentMediaRef,
  routeKey = currentRouteKey,
  captionSelection = currentVideoCaptionSelection,
) {
  const nextMediaRef = mediaRef || currentMediaRef;
  const nextRouteKey = routeKey || currentRouteKey;
  // Media identity is video + route, never the default audio language. A
  // Chinese subtitle selected for an English-audio video remains the same
  // digest across tab activation, page-complete, and scheduled refresh events.
  // A future track replacement must arrive as a new validated transcript
  // artifact; it must not be guessed from metadata language drift here.
  const videoChanged = digestMediaIdentityChanged(
    videoId,
    nextRouteKey,
    currentVideoId,
    currentRouteKey,
  );
  if (videoChanged) {
    resetDigestStateForVideo(
      videoId,
      videoUrl,
      nextMediaRef,
      nextRouteKey,
    );
  } else {
    currentVideoUrl = videoUrl;
    currentMediaRef = nextMediaRef;
    currentRouteKey = nextRouteKey;
  }
  currentVideoCaptionSelection = sanitizeTranscriptSelectedTrack(
    captionSelection,
  );

  if (SIDEPANEL_MVP_AVAILABLE && !videoChanged) {
    const transcriptStatus = sidepanelMvpState?.transcript?.status;
    if (
      transcriptStatus === SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.READY ||
      ![
        SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.LOADING,
        SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.RETRYING_FREE,
        SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.FETCHING_SUPADATA,
      ].includes(transcriptStatus)
    ) {
      renderSidepanelMvpTranscriptState();
      return Promise.resolve();
    }
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
  captionRetry = false,
  mvpOptions = {},
) {
  if (!isCurrentDigest(videoId, generation, routeKey)) return;
  const mvpTask = SIDEPANEL_MVP_AVAILABLE
    ? mvpOptions.mvpTask || sidepanelMvpState?.transcript?.activeTask
    : null;
  const mvpEnvelope = sidepanelMvpTaskResultEnvelope(mvpTask);
  const ownsDigestLoad = () =>
    isCurrentDigest(videoId, generation, routeKey) &&
    (!SIDEPANEL_MVP_AVAILABLE ||
      (mvpTask && sidepanelMvpTaskGate.isCurrent(mvpEnvelope)));
  if (!ownsDigestLoad()) return;

  // Check if we already have this video loaded in memory
  if (!videoChanged && videoId === currentVideoId && currentAnalysis) {
    if (SIDEPANEL_MVP_AVAILABLE && currentTranscript) {
      sidepanelMvpResolveTranscript(
        { success: true, routeOutcome: "HAVE_TRANSCRIPT", source: "memory" },
        mvpTask,
      );
      renderSidepanelMvpTranscriptState();
    } else {
      showState("results");
    }
    refreshOverviewForCurrentVideoIfVisible();
    return;
  }

  // Check cache for this video
  let cached = await loadFromCache(videoId, {
    mediaRef,
    requestedLanguage: currentVideoSourceLanguage,
    trackKind: YOUTUBE_TRANSCRIPT_TRACK_KIND,
    routeKey,
    selectedTrack: currentVideoCaptionSelection,
  });
  if (!ownsDigestLoad()) return;
  if (
    cached &&
    ((cached.routeKey && cached.routeKey !== routeKey) ||
      (cached.mediaRef?.mediaKey && cached.mediaRef.mediaKey !== videoId))
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
      cached.analysis?.timestampAnchorVersion ===
        ANALYSIS_TIMESTAMP_ANCHOR_VERSION &&
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
    const compactOverview = await loadOverviewFromCache(
      videoId,
      currentTranscriptTimestamped,
      currentTranscriptLanguage,
      currentTranscriptSource,
      currentTranscriptSelectedTrack,
    );
    if (!ownsDigestLoad()) return;
    if (compactOverview) {
      currentAnalysis = compactOverview;
    } else if (currentAnalysis) {
      // One-time no-network migration for overviews created before the compact
      // cache existed. Failure is harmless because the legacy digest remains.
      await saveOverviewToCache(
        videoId,
        currentAnalysis,
        currentTranscriptTimestamped,
        currentTranscriptLanguage,
        currentTranscriptSource,
        currentTranscriptSelectedTrack,
      );
      if (!ownsDigestLoad()) return;
    }
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
    await hydrateCurrentVideoNoteSource();
    if (!ownsDigestLoad()) return;

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      updateVideoMetaLine();
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    if (SIDEPANEL_MVP_AVAILABLE) {
      sidepanelMvpResolveTranscript(
        {
          success: true,
          routeOutcome: "HAVE_TRANSCRIPT",
          source: currentTranscriptSource || "cache",
        },
        mvpTask,
      );
    }
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    if (SIDEPANEL_MVP_AVAILABLE) renderSidepanelMvpTranscriptState();
    else {
      showState("results");
      document.getElementById("tabsNav").style.display = "flex";
    }

    // Respect the user's explicit All Notes filter. A saved-note navigation
    // must not silently collapse the library back to the current video after
    // they later request Transcript or Overview.
    loadNotes(notesFilterShowAll ? null : videoId);

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

  if (SIDEPANEL_MVP_AVAILABLE) renderSidepanelMvpTranscriptState();
  else {
    showState("loading");
    updateLoading("正在获取字幕", "");
  }

  const requestMediaRef = currentMediaRef || mediaRef;
  const transcriptRequest = buildTranscriptFetchRequest({
    videoId,
    mediaRef: requestMediaRef,
    preferredLanguage: currentVideoSourceLanguage,
    tabId: videoTabId,
    generation,
    routeKey,
    supadataConsent,
    captionRetry,
  });
  let transcriptResult;
  try {
    if (SIDEPANEL_MVP_AVAILABLE && mvpOptions.consentToken) {
      const consentToken = mvpOptions.consentToken;
      transcriptResult = await sidepanelMvpSupadataDispatcher.dispatch({
        identity: mvpTask.identity,
        token: consentToken,
        request: transcriptRequest,
        onConsumed: () => {
          sidepanelMvpDispatch({
            type: SIDEPANEL_STATE_API.EVENTS.SUPADATA_REQUEST_DISPATCHED,
            identity: mvpTask.identity,
            taskId: mvpTask.id,
            consentToken: consentToken.id,
          });
        },
      });
    } else {
      transcriptResult = await chrome.runtime.sendMessage(transcriptRequest);
    }
  } catch (error) {
    if (mvpOptions.consentToken) {
      sidepanelMvpConsentVault.revoke(mvpOptions.consentToken);
    }
    transcriptResult = {
      success: false,
      error: error?.code || "TRANSCRIPT_ERROR",
      routeOutcome:
        error?.code === "PAGE_CONTEXT_CHANGED"
          ? "PAGE_CONTEXT_CHANGED"
          : "UNKNOWN",
      message: error?.message || "读取字幕失败，请稍后重试。",
      runId: transcriptRequest.runId,
      routeKey: transcriptRequest.routeKey,
    };
  }
  if (!ownsDigestLoad()) return;
  if (
    SIDEPANEL_MVP_AVAILABLE &&
    !sidepanelMvpTaskGate.isCurrent(mvpEnvelope)
  ) {
    return;
  }
  if (
    !transcriptResponseMatchesRequest(transcriptResult, transcriptRequest, {
      platform: requestMediaRef?.platform,
    })
  ) {
    debugLog("[DigestDock Panel] Rejected stale transcript result", {
      expectedRunId: transcriptRequest.runId,
      receivedRunId: transcriptResult?.runId,
      expectedRouteKey: routeKey,
      receivedRouteKey: transcriptResult?.routeKey,
    });
    return;
  }

  if (SIDEPANEL_MVP_AVAILABLE) {
    sidepanelMvpResolveTranscript(transcriptResult, mvpTask, {
      finishTask: transcriptResult?.success !== true,
    });
    if (
      sidepanelMvpState.transcript.status !==
      SIDEPANEL_STATE_API.TRANSCRIPT_STATUSES.READY
    ) {
      return;
    }
  } else if (!transcriptResult.success) {
    const routeOutcome = transcriptRouteOutcome(transcriptResult);
    if (routeOutcome === "PAGE_CONTEXT_CHANGED") {
      scheduleDigestRefresh();
      return;
    }
    if (routeOutcome === "CONFIRMED_UNAVAILABLE") {
      showError(
        "当前视频没有可用字幕",
        transcriptResult.message || "YouTube 已确认当前视频没有可读取的字幕。",
      );
      return;
    }
    const shouldPromptForYoutubeCaptions =
      requestMediaRef?.platform !== "bilibili" &&
      supadataConsent !== true &&
      captionRetry !== true &&
      routeOutcome === "UNKNOWN";
    if (
      shouldPromptForYoutubeCaptions ||
      transcriptResult.requiresCaptionEnable === true ||
      transcriptResult.error === "YOUTUBE_CAPTIONS_REQUIRED"
    ) {
      const notesOnlyContext = isActiveNotesOnlyContext()
        ? activeNotesOnlyContext
        : null;
      showYoutubeCaptionsRequired(
        async () => {
          if (!ownsDigestLoad()) return;
          const requestKey = `${generation}:${videoId}`;
          await runDigestSingleFlight(requestKey, async () => undefined);
          await runDigestSingleFlight(requestKey, () =>
            runDigestLoad(
              videoId,
              generation,
              false,
              requestMediaRef,
              routeKey,
              false,
              true,
            ),
          );
          if (
            currentTranscript &&
            notesOnlyContext &&
            activeNotesOnlyContext?.token === notesOnlyContext.token &&
            isActiveNotesOnlyContext()
          ) {
            await clearNoteNavigationState(notesOnlyContext.token);
          }
        },
        notesOnlyContext
          ? () => returnToNotesOnlyContext(notesOnlyContext)
          : null,
      );
      return;
    }
    if (
      captionRetry === true &&
      shouldOfferSupadata(transcriptResult) &&
      supadataConsent !== true
    ) {
      const notesOnlyContext = isActiveNotesOnlyContext()
        ? activeNotesOnlyContext
        : null;
      const hasSupadataKey = Boolean(
        transcriptResult.hasSupadataKey ?? currentConfigStatus?.hasSupadataKey,
      );
      if (!hasSupadataKey) {
        showSupadataNotConfigured(
          transcriptResult.message ||
            "免费字幕路线未能取得字幕。如你愿意，可配置 Supadata 作为每次调用都需确认的第三方后备。",
        );
        return;
      }
      showSupadataConsent(async () => {
        if (!ownsDigestLoad()) return;
        const requestKey = `${generation}:${videoId}`;
        await runDigestSingleFlight(requestKey, async () => undefined);
        if (!ownsDigestLoad()) return;
        await runDigestSingleFlight(requestKey, () =>
          runDigestLoad(
            videoId,
            generation,
            false,
            requestMediaRef,
            routeKey,
            true,
          ),
        );
        if (
          currentTranscript &&
          notesOnlyContext &&
          activeNotesOnlyContext?.token === notesOnlyContext.token &&
          isActiveNotesOnlyContext()
        ) {
          await clearNoteNavigationState(notesOnlyContext.token);
        }
      }, notesOnlyContext ? () => returnToNotesOnlyContext(notesOnlyContext) : null);
      return;
    }
    // Once Supadata is explicitly authorized, provider errors stay on the
    // third-party path and never restart the free Passive/Active/Panel chain.
    if (transcriptResult.error === "SUPADATA_NOT_CONFIGURED") {
      showSupadataNotConfigured(
        transcriptResult.message ||
          "Supadata 密钥当前未配置；不会重新运行免费字幕路线。",
      );
      return;
    }
    if (transcriptResult.error === "RATE_LIMITED") {
      if (supadataConsent === true) {
        showSupadataRateLimited(
          transcriptResult.message ||
            "Supadata 请求已达速率上限，请稍后再授权重试。",
        );
      } else {
        showError(
          "YouTube 字幕暂时受限",
          transcriptResult.message ||
            "YouTube 原生字幕请求受到速率限制，本次已停止。",
        );
      }
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

  const previousArtifactIdentity = await readStoredTranscriptArtifactIdentity(
    videoId,
  );
  if (!ownsDigestLoad()) return;
  await invalidateTranscriptDerivedArtifacts(
    videoId,
    previousArtifactIdentity,
    currentTranscriptArtifactIdentity(),
  );
  if (!ownsDigestLoad()) return;

  await hydrateCurrentVideoNoteSource();
  if (!ownsDigestLoad()) return;

  currentAnalysis = await loadOverviewFromCache(
    videoId,
    currentTranscriptTimestamped,
    currentTranscriptLanguage,
    currentTranscriptSource,
    currentTranscriptSelectedTrack,
  );
  if (!ownsDigestLoad()) return;

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);
  }
  if (SIDEPANEL_MVP_AVAILABLE) renderSidepanelMvpTranscriptState();
  else {
    showState("results");
    document.getElementById("tabsNav").style.display = "flex";
  }

  // Preserve an explicitly selected All Notes view across digest loading.
  loadNotes(notesFilterShowAll ? null : videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);
  if (!ownsDigestLoad()) return;

  refreshOverviewForCurrentVideoIfVisible();

  if (SIDEPANEL_MVP_AVAILABLE) {
    sidepanelMvpTaskGate.finish(mvpEnvelope);
  }

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

function setTranscriptTranslationStatus(message = "", isError = false) {
  const status = document.getElementById("transcriptTranslationStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", isError);
  status.hidden = !message;
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
    <span class="overview-language-block overview-language-block--${language}${language === "zh" ? chineseVisualQuoteClass(text) : ""}" lang="${lang}">${escapeHtml(text || "")}</span>
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
    const overviewSaved = await saveOverviewToCache(
      videoId,
      currentAnalysis,
      currentTranscriptTimestamped,
      currentTranscriptLanguage,
    );
    const digestSaved = await saveToCache(videoId);
    if (!overviewSaved && !digestSaved) {
      setOverviewTranslationStatus(
        "概览已生成，但本地保存失败；再次打开可能会重新生成并消耗 AI 额度。",
        true,
      );
    }
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
    li.addEventListener("click", async () => {
      debugLog(
        "[DigestDock Panel] Chapter clicked:",
        chapterTime,
        chapter.timestampSeconds,
      );
      const moved = await seekTo(chapter.timestampSeconds);
      if (moved) {
        setActiveChapter(li);
        setOverviewTranslationStatus();
      } else {
        setOverviewTranslationStatus(
          "当前视频位置暂时无法跳转，请刷新视频页后重试。",
          true,
        );
      }
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
    div.addEventListener("click", async () => {
      debugLog(
        "[DigestDock Panel] Quote clicked:",
        quoteTime,
        quote.timestampSeconds,
      );
      const moved = await seekTo(quote.timestampSeconds);
      if (!moved) {
        setOverviewTranslationStatus(
          "当前视频位置暂时无法跳转，请刷新视频页后重试。",
          true,
        );
      }
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

/** Saves the current playback moment from the Notes empty state. */
async function saveCurrentMomentFromPanel() {
  const button = document.getElementById("saveCurrentMomentBtn");
  const label = button?.querySelector?.("span");
  if (
    !button ||
    !currentVideoId ||
    !currentRouteKey ||
    !Number.isInteger(videoTabId)
  ) {
    return;
  }
  const actionContext = Object.freeze({
    generation: digestGeneration,
    tabId: videoTabId,
    routeKey: currentRouteKey,
    videoId: currentVideoId,
    videoUrl: currentVideoUrl,
    videoTitle: currentVideoTitle,
    channelName: currentChannelName,
    sourceLanguage:
      currentVideoSourceLanguage || currentTranscriptLanguage || "",
    mediaRef: currentMediaRef ? { ...currentMediaRef } : null,
  });
  const contextIsCurrent = () =>
    digestGeneration === actionContext.generation &&
    videoTabId === actionContext.tabId &&
    currentRouteKey === actionContext.routeKey &&
    currentVideoId === actionContext.videoId;
  const setLabel = (text) => {
    if (label) label.textContent = text;
    else button.textContent = text;
  };

  button.disabled = true;
  setLabel("正在保存…");
  setNotesTranslationStatus();
  try {
    const timingResult = await chrome.runtime.sendMessage({
      action: "relayToContent",
      tabId: actionContext.tabId,
      expectedRouteKey: actionContext.routeKey,
      payload: { action: "getCurrentTime" },
    });
    const timing = requireContentRelayResponse(
      timingResult,
      "无法读取当前播放位置。",
    );
    if (!contextIsCurrent()) {
      throw new Error("视频页面已切换，请在当前视频重新保存。");
    }
    const timestamp = Math.max(
      0,
      Math.floor(Number(timing.currentTime) || 0) - 3,
    );
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: actionContext.videoId,
      mediaRef: actionContext.mediaRef,
      videoUrl:
        actionContext.mediaRef?.canonicalUrl || actionContext.videoUrl,
      timestamp,
      videoTitle: actionContext.videoTitle,
      channelName: actionContext.channelName,
      tabId: actionContext.tabId,
      expectedRouteKey: actionContext.routeKey,
      preferredLanguage: actionContext.sourceLanguage,
      sourceLanguage: actionContext.sourceLanguage,
      skipAiCleanup: true,
    });
    if (!result?.success) {
      throw new Error(result?.message || result?.error || "笔记保存失败。");
    }
    setLabel("已保存");
    setNotesTranslationStatus("已保存当前时刻。");
  } catch (error) {
    setLabel("保存当前时刻");
    setNotesTranslationStatus(
      error?.message || "无法保存当前时刻，请重试。",
      true,
    );
  } finally {
    button.disabled = false;
  }
}

/** Saves a key quote as a timestamped note. */
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
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> ${escapeHtml(transcriptOriginalBadgeText())}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);
  const originalIsChinese =
    currentPlatformIsBilibili() || currentVideoIsChinese();

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    div.innerHTML = `
      ${transcriptTimeCellMarkup(group.seekStart ?? group.start)}
      <span class="transcript-text">${
        originalIsChinese
          ? renderTranscriptVisualFragments(group.texts)
          : renderSubtitleInlineMarkup(group.text)
      }</span>
    `;

    attachTranscriptTimeSeek(div, group.seekStart ?? group.start);
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

/**
 * Read-only export mode for the transcript download. Bilibili tracks are
 * Chinese-only with no language control, so their content is exported as-is
 * under the "zh" file suffix; every other platform follows the active
 * transcript language mode.
 */
function transcriptExportMode() {
  if (currentPlatformIsBilibili() || currentVideoIsChinese()) return "zh";
  return currentTranscriptMode === "bilingual" ? "bilingual" : currentTranscriptMode;
}

function currentTranscriptOriginalSegments() {
  return groupTranscriptEntries(currentTranscript || []).map((segment) => ({
    segmentId: segment.id,
    start: segment.start,
    text: segment.text,
    sourceHash: YTD_NOTE_SOURCES.hashSourceText(segment.text),
  }));
}

function applyPersistedSourceToCurrentVideo(source) {
  const key = currentVideoId || currentMediaRef?.mediaKey || "";
  const normalized = YTD_NOTE_SOURCES.normalizeNoteSource(source);
  if (!normalized || normalized.mediaKey !== key) return false;

  if (
    currentVideoDescriptionTruncated &&
    normalized.descriptionTruncated !== true &&
    (normalized.descriptionStatus === "present" ||
      normalized.descriptionStatus === "confirmed-empty")
  ) {
    currentVideoDescription = normalized.descriptionOriginal || "";
    currentVideoDescriptionState = normalized.descriptionStatus;
    currentVideoDescriptionTruncated = false;
  } else if (
    currentVideoDescriptionState === "unknown" &&
    normalized.descriptionStatus === "present" &&
    normalized.descriptionOriginal
  ) {
    currentVideoDescription = normalized.descriptionOriginal;
    currentVideoDescriptionState = "present";
    currentVideoDescriptionTruncated = normalized.descriptionTruncated === true;
  } else if (
    currentVideoDescriptionState === "unknown" &&
    normalized.descriptionStatus === "confirmed-empty"
  ) {
    currentVideoDescriptionState = "confirmed-empty";
    currentVideoDescriptionTruncated = false;
  }

  const currentDescriptionHash = currentVideoDescription
    ? YTD_NOTE_SOURCES.hashSourceText(currentVideoDescription)
    : "";
  if (
    normalized.descriptionZh &&
    normalized.descriptionSourceHash &&
    normalized.descriptionSourceHash === currentDescriptionHash
  ) {
    currentVideoDescriptionZh = normalized.descriptionZh;
  }

  const byIdentity = new Map();
  const byStartHash = new Map();
  normalized.transcriptZh.forEach((entry) => {
    byIdentity.set(
      `${entry.segmentId}\u0000${entry.startMs}\u0000${entry.sourceHash}`,
      entry.text,
    );
    const fallback = `${entry.startMs}\u0000${entry.sourceHash}`;
    const values = byStartHash.get(fallback) || [];
    values.push(entry.text);
    byStartHash.set(fallback, values);
  });
  getActiveTranscriptSegments().forEach((segment) => {
    const startMs = Math.round((Number(segment.start) || 0) * 1000);
    const sourceHash = YTD_NOTE_SOURCES.hashSourceText(segment.text);
    const exact = byIdentity.get(
      `${segment.id}\u0000${startMs}\u0000${sourceHash}`,
    );
    const fallback = byStartHash.get(`${startMs}\u0000${sourceHash}`) || [];
    const translated = exact || (fallback.length === 1 ? fallback[0] : "");
    if (translated) {
      transcriptParagraphCache.set(
        transcriptTranslationCacheKey(key, segment),
        translated,
      );
    }
  });
  currentPersistedNoteSource = normalized;
  return true;
}

async function hydrateCurrentVideoNoteSource() {
  const key = currentVideoId || currentMediaRef?.mediaKey || "";
  if (!key || !currentTranscript?.length) return null;
  try {
    const source = await YTD_NOTE_SOURCES.readNoteSource(
      chrome.storage.local,
      key,
    );
    if (key !== currentVideoId) return null;
    if (source) applyPersistedSourceToCurrentVideo(source);
    return source || null;
  } catch (error) {
    console.error("[DigestDock] Hydrate note source error:", error);
    return null;
  }
}

async function upsertNoteSourceInBackground(source) {
  const result = await chrome.runtime.sendMessage({
    action: "upsertNoteSource",
    source,
  });
  if (!result?.success) {
    const error = new Error(result?.message || "视频资料保存失败。");
    error.code = result?.code || "SOURCE_WRITE_FAILED";
    throw error;
  }
  const currentKey = currentVideoId || currentMediaRef?.mediaKey || "";
  if (result.source?.mediaKey === currentKey) {
    currentPersistedNoteSource = result.source;
  }
  return result.source || source;
}

/**
 * Resolves the current video's FULL, timecode-ordered original + Chinese
 * transcript segments for the requested mode, purely from the in-memory
 * segments and the translation cache. Read-only: a segment with no cached
 * Chinese is reported via `missingCount` rather than translated here, so a
 * partial lazy-loaded translation is never silently completed. Shared by the
 * transcript download, the note-source library and the note export.
 */
function resolveCurrentVideoTranscript(mode) {
  const segments = groupTranscriptEntries(currentTranscript || []);
  const transcriptOriginal = currentTranscriptOriginalSegments();
  // A confirmed-Chinese track needs no translation: its "original" IS Chinese,
  // so the zh/bilingual assembly reuses the original text.
  const originalIsChinese =
    currentPlatformIsBilibili() || currentVideoIsChinese();
  const needsTranslation = mode !== "original" && !originalIsChinese;
  const transcriptZh = [];
  let missingCount = 0;
  segments.forEach((segment) => {
    if (originalIsChinese) {
      transcriptZh.push({
        segmentId: segment.id,
        start: segment.start,
        sourceHash: YTD_NOTE_SOURCES.hashSourceText(segment.text),
        text: segment.text,
      });
      return;
    }
    if (!needsTranslation) return;
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(currentVideoId, segment),
    );
    const text = typeof cached === "string" ? cached.trim() : "";
    if (text) {
      transcriptZh.push({
        segmentId: segment.id,
        start: segment.start,
        sourceHash: YTD_NOTE_SOURCES.hashSourceText(segment.text),
        text,
      });
    }
    else missingCount += 1;
  });
  return {
    segments,
    transcriptOriginal,
    transcriptZh,
    originalIsChinese,
    missingCount,
    total: segments.length,
  };
}

/** The validated Chinese video title held on the current media's notes. */
function currentVideoTitleZh() {
  const key = currentVideoId || currentMediaRef?.mediaKey || "";
  const note = (currentNotes || []).find(
    (candidate) => String(candidate?.mediaKey || candidate?.videoId || "") === key,
  );
  return note ? noteChineseVideoTitle(note) : "";
}

/**
 * Assembles the current-video transcript export source. Kept read-only and
 * with the transcript-download title semantics (title translation is owned by
 * notes, so a non-Chinese title is left original here).
 */
function buildTranscriptExportSource(mode) {
  const resolved = resolveCurrentVideoTranscript(mode);
  const source = {
    mediaKey: currentVideoId || currentMediaRef?.mediaKey || "",
    platform: currentPlatformIsBilibili() ? "bilibili" : "youtube",
    canonicalUrl: currentMediaRef?.canonicalUrl || currentVideoUrl || "",
    titleOriginal: currentVideoTitle || "",
    titleZh: resolved.originalIsChinese ? currentVideoTitle || "" : "",
    channelName: currentChannelName || "",
    descriptionOriginal: currentVideoDescription || "",
    descriptionStatus: currentVideoDescriptionState,
    descriptionTruncated: currentVideoDescriptionTruncated,
    descriptionZh: resolved.originalIsChinese
      ? currentVideoDescription || ""
      : currentVideoDescriptionZh,
    transcriptOriginal: resolved.transcriptOriginal,
    transcriptZh: resolved.transcriptZh,
    sourceLanguage:
      currentTranscriptLanguage || currentVideoSourceLanguage || "",
  };
  return { source, missingCount: resolved.missingCount, total: resolved.total };
}

function exportTranslationProgressText(plan) {
  const progress = plan?.progress || {};
  const completed = Number(progress.completedUnits) || 0;
  const total = Math.max(
    completed + (Number(progress.remainingUnits) || 0),
    Number(progress.totalUnits) || 0,
  );
  return {
    completed,
    total,
    remainingBatches:
      Number(progress.remainingBatches) || Number(plan?.estimatedBatches) || 0,
    roundMax: Number(progress.roundMaxBatches) || 20,
    hasProgress: completed > 0,
  };
}

function showTranscriptExportPrecheck(
  plan,
  missingCount,
  onGenerate,
  onExportOriginal,
) {
  const panel = document.getElementById("transcriptExportPrecheck");
  if (!panel) return;
  panel.innerHTML = "";
  const summary = document.createElement("p");
  summary.className = "notes-export-precheck-text";
  summary.tabIndex = -1;
  const progress = exportTranslationProgressText(plan);
  summary.textContent = plan.overLimit
    ? `还有 ${missingCount} 段字幕未翻译。本次补译未启动：${plan.limitReasons.join("、")}。请缩小导出范围。`
    : `还有 ${missingCount} 段字幕未翻译。当前已完成 ${progress.completed}/${progress.total} 个翻译单元，剩余约 ${progress.remainingBatches} 批；每次确认最多继续 ${progress.roundMax} 批，全部完成后自动导出。`;
  panel.appendChild(summary);
  const actions = document.createElement("div");
  actions.className = "notes-export-precheck-actions";
  const generate = document.createElement("button");
  generate.type = "button";
  generate.className = "enhance-btn active";
  generate.textContent = progress.hasProgress
    ? `继续补齐（本轮最多 ${progress.roundMax} 批）`
    : `生成中文（本轮最多 ${progress.roundMax} 批）`;
  generate.disabled = plan.overLimit;
  generate.addEventListener("click", () => {
    if (!generate.disabled) void onGenerate();
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "enhance-btn";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    panel.hidden = true;
    setTranscriptExportStatus("已取消导出。");
  });
  actions.append(generate, cancel);
  if (onExportOriginal) {
    const original = document.createElement("button");
    original.type = "button";
    original.className = "enhance-btn";
    original.textContent = "改为导出原文";
    original.addEventListener("click", () => {
      panel.hidden = true;
      onExportOriginal();
    });
    actions.insertBefore(original, cancel);
  }
  panel.appendChild(actions);
  panel.hidden = false;
  summary.focus?.();
}

async function exportTranscript() {
  const exportBtn = document.getElementById("exportTranscriptBtn");
  const precheckPanel = document.getElementById("transcriptExportPrecheck");
  setTranscriptExportStatus();
  if (!currentTranscript || !currentTranscript.length) {
    if (exportBtn) flashIconDone(exportBtn, "暂无可导出的字幕", "导出完整字幕", 2200);
    return;
  }
  const mode = transcriptExportMode();
  let persistedSource = null;
  try {
    persistedSource = await persistCurrentVideoSourceForExport();
  } catch (error) {
    setTranscriptExportStatus(
      error?.message || "无法保存字幕资料，请重试。",
      true,
    );
    return;
  }
  const built = buildTranscriptExportSource(mode);
  const source = persistedSource
    ? {
        ...persistedSource,
        ...built.source,
        descriptionZhChunks: persistedSource.descriptionZhChunks || [],
      }
    : built.source;
  const missingCount = built.missingCount;
  // Never emit a file that claims to be complete Chinese while segments remain
  // untranslated. A user may explicitly authorize one bounded completion job.
  if (missingCount > 0) {
    const mediaKey = source.mediaKey;
    const group = {
      mediaKey,
      representative: {
        videoTitle: currentVideoTitle,
        platform: source.platform,
      },
      notes: [],
    };
    const sourceMap = { [mediaKey]: source };
    const plan = YTD_NOTE_SOURCES.buildExportTranslationPlan({
      groups: [group],
      sourcesByKey: sourceMap,
      mode,
      isChineseText: looksLikeLegacyChineseNote,
      includeTitles: false,
      includeNotes: false,
      includeDescriptions: false,
      includeTranscript: true,
    });
    showTranscriptExportPrecheck(plan, missingCount, async () => {
      try {
        const outcome = await runConfirmedExportTranslationRound({
          plan,
          sourcesByKey: sourceMap,
          groups: [group],
          scope: "transcript-current",
          mode,
          format: "txt",
          panelId: "transcriptExportPrecheck",
          setStatus: setTranscriptExportStatus,
        });
        if (!exportRunIsCurrent(outcome.owner)) throw exportCancelledError();
        if (!outcome.complete) {
          await exportTranscript();
          return;
        }
        const latestSource = await YTD_NOTE_SOURCES.readNoteSource(
          chrome.storage.local,
          mediaKey,
        );
        assertFrozenExportOutcome(outcome, {
          mediaKeys: [mediaKey],
          mode,
          format: "txt",
        });
        assertFrozenExportMaterial(
          outcome,
          [group],
          latestSource ? { [mediaKey]: latestSource } : {},
        );
        const finalPlan = YTD_NOTE_SOURCES.buildExportTranslationPlan({
          groups: [group],
          sourcesByKey: latestSource ? { [mediaKey]: latestSource } : {},
          mode,
          isChineseText: looksLikeLegacyChineseNote,
          includeTitles: false,
          includeNotes: false,
          includeDescriptions: false,
          includeTranscript: true,
        });
        if (finalPlan.unitCount) {
          throw new Error("字幕补译尚未完整写入，请再次点击导出继续。");
        }
        await finalizeExportJobDownload(outcome, () => {
          assertExportRunCurrent(outcome.owner);
          const text = YTD_NOTE_EXPORT.buildTranscriptText(latestSource, mode);
          const filename = YTD_NOTE_EXPORT.transcriptExportFilename(
            latestSource.titleOriginal || currentVideoTitle,
            mode,
          );
          downloadTextFile(text, filename);
        });
        setTranscriptExportStatus("已导出完整字幕。");
      } catch (error) {
        const cancelled = error?.code === "EXPORT_TRANSLATION_CANCELLED";
        setTranscriptExportStatus(
          error?.message || "补译失败，请重试。",
          !cancelled,
        );
      }
    }, () => {
      abandonActiveExportTranslation();
      const text = YTD_NOTE_EXPORT.buildTranscriptText(source, "original");
      const filename = YTD_NOTE_EXPORT.transcriptExportFilename(
        source.titleOriginal || currentVideoTitle,
        "original",
      );
      downloadTextFile(text, filename);
      setTranscriptExportStatus("已导出原文字幕。");
    });
    return;
  }
  if (precheckPanel) precheckPanel.hidden = true;
  const text = YTD_NOTE_EXPORT.buildTranscriptText(source, mode);
  const filename = YTD_NOTE_EXPORT.transcriptExportFilename(
    currentVideoTitle,
    mode,
  );
  downloadTextFile(text, filename);
  setTranscriptExportStatus("已导出完整字幕。");
}

// ============================================================
// NOTE EXPORT (TXT) — current video, selected videos, and all notes
// ============================================================
// Reading exports reuse the shared note-export assembly and note-source
// library. Precheck is strictly read-only. Missing translations trigger no
// request unless the user explicitly chooses the bounded "生成中文并导出" action;
// source gaps never trigger Supadata or another provider implicitly.

/** Per-note original/Chinese text for exports, reusing the UI's validated logic. */
function resolveNoteExportEntry(note) {
  return { original: noteOriginalText(note), zh: noteChineseText(note) };
}

function noteCanonicalUrl(note) {
  const direct = String(note?.canonicalUrl || "").trim();
  const directLocator = extractMediaLocator(direct);
  if (directLocator?.canonicalUrl) return directLocator.canonicalUrl;
  const locator = extractMediaLocator(note?.timestampedUrl || "");
  if (locator?.canonicalUrl) return locator.canonicalUrl;
  if (note?.platform !== "bilibili") {
    const videoId = String(note?.videoId || note?.mediaKey || "").trim();
    if (/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    }
  }
  return "";
}

function normalizeExportMediaKeys(mediaKeys) {
  if (mediaKeys === null || mediaKeys === undefined) return null;
  return [...new Set((Array.isArray(mediaKeys) ? mediaKeys : []).map((key) =>
    String(key || "").trim(),
  ).filter(Boolean))].sort();
}

function filterNoteGroupsByMediaKeys(groups, mediaKeys, { requireAll = true } = {}) {
  const requested = normalizeExportMediaKeys(mediaKeys);
  const safeGroups = Array.isArray(groups) ? groups : [];
  if (requested === null) return safeGroups;
  const requestedSet = new Set(requested);
  const selected = safeGroups.filter((group) => requestedSet.has(group.mediaKey));
  if (requireAll && selected.length !== requestedSet.size) {
    const error = new Error("所选视频的笔记已发生变化，请重新选择导出范围。");
    error.code = "EXPORT_SELECTION_STALE";
    throw error;
  }
  return selected;
}

/**
 * Builds the note-source record for the current video from in-memory state, so
 * the durable library can back the "all notes" export even after the video is
 * unloaded. Only the fields we actually have are filled; description is only
 * available from a live capture (the digest cache never stored it).
 */
function buildCurrentVideoSourceRecord() {
  const resolved = resolveCurrentVideoTranscript("bilingual");
  return {
    mediaKey: currentVideoId || currentMediaRef?.mediaKey || "",
    platform: currentPlatformIsBilibili() ? "bilibili" : "youtube",
    canonicalUrl: currentMediaRef?.canonicalUrl || currentVideoUrl || "",
    titleOriginal: currentVideoTitle || "",
    titleZh: resolved.originalIsChinese
      ? currentVideoTitle || ""
      : currentVideoTitleZh(),
    channelName: currentChannelName || "",
    descriptionOriginal: currentVideoDescription || "",
    descriptionStatus: currentVideoDescriptionState,
    descriptionTruncated: currentVideoDescriptionTruncated,
    descriptionZh: resolved.originalIsChinese
      ? currentVideoDescription || ""
      : currentVideoDescriptionZh,
    sourceLanguage:
      currentTranscriptLanguage || currentVideoSourceLanguage || "",
    transcriptOriginal: resolved.transcriptOriginal,
    transcriptZh: resolved.transcriptZh,
  };
}

/**
 * Persists the current video's source material when at least one saved note
 * references it. Idempotent (the library no-ops when nothing changed), so it is
 * safe to call after saves, translations and cache writes.
 */
async function persistCurrentVideoNoteSourceIfNoted() {
  const key = currentVideoId || currentMediaRef?.mediaKey || "";
  if (!key) return null;
  try {
    const stored = await chrome.storage.local.get("ytd_notes");
    const notes = Array.isArray(stored.ytd_notes) ? stored.ytd_notes : [];
    const hasNote = notes.some(
      (note) => String(note?.mediaKey || note?.videoId || "") === key,
    );
    if (!hasNote) return null;
    const persisted = await upsertNoteSourceInBackground(
      buildCurrentVideoSourceRecord(),
    );
    applyPersistedSourceToCurrentVideo(persisted);
    return persisted;
  } catch (error) {
    console.error("[DigestDock] Persist note source error:", error);
    return null;
  }
}

async function persistCurrentVideoSourceForExport() {
  const key = currentVideoId || currentMediaRef?.mediaKey || "";
  if (!key || !currentTranscript?.length) return null;
  const persisted = await upsertNoteSourceInBackground(
    buildCurrentVideoSourceRecord(),
  );
  applyPersistedSourceToCurrentVideo(persisted);
  return persisted;
}

/**
 * Assembles the note-export "source" for one group, preferring the stored/
 * backfilled source and filling identity + title from the group's notes.
 */
function exportSourceForGroup(group, storedSource) {
  const rep = group.representative || group.notes[0] || {};
  const base = storedSource
    ? { ...storedSource }
    : {
        mediaKey: group.mediaKey,
        platform: rep.platform === "bilibili" ? "bilibili" : "youtube",
        canonicalUrl: noteCanonicalUrl(rep),
        titleOriginal: "",
        titleZh: "",
        channelName: "",
        descriptionOriginal: "",
        descriptionStatus: "unknown",
        descriptionZh: "",
        sourceLanguage: rep.sourceLanguage || "",
        transcriptOriginal: [],
        transcriptZh: [],
      };
  base.titleOriginal = base.titleOriginal || noteOriginalVideoTitle(rep);
  if (!base.titleZh) base.titleZh = noteChineseVideoTitle(rep);
  base.channelName = base.channelName || rep.channelName || "";
  base.canonicalUrl = base.canonicalUrl || noteCanonicalUrl(rep);
  base.sourceLanguage = base.sourceLanguage || rep.sourceLanguage || "";
  return YTD_NOTE_SOURCES.toExportSource(base, group.notes, {
    resolveNote: resolveNoteExportEntry,
  });
}

/** No-network backfill using one shared semantic grouping for original + zh. */
function resolveDigestTranscriptMaterial(mediaKey, digest) {
  const segments = groupTranscriptEntries(
    Array.isArray(digest?.transcript) ? digest.transcript : [],
  );
  const cache = digest?.paragraphCache || {};
  const original = segments.map((segment) => ({
    segmentId: segment.id,
    start: segment.start,
    sourceHash: YTD_NOTE_SOURCES.hashSourceText(segment.text),
    text: segment.text,
  }));
  const zh = [];
  segments.forEach((segment) => {
    const value = cache[transcriptTranslationCacheKey(mediaKey, segment)];
    const text = typeof value === "string" ? value.trim() : "";
    if (text) {
      zh.push({
        segmentId: segment.id,
        start: segment.start,
        sourceHash: YTD_NOTE_SOURCES.hashSourceText(segment.text),
        text,
      });
    }
  });
  return { transcriptOriginal: original, transcriptZh: zh };
}

/**
 * Collects the "all notes" export inputs: every note grouped by source, the
 * stored source library, and a strictly no-network backfill from the local
 * digest cache for any noted video without a stored source. Also enriches each
 * source with the validated title held on its notes so the precheck does not
 * ask to re-translate an already-translated title.
 */
async function collectAllNotesExport(mediaKeys = null) {
  const result = await chrome.runtime.sendMessage({
    action: "getNotes",
    videoId: null,
  });
  const notes = result?.success && Array.isArray(result.notes) ? result.notes : [];
  const allGroups = sortNoteGroups(
    groupNotesBySource(notes),
    (representative) =>
      noteVideoTitleSortKey(representative, currentNotesMode),
  );
  const groups = filterNoteGroupsByMediaKeys(allGroups, mediaKeys);
  const storedSources = await YTD_NOTE_SOURCES.readAllSources(
    chrome.storage.local,
  );
  const sourcesByKey = {};
  for (const group of groups) {
    const rep = group.representative || group.notes[0] || {};
    if (storedSources[group.mediaKey]) {
      sourcesByKey[group.mediaKey] = storedSources[group.mediaKey];
    }
    if (!sourcesByKey[group.mediaKey]) {
      try {
        const cacheKey = `digest_${group.mediaKey}`;
        const cached = await chrome.storage.local.get(cacheKey);
        const digest = cached[cacheKey];
        if (digest) {
          const backfilled = YTD_NOTE_SOURCES.sourceFromDigest(
            group.mediaKey,
            digest,
            resolveDigestTranscriptMaterial(group.mediaKey, digest),
          );
          if (backfilled) {
            sourcesByKey[group.mediaKey] = await upsertNoteSourceInBackground(
              backfilled,
            );
          }
        }
      } catch (error) {
        console.error("[DigestDock] Backfill source error:", error);
      }
    }
    // Enrich (or synthesize a minimal source) with note-held identity + title.
    const sourceWasAvailable = !!sourcesByKey[group.mediaKey];
    const source = sourcesByKey[group.mediaKey] || {
      mediaKey: group.mediaKey,
      platform: rep.platform === "bilibili" ? "bilibili" : "youtube",
      canonicalUrl: noteCanonicalUrl(rep),
      titleOriginal: "",
      titleZh: "",
      channelName: "",
      descriptionOriginal: "",
      descriptionStatus: "unknown",
      descriptionZh: "",
      transcriptOriginal: [],
      transcriptZh: [],
      sourceLanguage: rep.sourceLanguage || "",
    };
    source.titleOriginal = source.titleOriginal || noteOriginalVideoTitle(rep);
    if (!source.titleZh) source.titleZh = noteChineseVideoTitle(rep);
    source.channelName = source.channelName || rep.channelName || "";
    source.canonicalUrl = source.canonicalUrl || noteCanonicalUrl(rep);
    sourcesByKey[group.mediaKey] = sourceWasAvailable
      ? await upsertNoteSourceInBackground(source)
      : source;
  }
  return {
    notes: groups.flatMap((group) => group.notes),
    groups,
    sourcesByKey,
  };
}

function requireKnownExportDescriptions(precheck) {
  const videos = (precheck?.videos || []).map((video) => {
    if (video.descriptionStatus !== "unknown") return video;
    const existingReasons = video.blockingReasons || [];
    const blockingReasons = existingReasons.some((reason) =>
      String(reason).includes("简介"),
    )
      ? existingReasons
      : [...existingReasons, "尚未读取视频简介"];
    return { ...video, blocking: true, blockingReasons };
  });
  const blockingVideos = videos.filter((video) => video.blocking);
  return {
    ...precheck,
    videos,
    blockingVideos,
    hasBlocking: blockingVideos.length > 0,
  };
}

/** Human-readable summary of a precheck for the inline confirmation panel. */
function describeExportPrecheck(precheck) {
  const lines = [];
  lines.push(
    `范围：${precheck.videoCount} 个视频、${precheck.noteCount} 条笔记。`,
  );
  if (precheck.hasBlocking) {
    const names = precheck.blockingVideos
      .map((video) => `「${video.title}」（${video.blockingReasons.join("、")}）`)
      .join("；");
    lines.push(`缺少完整资料，将以「缺失」标注：${names}`);
  }
  if (precheck.hasTranslationGaps) {
    const gaps = [];
    if (precheck.translationGaps.titles)
      gaps.push(`${precheck.translationGaps.titles} 个标题`);
    if (precheck.translationGaps.descriptionChunks)
      gaps.push(`${precheck.translationGaps.descriptionChunks} 段简介`);
    else if (precheck.translationGaps.descriptions)
      gaps.push(`${precheck.translationGaps.descriptions} 个简介`);
    if (precheck.translationGaps.transcriptSegments)
      gaps.push(`${precheck.translationGaps.transcriptSegments} 段字幕`);
    if (precheck.translationGaps.notes)
      gaps.push(`${precheck.translationGaps.notes} 条笔记`);
    lines.push(
      `尚有 ${gaps.join("、")} 未翻译；不会自动联网补译，也不会用原文冒充中文导出。`,
    );
  }
  return lines.join("\n");
}

function noteExportModeLabel(mode = currentNotesMode) {
  if (mode === "original") return "原文";
  if (mode === "zh") return "中文";
  return "双语";
}

function buildNotesExportPrecheck(groups, sourcesByKey, mode = currentNotesMode) {
  return requireKnownExportDescriptions(
    YTD_NOTE_SOURCES.buildExportPrecheck({
      groups,
      sourcesByKey,
      mode,
      titleOf: (group) =>
        noteVideoTitleSortKey(group.representative || group.notes?.[0], mode),
      isChineseText: looksLikeLegacyChineseNote,
      resolveNote: resolveNoteExportEntry,
      includeTranscript: false,
    }),
  );
}

function buildNotesExportTranslationPlan(
  groups,
  sourcesByKey,
  mode = currentNotesMode,
) {
  return YTD_NOTE_SOURCES.buildExportTranslationPlan({
    groups,
    sourcesByKey,
    mode,
    isChineseText: looksLikeLegacyChineseNote,
    resolveNote: resolveNoteExportEntry,
    includeTranscript: false,
  });
}

function noteExportVideoTranslationGapCount(video) {
  return (
    (video?.needsTitleTranslation ? 1 : 0) +
    (Number(video?.descriptionMissingChunkCount) || 0) +
    (Number(video?.noteTranslationCount) || 0)
  );
}

function noteExportVideoPreparation(video) {
  if (video?.blocking) {
    return { label: "需补资料", className: "is-metadata" };
  }
  const missing = noteExportVideoTranslationGapCount(video);
  if (missing) {
    return { label: `需补译 ${missing} 项`, className: "is-translation" };
  }
  return { label: "可导出", className: "is-ready" };
}

function createNoteExportContinuation(mediaKeys) {
  return normalizeNoteExportContinuation({
    mediaKeys: normalizeExportMediaKeys(mediaKeys) || [],
    mode: currentNotesMode,
  });
}

function noteExportContinuationIsAuthorized(continuation) {
  const normalized = normalizeNoteExportContinuation(continuation);
  return (
    !!normalized &&
    activeNoteExportAuthorization?.expiresAt >= Date.now() &&
    activeNoteExportAuthorization.signature === JSON.stringify(normalized)
  );
}

function revokeNoteExportAuthorization(expectedAuthorization = null) {
  if (
    expectedAuthorization &&
    activeNoteExportAuthorization !== expectedAuthorization
  ) {
    return false;
  }
  noteExportAuthorizationGeneration += 1;
  activeNoteExportAuthorization = null;
  return true;
}

function noteExportAuthorizationCancelledError() {
  const error = new Error("已取消本次完整导出。");
  error.code = "NOTE_EXPORT_AUTHORIZATION_CANCELLED";
  return error;
}

function assertNoteExportAuthorizationCurrent(authorization) {
  if (!authorization) return;
  if (
    activeNoteExportAuthorization !== authorization ||
    noteExportAuthorizationGeneration !== authorization.generation ||
    authorization.expiresAt < Date.now()
  ) {
    throw noteExportAuthorizationCancelledError();
  }
}

function exportFlowWasCancelled(error) {
  return (
    error?.code === "EXPORT_TRANSLATION_CANCELLED" ||
    error?.code === "NOTE_EXPORT_AUTHORIZATION_CANCELLED"
  );
}

async function grantNoteExportAuthorization(
  continuation,
  { groups = [], sourcesByKey = {}, precheck = null } = {},
) {
  const normalized = normalizeNoteExportContinuation(continuation);
  if (!normalized) return null;
  const generation = noteExportAuthorizationGeneration + 1;
  noteExportAuthorizationGeneration = generation;
  activeNoteExportAuthorization = null;
  const effectivePrecheck =
    precheck || buildNotesExportPrecheck(groups, sourcesByKey, normalized.mode);
  const blockingMediaKeys = new Set(
    (effectivePrecheck.blockingVideos || []).map((video) =>
      String(video.mediaKey || ""),
    ),
  );
  const sourceRevisions = exportPlanSourceRevisions(
    sourcesByKey,
    normalized.mediaKeys,
  );
  const stableSourceRevisions = Object.fromEntries(
    Object.entries(sourceRevisions).filter(
      ([mediaKey]) => !blockingMediaKeys.has(mediaKey),
    ),
  );
  const providerRequired =
    normalized.mode !== "original" &&
    (effectivePrecheck.hasBlocking || effectivePrecheck.hasTranslationGaps);
  let providerSnapshot = null;
  if (providerRequired) {
    const config = await chrome.runtime.sendMessage({ action: "checkConfig" });
    if (noteExportAuthorizationGeneration !== generation) return null;
    currentConfigStatus = config;
    providerSnapshot = exportProviderSnapshot(config);
  }
  if (noteExportAuthorizationGeneration !== generation) return null;
  activeNoteExportAuthorization = {
    generation,
    signature: JSON.stringify(normalized),
    expiresAt: Date.now() + NOTE_EXPORT_AUTHORIZATION_TTL_MS,
    notesRevision: exportNotesRevision(groups),
    stableSourceRevisions,
    blockingMediaKeys: [...blockingMediaKeys].sort(),
    providerRequired,
    providerSnapshot,
  };
  return normalized;
}

async function validateNoteExportAuthorization(
  continuation,
  { groups = [], sourcesByKey = {}, precheck = null } = {},
) {
  const normalized = normalizeNoteExportContinuation(continuation);
  const authorization = activeNoteExportAuthorization;
  if (
    !normalized ||
    !authorization ||
    authorization.expiresAt < Date.now() ||
    authorization.signature !== JSON.stringify(normalized) ||
    authorization.notesRevision !== exportNotesRevision(groups)
  ) {
    revokeNoteExportAuthorization(authorization);
    return false;
  }

  for (const [mediaKey, expectedRevision] of Object.entries(
    authorization.stableSourceRevisions || {},
  )) {
    const source = YTD_NOTE_SOURCES.normalizeNoteSource(sourcesByKey?.[mediaKey]);
    if (!source || source.sourceRevision !== expectedRevision) {
      revokeNoteExportAuthorization(authorization);
      return false;
    }
  }

  if (authorization.providerRequired) {
    const config = await chrome.runtime.sendMessage({ action: "checkConfig" });
    if (
      activeNoteExportAuthorization !== authorization ||
      noteExportAuthorizationGeneration !== authorization.generation
    ) {
      throw noteExportAuthorizationCancelledError();
    }
    currentConfigStatus = config;
    if (
      !sameProviderSnapshot(
        exportProviderSnapshot(config),
        authorization.providerSnapshot,
      )
    ) {
      revokeNoteExportAuthorization(authorization);
      return false;
    }
  }

  // Metadata collection is the only material change authorized by the click.
  // Once an initially-blocking source becomes complete, freeze its revision so
  // any later change requires a fresh confirmation before AI can run.
  const effectivePrecheck =
    precheck || buildNotesExportPrecheck(groups, sourcesByKey, normalized.mode);
  const stillBlocking = new Set(
    (effectivePrecheck.blockingVideos || []).map((video) =>
      String(video.mediaKey || ""),
    ),
  );
  const remainingInitiallyBlocking = [];
  for (const mediaKey of authorization.blockingMediaKeys || []) {
    if (stillBlocking.has(mediaKey)) {
      remainingInitiallyBlocking.push(mediaKey);
      continue;
    }
    const source = YTD_NOTE_SOURCES.normalizeNoteSource(sourcesByKey?.[mediaKey]);
    if (!source?.sourceRevision) {
      revokeNoteExportAuthorization(authorization);
      return false;
    }
    authorization.stableSourceRevisions[mediaKey] = source.sourceRevision;
  }
  authorization.blockingMediaKeys = remainingInitiallyBlocking;
  return true;
}

async function clearNoteExportContinuation() {
  revokeNoteExportAuthorization();
  const state = activeNotesOnlyContext || pendingNoteNavigation;
  if (!state?.exportContinuation) return;
  await persistNoteNavigationState({
    ...state,
    exportContinuation: null,
  });
}

function resumeNoteExportContinuation(continuation) {
  const requestedContinuation = normalizeNoteExportContinuation(continuation);
  const liveContinuation = normalizeNoteExportContinuation(
    (activeNotesOnlyContext || pendingNoteNavigation)?.exportContinuation,
  );
  const storedContinuation =
    liveContinuation &&
    JSON.stringify(liveContinuation.mediaKeys) ===
      JSON.stringify(requestedContinuation?.mediaKeys)
      ? liveContinuation
      : requestedContinuation;
  if (!storedContinuation) return Promise.resolve(false);
  if (noteExportContinuationResumePromise) {
    return noteExportContinuationResumePromise;
  }
  if (currentNotesMode !== storedContinuation.mode) {
    // Platform defaults and side-panel reconstruction must not rewrite the
    // user's persisted export mode. A real user mode change updates the live
    // continuation in handleNotesModeChange before any resume can run.
    currentNotesMode = storedContinuation.mode;
    setNotesModeButtons(currentNotesMode);
  }
  const normalized = storedContinuation;
  const storedAuthorizationIsActive =
    noteExportContinuationIsAuthorized(normalized);
  noteExportContinuationResumePromise = exportAllNotes(normalized.mediaKeys, {
    authorized:
      storedAuthorizationIsActive &&
      noteExportContinuationIsAuthorized(normalized),
    autoOpenMetadata: false,
    resumed: true,
    modeOverride: normalized.mode,
    continuation: normalized,
  })
    .then(() => true)
    .finally(() => {
      noteExportContinuationResumePromise = null;
    });
  return noteExportContinuationResumePromise;
}

function hideNoteExportMenu() {
  const menu = document.getElementById("notesExportMenu");
  const btn = document.getElementById("notesExportBtn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function setNoteExportStatus(message = "", isError = false) {
  const el = document.getElementById("notesExportStatus");
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
  el.classList.toggle("is-error", !!isError);
}

function setTranscriptExportStatus(message = "", isError = false) {
  const el = document.getElementById("transcriptExportStatus");
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
  el.classList.toggle("is-error", !!isError);
}

function exportCancelledError() {
  const error = new Error("已取消补译；不会再启动后续请求批次。");
  error.code = "EXPORT_TRANSLATION_CANCELLED";
  return error;
}

function abandonActiveExportTranslation() {
  const jobId = activeExportJobId;
  activeExportJobId = "";
  exportTranslationGeneration += 1;
  if (jobId) {
    chrome.runtime
      .sendMessage({ action: "cancelExportTranslationJob", jobId })
      .catch(() => {});
  }
}

function renderExportTranslationProgress(panel, message, generation, setStatus) {
  if (!panel) return;
  panel.innerHTML = "";
  const summary = document.createElement("p");
  summary.className = "notes-export-precheck-text";
  summary.textContent = message;
  panel.appendChild(summary);
  const actions = document.createElement("div");
  actions.className = "notes-export-precheck-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "enhance-btn";
  cancel.textContent = "取消后续批次";
  cancel.addEventListener("click", () => {
    if (generation !== exportTranslationGeneration) return;
    const jobId = activeExportJobId;
    revokeNoteExportAuthorization();
    exportTranslationGeneration += 1;
    cancel.disabled = true;
    summary.textContent = "正在停止；已经发送的当前批次可能仍会完成，但不会继续后续批次。";
    setStatus("正在取消补译…");
    if (jobId) {
      chrome.runtime
        .sendMessage({ action: "cancelExportTranslationJob", jobId })
        .catch(() => {});
    }
  });
  actions.appendChild(cancel);
  panel.appendChild(actions);
  panel.hidden = false;
}

function updateCurrentExportTranslations(source) {
  applyPersistedSourceToCurrentVideo(source);
}

function exportNoteUnitKey(note) {
  return `note:${YTD_NOTE_SOURCES.hashSourceText(String(note?.id || ""))}:${YTD_NOTE_SOURCES.hashSourceText(note?.text || note?.rawText || "")}`;
}

function exportTitleUnitKey(title) {
  return `title:${YTD_NOTE_SOURCES.hashSourceText(title?.mediaKey || "")}:${YTD_NOTE_SOURCES.hashSourceText(title?.title || "")}`;
}

function exportPlanUnitKeys(plan) {
  return [
    ...(plan?.noteBatches || []).flat().map(exportNoteUnitKey),
    ...(plan?.titleBatches || []).flat().map(exportTitleUnitKey),
    ...(plan?.sourceBatches || []).flat().map((unit) => unit.id),
  ];
}

function exportPlanSourceRevisions(sourcesByKey, mediaKeys) {
  const revisions = {};
  (mediaKeys || []).forEach((mediaKey) => {
    const source = YTD_NOTE_SOURCES.normalizeNoteSource(sourcesByKey?.[mediaKey]);
    if (source?.sourceRevision) revisions[mediaKey] = source.sourceRevision;
  });
  return revisions;
}

function exportNotesRevision(groups) {
  const originals = (groups || [])
    .flatMap((group) => group.notes || [])
    .map((note) => [
      String(note?.id || ""),
      String(note?.mediaKey || note?.videoId || ""),
      noteOriginalText(note),
      noteOriginalVideoTitle(note),
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return YTD_NOTE_SOURCES.hashSourceText(JSON.stringify(originals));
}

function exportProviderSnapshot(config) {
  const provider = config?.provider || {};
  return {
    providerId: provider.id || "",
    modelId: provider.modelId || "",
    routeKey: provider.routeKey || "",
    targetLanguage: "zh",
    translationVersion: "export-v2",
  };
}

function buildFrozenExportIntent({
  scope,
  mediaKeys,
  mode,
  format,
  sourceRevisions,
  notesRevision,
  providerSnapshot,
}) {
  const canonicalSourceRevisions = Object.fromEntries(
    Object.entries(sourceRevisions || {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const contractHash = YTD_NOTE_SOURCES.hashSourceText(
    JSON.stringify({
      sourceRevisions: canonicalSourceRevisions,
      notesRevision,
      providerSnapshot,
    }),
  );
  return {
    scope: `${scope}-v${EXPORT_CONTENT_CONTRACT_VERSION}-${contractHash.replace(/[^A-Za-z0-9_-]/g, "-")}`,
    mediaKeys,
    mode,
    format,
    autoExport: true,
  };
}

function exportJobCursor(job, additionalCompleted = []) {
  const completed = new Set([
    ...(job?.completedUnitKeys || []),
    ...additionalCompleted,
  ]);
  const ordered = job?.orderedUnitKeys || [];
  let cursor = 0;
  while (cursor < ordered.length && completed.has(ordered[cursor])) cursor += 1;
  return cursor;
}

function exportRunOwner(scope, mode, generation) {
  return {
    scope,
    mode,
    generation,
    videoId: currentVideoId || "",
    routeKey: currentRouteKey || "",
    digestGeneration,
  };
}

function exportRunIsCurrent(owner) {
  if (
    !owner ||
    owner.generation !== exportTranslationGeneration ||
    owner.videoId !== (currentVideoId || "") ||
    owner.routeKey !== (currentRouteKey || "") ||
    owner.digestGeneration !== digestGeneration
  ) {
    return false;
  }
  return owner.scope === "transcript-current"
    ? transcriptExportMode() === owner.mode
    : currentNotesMode === owner.mode;
}

function assertExportRunCurrent(owner) {
  if (!exportRunIsCurrent(owner)) throw exportCancelledError();
}

function exportJobError(result, fallback) {
  const error = new Error(result?.message || result?.error || fallback);
  error.code = result?.code || "EXPORT_JOB_FAILED";
  return error;
}

async function readExportJobFromBackground(jobId, { allowMissing = false } = {}) {
  const result = await chrome.runtime.sendMessage({ action: "getExportJob", jobId });
  if (result?.success && result.job) return result.job;
  if (allowMissing && result?.code === "EXPORT_JOB_NOT_FOUND") return null;
  throw exportJobError(result, "无法读取补译进度。");
}

async function checkpointExportJobInBackground(jobId, patch) {
  const result = await chrome.runtime.sendMessage({
    action: "checkpointExportJob",
    jobId,
    patch,
  });
  if (!result?.success || !result.job) {
    throw exportJobError(result, "无法保存补译进度。");
  }
  return result.job;
}

function assertFrozenExportOutcome(outcome, { mediaKeys, mode, format }) {
  assertExportRunCurrent(outcome?.owner);
  const frozen = outcome?.intent;
  const expectedKeys = [...(mediaKeys || [])].sort();
  if (
    !frozen ||
    frozen.mode !== mode ||
    frozen.format !== format ||
    JSON.stringify([...(frozen.mediaKeys || [])].sort()) !==
      JSON.stringify(expectedKeys)
  ) {
    const error = new Error("导出范围在补译期间发生变化，请重新确认。");
    error.code = "EXPORT_JOB_FROZEN_MISMATCH";
    throw error;
  }
}

function assertFrozenExportMaterial(outcome, groups, sourcesByKey) {
  if (exportNotesRevision(groups) !== outcome?.notesRevision) {
    const error = new Error("笔记内容在补译期间发生变化，请重新确认。");
    error.code = "EXPORT_JOB_NOTES_REVISION_MISMATCH";
    throw error;
  }
  for (const [mediaKey, expectedRevision] of Object.entries(
    outcome?.sourceRevisions || {},
  )) {
    const source = YTD_NOTE_SOURCES.normalizeNoteSource(sourcesByKey?.[mediaKey]);
    if (!source || source.sourceRevision !== expectedRevision) {
      const error = new Error("视频资料在补译期间发生变化，请重新确认。");
      error.code = "EXPORT_JOB_SOURCE_REVISION_MISMATCH";
      throw error;
    }
  }
}

async function finalizeExportJobDownload(outcome, download) {
  assertExportRunCurrent(outcome?.owner);
  const claim = {
    claimId: `claim-${Date.now()}-${outcome.owner.generation}`,
    ownerId: "sidepanel",
    generation: outcome.owner.generation,
    claimedAt: Date.now(),
  };
  let claimed = false;
  try {
    await checkpointExportJobInBackground(outcome.jobId, {
      state: "ready_to_export",
      exportClaim: claim,
      lastError: null,
    });
    claimed = true;
    assertExportRunCurrent(outcome.owner);
    download();
    await checkpointExportJobInBackground(outcome.jobId, {
      state: "completed",
      exportClaim: null,
      lastError: null,
    });
    activeExportJobId = "";
    return true;
  } catch (error) {
    if (claimed) {
      await checkpointExportJobInBackground(outcome.jobId, {
        state: "failed",
        exportClaim: null,
        lastError: {
          code: error?.code || "EXPORT_FINALIZE_FAILED",
          retryable: true,
          at: Date.now(),
        },
      }).catch(() => null);
    }
    throw error;
  }
}

function sourceBatchMessage(jobId, units) {
  const first = units[0] || {};
  return {
    action: "translateExportSourceBatch",
    jobId,
    mediaKey: first.mediaKey,
    sourceRevision: first.sourceRevision,
    units: units.map((unit) => ({
      unitKey: unit.id,
      kind: unit.kind,
      sourceHash: unit.sourceHash,
      text: unit.text,
      ...(unit.kind === "description"
        ? { chunkIndex: unit.chunkIndex }
        : {
            segmentId: unit.segmentId,
            start: unit.start,
          }),
    })),
  };
}

function sameProviderSnapshot(left, right) {
  return [
    "providerId",
    "modelId",
    "routeKey",
    "targetLanguage",
    "translationVersion",
  ].every((field) => String(left?.[field] || "") === String(right?.[field] || ""));
}

async function assertExportProviderStillCurrent(providerSnapshot) {
  const config = await chrome.runtime.sendMessage({ action: "checkConfig" });
  currentConfigStatus = config;
  if (!config?.hasAiKey) {
    throw new Error("尚未配置当前 AI 服务商的 API 密钥，请先打开设置。");
  }
  const current = exportProviderSnapshot(config);
  if (!sameProviderSnapshot(current, providerSnapshot)) {
    const error = new Error("AI 服务商或模型已发生变化，请重新确认后继续补译。");
    error.code = "EXPORT_JOB_PROVIDER_MISMATCH";
    throw error;
  }
}

async function createOrResumeExportJobForRound({
  intent,
  plan,
  sourcesByKey,
  groups,
  providerSnapshot,
}) {
  let activeIntent = intent;
  let jobId = YTD_EXPORT_JOBS.jobIdForIntent(activeIntent);
  let existing = await readExportJobFromBackground(jobId, {
    allowMissing: true,
  });
  const missingKeys = new Set(exportPlanUnitKeys(plan));

  // A completed/stale job with the same immutable originals but fresh gaps is
  // an exceptional recovery case (for example, storage was restored). Give it
  // a new frozen identity instead of mutating terminal job history.
  if (
    existing &&
    ["ready_to_export", "completed", "stale"].includes(existing.state) &&
    missingKeys.size
  ) {
    const retryScope = String(intent.scope || "").startsWith("notes-")
      ? "notes-retry"
      : "transcript-retry";
    activeIntent = {
      ...intent,
      scope: `${retryScope}-${YTD_NOTE_SOURCES.hashSourceText(
        `${intent.scope}\u0000${[...missingKeys].join("\u0001")}`,
      )}`,
    };
    jobId = YTD_EXPORT_JOBS.jobIdForIntent(activeIntent);
    existing = await readExportJobFromBackground(jobId, { allowMissing: true });
  }

  let candidate;
  if (existing) {
    const completed = new Set(existing.completedUnitKeys || []);
    existing.orderedUnitKeys.forEach((key) => {
      if (!missingKeys.has(key)) completed.add(key);
    });
    const completedUnitKeys = existing.orderedUnitKeys.filter((key) =>
      completed.has(key),
    );
    candidate = {
      ...existing,
      state: "running",
      completedUnitKeys,
      currentBatch: null,
      cursor: exportJobCursor(existing, completedUnitKeys),
      exportClaim: null,
      lastError: null,
    };
  } else {
    const orderedUnitKeys = exportPlanUnitKeys(plan);
    candidate = YTD_EXPORT_JOBS.createExportJob({
      state: "running",
      intent: activeIntent,
      sourceRevisions: exportPlanSourceRevisions(
        sourcesByKey,
        activeIntent.mediaKeys,
      ),
      notesRevision: exportNotesRevision(groups),
      orderedUnitKeys,
      completedUnitKeys: [],
      currentBatch: null,
      cursor: 0,
      roundBudget: { maxBatches: 20 },
      providerSnapshot,
      exportClaim: null,
      lastError: null,
    });
  }
  const result = await chrome.runtime.sendMessage({
    action: "createOrResumeExportJob",
    job: candidate,
  });
  if (!result?.success || !result.job) {
    throw exportJobError(result, "无法创建或恢复补译任务。");
  }
  if (result.job.state !== "running") {
    return checkpointExportJobInBackground(result.job.jobId, {
      state: "running",
      completedUnitKeys: candidate.completedUnitKeys,
      currentBatch: null,
      cursor: exportJobCursor(result.job, candidate.completedUnitKeys),
      exportClaim: null,
      lastError: null,
    });
  }
  return result.job;
}

/**
 * Runs exactly one user-confirmed export-translation round. Every source batch
 * is translated + committed by the service worker, while note/title progress
 * is checkpointed immediately after its own background persistence succeeds.
 */
async function runConfirmedExportTranslationRound({
  plan,
  sourcesByKey,
  groups = [],
  scope,
  mode,
  format,
  panelId,
  setStatus,
  expectedProviderSnapshot = null,
  noteAuthorization = null,
}) {
  if (isExportTranslationRunning) {
    throw new Error("已有一个补译任务正在进行，请稍候。");
  }
  if (!plan || plan.overLimit) {
    throw new Error(
      `本次补译范围过大：${plan?.limitReasons?.join("、") || "超出安全上限"}。请缩小导出范围后重试。`,
    );
  }

  const invocation = {
    videoId: currentVideoId || "",
    routeKey: currentRouteKey || "",
    digestGeneration,
    mode,
  };
  const config = await chrome.runtime.sendMessage({ action: "checkConfig" });
  assertNoteExportAuthorizationCurrent(noteAuthorization);
  const modeStillCurrent =
    scope === "transcript-current"
      ? transcriptExportMode() === invocation.mode
      : currentNotesMode === invocation.mode;
  if (
    invocation.videoId !== (currentVideoId || "") ||
    invocation.routeKey !== (currentRouteKey || "") ||
    invocation.digestGeneration !== digestGeneration ||
    !modeStillCurrent
  ) {
    throw exportCancelledError();
  }
  currentConfigStatus = config;
  if (!config?.hasAiKey) {
    throw new Error("尚未配置当前 AI 服务商的 API 密钥，请先打开设置。");
  }
  if (!config?.provider?.capabilities?.includes("translate")) {
    throw new Error(`${config?.provider?.displayName || "当前服务商"}不支持翻译。`);
  }

  const generation = ++exportTranslationGeneration;
  const owner = exportRunOwner(scope, mode, generation);
  const providerSnapshot = exportProviderSnapshot(config);
  if (
    expectedProviderSnapshot &&
    !sameProviderSnapshot(providerSnapshot, expectedProviderSnapshot)
  ) {
    const error = new Error(
      "AI 服务商或模型已发生变化，请重新确认后继续补译。",
    );
    error.code = "EXPORT_JOB_PROVIDER_MISMATCH";
    throw error;
  }
  if (
    !providerSnapshot.providerId ||
    !providerSnapshot.modelId ||
    !providerSnapshot.routeKey
  ) {
    throw new Error("当前 AI 服务商配置不完整，请重新保存设置后重试。");
  }
  const mediaKeys = (groups || []).map((group) => group.mediaKey);
  const sourceRevisions = exportPlanSourceRevisions(sourcesByKey, mediaKeys);
  const notesRevision = exportNotesRevision(groups);
  const intent = buildFrozenExportIntent({
    scope,
    mediaKeys,
    mode,
    format,
    sourceRevisions,
    notesRevision,
    providerSnapshot,
  });
  const panel = document.getElementById(panelId);
  isExportTranslationRunning = true;
  const round = YTD_NOTE_SOURCES.takeExportTranslationRound(plan);
  const total = Math.max(1, round.estimatedBatches);
  let completedBatches = 0;
  let job = null;
  const showProgress = (label) => {
    renderExportTranslationProgress(
      panel,
      `${label}（本轮 ${completedBatches}/${total} 批）`,
      generation,
      setStatus,
    );
    setStatus(`${label}（本轮 ${completedBatches}/${total} 批）`);
  };

  try {
    assertExportRunCurrent(owner);
    job = await createOrResumeExportJobForRound({
      intent,
      plan,
      sourcesByKey,
      groups,
      providerSnapshot,
    });
    assertNoteExportAuthorizationCurrent(noteAuthorization);
    const previousJobId = activeExportJobId;
    activeExportJobId = job.jobId;
    // Navigation may have happened while the background created the durable
    // job, before the side panel knew its id. Bind first, then validate, so the
    // cancellation path below can never leave that job running.
    assertExportRunCurrent(owner);
    if (previousJobId && previousJobId !== job.jobId) {
      await chrome.runtime
        .sendMessage({
          action: "cancelExportTranslationJob",
          jobId: previousJobId,
        })
        .catch(() => null);
    }
    showProgress("准备补译");
    for (const notes of round.noteBatches) {
      assertExportRunCurrent(owner);
      await assertExportProviderStillCurrent(providerSnapshot);
      const result = await sendTranslationMessage({
        action: "translateExportNotesBatch",
        jobId: job.jobId,
        unitKeys: notes.map(exportNoteUnitKey),
        notes,
        titles: [],
      });
      assertExportRunCurrent(owner);
      const translatedIds = new Set(
        (result?.translations || [])
          .filter((entry) => String(entry?.textZh || "").trim())
          .map((entry) => String(entry.id || "")),
      );
      const completedUnitKeys = notes
        .filter((note) => translatedIds.has(String(note.id || "")))
        .map(exportNoteUnitKey);
      if (completedUnitKeys.length) {
        job = await checkpointExportJobInBackground(job.jobId, {
          completedUnitKeys,
          cursor: exportJobCursor(job, completedUnitKeys),
          lastError: null,
        });
      }
      if (completedUnitKeys.length !== notes.length) {
        throw new Error(result?.error || "笔记补译失败。");
      }
      completedBatches += 1;
      showProgress("正在生成中文笔记");
    }

    for (const titles of round.titleBatches) {
      assertExportRunCurrent(owner);
      await assertExportProviderStillCurrent(providerSnapshot);
      const result = await sendTranslationMessage({
        action: "translateExportNotesBatch",
        jobId: job.jobId,
        unitKeys: titles.map(exportTitleUnitKey),
        notes: [],
        titles,
      });
      assertExportRunCurrent(owner);
      const translatedKeys = new Set(
        (result?.titles || [])
          .filter((entry) => String(entry?.titleZh || "").trim())
          .map((entry) => String(entry.mediaKey || "")),
      );
      const completedUnitKeys = titles
        .filter((title) => translatedKeys.has(String(title.mediaKey || "")))
        .map(exportTitleUnitKey);
      if (completedUnitKeys.length) {
        job = await checkpointExportJobInBackground(job.jobId, {
          completedUnitKeys,
          cursor: exportJobCursor(job, completedUnitKeys),
          lastError: null,
        });
      }
      if (completedUnitKeys.length !== titles.length) {
        throw new Error(result?.error || "标题补译失败。");
      }
      completedBatches += 1;
      showProgress("正在生成中文标题");
    }

    for (const units of round.sourceBatches) {
      assertExportRunCurrent(owner);
      const result = await sendTranslationMessage(
        sourceBatchMessage(job.jobId, units),
      );
      assertExportRunCurrent(owner);
      if (!result?.success) {
        throw exportJobError(result, "字幕或简介补译失败。");
      }
      if (result.jobState === "cancelled") {
        throw exportCancelledError();
      }
      job = await readExportJobFromBackground(job.jobId);
      const storedSource = await YTD_NOTE_SOURCES.readNoteSource(
        chrome.storage.local,
        units[0].mediaKey,
      );
      assertExportRunCurrent(owner);
      if (storedSource) updateCurrentExportTranslations(storedSource);
      completedBatches += 1;
      showProgress("正在生成中文简介与字幕");
    }

    assertExportRunCurrent(owner);
    job = await readExportJobFromBackground(job.jobId);
    const remainingCount = Math.max(
      0,
      job.orderedUnitKeys.length - job.completedUnitKeys.length,
    );
    job = await checkpointExportJobInBackground(job.jobId, {
      // Final file assembly owns the ready/claim/completed transition. Keep a
      // fully translated job paused until latest storage has been revalidated.
      state: "paused",
      currentBatch: null,
      cursor: exportJobCursor(job),
      lastError: null,
    });
    assertExportRunCurrent(owner);
    if (panel) panel.hidden = true;
    if (remainingCount) {
      setStatus(`本轮已保存，仍有 ${remainingCount} 个翻译单元；请继续补齐。`);
    } else {
      setStatus("补译完成，正在生成文件…");
    }
    return {
      complete: remainingCount === 0,
      remainingCount,
      owner,
      jobId: job.jobId,
      intent: job.intent,
      sourceRevisions: job.sourceRevisions,
      notesRevision: job.notesRevision,
    };
  } catch (error) {
    if (job?.jobId && exportFlowWasCancelled(error)) {
      await chrome.runtime
        .sendMessage({
          action: "cancelExportTranslationJob",
          jobId: job.jobId,
        })
        .catch(() => null);
    }
    if (job?.jobId && !exportFlowWasCancelled(error)) {
      try {
        const latest = await readExportJobFromBackground(job.jobId);
        if (["planned", "running", "paused", "failed"].includes(latest.state)) {
          await checkpointExportJobInBackground(job.jobId, {
            state:
              error?.code === "EXPORT_JOB_PROVIDER_MISMATCH"
                ? "paused"
                : "failed",
            currentBatch: null,
            lastError: {
              code: error?.code || "EXPORT_TRANSLATION_FAILED",
              retryable: true,
              at: Date.now(),
            },
          });
        }
      } catch (_checkpointError) {
        // Preserve the original provider/validation error for the user.
      }
    }
    throw error;
  } finally {
    isExportTranslationRunning = false;
  }
}

/** Renders the export precheck; AI work is offered only by explicit click. */
function showNoteExportPrecheck(
  precheck,
  onConfirm,
  onGenerate,
  plan,
  _onExportOriginal,
  onAbandon = null,
) {
  const panel = document.getElementById("notesExportPrecheck");
  if (!panel) {
    if (!precheck.hasTranslationGaps) onConfirm();
    return;
  }
  panel.innerHTML = "";
  const summary = document.createElement("p");
  summary.className = "notes-export-precheck-text";
  summary.tabIndex = -1;
  const progress = exportTranslationProgressText(plan);
  const planSummary = precheck.hasTranslationGaps
    ? plan?.overLimit
      ? `\n本次补译未启动：${plan.limitReasons.join("、")}。`
      : `\n当前已完成 ${progress.completed}/${progress.total} 个翻译单元，剩余约 ${progress.remainingBatches} 批；每次确认最多继续 ${progress.roundMax} 批。`
    : "";
  const providerDisclosure = precheck.hasTranslationGaps
    ? `\n完整导出将使用${currentConfigStatus?.provider?.displayName || "当前 AI 服务"}；本轮最多 20 批，可取消。`
    : "";
  summary.textContent = `${describeExportPrecheck(precheck)}${planSummary}${providerDisclosure}`;
  panel.appendChild(summary);

  const actions = document.createElement("div");
  actions.className = "notes-export-precheck-actions";
  const completeBtn = document.createElement("button");
  completeBtn.type = "button";
  completeBtn.className = "enhance-btn active";
  completeBtn.textContent = progress.completed > 0 ? "继续完整导出" : "完整导出";
  completeBtn.disabled =
    !onGenerate || (!precheck.hasBlocking && !!plan?.overLimit);
  completeBtn.addEventListener("click", () => {
    if (!completeBtn.disabled) void onGenerate();
  });

  const directBtn = document.createElement("button");
  directBtn.type = "button";
  directBtn.className = "enhance-btn";
  directBtn.textContent = "直接导出";
  directBtn.addEventListener("click", () => {
    panel.hidden = true;
    void clearNoteExportContinuation();
    onConfirm();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "enhance-btn notes-export-cancel";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => {
    panel.hidden = true;
    void clearNoteExportContinuation();
    abandonActiveExportTranslation();
    if (onAbandon) onAbandon();
    else setNoteExportStatus("已取消导出。");
  });
  actions.append(cancelBtn, directBtn, completeBtn);
  panel.appendChild(actions);
  panel.hidden = false;
  summary.focus?.();
}

function showNoteExportMetadataWorkspace(
  precheck,
  groups,
  continuation,
  { autoOpenMetadata = false, onDirect = null } = {},
) {
  const panel = document.getElementById("notesExportPrecheck");
  if (!panel) return;
  panel.innerHTML = "";

  const summary = document.createElement("p");
  summary.className = "notes-export-precheck-text";
  summary.tabIndex = -1;
  summary.textContent = `${precheck.blockingVideos.length} 个视频需要补充页面资料。DigestDock 会逐个打开，只读取标题、频道、网址和完整简介；不会获取字幕、调用 Supadata 或 AI。`;
  panel.appendChild(summary);

  const groupByKey = new Map(
    (groups || []).map((group) => [String(group.mediaKey || ""), group]),
  );
  const list = document.createElement("div");
  list.className = "notes-export-supplement-list";
  (precheck.blockingVideos || []).forEach((video) => {
    const group = groupByKey.get(String(video.mediaKey || ""));
    const representative = group?.representative || group?.notes?.[0];
    const row = document.createElement("div");
    row.className = "notes-export-supplement-row";
    const copy = document.createElement("div");
    copy.className = "notes-export-supplement-copy";
    const title = document.createElement("strong");
    title.textContent = video.title || "未命名视频";
    const reasons = document.createElement("span");
    reasons.textContent = (video.blockingReasons || []).join("、");
    copy.append(title, reasons);
    const state = document.createElement("span");
    state.className = "notes-export-picker-option-status is-metadata";
    state.textContent = "待补充";
    row.append(copy, state);
    list.appendChild(row);
  });
  panel.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "notes-export-precheck-actions";
  const firstVideo = precheck.blockingVideos[0] || null;
  const firstGroup = firstVideo
    ? groupByKey.get(String(firstVideo.mediaKey || ""))
    : null;
  const representative = firstGroup?.representative || firstGroup?.notes?.[0];
  const openNext = document.createElement("button");
  openNext.type = "button";
  openNext.className = "enhance-btn active";
  openNext.textContent =
    precheck.blockingVideos.length > 1
      ? `打开下一个（还剩 ${precheck.blockingVideos.length} 个）`
      : "打开并补齐";
  openNext.disabled = !representative || !noteCanonicalUrl(representative);
  const runOpenNext = async () => {
    if (openNext.disabled) return;
    openNext.disabled = true;
    openNext.textContent = "正在打开…";
    setNoteExportStatus(`正在打开《${firstVideo?.title || "视频"}》补充资料…`);
    try {
      const opened = await playNote(representative, {
        captureMetadata: true,
        exportContinuation: continuation,
      });
      if (!opened) {
        const statusElement = document.getElementById("notesExportStatus");
        const existingMessage = String(
          statusElement?.textContent || "",
        ).trim();
        throw new Error(
          statusElement?.classList?.contains("is-error") && existingMessage
            ? existingMessage
            : "页面资料尚未就绪，请重试当前视频。",
        );
      }
    } catch (error) {
      openNext.disabled = false;
      openNext.textContent = "重试当前视频";
      setNoteExportStatus(error?.message || "无法打开视频，请重试。", true);
    }
  };
  openNext.addEventListener("click", () => void runOpenNext());

  const direct = document.createElement("button");
  direct.type = "button";
  direct.className = "enhance-btn";
  direct.textContent = "直接导出";
  direct.disabled = typeof onDirect !== "function";
  direct.addEventListener("click", () => {
    if (!direct.disabled) {
      void clearNoteExportContinuation();
      void onDirect();
    }
  });

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "enhance-btn notes-export-cancel";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    panel.hidden = true;
    abandonActiveExportTranslation();
    void clearNoteExportContinuation();
    setNoteExportStatus("已取消导出。");
  });
  actions.append(cancel, direct, openNext);
  panel.appendChild(actions);
  panel.hidden = false;
  summary.focus?.();
  if (autoOpenMetadata && !openNext.disabled) void runOpenNext();
}

async function exportCurrentVideoNotes() {
  const selectedMediaKey = currentVideoId || currentMediaRef?.mediaKey || "";
  if (!selectedMediaKey) {
    setNoteExportStatus("请先打开一个视频。", true);
    return;
  }
  await exportAllNotes([selectedMediaKey]);
}

async function exportAllNotes(mediaKeys = null, options = {}) {
  const direct = options?.direct === true;
  let authorized = options?.authorized === true;
  const grantAuthorization = options?.grantAuthorization === true;
  const autoOpenMetadata = options?.autoOpenMetadata === true;
  hideNoteExportMenu();
  if (direct) {
    revokeNoteExportAuthorization();
    abandonActiveExportTranslation();
  }
  const frozenMediaKeys = normalizeExportMediaKeys(mediaKeys);
  if (frozenMediaKeys && !frozenMediaKeys.length) {
    setNoteExportStatus("请至少选择一个视频。", true);
    return;
  }
  const mode = ["original", "zh", "bilingual"].includes(options?.modeOverride)
    ? options.modeOverride
    : currentNotesMode;
  const existingContinuation = normalizeNoteExportContinuation(
    options?.continuation,
  );
  const continuation =
    existingContinuation ||
    createNoteExportContinuation(frozenMediaKeys);
  closeNoteExportPicker();
  setNoteExportStatus("");
  try {
    await persistCurrentVideoNoteSourceIfNoted();
    const { groups, sourcesByKey } = await collectAllNotesExport(frozenMediaKeys);
    if (!groups.length) {
      setNoteExportStatus("还没有保存任何笔记。", true);
      return;
    }
    const precheck = buildNotesExportPrecheck(groups, sourcesByKey, mode);
    const translationPlan = buildNotesExportTranslationPlan(
      groups,
      sourcesByKey,
      mode,
    );
    let requiresFreshConfirmation = options?.resumed === true && !authorized;
    if (authorized) {
      authorized = await validateNoteExportAuthorization(continuation, {
        groups,
        sourcesByKey,
        precheck,
      });
      requiresFreshConfirmation = !authorized;
    }
    if (grantAuthorization) {
      const granted = await grantNoteExportAuthorization(continuation, {
        groups,
        sourcesByKey,
        precheck,
      });
      if (!granted) return;
      authorized = true;
      requiresFreshConfirmation = false;
    }
    const isSelectedScope = frozenMediaKeys !== null;
    const downloadSources = (sources, exportMode) => {
      if (isSelectedScope && sources.length === 1) {
        const source = sources[0];
        downloadTextFile(
          YTD_NOTE_EXPORT.buildCurrentVideoText(source, exportMode),
          YTD_NOTE_EXPORT.currentVideoNotesFilename(
            source.titleOriginal || "video-notes",
            exportMode,
          ),
          "text/plain;charset=utf-8",
        );
        return;
      }
      downloadTextFile(
        YTD_NOTE_EXPORT.buildAllNotesText(sources, exportMode),
        YTD_NOTE_EXPORT.allNotesFilename(exportMode),
        "text/plain;charset=utf-8",
      );
    };
    const exportWithMode = (exportMode) => {
      const sources = groups.map((group) =>
        exportSourceForGroup(group, sourcesByKey[group.mediaKey]),
      );
      downloadSources(sources, exportMode);
      setNoteExportStatus(
        `已导出${isSelectedScope ? "所选" : "全部"}${exportMode === "original" ? "原文" : ""}笔记（${groups.length} 个视频）。`,
      );
      const panel = document.getElementById("notesExportPrecheck");
      if (panel) panel.hidden = true;
      void clearNoteExportContinuation();
    };
    const doExport = () => exportWithMode(mode);
    if (direct) {
      doExport();
      return;
    }
    if (
      !requiresFreshConfirmation &&
      !precheck.hasBlocking &&
      !precheck.hasTranslationGaps
    ) {
      doExport();
      return;
    }

    const showMetadataWorkspace = (
      activeContinuation,
      shouldAutoOpen = false,
    ) => {
      showNoteExportMetadataWorkspace(
        precheck,
        groups,
        activeContinuation,
        {
          autoOpenMetadata: shouldAutoOpen,
          onDirect: () =>
            exportAllNotes(frozenMediaKeys, {
              direct: true,
              modeOverride: mode,
            }),
        },
      );
    };

    const generateAndExport = async (activeContinuation) => {
        try {
          const noteAuthorization = activeNoteExportAuthorization;
          if (
            !noteAuthorization ||
            !noteExportContinuationIsAuthorized(activeContinuation)
          ) {
            await exportAllNotes(frozenMediaKeys, {
              authorized: false,
              autoOpenMetadata: false,
              resumed: true,
              modeOverride: mode,
              continuation: activeContinuation,
            });
            return;
          }
          const outcome = await runConfirmedExportTranslationRound({
            plan: translationPlan,
            sourcesByKey,
            groups,
            scope: frozenMediaKeys ? "notes-selected" : "notes-all",
            mode,
            format: "txt",
            panelId: "notesExportPrecheck",
            setStatus: setNoteExportStatus,
            expectedProviderSnapshot: noteAuthorization.providerSnapshot,
            noteAuthorization,
          });
          if (!exportRunIsCurrent(outcome.owner)) throw exportCancelledError();
          if (!outcome.complete) {
            revokeNoteExportAuthorization();
            await exportAllNotes(frozenMediaKeys, {
              authorized: false,
              autoOpenMetadata: false,
              resumed: true,
              modeOverride: mode,
              continuation: activeContinuation,
            });
            return;
          }
          const latest = await collectAllNotesExport(frozenMediaKeys);
          assertFrozenExportOutcome(outcome, {
            mediaKeys:
              frozenMediaKeys || latest.groups.map((candidate) => candidate.mediaKey),
            mode,
            format: "txt",
          });
          assertFrozenExportMaterial(
            outcome,
            latest.groups,
            latest.sourcesByKey,
          );
          const finalPrecheck = buildNotesExportPrecheck(
            latest.groups,
            latest.sourcesByKey,
            mode,
          );
          const finalPlan = buildNotesExportTranslationPlan(
            latest.groups,
            latest.sourcesByKey,
            mode,
          );
          if (finalPlan.unitCount || finalPrecheck.hasTranslationGaps) {
            throw new Error("补译尚未完整写入，请再次点击导出继续。");
          }
          if (finalPrecheck.hasBlocking) {
            showNoteExportMetadataWorkspace(
              finalPrecheck,
              latest.groups,
              activeContinuation,
              {
                autoOpenMetadata: false,
                onDirect: () =>
                  exportAllNotes(frozenMediaKeys, {
                    direct: true,
                    modeOverride: mode,
                  }),
              },
            );
            return;
          }
          const finalSources = latest.groups.map((candidate) =>
            exportSourceForGroup(
              candidate,
              latest.sourcesByKey[candidate.mediaKey],
            ),
          );
          await finalizeExportJobDownload(outcome, () => {
            assertExportRunCurrent(outcome.owner);
            downloadSources(finalSources, mode);
          });
          setNoteExportStatus(
            `已导出${isSelectedScope ? "所选" : "全部"}笔记（${latest.groups.length} 个视频）。`,
          );
          await clearNoteExportContinuation();
        } catch (error) {
          revokeNoteExportAuthorization();
          if (error?.code === "EXPORT_JOB_PROVIDER_MISMATCH") {
            await exportAllNotes(frozenMediaKeys, {
              authorized: false,
              autoOpenMetadata: false,
              resumed: true,
              modeOverride: mode,
              continuation: activeContinuation,
            });
            return;
          }
          const cancelled = exportFlowWasCancelled(error);
          setNoteExportStatus(
            error?.message || "补译失败，请重试。",
            !cancelled,
          );
        }
      };

    if (authorized) {
      if (precheck.hasBlocking) {
        showMetadataWorkspace(continuation, autoOpenMetadata);
      } else {
        await generateAndExport(continuation);
      }
      return;
    }

    const beginCompleteExport = async () => {
      try {
        const authorizedContinuation = await grantNoteExportAuthorization(
          continuation,
          { groups, sourcesByKey, precheck },
        );
        if (!authorizedContinuation) {
          return;
        }
        if (precheck.hasBlocking) {
          showMetadataWorkspace(authorizedContinuation, true);
          return;
        }
        if (!precheck.hasTranslationGaps) {
          doExport();
          return;
        }
        return generateAndExport(authorizedContinuation);
      } catch (error) {
        revokeNoteExportAuthorization();
        if (error?.code === "NOTE_EXPORT_AUTHORIZATION_CANCELLED") return;
        setNoteExportStatus(error?.message || "无法开始完整导出。", true);
      }
    };

      showNoteExportPrecheck(
        precheck,
        doExport,
        beginCompleteExport,
        translationPlan,
        null,
      );
  } catch (error) {
    if (error?.code === "NOTE_EXPORT_AUTHORIZATION_CANCELLED") return;
    console.error("[DigestDock] Export all notes error:", error);
    setNoteExportStatus("导出失败，请重试。", true);
  }
}

function toggleNoteExportMenu() {
  const menu = document.getElementById("notesExportMenu");
  const btn = document.getElementById("notesExportBtn");
  if (!menu || !btn) return;
  updateNoteExportMenuContext();
  const willShow = menu.hidden;
  menu.hidden = !willShow;
  btn.setAttribute("aria-expanded", willShow ? "true" : "false");
}

function updateNoteExportMenuContext(groupCount = null) {
  const current = document.getElementById("exportCurrentNotes");
  const select = document.getElementById("selectNotesForExport");
  const all = document.getElementById("exportAllNotes");
  if (current) current.hidden = notesFilterShowAll;
  if (select) select.hidden = !notesFilterShowAll;
  if (all) {
    all.hidden = !notesFilterShowAll;
    const count = Number.isInteger(groupCount)
      ? groupCount
      : sortNoteGroups(groupNotesBySource(currentNotes)).length;
    all.textContent = count > 0 ? `导出全部视频（${count}）` : "导出全部视频";
  }
}

function closeNoteExportPicker({ restoreFocus = false } = {}) {
  const picker = document.getElementById("notesExportPicker");
  if (picker) picker.hidden = true;
  document
    .getElementById("notesExportBtn")
    ?.setAttribute("aria-expanded", "false");
  selectedNoteExportMediaKeys = new Set();
  noteExportPickerGroups = [];
  noteExportPickerPrecheck = null;
  noteExportPickerSourcesByKey = {};
  if (restoreFocus) document.getElementById("notesExportBtn")?.focus();
}

function updateNoteExportPickerSelection() {
  const total = noteExportPickerGroups.length;
  const selected = selectedNoteExportMediaKeys.size;
  const count = document.getElementById("notesExportSelectionCount");
  const confirm = document.getElementById("confirmNotesExportSelection");
  const direct = document.getElementById("directNotesExportSelection");
  const disclosure = document.getElementById("notesExportPickerDisclosure");
  const selectAll = document.getElementById("notesExportSelectAll");
  if (count) count.textContent = `已选 ${selected}/${total}`;
  if (confirm) {
    confirm.disabled = selected === 0;
    confirm.textContent = `完整导出（${selected}）`;
  }
  if (direct) {
    direct.disabled = selected === 0;
    direct.textContent = `直接导出（${selected}）`;
  }
  if (selectAll) {
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
  }
  if (disclosure) {
    if (!selected) {
      disclosure.textContent = "选择视频后将显示导出准备情况。";
    } else {
      const selectedVideos = (noteExportPickerPrecheck?.videos || []).filter(
        (video) => selectedNoteExportMediaKeys.has(video.mediaKey),
      );
      const metadataCount = selectedVideos.filter((video) => video.blocking).length;
      const translationCount = selectedVideos.reduce(
        (sum, video) => sum + noteExportVideoTranslationGapCount(video),
        0,
      );
      const providerName =
        currentConfigStatus?.provider?.displayName || "当前 AI 服务";
      const parts = [
        `范围：${selected} 个视频；模式：${noteExportModeLabel()}。`,
        `页面资料：${metadataCount ? `${metadataCount} 个需访问原视频补充` : "无需访问原视频"}。`,
      ];
      if (currentNotesMode === "original") {
        parts.push("AI 补译：不使用。");
      } else {
        parts.push(
          `AI 补译：当前可识别 ${translationCount} 项，服务为${providerName}；补充页面资料后数量可能增加，单轮最多 20 批，可取消。`,
        );
      }
      if (!metadataCount && !translationCount) {
        parts.push("当前资料齐全，可立即下载。");
      }
      parts.push("直接导出不会补资料或补译，缺失处会明确标记。");
      disclosure.textContent = parts.join(" ");
    }
  }
}

function renderNoteExportPicker(
  groups,
  sourcesByKey = {},
  preselectedKeys = [],
) {
  const list = document.getElementById("notesExportPickerList");
  if (!list) return;
  list.innerHTML = "";
  noteExportPickerGroups = [...groups];
  noteExportPickerSourcesByKey = { ...sourcesByKey };
  noteExportPickerPrecheck = buildNotesExportPrecheck(
    groups,
    noteExportPickerSourcesByKey,
  );
  const preparationByKey = new Map(
    (noteExportPickerPrecheck.videos || []).map((video) => [
      video.mediaKey,
      noteExportVideoPreparation(video),
    ]),
  );
  const preselected = new Set(normalizeExportMediaKeys(preselectedKeys) || []);
  selectedNoteExportMediaKeys = new Set(
    groups
      .map((group) => group.mediaKey)
      .filter((mediaKey) => preselected.has(mediaKey)),
  );
  groups.forEach((group, index) => {
    const representative = group.representative || group.notes?.[0] || {};
    const label = document.createElement("label");
    label.className = "notes-export-picker-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = group.mediaKey;
    input.id = `notes-export-source-${index}`;
    input.checked = selectedNoteExportMediaKeys.has(group.mediaKey);
    input.addEventListener("change", () => {
      if (input.checked) selectedNoteExportMediaKeys.add(group.mediaKey);
      else selectedNoteExportMediaKeys.delete(group.mediaKey);
      updateNoteExportPickerSelection();
    });
    const copy = document.createElement("span");
    copy.className = "notes-export-picker-option-copy";
    const title = document.createElement("span");
    title.className = "notes-export-picker-option-title";
    title.textContent = noteVideoTitleForMode(representative).replace(/\n/g, " ");
    title.title = title.textContent;
    const meta = document.createElement("span");
    meta.className = "notes-export-picker-option-meta";
    meta.textContent = noteSourceMetaText(representative, group.notes.length);
    copy.append(title, meta);
    const preparation = preparationByKey.get(group.mediaKey) || {
      label: "需补资料",
      className: "is-metadata",
    };
    const status = document.createElement("span");
    status.className = `notes-export-picker-option-status ${preparation.className}`;
    status.textContent = preparation.label;
    status.title = preparation.label;
    label.append(input, copy, status);
    list.appendChild(label);
  });
  updateNoteExportPickerSelection();
}

function handleNoteExportSelectAll(event) {
  const shouldSelect = event.currentTarget.checked;
  selectedNoteExportMediaKeys = shouldSelect
    ? new Set(noteExportPickerGroups.map((group) => group.mediaKey))
    : new Set();
  document
    .getElementById("notesExportPickerList")
    ?.querySelectorAll('input[type="checkbox"]')
    .forEach((input) => {
      input.checked = shouldSelect;
    });
  updateNoteExportPickerSelection();
}

async function recoverNotesExportSelection() {
  const navigationContinuation = normalizeNoteExportContinuation(
    (activeNotesOnlyContext || pendingNoteNavigation)?.exportContinuation,
  );
  if (navigationContinuation?.mode === currentNotesMode) {
    return navigationContinuation.mediaKeys;
  }
  try {
    const result = await chrome.runtime.sendMessage({ action: "listExportJobs" });
    const recoverableStates = new Set(["planned", "running", "paused", "failed"]);
    const job = (result?.success && Array.isArray(result.jobs) ? result.jobs : []).find(
      (candidate) =>
        recoverableStates.has(candidate?.state) &&
        String(candidate?.intent?.scope || "").startsWith("notes-") &&
        candidate?.intent?.mode === currentNotesMode,
    );
    return normalizeExportMediaKeys(job?.intent?.mediaKeys) || [];
  } catch (_error) {
    return [];
  }
}

async function openNoteExportPicker({ selectAll = false } = {}) {
  hideNoteExportMenu();
  setNoteExportStatus("");
  try {
    if (currentNotesMode !== "original") {
      try {
        currentConfigStatus = await chrome.runtime.sendMessage({
          action: "checkConfig",
        });
      } catch (_error) {
        // The picker still works in direct-export mode when settings are
        // temporarily unavailable; the complete action rechecks before AI.
      }
    }
    await persistCurrentVideoNoteSourceIfNoted();
    const { groups, sourcesByKey } = await collectAllNotesExport();
    if (!groups.length) {
      setNoteExportStatus("还没有保存任何笔记。", true);
      return;
    }
    const recoveredSelection = selectAll
      ? groups.map((group) => group.mediaKey)
      : await recoverNotesExportSelection();
    renderNoteExportPicker(
      groups,
      sourcesByKey,
      recoveredSelection,
    );
    const picker = document.getElementById("notesExportPicker");
    if (picker) picker.hidden = false;
    document
      .getElementById("notesExportBtn")
      ?.setAttribute("aria-expanded", "true");
    document
      .getElementById("notesExportPickerList")
      ?.querySelector('input[type="checkbox"]')
      ?.focus();
  } catch (error) {
    console.error("[DigestDock] Open export picker error:", error);
    setNoteExportStatus("无法读取笔记，请重试。", true);
  }
}

/** Exports a single source container's notes (the per-video shortcut). */
async function exportSingleSourceGroup(group) {
  const selectedMediaKey = String(group?.mediaKey || "");
  if (!selectedMediaKey || !group?.notes?.length) return;
  await exportAllNotes([selectedMediaKey]);
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
    cancelFollowIdleResume({ clearHold: true });
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
  configureNotesReturnAction();
}

function showSupadataConsent(onConfirm, onDecline = null) {
  showError(
    "是否使用 Supadata 获取字幕？",
    "此视频将通过 Supadata 获取 YouTube 原生字幕。点击后会把此视频的标准 YouTube 链接发送给 Supadata，并可能消耗你的 API 额度。",
  );
  const primaryButton = document.getElementById("errorBtn");
  const secondaryButton = document.getElementById("errorSecondaryBtn");
  primaryButton.textContent = "本次使用 Supadata";
  if (secondaryButton) {
    secondaryButton.textContent = onDecline
      ? "返回笔记"
      : "不使用第三方服务";
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
    if (onDecline) return onDecline();
    showSupadataDeclined();
  };
  primaryButton.focus();
}

function showYoutubeCaptionsRequired(onRetry, onCancel = null) {
  showError(
    "请先打开 YouTube 字幕",
    "请点击视频播放器右下角的“字幕 / CC”按钮，等待字幕显示后再重新读取。",
  );
  const primaryButton = document.getElementById("errorBtn");
  const secondaryButton = document.getElementById("errorSecondaryBtn");
  primaryButton.textContent = "已打开字幕，重新读取";
  if (secondaryButton && onCancel) {
    secondaryButton.textContent = "返回笔记";
    secondaryButton.hidden = false;
  }
  errorAction = async () => {
    primaryButton.disabled = true;
    if (secondaryButton) secondaryButton.disabled = true;
    showState("loading");
    updateLoading(
      "正在重新读取字幕",
      "只读取 YouTube 页面已经加载的字幕…",
    );
    try {
      await onRetry();
    } catch (error) {
      showError(
        "仍未读取到字幕",
        error?.message || "请确认播放器中已经显示字幕，然后重试。",
      );
    }
  };
  errorSecondaryAction = onCancel ? () => onCancel() : null;
  primaryButton.focus();
}

// After the user declines the third-party request, stay in a safe no-transcript
// state. The default primary starts a fresh user-driven transcript task; it
// never sends a Supadata request without another explicit confirmation.
function showSupadataDeclined() {
  showError(
    "已跳过 Supadata 字幕",
    "没有向 Supadata 发送视频链接。此视频暂时没有可用字幕。如需字幕，可重新在侧栏本次授权 Supadata，或在设置中调整可选配置。",
  );
  const secondaryButton = document.getElementById("errorSecondaryBtn");
  if (secondaryButton) {
    secondaryButton.textContent = "管理 Supadata";
    secondaryButton.hidden = false;
  }
  errorSecondaryAction = openSupadataOptions;
}

function openSupadataOptions() {
  const relativeUrl = "options.html?focus=supadata#section-transcript";
  try {
    const url = chrome.runtime.getURL(relativeUrl);
    if (chrome.tabs?.create) return chrome.tabs.create({ url });
  } catch (_error) {
    // Fall back to the generic options action in restricted test/preview hosts.
  }
  return chrome.runtime.sendMessage({
    action: "openOptions",
    focus: "supadata",
  });
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
    "免费字幕未能取得",
    message ||
      "你可以选择配置 Supadata 作为第三方后备；每次调用都需重新确认，确认前不会发送请求。",
  );
  const primaryButton = document.getElementById("errorBtn");
  primaryButton.textContent = "了解并配置 Supadata";
  errorAction = openSupadataOptions;
}

function showSupadataInvalidKey(message) {
  showError(
    "Supadata 密钥无效",
    message || "请在设置中更新 Supadata API 密钥后重新授权。",
  );
  const primaryButton = document.getElementById("errorBtn");
  primaryButton.textContent = "管理 Supadata";
  errorAction = openSupadataOptions;
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
  showError(
    "AI 功能尚未配置",
    `字幕阅读、时间跳转和原文笔记仍可使用。如需概览、讲解、翻译或笔记润色，请在设置中添加 ${activeAiServiceLabel(configStatus)} API 密钥。`,
  );
  document.getElementById("errorBtn").textContent = "配置 AI 功能";
  errorAction = openAiSettings;
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

async function returnToNotesOnlyContext(context = activeNotesOnlyContext) {
  if (
    !context ||
    activeNotesOnlyContext?.token !== context.token ||
    !isActiveNotesOnlyContext()
  ) {
    return false;
  }

  try {
    const tab = await chrome.tabs.get(context.tabId);
    const locator = extractMediaLocator(tab?.pendingUrl || tab?.url || "");
    if (!noteNavigationMatches(context, tab, locator)) {
      await clearNoteNavigationState(context.token);
      return false;
    }
  } catch (error) {
    if (isTransientTabLookupError(error)) {
      await clearNoteNavigationState(context.token);
      return false;
    }
    throw error;
  }

  showState("results");
  switchTab("notes");
  await loadNotes(context.showAll ? null : context.mediaKey, {
    translateMissing: false,
  });
  return true;
}

function configureNotesReturnAction(context = activeNotesOnlyContext) {
  if (
    !context ||
    activeNotesOnlyContext?.token !== context.token ||
    !isActiveNotesOnlyContext()
  ) {
    return false;
  }
  const secondaryButton = document.getElementById("errorSecondaryBtn");
  if (!secondaryButton) return false;
  secondaryButton.textContent = "返回笔记";
  secondaryButton.disabled = false;
  secondaryButton.hidden = false;
  errorSecondaryAction = () => returnToNotesOnlyContext(context);
  return true;
}

function resumeDigestFromNotesOnly(tabName) {
  if (noteNavigationResumePromise) return noteNavigationResumePromise;
  const context = activeNotesOnlyContext;
  if (!context) return Promise.resolve();

  if (SIDEPANEL_MVP_AVAILABLE) {
    sidepanelMvpProgressOverride = {
      title: tabName === "overview" ? "正在准备概览" : "正在获取字幕",
      subtitle: "",
    };
    renderSidepanelMvpTranscriptState();
  } else {
    showState("loading");
    updateLoading(
      tabName === "overview" ? "正在准备概览" : "正在获取字幕",
      "",
    );
  }
  noteNavigationResumePromise = checkCurrentTab({
    resumeNoteNavigationToken: context.token,
  })
    .then(async () => {
      if (
        currentTranscript &&
        activeNotesOnlyContext?.token === context.token &&
        isActiveNotesOnlyContext()
      ) {
        await clearNoteNavigationState(context.token);
      }
    })
    .catch((error) => {
      console.error("[DigestDock Panel] Resume digest error:", error);
      showError(
        "无法读取当前视频",
        error?.message || "读取当前视频失败，请刷新页面后重试。",
      );
    })
    .finally(() => {
      noteNavigationResumePromise = null;
    });
  return noteNavigationResumePromise;
}

function saveWorkspaceTabSnapshot(tabName) {
  if (
    !SIDEPANEL_MVP_AVAILABLE ||
    !sidepanelMvpState?.session?.videoId ||
    !["transcript", "overview", "notes"].includes(tabName)
  ) {
    return;
  }
  const contentArea = document.getElementById("contentArea");
  sidepanelMvpState = SIDEPANEL_STATE_API.reduceSidepanelState(
    sidepanelMvpState,
    {
      type: SIDEPANEL_STATE_API.EVENTS.TAB_STATE_SAVED,
      tab: tabName,
      snapshot: {
        scrollTop: Math.max(0, Number(contentArea?.scrollTop) || 0),
        filter:
          tabName === "notes" ? (notesFilterShowAll ? "all" : "current") : "",
        follow:
          tabName === "transcript"
            ? {
                mode: autoScrollEnabled ? "following" : "paused",
                anchorTime: 0,
              }
            : undefined,
      },
    },
  );
}

function restoreWorkspaceTabSnapshot(tabName) {
  const scrollTop = Number(sidepanelMvpState?.tabs?.[tabName]?.scrollTop);
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
  const restore = () => {
    const contentArea = document.getElementById("contentArea");
    if (contentArea) {
      lastAutoScrollTime = Date.now();
      contentArea.scrollTop = scrollTop;
    }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
  else setTimeout(restore, 0);
}

function switchTab(tabName, { restoreScroll = true } = {}) {
  const previousTab = currentWorkspaceTab();
  if (tabName !== "transcript") {
    cancelFollowIdleResume({ clearHold: true });
  }
  if (previousTab) saveWorkspaceTabSnapshot(previousTab);
  if (SIDEPANEL_MVP_AVAILABLE && sidepanelMvpState?.session?.videoId) {
    sidepanelMvpState = SIDEPANEL_STATE_API.reduceSidepanelState(
      sidepanelMvpState,
      { type: SIDEPANEL_STATE_API.EVENTS.USER_SELECT_TAB, tab: tabName },
    );
  }
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle("active", active);
    tab.setAttribute?.("aria-selected", String(active));
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });
  updateHeaderLanguageControlsVisibility();
  if (restoreScroll) restoreWorkspaceTabSnapshot(tabName);

  // A saved-note jump intentionally performs no transcript acquisition. The
  // user's explicit switch to Transcript or Overview is the point at which we
  // leave that local-only state and resume the ordinary digest/consent flow.
  if (
    (tabName === "transcript" || tabName === "overview") &&
    isActiveNotesOnlyContext() &&
    !currentTranscript
  ) {
    void resumeDigestFromNotesOnly(tabName);
    return;
  }

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

  if (!hasConfiguredAiService()) {
    setOverviewTranslationStatus(aiFeatureSetupMessage("生成概览"));
    const chapterList = document.getElementById("chapterList");
    const quotesList = document.getElementById("quotesList");
    if (chapterList) {
      chapterList.innerHTML =
        '<li class="chapter-item ai-setup-placeholder">字幕已就绪。配置 AI 服务后可生成章节概览。</li>';
    }
    if (quotesList) {
      quotesList.innerHTML =
        '<div class="quote-item ai-setup-placeholder">配置 AI 服务后可提取关键语句。</div>';
    }
    return;
  }
  setOverviewTranslationStatus();

  const videoId = currentVideoId;
  const generation = digestGeneration;
  const routeKey = currentRouteKey;
  const mediaRef = currentMediaRef;
  const transcriptTimestamped = currentTranscriptTimestamped;
  const analysisCues = buildOverviewAnalysisCues(currentTranscript || []);
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
      analysisCues,
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

    // Persist a compact overview record before the much larger digest payload.
    // Even when a transcript cache write fails, reopening the same video can
    // still reuse the already-paid-for overview without another provider call.
    const overviewSaved = await saveOverviewToCache(
      videoId,
      currentAnalysis,
      transcriptTimestamped,
      sourceLanguage,
    );
    const digestSaved = await saveToCache(videoId);
    if (!overviewSaved && !digestSaved) {
      setOverviewTranslationStatus(
        "概览已生成，但本地保存失败；再次打开可能会重新生成并消耗 AI 额度。",
        true,
      );
    }
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
    return false;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    if (!Number.isInteger(videoTabId) || !currentRouteKey) return false;
    // One exact-route relay owns both delivery and the post-response SPA check.
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      tabId: videoTabId,
      expectedRouteKey: currentRouteKey,
      payload,
    });
    debugLog("[DigestDock Panel] seekTo relay result:", result);
    return result?.success === true && result.response?.success === true;
  } catch (error) {
    console.error("[DigestDock Panel] seekTo error:", error);
    return false;
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
async function playNote(
  note,
  { captureMetadata = false, exportContinuation = null } = {},
) {
  const noteMediaKey = note?.mediaKey || note?.videoId;
  if (noteMediaKey && noteMediaKey === currentVideoId) {
    if (captureMetadata && activeNotesOnlyContext) {
      const tab = await chrome.tabs.get(activeNotesOnlyContext.tabId);
      const locator = extractMediaLocator(tab?.pendingUrl || tab?.url || "");
      const context = normalizeNoteNavigationState({
        ...activeNotesOnlyContext,
        captureMetadata: true,
        exportContinuation:
          exportContinuation || activeNotesOnlyContext.exportContinuation,
      });
      if (context) {
        await persistNoteNavigationState(context);
        const captured = await captureNotesOnlyMetadata(context, tab, locator);
        if (captured && context.exportContinuation) {
          void resumeNoteExportContinuation(context.exportContinuation);
        }
        return !!captured;
      }
      return false;
    }
    if (captureMetadata) {
      if (!Number.isInteger(videoTabId)) {
        setNoteExportStatus("无法确认当前视频标签页，请刷新后重试。", true);
        return false;
      }
      const tab = await chrome.tabs.get(videoTabId);
      const locator = extractMediaLocator(tab?.pendingUrl || tab?.url || "");
      const context = {
        token: `metadata:${videoTabId}:${currentRouteKey}`,
        tabId: videoTabId,
        routeKey: currentRouteKey,
        mediaKey: String(noteMediaKey),
        platform:
          currentMediaRef?.platform === "bilibili" ? "bilibili" : "youtube",
        canonicalUrl:
          currentMediaRef?.canonicalUrl || noteCanonicalUrl(note),
        timestampedUrl: note?.timestampedUrl || note?.canonicalUrl || "",
        videoTitle: noteOriginalVideoTitle(note),
        channelName: note?.channelName || "",
        sourceLanguage: note?.sourceLanguage || "",
        duration: Number(note?.duration) || 0,
        captureMetadata: true,
        exportContinuation: normalizeNoteExportContinuation(exportContinuation),
      };
      const captured = await captureNotesOnlyMetadata(context, tab, locator, {
        requireActiveContext: false,
      });
      if (captured && context.exportContinuation) {
        void resumeNoteExportContinuation(context.exportContinuation);
      }
      return !!captured;
    }
    await seekTo(note.timestampSeconds);
    return true;
  }

  const targetUrl = String(note?.timestampedUrl || noteCanonicalUrl(note) || "");
  if (!extractMediaLocator(targetUrl)) {
    setNoteExportStatus("该笔记缺少可打开的视频网址。", true);
    return false;
  }

  let createdTab = null;
  let intent = null;
  try {
    // Create the tab in the background first so the navigation intent can be
    // bound to its exact tabId before Chrome emits onActivated. This removes a
    // race where an unrelated active tab could otherwise consume the intent.
    createdTab = await chrome.tabs.create({ url: targetUrl, active: false });
    if (!Number.isInteger(createdTab?.id)) {
      throw new Error("浏览器未返回新标签页，请重试。");
    }
    intent = buildNoteNavigationIntent(note, createdTab?.id, {
      captureMetadata,
      exportContinuation,
    });
    if (!intent) {
      throw new Error("无法确认笔记对应的视频网址，请重试。");
    }
    await persistNoteNavigationState(intent);
    if (typeof chrome.tabs.update !== "function") {
      throw new Error("浏览器暂时无法激活视频标签页，请重试。");
    }
    await chrome.tabs.update(createdTab.id, { active: true });
    return true;
  } catch (error) {
    if (intent) await clearNoteNavigationState(intent.token);
    if (Number.isInteger(createdTab?.id) && typeof chrome.tabs.remove === "function") {
      await chrome.tabs.remove(createdTab.id).catch(() => undefined);
    }
    debugLog("[DigestDock Panel] Open saved note failed:", error);
    return false;
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

/**
 * Renders already-grouped subtitle pieces without changing their text. Each
 * item is a real source-cue boundary retained by groupTranscriptEntries(); CSS
 * turns those boundaries into visual line breaks while copy/export/cache keep
 * using the canonical segment.text string.
 */
function renderTranscriptVisualFragments(fragments) {
  const values = Array.isArray(fragments) ? fragments : [fragments];
  return values
    .map((fragment) => String(fragment ?? ""))
    .filter((fragment) => fragment.trim())
    .map(
      (fragment) =>
        `<span class="transcript-fragment-line">${renderSubtitleInlineMarkup(fragment)}</span>`,
    )
    .join("");
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

function downloadTextFile(text, filename, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
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
  const needsAiConfig = !hasConfiguredAiService();
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
        ${
          needsAiConfig
            ? `<div class="explain-error">${escapeHtml(aiFeatureSetupMessage("解释所选内容"))}</div><button class="enhance-btn" id="configureAiForExplain" type="button">打开设置</button>`
            : '<div class="explain-loading"><div class="loading-bar"></div><span>正在分析…</span></div>'
        }
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

  if (needsAiConfig) {
    document
      .getElementById("configureAiForExplain")
      ?.addEventListener("click", () => void openAiSettings());
    return;
  }

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

function overviewCacheKey(videoId) {
  const mediaKey = String(videoId || "").trim().slice(0, 220);
  return mediaKey ? `${OVERVIEW_CACHE_PREFIX}${mediaKey}` : "";
}

function overviewTranscriptFingerprint(transcriptTimestamped) {
  const text = String(transcriptTimestamped || "").trim();
  return text ? YTD_NOTE_SOURCES.hashSourceText(text) : "";
}

function buildOverviewCacheRecord(
  videoId,
  analysis,
  transcriptTimestamped,
  sourceLanguage,
  transcriptSource = currentTranscriptSource,
  selectedTrack = currentTranscriptSelectedTrack,
) {
  const mediaKey = String(videoId || "").trim().slice(0, 220);
  const transcriptFingerprint = overviewTranscriptFingerprint(
    transcriptTimestamped,
  );
  if (!mediaKey || !transcriptFingerprint || !hasUsableChineseAnalysis(analysis)) {
    return null;
  }
  if (
    analysis?.timestampAnchorVersion !== ANALYSIS_TIMESTAMP_ANCHOR_VERSION
  ) {
    return null;
  }
  return {
    schemaVersion: OVERVIEW_CACHE_SCHEMA_VERSION,
    mediaKey,
    transcriptFingerprint,
    transcriptSource: String(transcriptSource || "").trim(),
    selectedTrackIdentity: transcriptSelectedTrackIdentity(selectedTrack),
    sourceLanguage: normalizeLanguageCode(
      sourceLanguage || analysis?.sourceLanguage,
    ),
    analysis,
    timestamp: Date.now(),
  };
}

function validateOverviewCacheRecord(
  record,
  videoId,
  transcriptTimestamped = "",
  sourceLanguage = "",
  transcriptSource = "",
  selectedTrack = null,
) {
  const mediaKey = String(videoId || "").trim().slice(0, 220);
  const legacyBilibiliV1 =
    mediaKey.startsWith("bilibili:") && record?.schemaVersion === 1;
  if (
    !record ||
    (record.schemaVersion !== OVERVIEW_CACHE_SCHEMA_VERSION &&
      !legacyBilibiliV1) ||
    record.mediaKey !== mediaKey ||
    record.analysis?.timestampAnchorVersion !==
      ANALYSIS_TIMESTAMP_ANCHOR_VERSION ||
    !hasUsableChineseAnalysis(record.analysis)
  ) {
    return null;
  }
  const expectedFingerprint = overviewTranscriptFingerprint(
    transcriptTimestamped,
  );
  if (
    expectedFingerprint &&
    record.transcriptFingerprint !== expectedFingerprint
  ) {
    return null;
  }
  const expectedSource = String(transcriptSource || "").trim();
  const expectedLanguage = normalizeLanguageCode(sourceLanguage);
  const cachedLanguage = normalizeLanguageCode(
    record.sourceLanguage || record.analysis?.sourceLanguage,
  );
  if (
    expectedLanguage &&
    cachedLanguage &&
    !languagesSharePrimary(expectedLanguage, cachedLanguage)
  ) {
    return null;
  }
  // v1 Bilibili overviews predate YouTube source/track binding, but already
  // bind mediaKey, transcript fingerprint, language, and usable analysis.
  // Preserve them so this YouTube-only policy change does not spend AI again.
  if (legacyBilibiliV1) return record.analysis;
  if (expectedSource && record.transcriptSource !== expectedSource) return null;
  if (
    expectedSource &&
    record.selectedTrackIdentity !==
      transcriptSelectedTrackIdentity(selectedTrack)
  ) {
    return null;
  }
  return record.analysis;
}

async function saveOverviewToCache(
  videoId,
  analysis,
  transcriptTimestamped = currentTranscriptTimestamped,
  sourceLanguage = currentTranscriptLanguage,
  transcriptSource = currentTranscriptSource,
  selectedTrack = currentTranscriptSelectedTrack,
) {
  const key = overviewCacheKey(videoId);
  const record = buildOverviewCacheRecord(
    videoId,
    analysis,
    transcriptTimestamped,
    sourceLanguage,
    transcriptSource,
    selectedTrack,
  );
  if (!key || !record) return false;
  try {
    await chrome.storage.local.set({ [key]: record });
    await evictOldOverviewCacheEntries(OVERVIEW_CACHE_MAX_ENTRIES);
    return true;
  } catch (error) {
    console.error("Overview cache save error:", error);
    return false;
  }
}

async function loadOverviewFromCache(
  videoId,
  transcriptTimestamped = currentTranscriptTimestamped,
  sourceLanguage = currentTranscriptLanguage,
  transcriptSource = currentTranscriptSource,
  selectedTrack = currentTranscriptSelectedTrack,
) {
  const key = overviewCacheKey(videoId);
  if (!key) return null;
  try {
    const result = await chrome.storage.local.get(key);
    const record = result[key];
    const analysis = validateOverviewCacheRecord(
      record,
      videoId,
      transcriptTimestamped,
      sourceLanguage,
      transcriptSource,
      selectedTrack,
    );
    if (!analysis && record) await chrome.storage.local.remove(key);
    return analysis;
  } catch (error) {
    console.error("Overview cache load error:", error);
    return null;
  }
}

async function evictOldOverviewCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    const overviewKeys = Object.keys(allData).filter((key) =>
      key.startsWith(OVERVIEW_CACHE_PREFIX),
    );
    if (overviewKeys.length <= maxEntries) return;
    const sorted = overviewKeys
      .map((key) => ({ key, timestamp: Number(allData[key]?.timestamp) || 0 }))
      .sort((left, right) => left.timestamp - right.timestamp);
    await chrome.storage.local.remove(
      sorted.slice(0, overviewKeys.length - maxEntries).map((entry) => entry.key),
    );
  } catch (error) {
    console.error("Overview cache eviction error:", error);
  }
}

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || videoId !== currentVideoId || !currentTranscript) return false;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    const cachePrefix = transcriptTranslationCachePrefix(videoId);
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(cachePrefix)) {
        paragraphCacheForVideo[key] = value;
      }
    }

    const transcriptFingerprint = transcriptContentFingerprint(
      currentTranscriptTimestamped,
      currentTranscriptText,
    );
    const transcriptSelectedTrack = sanitizeTranscriptSelectedTrack(
      currentTranscriptSelectedTrack,
    );
    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      analysisVideoId: currentAnalysis ? videoId : null,
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      transcriptSource: currentTranscriptSource,
      transcriptSelectedTrack,
      transcriptSelectedTrackIdentity:
        transcriptSelectedTrackIdentity(transcriptSelectedTrack),
      transcriptFingerprint,
      transcriptSourceAttempt: currentTranscriptSourceAttempt,
      mediaRef: currentMediaRef,
      routeKey: currentRouteKey,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      transcriptSourcePolicyVersion: TRANSCRIPT_SOURCE_POLICY_VERSION,
      transcriptRequestedLanguage: currentVideoSourceLanguage || null,
      transcriptRequestedTrackKind: currentPlatformIsBilibili()
        ? null
        : YOUTUBE_TRANSCRIPT_TRACK_KIND,
      transcriptArtifactIdentity: transcriptArtifactIdentity({
        source: currentTranscriptSource,
        language: currentTranscriptLanguage,
        requestedLanguage: currentVideoSourceLanguage,
        selectedTrack: transcriptSelectedTrack,
        fingerprint: transcriptFingerprint,
      }),
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

    // Refresh this video's durable export material (idempotent; only when the
    // video has a note). Captures newly translated transcript/title segments.
    void persistCurrentVideoNoteSourceIfNoted();
    return true;
  } catch (error) {
    console.error("Cache save error:", error);
    return false;
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
function validateTranscriptCacheRecord(
  cached,
  {
    videoId = "",
    mediaRef = null,
    requestedLanguage = "",
    trackKind = YOUTUBE_TRANSCRIPT_TRACK_KIND,
    routeKey = "",
    selectedTrack: expectedSelectedTrack = null,
  } = {},
) {
  if (!cached || typeof cached !== "object") return null;
  if (!Array.isArray(cached.transcript) || !cached.transcript.length) {
    return null;
  }

  const cachedPlatform =
    cached.mediaRef?.platform ||
    mediaRef?.platform ||
    (String(videoId).startsWith("bilibili:") ? "bilibili" : "youtube");
  const source = String(cached.transcriptSource || "").trim();
  const isBilibili = cachedPlatform === "bilibili";
  if (isBilibili) {
    // Bilibili keeps its independent cache contract. Version 4 remains valid
    // across the YouTube-only policy expansion; newly written version 5 rows
    // additionally carry the stronger fingerprint identity below.
    if (
      source !== "bilibili" ||
      ![4, TRANSCRIPT_SOURCE_POLICY_VERSION].includes(
        cached.transcriptSourcePolicyVersion,
      )
    ) {
      return null;
    }
  } else if (
    cached.transcriptSourcePolicyVersion !== TRANSCRIPT_SOURCE_POLICY_VERSION ||
    !YOUTUBE_TRANSCRIPT_SOURCES.has(source)
  ) {
    return null;
  }
  if (videoId && cached.mediaRef?.mediaKey !== videoId) {
    return null;
  }
  if (
    mediaRef?.platform &&
    cached.mediaRef?.platform !== mediaRef.platform
  ) {
    return null;
  }
  if (routeKey && cached.routeKey !== routeKey) return null;

  if (isBilibili && cached.transcriptSourcePolicyVersion === 4) {
    return cached;
  }

  const fingerprint = transcriptContentFingerprint(
    cached.transcriptTimestamped,
    cached.transcriptText,
  );
  if (!fingerprint || cached.transcriptFingerprint !== fingerprint) return null;

  const selectedTrack = sanitizeTranscriptSelectedTrack(
    cached.transcriptSelectedTrack,
  );
  const expectedTrack = sanitizeTranscriptSelectedTrack(expectedSelectedTrack);
  if (
    cached.transcriptSelectedTrack &&
    !["manual", "asr"].includes(cached.transcriptSelectedTrack.kind)
  ) {
    return null;
  }
  if (
    cached.transcriptSelectedTrackIdentity !==
    transcriptSelectedTrackIdentity(selectedTrack)
  ) {
    return null;
  }
  if (
    expectedTrack?.language &&
    (!selectedTrack ||
      selectedTrack.language !== expectedTrack.language ||
      selectedTrack.kind !== expectedTrack.kind)
  ) {
    return null;
  }
  if (
    !isBilibili &&
    !["supadata", "youtube-panel"].includes(source) &&
    (!selectedTrack || !selectedTrack.language)
  ) {
    return null;
  }

  const transcriptLanguage = normalizeLanguageCode(cached.transcriptLanguage);
  if (
    selectedTrack?.language &&
    transcriptLanguage &&
    !languagesSharePrimary(selectedTrack.language, transcriptLanguage)
  ) {
    return null;
  }

  if (!isBilibili) {
    if (cached.transcriptRequestedTrackKind !== trackKind) return null;
    const expectedLanguage = normalizeLanguageCode(requestedLanguage);
    const cachedRequestedLanguage = normalizeLanguageCode(
      cached.transcriptRequestedLanguage,
    );
    if (
      expectedLanguage &&
      cachedRequestedLanguage &&
      cachedRequestedLanguage !== expectedLanguage
    ) {
      return null;
    }
  }

  const artifactIdentity = cachedTranscriptArtifactIdentity(cached);
  if (
    !artifactIdentity ||
    cached.transcriptArtifactIdentity !== artifactIdentity
  ) {
    return null;
  }
  return cached;
}

async function readStoredTranscriptArtifactIdentity(videoId) {
  if (!videoId) return "";
  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    return cachedTranscriptArtifactIdentity(result[`digest_${videoId}`]);
  } catch (_error) {
    return "";
  }
}

async function invalidateTranscriptDerivedArtifacts(
  videoId,
  previousArtifactIdentity,
  nextArtifactIdentity,
) {
  if (
    previousArtifactIdentity &&
    nextArtifactIdentity &&
    previousArtifactIdentity === nextArtifactIdentity
  ) {
    return false;
  }
  await chrome.storage.local.remove(overviewCacheKey(videoId));
  await YTD_NOTE_SOURCES.removeNoteSources(chrome.storage.local, videoId);
  currentPersistedNoteSource = null;
  const cachePrefix = transcriptTranslationCachePrefix(videoId);
  for (const key of [...transcriptParagraphCache.keys()]) {
    if (key.startsWith(cachePrefix)) transcriptParagraphCache.delete(key);
  }
  return true;
}

async function loadFromCache(videoId, expected = {}) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return validateTranscriptCacheRecord(cached, { videoId, ...expected });
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
  const textLanguage = normalizeLanguageCode(note?.textLanguage);
  const trustedChineseText =
    note?.platform === "bilibili"
      ? isConfirmedSimplifiedChineseSource(textLanguage)
      : isChineseLanguage(textLanguage);
  return Boolean(
    trustedChineseText &&
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

// ============================================================
// NOTE VIDEO TITLE — original / Chinese / bilingual
// ============================================================
// The stored `videoTitle` is always the original title. `videoTitleZh` holds a
// validated Chinese translation bound to the media identity (mediaKey), shared
// by every note of the same video. Missing translations fall back to the
// original title; a title that is already Chinese is reused as-is with no
// provider call.

function noteOriginalVideoTitle(note) {
  const title = String(note?.videoTitle || "").trim();
  return title || "Untitled Video";
}

/**
 * True when the original title is already Chinese, so it can be reused directly
 * for the Chinese view without a translation request. Mirrors the note-body
 * legacy-Chinese heuristic: reject Japanese/Korean scripts, require CJK to
 * dominate any Latin text.
 */
function videoTitleIsChinese(note) {
  return looksLikeLegacyChineseNote(noteOriginalVideoTitle(note));
}

function noteChineseVideoTitle(note) {
  if (videoTitleIsChinese(note)) return noteOriginalVideoTitle(note);
  const translated = String(note?.videoTitleZh || "").trim();
  if (!translated) return "";
  const sourceHash = String(note?.videoTitleZhSourceHash || "").trim();
  if (
    sourceHash &&
    sourceHash !== YTD_NOTE_SOURCES.hashSourceText(noteOriginalVideoTitle(note))
  ) {
    return "";
  }
  return note?.videoTitleZhValidated === true &&
    note?.videoTitleZhValidationVersion ===
      NOTE_TITLE_TRANSLATION_VALIDATION_VERSION
    ? translated
    : "";
}

/** Ordered {lang,text} title blocks for the current mode (shared assembly). */
function noteVideoTitleSegments(note, mode = currentNotesMode) {
  return YTD_NOTE_EXPORT.localizedSegments(
    noteOriginalVideoTitle(note),
    noteChineseVideoTitle(note),
    mode,
  );
}

/**
 * Plain-text title for the given mode — used for the header `title` attribute
 * and export. Bilingual returns both lines when they differ.
 */
function noteVideoTitleForMode(note, mode = currentNotesMode) {
  return YTD_NOTE_EXPORT.localizedPlainText(
    noteOriginalVideoTitle(note),
    noteChineseVideoTitle(note),
    mode,
  );
}

/**
 * Single visible title used to sort source groups under the current mode:
 * the first visible line (Chinese in zh mode, otherwise the original).
 */
function noteVideoTitleSortKey(note, mode = currentNotesMode) {
  return (
    noteVideoTitleSegments(note, mode)[0]?.text || noteOriginalVideoTitle(note)
  );
}

function renderNoteVideoTitle(note, mode = currentNotesMode) {
  const originalIsChinese = videoTitleIsChinese(note);
  return noteVideoTitleSegments(note, mode)
    .map((block) => {
      const lang =
        block.lang === "zh" || originalIsChinese ? "zh-CN" : "en";
      return `<span class="note-source-title-line note-source-title-line--${block.lang}" lang="${lang}">${escapeHtml(block.text)}</span>`;
    })
    .join("");
}

/**
 * De-duplicated per-media title translation work: one entry per media identity
 * whose original title is not already Chinese and has no validated translation.
 * Titles that keep failing are dropped after a bounded number of attempts so
 * mode toggles cannot loop on the same failure.
 */
function collectMissingNoteTitleWork(notes) {
  const seen = new Set();
  const work = [];
  for (const note of notes) {
    const mediaKey = String(note?.mediaKey || note?.videoId || "").trim();
    if (!mediaKey || seen.has(mediaKey)) continue;
    seen.add(mediaKey);
    if (videoTitleIsChinese(note) || noteChineseVideoTitle(note)) continue;
    const title = noteOriginalVideoTitle(note);
    if (!title || title === "Untitled Video") continue;
    if (
      (noteTitleTranslationAttemptByKey.get(mediaKey) || 0) >=
      NOTE_TITLE_TRANSLATION_MAX_ATTEMPTS
    ) {
      continue;
    }
    work.push({ mediaKey, title });
    if (work.length >= 10) break;
  }
  return work;
}

/**
 * Applies validated title translations to every in-memory note that shares the
 * media identity. Returns true when at least one note changed.
 */
function applyNoteTitleTranslations(titles) {
  if (!Array.isArray(titles) || !titles.length) return false;
  const byKey = new Map(titles.map((entry) => [entry.mediaKey, entry.titleZh]));
  byKey.forEach((_titleZh, key) => noteTitleTranslationAttemptByKey.delete(key));
  let changed = false;
  currentNotes = currentNotes.map((note) => {
    const key = String(note?.mediaKey || note?.videoId || "").trim();
    if (!key || !byKey.has(key)) return note;
    changed = true;
    return {
      ...note,
      videoTitleZh: byKey.get(key),
      videoTitleZhValidated: true,
      videoTitleZhValidationVersion: NOTE_TITLE_TRANSLATION_VALIDATION_VERSION,
    };
  });
  return changed;
}

// ============================================================
// NOTE SOURCE GROUPING — one container per media, timecode-ordered.
// Grouping/sorting live in the shared note-export module so the UI and the
// reading exports never diverge on how notes are grouped or ordered.
// ============================================================

const noteMediaGroupKey = YTD_NOTE_EXPORT.noteMediaGroupKey;
const sortNotesByTimecode = YTD_NOTE_EXPORT.sortNotesByTimecode;
const groupNotesBySource = YTD_NOTE_EXPORT.groupNotesBySource;

/**
 * Sorts source groups by their visible title under the current mode
 * (localeCompare zh-CN), with `mediaKey` as the stable tie-breaker.
 */
function sortNoteGroups(groups, mode = currentNotesMode) {
  return YTD_NOTE_EXPORT.sortNoteGroups(groups, (representative) =>
    noteVideoTitleSortKey(representative, mode),
  );
}

function notePlatformLabel(note) {
  return note?.platform === "bilibili" ? "B 站" : "YouTube";
}

function renderNoteLanguageContent(note, mode = currentNotesMode) {
  const originalIsChinese = noteHasChineseSource(note);
  return YTD_NOTE_EXPORT.localizedSegments(
    noteOriginalText(note),
    noteChineseText(note),
    mode,
  )
    .map((block) => {
      const contentLanguage =
        block.lang === "zh" || (block.lang === "original" && originalIsChinese)
          ? "zh-CN"
          : "en";
      const text = String(block.text || "").trim();
      const alreadyQuoted = /^[“「『\"]+[\s\S]*[”」』\"]+$/.test(text);
      return `<span class="note-language-block note-language-block--${block.lang}" lang="${contentLanguage}">${alreadyQuoted ? escapeHtml(text) : `“${escapeHtml(text)}”`}</span>`;
    })
    .join("");
}

function noteCopyTextForMode(note, mode = currentNotesMode) {
  return YTD_NOTE_EXPORT.localizedPlainText(
    noteOriginalText(note),
    noteChineseText(note),
    mode,
  );
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
  const providerLabel = activeAiServiceLabel();
  const codes = new Set(
    failures
      .map((failure) => String(failure?.code || ""))
      .filter(Boolean),
  );
  if (codes.has("RATE_LIMITED")) {
    return `${providerLabel}请求受限，请稍后再次点击当前语言重试。`;
  }
  if (codes.has("PROVIDER_TIMEOUT")) {
    return `${providerLabel}请求超时，请再次点击当前语言重试。`;
  }
  if (codes.has("NOTE_JOB_TIMEOUT")) {
    return "笔记翻译任务等待超时，请再次点击当前语言重试。";
  }
  if (codes.has("PROVIDER_ERROR")) {
    return `${providerLabel}请求失败，请检查网络或稍后再次点击当前语言重试。`;
  }
  if (codes.has("OUTPUT_TRUNCATED")) {
    return `${providerLabel}输出被截断，请再次点击当前语言重试。`;
  }
  if (codes.has("CONTENT_FILTERED")) {
    return `${providerLabel}未返回这条内容，已保留原文。`;
  }
  if (codes.has("PROVIDER_UNAVAILABLE")) {
    return `${providerLabel}暂时不可用，请稍后再次点击当前语言重试。`;
  }
  if (codes.has("UNEXPECTED_FINISH_REASON")) {
    return `${providerLabel}未正常完成响应，请再次点击当前语言重试。`;
  }
  if (codes.has("RETRY_BUDGET_EXHAUSTED")) {
    return "本轮重试次数已达上限，请再次点击当前语言继续。";
  }
  if (codes.has("EMPTY_RESPONSE")) {
    return `${providerLabel}返回了空内容，请再次点击当前语言重试。`;
  }
  if (codes.has("INVALID_JSON")) {
    return `${providerLabel}返回格式无法解析，请再次点击当前语言重试。`;
  }
  if (codes.has("MISSING_ITEM")) {
    return `${providerLabel}返回结果漏掉了这条笔记，请再次点击当前语言重试。`;
  }
  if (codes.has("MULTIPLE_CANDIDATES")) {
    return `${providerLabel}返回了多个冲突结果，请再次点击当前语言重试。`;
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
  const titleWork = collectMissingNoteTitleWork(currentNotes);
  if (!missingNotes.length && !titleWork.length) {
    setNotesTranslationStatus();
    return;
  }
  if (!hasConfiguredAiService()) {
    setNotesTranslationStatus(aiFeatureSetupMessage("生成中文或双语笔记"));
    return;
  }

  const generation = ++notesTranslationGeneration;
  const failureById = new Map();
  setNotesTranslationLoading(true);
  setNotesTranslationStatus(
    missingNotes.length
      ? `正在生成 ${missingNotes.length} 条中文笔记…`
      : "正在翻译视频标题…",
  );
  try {
    // One user action owns one bounded backend job (up to ten notes, the
    // de-duplicated title batch, and five provider calls total). Remaining
    // notes continue only after an explicit retry, so a large library cannot
    // multiply requests silently.
    const batch = missingNotes.slice(0, 10);
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
      titles: titleWork,
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
    // Titles are validated independently of note bodies: a failed title never
    // blocks a translated body, and a failed body never blocks a title.
    (result.titleFailures || []).forEach((failure) => {
      if (typeof failure?.mediaKey === "string" && failure.mediaKey) {
        noteTitleTranslationAttemptByKey.set(
          failure.mediaKey,
          (noteTitleTranslationAttemptByKey.get(failure.mediaKey) || 0) + 1,
        );
      }
    });
    currentNotes = currentNotes.map((note) =>
      translatedById.has(note.id)
        ? {
            ...note,
            translatedText: translatedById.get(note.id).textZh,
            translatedUnchanged: translatedById.get(note.id).unchanged === true,
            translatedValidated: true,
            translatedValidationVersion: NOTE_TRANSLATION_VALIDATION_VERSION,
          }
        : note,
    );
    applyNoteTitleTranslations(result.titles);
    renderNotes(currentNotes, currentNotesFilterVideoId);
    if (!result?.success && !result?.failures?.length) {
      throw new Error(result?.error || "中文笔记生成失败");
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
  const needsAiTranslation =
    mode !== "original" &&
    (currentNotes.some(
      (note) => noteOriginalText(note) && !noteChineseText(note),
    ) || collectMissingNoteTitleWork(currentNotes).length > 0);
  if (needsAiTranslation && !hasConfiguredAiService()) {
    setNotesModeButtons(currentNotesMode);
    setNotesTranslationStatus(aiFeatureSetupMessage("生成中文或双语笔记"));
    return;
  }
  revokeNoteExportAuthorization();
  const navigationState = activeNotesOnlyContext || pendingNoteNavigation;
  if (navigationState?.exportContinuation) {
    void persistNoteNavigationState({
      ...navigationState,
      exportContinuation: {
        mediaKeys: navigationState.exportContinuation.mediaKeys,
        mode,
      },
    });
  }
  currentNotesMode = mode;
  setNotesModeButtons(mode);
  renderNotes(currentNotes, currentNotesFilterVideoId);
  const picker = document.getElementById("notesExportPicker");
  if (picker && !picker.hidden && noteExportPickerGroups.length) {
    renderNoteExportPicker(
      noteExportPickerGroups,
      noteExportPickerSourcesByKey,
      [...selectedNoteExportMediaKeys],
    );
  }
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
 * Renders the notes list in the Notes tab. Notes are grouped into one source
 * container per media identity; containers are ordered by visible title and
 * notes inside each container by timecode ascending.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");
  const notesIntroText = document.getElementById("notesIntroText");
  const languageStatus = document.getElementById("notesLanguageStatus");

  if (!notesList) return;

  notesList.innerHTML = "";
  setNotesModeButtons(currentNotesMode);

  if (!notes || notes.length === 0) {
    updateNoteExportMenuContext(0);
    setNotesTranslationStatus();
    notesIntro.style.display = "flex";
    const saveCurrentMomentLabel = document.querySelector(
      "#saveCurrentMomentBtn span",
    );
    if (saveCurrentMomentLabel) {
      saveCurrentMomentLabel.textContent = "保存当前时刻";
    }
    if (notesIntroText) {
      notesIntroText.textContent = filteredVideoId
        ? "当前视频还没有笔记。保存当前播放位置，稍后可直接跳回。"
        : "还没有保存任何笔记。请先打开一个视频，再保存当前播放位置。";
    }
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

  const groups = sortNoteGroups(groupNotesBySource(notes));
  updateNoteExportMenuContext(groups.length);
  groups.forEach((group) => {
    notesList.appendChild(renderNoteSourceGroup(group, filteredVideoId));
  });

  ensureNoteMenuDismissHandler();
}

/**
 * Builds one source container: a header with the mode-aware video title,
 * channel / platform / count metadata and an "open video" action, followed by
 * the timecode-sorted note items.
 */
function noteSourceMetaText(representative, noteCount) {
  const channel = String(representative?.channelName || "").trim();
  return [channel, notePlatformLabel(representative), `${noteCount} 条笔记`]
    .filter(Boolean)
    .join(" · ");
}

function renderNoteSourceGroup(group, filteredVideoId) {
  const representative = group.representative || group.notes[0];
  const container = document.createElement("div");
  container.className = "note-source-group";
  container.dataset.mediaKey = group.mediaKey;

  const header = document.createElement("div");
  header.className = "note-source-header";
  const metaText = noteSourceMetaText(representative, group.notes.length);
  const titlePlain = noteVideoTitleForMode(representative).replace(/\n/g, " · ");
  header.innerHTML = `
    <div class="note-source-title" title="${escapeHtml(titlePlain)}">${renderNoteVideoTitle(representative)}</div>
    <div class="note-source-meta">${escapeHtml(metaText)}</div>
    <div class="note-source-actions">
      <button class="note-source-open" type="button" title="打开视频" aria-label="打开视频">打开视频</button>
      <button class="note-source-export" type="button" title="导出此视频笔记" aria-label="导出此视频笔记">导出此视频</button>
    </div>
  `;
  header
    .querySelector(".note-source-open")
    ?.addEventListener("click", () => playNote(group.notes[0]));
  header
    .querySelector(".note-source-export")
    ?.addEventListener("click", () => exportSingleSourceGroup(group));
  container.appendChild(header);

  const list = document.createElement("div");
  list.className = "note-source-list";
  group.notes.forEach((note) => {
    list.appendChild(buildNoteItemElement(note, filteredVideoId));
  });
  container.appendChild(list);
  return container;
}

/**
 * Builds a single note row (timecode, mode-aware body, per-note actions). The
 * video title now lives on the enclosing source container, not the row.
 */
function buildNoteItemElement(note, filteredVideoId) {
  const noteEl = document.createElement("div");
  noteEl.className = "note-item";
  const noteCopyText = noteCopyTextForMode(note);
  const noteTime = formatTimecode(note.timestampSeconds);
  noteEl.innerHTML = `
    <div class="note-header">
      <span class="note-timestamp" role="button" tabindex="0" data-seconds="${Number(note.timestampSeconds) || 0}" title="从 ${escapeHtml(noteTime)} 播放" aria-label="从 ${escapeHtml(noteTime)} 播放">${escapeHtml(noteTime)}</span>
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
  noteEl
    .querySelector(".note-play")
    .addEventListener("click", () => playNote(note));

  return noteEl;
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

function currentWorkspaceTab() {
  return String(document.querySelector(".tab.active")?.dataset?.tab || "");
}

function followPlaybackSnapshot() {
  const identity = sidepanelMvpCurrentIdentity();
  if (
    !identity ||
    !currentVideoId ||
    !currentRouteKey ||
    !Number.isInteger(videoTabId)
  ) {
    return null;
  }
  return Object.freeze({
    identity,
    videoId: currentVideoId,
    routeKey: currentRouteKey,
    digestGeneration,
    tabId: videoTabId,
  });
}

function followPlaybackSnapshotIsCurrent(snapshot) {
  return Boolean(
    snapshot &&
      snapshot.videoId === currentVideoId &&
      snapshot.routeKey === currentRouteKey &&
      snapshot.digestGeneration === digestGeneration &&
      snapshot.tabId === videoTabId &&
      SIDEPANEL_STATE_API?.sameIdentity?.(
        snapshot.identity,
        sidepanelMvpCurrentIdentity(),
      ),
  );
}

function followContextIsDeparted() {
  return currentWorkspaceTab() === "transcript" && autoScrollEnabled === false;
}

function followResumeHasBlockingUi() {
  if (document.hidden || !panelIsShowingResults()) return true;
  if (!Array.isArray(currentTranscript) || currentTranscript.length === 0) {
    return true;
  }
  if (
    sidepanelMvpState?.transcript?.status !==
    SIDEPANEL_STATE_API?.TRANSCRIPT_STATUSES?.READY
  ) {
    return true;
  }
  if (
    isAnalysisLoading ||
    isOverviewTranslationLoading ||
    isNotesLoading ||
    isNotesTranslationLoading ||
    Boolean(activeExportJobId)
  ) {
    return true;
  }
  if (isActiveNotesOnlyContext() || notesFilterShowAll) return true;
  if (String(window.getSelection?.()?.toString?.() || "").trim()) return true;

  const contentArea = document.getElementById("contentArea");
  const activeElement = document.activeElement;
  if (
    contentArea?.contains?.(activeElement) &&
    activeElement?.matches?.("input, textarea, select, [contenteditable='true']")
  ) {
    return true;
  }

  return Boolean(
    document.querySelector(
      "#explainModal, .notes-export-menu:not([hidden]), .notes-export-picker:not([hidden]), .notes-export-precheck:not([hidden]), .theme-switch-menu:not([hidden])",
    ),
  );
}

function announceFollowPlayback(message) {
  const status = document.getElementById("followPlaybackStatus");
  if (!status) return;
  status.textContent = message;
  setTimeout(() => {
    if (status.textContent === message) status.textContent = "";
  }, 1800);
}

function showFollowPlaybackPrompt({ held = false, message = "" } = {}) {
  if (currentWorkspaceTab() !== "transcript") {
    hideFollowPlaybackPrompt();
    return;
  }
  const bar = document.getElementById("followPlaybackBar");
  const hint = document.getElementById("followPlaybackHint");
  if (!bar || !hint) return;
  bar.hidden = false;
  bar.classList.toggle("is-held", held);
  hint.textContent = held
    ? "已暂停自动跟随"
    : message || "静置 5 秒后回到字幕";
}

function hideFollowPlaybackPrompt() {
  const bar = document.getElementById("followPlaybackBar");
  if (!bar) return;
  bar.hidden = true;
  bar.classList?.remove?.("is-held");
}

function idleFollowController() {
  if (!SIDEPANEL_EFFECTS_API?.createIdleFollowController) return null;
  if (!followIdleController) {
    followIdleController = SIDEPANEL_EFFECTS_API.createIdleFollowController({
      delayMs: FOLLOW_IDLE_RESUME_DELAY_MS,
      readPlayback: readFollowPlayback,
      shouldResume: shouldAutoResumeFollow,
      resume: resumeFollowPlaybackFromIdle,
      onSettled: (snapshot, { resumed, playback }) => {
        if (resumed || followManualHoldTab) return;
        const shouldRetry =
          followPlaybackSnapshotIsCurrent(snapshot) &&
          followContextIsDeparted() &&
          !isActiveNotesOnlyContext() &&
          !notesFilterShowAll &&
          (playback == null ||
            playback?.paused === true ||
            followResumeHasBlockingUi());
        if (shouldRetry) {
          showFollowPlaybackPrompt({
            message:
              playback?.paused === true
                ? "视频暂停，播放后将回到字幕"
                : playback == null
                  ? "暂未读到播放位置，将继续重试"
                : "阅读结束后静置 5 秒回到字幕",
          });
          followIdleController?.schedule(snapshot);
        } else {
          hideFollowPlaybackPrompt();
        }
      },
    });
  }
  return followIdleController;
}

function cancelFollowIdleResume({ keepPrompt = false, clearHold = false } = {}) {
  followIntentRevision += 1;
  idleFollowController()?.cancel();
  if (clearHold) followManualHoldTab = null;
  if (!keepPrompt) hideFollowPlaybackPrompt();
}

function scheduleFollowIdleResume() {
  const snapshot = followPlaybackSnapshot();
  const activeTab = currentWorkspaceTab();
  if (
    !snapshot ||
    activeTab !== "transcript" ||
    !followContextIsDeparted() ||
    followManualHoldTab === activeTab
  ) {
    return false;
  }
  showFollowPlaybackPrompt();
  idleFollowController()?.schedule(snapshot);
  return true;
}

function onFollowWorkspaceInteraction(event = {}) {
  if (currentWorkspaceTab() !== "transcript") return;
  if (
    event.type === "scroll" &&
    Date.now() - lastAutoScrollTime < 1000
  ) {
    return;
  }
  const selectedText = String(window.getSelection?.()?.toString?.() || "").trim();
  const intentionalTranscriptInteraction =
    currentWorkspaceTab() === "transcript" &&
    autoScrollEnabled &&
    autoScrollInterval &&
    (event.type !== "selectionchange" || Boolean(selectedText));
  if (intentionalTranscriptInteraction) {
    autoScrollEnabled = false;
  }
  if (!followContextIsDeparted()) return;
  followIntentRevision += 1;
  scheduleFollowIdleResume();
}

function readFollowPlayback(
  snapshot,
  { timeoutMs = FOLLOW_PLAYBACK_READ_TIMEOUT_MS } = {},
) {
  if (!followPlaybackSnapshotIsCurrent(snapshot)) return Promise.resolve(null);
  const boundedTimeout = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Number(timeoutMs))
    : FOLLOW_PLAYBACK_READ_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timerId = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timerId !== null) clearTimeout(timerId);
      resolve(value);
    };
    timerId = setTimeout(() => finish(null), boundedTimeout);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage({
        action: "relayToContent",
        tabId: snapshot.tabId,
        expectedRouteKey: snapshot.routeKey,
        payload: { action: "getCurrentTime" },
      });
    } catch (_error) {
      finish(null);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => {
        if (
          !followPlaybackSnapshotIsCurrent(snapshot) ||
          !result?.success ||
          !result.response
        ) {
          finish(null);
          return;
        }
        finish(result.response);
      },
      () => finish(null),
    );
  });
}

function shouldAutoResumeFollow(snapshot, playback) {
  return Boolean(
    followPlaybackSnapshotIsCurrent(snapshot) &&
      followContextIsDeparted() &&
      !followResumeHasBlockingUi() &&
      playback?.paused === false &&
      Number.isFinite(Number(playback.currentTime)),
  );
}

function playbackScrollBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    ? "auto"
    : "smooth";
}

function restoreFollowAtTime(currentTime, { automatic = false } = {}) {
  if (!Array.isArray(currentTranscript) || currentTranscript.length === 0) {
    return false;
  }
  if (currentWorkspaceTab() !== "transcript") return false;
  // A cue read started before this explicit restore must not arrive later and
  // scroll the transcript back to an older playback position.
  playbackTrackingRequestToken += 1;
  playbackTrackingRequestInFlight = false;
  cancelFollowIdleResume({ clearHold: true });
  autoScrollEnabled = true;
  startPlaybackTracking();
  highlightActiveEntry(Number(currentTime) || 0, { forceScroll: true });
  hideFollowPlaybackPrompt();
  announceFollowPlayback(
    automatic ? "已自动恢复跟随当前字幕。" : "已恢复跟随当前字幕。",
  );
  return true;
}

async function resumeFollowPlaybackFromIdle(snapshot, playback) {
  if (!shouldAutoResumeFollow(snapshot, playback)) return false;
  return restoreFollowAtTime(playback.currentTime, { automatic: true });
}

async function resumeFollowPlaybackNow() {
  if (currentWorkspaceTab() !== "transcript") {
    cancelFollowIdleResume({ clearHold: true });
    return false;
  }
  if (!Array.isArray(currentTranscript) || currentTranscript.length === 0) {
    showFollowPlaybackPrompt({ message: "当前字幕尚未准备好" });
    announceFollowPlayback("当前视频尚未准备好，请稍后再试。");
    return false;
  }
  cancelFollowIdleResume({ keepPrompt: true, clearHold: true });
  const intentRevision = followIntentRevision;
  showFollowPlaybackPrompt({ message: "正在回到当前字幕…" });
  playbackTrackingRequestToken += 1;
  playbackTrackingRequestInFlight = false;
  autoScrollEnabled = true;
  hideFollowPlaybackPrompt();
  startPlaybackTracking();
  const located = await playbackTrackingTick({ forceScroll: true });
  if (
    intentRevision !== followIntentRevision ||
    currentWorkspaceTab() !== "transcript" ||
    followManualHoldTab
  ) {
    return false;
  }
  announceFollowPlayback(
    located
      ? "已恢复跟随当前字幕。"
      : "已回到字幕，播放位置暂未读取到，将继续自动重试。",
  );
  return true;
}

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (
    !currentTranscript ||
    !currentTranscript.length ||
    currentWorkspaceTab() !== "transcript"
  ) {
    return;
  }

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  hideFollowPlaybackPrompt();
  playbackTrackingEpoch += 1;
  const epoch = playbackTrackingEpoch;

  // Poll video time every 500ms
  autoScrollInterval = setInterval(
    () => void playbackTrackingTick({ expectedEpoch: epoch }),
    500,
  );
  void playbackTrackingTick({ expectedEpoch: epoch });

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
  playbackTrackingEpoch += 1;
  playbackTrackingRequestToken += 1;
  playbackTrackingRequestInFlight = false;
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  hideFollowPlaybackPrompt();

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
async function playbackTrackingTick({
  expectedEpoch = playbackTrackingEpoch,
  forceScroll = false,
} = {}) {
  if (
    expectedEpoch !== playbackTrackingEpoch ||
    currentWorkspaceTab() !== "transcript"
  ) {
    return false;
  }
  if (playbackTrackingRequestInFlight && !forceScroll) return false;
  const requestToken = ++playbackTrackingRequestToken;
  const snapshot = followPlaybackSnapshot();
  if (!snapshot) return false;
  playbackTrackingRequestInFlight = true;
  try {
    const playback = await readFollowPlayback(snapshot);

    if (
      requestToken !== playbackTrackingRequestToken ||
      expectedEpoch !== playbackTrackingEpoch ||
      !followPlaybackSnapshotIsCurrent(snapshot) ||
      currentWorkspaceTab() !== "transcript" ||
      !playback
    ) {
      return false;
    }

    const currentTime = playback.currentTime || 0;
    highlightActiveEntry(currentTime, { forceScroll });
    return true;
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
    return false;
  } finally {
    if (requestToken === playbackTrackingRequestToken) {
      playbackTrackingRequestInFlight = false;
    }
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
  activeEntry.scrollIntoView({
    behavior: playbackScrollBehavior(),
    block: "center",
  });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds, { forceScroll = false } = {}) {
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
  if (activeEntry.classList.contains("active-playback")) {
    if (forceScroll && autoScrollEnabled) scrollToActiveEntry();
    return;
  }

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({
      behavior: playbackScrollBehavior(),
      block: "center",
    });
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
    followIntentRevision += 1;
    scheduleFollowIdleResume();
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

function buildOverviewAnalysisCues(entries = currentTranscript || []) {
  return groupTranscriptEntries(entries).map((segment, index) => ({
    cueId: `cue-${index}`,
    timestampSeconds: Math.max(
      0,
      Number(segment.seekStart ?? segment.start) || 0,
    ),
    text: segment.text,
  }));
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

  if (mode !== "original" && !hasConfiguredAiService()) {
    const segments = getActiveTranscriptSegments();
    const hasMissingTranslation = segments.some(
      (segment) =>
        !transcriptParagraphCache.has(
          transcriptTranslationCacheKey(currentVideoId, segment),
        ),
    );
    if (hasMissingTranslation) {
      setTranscriptModeButtons(currentTranscriptMode);
      setTranscriptTranslationStatus(
        aiFeatureSetupMessage("生成中文字幕或双语字幕"),
      );
      return;
    }
  }
  setTranscriptTranslationStatus();

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
    setTranscriptTranslationStatus();
    renderTranscript();
    return;
  }

  await translateTranscript();
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderTranscriptVisualFragments([translated]);
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
      ${transcriptTimeCellMarkup(segment.seekStart ?? segment.start)}
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    attachTranscriptTimeSeek(div, segment.seekStart ?? segment.start);
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
  const hasMissingTranslation = segments.some(
    (segment) =>
      !transcriptParagraphCache.has(
        transcriptTranslationCacheKey(currentVideoId, segment),
      ),
  );
  if (hasMissingTranslation && !hasConfiguredAiService()) {
    currentTranscriptMode = "original";
    setTranscriptModeButtons("original");
    renderTranscript();
    setTranscriptTranslationStatus(
      aiFeatureSetupMessage("生成中文字幕或双语字幕"),
    );
    return;
  }
  setTranscriptTranslationStatus();

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
  TRANSCRIPT_SOURCE_POLICY_VERSION,
  YOUTUBE_TRANSCRIPT_TRACK_KIND,
  hasConfiguredAiService,
  activeAiServiceLabel,
  aiFeatureSetupMessage,
  createSingleFlight,
  buildTranscriptFetchRequest,
  transcriptResponseMatchesRequest,
  transcriptRouteOutcome,
  shouldOfferSupadata,
  transcriptSelectedTrackIdentity,
  transcriptContentFingerprint,
  transcriptArtifactIdentity,
  cachedTranscriptArtifactIdentity,
  digestMediaIdentityChanged,
  validateTranscriptCacheRecord,
  sendTranslationMessage,
  groupTranscriptEntries,
  buildOverviewAnalysisCues,
  needsVisualChineseQuotes,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  loadNotes,
  hasUsableChineseAnalysis,
  hasCompleteOriginalAnalysis,
  overviewCacheKey,
  overviewTranscriptFingerprint,
  buildOverviewCacheRecord,
  validateOverviewCacheRecord,
  saveOverviewToCache,
  loadOverviewFromCache,
  normalizeLanguageCode,
  isChineseLanguage,
  isConfirmedSimplifiedChineseSource,
  currentPlatformIsBilibili,
  transcriptOriginalBadgeText,
  isTransientTabLookupError,
  noteHasChineseSource,
  noteHasPolishedChineseText,
  noteOriginalText,
  noteChineseText,
  noteCopyTextForMode,
  noteOriginalVideoTitle,
  noteChineseVideoTitle,
  videoTitleIsChinese,
  noteVideoTitleForMode,
  noteVideoTitleSortKey,
  renderNoteVideoTitle,
  noteMediaGroupKey,
  groupNotesBySource,
  sortNotesByTimecode,
  sortNoteGroups,
  notePlatformLabel,
  noteSourceMetaText,
  summarizeNoteTranslationFailures,
  saveCurrentMomentFromPanel,
  renderNoteLanguageContent,
  renderChapterLanguageContent,
  renderQuoteLanguageContent,
  overviewQuoteCopyText,
  renderSubtitleInlineMarkup,
  renderTranscriptVisualFragments,
  renderTranscriptSegmentContent,
  extractMediaLocator,
  isDigestDockOptionsUrl,
  transcriptTranslationCacheKey,
  transcriptExportMode,
  buildTranscriptExportSource,
  describeExportPrecheck,
  runConfirmedExportTranslation: runConfirmedExportTranslationRound,
  runConfirmedExportTranslationRound,
  finalizeExportJobDownload,
  showNoteExportPrecheck,
  showNoteExportMetadataWorkspace,
  renderNoteExportPicker,
  recoverNotesExportSelection,
  createNoteExportContinuation,
  grantNoteExportAuthorization,
  validateNoteExportAuthorization,
  noteExportContinuationIsAuthorized,
  revokeNoteExportAuthorization,
  resumeNoteExportContinuation,
  persistNoteNavigationState,
  hydrateNoteNavigationState,
  noteExportVideoPreparation,
  handleNotesModeChange,
  buildNotesExportPrecheck,
  buildNotesExportTranslationPlan,
  exportAllNotes,
  captureNotesOnlyMetadata,
  playNote,
  noteCanonicalUrl,
  normalizeExportMediaKeys,
  filterNoteGroupsByMediaKeys,
  buildFrozenExportIntent,
  renderExportTranslationProgress,
  exportRunIsCurrent,
  sourceBatchMessage,
  collectMissingNoteTitleWork,
  applyNoteTitleTranslations,
  groupTranscriptEntries,
  formatTimecode,
  sidepanelMvpBindSession,
  sidepanelMvpBeginEvent,
  sidepanelMvpHandleAction,
  sidepanelMvpResolveTranscript,
  getSidepanelMvpState: () => sidepanelMvpState,
};
