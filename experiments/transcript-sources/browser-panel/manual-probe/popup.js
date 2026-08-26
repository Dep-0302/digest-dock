const statusElement = document.getElementById("status");

async function context() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("没有活动标签页。");
  const url = new URL(tab.pendingUrl || tab.url || "");
  const videoId = url.hostname === "www.youtube.com" && url.pathname === "/watch"
    ? url.searchParams.get("v")
    : null;
  if (!/^[0-9A-Za-z_-]{11}$/.test(videoId || "")) {
    throw new Error("请先切换到标准 YouTube 视频页。");
  }
  const player = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: () => document.querySelector("#movie_player")?.getPlayerResponse?.()?.videoDetails?.videoId || null,
  });
  if (player?.[0]?.result !== videoId) {
    throw new Error("播放器仍在切换视频，请等待稳定后重试。");
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    files: ["reader.js"],
  });
  return { tabId: tab.id, videoId };
}

async function callReader(method) {
  const { tabId, videoId } = await context();
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (name, expectedVideoId) => globalThis.PANEL_TRANSCRIPT_READER[name](expectedVideoId),
    args: [method, videoId],
  });
  return result?.[0]?.result || { ok: false, errorCode: "INVALID_RESPONSE" };
}

function safeSummary(result) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return JSON.stringify(
    {
      ok: result?.ok === true,
      errorCode: result?.errorCode || null,
      providerId: result?.providerId || "youtube-panel",
      providerVariant: result?.providerVariant || "manual-rendered-panel",
      videoId: result?.videoId || null,
      visibleRowCount: result?.visibleRowCount || 0,
      collectedRowCount: result?.collectedRowCount || rows.length,
      sawTop: result?.sawTop || false,
      sawBottom: result?.sawBottom || false,
      complete: result?.complete === true,
      completenessEvidence: result?.completenessEvidence || "incomplete",
      generation: Number.isInteger(result?.generation) ? result.generation : null,
      coverageRatio: Number.isFinite(result?.coverageRatio)
        ? result.coverageRatio
        : 0,
      collects: result?.collects || 0,
      firstStart: rows[0]?.start ?? null,
      lastStart: rows.at(-1)?.start ?? null,
      characterCount: rows.reduce((sum, row) => sum + String(row.text || "").length, 0),
      providerInitiated: result?.providerInitiated || {
        youtubePlayer: 0,
        youtubeTimedtext: 0,
        thirdParty: 0,
        loopback: 0,
      },
    },
    null,
    2,
  );
}

async function run(method) {
  try {
    statusElement.textContent = safeSummary(await callReader(method));
  } catch (error) {
    statusElement.textContent = String(error?.message || error);
  }
}

document.getElementById("collectBtn").addEventListener("click", () => run("collect"));
document.getElementById("finishBtn").addEventListener("click", () => run("finalize"));
document.getElementById("resetBtn").addEventListener("click", () => run("reset"));
