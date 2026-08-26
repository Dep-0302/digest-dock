const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const API_ENDPOINT = "https://api.supadata.ai/v1/transcript";
const POLL_LIMIT = 60;
const keyInput = document.getElementById("apiKey");
const languageInput = document.getElementById("language");
const runButton = document.getElementById("runBtn");
const statusElement = document.getElementById("status");

async function activeContext(expectedVideoId = null) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const candidates = tabs
    .map((tab) => ({
      tab,
      videoId: SUPADATA_PROBE_CORE.videoIdFromUrl(
        tab.pendingUrl || tab.url,
      ),
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

async function boundedJson(url, apiKey, signal) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    headers: { "x-api-key": apiKey },
    signal,
  });
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("INVALID_RESPONSE");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("INVALID_RESPONSE");
  }
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("INVALID_RESPONSE");
  }
  return { ok: response.ok, status: response.status, body };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProbe() {
  const apiKey = keyInput.value.trim();
  const preferredLanguage = SUPADATA_PROBE_CORE.normalizeLanguage(
    languageInput.value,
  );
  if (apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey)) {
    throw new Error("请输入有效的 Supadata API Key。");
  }
  const { videoId } = await activeContext();
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), 90_000);
  const started = Date.now();
  let requestCount = 0;
  try {
    const url = new URL(API_ENDPOINT);
    url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
    url.searchParams.set("text", "false");
    url.searchParams.set("mode", "native");
    if (preferredLanguage) url.searchParams.set("lang", preferredLanguage);
    requestCount += 1;
    let response = await boundedJson(url.href, apiKey, controller.signal);
    if (response.status === 202) {
      const jobId = String(response.body?.jobId || "");
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(jobId)) {
        throw new Error("INVALID_RESPONSE");
      }
      let completed = false;
      for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
        await delay(1000);
        await activeContext(videoId);
        requestCount += 1;
        response = await boundedJson(
          `${API_ENDPOINT}/${encodeURIComponent(jobId)}`,
          apiKey,
          controller.signal,
        );
        if (response.status === 401) throw new Error("INVALID_KEY");
        if (response.status === 429) throw new Error("RATE_LIMITED");
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        if (response.body?.status === "completed") {
          completed = true;
          break;
        }
        if (response.body?.status === "failed") throw new Error("INVALID_RESPONSE");
      }
      if (!completed) throw new Error("TIMEOUT");
    }
    await activeContext(videoId);
    if (response.status === 206 || response.status === 404) {
      throw new Error("NO_TRANSCRIPT");
    }
    if (response.status === 401) throw new Error("INVALID_KEY");
    if (response.status === 429) throw new Error("RATE_LIMITED");
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const normalized = SUPADATA_PROBE_CORE.normalizePayload(
      response.body,
      preferredLanguage,
    );
    return SUPADATA_PROBE_CORE.summarize(
      normalized,
      videoId,
      Date.now() - started,
      requestCount,
    );
  } finally {
    clearTimeout(hardTimeout);
    keyInput.value = "";
  }
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  statusElement.textContent = "正在执行本次已确认的 Supadata 请求…";
  try {
    statusElement.textContent = JSON.stringify(await runProbe(), null, 2);
  } catch (error) {
    statusElement.textContent = JSON.stringify(
      {
        ok: false,
        providerId: "supadata-native",
        errorCode:
          error?.name === "AbortError"
            ? "TIMEOUT"
            : String(error?.message || error).slice(0, 80),
      },
      null,
      2,
    );
  } finally {
    keyInput.value = "";
    runButton.disabled = false;
  }
});
