const elements = {
  runButton: document.getElementById("runButton"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  videoTitle: document.getElementById("videoTitle"),
  videoPart: document.getElementById("videoPart"),
  mediaKey: document.getElementById("mediaKey"),
  trackSummary: document.getElementById("trackSummary"),
  selectedTrack: document.getElementById("selectedTrack"),
  segmentCount: document.getElementById("segmentCount"),
  sample: document.getElementById("sample"),
};

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`.trim();
}

function describeError(error) {
  switch (error?.code) {
    case "LOGIN_REQUIRED":
      return "检测到字幕登录限制。请在当前 Chrome 登录 B 站、刷新视频页后重试。";
    case "NO_SUBTITLE":
      return "这个视频没有独立字幕轨；画面硬字幕不在本次验证范围内。";
    case "UNSUPPORTED_URL":
      return "请先打开标准的 www.bilibili.com/video/BV... 视频页。";
    default:
      return error?.message || "验证失败。";
  }
}

function renderResult(result) {
  const { media, tracks, selectedTrack, transcript } = result;
  elements.videoTitle.textContent = media.creator
    ? `${media.title} · ${media.creator}`
    : media.title;
  elements.videoPart.textContent = `P${media.page} · ${media.partTitle || "未命名分P"}`;
  elements.mediaKey.textContent = media.mediaKey;
  elements.trackSummary.textContent = tracks
    .map((track) => `${track.label}${track.isAi ? "（AI）" : "（人工）"}`)
    .join("、");
  elements.selectedTrack.textContent = `${selectedTrack.label}${
    selectedTrack.isAi ? "（AI）" : "（人工）"
  }`;
  elements.segmentCount.textContent = String(transcript.length);
  elements.sample.textContent = transcript
    .slice(0, 8)
    .map(
      (entry) =>
        `[${BILI_SUBTITLE_POC.formatTimestamp(entry.start)}] ${entry.text}`,
    )
    .join("\n");
  elements.result.hidden = false;
}

async function runVerification() {
  elements.runButton.disabled = true;
  elements.result.hidden = true;
  setStatus("正在读取视频信息和字幕轨…");

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.url) throw new Error("无法读取当前标签页地址。");

    const result = await BILI_SUBTITLE_POC.verifyVideo(tab.url);
    renderResult(result);
    setStatus(
      `验证通过：当前分P取得 ${result.tracks.length} 条字幕轨、${result.transcript.length} 个有效片段。`,
      "success",
    );
  } catch (error) {
    setStatus(describeError(error), "error");
  } finally {
    elements.runButton.disabled = false;
  }
}

elements.runButton.addEventListener("click", runVerification);
runVerification();
