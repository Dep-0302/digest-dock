const HELPER_ENDPOINT = "http://127.0.0.1:8765/v1/transcript";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const originElement = document.getElementById("origin");
const tokenInput = document.getElementById("token");
const languageInput = document.getElementById("language");
const runButton = document.getElementById("runBtn");
const healthButton = document.getElementById("healthBtn");
const statusElement = document.getElementById("status");
const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");

originElement.textContent = extensionOrigin;

function videoIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.hostname !== "www.youtube.com" || url.pathname !== "/watch") return null;
    const videoId = url.searchParams.get("v");
    return /^[0-9A-Za-z_-]{11}$/.test(videoId || "") ? videoId : null;
  } catch {
    return null;
  }
}

function normalizeLanguage(value) {
  const language = String(value || "").trim().replace(/_/g, "-");
  return language && language.length <= 35 &&
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)
    ? language
    : null;
}

async function activeContext(expectedVideoId = null) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const candidates = tabs
    .map((tab) => ({
      tab,
      videoId: videoIdFromUrl(tab.pendingUrl || tab.url),
    }))
    .filter(
      ({ videoId }) =>
        videoId && (!expectedVideoId || videoId === expectedVideoId),
    )
    .sort(
      (left, right) =>
        Number(right.tab.lastAccessed || 0) - Number(left.tab.lastAccessed || 0),
    );
  const { tab, videoId } = candidates[0] || {};
  if (!tab?.id || !videoId || (expectedVideoId && videoId !== expectedVideoId)) {
    throw new Error("PAGE_CONTEXT_CHANGED");
  }
  const player = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: () =>
      document.querySelector("#movie_player")?.getPlayerResponse?.()?.videoDetails
        ?.videoId || null,
  });
  if (player?.[0]?.result !== videoId) throw new Error("PAGE_CONTEXT_CHANGED");
  return { tabId: tab.id, videoId };
}

async function runHelper() {
  const token = tokenInput.value.trim();
  if (token.length < 32 || token.length > 256 || /\s/.test(token)) {
    throw new Error("请输入当前助手使用的 32-256 位配对 Token。");
  }
  const { videoId } = await activeContext();
  const requestId = `manual-${Date.now()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const started = Date.now();
  try {
    const response = await fetch(HELPER_ENDPOINT, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-DigestDock-Helper-Origin": extensionOrigin,
        "X-DigestDock-Helper-Token": token,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        requestId,
        runId: requestId,
        providerId: "local-helper",
        providerVariant: "youtube-transcript-api",
        videoId,
        preferredLanguage: normalizeLanguage(languageInput.value),
        trackKind: "manual-first",
      }),
      signal: controller.signal,
    });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error("INVALID_RESPONSE");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("INVALID_RESPONSE");
    }
    const payload = text ? JSON.parse(text) : {};
    await activeContext(videoId);
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.errorCode || `HTTP_${response.status}`);
    }
    if (
      payload.schemaVersion !== 1 ||
      payload.providerId !== "local-helper" ||
      payload.providerVariant !== "youtube-transcript-api" ||
      payload.runId !== requestId ||
      payload.requestId !== requestId ||
      payload.videoId !== videoId
    ) {
      throw new Error("INVALID_RESPONSE");
    }
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    if (!segments.length) throw new Error("EMPTY_TRANSCRIPT");
    let previousStart = -Infinity;
    let characterCount = 0;
    for (const [index, segment] of segments.entries()) {
      const textValue = String(segment?.text || "").trim();
      const start = Number(segment?.start);
      const duration = Number(segment?.duration);
      if (
        !textValue ||
        !Number.isFinite(start) ||
        !Number.isFinite(duration) ||
        start < previousStart ||
        start < 0 ||
        duration < 0
      ) {
        throw new Error(`INVALID_RESPONSE:${index}`);
      }
      previousStart = start;
      characterCount += textValue.length;
    }
    return {
      providerId: "local-helper",
      providerVariant: "youtube-transcript-api",
      videoId,
      language: normalizeLanguage(payload.language),
      languageEvidence: payload.language ? "verified" : "unknown",
      segmentCount: segments.length,
      characterCount,
      firstStart: Number(segments[0].start),
      lastStart: Number(segments.at(-1).start),
      elapsedMs: Date.now() - started,
      providerInitiated: {
        loopback: 1,
      },
    };
  } finally {
    clearTimeout(timeout);
    tokenInput.value = "";
  }
}

async function checkHealth() {
  const token = tokenInput.value.trim();
  if (token.length < 32 || token.length > 256 || /\s/.test(token)) {
    throw new Error("请输入当前助手使用的 32-256 位配对 Token。");
  }
  const response = await fetch("http://127.0.0.1:8765/health", {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    headers: {
      "X-DigestDock-Helper-Origin": extensionOrigin,
      "X-DigestDock-Helper-Token": token,
    },
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true || payload.networkRequests !== 0) {
    throw new Error(payload?.errorCode || `HTTP_${response.status}`);
  }
  return payload;
}

healthButton.addEventListener("click", async () => {
  healthButton.disabled = true;
  try {
    statusElement.textContent = JSON.stringify(await checkHealth(), null, 2);
  } catch (error) {
    statusElement.textContent = String(error?.message || error);
  } finally {
    healthButton.disabled = false;
  }
});

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  statusElement.textContent = "正在调用本机 127.0.0.1 助手…";
  try {
    statusElement.textContent = JSON.stringify(await runHelper(), null, 2);
  } catch (error) {
    statusElement.textContent = JSON.stringify(
      {
        ok: false,
        providerId: "local-helper",
        errorCode:
          error?.name === "AbortError"
            ? "TIMEOUT"
            : String(error?.message || error).slice(0, 80),
      },
      null,
      2,
    );
  } finally {
    tokenInput.value = "";
    runButton.disabled = false;
  }
});
