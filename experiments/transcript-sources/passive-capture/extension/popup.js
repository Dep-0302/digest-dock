let enabled = true;

const statusElement = document.getElementById("status");
const refreshButton = document.getElementById("refreshBtn");
const toggleButton = document.getElementById("toggleBtn");
const clearButton = document.getElementById("clearBtn");
const languageInput = document.getElementById("language");
const trackKindInput = document.getElementById("trackKind");

async function activeYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentUrl = tab?.pendingUrl || tab?.url || "";
  if (!tab?.id || !/^https:\/\/www\.youtube\.com\/watch\?/.test(currentUrl)) {
    throw new Error("请先切换到标准 YouTube 视频页。");
  }
  return tab;
}

function summarize(capture, captureCount = 0) {
  if (!capture) {
    return "尚未观察到当前视频的新字幕响应。\nrequestsInitiated: 0";
  }
  const first = capture.transcript?.[0] || null;
  const last = capture.transcript?.at(-1) || null;
  return JSON.stringify(
    {
      providerId: capture.providerId,
      videoId: capture.videoId,
      language: capture.language,
      segmentCount: capture.transcript?.length || 0,
      capturedAt: capture.capturedAt,
      captureCount,
      first: first
        ? { start: first.start, textCharacters: first.text.length }
        : null,
      last: last
        ? { start: last.start, textCharacters: last.text.length }
        : null,
      diagnostics: capture.diagnostics,
    },
    null,
    2,
  );
}

async function refresh() {
  try {
    const tab = await activeYouTubeTab();
    const result = await chrome.runtime.sendMessage({
      action: "getPassiveTimedtextCapture",
      tabId: tab.id,
      preferredLanguage: languageInput.value.trim() || null,
      trackKind: trackKindInput.value,
    });
    if (!result?.ok) {
      throw new Error(result?.errorCode || "无法读取当前实验结果。");
    }
    statusElement.textContent = summarize(result.capture, result.captureCount);
  } catch (error) {
    statusElement.textContent = String(error?.message || error);
  }
}

refreshButton.addEventListener("click", refresh);

toggleButton.addEventListener("click", async () => {
  try {
    const tab = await activeYouTubeTab();
    enabled = !enabled;
    await chrome.tabs.sendMessage(tab.id, {
      action: "setPassiveCaptureEnabled",
      enabled,
    });
    toggleButton.textContent = enabled ? "暂停观察" : "恢复观察";
    statusElement.textContent = enabled
      ? "观察已恢复。为保证 document_start 覆盖，请刷新视频页。"
      : "观察已暂停；页面原始 XHR/fetch 已恢复。";
  } catch (error) {
    statusElement.textContent = String(error?.message || error);
  }
});

clearButton.addEventListener("click", async () => {
  try {
    const tab = await activeYouTubeTab();
    await chrome.runtime.sendMessage({
      action: "clearPassiveTimedtextCapture",
      tabId: tab.id,
    });
    statusElement.textContent = "已清除当前标签页的会话结果。";
  } catch (error) {
    statusElement.textContent = String(error?.message || error);
  }
});

refresh();
