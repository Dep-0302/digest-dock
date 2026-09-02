const languageInput = document.getElementById("language");
const runButton = document.getElementById("run");
const output = document.getElementById("output");

async function currentVideoTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(String(tab?.url || ""));
  const videoId = url.hostname === "www.youtube.com" && url.pathname === "/watch"
    ? String(url.searchParams.get("v") || "")
    : "";
  if (!tab?.id || !/^[0-9A-Za-z_-]{11}$/.test(videoId)) {
    throw new Error("请先打开一个标准 YouTube 视频页。");
  }
  return { tabId: tab.id, videoId };
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  output.textContent = "正在运行一次真实探针…";
  try {
    const language = languageInput.value.trim();
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)) {
      throw new Error("语言代码格式无效，例如 zh、zh-Hant、en。");
    }
    const { tabId, videoId } = await currentVideoTab();
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["active-ios-single.js", "diagnostics-readback.js"],
    });
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      args: [videoId, language],
      func: async (expectedVideoId, requestedLanguage) => {
        const probe = globalThis.DIGESTDOCK_YOUTUBE_ACTIVE_IOS_SINGLE_PROBE;
        const diagnostics = globalThis.DIGESTDOCK_AUTO_READ_DIAGNOSTICS;
        if (!probe?.run || !diagnostics?.project) {
          return { status: "PROBE_UNAVAILABLE" };
        }
        const result = await probe.run({
          runId: `popup-${Date.now()}`,
          videoId: expectedVideoId,
          language: requestedLanguage,
          trackKind: "manual-first",
        });
        return diagnostics.project(result, {
          videoId: expectedVideoId,
          language: requestedLanguage,
        });
      },
    });
    output.textContent = JSON.stringify(execution?.[0]?.result || null, null, 2);
  } catch (error) {
    output.textContent = JSON.stringify({
      status: "PROBE_ERROR",
      message: String(error?.message || error).slice(0, 300),
    }, null, 2);
  } finally {
    runButton.disabled = false;
  }
});
