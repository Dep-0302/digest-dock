const elements = {
  language: document.getElementById("languageInput"),
  mode: document.getElementById("modeSelect"),
  run: document.getElementById("runButton"),
  status: document.getElementById("status"),
  success: document.getElementById("successCard"),
  videoId: document.getElementById("videoIdValue"),
  client: document.getElementById("clientValue"),
  track: document.getElementById("trackValue"),
  segmentCount: document.getElementById("segmentCountValue"),
  samples: document.getElementById("sampleOutput"),
  attempts: document.getElementById("attemptRows"),
  diagnostic: document.getElementById("diagnosticOutput"),
  copy: document.getElementById("copyButton"),
};

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`.trim();
}

function summarizeFormats(formats) {
  if (!Array.isArray(formats) || !formats.length) return "—";
  return formats
    .map((item) => {
      if (item.error) return `${item.format}:${item.error.code}`;
      return `${item.format}:${item.status}/${item.bytes}B/${item.segmentCount || 0}`;
    })
    .join(" · ");
}

function renderAttempts(attempts) {
  elements.attempts.textContent = "";
  if (!Array.isArray(attempts) || !attempts.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "muted";
    cell.textContent = "没有可用诊断";
    row.appendChild(cell);
    elements.attempts.appendChild(row);
    return;
  }
  attempts.forEach((attempt) => {
    const row = document.createElement("tr");
    const values = [
      attempt.client,
      String(attempt.trackCount || 0),
      attempt.outcome || attempt.error?.code || "—",
      summarizeFormats(attempt.formats),
    ];
    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    elements.attempts.appendChild(row);
  });
}

function renderDiagnostic(value) {
  elements.diagnostic.value = JSON.stringify(value, null, 2);
  elements.copy.disabled = false;
}

function renderSuccess(result) {
  elements.success.hidden = false;
  elements.videoId.textContent = result.videoId;
  elements.client.textContent = result.sourceAttempt;
  elements.track.textContent = `${result.selectedTrack.language} · ${result.selectedTrack.kind}`;
  elements.segmentCount.textContent = String(result.segmentCount);
  elements.samples.textContent = result.samples
    .map(
      (entry) =>
        `[${YOUTUBE_SUBTITLE_VERIFIER.formatTimestamp(entry.start)}] ${entry.text}`,
    )
    .join("\n");
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function assertCurrentVideo(initialTab, initialMedia, attempts = []) {
  const latestTab = await currentTab();
  let latestMedia = null;
  try {
    latestMedia = YOUTUBE_SUBTITLE_VERIFIER.parseVideoUrl(latestTab?.url || "");
  } catch {
    // Converted to PAGE_CHANGED below.
  }
  if (
    latestTab?.id !== initialTab?.id ||
    latestMedia?.videoId !== initialMedia?.videoId
  ) {
    throw new YOUTUBE_SUBTITLE_VERIFIER.VerifierError(
      "PAGE_CHANGED",
      "验证期间当前标签页或视频已变化，已拒绝旧结果。",
      { attempts },
    );
  }
}

async function verifyInIsolatedTab(tab, url, callOptions) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    files: ["verifier.js"],
  });
  const execution = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: async (videoUrl, options) => {
      const verifier = globalThis.YOUTUBE_SUBTITLE_VERIFIER;
      if (!verifier?.verifyVideo || !verifier?.diagnosticsFromError) {
        return {
          ok: false,
          code: "PROBE_FAILED",
          message: "页面隔离环境中的字幕验证器不可用。",
          diagnostics: { attempts: [] },
        };
      }
      try {
        const result = await verifier.verifyVideo(videoUrl, options);
        return {
          ok: true,
          result: {
            videoId: result.videoId,
            language: result.language,
            selectedTrack: result.selectedTrack,
            sourceAttempt: result.sourceAttempt,
            segmentCount: result.transcript.length,
            samples: result.transcript.slice(0, 5),
            diagnostics: result.diagnostics,
          },
        };
      } catch (error) {
        return {
          ok: false,
          code: error?.code || "PROBE_FAILED",
          message: String(error?.message || "验证失败。"),
          diagnostics: verifier.diagnosticsFromError(error),
        };
      }
    },
    args: [url, callOptions],
  });
  const payload = execution?.[0]?.result;
  if (!payload?.ok) {
    const error = new Error(payload?.message || "页面隔离验证失败。");
    error.code = payload?.code || "PROBE_FAILED";
    error.attempts = Array.isArray(payload?.diagnostics?.attempts)
      ? payload.diagnostics.attempts
      : [];
    throw error;
  }
  return payload.result;
}

async function runVerification() {
  elements.run.disabled = true;
  elements.copy.disabled = true;
  elements.success.hidden = true;
  elements.samples.textContent = "";
  setStatus("正在依次测试 IOS、ANDROID_VR、MWEB、ANDROID…");

  let initialTab = null;
  let initialMedia = null;
  try {
    initialTab = await currentTab();
    if (!initialTab?.url) throw new Error("无法读取当前标签页地址。");
    initialMedia = YOUTUBE_SUBTITLE_VERIFIER.parseVideoUrl(initialTab.url);
    const language = elements.language.value.trim();
    if (!/^[0-9A-Za-z-]{2,20}$/.test(language)) {
      throw new Error("语言代码格式无效，例如 en、zh-TW、ja。");
    }
    const result = await verifyInIsolatedTab(initialTab, initialTab.url, {
      language,
      mode: elements.mode.value,
    });
    await assertCurrentVideo(
      initialTab,
      initialMedia,
      result.diagnostics.attempts,
    );
    renderSuccess(result);
    renderAttempts(result.diagnostics.attempts);
    renderDiagnostic({
      runAt: new Date().toISOString(),
      success: true,
      ...result.diagnostics,
    });
    setStatus(
      `验证通过：${result.sourceAttempt} 取得 ${result.segmentCount} 个有效片段。`,
      "success",
    );
  } catch (error) {
    let effectiveError = error;
    if (initialTab && initialMedia && error?.code !== "PAGE_CHANGED") {
      try {
        await assertCurrentVideo(
          initialTab,
          initialMedia,
          Array.isArray(error?.attempts) ? error.attempts : [],
        );
      } catch (contextError) {
        effectiveError = contextError;
      }
    }
    const diagnostics =
      YOUTUBE_SUBTITLE_VERIFIER.diagnosticsFromError(effectiveError);
    renderAttempts(diagnostics.attempts);
    renderDiagnostic({
      runAt: new Date().toISOString(),
      success: false,
      ...diagnostics,
    });
    setStatus(effectiveError?.message || "验证失败。", "error");
  } finally {
    elements.run.disabled = false;
  }
}

elements.run.addEventListener("click", runVerification);
elements.copy.addEventListener("click", async () => {
  let copied = false;
  try {
    await navigator.clipboard.writeText(elements.diagnostic.value);
    copied = true;
  } catch {
    elements.diagnostic.focus();
    elements.diagnostic.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
  }
  if (copied) {
    setStatus("已复制脱敏诊断结果。", "success");
  } else {
    elements.diagnostic.focus();
    elements.diagnostic.select();
    setStatus("自动复制失败，已选中诊断文本。", "error");
  }
});
