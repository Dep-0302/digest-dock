importScripts("core.js");

const STORAGE_KEY = "passiveTranscriptCaptures:v1";
const MAX_CAPTURE_ENTRIES = 6;
const MAX_CAPTURE_STATE_BYTES = 6 * 1024 * 1024;
let captureMutationQueue = Promise.resolve();

function enqueueMutation(operation) {
  const task = captureMutationQueue.then(operation, operation);
  captureMutationQueue = task.catch(() => {});
  return task;
}

chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(() => {});

async function readCaptures() {
  const value = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
  return Array.isArray(value) ? value : [];
}

async function writeCaptures(entries) {
  const bounded = [...entries].sort((left, right) =>
    String(left.capturedAt).localeCompare(String(right.capturedAt)),
  );
  while (
    bounded.length > MAX_CAPTURE_ENTRIES ||
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength >
      MAX_CAPTURE_STATE_BYTES
  ) {
    bounded.shift();
  }
  await chrome.storage.session.set({ [STORAGE_KEY]: bounded });
  return bounded;
}

async function clearTabCaptures(tabId) {
  const captures = await readCaptures();
  await writeCaptures(captures.filter((capture) => capture.tabId !== tabId));
}

function videoIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.hostname !== "www.youtube.com" || url.pathname !== "/watch") {
      return null;
    }
    const videoId = url.searchParams.get("v");
    return /^[0-9A-Za-z_-]{11}$/.test(videoId || "") ? videoId : null;
  } catch {
    return null;
  }
}

async function recordCapture(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) {
    return { ok: false, errorCode: "INVALID_RESPONSE" };
  }
  const tab = await chrome.tabs.get(tabId);
  const currentVideoId = videoIdFromUrl(tab.pendingUrl || tab.url);
  if (!currentVideoId) {
    return { ok: false, errorCode: "PAGE_CONTEXT_CHANGED" };
  }
  let result;
  try {
    result = PASSIVE_TRANSCRIPT_CORE.normalizeCapture(
      message.capture,
      currentVideoId,
    );
  } catch (error) {
    return {
      ok: false,
      errorCode: error?.code || "INVALID_RESPONSE",
      message: String(error?.message || error).slice(0, 300),
    };
  }
  const {
    transcriptText: _plainText,
    transcriptTextTimestamped: _timestampedText,
    ...sessionResult
  } = result;
  const captures = await readCaptures();
  const identity = [
    tabId,
    result.videoId,
    result.language || "unknown",
    result.diagnostics?.trackKind || "unknown",
  ].join(":");
  const next = captures.filter((capture) => capture.identity !== identity);
  next.push({
    ...sessionResult,
    identity,
    tabId,
    capturedAt: new Date().toISOString(),
  });
  const storedEntries = await writeCaptures(next);
  if (!storedEntries.some((capture) => capture.identity === identity)) {
    return { ok: false, errorCode: "RESPONSE_TOO_LARGE" };
  }
  return {
    ok: true,
    providerId: result.providerId,
    videoId: result.videoId,
    segmentCount: result.transcript.length,
  };
}

async function getCapture(tabId, preferredLanguage = null, trackKind = "any") {
  if (!Number.isInteger(tabId)) {
    return { ok: false, errorCode: "INVALID_RESPONSE" };
  }
  const captures = await readCaptures();
  const tab = await chrome.tabs.get(tabId);
  const currentVideoId = videoIdFromUrl(tab.pendingUrl || tab.url);
  if (!currentVideoId) {
    await clearTabCaptures(tabId);
    return { ok: false, errorCode: "PAGE_CONTEXT_CHANGED" };
  }
  const allMatches = captures.filter(
    (capture) =>
      capture.tabId === tabId && capture.videoId === currentVideoId,
  );
  const normalizedLanguage = PASSIVE_TRANSCRIPT_CORE.normalizeLanguage(
    preferredLanguage,
  );
  const requestedPrimary = normalizedLanguage?.toLowerCase().split("-")[0];
  const normalizedKind = ["manual", "asr", "any"].includes(trackKind)
    ? trackKind
    : "any";
  const matches = allMatches
    .filter(
      (capture) =>
        (!requestedPrimary ||
          PASSIVE_TRANSCRIPT_CORE.normalizeLanguage(capture.language)
            ?.toLowerCase()
            .split("-")[0] === requestedPrimary) &&
        (normalizedKind === "any" ||
          capture.diagnostics?.trackKind === normalizedKind),
    )
    .sort((left, right) =>
      Number(
        PASSIVE_TRANSCRIPT_CORE.normalizeLanguage(left.language) !==
          normalizedLanguage,
      ) -
        Number(
          PASSIVE_TRANSCRIPT_CORE.normalizeLanguage(right.language) !==
            normalizedLanguage,
        ) ||
      String(right.capturedAt).localeCompare(String(left.capturedAt)),
    );
  const stored = matches[0] || null;
  if (!stored) {
    return {
      ok: allMatches.length === 0,
      errorCode: allMatches.length ? "TRACK_UNAVAILABLE" : null,
      capture: null,
      captureCount: allMatches.length,
    };
  }
  return { ok: true, capture: stored, captureCount: allMatches.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "recordPassiveTimedtextCapture") {
    enqueueMutation(() => recordCapture(message, sender)).then(sendResponse).catch((error) =>
      sendResponse({
        ok: false,
        errorCode: "INVALID_RESPONSE",
        message: String(error?.message || error).slice(0, 300),
      }),
    );
    return true;
  }
  if (message?.action === "getPassiveTimedtextCapture") {
    captureMutationQueue
      .then(() =>
        getCapture(
          message.tabId,
          message.preferredLanguage,
          message.trackKind,
        ),
      )
      .then(sendResponse)
      .catch((error) =>
      sendResponse({
        ok: false,
        errorCode: "INVALID_RESPONSE",
        message: String(error?.message || error).slice(0, 300),
      }),
    );
    return true;
  }
  if (message?.action === "clearPassiveTimedtextCapture") {
    enqueueMutation(() => clearTabCaptures(message.tabId))
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          errorCode: "INVALID_RESPONSE",
          message: String(error?.message || error).slice(0, 300),
        }),
      );
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  enqueueMutation(() => clearTabCaptures(tabId)).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueMutation(() => clearTabCaptures(tabId)).catch(() => {});
});
