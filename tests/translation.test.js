const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const bilibiliAdapter = require("../bilibili.js");
const youtubeTranscriptAdapter = require("../youtube-transcript.js");

function loadSidepanelRuntime({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const tabUpdatedListeners = [];
  const tabActivatedListeners = [];
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: {
        onUpdated: {
          addListener(listener) {
            tabUpdatedListeners.push(listener);
          },
        },
        onActivated: {
          addListener(listener) {
            tabActivatedListeners.push(listener);
          },
        },
      },
    },
    YTD_SETTINGS: {},
    BILIBILI_ADAPTER: bilibiliAdapter,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read("sidepanel.js"), context);
  return {
    helpers: sandbox.__YTD_TRANSCRIPT_TESTING__,
    sandbox,
    tabUpdatedListeners,
    tabActivatedListeners,
    evaluate: (code) => vm.runInContext(code, context),
  };
}

function loadSidepanelHelpers(options = {}) {
  return loadSidepanelRuntime(options).helpers;
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  storageGetImpl,
  storageSetImpl = async () => {},
  tabsImpl = {},
  bilibiliAdapterImpl = bilibiliAdapter,
  youtubeTranscriptAdapterImpl = youtubeTranscriptAdapter,
} = {}) {
  const listeners = { addListener() {} };
  const runtimeMessageListeners = [];
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get:
            storageGetImpl ||
            (async () => ({ ytd_settings: settings })),
          set: storageSetImpl,
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            runtimeMessageListeners.push(listener);
          },
        },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: { onUpdated: listeners, onActivated: listeners, ...tabsImpl },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
    BILIBILI_ADAPTER: bilibiliAdapterImpl,
    YOUTUBE_TRANSCRIPT_ADAPTER: youtubeTranscriptAdapterImpl,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  const helpers = sandbox.__YTD_TRANSLATION_TESTING__;
  Object.defineProperty(helpers, "__runtimeMessageListeners", {
    value: runtimeMessageListeners,
  });
  return helpers;
}

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fireActive(delay) {
      const match = [...timers.entries()].find(
        ([, timer]) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match[1].active = false;
      match[1].callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && timer.delay === delay,
      ).length;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
  };
}

function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

const encode = (value) => new TextEncoder().encode(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function dispatchBackgroundMessage(background, message, sender = {}) {
  const listener = background.__runtimeMessageListeners[0];
  assert.equal(typeof listener, "function", "background message listener must exist");
  return new Promise((resolve, reject) => {
    try {
      const keepOpen = listener(message, sender, resolve);
      assert.equal(keepOpen, true, `${message.action} must keep the response channel open`);
    } catch (error) {
      reject(error);
    }
  });
}

function installSidepanelDigestFixture(runtime) {
  return runtime.evaluate(`
    (() => {
      const elements = new Map();
      const pendingCaches = new Map();
      const events = [];
      const saved = [];
      let activeTabName = "transcript";
      currentOverviewMode = "zh";
      const element = (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            id,
            style: {},
            hidden: false,
            innerHTML: "",
            textContent: "",
            disabled: false,
            focused: false,
            listeners: {},
            classList: { toggle() {}, contains() { return false; } },
            setAttribute() {},
            addEventListener(type, listener) { this.listeners[type] = listener; },
            focus() { this.focused = true; },
            click() {
              if (this.disabled) return undefined;
              return this.listeners.click?.();
            },
          });
        }
        return elements.get(id);
      };

      document.getElementById = element;
      document.querySelectorAll = () => [];
      document.querySelector = (selector) =>
        selector === ".tab.active"
          ? { dataset: { tab: activeTabName } }
          : null;
      showState = () => {};
      renderTranscript = () => events.push("transcript:" + currentTranscriptText);
      renderAnalysisResults = (analysis) =>
        events.push("analysis:" + (analysis?.marker || "none"));
      highlightMomentsOnPage = () => {};
      loadNotes = (videoId) => events.push("notes:" + videoId);
      setupExplainFeature = () => {};
      translateTranscript = () => {};
      setOverviewTranslationStatus = () => {};
      setOverviewTranslationLoading = (show) => {
        isOverviewTranslationLoading = show;
      };
      loadFromCache = (videoId) =>
        new Promise((resolve) => {
          const queue = pendingCaches.get(videoId) || [];
          queue.push(resolve);
          pendingCaches.set(videoId, queue);
        });
      saveToCache = async (videoId) => {
        saved.push({
          videoId,
          marker: currentAnalysis?.marker || null,
          transcriptText: currentTranscriptText,
        });
      };

      const makeCache = (
        videoId,
        withProvenance = true,
        sourceLanguage = "en",
        withOriginal = false,
        mediaRef = null,
        routeKey = null,
      ) => ({
        analysis: {
          marker: videoId,
          schemaVersion: 3,
          baseLanguage: "zh-Hans",
          sourceLanguage,
          chapters: [
            {
              timestamp: "0:00",
              timestampSeconds: 0,
              titleZh: "中文标题 " + videoId,
              summaryZh: "中文总结 " + videoId,
              titleOriginal: withOriginal ? "Original title " + videoId : "",
              summaryOriginal: withOriginal
                ? "Original summary " + videoId
                : "",
            },
          ],
          keyQuotes: [
            {
              quoteOriginal: sourceLanguage.startsWith("zh")
                ? "中文原句 " + videoId
                : "Quote " + videoId,
              quoteZh: "中文引语 " + videoId,
            },
          ],
        },
        analysisVideoId: withProvenance ? videoId : undefined,
        transcript: [{ start: 0, text: "Transcript " + videoId }],
        transcriptText: "transcript-" + videoId,
        transcriptTimestamped: "timestamped-" + videoId,
        transcriptLanguage: sourceLanguage,
        ...(mediaRef ? { mediaRef } : {}),
        ...(routeKey ? { routeKey } : {}),
        timestamp: Date.now(),
      });

      return {
        start: (videoId, options = {}) => {
          const mediaRef = options.mediaRef || currentMediaRef;
          const routeKey = options.routeKey || currentRouteKey;
          if (options.mediaRef) currentMediaRef = options.mediaRef;
          if (options.routeKey) currentRouteKey = options.routeKey;
          return startDigest(
            videoId,
            options.videoUrl || "url-" + videoId,
            mediaRef,
            routeKey,
          );
        },
        analyze: () => triggerAnalysis(),
        resolveCache: (videoId, cached) => pendingCaches.get(videoId).shift()(cached),
        resolveLatestCache: (videoId, cached) =>
          pendingCaches.get(videoId).pop()(cached),
        makeCache,
        setActiveTab: (tabName) => { activeTabName = tabName; },
        setVideoSourceLanguage: (language) => {
          currentVideoSourceLanguage = language;
        },
        setOverviewMode: (mode) => handleOverviewModeChange(mode),
        ensureOverviewOriginal: () => ensureOverviewOriginal(),
        setOverviewHtml: (value) => {
          element("chapterList").innerHTML = value;
          element("quotesList").innerHTML = value;
        },
        overviewHtml: () => JSON.stringify({
          chapters: element("chapterList").innerHTML,
          quotes: element("quotesList").innerHTML,
        }),
        snapshot: () => JSON.stringify({
          videoId: currentVideoId,
          videoUrl: currentVideoUrl,
          transcriptText: currentTranscriptText,
          analysisMarker: currentAnalysis?.marker || null,
          sourceLanguage: currentAnalysis?.sourceLanguage || null,
          titleOriginal: currentAnalysis?.chapters?.[0]?.titleOriginal || "",
          overviewMode: currentOverviewMode,
          isAnalysisLoading,
        }),
        mediaSnapshot: () => JSON.stringify({
          videoId: currentVideoId,
          videoUrl: currentVideoUrl,
          routeKey: currentRouteKey,
          mediaKey: currentMediaRef?.mediaKey || null,
          transcriptText: currentTranscriptText,
          analysisMarker: currentAnalysis?.marker || null,
          isAnalysisLoading,
        }),
        events: () => JSON.stringify(events),
        saved: () => JSON.stringify(saved),
        setupEvents: () => setupEventListeners(),
        errorSnapshot: () => JSON.stringify({
          title: element("errorTitle").textContent,
          message: element("errorMessage").textContent,
          primaryText: element("errorBtn").textContent,
          primaryDisabled: element("errorBtn").disabled,
          secondaryText: element("errorSecondaryBtn").textContent,
          secondaryHidden: element("errorSecondaryBtn").hidden,
        }),
        clickError: () => element("errorBtn").click(),
        clickErrorSecondary: () => element("errorSecondaryBtn").click(),
        overviewTranslationLoading: () => isOverviewTranslationLoading,
      };
    })()
  `);
}

test("Header exposes tab-specific transcript, overview, and notes language modes", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");
  const headerStart = html.indexOf('<div class="header-top">');
  const tabsStart = html.indexOf('<div class="tabs"');
  const controlStart = html.indexOf('id="transcriptModeControl"');
  const overviewControlStart = html.indexOf('id="overviewModeControl"');
  const notesControlStart = html.indexOf('id="notesModeControl"');
  const settingsStart = html.indexOf('id="settingsBtn"');
  const resultsStart = html.indexOf('id="resultsState"');

  assert.ok(headerStart >= 0);
  assert.ok(controlStart > headerStart && controlStart < tabsStart);
  assert.ok(overviewControlStart > controlStart && overviewControlStart < tabsStart);
  assert.ok(notesControlStart > overviewControlStart && notesControlStart < tabsStart);
  assert.ok(settingsStart > notesControlStart && settingsStart < tabsStart);
  assert.ok(controlStart < resultsStart, "mode control must live outside scrolling results");
  assert.match(html, /id="transcriptModeControl"[\s\S]*?hidden/);
  assert.match(html, /id="overviewModeControl"[\s\S]*?hidden/);
  assert.match(html, /id="notesModeControl"[\s\S]*?hidden/);
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>原文</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(html, /data-overview-mode="original"[\s\S]*?aria-pressed="false"[\s\S]*?>原文</);
  assert.match(html, /data-overview-mode="zh"[\s\S]*?aria-pressed="true"[\s\S]*?>中文</);
  assert.match(html, /data-overview-mode="bilingual"[\s\S]*?aria-pressed="false"[\s\S]*?>双语</);
  assert.match(html, /data-notes-mode="original"[\s\S]*?>原文</);
  assert.match(html, /data-notes-mode="zh"[\s\S]*?>中文</);
  assert.match(html, /data-notes-mode="bilingual"[\s\S]*?aria-pressed="true"[\s\S]*?>双语</);
  assert.match(css, /\.header-actions\s*\{[\s\S]*?display:\s*flex/);
  assert.match(css, /\.language-mode-control\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(
    js,
    /function updateHeaderLanguageControlsVisibility\(\)[\s\S]*?transcriptControl\.hidden = !\(showingResults && activeTab === "transcript"\)[\s\S]*?overviewControl\.hidden = !\(showingResults && activeTab === "overview"\)[\s\S]*?notesControl\.hidden = !\(showingResults && activeTab === "notes"\)/,
  );
  assert.match(js, /function showState\(state\)[\s\S]*?updateHeaderLanguageControlsVisibility\(\)/);
  assert.match(js, /function switchTab\(tabName\)[\s\S]*?updateHeaderLanguageControlsVisibility\(\)/);
  assert.match(js, /handleTranscriptModeChange\(button\.dataset\.transcriptMode\)/);
  assert.match(js, /handleOverviewModeChange\(button\.dataset\.overviewMode\)/);
  assert.match(js, /handleNotesModeChange\(button\.dataset\.notesMode\)/);
  assert.match(js, /let currentOverviewMode = "zh"/);
  assert.match(js, /let currentNotesMode = "bilingual"/);
  assert.match(js, /action: "translateOverviewOriginal"/);
  assert.match(js, /function ensureOverviewOriginal\(\)/);
  assert.match(js, /action: "translateNotes"/);
  assert.match(js, /function ensureNotesChinese\(\)/);
  assert.match(
    js,
    /function ensureNotesChinese\(\)[\s\S]*?await sendTranslationMessage\(\{[\s\S]*?action: "translateNotes"/,
  );
  assert.match(js, /const REQUIRED_RUNTIME_PROTOCOL_VERSION = 8/);
  assert.match(
    js,
    /runtimeProtocolVersion\s*!==\s*REQUIRED_RUNTIME_PROTOCOL_VERSION[\s\S]*?showRuntimeVersionError\(\)/,
  );
  assert.match(js, /扩展后台未响应原文翻译请求，请重新加载扩展/);
  const backgroundSource = read("background.js");
  assert.match(backgroundSource, /const RUNTIME_PROTOCOL_VERSION = 8/);
  assert.match(
    backgroundSource,
    /runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION/,
  );
  assert.match(js, /contentType: "transcriptBatch"/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.match(js, /原文（\$\{language\}）/);
  assert.match(
    js,
    /return startDigest\(currentVideoId, currentVideoUrl\)\.catch\(/,
  );
  assert.match(
    js,
    /await startDigest\([\s\S]*?nextMediaRef\.mediaKey,[\s\S]*?nextVideoUrl,[\s\S]*?nextMediaRef,[\s\S]*?locator\.routeKey/,
  );
  assert.match(js, /const requestKey = `\$\{generation\}:\$\{videoId\}`/);
  assert.match(js, /runDigestSingleFlight\(requestKey/);
  assert.match(js, /const generation = \+\+tabCheckGeneration/);
  assert.match(js, /latestLocator\.routeKey !== locator\.routeKey/);
  assert.match(js, /cached\.analysisVideoId === videoId/);
  assert.match(js, /videoId !== currentVideoId \|\| !currentTranscript/);
  assert.match(js, /preferredLanguage: currentVideoSourceLanguage/);
  assert.match(js, /const TRANSCRIPT_SOURCE_POLICY_VERSION = 3/);
  assert.match(
    js,
    /cached\.transcriptSourcePolicyVersion !== TRANSCRIPT_SOURCE_POLICY_VERSION/,
  );
});

test("notesChanged refreshes imported notes without starting translation", async () => {
  const messages = [];
  const helpers = loadSidepanelHelpers({
    sendMessage: async (message) => {
      messages.push(message);
      if (message.action === "getNotes") {
        return {
          success: true,
          notes: [
            {
              id: "imported-note",
              videoId: "video_001",
              videoTitle: "Imported video",
              timestamp: "0:05",
              timestampSeconds: 5,
              timestampedUrl:
                "https://www.youtube.com/watch?v=video_001&t=5s",
              text: "Imported English note without a translation.",
              translatedText: "",
            },
          ],
        };
      }
      throw new Error(`Unexpected background action: ${message.action}`);
    },
  });

  await helpers.loadNotes(null, { translateMissing: false });
  await Promise.resolve();

  assert.deepEqual(
    messages.map((message) => message.action),
    ["getNotes"],
  );
  assert.match(
    read("sidepanel.js"),
    /message\.action === "noteSaved" \|\| message\.action === "notesChanged"[\s\S]*?loadNotes\([\s\S]*?translateMissing: message\.action === "noteSaved"/,
  );
});

test("duplicate digest starts for the same video share one in-flight task", async () => {
  const { createSingleFlight } = loadSidepanelHelpers();
  const run = createSingleFlight();
  let callCount = 0;
  let finish;
  const task = () => {
    callCount += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };

  const first = run("video-1", task);
  const second = run("video-1", task);
  await nextTurn();
  assert.equal(callCount, 1);
  finish("done");
  assert.equal(await first, "done");
  assert.equal(await second, "done");

  const third = run("video-1", async () => {
    callCount += 1;
    return "again";
  });
  assert.equal(await third, "again");
  assert.equal(callCount, 2);

  let finishVideoA;
  let finishVideoB;
  const videoA = run(
    "video-a",
    () =>
      new Promise((resolve) => {
        finishVideoA = resolve;
      }),
  );
  const videoB = run(
    "video-b",
    () =>
      new Promise((resolve) => {
        finishVideoB = resolve;
      }),
  );
  const duplicateVideoA = run("video-a", () => {
    throw new Error("video-a must stay single-flight while video-b is active");
  });
  await nextTurn();
  finishVideoB("b");
  finishVideoA("a");
  assert.equal(await videoB, "b");
  assert.equal(await videoA, "a");
  assert.equal(await duplicateVideoA, "a");
});

test("Supadata is requested only after the user confirms the third-party action", async () => {
  const messages = [];
  const videoId = "abc123DEF45";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      messages.push({ ...message });
      if (message.action !== "fetchTranscript") {
        throw new Error(`Unexpected action: ${message.action}`);
      }
      if (message.supadataConsent !== true) {
        return {
          success: false,
          error: "SUPADATA_CONSENT_REQUIRED",
          message: "Choose whether to use Supadata.",
        };
      }
      return {
        success: true,
        source: "supadata",
        sourceAttempt: "SUPADATA",
        selectedTrack: null,
        transcript: [
          { text: "Approved fallback", start: 0, duration: 2, language: "en" },
        ],
        transcriptText: "Approved fallback",
        transcriptTextTimestamped: "[0:00] Approved fallback",
        language: "en",
      };
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setupEvents();

  const initialLoad = fixture.start(videoId, {
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
  });
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await initialLoad;

  assert.deepEqual(
    messages.map((message) => message.supadataConsent),
    [false],
  );
  assert.deepEqual(JSON.parse(fixture.errorSnapshot()), {
    title: "是否使用第三方字幕服务？",
    message:
      "未能直接读取 YouTube 原生字幕。你可以选择本次使用 Supadata 重试；点击后会把此视频的标准 YouTube 链接发送给 Supadata，并可能消耗你的 API 额度。",
    primaryText: "本次使用 Supadata",
    primaryDisabled: false,
    secondaryText: "不使用第三方服务",
    secondaryHidden: false,
  });

  const approvedLoad = fixture.clickError();
  const blockedDoubleClick = fixture.clickError();
  const duplicateRefresh = fixture.start(videoId);
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await Promise.all([approvedLoad, duplicateRefresh]);

  assert.equal(blockedDoubleClick, undefined);
  assert.deepEqual(
    messages.map((message) => message.supadataConsent),
    [false, true],
  );
  assert.equal(JSON.parse(fixture.saved()).at(-1).transcriptText, "Approved fallback");
});

test("declining Supadata sends no third-party transcript request", async () => {
  const messages = [];
  const videoId = "abc123DEF45";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      messages.push({ ...message });
      return {
        success: false,
        error: "SUPADATA_CONSENT_REQUIRED",
        message: "Choose whether to use Supadata.",
      };
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setupEvents();

  const initialLoad = fixture.start(videoId);
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await initialLoad;
  fixture.clickErrorSecondary();

  assert.deepEqual(
    messages.map((message) => message.supadataConsent),
    [false],
  );
  const errorState = JSON.parse(fixture.errorSnapshot());
  assert.equal(errorState.title, "继续使用 YouTube 原生字幕");
  assert.match(errorState.message, /没有向 Supadata 发送视频链接/);
  assert.match(errorState.message, /字幕轨尚未加载/);
  assert.match(errorState.message, /VPN 或代理/);
  assert.equal(errorState.primaryText, "重试 YouTube 原生字幕");
  assert.equal(errorState.secondaryHidden, true);

  const nativeRetry = fixture.clickError();
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await nativeRetry;

  assert.deepEqual(
    messages.map((message) => message.supadataConsent),
    [false, false],
  );
});

test("a consent click waits for an older local-only refresh and still runs", async () => {
  const messages = [];
  const videoId = "abc123DEF45";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      messages.push({ ...message });
      if (message.supadataConsent !== true) {
        return {
          success: false,
          error: "SUPADATA_CONSENT_REQUIRED",
          message: "Choose whether to use Supadata.",
        };
      }
      return {
        success: true,
        source: "supadata",
        sourceAttempt: "SUPADATA",
        selectedTrack: null,
        transcript: [
          { text: "Approved fallback", start: 0, duration: 2, language: "en" },
        ],
        transcriptText: "Approved fallback",
        transcriptTextTimestamped: "[0:00] Approved fallback",
        language: "en",
      };
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setupEvents();

  const initialLoad = fixture.start(videoId);
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await initialLoad;

  const olderLocalRefresh = fixture.start(videoId);
  await nextTurn();
  const approvedLoad = fixture.clickError();
  fixture.resolveCache(videoId, null);
  await olderLocalRefresh;

  await nextTurn();
  fixture.resolveCache(videoId, null);
  await approvedLoad;

  assert.deepEqual(
    messages.map((message) => message.supadataConsent),
    [false, false, true],
  );
  assert.equal(JSON.parse(fixture.saved()).at(-1).transcriptText, "Approved fallback");
});

test("media locators separate Bilibili route identity from resolved CID identity", () => {
  const { extractMediaLocator } = loadSidepanelHelpers();
  const youtube = extractMediaLocator(
    "https://www.youtube.com/watch?v=ydTeb_I0b94&list=example",
  );
  const bilibili = extractMediaLocator(
    "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=2&trackid=example",
  );

  assert.equal(youtube.mediaKey, "ydTeb_I0b94");
  assert.equal(youtube.routeKey, "youtube:ydTeb_I0b94");
  assert.equal(bilibili.routeKey, "bilibili:BV1zfg36ZEXi:p2");
  assert.equal(bilibili.mediaKey, undefined);
  assert.equal(
    bilibili.canonicalUrl,
    "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=2",
  );
  assert.match(
    read("sidepanel.js"),
    /function isBilibiliChineseMedia\(\)[\s\S]*?isConfirmedSimplifiedChineseSource\(currentTranscriptLanguage\)/,
    "Bilibili must hide redundant language modes only for confirmed Simplified Chinese",
  );
});

test("background accepts standard Bilibili videos but rejects unsupported Bilibili pages", () => {
  const background = loadBackgroundHelpers();
  assert.equal(
    background.isSupportedVideoUrl(
      "https://www.youtube.com/watch?v=ydTeb_I0b94",
    ),
    true,
  );
  assert.equal(
    background.isSupportedVideoUrl(
      "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=1",
    ),
    true,
  );
  assert.equal(
    background.isSupportedVideoUrl(
      "https://www.bilibili.com/bangumi/play/ep123",
    ),
    false,
  );
  assert.equal(
    background.isSupportedVideoUrl("https://live.bilibili.com/123"),
    false,
  );
});

test("Bilibili media resolution and transcript messages use the adapter contract", async () => {
  const calls = [];
  const mediaRef = {
    platform: "bilibili",
    bvid: "BV1zfg36ZEXi",
    aid: 123,
    cid: 40830435549,
    page: 2,
    mediaKey: "bilibili:BV1zfg36ZEXi:40830435549",
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=2",
    title: "示例视频 P2",
    channelName: "示例作者",
  };
  const adapter = {
    parseBilibiliVideoUrl: bilibiliAdapter.parseBilibiliVideoUrl,
    canonicalVideoUrl: bilibiliAdapter.canonicalVideoUrl,
    async resolveMedia(url) {
      calls.push({ action: "resolve", url });
      return mediaRef;
    },
    async fetchTranscript(resolved) {
      calls.push({ action: "fetch", mediaKey: resolved.mediaKey });
      return {
        transcript: [
          { start: 0, end: 3, text: "先把问题想清楚。", language: "zh-CN" },
        ],
        transcriptText: "先把问题想清楚。",
        transcriptTimestamped: "[0:00] 先把问题想清楚。",
        language: "zh-CN",
        sourceLanguage: "zh-CN",
      };
    },
  };
  const background = loadBackgroundHelpers({ bilibiliAdapterImpl: adapter });

  const resolved = await dispatchBackgroundMessage(background, {
    action: "resolveBilibiliMedia",
    url: mediaRef.canonicalUrl,
  });
  assert.equal(resolved.success, true);
  assert.equal(resolved.mediaRef.platform, "bilibili");
  assert.equal(resolved.mediaRef.mediaKey, mediaRef.mediaKey);
  assert.equal(resolved.mediaRef.canonicalUrl, mediaRef.canonicalUrl);
  assert.equal(resolved.mediaRef.metadata.title, mediaRef.title);

  const transcript = await dispatchBackgroundMessage(background, {
    action: "fetchTranscript",
    mediaRef,
    preferredLanguage: "zh-CN",
  });
  assert.equal(transcript.success, true);
  assert.equal(transcript.mediaRef.mediaKey, mediaRef.mediaKey);
  assert.equal(transcript.language, "zh-CN");
  assert.equal(transcript.transcript.length, 1);
  assert.equal(transcript.transcript[0].text, "先把问题想清楚。");
  assert.deepEqual(calls, [
    { action: "resolve", url: mediaRef.canonicalUrl },
    { action: "fetch", mediaKey: mediaRef.mediaKey },
  ]);
});

test("a newer active-tab check is not swallowed by an older pending check", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      currentConfigStatus = { hasAiKey: true, hasSupadataKey: true };
      const loaded = [];
      const tabs = [
        { id: 1, url: "https://www.youtube.com/watch?v=video-a" },
        { id: 2, url: "https://www.youtube.com/watch?v=video-b" },
      ];
      let queryIndex = 0;
      let relayCount = 0;
      let releaseFirstRelay;
      chrome.tabs.query = async () => {
        const tab = tabs[Math.min(queryIndex, tabs.length - 1)];
        queryIndex += 1;
        return tab ? [tab] : [];
      };
      chrome.tabs.get = async (tabId) => tabs.find((tab) => tab.id === tabId);
      chrome.runtime.sendMessage = () => {
        relayCount += 1;
        if (relayCount === 1) {
          return new Promise((resolve) => { releaseFirstRelay = resolve; });
        }
        return Promise.resolve({
          success: true,
          response: { title: "Video B", channelName: "Channel B" },
        });
      };
      startDigest = async (videoId, videoUrl) => {
        loaded.push({ videoId, videoUrl });
      };
      showState = () => {};
      scheduleDigestRefresh = () => {};

      return {
        check: () => checkCurrentTab(),
        releaseFirst: () => releaseFirstRelay({
          success: true,
          response: { title: "Video A", channelName: "Channel A" },
        }),
        snapshot: () => JSON.stringify({
          loaded,
          title: currentVideoTitle,
          channelName: currentChannelName,
        }),
      };
    })()
  `);

  const first = fixture.check();
  await nextTurn();
  const second = fixture.check();
  await second;
  fixture.releaseFirst();
  await first;

  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    loaded: [
      {
        videoId: "video-b",
        videoUrl: "https://www.youtube.com/watch?v=video-b",
      },
    ],
    title: "Video B",
    channelName: "Channel B",
  });
});

test("a vanished tab is retried without surfacing an extension error", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      currentConfigStatus = { hasAiKey: true, hasSupadataKey: true };
      let refreshes = 0;
      let shownErrors = 0;
      let loggedErrors = 0;
      chrome.tabs.query = async () => [
        { id: 77, url: "https://www.youtube.com/watch?v=video-a" },
      ];
      chrome.tabs.get = async () => {
        throw new Error("No tab with id: 77");
      };
      chrome.runtime.sendMessage = async () => ({
        success: true,
        response: { title: "Video A" },
      });
      scheduleDigestRefresh = () => { refreshes += 1; };
      showError = () => { shownErrors += 1; };
      console = {
        ...console,
        error() { loggedErrors += 1; },
      };
      return {
        check: () => checkCurrentTab(),
        snapshot: () => JSON.stringify({ refreshes, shownErrors, loggedErrors }),
      };
    })()
  `);

  await fixture.check();
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    refreshes: 1,
    shownErrors: 0,
    loggedErrors: 0,
  });
  assert.equal(
    runtime.helpers.isTransientTabLookupError(new Error("No tab with id: 77")),
    true,
  );
});

test("a missing content receiver prompts a page refresh without starting a digest", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      currentConfigStatus = { hasAiKey: true, hasSupadataKey: true };
      let tabReads = 0;
      let digestStarts = 0;
      let refreshPrompt = null;
      chrome.tabs.query = async () => [
        { id: 91, url: "https://www.youtube.com/watch?v=video-a" },
      ];
      chrome.tabs.get = async () => {
        tabReads += 1;
        return { id: 91, url: "https://www.youtube.com/watch?v=video-a" };
      };
      chrome.runtime.sendMessage = async () => ({
        success: false,
        error: "PAGE_REFRESH_REQUIRED",
        message: "DigestDock 已更新，请刷新当前 YouTube 页面后重试。",
      });
      startDigest = async () => { digestStarts += 1; };
      showPageRefreshRequired = (tabId, message) => {
        refreshPrompt = { tabId, message };
      };
      return {
        check: () => checkCurrentTab(),
        snapshot: () => JSON.stringify({
          tabReads,
          digestStarts,
          refreshPrompt,
        }),
      };
    })()
  `);

  await fixture.check();
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    tabReads: 0,
    digestStarts: 0,
    refreshPrompt: {
      tabId: 91,
      message: "DigestDock 已更新，请刷新当前 YouTube 页面后重试。",
    },
  });
});

test("the refresh action reloads the page and rechecks after loading completes", async () => {
  const timers = createFakeTimers();
  const runtime = loadSidepanelRuntime({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });
  const fixture = runtime.evaluate(`
    (() => {
      const elements = new Map();
      const reloads = [];
      let checks = 0;
      document.getElementById = (id) => {
        if (!elements.has(id)) {
          elements.set(id, { style: {}, textContent: "" });
        }
        return elements.get(id);
      };
      showState = () => {};
      checkCurrentTab = () => { checks += 1; };
      chrome.tabs.reload = async (tabId) => { reloads.push(tabId); };
      videoTabId = 91;
      panelWindowId = 1;
      showPageRefreshRequired(91, "请刷新当前 YouTube 页面。");
      return {
        press: () => errorAction(),
        snapshot: () => JSON.stringify({
          reloads,
          checks,
          buttonText: elements.get("errorBtn").textContent,
        }),
      };
    })()
  `);

  await fixture.press();
  runtime.tabUpdatedListeners[0](
    91,
    { status: "complete" },
    {
      id: 91,
      active: true,
      windowId: 1,
      url: "https://www.youtube.com/watch?v=video-a",
    },
  );
  assert.equal(timers.activeCount(600), 1);
  timers.fireActive(600);

  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    reloads: [91],
    checks: 1,
    buttonText: "刷新页面",
  });
});

test("a stale video load cannot replace the latest video's digest state", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installSidepanelDigestFixture(runtime);

  const videoA = fixture.start("video-a");
  await nextTurn();
  fixture.setOverviewHtml("old video-a overview");
  const videoB = fixture.start("video-b");
  await nextTurn();

  assert.deepEqual(JSON.parse(fixture.overviewHtml()), {
    chapters: "",
    quotes: "",
  });

  fixture.resolveCache("video-b", fixture.makeCache("video-b"));
  await videoB;
  fixture.resolveCache("video-a", fixture.makeCache("video-a"));
  await videoA;

  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    videoId: "video-b",
    videoUrl: "url-video-b",
    transcriptText: "transcript-video-b",
    analysisMarker: "video-b",
    sourceLanguage: "en",
    titleOriginal: "",
    overviewMode: "zh",
    isAnalysisLoading: false,
  });
  assert.deepEqual(JSON.parse(fixture.events()), [
    "transcript:transcript-video-b",
    "analysis:video-b",
    "notes:video-b",
  ]);
});

test("a stale Bilibili part cache cannot replace the current CID and route", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installSidepanelDigestFixture(runtime);
  const p1 = {
    platform: "bilibili",
    bvid: "BV1zfg36ZEXi",
    cid: 111,
    page: 1,
    mediaKey: "bilibili:BV1zfg36ZEXi:111",
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=1",
  };
  const p2 = {
    ...p1,
    cid: 222,
    page: 2,
    mediaKey: "bilibili:BV1zfg36ZEXi:222",
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=2",
  };
  const p1Route = "bilibili:BV1zfg36ZEXi:p1";
  const p2Route = "bilibili:BV1zfg36ZEXi:p2";

  const staleP1 = fixture.start(p1.mediaKey, {
    mediaRef: p1,
    routeKey: p1Route,
    videoUrl: p1.canonicalUrl,
  });
  await nextTurn();
  const currentP2 = fixture.start(p2.mediaKey, {
    mediaRef: p2,
    routeKey: p2Route,
    videoUrl: p2.canonicalUrl,
  });
  await nextTurn();

  fixture.resolveCache(
    p2.mediaKey,
    fixture.makeCache(p2.mediaKey, true, "zh-CN", false, p2, p2Route),
  );
  await currentP2;
  fixture.resolveCache(
    p1.mediaKey,
    fixture.makeCache(p1.mediaKey, true, "zh-CN", false, p1, p1Route),
  );
  await staleP1;

  assert.deepEqual(JSON.parse(fixture.mediaSnapshot()), {
    videoId: p2.mediaKey,
    videoUrl: p2.canonicalUrl,
    routeKey: p2Route,
    mediaKey: p2.mediaKey,
    transcriptText: `transcript-${p2.mediaKey}`,
    analysisMarker: p2.mediaKey,
    isAnalysisLoading: false,
  });
  assert.deepEqual(JSON.parse(fixture.events()), [
    `transcript:transcript-${p2.mediaKey}`,
    `analysis:${p2.mediaKey}`,
    `notes:${p2.mediaKey}`,
  ]);
});

test("Bilibili analysis and notes stale guards bind to media identity and generations", () => {
  const source = read("sidepanel.js");
  assert.match(
    source,
    /function isCurrentDigest\([\s\S]*?videoId === currentVideoId[\s\S]*?generation === digestGeneration[\s\S]*?routeKey === currentRouteKey/,
  );
  assert.match(
    source,
    /async function triggerAnalysis\(\)[\s\S]*?const videoId = currentVideoId[\s\S]*?const generation = digestGeneration[\s\S]*?const routeKey = currentRouteKey[\s\S]*?const mediaRef = currentMediaRef[\s\S]*?currentMediaRef\?\.mediaKey === mediaRef\?\.mediaKey[\s\S]*?currentTranscriptTimestamped === transcriptTimestamped/,
  );
  assert.match(
    source,
    /async function loadNotes\([\s\S]*?loadGeneration = \+\+notesLoadGeneration[\s\S]*?digestSnapshot = digestGeneration[\s\S]*?loadGeneration === notesLoadGeneration[\s\S]*?digestSnapshot === digestGeneration[\s\S]*?videoId === currentVideoId/,
  );
});

test("switching A to B and quickly back to A starts a fresh A load", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installSidepanelDigestFixture(runtime);

  const staleA = fixture.start("video-a");
  await nextTurn();
  const staleB = fixture.start("video-b");
  await nextTurn();
  const currentA = fixture.start("video-a");
  await nextTurn();

  fixture.resolveLatestCache("video-a", fixture.makeCache("video-a"));
  await currentA;
  fixture.resolveCache("video-b", fixture.makeCache("video-b"));
  await staleB;
  fixture.resolveCache("video-a", fixture.makeCache("video-a"));
  await staleA;

  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    videoId: "video-a",
    videoUrl: "url-video-a",
    transcriptText: "transcript-video-a",
    analysisMarker: "video-a",
    sourceLanguage: "en",
    titleOriginal: "",
    overviewMode: "zh",
    isAnalysisLoading: false,
  });
  assert.deepEqual(JSON.parse(fixture.events()), [
    "transcript:transcript-video-a",
    "analysis:video-a",
    "notes:video-a",
  ]);
});

test("a stale overview response cannot render or poison the new video's cache", async () => {
  const analysisRequests = new Map();
  const runtime = loadSidepanelRuntime({
    sendMessage: (message) => {
      if (message.action !== "analyzeTranscript") return Promise.resolve({});
      return new Promise((resolve) => {
        analysisRequests.set(message.transcriptText, resolve);
      });
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);

  const loadA = fixture.start("video-a");
  await nextTurn();
  fixture.resolveCache("video-a", {
    ...fixture.makeCache("video-a"),
    analysis: null,
    analysisVideoId: null,
  });
  await loadA;
  const analysisA = fixture.analyze();
  await nextTurn();

  const loadB = fixture.start("video-b");
  await nextTurn();
  fixture.resolveCache("video-b", {
    ...fixture.makeCache("video-b"),
    analysis: null,
    analysisVideoId: null,
  });
  await loadB;
  const analysisB = fixture.analyze();
  await nextTurn();

  analysisRequests.get("timestamped-video-a")({
    success: true,
    analysis: fixture.makeCache("video-a").analysis,
  });
  await analysisA;
  assert.equal(JSON.parse(fixture.snapshot()).isAnalysisLoading, true);
  assert.deepEqual(JSON.parse(fixture.events()), [
    "transcript:transcript-video-a",
    "notes:video-a",
    "transcript:transcript-video-b",
    "notes:video-b",
  ]);
  assert.deepEqual(JSON.parse(fixture.saved()), []);

  analysisRequests.get("timestamped-video-b")({
    success: true,
    analysis: fixture.makeCache("video-b").analysis,
  });
  await analysisB;

  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    videoId: "video-b",
    videoUrl: "url-video-b",
    transcriptText: "transcript-video-b",
    analysisMarker: "video-b",
    sourceLanguage: "en",
    titleOriginal: "",
    overviewMode: "zh",
    isAnalysisLoading: false,
  });
  assert.deepEqual(JSON.parse(fixture.saved()), [
    {
      videoId: "video-b",
      marker: "video-b",
      transcriptText: "transcript-video-b",
    },
  ]);
});

test("cached overview content is accepted only for the same video", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installSidepanelDigestFixture(runtime);
  const load = fixture.start("video-b");
  await nextTurn();
  fixture.resolveCache("video-b", fixture.makeCache("video-b", false));
  await load;

  assert.equal(JSON.parse(fixture.snapshot()).analysisMarker, null);
  assert.doesNotMatch(fixture.events(), /analysis:video-b/);
});

test("a newly confirmed player language invalidates mismatched transcript state", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setVideoSourceLanguage("en");
  const englishLoad = fixture.start("video-a");
  await nextTurn();
  fixture.resolveCache("video-a", fixture.makeCache("video-a"));
  await englishLoad;

  fixture.setVideoSourceLanguage("zh-CN");
  const chineseLoad = fixture.start("video-a");
  await nextTurn();
  fixture.resolveCache(
    "video-a",
    fixture.makeCache("video-a", true, "zh-CN"),
  );
  await chineseLoad;

  assert.equal(JSON.parse(fixture.snapshot()).sourceLanguage, "zh-CN");
  assert.equal(JSON.parse(fixture.snapshot()).overviewMode, "zh");
});

test("an active Overview tab starts analysis for the newly selected video", async () => {
  let requestedTranscript = "";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      if (message.action !== "analyzeTranscript") return {};
      requestedTranscript = message.transcriptText;
      return {
        success: true,
        analysis: {
          marker: "video-b",
          schemaVersion: 3,
          baseLanguage: "zh-Hans",
          sourceLanguage: "en",
          chapters: [
            {
              timestamp: "0:00",
              timestampSeconds: 0,
              titleZh: "中文标题 video-b",
              summaryZh: "中文总结 video-b",
            },
          ],
          keyQuotes: [
            {
              quoteOriginal: "Quote video-b",
              quoteZh: "中文引语 video-b",
            },
          ],
        },
      };
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setActiveTab("overview");

  const load = fixture.start("video-b");
  await nextTurn();
  fixture.resolveCache("video-b", {
    ...fixture.makeCache("video-b"),
    analysis: null,
    analysisVideoId: null,
  });
  await load;
  await nextTurn();

  assert.equal(requestedTranscript, "timestamped-video-b");
  assert.equal(JSON.parse(fixture.snapshot()).analysisMarker, "video-b");
});

test("non-Chinese overview translates to the source language only after user selection", async () => {
  const translationMessages = [];
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      if (message.action !== "translateOverviewOriginal") return {};
      translationMessages.push(message);
      return {
        success: true,
        originalOverview: {
          chapters: [
            {
              id: "chapter-0",
              titleOriginal: "Original title video-b",
              summaryOriginal: "Original summary video-b",
            },
          ],
        },
      };
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  const load = fixture.start("video-b");
  await nextTurn();
  fixture.resolveCache("video-b", fixture.makeCache("video-b"));
  await load;

  assert.equal(JSON.parse(fixture.snapshot()).overviewMode, "zh");
  assert.equal(translationMessages.length, 0);

  fixture.setOverviewMode("original");
  await nextTurn();
  assert.equal(translationMessages.length, 1);
  assert.equal(translationMessages[0].targetLanguage, "en");
  assert.equal(
    JSON.parse(fixture.snapshot()).titleOriginal,
    "Original title video-b",
  );

  fixture.setOverviewMode("bilingual");
  await nextTurn();
  assert.equal(translationMessages.length, 1, "cached original must be reused");
});

test("Chinese-source overview never requests an original translation", async () => {
  let translationCalls = 0;
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      if (message.action === "translateOverviewOriginal") translationCalls += 1;
      return {};
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  const load = fixture.start("video-zh");
  await nextTurn();
  fixture.resolveCache(
    "video-zh",
    fixture.makeCache("video-zh", true, "zh-CN"),
  );
  await load;

  fixture.setOverviewMode("original");
  fixture.setOverviewMode("bilingual");
  await nextTurn();
  assert.equal(translationCalls, 0);
  assert.equal(JSON.parse(fixture.snapshot()).sourceLanguage, "zh-CN");
});

test("stale A original translation cannot overwrite a fresh A after A-B-A", async () => {
  const translationResolvers = [];
  const runtime = loadSidepanelRuntime({
    sendMessage: (message) => {
      if (message.action !== "translateOverviewOriginal") {
        return Promise.resolve({});
      }
      return new Promise((resolve) => translationResolvers.push(resolve));
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);

  const firstA = fixture.start("video-a");
  await nextTurn();
  fixture.resolveCache("video-a", fixture.makeCache("video-a"));
  await firstA;
  fixture.setOverviewMode("original");
  await nextTurn();

  const videoB = fixture.start("video-b");
  await nextTurn();
  fixture.resolveCache("video-b", fixture.makeCache("video-b"));
  await videoB;
  const freshA = fixture.start("video-a");
  await nextTurn();
  fixture.resolveCache("video-a", fixture.makeCache("video-a"));
  await freshA;
  fixture.setOverviewMode("original");
  await nextTurn();
  assert.equal(translationResolvers.length, 2);

  translationResolvers[0]({
    success: true,
    originalOverview: {
      chapters: [
        {
          id: "chapter-0",
          titleOriginal: "Stale title",
          summaryOriginal: "Stale summary",
        },
      ],
    },
  });
  await nextTurn();
  assert.equal(JSON.parse(fixture.snapshot()).titleOriginal, "");
  assert.equal(fixture.overviewTranslationLoading(), true);

  translationResolvers[1]({
    success: true,
    originalOverview: {
      chapters: [
        {
          id: "chapter-0",
          titleOriginal: "Fresh title",
          summaryOriginal: "Fresh summary",
        },
      ],
    },
  });
  await nextTurn();
  assert.equal(JSON.parse(fixture.snapshot()).titleOriginal, "Fresh title");
  assert.equal(fixture.overviewTranslationLoading(), false);
});

test("overview content defaults to Chinese and renders source-language variants on demand", () => {
  const helpers = loadSidepanelHelpers();
  const chapter = {
    titleZh: "中文标题",
    summaryZh: "中文摘要。",
    titleOriginal: "English title",
    summaryOriginal: "English summary.",
  };
  const quote = {
    quoteOriginal: "English quote.",
    quoteZh: "中文引语。",
  };

  const originalChapter = helpers.renderChapterLanguageContent(
    chapter,
    "original",
    "en",
  );
  const chineseChapter = helpers.renderChapterLanguageContent(chapter, "zh", "en");
  const bilingualChapter = helpers.renderChapterLanguageContent(
    chapter,
    "bilingual",
    "en",
  );
  assert.match(originalChapter, /English title/);
  assert.doesNotMatch(originalChapter, /中文标题/);
  assert.match(chineseChapter, /中文标题/);
  assert.doesNotMatch(chineseChapter, /English title/);
  assert.match(bilingualChapter, /English title[\s\S]*中文标题/);

  assert.match(
    helpers.renderQuoteLanguageContent(quote, "original", "en"),
    /English quote/,
  );
  assert.match(helpers.renderQuoteLanguageContent(quote, "zh", "en"), /中文引语/);
  assert.match(
    helpers.renderQuoteLanguageContent(quote, "bilingual", "en"),
    /English quote[\s\S]*中文引语/,
  );
  assert.equal(
    helpers.overviewQuoteCopyText(quote, "bilingual", "en"),
    "English quote.\n中文引语。",
  );
  const chineseBaseAnalysis = {
    schemaVersion: 3,
    baseLanguage: "zh-Hans",
    sourceLanguage: "en",
    chapters: [chapter],
    keyQuotes: [quote],
  };
  assert.equal(helpers.hasUsableChineseAnalysis(chineseBaseAnalysis), true);
  assert.equal(helpers.hasUsableChineseAnalysis(null), false);
  assert.equal(helpers.hasUsableChineseAnalysis(undefined), false);
  assert.equal(
    helpers.hasUsableChineseAnalysis({
      schemaVersion: 3,
      baseLanguage: "zh-Hans",
      chapters: null,
      keyQuotes: null,
    }),
    false,
  );
  assert.equal(helpers.hasCompleteOriginalAnalysis(chineseBaseAnalysis), true);
  assert.equal(helpers.hasCompleteOriginalAnalysis(null), false);

  const untranslated = {
    ...chineseBaseAnalysis,
    chapters: [{ titleZh: "中文标题", summaryZh: "中文摘要。" }],
  };
  assert.equal(helpers.hasCompleteOriginalAnalysis(untranslated), false);
  assert.match(
    helpers.renderChapterLanguageContent(
      untranslated.chapters[0],
      "original",
      "en",
    ),
    /中文标题/,
  );

  const chineseSourceBilingual = helpers.renderChapterLanguageContent(
    chapter,
    "bilingual",
    "zh-CN",
  );
  assert.equal(
    (chineseSourceBilingual.match(/<span class="overview-language-block/g) || [])
      .length,
    1,
  );
  assert.equal(
    helpers.overviewQuoteCopyText(quote, "bilingual", "zh-CN"),
    "中文引语。",
  );
});

test("notes render and copy original, Chinese, and bilingual variants", () => {
  const helpers = loadSidepanelHelpers();
  const note = {
    text: "Polished English note.",
    translatedText: "润色后的中文笔记。",
  };
  assert.match(
    helpers.renderNoteLanguageContent(note, "original"),
    /Polished English note/,
  );
  assert.doesNotMatch(
    helpers.renderNoteLanguageContent(note, "original"),
    /中文笔记/,
  );
  assert.match(
    helpers.renderNoteLanguageContent(note, "zh"),
    /润色后的中文笔记/,
  );
  assert.match(
    helpers.renderNoteLanguageContent(note, "bilingual"),
    /Polished English note[\s\S]*润色后的中文笔记/,
  );
  assert.equal(
    helpers.noteCopyTextForMode(note, "bilingual"),
    "Polished English note.\n润色后的中文笔记。",
  );
  const englishOnly = { text: "English only." };
  assert.match(
    helpers.renderNoteLanguageContent(englishOnly, "zh"),
    /English only/,
  );
  assert.equal(
    helpers.noteCopyTextForMode(englishOnly, "zh"),
    "English only.",
  );
  const chineseSource = {
    text: "AI-polished fallback",
    rawText: "原字幕本身就是中文。",
    sourceLanguage: "zh-CN",
  };
  assert.equal(helpers.noteHasChineseSource(chineseSource), true);
  const chineseSourceBilingual = helpers.renderNoteLanguageContent(
    chineseSource,
    "bilingual",
  );
  assert.match(chineseSourceBilingual, /原字幕本身就是中文/);
  assert.equal(
    (chineseSourceBilingual.match(/<span\b/g) || []).length,
    1,
    "Chinese source text must not be duplicated in bilingual mode",
  );
  assert.equal(
    helpers.noteCopyTextForMode(chineseSource, "bilingual"),
    "原字幕本身就是中文。",
  );
  assert.match(
    helpers.renderNoteLanguageContent(chineseSource, "original"),
    /lang="zh-CN"/,
  );
  assert.equal(
    helpers.noteHasChineseSource({
      rawText: "東京で漢字を使います。",
      sourceLanguage: "ja",
    }),
    false,
  );
  assert.equal(helpers.noteHasChineseSource({ rawText: "对" }), true);
  assert.equal(helpers.noteHasChineseSource({ rawText: "“你好”" }), true);
  assert.equal(helpers.noteHasChineseSource({ rawText: "《中文标题》" }), true);
  assert.equal(
    helpers.noteHasChineseSource({
      rawText: "这段中文引用了《となりのトトロ》。",
    }),
    true,
  );
  assert.match(
    helpers.renderNoteLanguageContent(
      { text: "Good.", translatedText: "好" },
      "zh",
    ),
    /好/,
  );
  assert.match(
    helpers.renderNoteLanguageContent(
      { text: "Good.", translatedText: "“好。”" },
      "zh",
    ),
    /“好。”/,
  );
  assert.doesNotMatch(
    helpers.renderNoteLanguageContent(
      {
        text: "Japanese fallback.",
        translatedText: "東京で漢字を使います。",
      },
      "zh",
    ),
    /東京/,
  );
  assert.match(
    helpers.renderNoteLanguageContent(
      {
        text: "Miyazaki note.",
        translatedText: "宫崎骏导演了《となりのトトロ》。",
      },
      "zh",
    ),
    /となりのトトロ/,
  );
  assert.match(
    helpers.summarizeNoteTranslationFailures([{ code: "RATE_LIMITED" }]),
    /请求受限/,
  );
  assert.match(
    helpers.summarizeNoteTranslationFailures([
      { code: "INVALID_TRANSLATION" },
    ]),
    /主要为英文/,
  );
  assert.match(
    helpers.summarizeNoteTranslationFailures([{ code: "PROVIDER_ERROR" }]),
    /请求失败/,
  );
  assert.match(
    helpers.summarizeNoteTranslationFailures([{ code: "EMPTY_RESPONSE" }]),
    /空内容/,
  );
  assert.match(
    helpers.summarizeNoteTranslationFailures([{ code: "INVALID_JSON" }]),
    /格式无法解析/,
  );
  assert.match(
    helpers.summarizeNoteTranslationFailures([{ code: "MISSING_ITEM" }]),
    /漏掉了这条笔记/,
  );
  assert.match(
    helpers.summarizeNoteTranslationFailures([
      { code: "MULTIPLE_CANDIDATES" },
    ]),
    /多个冲突结果/,
  );
  assert.match(
    helpers.summarizeNoteTranslationFailures([{ code: "CONTENT_FILTERED" }]),
    /未返回这条内容/,
  );
});

test("clicking the active Chinese notes mode retries once without duplicate requests", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      const elements = new Map();
      let requests = 0;
      let resolveTranslation;
      const element = (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            hidden: false,
            textContent: "",
            classList: { toggle() {} },
            setAttribute() {},
          });
        }
        return elements.get(id);
      };
      document.getElementById = element;
      document.querySelectorAll = () => [];
      renderNotes = () => {};
      currentNotesMode = "zh";
      currentNotes = [
        { id: "note_retry", text: "Retry this English note.", videoTitle: "Video" },
      ];
      isNotesLoading = false;
      isNotesTranslationLoading = false;
      chrome.runtime.sendMessage = (message) => {
        if (message.action !== "translateNotes") return Promise.resolve({});
        requests += 1;
        return new Promise((resolve) => { resolveTranslation = resolve; });
      };
      return {
        click: (mode) => handleNotesModeChange(mode),
        setMode: (mode) => { currentNotesMode = mode; },
        resolve: () => resolveTranslation({
          success: true,
          translations: [{ id: "note_retry", textZh: "重试后的中文笔记。" }],
          failures: [],
        }),
        snapshot: () => JSON.stringify({
          requests,
          loading: isNotesTranslationLoading,
          translatedText: currentNotes[0].translatedText || "",
        }),
      };
    })()
  `);

  fixture.click("zh");
  fixture.click("zh");
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    requests: 1,
    loading: true,
    translatedText: "",
  });

  fixture.resolve();
  await nextTurn();
  fixture.click("zh");
  fixture.setMode("original");
  fixture.click("original");
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    requests: 1,
    loading: false,
    translatedText: "重试后的中文笔记。",
  });
});

test("a fast failed same-mode retry is debounced before the second click", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      const elements = new Map();
      let requests = 0;
      const element = (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            hidden: false,
            textContent: "",
            classList: { toggle() {} },
          });
        }
        return elements.get(id);
      };
      document.getElementById = element;
      document.querySelectorAll = () => [];
      renderNotes = () => {};
      currentNotesMode = "zh";
      currentNotes = [{ id: "note_fast", text: "Fast failed note." }];
      chrome.runtime.sendMessage = async (message) => {
        if (message.action !== "translateNotes") return {};
        requests += 1;
        return {
          success: false,
          translations: [],
          failures: [{ id: "note_fast", code: "PROVIDER_ERROR" }],
        };
      };
      return {
        click: () => handleNotesModeChange("zh"),
        snapshot: () => JSON.stringify({
          requests,
          loading: isNotesTranslationLoading,
          status: element("notesLanguageStatus").textContent,
        }),
      };
    })()
  `);

  fixture.click();
  await nextTurn();
  fixture.click();
  await nextTurn();
  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.requests, 1);
  assert.equal(snapshot.loading, false);
  assert.match(snapshot.status, /请求失败/);
});

test("a stuck notes message exits loading state at the translation watchdog", async () => {
  const timers = createFakeTimers();
  const runtime = loadSidepanelRuntime({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });
  const fixture = runtime.evaluate(`
    (() => {
      const elements = new Map();
      let resolveTranslation;
      const element = (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            hidden: false,
            textContent: "",
            classList: { toggle() {} },
          });
        }
        return elements.get(id);
      };
      document.getElementById = element;
      document.querySelectorAll = () => [];
      renderNotes = () => {};
      currentNotesMode = "zh";
      currentNotes = [{ id: "note_stuck", text: "A stuck note." }];
      chrome.runtime.sendMessage = () =>
        new Promise((resolve) => { resolveTranslation = resolve; });
      return {
        run: () => ensureNotesChinese(),
        resolveLate: () => resolveTranslation({
          success: true,
          translations: [{ id: "note_stuck", textZh: "迟到的中文。" }],
          failures: [],
        }),
        snapshot: () => JSON.stringify({
          loading: isNotesTranslationLoading,
          status: element("notesLanguageStatus").textContent,
          translatedText: currentNotes[0].translatedText || "",
        }),
      };
    })()
  `);

  const request = fixture.run();
  assert.equal(timers.activeCount(130_000), 1);
  timers.fireActive(130_000);
  await request;
  const timedOut = JSON.parse(fixture.snapshot());
  assert.equal(timedOut.loading, false);
  assert.match(timedOut.status, /130 秒后超时/);
  assert.equal(timedOut.translatedText, "");

  fixture.resolveLate();
  await nextTurn();
  assert.deepEqual(JSON.parse(fixture.snapshot()), timedOut);
});

test("switching notes to original invalidates a pending translation response", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      const elements = new Map();
      let resolveTranslation;
      const element = (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            hidden: false,
            textContent: "",
            classList: { toggle() {} },
          });
        }
        return elements.get(id);
      };
      document.getElementById = element;
      document.querySelectorAll = () => [];
      renderNotes = () => {};
      currentNotesMode = "zh";
      currentNotes = [{ id: "note_pending", text: "Pending note." }];
      chrome.runtime.sendMessage = () =>
        new Promise((resolve) => { resolveTranslation = resolve; });
      return {
        start: () => handleNotesModeChange("zh"),
        showOriginal: () => handleNotesModeChange("original"),
        resolve: () => resolveTranslation({
          success: false,
          translations: [],
          failures: [{ id: "note_pending", code: "PROVIDER_ERROR" }],
        }),
        snapshot: () => JSON.stringify({
          mode: currentNotesMode,
          loading: isNotesTranslationLoading,
          status: element("notesLanguageStatus").textContent,
          statusHidden: element("notesLanguageStatus").hidden,
        }),
      };
    })()
  `);

  fixture.start();
  fixture.showOriginal();
  fixture.resolve();
  await nextTurn();
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    mode: "original",
    loading: false,
    status: "",
    statusHidden: true,
  });
});

test("one notes retry action sends only one bounded ten-note batch", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      const elements = new Map();
      const requests = [];
      const element = (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            hidden: false,
            textContent: "",
            classList: { toggle() {} },
          });
        }
        return elements.get(id);
      };
      document.getElementById = element;
      document.querySelectorAll = () => [];
      renderNotes = () => {};
      currentNotesMode = "zh";
      currentNotes = Array.from({ length: 23 }, (_, index) => ({
        id: "note_" + index,
        text: "English note " + index + ".",
      }));
      chrome.runtime.sendMessage = async (message) => {
        requests.push(message.notes.map((note) => note.id));
        return {
          success: true,
          translations: message.notes.map((note) => ({
            id: note.id,
            textZh: "中文 " + note.id,
          })),
          failures: [],
        };
      };
      return {
        run: () => ensureNotesChinese(),
        snapshot: () => JSON.stringify({
          requests,
          remaining: currentNotes.filter((note) => !noteChineseText(note)).length,
          status: element("notesLanguageStatus").textContent,
        }),
      };
    })()
  `);

  await fixture.run();
  const snapshot = JSON.parse(fixture.snapshot());
  assert.deepEqual(snapshot.requests, [
    Array.from({ length: 10 }, (_, index) => `note_${index}`),
  ]);
  assert.equal(snapshot.remaining, 13);
  assert.match(snapshot.status, /13 条中文笔记仍未生成/);
});

test("content failures rotate behind untried notes on the next bounded retry", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      const elements = new Map();
      const requests = [];
      const element = (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            hidden: false,
            textContent: "",
            classList: { toggle() {} },
          });
        }
        return elements.get(id);
      };
      document.getElementById = element;
      document.querySelectorAll = () => [];
      renderNotes = () => {};
      currentNotesMode = "zh";
      currentNotes = Array.from({ length: 12 }, (_, index) => ({
        id: "note_" + index,
        text: "English note " + index + ".",
      }));
      chrome.runtime.sendMessage = async (message) => {
        const ids = message.notes.map((note) => note.id);
        requests.push(ids);
        if (requests.length === 1) {
          return {
            success: false,
            translations: [],
            failures: ids.map((id) => ({ id, code: "INVALID_TRANSLATION" })),
          };
        }
        return {
          success: true,
          translations: ids.map((id) => ({ id, textZh: "中文 " + id })),
          failures: [],
        };
      };
      return {
        run: () => ensureNotesChinese(),
        requests: () => JSON.stringify(requests),
      };
    })()
  `);

  await fixture.run();
  await fixture.run();
  const requests = JSON.parse(fixture.requests());
  assert.deepEqual(requests[0],
    Array.from({ length: 10 }, (_, index) => `note_${index}`));
  assert.deepEqual(requests[1].slice(0, 2), ["note_10", "note_11"]);
});

test("notes loading blocks stale same-mode retries and ignores older filter results", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      const pendingLoads = new Map();
      const translationRequests = [];
      const elements = new Map();
      const element = (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            hidden: false,
            textContent: "",
            classList: { toggle() {} },
            setAttribute() {},
          });
        }
        return elements.get(id);
      };
      document.getElementById = element;
      document.querySelectorAll = () => [];
      renderNotes = () => {};
      currentNotesMode = "zh";
      currentNotes = [{ id: "old_note", text: "Old note." }];
      chrome.runtime.sendMessage = (message) => {
        if (message.action === "getNotes") {
          return new Promise((resolve) => {
            pendingLoads.set(String(message.videoId), resolve);
          });
        }
        if (message.action === "translateNotes") {
          translationRequests.push(message.notes.map((note) => note.id));
          return Promise.resolve({
            success: true,
            translations: message.notes.map((note) => ({
              id: note.id,
              textZh: "中文 " + note.id,
            })),
            failures: [],
          });
        }
        return Promise.resolve({});
      };
      return {
        load: (videoId) => loadNotes(videoId),
        clickActive: () => handleNotesModeChange("zh"),
        resolve: (videoId, notes) => pendingLoads.get(String(videoId))({
          success: true,
          notes,
        }),
        snapshot: () => JSON.stringify({
          noteIds: currentNotes.map((note) => note.id),
          translationRequests,
          isNotesLoading,
          notesFilterShowAll,
        }),
      };
    })()
  `);

  const oldLoad = fixture.load("old-video");
  const latestLoad = fixture.load(null);
  fixture.clickActive();
  assert.deepEqual(JSON.parse(fixture.snapshot()).translationRequests, []);

  fixture.resolve(null, [
    { id: "new_note", text: "New note.", videoTitle: "New video" },
  ]);
  await latestLoad;
  await nextTurn();
  fixture.resolve("old-video", [
    { id: "stale_note", text: "Stale note.", videoTitle: "Old video" },
  ]);
  await oldLoad;
  await nextTurn();

  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    noteIds: ["new_note"],
    translationRequests: [["new_note"]],
    isNotesLoading: false,
    notesFilterShowAll: true,
  });
});

test("a failed notes filter load restores the last successful filter state", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      currentNotesFilterVideoId = "video-a";
      notesFilterShowAll = false;
      chrome.runtime.sendMessage = async () => ({ success: false });
      return {
        loadAll: () => loadNotes(null),
        snapshot: () => JSON.stringify({
          notesFilterShowAll,
          currentNotesFilterVideoId,
        }),
      };
    })()
  `);

  await fixture.loadAll();
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    notesFilterShowAll: false,
    currentNotesFilterVideoId: "video-a",
  });
});

test("overview analysis validation builds the v3 Chinese-base schema", () => {
  const background = loadBackgroundHelpers();
  const normalized = background.validateAndFixTimestamps(
    {
      detectedSourceLanguage: "en",
      chapters: [
        {
          titleZh: "中文标题",
          summaryZh: "中文摘要。",
          timestampSeconds: 5,
        },
        {
          titleZh: "缺少摘要",
          timestampSeconds: 9,
        },
      ],
      keyQuotes: [
        {
          quoteOriginal: "English quote.",
          quoteZh: "中文引语。",
          timestampSeconds: 12,
        },
        {
          quoteOriginal: "Missing Chinese quote.",
          timestampSeconds: 15,
        },
      ],
      keyMoments: [5, 12, 999],
    },
    100,
    "en",
  );

  assert.equal(normalized.schemaVersion, 3);
  assert.equal(normalized.baseLanguage, "zh-Hans");
  assert.equal(normalized.sourceLanguage, "en");
  assert.equal(normalized.chapters.length, 1);
  assert.equal(normalized.chapters[0].titleZh, "中文标题");
  assert.equal(normalized.chapters[0].summaryZh, "中文摘要。");
  assert.equal(normalized.keyQuotes.length, 1);
  assert.equal(normalized.keyQuotes[0].quoteOriginal, "English quote.");
  assert.equal(normalized.keyQuotes[0].quoteZh, "中文引语。");
  assert.deepEqual(normalized.keyMoments, [5, 12]);

  const chineseSource = background.validateAndFixTimestamps(
    {
      chapters: [
        { titleZh: "标题", summaryZh: "中文摘要。", timestampSeconds: 0 },
      ],
      keyQuotes: [
        {
          quoteOriginal: "原始中文引语。",
          quoteZh: "不应采用的回译。",
          timestampSeconds: 0,
        },
      ],
    },
    10,
    "zh-CN",
  );
  assert.equal(chineseSource.keyQuotes[0].quoteZh, "原始中文引语。");

  const detected = background.validateAndFixTimestamps(
    {
      detectedSourceLanguage: "ja",
      chapters: [
        { titleZh: "标题", summaryZh: "中文摘要。", timestampSeconds: 0 },
      ],
      keyQuotes: [
        {
          quoteOriginal: "元の引用です。",
          quoteZh: "中文引语。",
          timestampSeconds: 0,
        },
      ],
    },
    10,
    "und",
  );
  assert.equal(detected.sourceLanguage, "ja");
});

test("overview generates Chinese first and translates chapters to the source language on demand", async () => {
  const requests = [];
  const background = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        const file = url.endsWith("translation.md")
          ? "prompts/translation.md"
          : "prompts/analysis.md";
        return { ok: true, text: async () => read(file) };
      }
      requests.push(JSON.parse(options.body));
      const content =
        requests.length === 1
          ? {
              detectedSourceLanguage: "en",
              chapters: [
                {
                  titleZh: "开场",
                  summaryZh: "开场部分。",
                  timestampSeconds: 0,
                },
              ],
              keyQuotes: [
                {
                  quoteOriginal: "Hello world.",
                  quoteZh: "你好，世界。",
                  timestampSeconds: 0,
                },
              ],
              keyMoments: [0],
            }
          : {
              chapters: [
                {
                  id: "chapter-0",
                  titleOriginal: "Opening",
                  summaryOriginal: "The opening section.",
                },
              ],
            };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(content),
              },
            },
          ],
        }),
      };
    },
  });

  const chineseResult = await background.handleAnalyzeTranscript(
    "[0:00] Hello world.",
    "Example video",
    "Example channel",
    "Example description",
    60,
    "en",
  );
  assert.equal(chineseResult.success, true);
  assert.equal(chineseResult.analysis.sourceLanguage, "en");
  assert.equal(chineseResult.analysis.chapters[0].titleZh, "开场");
  assert.equal(chineseResult.analysis.keyQuotes[0].quoteOriginal, "Hello world.");
  assert.equal(chineseResult.analysis.keyQuotes[0].quoteZh, "你好，世界。");
  assert.equal(requests.length, 1, "default Chinese overview uses one AI call");

  const originalResult = await background.handleTranslateOverviewOriginal(
    chineseResult.analysis,
    "Example video",
    "en",
  );

  assert.equal(originalResult.success, true);
  assert.equal(
    originalResult.originalOverview.chapters[0].titleOriginal,
    "Opening",
  );
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /Simplified Chinese structural overview/);
  assert.match(requests[0].messages[0].content, /do not draft an English overview first/);
  assert.match(
    requests[1].messages[0].content,
    /Translate this Simplified Chinese YouTube overview into English/,
  );
});

test("Chinese-source overview rejects redundant original translation", async () => {
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      throw new Error("Chinese source must not call original translation");
    },
  });
  const analysis = {
    schemaVersion: 3,
    baseLanguage: "zh-Hans",
    sourceLanguage: "zh-CN",
    chapters: [{ titleZh: "标题", summaryZh: "中文摘要。" }],
    keyQuotes: [
      { quoteOriginal: "中文原句。", quoteZh: "中文原句。" },
    ],
  };

  const result = await background.handleTranslateOverviewOriginal(
    analysis,
    "中文视频",
    "zh-CN",
  );
  assert.equal(result.success, false);
  assert.match(result.error, /do not require translation/);
  assert.equal(apiCalls, 0);

  const mismatchedTarget = await background.handleTranslateOverviewOriginal(
    {
      ...analysis,
      sourceLanguage: "en",
    },
    "English video",
    "ja",
  );
  assert.equal(mismatchedTarget.success, false);
  assert.match(mismatchedTarget.error, /must match the source caption language/);
  assert.equal(apiCalls, 0);
});

test("Bilibili Chinese overview uses the shared v3 Chinese-first schema in one call", async () => {
  const requests = [];
  const background = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/analysis.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  detectedSourceLanguage: "zh-CN",
                  chapters: [
                    {
                      titleZh: "开场",
                      summaryZh: "介绍本期主题。",
                      timestampSeconds: 0,
                    },
                  ],
                  keyQuotes: [
                    {
                      quoteOriginal: "先把问题想清楚。",
                      quoteZh: "先把问题想清楚。",
                      timestampSeconds: 0,
                    },
                  ],
                  keyMoments: [0],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const result = await background.handleAnalyzeTranscript(
    "[0:00] 先把问题想清楚。",
    "示例视频",
    "示例作者",
    "示例简介",
    60,
    "zh-CN",
    "bilibili",
  );

  assert.equal(result.success, true);
  assert.equal(requests.length, 1);
  const requestText = requests[0].messages
    .map((message) => message.content)
    .join("\n");
  assert.match(requestText, /Simplified Chinese structural overview/);
  assert.match(requestText, /Source platform: bilibili/);
  assert.match(requestText, /SOURCE CAPTION LANGUAGE: zh-CN/);
  assert.doesNotMatch(requestText, /English structural overview/);
  assert.equal(result.analysis.schemaVersion, 3);
  assert.equal(result.analysis.baseLanguage, "zh-Hans");
  assert.equal(result.analysis.sourceLanguage, "zh-CN");
  assert.equal(result.analysis.chapters[0].titleZh, "开场");
  assert.equal(result.analysis.chapters[0].summaryZh, "介绍本期主题。");
  assert.equal(result.analysis.keyQuotes[0].quoteOriginal, "先把问题想清楚。");
  assert.equal(result.analysis.keyQuotes[0].quoteZh, "先把问题想清楚。");
});

test("Traditional Bilibili overview and notes keep source text distinct from Simplified Chinese", () => {
  const background = loadBackgroundHelpers();
  const sidepanel = loadSidepanelHelpers();
  const analysis = background.validateAndFixTimestamps(
    {
      detectedSourceLanguage: "zh-TW",
      chapters: [
        {
          titleZh: "简体标题",
          summaryZh: "这是简体中文摘要。",
          timestampSeconds: 0,
        },
      ],
      keyQuotes: [
        {
          quoteOriginal: "這是繁體原句。",
          quoteZh: "这是简体原句。",
          timestampSeconds: 5,
        },
      ],
      keyMoments: [5],
    },
    60,
    "zh-TW",
  );

  assert.equal(analysis.sourceLanguage, "zh-TW");
  assert.equal(analysis.keyQuotes[0].quoteOriginal, "這是繁體原句。");
  assert.equal(analysis.keyQuotes[0].quoteZh, "这是简体原句。");
  assert.doesNotThrow(() =>
    background.validateOverviewOriginalTranslationRequest(analysis, "zh-TW"),
  );

  const chapter = {
    ...analysis.chapters[0],
    titleOriginal: "繁體標題",
    summaryOriginal: "這是繁體中文摘要。",
  };
  assert.match(
    sidepanel.renderChapterLanguageContent(chapter, "original", "zh-TW"),
    /繁體標題/,
  );
  assert.match(
    sidepanel.renderQuoteLanguageContent(
      analysis.keyQuotes[0],
      "original",
      "zh-TW",
    ),
    /這是繁體原句/,
  );

  const traditionalBilibiliNote = {
    platform: "bilibili",
    sourceLanguage: "zh-TW",
    textLanguage: "",
    text: "這是繁體筆記。",
    rawText: "這是繁體筆記。",
  };
  assert.equal(background.noteHasChineseSource(traditionalBilibiliNote), false);
  assert.equal(sidepanel.noteHasChineseSource(traditionalBilibiliNote), false);
  const restoredTraditionalNote = {
    ...traditionalBilibiliNote,
    sourceLanguage: "",
    textLanguage: "zh-TW",
  };
  assert.equal(background.noteHasChineseSource(restoredTraditionalNote), false);
  assert.equal(sidepanel.noteHasChineseSource(restoredTraditionalNote), false);
  assert.equal(
    background.noteHasChineseSource({
      ...traditionalBilibiliNote,
      platform: "youtube",
    }),
    true,
    "the existing YouTube Chinese-note behavior remains unchanged",
  );
  assert.equal(background.shouldUseBilibiliChinese("bilibili", "zh-CN"), true);
  assert.equal(background.shouldUseBilibiliChinese("bilibili", "zh-TW"), false);
});

test("Bilibili Chinese note cleanup keeps the polished Chinese text", async () => {
  const requests = [];
  const background = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/note-cleanup.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  quote: "先把问题想清楚，再开始动手。",
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const cleaned = await background.cleanupNoteText(
    "先把问题想清楚",
    "嗯，我们应该",
    "再开始动手",
    "嗯，我们应该先把问题想清楚，再开始动手。",
    "示例视频",
    "bilibili",
    "zh-CN",
  );

  assert.equal(cleaned, "先把问题想清楚，再开始动手。");
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content, /整理成通顺、完整、可独立阅读的中文笔记/);
});

test("Bilibili timestamp note saves polished Chinese once without translation", async () => {
  const requests = [];
  let storedNotes = [];
  const mediaRef = {
    platform: "bilibili",
    bvid: "BV1zfg36ZEXi",
    aid: 123,
    cid: 40830435549,
    page: 1,
    mediaKey: "bilibili:BV1zfg36ZEXi:40830435549",
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/",
    title: "示例视频",
    channelName: "示例作者",
  };
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: {
            provider: "deepseek",
            aiApiKey: "test-key",
            aiBaseUrl: "https://api.deepseek.com",
            aiModel: "deepseek-v4-flash",
          },
        };
      }
      if (key === `digest_${mediaRef.mediaKey}`) {
        return {
          [`digest_${mediaRef.mediaKey}`]: {
            transcriptSourcePolicyVersion: 3,
            mediaRef,
            transcriptLanguage: "zh-CN",
            transcript: [
              { start: 0, text: "我们先把问题想清楚", language: "zh-CN" },
              { start: 8, text: "然后再开始动手", language: "zh-CN" },
            ],
          },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (Array.isArray(items.ytd_notes)) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/note-cleanup.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  quote: "我们先把问题想清楚，然后再开始动手。",
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const result = await background.handleSaveNote(
    mediaRef,
    5,
    "示例视频",
    "示例作者",
  );

  assert.equal(result.success, true);
  assert.equal(requests.length, 1);
  const requestText = requests[0].messages
    .map((message) => message.content)
    .join("\n");
  assert.match(requestText, /整理成通顺、完整、可独立阅读的中文笔记/);
  assert.doesNotMatch(requestText, /Translate these polished English video notes/);
  assert.equal(result.note.text, "我们先把问题想清楚，然后再开始动手。");
  assert.equal(result.note.textLanguage, "zh-CN");
  assert.equal(result.note.translatedText, "");
  assert.equal(result.note.videoId, mediaRef.mediaKey);
  assert.equal(result.note.mediaKey, mediaRef.mediaKey);
  assert.equal(result.note.platform, "bilibili");
  assert.equal(result.note.bvid, mediaRef.bvid);
  assert.equal(result.note.cid, mediaRef.cid);
  assert.equal(result.note.page, mediaRef.page);
  assert.equal(result.note.canonicalUrl, mediaRef.canonicalUrl);
  assert.match(result.note.timestampedUrl, /BV1zfg36ZEXi\/\?t=5$/);
  assert.equal(storedNotes[0].text, result.note.text);
});

test("a note saved before the first caption uses the first line instead of the last", async () => {
  let storedNotes = [];
  const mediaRef = {
    platform: "bilibili",
    bvid: "BV1zfg36ZEXi",
    aid: 123,
    cid: 40830435549,
    page: 1,
    mediaKey: "bilibili:BV1zfg36ZEXi:40830435549",
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/",
    title: "示例视频",
    channelName: "示例作者",
  };
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") return { ytd_settings: {} };
      if (key === `digest_${mediaRef.mediaKey}`) {
        return {
          [`digest_${mediaRef.mediaKey}`]: {
            transcriptSourcePolicyVersion: 3,
            mediaRef,
            transcriptLanguage: "zh-CN",
            transcript: [
              { start: 5, text: "第一条字幕。", language: "zh-CN" },
              { start: 10, text: "最后一条字幕。", language: "zh-CN" },
            ],
          },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (Array.isArray(items.ytd_notes)) storedNotes = items.ytd_notes;
    },
  });

  const result = await background.handleSaveNote(
    mediaRef,
    0,
    "示例视频",
    "示例作者",
  );

  assert.equal(result.success, true);
  assert.equal(storedNotes.length, 1);
  assert.equal(storedNotes[0].rawText, "第一条字幕。");
  assert.match(storedNotes[0].text, /^第一条字幕/);
});

test("new polished Chinese notes display cleaned text while legacy notes keep raw text", () => {
  const sidepanel = loadSidepanelHelpers();
  const polished = {
    text: "整理后的完整中文笔记。",
    rawText: "原始字幕碎片",
    sourceLanguage: "zh-CN",
    textLanguage: "zh-CN",
  };
  const legacy = {
    text: "旧清理字段",
    rawText: "旧版原始中文字幕",
    sourceLanguage: "zh-CN",
  };

  assert.equal(sidepanel.noteOriginalText(polished), "整理后的完整中文笔记。");
  assert.equal(sidepanel.noteChineseText(polished), "整理后的完整中文笔记。");
  assert.equal(sidepanel.noteOriginalText(legacy), "旧版原始中文字幕");
  assert.doesNotMatch(
    sidepanel.renderNoteLanguageContent(polished, "zh"),
    /原始字幕碎片/,
  );
});

test("Bilibili polished Chinese notes reuse cleaned text without translation", async () => {
  const note = {
    id: "note_bili_zh",
    videoId: "bilibili:BV1zfg36ZEXi:40830435549",
    mediaKey: "bilibili:BV1zfg36ZEXi:40830435549",
    platform: "bilibili",
    text: "润色后的完整中文笔记。",
    rawText: "原始字幕碎片",
    sourceLanguage: "zh-CN",
    textLanguage: "zh-CN",
    videoTitle: "示例视频",
    translatedText: "",
  };
  let storedNotes = [note];
  let providerCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) =>
      key === "ytd_notes" ? { ytd_notes: storedNotes } : {},
    storageSetImpl: async (items) => {
      if (Array.isArray(items.ytd_notes)) storedNotes = items.ytd_notes;
    },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Chinese Bilibili notes must not call the provider");
    },
  });

  const result = await background.handleTranslateNotes([note]);

  assert.equal(result.success, true);
  assert.equal(providerCalls, 0);
  assert.equal(result.translations[0].textZh, note.text);
  assert.notEqual(result.translations[0].textZh, note.rawText);
  assert.equal(storedNotes[0].translatedText, note.text);
  assert.equal(storedNotes[0].translatedValidated, true);
});

test("Traditional Bilibili notes make one provider call and persist Simplified Chinese", async () => {
  const note = {
    id: "note_bili_traditional",
    videoId: "bilibili:BV1zfg36ZEXi:40830435549",
    mediaKey: "bilibili:BV1zfg36ZEXi:40830435549",
    platform: "bilibili",
    text: "這是繁體中文筆記。",
    rawText: "這是繁體中文筆記。",
    sourceLanguage: "zh-TW",
    textLanguage: "",
    videoTitle: "示例视频",
    translatedText: "",
  };
  let storedNotes = [note];
  let providerCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (Array.isArray(items.ytd_notes)) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      providerCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [
                    {
                      id: note.id,
                      textZh: "这是繁体中文笔记。",
                    },
                  ],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const normalized = background.validateNoteTranslationRequest([note]);
  assert.equal(normalized[0].platform, "bilibili");
  assert.equal(normalized[0].sourceLanguage, "zh-TW");
  const result = await background.handleTranslateNotes([note]);

  assert.equal(result.success, true);
  assert.equal(providerCalls, 1);
  assert.equal(result.translations[0].textZh, "这是繁体中文笔记。");
  assert.equal(storedNotes[0].translatedText, "这是繁体中文笔记。");
  assert.equal(storedNotes[0].translatedValidated, true);
  assert.match(
    read("sidepanel.js"),
    /sourceLanguage: note\.sourceLanguage \|\| "",[\s\S]*?platform: note\.platform === "bilibili"[\s\S]*?textLanguage: note\.textLanguage \|\| ""/,
  );
});

test("notes generate Chinese once from polished English and persist it", async () => {
  const backgroundSource = read("background.js");
  assert.match(
    backgroundSource,
    /async function handleSaveNote\([\s\S]*?cleanupNoteText\([\s\S]*?saveNoteToStorage\(note, saveGeneration\)[\s\S]*?action: "noteSaved"/,
  );
  assert.doesNotMatch(backgroundSource, /handleTranslateNotes\(\[note\]\)/);
  assert.match(
    backgroundSource,
    /sourceLanguage:[\s\S]*?matchedLine\.language/,
  );
  const saveQuoteSource =
    read("sidepanel.js").match(
      /async function saveQuoteAsNote\([\s\S]*?\n}\n\n\/\*\*/,
    )?.[0] || "";
  assert.doesNotMatch(saveQuoteSource, /loadNotes\(/);
  const requests = [];
  let storedNotes = [
    {
      id: "note_1",
      text: "A polished English note.",
      rawText: "東京で漢字を使います。",
      sourceLanguage: "ja",
      videoTitle: "Example video",
      translatedText: "",
    },
  ];
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: {
            provider: "deepseek",
            aiApiKey: "test-key",
            aiBaseUrl: "https://api.deepseek.com",
            aiModel: "deepseek-v4-flash",
          },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id: "note_1", textZh: "一条润色后的中文笔记。" }],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(result.translations[0].textZh, "一条润色后的中文笔记。");
  assert.equal(storedNotes[0].translatedText, "一条润色后的中文笔记。");
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content, /Translate these polished English video notes/);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content), {
    notes: [
      {
        id: "note_1",
        text: "A polished English note.",
        videoTitle: "Example video",
      },
    ],
  });
});

test("technical-only notes accept an explicit unchanged model result", async () => {
  const technicalText = "OpenAI API GPT Codex Claude Code GitHub Chrome";
  let storedNotes = [
    { id: "note_tech", text: technicalText, videoTitle: "Tooling" },
  ];
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [
                    {
                      id: "note_tech",
                      textZh: technicalText,
                      unchanged: true,
                      unchangedKind: "technical",
                    },
                  ],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(apiCalls, 1);
  assert.equal(result.translations[0].textZh, technicalText);
  assert.equal(storedNotes[0].translatedText, technicalText);
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: technicalText },
      { text: technicalText },
    ).textZh,
    "",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      {
        textZh: `${technicalText} extra`,
        unchanged: true,
        unchangedKind: "technical",
      },
      { text: technicalText },
    ).textZh,
    "",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      {
        textZh: "This ordinary English sentence was not translated.",
        unchanged: true,
      },
      { text: "This ordinary English sentence was not translated." },
    ).textZh,
    "",
  );
  for (const ordinaryText of [
    "Never Give Up",
    "Build Better Products",
    "MOVE FAST",
    "Stay Hungry",
  ]) {
    assert.equal(
      background.validateNoteTranslationCandidate(
        {
          textZh: ordinaryText,
          unchanged: true,
          unchangedKind: "technical",
        },
        { text: ordinaryText },
      ).textZh,
      "",
    );
  }
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "This is still an English note, 中文." },
      { text: "This source sentence needs translation." },
    ).textZh,
    "",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "This is an entirely untranslated English note, 中文翻译。" },
      { text: "This source sentence needs translation." },
    ).textZh,
    "",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "summary 好" },
      { text: "A summary." },
    ).textZh,
    "",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "用 feature flag 做 rollout。" },
      { text: "Use a feature flag for the rollout." },
    ).textZh,
    "用 feature flag 做 rollout。",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "宫崎骏导演了《となりのトトロ》。" },
      { text: "Hayao Miyazaki directed My Neighbor Totoro." },
    ).textZh,
    "宫崎骏导演了《となりのトトロ》。",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "“好。”" },
      { text: "Good." },
    ).textZh,
    "“好。”",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "《这是中文》" },
      { text: "This is Chinese." },
    ).textZh,
    "《这是中文》",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "“This ordinary English sentence was not translated.” 好" },
      { text: "This ordinary English sentence needs translation." },
    ).textZh,
    "",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      {
        textZh: "Sam Altman",
        unchanged: true,
        unchangedKind: "proper_noun",
      },
      { text: "Sam Altman", videoTitle: "An interview with Sam Altman" },
    ).textZh,
    "Sam Altman",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      {
        textZh: "Art",
        unchanged: true,
        unchangedKind: "proper_noun",
      },
      { text: "Art", videoTitle: "Artificial Intelligence" },
    ).textZh,
    "",
  );
  for (const personName of [
    "José Álvarez",
    "Björk",
    "Jean-Luc Picard",
    "O'Connor",
  ]) {
    assert.equal(
      background.validateNoteTranslationCandidate(
        {
          textZh: personName,
          unchanged: true,
          unchangedKind: "proper_noun",
        },
        { text: personName, videoTitle: `Interview with ${personName}` },
      ).textZh,
      personName,
    );
  }
  assert.equal(
    background.validateNoteTranslationCandidate(
      {
        textZh: "東京で漢字を使います。",
        unchanged: true,
        unchangedKind: "technical",
      },
      { text: "東京で漢字を使います。", videoTitle: "Japanese lesson" },
    ).textZh,
    "",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      {
        textZh: "東京で漢字を使います。",
        unchanged: true,
        unchangedKind: "proper_noun",
      },
      {
        text: "東京で漢字を使います。",
        videoTitle: "東京で漢字を使います。",
      },
    ).textZh,
    "",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "好" },
      { text: "Good." },
    ).textZh,
    "好",
  );
  assert.equal(
    background.validateNoteTranslationCandidate(
      { textZh: "東京で漢字を使います。" },
      { text: "This is Japanese." },
    ).textZh,
    "",
  );
});

test("a valid one-character stored Chinese note is reused without an API call", async () => {
  let storedNotes = [
    { id: "note_short", text: "Good.", translatedText: "好" },
  ];
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) =>
      key === "ytd_notes" ? { ytd_notes: storedNotes } : {},
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async () => {
      apiCalls += 1;
      throw new Error("A valid stored translation must not call the API");
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(apiCalls, 0);
  assert.equal(result.translations[0].textZh, "好");
  assert.equal(storedNotes[0].translatedValidated, true);
  assert.equal(storedNotes[0].translatedValidationVersion, 1);
});

test("a unique singleton retry safely recovers a model-modified note ID", async () => {
  let storedNotes = [
    { id: "note_1", text: "First English note.", videoTitle: "Video" },
    { id: "note_2", text: "Second English note.", videoTitle: "Video" },
  ];
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      const notes =
        apiCalls === 1
          ? [
              { id: "note_1", textZh: "第一条中文笔记。" },
              { id: "note-2", textZh: "不会按批次位置写入。" },
            ]
          : [{ id: "note-2", textZh: "第二条中文笔记。" }];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ notes }) } }],
        }),
      };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(apiCalls, 2);
  assert.deepEqual(result.missingIds, []);
  assert.equal(storedNotes[0].translatedText, "第一条中文笔记。");
  assert.equal(storedNotes[1].translatedText, "第二条中文笔记。");

  const [ambiguous] = background.normalizeNoteTranslation(
    {
      notes: [
        { id: "wrong-a", textZh: "候选甲。" },
        { id: "wrong-b", textZh: "候选乙。" },
      ],
    },
    [{ id: "note_2", text: "Second English note." }],
    { allowSingletonIdRecovery: true },
  );
  assert.equal(ambiguous.textZh, "");
});

test("singleton note recovery accepts safe Flash response variants for the real note", () => {
  const background = loadBackgroundHelpers();
  const source = {
    id: "note_real_047",
    text: "The complicated part about mimetic desire is that it's not just about the products that you buy. It's about the goals that you chase, the career that you chase, and who you compete with, who you envy, who you sleep with, your values, your dreams, and your lifestyle.",
    videoTitle: "Why Everyone Is Living The Same Life",
  };
  const chinese =
    "模仿性欲望的复杂之处在于，它不仅关乎你购买的产品，也关乎你追逐的目标和事业、与你竞争或令你羡慕的人、亲密关系，以及你的价值观、梦想和生活方式。";
  const acceptedResponses = [
    chinese,
    JSON.stringify({ id: source.id, textZh: chinese }),
    JSON.stringify([{ id: source.id, textZh: chinese }]),
    JSON.stringify({ notes: [{ id: source.id, translation: chinese }] }),
    JSON.stringify({ translation: chinese }),
    JSON.stringify({
      notes: [{ id: source.id, textZh: `English: ${source.text}\n中文：${chinese}` }],
    }),
    JSON.stringify(chinese),
    `\`\`\`text\n${chinese}\n\`\`\``,
    `English: ${source.text}\n中文：${chinese}`,
  ];
  for (const response of acceptedResponses) {
    assert.equal(
      background.normalizeSingletonNoteTranslationResponse(response, source)
        .textZh,
      chinese,
    );
  }

  for (const rejectedResponse of [
    source.text,
    `{"translation":"${chinese}"`,
    JSON.stringify([
      { translation: chinese },
      { translation: "第二个冲突候选。" },
    ]),
    JSON.stringify({
      notes: [
        { id: source.id, textZh: chinese },
        { id: "another-note", textZh: "另一个候选。" },
      ],
    }),
    JSON.stringify({
      notes: [
        { id: source.id, textZh: chinese },
        { id: source.id, textZh: "冲突的重复候选。" },
      ],
    }),
    JSON.stringify({ translation: chinese, text: "冲突的另一个值。" }),
    `${source.text}\n${chinese}`,
  ]) {
    assert.equal(
      background.normalizeSingletonNoteTranslationResponse(
        rejectedResponse,
        source,
      ).textZh,
      "",
    );
  }

  const multilineChinese =
    "第一句中文。\n译文：这里只是在解释一个术语。\n最后一句中文。";
  assert.equal(
    background.normalizeSingletonNoteTranslationResponse(
      JSON.stringify({ notes: [{ id: source.id, textZh: multilineChinese }] }),
      source,
    ).textZh,
    multilineChinese,
  );
  const [strictBatchBilingual] = background.normalizeNoteTranslation(
    {
      notes: [
        { id: source.id, textZh: `English: ${source.text}\n中文：${chinese}` },
      ],
    },
    [source],
  );
  assert.equal(strictBatchBilingual.textZh, "");
  const shortOriginalBilingual =
    "English: Hi\n中文：这是一段明显足够长的中文翻译内容，用来确认批量路径不会保存整段双语。";
  const [strictShortBatchBilingual] = background.normalizeNoteTranslation(
    { notes: [{ id: source.id, textZh: shortOriginalBilingual }] },
    [source],
  );
  assert.equal(strictShortBatchBilingual.textZh, "");
  assert.equal(
    background.normalizeSingletonNoteTranslationResponse(
      JSON.stringify({
        notes: [{ id: source.id, textZh: shortOriginalBilingual }],
      }),
      source,
    ).textZh,
    "这是一段明显足够长的中文翻译内容，用来确认批量路径不会保存整段双语。",
  );
  const [duplicateBatch] = background.normalizeNoteTranslation(
    {
      notes: [
        { id: source.id, textZh: chinese },
        { id: source.id, textZh: "另一个重复结果。" },
      ],
    },
    [source],
  );
  assert.equal(duplicateBatch.textZh, "");
  assert.equal(duplicateBatch.failureCode, "MULTIPLE_CANDIDATES");
});

test("plain Chinese from a singleton retry is persisted instead of discarded", async () => {
  const sourceText =
    "The complicated part about mimetic desire is that it's not just about the products that you buy. It's about your goals, values, dreams, and lifestyle.";
  const chinese =
    "模仿性欲望的复杂之处在于，它不仅关乎购买的产品，也关乎你的目标、价值观、梦想和生活方式。";
  let storedNotes = [
    {
      id: "note_plain",
      text: sourceText,
      videoTitle: "Why Everyone Is Living The Same Life",
    },
  ];
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      const content =
        apiCalls === 1 ? JSON.stringify({ notes: [] }) : chinese;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(apiCalls, 2);
  assert.equal(storedNotes[0].translatedText, chinese);
});

test("note recovery keeps provider calls bounded for persistently invalid JSON shapes", async () => {
  let storedNotes = Array.from({ length: 10 }, (_, index) => ({
    id: `note_${index}`,
    text: `English note number ${index}.`,
    videoTitle: "Video",
  }));
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify({ notes: [] }) } },
          ],
        }),
      };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, false);
  assert.equal(apiCalls, 5);
  assert.equal(result.missingIds.length, 10);
  assert.ok(
    result.failures.some(
      (failure) => failure.code === "RETRY_BUDGET_EXHAUSTED",
    ),
  );
  assert.equal(
    storedNotes.some((note) => Boolean(note.translatedText)),
    false,
  );
});

test("a rate limit on the final provider-call slot starts cooldown without waiting", async () => {
  let storedNotes = Array.from({ length: 10 }, (_, index) => ({
    id: `note_${index}`,
    text: `English note number ${index}.`,
    videoTitle: "Video",
  }));
  let apiCalls = 0;
  const waits = [];
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      if (apiCalls === 5) {
        return { ok: false, status: 429, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify({ notes: [] }) } },
          ],
        }),
      };
    },
  });

  const first = await background.handleTranslateNotes(storedNotes, {
    wait: async (delay) => waits.push(delay),
  });
  assert.equal(apiCalls, 5);
  assert.deepEqual(waits, []);
  assert.ok(
    first.failures.some((failure) => failure.code === "RATE_LIMITED"),
  );

  const second = await background.handleTranslateNotes(storedNotes, {
    wait: async (delay) => waits.push(delay),
  });
  assert.equal(apiCalls, 5, "cooldown must prevent an immediate provider retry");
  assert.ok(second.failures.every((failure) => failure.code === "RATE_LIMITED"));
});

test("a notes deadline includes queue wait and lets the next fresh job continue", async () => {
  let storedNotes = [
    { id: "note_1", text: "First note.", videoTitle: "Video" },
    { id: "note_2", text: "Second note.", videoTitle: "Video" },
  ];
  let apiCalls = 0;
  let releaseFirst;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      const [{ id }] = JSON.parse(options.body).messages
        .map((message) => {
          try {
            return JSON.parse(message.content).notes || [];
          } catch (_error) {
            return [];
          }
        })
        .find((notes) => notes.length);
      const response = {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id, textZh: `中文 ${id}` }],
                }),
              },
            },
          ],
        }),
      };
      if (apiCalls === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve(response);
        });
      }
      return response;
    },
  });

  const first = background.handleTranslateNotes([storedNotes[0]]);
  await nextTurn();
  const expired = background.handleTranslateNotes([storedNotes[1]], {
    deadlineAt: Date.now() - 1,
  });
  releaseFirst();
  assert.equal((await first).success, true);

  const expiredResult = await expired;
  assert.equal(expiredResult.success, false);
  assert.equal(apiCalls, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(expiredResult.failures)), [
    { id: "note_2", code: "NOTE_JOB_TIMEOUT" },
  ]);

  const fresh = await background.handleTranslateNotes([storedNotes[1]]);
  assert.equal(fresh.success, true);
  assert.equal(apiCalls, 2);
});

test("a hung notes storage read times out without permanently blocking the queue", async () => {
  let ytdNotesReads = 0;
  let apiCalls = 0;
  const storedNotes = [
    { id: "note_storage", text: "Storage note.", videoTitle: "Video" },
  ];
  const background = loadBackgroundHelpers({
    setTimeoutImpl: (callback, delay) => setTimeout(callback, delay),
    clearTimeoutImpl: (id) => clearTimeout(id),
    storageGetImpl: async (key) => {
      if (key === "ytd_notes") {
        ytdNotesReads += 1;
        if (ytdNotesReads === 1) return new Promise(() => {});
        return { ytd_notes: storedNotes };
      }
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      return {};
    },
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      const userPayload = JSON.parse(
        JSON.parse(options.body).messages.at(-1).content,
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [
                    { id: userPayload.notes[0].id, textZh: "存储恢复后的中文。" },
                  ],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const timedOut = await background.handleTranslateNotes(storedNotes, {
    deadlineAt: Date.now() + 15,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(timedOut.failures)), [
    { id: "note_storage", code: "NOTE_JOB_TIMEOUT" },
  ]);

  const recovered = await background.handleTranslateNotes(storedNotes);
  assert.equal(recovered.success, true);
  assert.equal(apiCalls, 1);
});

test("a timed-out persist read cannot perform a late write or block a fresh save", async () => {
  let storedNotes = [
    { id: "note_persist", text: "Persist note.", videoTitle: "Video" },
  ];
  let ytdNotesReads = 0;
  let releasePersistRead;
  let storageSets = 0;
  const background = loadBackgroundHelpers({
    setTimeoutImpl: (callback, delay) => setTimeout(callback, delay),
    clearTimeoutImpl: (id) => clearTimeout(id),
    storageGetImpl: async (key) => {
      if (key === "ytd_notes") {
        ytdNotesReads += 1;
        if (ytdNotesReads === 2) {
          return new Promise((resolve) => {
            releasePersistRead = () => resolve({ ytd_notes: storedNotes });
          });
        }
        return { ytd_notes: storedNotes };
      }
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      return {};
    },
    storageSetImpl: async (items) => {
      storageSets += 1;
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id: "note_persist", textZh: "持久化中文。" }],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const timedOut = await background.handleTranslateNotes(storedNotes, {
    deadlineAt: Date.now() + 20,
  });
  assert.equal(timedOut.success, false);
  assert.equal(storageSets, 0);

  releasePersistRead();
  await nextTurn();
  assert.equal(storageSets, 0, "a late read must not continue into storage.set");

  await background.saveNoteToStorage({
    id: "note_after_timeout",
    text: "Saved after timeout.",
  });
  assert.equal(storageSets, 1);
  assert.equal(storedNotes[0].id, "note_after_timeout");
});

test("an in-flight storage commit keeps later note jobs behind the write queue", async () => {
  let storedNotes = [
    { id: "note_commit", text: "Commit note.", videoTitle: "Video" },
  ];
  let apiCalls = 0;
  let blockedCommit = false;
  let releaseCommit;
  let commitStarted;
  const commitStartedPromise = new Promise((resolve) => {
    commitStarted = resolve;
  });
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
      if (
        !blockedCommit &&
        storedNotes.some((note) => note.translatedText === "提交中的中文。")
      ) {
        blockedCommit = true;
        commitStarted();
        return new Promise((resolve) => {
          releaseCommit = resolve;
        });
      }
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id: "note_commit", textZh: "提交中的中文。" }],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const first = background.handleTranslateNotes(storedNotes);
  await commitStartedPromise;
  const queued = background.handleTranslateNotes(storedNotes);
  await nextTurn();
  assert.equal(apiCalls, 1);

  releaseCommit();
  assert.equal((await first).success, true);
  assert.equal((await queued).success, true);
  assert.equal(apiCalls, 1, "the queued job must reuse the committed translation");
});

test("a notes deadline prevents a rate-limit backoff from starting another call", async () => {
  let storedNotes = [
    { id: "note_deadline", text: "Deadline note.", videoTitle: "Video" },
  ];
  let apiCalls = 0;
  const waits = [];
  let now = 1_000;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes, {
    now: () => now,
    deadlineAt: 1_500,
    wait: async (delay) => {
      waits.push(delay);
      now += delay;
    },
  });
  assert.equal(apiCalls, 1);
  assert.deepEqual(waits, []);
  assert.deepEqual(JSON.parse(JSON.stringify(result.failures)), [
    { id: "note_deadline", code: "NOTE_JOB_TIMEOUT" },
  ]);
});

test("a notes provider call receives only its remaining hard-timeout budget", async () => {
  const timerDelays = [];
  const background = loadBackgroundHelpers({
    setTimeoutImpl(_callback, delay) {
      timerDelays.push(delay);
      return timerDelays.length;
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "done" } }],
      }),
    }),
  });

  await background.requestAiCompletion({
    maxTokens: 32,
    hardTimeoutMs: 750,
    messages: [{ role: "user", content: "Hello" }],
  });
  assert.ok(timerDelays.includes(750));
  assert.ok(timerDelays.includes(50_000));
});

test("notes reuse the deadline-bounded settings snapshot before provider fetch", async () => {
  let storedNotes = [
    { id: "note_settings", text: "Settings note.", videoTitle: "Video" },
  ];
  let settingsReads = 0;
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      if (key === "ytd_settings") {
        settingsReads += 1;
        if (settingsReads > 1) return new Promise(() => {});
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id: "note_settings", textZh: "设置中文。" }],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(settingsReads, 1);
  assert.equal(apiCalls, 1);
});

test("Chinese source notes reuse their raw subtitle without an API call", async () => {
  let storedNotes = [
    {
      id: "note_zh",
      text: "Polished fallback text.",
      rawText: "这条原字幕已经是中文。",
      sourceLanguage: "zh-CN",
      videoTitle: "示例视频",
    },
    {
      id: "note_zh_legacy",
      text: "Legacy fallback text.",
      rawText: "这条旧笔记没有语言字段，但原字幕是中文。",
      videoTitle: "旧视频",
    },
  ];
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) =>
      key === "ytd_notes" ? { ytd_notes: storedNotes } : {},
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async () => {
      apiCalls += 1;
      throw new Error("Chinese source notes must not call the API");
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(apiCalls, 0);
  assert.equal(result.translations[0].textZh, "这条原字幕已经是中文。");
  assert.equal(
    result.translations[1].textZh,
    "这条旧笔记没有语言字段，但原字幕是中文。",
  );
  assert.equal(storedNotes[0].translatedText, "这条原字幕已经是中文。");
  assert.equal(
    storedNotes[1].translatedText,
    "这条旧笔记没有语言字段，但原字幕是中文。",
  );
  assert.equal(background.noteHasChineseSource(storedNotes[0]), true);
  assert.equal(background.noteHasChineseSource(storedNotes[1]), true);
  assert.equal(background.noteHasChineseSource({ rawText: "对" }), true);
  assert.equal(background.noteHasChineseSource({ rawText: "“你好”" }), true);
  assert.equal(
    background.noteHasChineseSource({ rawText: "《中文标题》" }),
    true,
  );
  assert.equal(
    background.noteHasChineseSource({
      rawText: "这段中文引用了《となりのトトロ》。",
    }),
    true,
  );
  assert.equal(
    background.noteHasChineseSource({ rawText: "東京で漢字を使います。" }),
    false,
  );
  assert.equal(
    background.noteHasChineseSource({ rawText: "Beijing 北京 is a city." }),
    false,
  );
});

test("missing note translations retry individually instead of discarding the batch", async () => {
  const requests = [];
  let storedNotes = [
    { id: "note_1", text: "First English note.", videoTitle: "Video" },
    { id: "note_2", text: "Second English note.", videoTitle: "Video" },
  ];
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      const notes =
        requests.length === 1
          ? [{ id: "note_1", textZh: "第一条中文笔记。" }]
          : [{ id: "note_2", textZh: "第二条中文笔记。" }];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ notes }) } }],
        }),
      };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.missingIds, []);
  assert.equal(storedNotes[0].translatedText, "第一条中文笔记。");
  assert.equal(storedNotes[1].translatedText, "第二条中文笔记。");
});

test("valid note translations persist even when another item still fails", async () => {
  let storedNotes = [
    { id: "note_1", text: "First English note.", videoTitle: "Video" },
    { id: "note_2", text: "Second English note.", videoTitle: "Video" },
  ];
  let apiCall = 0;
  const waits = [];
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCall += 1;
      if (apiCall === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    notes: [{ id: "note_1", textZh: "第一条中文笔记。" }],
                  }),
                },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 429, json: async () => ({}) };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes, {
    wait: async (delay) => waits.push(delay),
  });
  assert.equal(result.success, true);
  assert.equal(apiCall, 3);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(result.missingIds, ["note_2"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.failures)), [
    { id: "note_2", code: "RATE_LIMITED" },
  ]);
  assert.equal(storedNotes[0].translatedText, "第一条中文笔记。");
  assert.equal(storedNotes[1].translatedText, undefined);
});

test("concurrent requests for the same note serialize and call the API once", async () => {
  let storedNotes = [
    { id: "note_1", text: "English note.", videoTitle: "Video" },
  ];
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id: "note_1", textZh: "中文笔记。" }],
                }),
              },
            },
          ],
        }),
      };
    },
  });
  const request = [
    { id: "note_1", text: "English note.", videoTitle: "Video" },
  ];

  const [first, second] = await Promise.all([
    background.handleTranslateNotes(request),
    background.handleTranslateNotes(request),
  ]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(apiCalls, 1);
  assert.equal(storedNotes[0].translatedText, "中文笔记。");
});

test("note translation, save, and delete share one storage write queue", async () => {
  let storedNotes = [
    { id: "note_1", text: "English note.", videoTitle: "Video" },
  ];
  let signalTranslationWrite;
  const translationWriteStarted = new Promise((resolve) => {
    signalTranslationWrite = resolve;
  });
  let releaseTranslationWrite;
  const translationWriteGate = new Promise((resolve) => {
    releaseTranslationWrite = resolve;
  });
  let blockedTranslationWrite = false;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") {
        return { ytd_notes: storedNotes.map((note) => ({ ...note })) };
      }
      return {};
    },
    storageSetImpl: async (items) => {
      if (!Array.isArray(items.ytd_notes)) return;
      const nextNotes = items.ytd_notes.map((note) => ({ ...note }));
      if (
        !blockedTranslationWrite &&
        nextNotes.some((note) => note.translatedText === "中文笔记。")
      ) {
        blockedTranslationWrite = true;
        signalTranslationWrite();
        await translationWriteGate;
      }
      storedNotes = nextNotes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id: "note_1", textZh: "中文笔记。" }],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const translation = background.handleTranslateNotes(storedNotes);
  await translationWriteStarted;
  const save = background.saveNoteToStorage({
    id: "note_new",
    text: "New note.",
    videoTitle: "Video",
  });
  const deletion = background.handleDeleteNote("note_1");
  releaseTranslationWrite();

  const [translationResult, deletionResult] = await Promise.all([
    translation,
    deletion,
    save,
  ]);
  assert.equal(translationResult.success, true);
  assert.equal(deletionResult.success, true);
  assert.deepEqual(
    storedNotes.map((note) => note.id),
    ["note_new"],
  );
});

test("missing content receiver requires a page refresh instead of reinjection", async () => {
  const background = loadBackgroundHelpers();
  const sendCalls = [];
  const injectionCalls = [];
  const waitCalls = [];
  await assert.rejects(
    background.sendMessageToContentWithRecovery(
      17,
      { action: "getVideoInfo" },
      {
        async sendMessage(tabId, message) {
          sendCalls.push({ tabId, message });
          throw new Error(
            "Could not establish connection. Receiving end does not exist.",
          );
        },
        async executeScript(details) {
          injectionCalls.push(details);
        },
        async wait(delay) {
          waitCalls.push(delay);
        },
      },
    ),
    (error) => {
      assert.equal(error.code, "PAGE_REFRESH_REQUIRED");
      assert.match(error.message, /刷新当前 YouTube 页面/);
      return true;
    },
  );

  assert.equal(sendCalls.length, 4);
  assert.deepEqual(waitCalls, [150, 350, 700]);
  assert.deepEqual(injectionCalls, []);
  assert.equal(
    background.isPageRefreshRequiredError({
      code: "PAGE_REFRESH_REQUIRED",
    }),
    true,
  );
  assert.equal(
    background.isPageRefreshRequiredError({
      code: "PAGE_CONTEXT_CHANGED",
    }),
    false,
  );
});

test("content messaging retries normal document startup without reinjection", async () => {
  const background = loadBackgroundHelpers();
  const waitCalls = [];
  const injectionCalls = [];
  let sendCount = 0;
  const result = await background.sendMessageToContentWithRecovery(
    17,
    { action: "getVideoInfo" },
    {
      async sendMessage() {
        sendCount += 1;
        if (sendCount === 1) {
          throw new Error(
            "Could not establish connection. Receiving end does not exist.",
          );
        }
        return { title: "Ready after document_idle" };
      },
      async executeScript(details) {
        injectionCalls.push(details);
      },
      async wait(delay) {
        waitCalls.push(delay);
      },
    },
  );

  assert.deepEqual(result, { title: "Ready after document_idle" });
  assert.equal(sendCount, 2);
  assert.deepEqual(waitCalls, [150]);
  assert.deepEqual(injectionCalls, []);
});

test("missing content receiver classification stays narrow", () => {
  const background = loadBackgroundHelpers();
  assert.equal(
    background.isMissingContentReceiverError(
      new Error(
        "Could not establish connection. Receiving end does not exist.",
      ),
    ),
    true,
  );
  assert.equal(
    background.isMissingContentReceiverError(
      new Error("Could not establish connection."),
    ),
    false,
  );
});

test("relayToContent honors the exact Bilibili tab without active-tab fallback", async () => {
  const exactTab = {
    id: 21,
    url: "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=2",
  };
  const activeOtherTab = {
    id: 99,
    url: "https://www.youtube.com/watch?v=ydTeb_I0b94",
  };
  const reads = [];
  const sends = [];
  let queryCount = 0;
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get(tabId) {
        reads.push(tabId);
        return tabId === exactTab.id ? exactTab : activeOtherTab;
      },
      async query() {
        queryCount += 1;
        return [activeOtherTab];
      },
      async sendMessage(tabId, message) {
        sends.push({ tabId, message });
        return { title: "Bilibili video P2" };
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: exactTab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    success: true,
    response: { title: "Bilibili video P2" },
  });
  assert.deepEqual(reads, [exactTab.id]);
  assert.deepEqual(sends, [
    { tabId: exactTab.id, message: { action: "getVideoInfo" } },
  ]);
  assert.equal(queryCount, 0);
  assert.doesNotMatch(read("background.js"), /files:\s*\["bilibili\.js",\s*"content-bilibili\.js"\]/);
});

test("relay recovery does not hide unrelated messaging failures", async () => {
  const background = loadBackgroundHelpers();
  assert.equal(
    background.isTransientTabContextError(
      new Error("Frame with ID 0 was removed."),
    ),
    true,
  );
  assert.equal(
    background.isTransientTabContextError(
      new Error("No tab with id: 1079106118"),
    ),
    true,
  );
  assert.equal(
    background.isTransientTabContextError(new Error("Tab was closed")),
    false,
  );
  let injectionCount = 0;
  await assert.rejects(
    background.sendMessageToContentWithRecovery(
      17,
      { action: "getVideoInfo" },
      {
        async sendMessage() {
          throw new Error("Tab was closed");
        },
        async executeScript() {
          injectionCount += 1;
        },
      },
    ),
    /Tab was closed/,
  );
  assert.equal(injectionCount, 0);
});

test("semantic segmentation rebuilds sentences across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "The next thought also" },
      { start: 7, text: "stays together!" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(
    segments[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].text, "The next thought also stays together!");
  assert.equal(segments[1].start, 5);
});

test("a huge raw Supadata entry is split into seekable bounded segments", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);
  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.text.length <= 384));
  assert.equal(segments[0].start, 12);
  assert.ok(segments.at(-1).start > segments[0].start);
  assert.ok(segments.every((segment) => /^segment-\d+-\d+$/.test(segment.id)));
});

test("Chinese sentence and clause punctuation creates semantic guardrails", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "这是一个被字幕切开的" },
      { start: 2, text: "完整句子。这是第二个想法，" },
      { start: 5, text: "也应该保持语义完整！" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "这是一个被字幕切开的完整句子。");
  assert.equal(segments[1].text, "这是第二个想法，也应该保持语义完整！");
});

test("unpunctuated CJK captions split into short seekable rows without inventing text", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const first = "甲".repeat(96);
  const second = "乙".repeat(96);
  const segments = groupTranscriptEntries([
    { start: 0, duration: 29, text: first, language: "zh-CN" },
    { start: 29, duration: 29, text: second, language: "zh-CN" },
  ]);

  assert.ok(segments.length >= 6);
  assert.ok(segments.every((segment) => segment.text.length <= 72));
  assert.ok(
    segments.every(
      (segment) => !(segment.text.includes("甲") && segment.text.includes("乙")),
    ),
    "a later caption must be flushed before it crosses the time boundary",
  );
  assert.equal(segments.map((segment) => segment.text).join(""), first + second);
  assert.ok(
    segments.every(
      (segment, index) => index === 0 || segment.start > segments[index - 1].start,
    ),
  );
  assert.doesNotMatch(segments.map((segment) => segment.text).join(""), /[。！？]/);
});

test("a short long-duration CJK caption remains one readable row", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = "短字幕没有标点";
  const segments = groupTranscriptEntries([
    { start: 5, duration: 60, text, language: "zh-CN" },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, text);
  assert.equal(segments[0].start, 5);
});

test("transcript translation cache keys include v2 segmentation and source text", () => {
  const { transcriptTranslationCacheKey } = loadSidepanelHelpers();
  const first = transcriptTranslationCacheKey("video-1", {
    id: "segment-0-0",
    text: "第一段原文",
  });
  const second = transcriptTranslationCacheKey("video-1", {
    id: "segment-0-0",
    text: "第二段原文",
  });
  assert.match(first, /^video-1:zh:semantic:v2:segment-0-0:/);
  assert.notEqual(first, second);
});

test("structured translation batches align by stable ID and expose missing fallback", () => {
  const sidepanel = loadSidepanelHelpers();
  const background = loadBackgroundHelpers();
  const source = [
    { id: "segment-0-0", text: "A complete first sentence." },
    { id: "segment-1-5000", text: "A complete second sentence." },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.validateTranscriptBatchRequest({ segments: source }))),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "unknown", text: "\u5ffd\u7565" },
        { id: "segment-1-5000", text: "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002" },
      ],
    },
    source,
  );
  const aligned = sidepanel.alignTranslatedSegmentBatch(
    source,
    normalized.segments,
  );
  assert.equal(aligned[0].id, source[0].id);
  assert.equal(aligned[0].text, "");
  assert.match(aligned[0].error, /暂时无法获得翻译/);
  assert.equal(aligned[1].text, "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002");
});

test("translated-only omits English while bilingual renders aligned English and Chinese", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const segment = { id: "segment-0-0", text: "Original English sentence." };
  const translatedOnly = renderTranscriptSegmentContent(
    segment,
    "zh",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  const bilingual = renderTranscriptSegmentContent(
    segment,
    "bilingual",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  assert.doesNotMatch(translatedOnly, /Original English sentence/);
  assert.match(translatedOnly, /\u4e2d\u6587\u8bd1\u6587/);
  assert.match(bilingual, /transcript-original/);
  assert.match(bilingual, /Original English sentence/);
  assert.match(bilingual, /\u4e2d\u6587\u8bd1\u6587/);
});

test("subtitle formatting tags render in original and translated segment text", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const html = renderTranscriptSegmentContent(
    {
      id: "segment-0-0",
      text: "Think <i>deeply</i>, <b>carefully</b>, and <u>clearly</u>.<br>Next line.",
    },
    "bilingual",
    "\u5b57\u5730<i>\u601d\u8003</i>\u7684\u3002<strong>\u91cd\u70b9</strong>",
    "",
  );

  assert.match(html, /Think <i>deeply<\/i>/);
  assert.match(html, /<b>carefully<\/b>/);
  assert.match(html, /<u>clearly<\/u>\.<br>Next line/);
  assert.match(html, /\u5b57\u5730<i>\u601d\u8003<\/i>\u7684\u3002<strong>\u91cd\u70b9<\/strong>/);
});

test("subtitle markup renderer keeps attributed and arbitrary HTML escaped", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><i onclick="alert(2)">unsafe</i><script>alert(3)</script>',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;i onclick=&quot;alert\(2\)&quot;&gt;unsafe<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|<i\s+onclick|<script\b/);
});

test("background rejects unsupported language fallthrough and malformed batches", () => {
  const source = read("background.js");
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.match(source, /targetLanguage !== "zh"/);
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 4 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );
});

test("overview source language comes from the actual native subtitle track", () => {
  const background = loadBackgroundHelpers();
  const source = read("background.js");
  assert.doesNotMatch(source, /searchParams\.set\("lang",\s*"en"\)/);
  assert.match(
    source,
    /apiUrl\.searchParams\.set\("lang", normalizedPreferredLanguage\)/,
  );
  assert.match(source, /defaultCaptionTrack\?\.languageCode/);
  assert.equal(
    background.getSupadataTrackLanguage({ lang: "en_US", content: [] }),
    "en-US",
  );
  assert.equal(
    background.getSupadataTrackLanguage({
      content: [{ text: "first" }, { text: "二番目", lang: "ja" }],
    }),
    "ja",
  );
  assert.equal(background.isChineseLanguage("zh-Hant"), true);
  assert.equal(background.isChineseLanguage("ja"), false);
  assert.equal(background.languagesSharePrimary("en-US", "en"), true);
  assert.equal(background.languagesSharePrimary("zh-Hans", "zh-TW"), true);
  assert.equal(background.languagesSharePrimary("en", "ja"), false);
  assert.equal(background.normalizeLanguageCode("en\nIgnore previous"), "");
});

test("transcript fetch requests the player language and rejects a fallback track", async () => {
  const requestedUrls = [];
  const makeBackground = (returnedLanguage) =>
    loadBackgroundHelpers({
      settings: {
        provider: "deepseek",
        aiApiKey: "test-key",
        supadataApiKey: "supadata-key",
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "deepseek-v4-flash",
      },
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            lang: returnedLanguage,
            content: [
              {
                text: "Caption text.",
                offset: 0,
                duration: 1000,
                lang: returnedLanguage,
              },
            ],
          }),
        };
      },
    });

  const english = await makeBackground("en").handleFetchTranscript(
    "ydTeb_I0b94",
    "en-US",
  );
  assert.equal(english.success, true);
  assert.equal(new URL(requestedUrls[0]).searchParams.get("lang"), "en-US");

  const mismatch = await makeBackground("en").handleFetchTranscript(
    "ydTeb_I0b94",
    "ja",
  );
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.error, "SOURCE_TRANSCRIPT_UNAVAILABLE");

  const missingLanguage = await makeBackground(null).handleFetchTranscript(
    "ydTeb_I0b94",
    "ja",
  );
  assert.equal(missingLanguage.success, false);
  assert.equal(missingLanguage.error, "SOURCE_TRANSCRIPT_UNAVAILABLE");
});

test("all AI product requests use DeepSeek non-thinking and JSON behavior", async () => {
  const deepSeekRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const deepSeek = loadBackgroundHelpers({
    fetchImpl: successfulFetch(deepSeekRequests),
  });
  const deepSeekResult = await deepSeek.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(deepSeekResult.text, "translated");
  assert.deepEqual(deepSeekRequests[0].thinking, { type: "disabled" });
  assert.deepEqual(deepSeekRequests[0].response_format, {
    type: "json_object",
  });

  const backgroundSource = read("background.js");
  assert.equal(
    (backgroundSource.match(/await requestAiCompletion\(\{/g) || []).length,
    4,
  );
  assert.doesNotMatch(backgroundSource, /disableThinking/);
  for (const callPath of [
    "handleAnalyzeTranscript",
    "cleanupNoteText",
    "handleExplainSelection",
    "callAiTranslation",
  ]) {
    assert.match(
      backgroundSource,
      new RegExp(`async function ${callPath}\\([\\s\\S]*?requestAiCompletion\\(\\{`),
    );
  }
});

test("non-stop provider finish reasons are rejected even when content looks valid", async () => {
  let finishReason = "length";
  const background = loadBackgroundHelpers({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: finishReason,
            message: { content: '{"notes":[{"id":"note_1","textZh":"中文"}]}' },
          },
        ],
      }),
    }),
  });
  const expectedCodes = {
    length: "OUTPUT_TRUNCATED",
    content_filter: "CONTENT_FILTERED",
    insufficient_system_resource: "PROVIDER_UNAVAILABLE",
    tool_calls: "UNEXPECTED_FINISH_REASON",
  };

  for (const [reason, code] of Object.entries(expectedCodes)) {
    finishReason = reason;
    await assert.rejects(
      background.requestAiCompletion({
        maxTokens: 128,
        messages: [{ role: "user", content: "Translate" }],
      }),
      (error) => {
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

test("blank-line chunks reset provider idle timeout and valid JSON succeeds", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async () =>
      streamingResponse([
        encode("\n"),
        encode("\n"),
        encode('{"choices":[{"message":{"content":"translated"}}]}'),
      ]),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "translated");
  assert.equal(timers.createdCount(50_000), 5);
  assert.equal(timers.activeCount(50_000), 0);
  assert.equal(timers.activeCount(120_000), 0);
});

test("provider idle silence aborts with a distinct Retry-able error", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }),
      },
    }),
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  timers.fireActive(50_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_IDLE_TIMEOUT");
  assert.match(result.error, /连续 50 秒没有响应.*重试/);
  assert.equal(timers.activeCount(120_000), 0);
});

test("blank-line keepalives cannot evade the provider hard cap", async () => {
  const timers = createFakeTimers();
  let releaseRead;
  let signal;
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                releaseRead = () => resolve({ done: false, value: encode("\n") });
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                }, { once: true });
              }),
          }),
        },
      };
    },
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  releaseRead();
  await nextTurn();
  releaseRead();
  await nextTurn();
  assert.equal(timers.activeCount(50_000), 1);
  timers.fireActive(120_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_HARD_TIMEOUT");
  assert.match(result.error, /超过 120 秒.*重试/);
  assert.equal(timers.activeCount(50_000), 0);
});

test("provider response reader accepts leading whitespace before JSON", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([
        encode('  \n\t{"choices":[{"message":{"content":"ok"}}]}'),
      ]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
});

test("provider response reader rejects bodies over 2 MiB", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([new Uint8Array(2 * 1024 * 1024 + 1)]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
  assert.match(result.error, /2 MiB limit/);
});

test("DeepSeek retries one empty transcript JSON response without response_format", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: requests.length === 1
                ? ""
                : '{"segments":[{"id":"segment-0-0","text":"\u4e2d\u6587\u8bd1\u6587\u3002"}]}',
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  assert.equal(requests[0].max_tokens, 1536);
});

test("translation message watchdog rejects, clears its timer, and ignores late replies", async () => {
  let timeoutCallback;
  let timeoutDelay;
  let resolveMessage;
  let clearCount = 0;
  const helpers = loadSidepanelHelpers({
    sendMessage: () =>
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    setTimeoutImpl(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 73;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 73);
      clearCount += 1;
    },
  });

  const request = helpers.sendTranslationMessage({
    action: "translateContent",
  });
  assert.equal(timeoutDelay, 130_000);
  timeoutCallback();
  await assert.rejects(request, (error) => {
    assert.equal(error.code, "TRANSLATION_MESSAGE_TIMEOUT");
    assert.match(error.message, /130 秒后超时.*重试/);
    return true;
  });
  assert.equal(clearCount, 1);

  resolveMessage({ success: true });
  await Promise.resolve();
  assert.equal(clearCount, 1);

  let successTimeoutCallback;
  let successClearCount = 0;
  const successfulHelpers = loadSidepanelHelpers({
    sendMessage: () => Promise.resolve({ success: true }),
    setTimeoutImpl(callback) {
      successTimeoutCallback = callback;
      return 91;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 91);
      successClearCount += 1;
    },
  });
  assert.deepEqual(
    await successfulHelpers.sendTranslationMessage({
      action: "translateContent",
    }),
    { success: true },
  );
  assert.equal(successClearCount, 1);
  successTimeoutCallback();
  assert.equal(successClearCount, 1);
});

test("Chinese prompt preserves natural bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(prompt, /spaces between Chinese and adjacent English words or digits/);
  assert.match(prompt, /source-language `text`/);
});

test("overview starts from Chinese and keeps original-language translation lazy", () => {
  const analysisPrompt = read("prompts/analysis.md");
  const translationPrompt = read("prompts/translation.md");
  assert.match(analysisPrompt, /Simplified Chinese structural overview/);
  assert.match(analysisPrompt, /titleZh/);
  assert.match(analysisPrompt, /summaryZh/);
  assert.match(analysisPrompt, /quoteOriginal/);
  assert.match(analysisPrompt, /quoteZh/);
  assert.match(translationPrompt, /^## Overview original translation$/m);
  assert.match(translationPrompt, /"titleOriginal"/);
  assert.match(translationPrompt, /"summaryOriginal"/);
  assert.doesNotMatch(
    translationPrompt.match(/## Overview original translation[\s\S]*?(?=\n## |$)/)?.[0] || "",
    /quoteOriginal|quoteZh/,
  );
  assert.match(translationPrompt, /^## Notes translation$/m);
  assert.match(translationPrompt, /Translate these polished English video notes/);
  assert.match(translationPrompt, /"textZh":"中文笔记"/);
  assert.match(translationPrompt, /"unchanged":true/);
  assert.match(translationPrompt, /"unchangedKind":"technical"/);
  assert.match(translationPrompt, /"unchangedKind":"proper_noun"/);
});

test("saving a note from a Chinese caption skips AI cleanup and keeps the original text", async () => {
  const videoId = "vid_zh";
  const settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  };
  const makeDigest = (language) => ({
    transcriptSourcePolicyVersion: 3,
    transcript: [
      { start: 0, text: "开场白。", language },
      { start: 10, text: "第二句中文字幕内容。", language },
      { start: 20, text: "结束语。", language },
    ],
  });

  const runSave = async (language) => {
    const digest = makeDigest(language);
    let savedNote = null;
    let cleanupCalls = 0;
    const background = loadBackgroundHelpers({
      storageGetImpl: async (key) => {
        if (key === "ytd_settings") return { ytd_settings: settings };
        if (key === `digest_${videoId}`) {
          return { [`digest_${videoId}`]: digest };
        }
        if (key === "ytd_notes") return { ytd_notes: [] };
        return {};
      },
      storageSetImpl: async (items) => {
        if (items.ytd_notes) savedNote = items.ytd_notes[0];
      },
      fetchImpl: async (url) => {
        if (url.startsWith("chrome-extension://")) {
          return { ok: true, text: async () => read("prompts/note-cleanup.md") };
        }
        // Only the DeepSeek cleanup endpoint reaches here.
        cleanupCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: { content: JSON.stringify({ quote: "Cleaned English." }) },
              },
            ],
          }),
        };
      },
    });
    const result = await background.handleSaveNote(videoId, 10, "视频", "频道");
    return { result, savedNote, cleanupCalls };
  };

  // Confirmed Chinese caption lines are shown from rawText, so the English
  // cleanup call is pure waste and must be skipped for both simplified and
  // traditional tags. The stored note.text stays the original caption text.
  for (const language of ["zh-CN", "zh-Hans", "zh-SG", "zh-Hant", "zh-TW"]) {
    const { result, savedNote, cleanupCalls } = await runSave(language);
    assert.equal(result.success, true, `${language} save should succeed`);
    assert.equal(cleanupCalls, 0, `${language} must not call DeepSeek cleanup`);
    assert.equal(savedNote.text, "第二句中文字幕内容。");
    assert.equal(savedNote.rawText, "第二句中文字幕内容。");
    assert.equal(savedNote.sourceLanguage, language);
  }

  // The skip is decided by the language tag, never by "contains Han chars":
  // an explicit Japanese line and a missing language keep the cleanup path so
  // Japanese kanji is never misread as Chinese.
  for (const language of ["en", "ja", ""]) {
    const { result, savedNote, cleanupCalls } = await runSave(language);
    assert.equal(result.success, true, `"${language}" save should succeed`);
    assert.equal(cleanupCalls, 1, `"${language}" must run the DeepSeek cleanup once`);
    assert.equal(savedNote.text, "Cleaned English.");
    assert.equal(savedNote.rawText, "第二句中文字幕内容。");
    assert.equal(savedNote.sourceLanguage, language);
  }
});

test("isConfirmedSimplifiedChineseSource matches only explicit Simplified tags", () => {
  const { isConfirmedSimplifiedChineseSource: isSimplified } =
    loadSidepanelHelpers();
  for (const yes of [
    "zh-Hans",
    "zh-CN",
    "zh-SG",
    "zh-hans",
    "zh-Hans-CN",
    "zh-Hans-TW",
  ]) {
    assert.equal(isSimplified(yes), true, `${yes} should be confirmed Simplified`);
  }
  for (const no of [
    "zh",
    "zh-Hant",
    "zh-Hant-CN",
    "zh-Hant-SG",
    "zh-TW",
    "zh-HK",
    "zh-MO",
    "yue",
    "en",
    "ja",
    "",
    null,
  ]) {
    assert.equal(
      isSimplified(no),
      false,
      `${no} must not be confirmed Simplified`,
    );
  }
});

test("a confirmed Simplified-Chinese transcript never requests translation and stays on original", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      let translateContentRequests = 0;
      let renders = 0;
      const modeButtonCalls = [];
      chrome.runtime.sendMessage = (message) => {
        if (message.action === "translateContent") translateContentRequests += 1;
        return Promise.resolve({
          success: true,
          translatedContent: { segments: [] },
        });
      };
      renderTranscript = () => { renders += 1; };
      setTranscriptModeButtons = (mode) => { modeButtonCalls.push(mode); };
      currentVideoId = "vid_zh";
      currentTranscript = [
        { start: 0, text: "第一段简体中文字幕。" },
        { start: 8, text: "第二段简体中文字幕内容。" },
      ];
      currentTranscriptLanguage = "zh-Hans";
      currentTranscriptMode = "original";
      return {
        changeMode: (mode) => handleTranscriptModeChange(mode),
        forceTranslate: (mode) => {
          currentTranscriptMode = mode;
          return translateTranscript();
        },
        snapshot: () => JSON.stringify({
          translateContentRequests,
          renders,
          modeButtonCalls,
          mode: currentTranscriptMode,
        }),
      };
    })()
  `);

  // The control layer refuses to switch into zh / bilingual.
  await fixture.changeMode("bilingual");
  await fixture.changeMode("zh");
  let snap = JSON.parse(fixture.snapshot());
  assert.equal(snap.translateContentRequests, 0);
  assert.equal(snap.mode, "original", "mode must stay original for a Simplified source");

  // The fail-safe inside translateTranscript also protects the load-time path
  // (e.g. arriving from an English video still stuck in bilingual mode): it
  // collapses back to original with no request and no pending/duplicate row.
  await fixture.forceTranslate("bilingual");
  snap = JSON.parse(fixture.snapshot());
  assert.equal(snap.translateContentRequests, 0);
  assert.equal(snap.mode, "original", "the fail-safe must reset the mode to original");
  assert.deepEqual(snap.modeButtonCalls, ["original"]);
  assert.ok(snap.renders >= 1, "the fail-safe re-renders the plain transcript");
});

test("Traditional and non-Chinese transcripts still enter the translation path", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      let translateCalls = 0;
      translateTranscript = () => { translateCalls += 1; return Promise.resolve(); };
      setTranscriptModeButtons = () => {};
      currentTranscript = [{ start: 0, text: "sample" }];
      currentTranscriptMode = "original";
      return {
        setLanguage: (language) => {
          currentTranscriptLanguage = language;
          currentTranscriptMode = "original";
          translateCalls = 0;
        },
        changeMode: (mode) => handleTranscriptModeChange(mode),
        snapshot: () => JSON.stringify({ translateCalls, mode: currentTranscriptMode }),
      };
    })()
  `);

  // Traditional Chinese must keep working — it still needs conversion to zh.
  fixture.setLanguage("zh-Hant");
  await fixture.changeMode("zh");
  assert.deepEqual(JSON.parse(fixture.snapshot()), { translateCalls: 1, mode: "zh" });

  // English is unaffected: bilingual mode still translates.
  fixture.setLanguage("en");
  await fixture.changeMode("bilingual");
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    translateCalls: 1,
    mode: "bilingual",
  });

  // A bare, ambiguous `zh` is not confirmed Simplified, so it still translates.
  fixture.setLanguage("zh");
  await fixture.changeMode("zh");
  assert.deepEqual(JSON.parse(fixture.snapshot()), { translateCalls: 1, mode: "zh" });
});

test("Simplified-Chinese videos disable the Chinese and bilingual transcript buttons", () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      const makeButton = (mode) => ({
        dataset: { transcriptMode: mode },
        disabled: false,
        attrs: {},
        setAttribute(name, value) { this.attrs[name] = value; },
        removeAttribute(name) { delete this.attrs[name]; },
      });
      const buttons = [
        makeButton("original"),
        makeButton("zh"),
        makeButton("bilingual"),
      ];
      document.querySelectorAll = (selector) =>
        selector === ".transcript-mode-btn" ? buttons : [];
      return {
        apply: (language) => {
          currentTranscriptLanguage = language;
          updateTranscriptModeAvailability();
        },
        snapshot: () => JSON.stringify(buttons.map((button) => ({
          mode: button.dataset.transcriptMode,
          disabled: button.disabled,
          ariaDisabled: button.attrs["aria-disabled"] || null,
          title: button.attrs["title"] || null,
        }))),
      };
    })()
  `);

  fixture.apply("zh-CN");
  assert.deepEqual(JSON.parse(fixture.snapshot()), [
    { mode: "original", disabled: false, ariaDisabled: null, title: null },
    {
      mode: "zh",
      disabled: true,
      ariaDisabled: "true",
      title: "字幕已是简体中文，无需翻译。",
    },
    {
      mode: "bilingual",
      disabled: true,
      ariaDisabled: "true",
      title: "字幕已是简体中文，无需翻译。",
    },
  ]);

  // Switching to an English (or Traditional) video re-enables every button.
  fixture.apply("en");
  assert.deepEqual(JSON.parse(fixture.snapshot()), [
    { mode: "original", disabled: false, ariaDisabled: null, title: null },
    { mode: "zh", disabled: false, ariaDisabled: null, title: null },
    { mode: "bilingual", disabled: false, ariaDisabled: null, title: null },
  ]);
});
