const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelRuntime({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
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
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read("sidepanel.js"), context);
  return {
    helpers: sandbox.__YTD_TRANSCRIPT_TESTING__,
    sandbox,
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
} = {}) {
  const listeners = { addListener() {} };
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
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
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
            classList: { toggle() {}, contains() { return false; } },
            setAttribute() {},
            addEventListener() {},
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
        timestamp: Date.now(),
      });

      return {
        start: (videoId) => startDigest(videoId, "url-" + videoId),
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
        events: () => JSON.stringify(events),
        saved: () => JSON.stringify(saved),
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
  assert.match(js, /const REQUIRED_RUNTIME_PROTOCOL_VERSION = 4/);
  assert.match(
    js,
    /runtimeProtocolVersion !== REQUIRED_RUNTIME_PROTOCOL_VERSION[\s\S]*?showRuntimeVersionError\(\)/,
  );
  assert.match(js, /扩展后台未响应原文翻译请求，请重新加载扩展/);
  const backgroundSource = read("background.js");
  assert.match(backgroundSource, /const RUNTIME_PROTOCOL_VERSION = 4/);
  assert.match(
    backgroundSource,
    /runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION/,
  );
  assert.match(js, /contentType: "transcriptBatch"/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.match(js, /原文（\$\{language\}）/);
  assert.match(js, /await startDigest\(videoId, latestUrl\)/);
  assert.match(js, /const requestKey = `\$\{generation\}:\$\{videoId\}`/);
  assert.match(js, /runDigestSingleFlight\(requestKey/);
  assert.match(js, /const generation = \+\+tabCheckGeneration/);
  assert.match(js, /extractVideoId\(latestUrl\) !== videoId/);
  assert.match(js, /cached\.analysisVideoId === videoId/);
  assert.match(js, /videoId !== currentVideoId \|\| !currentTranscript/);
  assert.match(js, /preferredLanguage: currentVideoSourceLanguage/);
  assert.match(js, /const TRANSCRIPT_SOURCE_POLICY_VERSION = 2/);
  assert.match(
    js,
    /cached\.transcriptSourcePolicyVersion !== TRANSCRIPT_SOURCE_POLICY_VERSION/,
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

test("a newer active-tab check is not swallowed by an older pending check", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
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
  assert.equal(helpers.hasCompleteOriginalAnalysis(chineseBaseAnalysis), true);

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

test("notes generate Chinese once from polished English and persist it", async () => {
  const backgroundSource = read("background.js");
  assert.match(
    backgroundSource,
    /async function handleSaveNote\([\s\S]*?cleanupNoteText\([\s\S]*?saveNoteToStorage\(note\)[\s\S]*?handleTranslateNotes\(\[note\]\)/,
  );
  assert.match(
    backgroundSource,
    /sourceLanguage:[\s\S]*?matchedLine\.language/,
  );
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

test("Chinese source notes reuse their raw subtitle without an API call", async () => {
  let storedNotes = [
    {
      id: "note_zh",
      text: "Polished fallback text.",
      rawText: "这条原字幕已经是中文。",
      sourceLanguage: "zh-CN",
      videoTitle: "示例视频",
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
  assert.equal(storedNotes[0].translatedText, "这条原字幕已经是中文。");
  assert.equal(background.noteHasChineseSource(storedNotes[0]), true);
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

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.deepEqual(result.missingIds, ["note_2"]);
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

test("relay recovery reinjects the content script once after extension reload", async () => {
  const background = loadBackgroundHelpers();
  const sendCalls = [];
  const injectionCalls = [];
  const result = await background.sendMessageToContentWithRecovery(
    17,
    { action: "getVideoInfo" },
    {
      async sendMessage(tabId, message) {
        sendCalls.push({ tabId, message });
        if (sendCalls.length === 1) {
          throw new Error(
            "Could not establish connection. Receiving end does not exist.",
          );
        }
        return { title: "Recovered video" };
      },
      async executeScript(details) {
        injectionCalls.push(details);
      },
    },
  );

  assert.deepEqual(result, { title: "Recovered video" });
  assert.equal(sendCalls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(injectionCalls)), [
    { target: { tabId: 17 }, files: ["content.js"] },
  ]);
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
  await assert.rejects(request, /130 秒后超时.*重试/);
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
});
