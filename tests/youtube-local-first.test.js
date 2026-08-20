const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const bilibiliAdapter = require("../bilibili.js");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function localResult(language = "en") {
  return {
    transcript: [
      { text: "Local line", start: 0, duration: 2, language },
    ],
    transcriptText: "Local line",
    transcriptTextTimestamped: "[0:00] Local line",
    language,
    selectedTrack: {
      index: 0,
      language,
      kind: "manual",
      isGenerated: false,
      label: "Test track",
    },
    sourceAttempt: "PAGE",
    attempts: [{ sourceAttempt: "PAGE", outcome: "transcript" }],
  };
}

function loadBackground({
  settings = {
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "",
  },
  youtubeAdapter,
  executeScript = async () => [{ result: null }],
  tabsGet = async (tabId) => ({
    id: tabId,
    url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  }),
  fetchImpl = async () => {
    throw new Error("unexpected fetch");
  },
  storageGet,
  storageSet = async () => {},
  bilibiliAdapterImpl = bilibiliAdapter,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const listeners = { addListener() {} };
  const runtimeMessageListeners = [];
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    Intl,
    AbortController,
    fetch: fetchImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get:
            storageGet ||
            (async (key) =>
              key === "ytd_settings" ? { ytd_settings: settings } : {}),
          set: storageSet,
          remove: async () => {},
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: async () => {},
      },
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            runtimeMessageListeners.push(listener);
          },
        },
        openOptionsPage() {},
        getURL: (resource) => `chrome-extension://test/${resource}`,
        sendMessage: async () => ({ success: true }),
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        get: tabsGet,
      },
      scripting: { executeScript },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
    YOUTUBE_TRANSCRIPT_ADAPTER: youtubeAdapter,
    BILIBILI_ADAPTER: bilibiliAdapterImpl,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return {
    helpers: sandbox.__YTD_TRANSLATION_TESTING__,
    runtimeMessageListeners,
  };
}

function pageSnapshot(videoId = "jNQXAC9IVRw", language = "en") {
  return [
    {
      result: {
        ok: true,
        videoId,
        sourceLanguage: language,
        tracks: [
          {
            baseUrl:
              `https://www.youtube.com/api/timedtext?v=${videoId}&signature=secret`,
            languageCode: language,
            vssId: `.${language}`,
            name: { simpleText: language },
            isDefault: true,
          },
        ],
      },
    },
  ];
}

test("local PAGE extraction short-circuits Supadata and preserves the shared contract", async () => {
  let adapterInput = null;
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: {
      aiApiKey: "test-key",
      supadataApiKey: "optional-key",
    },
    youtubeAdapter: {
      async fetchTranscript(input) {
        adapterInput = input;
        return localResult("en");
      },
    },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
  });

  const result = await helpers.handleFetchYoutubeTranscriptLocalFirst(
    "jNQXAC9IVRw",
    "en-US",
    42,
  );

  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-timedtext");
  assert.equal(result.transcriptText, "Local line");
  assert.equal(result.transcriptTextTimestamped, "[0:00] Local line");
  assert.equal(result.language, "en");
  assert.equal(result.selectedTrack.kind, "manual");
  assert.equal(adapterInput.videoId, "jNQXAC9IVRw");
  assert.equal(adapterInput.preferredLanguage, "en-US");
  assert.equal(adapterInput.captionTracks.length, 1);
  assert.equal(supadataCalls, 0);
});

test("an empty preference uses the page default source language", async () => {
  let adapterInput = null;
  const { helpers } = loadBackground({
    youtubeAdapter: {
      async fetchTranscript(input) {
        adapterInput = input;
        return localResult("zh-TW");
      },
    },
    executeScript: async () => pageSnapshot("jNQXAC9IVRw", "zh-TW"),
  });
  const result = await helpers.handleFetchYoutubeTranscriptLocalFirst(
    "jNQXAC9IVRw",
    "",
    42,
  );
  assert.equal(result.success, true);
  assert.equal(adapterInput.preferredLanguage, "zh-TW");
  assert.equal(result.language, "zh-TW");
});

test("explicit consent still prefers a recovered local transcript", async () => {
  let providerCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    youtubeAdapter: {
      async fetchTranscript() {
        return localResult("en");
      },
    },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({});
    },
  });

  const result = await helpers.handleFetchYoutubeTranscriptLocalFirst(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );

  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-timedtext");
  assert.equal(providerCalls, 0);
});

test("local failure requires explicit consent before Supadata is called", async () => {
  let supadataCalls = 0;
  const localError = Object.assign(new Error("empty local captions"), {
    code: "EMPTY_TRANSCRIPT",
    attempts: [{ sourceAttempt: "PAGE", outcome: "empty-caption-body" }],
  });
  const withFallback = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    youtubeAdapter: {
      async fetchTranscript() {
        throw localError;
      },
    },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async (url) => {
      assert.match(String(url), /api\.supadata\.ai/);
      supadataCalls += 1;
      return jsonResponse({
        content: [
          { text: "Fallback line", offset: 1000, duration: 2000, lang: "en" },
        ],
        lang: "en",
      });
    },
  });
  const consentRequired =
    await withFallback.helpers.handleFetchYoutubeTranscriptLocalFirst(
      "jNQXAC9IVRw",
      "en",
      42,
    );
  assert.equal(consentRequired.success, false);
  assert.equal(consentRequired.error, "SUPADATA_CONSENT_REQUIRED");
  assert.equal(consentRequired.localError, "EMPTY_TRANSCRIPT");
  assert.equal(supadataCalls, 0);

  const fallback = await withFallback.helpers.handleFetchYoutubeTranscriptLocalFirst(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(fallback.success, true);
  assert.equal(fallback.source, "supadata");
  assert.equal(fallback.sourceAttempt, "SUPADATA");
  assert.equal(fallback.transcript[0].text, "Fallback line");
  assert.equal(supadataCalls, 1);
});

test("Supadata stays unused without a configured key even if consent is requested", async () => {
  let providerCalls = 0;
  const localError = Object.assign(new Error("empty local captions"), {
    code: "EMPTY_TRANSCRIPT",
  });
  const noFallback = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "" },
    youtubeAdapter: {
      async fetchTranscript() {
        throw localError;
      },
    },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({});
    },
  });
  const failed = await noFallback.helpers.handleFetchYoutubeTranscriptLocalFirst(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(failed.success, false);
  assert.equal(failed.error, "SUPADATA_NOT_CONFIGURED");
  assert.equal(failed.localError, "EMPTY_TRANSCRIPT");
  assert.match(failed.message, /可选密钥/);
  assert.equal(providerCalls, 0);
});

test("only strict boolean consent can authorize the optional provider", async () => {
  let providerCalls = 0;
  const localError = Object.assign(new Error("empty local captions"), {
    code: "EMPTY_TRANSCRIPT",
  });
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    youtubeAdapter: {
      async fetchTranscript() {
        throw localError;
      },
    },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({
        content: [
          { text: "Fallback line", offset: 0, duration: 1000, lang: "en" },
        ],
        lang: "en",
      });
    },
  });

  for (const consent of [undefined, false, "true", 1]) {
    const result = await helpers.handleFetchYoutubeTranscriptLocalFirst(
      "jNQXAC9IVRw",
      "en",
      42,
      consent,
    );
    assert.equal(result.error, "SUPADATA_CONSENT_REQUIRED");
  }
  assert.equal(providerCalls, 0);
});

test("a stale page video never probes clients or spends Supadata fallback quota", async () => {
  let adapterCalls = 0;
  let providerCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    youtubeAdapter: {
      async fetchTranscript() {
        adapterCalls += 1;
        return localResult();
      },
    },
    executeScript: async () => [
      { result: { ok: false, error: "PAGE_CONTEXT_CHANGED" } },
    ],
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({});
    },
  });
  const result = await helpers.handleFetchYoutubeTranscriptLocalFirst(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(adapterCalls, 0);
  assert.equal(providerCalls, 0);
});

test("a pending navigation blocks an approved Supadata request for the old video", async () => {
  let providerCalls = 0;
  const localError = Object.assign(new Error("empty local captions"), {
    code: "EMPTY_TRANSCRIPT",
  });
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    youtubeAdapter: {
      async fetchTranscript() {
        throw localError;
      },
    },
    executeScript: async () => pageSnapshot(),
    tabsGet: async (tabId) => ({
      id: tabId,
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      pendingUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    }),
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({});
    },
  });

  const result = await helpers.handleFetchYoutubeTranscriptLocalFirst(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(providerCalls, 0);
});

test("a Supadata result is rejected if the tab navigates while fallback is in flight", async () => {
  let tabsGetCalls = 0;
  let providerCalls = 0;
  const localError = Object.assign(new Error("empty local captions"), {
    code: "EMPTY_TRANSCRIPT",
  });
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    youtubeAdapter: {
      async fetchTranscript() {
        throw localError;
      },
    },
    executeScript: async () => pageSnapshot(),
    tabsGet: async (tabId) => {
      tabsGetCalls += 1;
      return {
        id: tabId,
        url:
          tabsGetCalls <= 2
            ? "https://www.youtube.com/watch?v=jNQXAC9IVRw"
            : "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      };
    },
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({
        content: [
          { text: "Old fallback line", offset: 0, duration: 1000, lang: "en" },
        ],
        lang: "en",
      });
    },
  });

  const result = await helpers.handleFetchYoutubeTranscriptLocalFirst(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(providerCalls, 1);
  assert.equal(tabsGetCalls, 3);
});

test("a completed Supadata async job rejects an empty transcript", async () => {
  let fetchCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    youtubeAdapter: { async fetchTranscript() {} },
    setTimeoutImpl(callback) {
      callback();
      return 1;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return jsonResponse({ jobId: "job-1" }, 202);
      return jsonResponse({ status: "completed", content: [], lang: "en" });
    },
  });

  const result = await helpers.handleFetchTranscript("jNQXAC9IVRw", "en");

  assert.equal(result.success, false);
  assert.equal(result.error, "EMPTY_TRANSCRIPT");
  assert.equal(fetchCalls, 2);
});

test("Supadata async polling stops when the user leaves the video", async () => {
  let fetchCalls = 0;
  let contextChecks = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    youtubeAdapter: { async fetchTranscript() {} },
    setTimeoutImpl(callback) {
      callback();
      return 1;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ jobId: "job-1" }, 202);
    },
  });

  const result = await helpers.handleFetchTranscript(
    "jNQXAC9IVRw",
    "en",
    async () => {
      contextChecks += 1;
      return contextChecks === 1;
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(fetchCalls, 1);
  assert.equal(contextChecks, 2);
});

test("the media router keeps Bilibili isolated from the YouTube adapter", async () => {
  let youtubeCalls = 0;
  const mediaRef = {
    platform: "bilibili",
    bvid: "BV1zfg36ZEXi",
    aid: 123,
    cid: 456,
    page: 1,
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/",
  };
  const { helpers } = loadBackground({
    youtubeAdapter: {
      async fetchTranscript() {
        youtubeCalls += 1;
        return localResult();
      },
    },
    bilibiliAdapterImpl: {
      ...bilibiliAdapter,
      async fetchTranscript() {
        return {
          ...localResult("zh-CN"),
          selectedTrack: { language: "zh-CN", kind: "manual" },
        };
      },
    },
  });
  const result = await helpers.handleFetchMediaTranscript(
    mediaRef,
    "zh-CN",
    42,
    true,
  );
  assert.equal(result.success, true);
  assert.equal(result.source, "bilibili");
  assert.equal(youtubeCalls, 0);
});

test("a cache-miss YouTube note reuses tabId and preferred language for local extraction", async () => {
  const adapterInputs = [];
  let savedNotes = [];
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "" },
    youtubeAdapter: {
      async fetchTranscript(input) {
        adapterInputs.push(input);
        return {
          ...localResult("zh-CN"),
          transcript: [
            { text: "中文字幕。", start: 0, duration: 3, language: "zh-CN" },
          ],
          transcriptText: "中文字幕。",
          transcriptTextTimestamped: "[0:00] 中文字幕。",
          language: "zh-CN",
        };
      },
    },
    executeScript: async () => pageSnapshot("jNQXAC9IVRw", "zh-CN"),
    storageGet: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key", supadataApiKey: "" } };
      }
      if (key === "ytd_notes") return { ytd_notes: savedNotes };
      return {};
    },
    storageSet: async (items) => {
      if (Array.isArray(items.ytd_notes)) savedNotes = items.ytd_notes;
    },
  });
  const result = await helpers.handleSaveNote(
    "jNQXAC9IVRw",
    1,
    "视频",
    "频道",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    42,
    "zh-CN",
  );
  assert.equal(result.success, true);
  assert.equal(adapterInputs.length, 1);
  assert.equal(adapterInputs[0].preferredLanguage, "zh-CN");
  assert.equal(savedNotes[0].sourceLanguage, "zh-CN");
  assert.equal(savedNotes[0].text, "中文字幕。");
});

test("a cache-miss note never authorizes Supadata on the user's behalf", async () => {
  let providerCalls = 0;
  let savedNotes = [];
  const localError = Object.assign(new Error("empty local captions"), {
    code: "EMPTY_TRANSCRIPT",
  });
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    youtubeAdapter: {
      async fetchTranscript() {
        throw localError;
      },
    },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({});
    },
    storageGet: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: {
            aiApiKey: "test-key",
            supadataApiKey: "optional-key",
          },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: savedNotes };
      return {};
    },
    storageSet: async (items) => {
      if (Array.isArray(items.ytd_notes)) savedNotes = items.ytd_notes;
    },
  });

  const result = await helpers.handleSaveNote(
    "jNQXAC9IVRw",
    1,
    "视频",
    "频道",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    42,
    "en",
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "SUPADATA_CONSENT_REQUIRED");
  assert.equal(providerCalls, 0);
  assert.equal(savedNotes.length, 0);
});

test("side panel and note messages thread the exact tab and language through", () => {
  const panel = read("sidepanel.js");
  const background = read("background.js");
  assert.match(
    panel,
    /action: "fetchTranscript"[\s\S]*?preferredLanguage: currentVideoSourceLanguage,[\s\S]*?tabId: videoTabId,[\s\S]*?supadataConsent: supadataConsent === true/,
  );
  assert.match(
    panel,
    /action: "saveNote"[\s\S]*?tabId: videoTabId,[\s\S]*?preferredLanguage:/,
  );
  assert.match(
    background,
    /message\.tabId \?\? sender\.tab\?\.id \?\? null/,
  );
  assert.match(panel, /const TRANSCRIPT_SOURCE_POLICY_VERSION = 3/);
  assert.match(background, /const TRANSCRIPT_SOURCE_POLICY_VERSION = 3/);
  assert.match(panel, /const REQUIRED_RUNTIME_PROTOCOL_VERSION = 8/);
  assert.match(background, /const RUNTIME_PROTOCOL_VERSION = 8/);
  assert.match(background, /message\.supadataConsent === true/);
  assert.match(background, /tab\?\.pendingUrl \|\| tab\?\.url/);
  assert.match(panel, /latestTab\.pendingUrl \|\| latestTab\.url/);
  assert.match(panel, /本次使用 Supadata/);
  assert.match(panel, /不使用第三方服务/);
  assert.match(panel, /SUPADATA_CONSENT_REQUIRED/);
  assert.match(panel, /SUPADATA_NOT_CONFIGURED/);
  const errorUi = read("sidepanel.html");
  assert.match(errorUi, /id="errorSecondaryBtn"[\s\S]*?type="button"[\s\S]*?hidden/);
  assert.match(panel, /if \(!currentConfigStatus\?\.hasAiKey\)/);
  assert.doesNotMatch(
    panel,
    /locator\.platform === "youtube" && !currentConfigStatus\?\.hasSupadataKey/,
  );
  assert.match(panel, /transcriptSource: currentTranscriptSource/);
  assert.match(panel, /transcriptSelectedTrack: sanitizeTranscriptSelectedTrack/);
  assert.match(panel, /transcriptSourceAttempt: currentTranscriptSourceAttempt/);
  const sanitizer = panel.match(
    /function sanitizeTranscriptSelectedTrack\(track\)[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(sanitizer);
  assert.doesNotMatch(sanitizer, /baseUrl|signature|token/i);
});
