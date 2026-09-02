const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const bilibiliAdapter = require("../bilibili.js");

function createMemoryStorageArea(initial = {}) {
  const values = JSON.parse(JSON.stringify(initial));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return clone(values);
      if (typeof keys === "object" && !Array.isArray(keys)) {
        const result = clone(keys);
        for (const key of Object.keys(keys)) {
          if (Object.hasOwn(values, key)) result[key] = clone(values[key]);
        }
        return result;
      }
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, clone(values[key])]),
      );
    },
    async set(next) {
      Object.assign(values, clone(next));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async clear() {
      for (const key of Object.keys(values)) delete values[key];
    },
    snapshot() {
      return clone(values);
    },
  };
}

function loadSidepanelRuntime({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  storageLocal = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
    clear: async () => {},
  },
  storageSession = createMemoryStorageArea(),
  documentImpl,
  noteSourcesImpl = require("../note-sources.js"),
  exportJobsImpl = require("../export-jobs.js"),
} = {}) {
  const runtimeMessageListeners = [];
  const listeners = {
    addListener(listener) {
      runtimeMessageListeners.push(listener);
    },
  };
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
    document: documentImpl || {
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
      storage: { local: storageLocal, session: storageSession },
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
    YTD_NOTE_EXPORT: require("../note-export.js"),
    YTD_NOTE_SOURCES: noteSourcesImpl,
    YTD_EXPORT_JOBS: exportJobsImpl,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read("sidepanel.js"), context);
  vm.runInContext(
    'currentConfigStatus = { hasAiKey: true, provider: { displayName: "DeepSeek" } };',
    context,
  );
  return {
    helpers: sandbox.__YTD_TRANSCRIPT_TESTING__,
    sandbox,
    runtimeMessageListeners,
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
  storageRemoveImpl = async () => {},
  storageClearImpl = async () => {},
  tabsImpl = {},
  scriptingImpl = { executeScript: async () => [] },
  pageDocumentImpl = {},
  pageWindowImpl = {},
  bilibiliAdapterImpl = bilibiliAdapter,
  noteSourcesImpl = require("../note-sources.js"),
  exportJobsImpl = require("../export-jobs.js"),
  runtimeSendMessageImpl = () => Promise.resolve({ success: true }),
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
    document: pageDocumentImpl,
    window: pageWindowImpl,
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
          remove: storageRemoveImpl,
          clear: storageClearImpl,
        },
      },
      action: { onClicked: listeners },
      scripting: scriptingImpl,
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
        sendMessage: runtimeSendMessageImpl,
      },
      tabs: { onUpdated: listeners, onActivated: listeners, ...tabsImpl },
    },
    // Load the real, published logic modules the service worker derives its
    // provider config from, instead of a hand-written stub. background.js calls
    // YTD_SETTINGS.hasActiveApiKey()/apiKeyFor()/normalize() and
    // YTD_AI_PROVIDERS.resolveProviderId()/getProvider()/describeProvider(), so
    // the harness must honor the same contract the extension ships. All three
    // are pure logic (no network, chrome.*, or DOM) and safe to require here.
    YTD_AI_PROVIDERS: require("../ai-providers.js"),
    YTD_SETTINGS: require("../settings.js"),
    YTD_NOTES_BACKUP: require("../notes-backup.js"),
    YTD_NOTE_SOURCES: noteSourcesImpl,
    YTD_EXPORT_JOBS: exportJobsImpl,
    BILIBILI_ADAPTER: bilibiliAdapterImpl,
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

function createAsyncGate() {
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  return {
    entered,
    enter() {
      enteredResolve();
      return blocked;
    },
    release() {
      releaseResolve();
    },
  };
}

test("export precheck names every translation gap and forbids original-text substitution", () => {
  const helpers = loadSidepanelHelpers();
  const summary = helpers.describeExportPrecheck({
    videoCount: 2,
    noteCount: 3,
    hasBlocking: false,
    blockingVideos: [],
    hasTranslationGaps: true,
    translationGaps: {
      titles: 1,
      descriptions: 1,
      transcriptSegments: 4,
      notes: 2,
    },
  });
  assert.match(summary, /1 个标题/);
  assert.match(summary, /1 个简介/);
  assert.match(summary, /4 段字幕/);
  assert.match(summary, /2 条笔记/);
  assert.match(summary, /不会用原文冒充中文导出/);
  assert.doesNotMatch(summary, /缺失部分将以原文呈现/);
});

test("one confirmed export round starts at most 20 batches and never auto-downloads", async () => {
  const controller = createSidepanelJobController();
  const documentImpl = createInteractiveDocument();
  const fixture = makeNoteRoundFixture(21);
  const runtime = loadSidepanelRuntime({
    sendMessage: controller.sendMessage,
    documentImpl,
    exportJobsImpl: createExportJobsBridge(),
  });
  let downloadCount = 0;
  runtime.sandbox.__downloadProbe = () => {
    downloadCount += 1;
  };
  runtime.evaluate("downloadTextFile = () => globalThis.__downloadProbe() ");

  const outcome = await runtime.helpers.runConfirmedExportTranslation({
    plan: fixture.plan,
    sourcesByKey: {},
    groups: fixture.groups,
    scope: "notes-current",
    mode: "bilingual",
    format: "txt",
    panelId: "notesExportPrecheck",
    setStatus() {},
  });

  assert.equal(outcome.complete, false);
  assert.equal(outcome.remainingCount, 1);
  assert.equal(
    controller.actions.filter(
      (action) => action === "translateExportNotesBatch",
    ).length,
    20,
  );
  assert.equal(controller.translatedNoteIds.length, 20);
  assert.equal(controller.translatedNoteIds.includes("round-note-21"), false);
  assert.equal(controller.job().state, "paused");
  assert.equal(downloadCount, 0, "an incomplete round never creates a file");

  runtime.helpers.showNoteExportPrecheck(
    {
      videoCount: 1,
      noteCount: 21,
      hasBlocking: false,
      blockingVideos: [],
      hasTranslationGaps: true,
      translationGaps: {
        titles: 0,
        descriptionChunks: 0,
        transcriptSegments: 0,
        notes: 1,
      },
    },
    () => {},
    () => {},
    {
      overLimit: false,
      estimatedBatches: 1,
      progress: {
        totalUnits: 21,
        completedUnits: 20,
        remainingUnits: 1,
        remainingBatches: 1,
        roundMaxBatches: 20,
      },
    },
  );
  assert.equal(documentImpl.element("notesExportPrecheck").hidden, false);
  assert.ok(
    documentImpl.findButton(
      "notesExportPrecheck",
      "继续完整导出",
    ),
    "durable progress is re-presented as an actionable continuation",
  );
});

test("a completed notes batch claims, downloads once, and finishes the durable job", async () => {
  const controller = createSidepanelJobController();
  const documentImpl = createInteractiveDocument();
  const fixture = makeNoteRoundFixture(1);
  const runtime = loadSidepanelRuntime({
    sendMessage: controller.sendMessage,
    documentImpl,
    exportJobsImpl: createExportJobsBridge(),
  });
  const outcome = await runtime.helpers.runConfirmedExportTranslation({
    plan: fixture.plan,
    sourcesByKey: {},
    groups: fixture.groups,
    scope: "notes-current",
    mode: "bilingual",
    format: "txt",
    panelId: "notesExportPrecheck",
    setStatus() {},
  });
  assert.equal(outcome.complete, true);
  assert.equal(controller.job().state, "paused");
  let downloads = 0;
  await runtime.helpers.finalizeExportJobDownload(outcome, () => {
    downloads += 1;
  });
  assert.equal(downloads, 1);
  assert.equal(controller.job().state, "completed");
  assert.equal(controller.job().exportClaim, null);
});

test("notes precheck exposes one complete action and one direct fallback", () => {
  const documentImpl = createInteractiveDocument();
  const actions = [];
  const runtime = loadSidepanelRuntime({
    documentImpl,
    sendMessage(message) {
      actions.push(message.action);
      return Promise.resolve({});
    },
  });
  let generated = 0;
  let exportedDirect = 0;
  runtime.helpers.showNoteExportPrecheck(
    {
      videoCount: 1,
      noteCount: 1,
      hasBlocking: false,
      blockingVideos: [],
      hasTranslationGaps: true,
      translationGaps: {
        titles: 0,
        descriptionChunks: 0,
        transcriptSegments: 0,
        notes: 1,
      },
    },
    () => {
      exportedDirect += 1;
    },
    () => {
      generated += 1;
    },
    {
      overLimit: false,
      estimatedBatches: 1,
      progress: {
        totalUnits: 1,
        completedUnits: 0,
        remainingUnits: 1,
        remainingBatches: 1,
        roundMaxBatches: 20,
      },
    },
    null,
  );
  const complete = documentImpl.findButton(
    "notesExportPrecheck",
    "完整导出",
  );
  const direct = documentImpl.findButton(
    "notesExportPrecheck",
    "直接导出",
  );
  const cancel = documentImpl.findButton(
    "notesExportPrecheck",
    "取消",
  );
  assert.ok(complete);
  assert.ok(direct);
  assert.ok(cancel);
  assert.equal(documentImpl.findButton("notesExportPrecheck", "导出原文"), null);
  assert.equal(documentImpl.findButton("notesExportPrecheck", "补充导出"), null);
  complete.click();
  assert.equal(generated, 1);
  direct.click();
  assert.equal(exportedDirect, 1);
  assert.deepEqual(actions, []);
});

test("metadata workspace exposes one next-video action and a direct fallback", async () => {
  const documentImpl = createInteractiveDocument();
  const messages = [];
  const runtime = loadSidepanelRuntime({
    documentImpl,
    sendMessage(message) {
      messages.push(message);
      return Promise.resolve({ success: true });
    },
  });
  let directExports = 0;
  runtime.helpers.showNoteExportMetadataWorkspace(
    {
      hasTranslationGaps: false,
      blockingVideos: [
        {
          mediaKey: "video-a",
          title: "Video A",
          blockingReasons: ["缺少视频简介状态"],
        },
      ],
    },
    [
      {
        mediaKey: "video-a",
        representative: {
          mediaKey: "video-a",
          videoId: "video-a",
          videoTitle: "Video A",
          timestampedUrl: "https://www.youtube.com/watch?v=video-a&t=5s",
        },
        notes: [],
      },
    ],
    { mediaKeys: ["video-a"], mode: "bilingual" },
    {
      autoOpenMetadata: false,
      onDirect() {
        directExports += 1;
      },
    },
  );

  assert.ok(documentImpl.findButton("notesExportPrecheck", "打开并补齐"));
  const direct = documentImpl.findButton("notesExportPrecheck", "直接导出");
  assert.ok(direct);
  assert.ok(documentImpl.findButton("notesExportPrecheck", "取消"));
  assert.equal(
    documentImpl.findButton("notesExportPrecheck", "重新检查并导出"),
    null,
  );
  direct.click();
  assert.equal(directExports, 1);
  assert.deepEqual(messages, [], "rendering the workspace starts no provider");
});

test("metadata workspace shows a single next action for a multi-video queue", async () => {
  const documentImpl = createInteractiveDocument();
  const runtime = loadSidepanelRuntime({ documentImpl });
  runtime.helpers.showNoteExportMetadataWorkspace(
    {
      hasTranslationGaps: false,
      blockingVideos: [
        {
          mediaKey: "video-a",
          title: "Video A",
          blockingReasons: ["缺少视频简介状态"],
        },
        {
          mediaKey: "video-b",
          title: "Video B",
          blockingReasons: ["缺少频道名称"],
        },
      ],
    },
    [
      {
        mediaKey: "video-a",
        representative: {
          mediaKey: "video-a",
          videoId: "video-a",
          videoTitle: "Video A",
          timestampedUrl: "https://www.youtube.com/watch?v=video-a&t=5s",
        },
        notes: [],
      },
      {
        mediaKey: "video-b",
        representative: {
          mediaKey: "video-b",
          videoId: "video-b",
          videoTitle: "Video B",
          timestampedUrl: "https://www.youtube.com/watch?v=video-b&t=5s",
        },
        notes: [],
      },
    ],
    { mediaKeys: ["video-a", "video-b"], mode: "bilingual" },
    { autoOpenMetadata: false },
  );
  assert.ok(documentImpl.findButton(
    "notesExportPrecheck",
    "打开下一个（还剩 2 个）",
  ));
  assert.equal(
    documentImpl.findButton("notesExportPrecheck", "重新检查并导出"),
    null,
  );
});

test("metadata workspace restores its retry action when a video tab cannot open", async () => {
  const documentImpl = createInteractiveDocument();
  const runtime = loadSidepanelRuntime({ documentImpl });
  runtime.sandbox.chrome.tabs.create = async () => {
    throw new Error("tab creation rejected");
  };
  runtime.helpers.showNoteExportMetadataWorkspace(
    {
      hasTranslationGaps: false,
      blockingVideos: [
        {
          mediaKey: "video-open-failure",
          title: "Video open failure",
          blockingReasons: ["缺少视频简介状态"],
        },
      ],
    },
    [
      {
        mediaKey: "video-open-failure",
        representative: {
          mediaKey: "video-open-failure",
          videoId: "video-open-failure",
          videoTitle: "Video open failure",
          timestampedUrl:
            "https://www.youtube.com/watch?v=video-open-failure&t=5s",
        },
        notes: [],
      },
    ],
    { mediaKeys: ["video-open-failure"], mode: "bilingual" },
    { autoOpenMetadata: false },
  );

  const open = documentImpl.findButton(
    "notesExportPrecheck",
    "打开并补齐",
  );
  assert.ok(open);
  open.click();
  await nextTurn();
  await nextTurn();

  assert.equal(open.disabled, false);
  assert.equal(open.textContent, "重试当前视频");
  assert.match(
    documentImpl.element("notesExportStatus").textContent,
    /页面资料尚未就绪/,
  );
});

test("metadata workspace restores its retry action when the new tab cannot activate", async () => {
  const documentImpl = createInteractiveDocument();
  const runtime = loadSidepanelRuntime({ documentImpl });
  const removedTabs = [];
  runtime.sandbox.chrome.tabs.create = async ({ url }) => ({
    id: 88,
    url,
    pendingUrl: url,
  });
  runtime.sandbox.chrome.tabs.update = async () => {
    throw new Error("tab activation rejected");
  };
  runtime.sandbox.chrome.tabs.remove = async (tabId) => {
    removedTabs.push(tabId);
  };
  runtime.helpers.showNoteExportMetadataWorkspace(
    {
      hasTranslationGaps: false,
      blockingVideos: [
        {
          mediaKey: "video-activation-failure",
          title: "Video activation failure",
          blockingReasons: ["缺少视频简介状态"],
        },
      ],
    },
    [
      {
        mediaKey: "video-activation-failure",
        representative: {
          mediaKey: "video-activation-failure",
          videoId: "video-activation-failure",
          videoTitle: "Video activation failure",
          timestampedUrl:
            "https://www.youtube.com/watch?v=video-activation-failure&t=5s",
        },
        notes: [],
      },
    ],
    { mediaKeys: ["video-activation-failure"], mode: "bilingual" },
    { autoOpenMetadata: false },
  );

  const open = documentImpl.findButton(
    "notesExportPrecheck",
    "打开并补齐",
  );
  open.click();
  await nextTurn();
  await nextTurn();

  assert.equal(open.disabled, false);
  assert.equal(open.textContent, "重试当前视频");
  assert.deepEqual(removedTabs, [88]);
});

test("metadata workspace restores its retry action when the current page is not ready", async () => {
  const documentImpl = createInteractiveDocument();
  const mediaKey = "current-page-not-ready";
  const runtime = loadSidepanelRuntime({
    documentImpl,
    async sendMessage(message) {
      if (message.action === "relayToContent") {
        return {
          success: false,
          error: "PAGE_REFRESH_REQUIRED",
          message: "请刷新当前视频页后重试。",
        };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    },
  });
  runtime.sandbox.chrome.tabs.get = async () => ({
    id: 77,
    url: `https://www.youtube.com/watch?v=${mediaKey}`,
  });
  runtime.evaluate(`
    currentVideoId = ${JSON.stringify(mediaKey)};
    currentRouteKey = ${JSON.stringify(`youtube:${mediaKey}`)};
    currentVideoUrl = ${JSON.stringify(
      `https://www.youtube.com/watch?v=${mediaKey}`,
    )};
    currentMediaRef = {
      platform: "youtube",
      mediaKey: ${JSON.stringify(mediaKey)},
      videoId: ${JSON.stringify(mediaKey)},
      routeKey: ${JSON.stringify(`youtube:${mediaKey}`)},
      canonicalUrl: currentVideoUrl,
    };
    currentVideoTitle = "Current page not ready";
    videoTabId = 77;
  `);
  runtime.helpers.showNoteExportMetadataWorkspace(
    {
      hasTranslationGaps: false,
      blockingVideos: [
        {
          mediaKey,
          title: "Current page not ready",
          blockingReasons: ["缺少视频简介状态"],
        },
      ],
    },
    [
      {
        mediaKey,
        representative: {
          mediaKey,
          videoId: mediaKey,
          videoTitle: "Current page not ready",
          timestampedUrl: `https://www.youtube.com/watch?v=${mediaKey}&t=5s`,
        },
        notes: [],
      },
    ],
    { mediaKeys: [mediaKey], mode: "bilingual" },
    { autoOpenMetadata: false },
  );

  const open = documentImpl.findButton(
    "notesExportPrecheck",
    "打开并补齐",
  );
  open.click();
  await nextTurn();
  await nextTurn();

  assert.equal(open.disabled, false);
  assert.equal(open.textContent, "重试当前视频");
  assert.match(
    documentImpl.element("notesExportStatus").textContent,
    /刷新当前视频页后重试/,
  );
});

test("export picker shows ready, metadata, and translation preparation before submit", () => {
  const documentImpl = createInteractiveDocument();
  const runtime = loadSidepanelRuntime({ documentImpl });
  runtime.evaluate(
    'currentConfigStatus = { provider: { displayName: "DeepSeek" } }',
  );
  const groups = [
    {
      mediaKey: "ready-video",
      representative: {
        mediaKey: "ready-video",
        videoTitle: "已就绪",
        channelName: "频道",
        sourceLanguage: "zh-CN",
      },
      notes: [{ id: "r", text: "中文笔记", sourceLanguage: "zh-CN" }],
    },
    {
      mediaKey: "metadata-video",
      representative: {
        mediaKey: "metadata-video",
        videoTitle: "缺资料",
        channelName: "频道",
      },
      notes: [{ id: "m", text: "English note" }],
    },
    {
      mediaKey: "translation-video",
      representative: {
        mediaKey: "translation-video",
        videoTitle: "Needs translation",
        channelName: "Channel",
      },
      notes: [{ id: "t", text: "English note" }],
    },
  ];
  const sourcesByKey = {
    "ready-video": {
      mediaKey: "ready-video",
      platform: "youtube",
      canonicalUrl: "https://www.youtube.com/watch?v=ready-video",
      titleOriginal: "已就绪",
      channelName: "频道",
      descriptionOriginal: "中文简介",
      descriptionStatus: "present",
      sourceLanguage: "zh-CN",
    },
    "translation-video": {
      mediaKey: "translation-video",
      platform: "youtube",
      canonicalUrl: "https://www.youtube.com/watch?v=translation-video",
      titleOriginal: "Needs translation",
      channelName: "Channel",
      descriptionOriginal: "English description",
      descriptionStatus: "present",
      sourceLanguage: "en",
    },
  };

  runtime.helpers.renderNoteExportPicker(
    groups,
    sourcesByKey,
    groups.map((group) => group.mediaKey),
  );

  const list = documentImpl.element("notesExportPickerList");
  const statuses = list.children.map((label) => label.children.at(-1).textContent);
  assert.deepEqual(statuses, ["可导出", "需补资料", "需补译 3 项"]);
  assert.equal(
    documentImpl.element("confirmNotesExportSelection").textContent,
    "完整导出（3）",
  );
  assert.equal(
    documentImpl.element("directNotesExportSelection").textContent,
    "直接导出（3）",
  );
  assert.match(
    documentImpl.element("notesExportPickerDisclosure").textContent,
    /范围：3 个视频；模式：双语.*页面资料：1 个需访问原视频补充.*AI 补译：当前可识别 4 项，服务为DeepSeek.*单轮最多 20 批/,
  );

  runtime.evaluate('currentNotesMode = "original"');
  runtime.helpers.renderNoteExportPicker(
    groups,
    sourcesByKey,
    groups.map((group) => group.mediaKey),
  );
  assert.match(
    documentImpl.element("notesExportPickerDisclosure").textContent,
    /范围：3 个视频；模式：原文.*AI 补译：不使用/,
  );
});

test("export picker event wiring freezes the same sorted selection for complete and direct export", async () => {
  const documentImpl = createInteractiveDocument();
  const runtime = loadSidepanelRuntime({
    documentImpl,
    sendMessage: async () => ({ runtimeProtocolVersion: 0 }),
  });
  runtime.sandbox.__pickerExportCalls = [];
  runtime.evaluate(`
    exportAllNotes = (mediaKeys, options = {}) => {
      globalThis.__pickerExportCalls.push({
        mediaKeys: [...mediaKeys],
        options: { ...options },
      });
      return Promise.resolve();
    };
  `);

  await documentImpl.dispatchEvent({ type: "DOMContentLoaded" });

  const groups = ["video-z", "video-a", "video-m"].map((mediaKey) => ({
    mediaKey,
    representative: {
      mediaKey,
      videoTitle: mediaKey,
      channelName: "Channel",
      sourceLanguage: "en",
    },
    notes: [{ id: `note-${mediaKey}`, text: "Saved note", sourceLanguage: "en" }],
  }));
  const sourcesByKey = Object.fromEntries(
    groups.map(({ mediaKey }) => [
      mediaKey,
      {
        mediaKey,
        platform: "youtube",
        canonicalUrl: `https://www.youtube.com/watch?v=${mediaKey}`,
        titleOriginal: mediaKey,
        channelName: "Channel",
        descriptionOriginal: "Description",
        descriptionStatus: "present",
        sourceLanguage: "en",
      },
    ]),
  );
  runtime.helpers.renderNoteExportPicker(groups, sourcesByKey, []);

  const inputs = documentImpl
    .element("notesExportPickerList")
    .children.map((label) => label.children[0]);
  for (const input of inputs.filter((candidate) =>
    ["video-z", "video-a"].includes(candidate.value),
  )) {
    input.checked = true;
    input.dispatchEvent({ type: "change" });
  }

  const submitEvent = { type: "submit", preventDefaultCalled: false };
  submitEvent.preventDefault = () => {
    submitEvent.preventDefaultCalled = true;
  };
  documentImpl.element("notesExportPicker").dispatchEvent(submitEvent);
  documentImpl.element("directNotesExportSelection").click();

  assert.equal(submitEvent.preventDefaultCalled, true);
  assert.deepEqual(clonePlain(runtime.sandbox.__pickerExportCalls), [
    {
      mediaKeys: ["video-a", "video-z"],
      options: { grantAuthorization: true, autoOpenMetadata: true },
    },
    {
      mediaKeys: ["video-a", "video-z"],
      options: { direct: true },
    },
  ]);
});

test("direct selected export downloads once with missing markers and starts no provider", async () => {
  const noteSources = require("../note-sources.js");
  const storageLocal = createMemoryStorageArea();
  const mediaKey = "direct-video";
  await noteSources.writeNoteSource(storageLocal, {
    mediaKey,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${mediaKey}`,
    titleOriginal: "Direct video",
    channelName: "Channel",
    descriptionStatus: "unknown",
    sourceLanguage: "en",
  });
  const note = {
    id: "direct-note",
    mediaKey,
    videoId: mediaKey,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${mediaKey}`,
    videoTitle: "Direct video",
    channelName: "Channel",
    timestampSeconds: 7,
    text: "English saved note.",
    translatedText: "",
    sourceLanguage: "en",
  };
  const messages = [];
  const documentImpl = createInteractiveDocument();
  const runtime = loadSidepanelRuntime({
    documentImpl,
    storageLocal,
    async sendMessage(message) {
      messages.push(JSON.parse(JSON.stringify(message)));
      if (message.action === "getNotes") return { success: true, notes: [note] };
      if (message.action === "upsertNoteSource") {
        const write = await noteSources.writeNoteSource(storageLocal, message.source);
        return {
          success: true,
          changed: write.changed,
          source: await noteSources.readNoteSource(storageLocal, mediaKey),
        };
      }
      if (message.action === "cancelExportTranslationJob") {
        return { success: true };
      }
      throw new Error(`Unexpected background action: ${message.action}`);
    },
  });
  const downloads = [];
  runtime.sandbox.__downloadProbe = (text, filename) => {
    downloads.push({ text, filename });
  };
  runtime.evaluate(
    "downloadTextFile = (text, filename) => globalThis.__downloadProbe(text, filename)",
  );

  await runtime.helpers.exportAllNotes([mediaKey], { direct: true });

  assert.equal(downloads.length, 1);
  assert.match(downloads[0].text, /缺失：原文视频简介/);
  assert.equal(downloads[0].filename.endsWith(".txt"), true);
  assert.equal(
    messages.some((message) =>
      [
        "translateExportNotesBatch",
        "translateExportSourceBatch",
        "fetchTranscript",
        "relayToContent",
      ].includes(message.action),
    ),
    false,
  );
});

test("opening the picker can recover a frozen retry selection without resuming work", async () => {
  const actions = [];
  const runtime = loadSidepanelRuntime({
    async sendMessage(message) {
      actions.push(message.action);
      if (message.action === "listExportJobs") {
        return {
          success: true,
          jobs: [
            {
              state: "paused",
              updatedAt: 20,
              intent: {
                scope: "notes-retry-v4-test",
                mediaKeys: ["video-b", "video-a"],
                mode: "bilingual",
              },
            },
          ],
        };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(await runtime.helpers.recoverNotesExportSelection())),
    ["video-a", "video-b"],
  );
  assert.deepEqual(actions, ["listExportJobs"]);
});

test("cross-page complete-export authorization freezes provider, notes, and complete sources", async () => {
  const noteSources = require("../note-sources.js");
  let provider = {
    id: "deepseek",
    displayName: "DeepSeek",
    modelId: "deepseek-v4-flash",
    routeKey: "deepseek:deepseek-v4-flash",
  };
  const actions = [];
  const runtime = loadSidepanelRuntime({
    async sendMessage(message) {
      actions.push(message.action);
      if (message.action === "checkConfig") {
        return { hasAiKey: true, provider: { ...provider } };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    },
  });
  const note = {
    id: "authorization-note",
    mediaKey: "authorization-video",
    videoId: "authorization-video",
    videoTitle: "Authorization video",
    text: "Saved English note.",
    sourceLanguage: "en",
  };
  const groups = [
    {
      mediaKey: note.mediaKey,
      representative: note,
      notes: [note],
    },
  ];
  const source = noteSources.normalizeNoteSource({
    mediaKey: note.mediaKey,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${note.mediaKey}`,
    titleOriginal: note.videoTitle,
    channelName: "Channel",
    descriptionOriginal: "Complete description.",
    descriptionStatus: "present",
    sourceLanguage: "en",
  });
  const sourcesByKey = { [note.mediaKey]: source };
  const precheck = runtime.helpers.buildNotesExportPrecheck(
    groups,
    sourcesByKey,
    "bilingual",
  );
  const continuation = runtime.helpers.createNoteExportContinuation([
    note.mediaKey,
  ]);

  await runtime.helpers.grantNoteExportAuthorization(continuation, {
    groups,
    sourcesByKey,
    precheck,
  });
  provider = {
    id: "zhipu",
    displayName: "智谱 GLM",
    modelId: "glm-4.7-flash",
    routeKey: "zhipu:glm-4.7-flash",
  };
  assert.equal(
    await runtime.helpers.validateNoteExportAuthorization(continuation, {
      groups,
      sourcesByKey,
      precheck,
    }),
    false,
    "a provider change invalidates the disclosed click",
  );

  provider = {
    id: "deepseek",
    displayName: "DeepSeek",
    modelId: "deepseek-v4-flash",
    routeKey: "deepseek:deepseek-v4-flash",
  };
  await runtime.helpers.grantNoteExportAuthorization(continuation, {
    groups,
    sourcesByKey,
    precheck,
  });
  const changedGroups = [
    {
      ...groups[0],
      notes: [{ ...note, text: "Changed note after confirmation." }],
    },
  ];
  assert.equal(
    await runtime.helpers.validateNoteExportAuthorization(continuation, {
      groups: changedGroups,
      sourcesByKey,
      precheck,
    }),
    false,
    "a note change requires another confirmation",
  );

  await runtime.helpers.grantNoteExportAuthorization(continuation, {
    groups,
    sourcesByKey,
    precheck,
  });
  const changedSource = noteSources.normalizeNoteSource({
    ...source,
    descriptionOriginal: "Changed complete description.",
  });
  assert.equal(
    await runtime.helpers.validateNoteExportAuthorization(continuation, {
      groups,
      sourcesByKey: { [note.mediaKey]: changedSource },
      precheck: runtime.helpers.buildNotesExportPrecheck(
        groups,
        { [note.mediaKey]: changedSource },
        "bilingual",
      ),
    }),
    false,
    "a source that was complete at confirmation is frozen",
  );
  assert.equal(
    actions.some((action) => action.startsWith("translateExport")),
    false,
  );
});

test("authorized metadata completion is accepted once and its new revision is then frozen", async () => {
  const noteSources = require("../note-sources.js");
  const runtime = loadSidepanelRuntime({
    async sendMessage(message) {
      if (message.action === "checkConfig") {
        return {
          hasAiKey: true,
          provider: {
            id: "deepseek",
            modelId: "deepseek-v4-flash",
            routeKey: "deepseek:deepseek-v4-flash",
          },
        };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    },
  });
  const note = {
    id: "metadata-authorization-note",
    mediaKey: "metadata-authorization-video",
    videoId: "metadata-authorization-video",
    videoTitle: "Metadata authorization video",
    text: "Saved English note.",
    sourceLanguage: "en",
  };
  const groups = [
    { mediaKey: note.mediaKey, representative: note, notes: [note] },
  ];
  const incompleteSource = noteSources.normalizeNoteSource({
    mediaKey: note.mediaKey,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${note.mediaKey}`,
    titleOriginal: note.videoTitle,
    channelName: "Channel",
    descriptionStatus: "unknown",
    sourceLanguage: "en",
  });
  const initialSources = { [note.mediaKey]: incompleteSource };
  const initialPrecheck = runtime.helpers.buildNotesExportPrecheck(
    groups,
    initialSources,
    "bilingual",
  );
  const continuation = runtime.helpers.createNoteExportContinuation([
    note.mediaKey,
  ]);
  await runtime.helpers.grantNoteExportAuthorization(continuation, {
    groups,
    sourcesByKey: initialSources,
    precheck: initialPrecheck,
  });

  const completedSource = noteSources.normalizeNoteSource({
    ...incompleteSource,
    descriptionOriginal: "Captured complete description.",
    descriptionStatus: "present",
  });
  const completedSources = { [note.mediaKey]: completedSource };
  const completedPrecheck = runtime.helpers.buildNotesExportPrecheck(
    groups,
    completedSources,
    "bilingual",
  );
  assert.equal(
    await runtime.helpers.validateNoteExportAuthorization(continuation, {
      groups,
      sourcesByKey: completedSources,
      precheck: completedPrecheck,
    }),
    true,
  );

  const changedAgain = noteSources.normalizeNoteSource({
    ...completedSource,
    descriptionOriginal: "Changed after metadata completion.",
  });
  assert.equal(
    await runtime.helpers.validateNoteExportAuthorization(continuation, {
      groups,
      sourcesByKey: { [note.mediaKey]: changedAgain },
      precheck: runtime.helpers.buildNotesExportPrecheck(
        groups,
        { [note.mediaKey]: changedAgain },
        "bilingual",
      ),
    }),
    false,
  );
});

test("cancel and direct export both revoke a pending complete-export grant", async () => {
  for (const actionText of ["取消", "直接导出"]) {
    let resolveConfig;
    const documentImpl = createInteractiveDocument();
    const runtime = loadSidepanelRuntime({
      documentImpl,
      async sendMessage(message) {
        if (message.action === "checkConfig") {
          return new Promise((resolve) => {
            resolveConfig = resolve;
          });
        }
        throw new Error(`Unexpected action: ${message.action}`);
      },
    });
    const note = {
      id: `pending-${actionText}`,
      mediaKey: `pending-video-${actionText}`,
      videoId: `pending-video-${actionText}`,
      videoTitle: "Pending authorization",
      text: "English note.",
      sourceLanguage: "en",
    };
    const groups = [
      { mediaKey: note.mediaKey, representative: note, notes: [note] },
    ];
    const sourcesByKey = {
      [note.mediaKey]: require("../note-sources.js").normalizeNoteSource({
        mediaKey: note.mediaKey,
        platform: "youtube",
        canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(note.mediaKey)}`,
        titleOriginal: note.videoTitle,
        channelName: "Channel",
        descriptionOriginal: "English description.",
        descriptionStatus: "present",
        sourceLanguage: "en",
      }),
    };
    const precheck = runtime.helpers.buildNotesExportPrecheck(
      groups,
      sourcesByKey,
      "bilingual",
    );
    const continuation = runtime.helpers.createNoteExportContinuation([
      note.mediaKey,
    ]);
    let grantPromise = null;
    runtime.helpers.showNoteExportPrecheck(
      precheck,
      () => {},
      () => {
        grantPromise = runtime.helpers.grantNoteExportAuthorization(
          continuation,
          { groups, sourcesByKey, precheck },
        );
      },
      { overLimit: false, estimatedBatches: 1 },
    );

    documentImpl.findButton("notesExportPrecheck", "完整导出").click();
    await nextTurn();
    assert.ok(grantPromise, "the deferred grant has started");
    documentImpl.findButton("notesExportPrecheck", actionText).click();
    resolveConfig({
      hasAiKey: true,
      provider: {
        id: "deepseek",
        modelId: "deepseek-v4-flash",
        routeKey: "deepseek:deepseek-v4-flash",
      },
    });
    assert.equal(await grantPromise, null);
    assert.equal(
      runtime.helpers.noteExportContinuationIsAuthorized(continuation),
      false,
    );
  }
});

test("cancelling while authorization validation waits cannot return a stale true", async () => {
  let deferValidation = false;
  let resolveValidation;
  const runtime = loadSidepanelRuntime({
    async sendMessage(message) {
      if (message.action !== "checkConfig") {
        throw new Error(`Unexpected action: ${message.action}`);
      }
      const config = {
        hasAiKey: true,
        provider: {
          id: "deepseek",
          modelId: "deepseek-v4-flash",
          routeKey: "deepseek:deepseek-v4-flash",
        },
      };
      if (!deferValidation) return config;
      return new Promise((resolve) => {
        resolveValidation = () => resolve(config);
      });
    },
  });
  const note = {
    id: "validation-cancel-note",
    mediaKey: "validation-cancel-video",
    videoId: "validation-cancel-video",
    videoTitle: "Validation cancel video",
    text: "English note.",
    sourceLanguage: "en",
  };
  const groups = [
    { mediaKey: note.mediaKey, representative: note, notes: [note] },
  ];
  const sourcesByKey = {
    [note.mediaKey]: require("../note-sources.js").normalizeNoteSource({
      mediaKey: note.mediaKey,
      platform: "youtube",
      canonicalUrl: `https://www.youtube.com/watch?v=${note.mediaKey}`,
      titleOriginal: note.videoTitle,
      channelName: "Channel",
      descriptionOriginal: "English description.",
      descriptionStatus: "present",
      sourceLanguage: "en",
    }),
  };
  const precheck = runtime.helpers.buildNotesExportPrecheck(
    groups,
    sourcesByKey,
    "bilingual",
  );
  const continuation = runtime.helpers.createNoteExportContinuation([
    note.mediaKey,
  ]);
  await runtime.helpers.grantNoteExportAuthorization(continuation, {
    groups,
    sourcesByKey,
    precheck,
  });

  deferValidation = true;
  const validation = runtime.helpers.validateNoteExportAuthorization(
    continuation,
    { groups, sourcesByKey, precheck },
  );
  await nextTurn();
  runtime.helpers.revokeNoteExportAuthorization();
  resolveValidation();
  await assert.rejects(validation, {
    code: "NOTE_EXPORT_AUTHORIZATION_CANCELLED",
  });
});

test("a provider change between the disclosed click and first round starts zero work", async () => {
  const actions = [];
  const runtime = loadSidepanelRuntime({
    async sendMessage(message) {
      actions.push(message.action);
      if (message.action === "checkConfig") {
        return {
          hasAiKey: true,
          provider: {
            id: "zhipu",
            displayName: "智谱 GLM",
            modelId: "glm-4.7-flash",
            routeKey: "zhipu:glm-4.7-flash",
            capabilities: ["translate"],
          },
        };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    },
  });
  const fixture = makeNoteRoundFixture(1);

  await assert.rejects(
    runtime.helpers.runConfirmedExportTranslation({
      plan: fixture.plan,
      sourcesByKey: {},
      groups: fixture.groups,
      scope: "notes-selected",
      mode: "bilingual",
      format: "txt",
      panelId: "notesExportPrecheck",
      setStatus() {},
      expectedProviderSnapshot: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        routeKey: "deepseek:deepseek-v4-flash",
        targetLanguage: "zh",
        translationVersion: "export-v2",
      },
    }),
    { code: "EXPORT_JOB_PROVIDER_MISMATCH" },
  );
  assert.deepEqual(actions, ["checkConfig"]);
});

test("provider mismatch refreshes the confirmation copy before another click", async () => {
  const noteSources = require("../note-sources.js");
  const storageLocal = createMemoryStorageArea();
  const documentImpl = createInteractiveDocument();
  const mediaKey = "provider-disclosure-refresh";
  const note = {
    id: "provider-disclosure-note",
    mediaKey,
    videoId: mediaKey,
    videoTitle: "Provider disclosure video",
    channelName: "Channel",
    text: "English note that needs translation.",
    sourceLanguage: "en",
  };
  await noteSources.writeNoteSource(storageLocal, {
    mediaKey,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${mediaKey}`,
    titleOriginal: note.videoTitle,
    channelName: note.channelName,
    descriptionOriginal: "English description that needs translation.",
    descriptionStatus: "present",
    sourceLanguage: "en",
  });
  const deepseek = {
    id: "deepseek",
    displayName: "DeepSeek",
    modelId: "deepseek-v4-flash",
    routeKey: "deepseek:deepseek-v4-flash",
    capabilities: ["translate"],
  };
  const zhipu = {
    id: "zhipu",
    displayName: "智谱 GLM",
    modelId: "glm-4.7-flash",
    routeKey: "zhipu:glm-4.7-flash",
    capabilities: ["translate"],
  };
  let configReads = 0;
  const actions = [];
  const runtime = loadSidepanelRuntime({
    storageLocal,
    documentImpl,
    async sendMessage(message) {
      actions.push(message.action);
      if (message.action === "getNotes") return { success: true, notes: [note] };
      if (message.action === "upsertNoteSource") {
        await noteSources.writeNoteSource(storageLocal, message.source);
        return {
          success: true,
          source: await noteSources.readNoteSource(storageLocal, mediaKey),
        };
      }
      if (message.action === "checkConfig") {
        configReads += 1;
        return {
          hasAiKey: true,
          provider: configReads === 1 ? deepseek : zhipu,
        };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    },
  });
  runtime.evaluate(
    `currentConfigStatus = { hasAiKey: true, provider: ${JSON.stringify(deepseek)} }`,
  );

  await runtime.helpers.exportAllNotes([mediaKey]);
  const panel = documentImpl.element("notesExportPrecheck");
  assert.match(panel.children[0].textContent, /DeepSeek/);
  documentImpl.findButton("notesExportPrecheck", "完整导出").click();
  for (let index = 0; index < 8; index += 1) await nextTurn();

  assert.match(panel.children[0].textContent, /智谱 GLM/);
  assert.ok(documentImpl.findButton("notesExportPrecheck", "完整导出"));
  assert.equal(
    actions.some((action) =>
      [
        "createOrResumeExportJob",
        "translateExportNotesBatch",
        "translateExportSourceBatch",
      ].includes(action),
    ),
    false,
  );
});

test("a rebuilt side panel restores the frozen scope but never resumes AI without a fresh click", async () => {
  const noteSources = require("../note-sources.js");
  const storageLocal = createMemoryStorageArea();
  const mediaKey = "rebuild-video";
  await noteSources.writeNoteSource(storageLocal, {
    mediaKey,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${mediaKey}`,
    titleOriginal: "Rebuild video",
    channelName: "Channel",
    descriptionOriginal: "English description.",
    descriptionStatus: "present",
    sourceLanguage: "en",
  });
  const note = {
    id: "rebuild-note",
    mediaKey,
    videoId: mediaKey,
    videoTitle: "Rebuild video",
    channelName: "Channel",
    text: "English note.",
    sourceLanguage: "en",
  };
  const actions = [];
  const documentImpl = createInteractiveDocument();
  const runtime = loadSidepanelRuntime({
    storageLocal,
    documentImpl,
    async sendMessage(message) {
      actions.push(message.action);
      if (message.action === "getNotes") return { success: true, notes: [note] };
      if (message.action === "upsertNoteSource") {
        await noteSources.writeNoteSource(storageLocal, message.source);
        return {
          success: true,
          source: await noteSources.readNoteSource(storageLocal, mediaKey),
        };
      }
      if (message.action === "cancelExportTranslationJob") {
        return { success: true };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    },
  });

  await runtime.helpers.resumeNoteExportContinuation({
    mediaKeys: [mediaKey],
    mode: "bilingual",
  });

  assert.ok(
    documentImpl.findButton("notesExportPrecheck", "完整导出"),
    "rebuild returns to confirmation instead of silently calling AI",
  );
  assert.equal(
    actions.some((action) => action.startsWith("translateExport")),
    false,
  );
  assert.equal(actions.includes("checkConfig"), false);
});

test("changing the notes language revokes the old grant and resumes only at confirmation", async () => {
  const noteSources = require("../note-sources.js");
  const storageLocal = createMemoryStorageArea();
  const mediaKey = "mode-change-video";
  await noteSources.writeNoteSource(storageLocal, {
    mediaKey,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${mediaKey}`,
    titleOriginal: "Mode change video",
    channelName: "Channel",
    descriptionOriginal: "English description.",
    descriptionStatus: "present",
    sourceLanguage: "en",
  });
  const note = {
    id: "mode-change-note",
    mediaKey,
    videoId: mediaKey,
    videoTitle: "Mode change video",
    channelName: "Channel",
    text: "English note.",
    sourceLanguage: "en",
  };
  const actions = [];
  const documentImpl = createInteractiveDocument();
  const runtime = loadSidepanelRuntime({
    storageLocal,
    documentImpl,
    async sendMessage(message) {
      actions.push(message.action);
      if (message.action === "checkConfig") {
        return {
          hasAiKey: true,
          provider: {
            id: "deepseek",
            modelId: "deepseek-v4-flash",
            routeKey: "deepseek:deepseek-v4-flash",
          },
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [note] };
      if (message.action === "upsertNoteSource") {
        await noteSources.writeNoteSource(storageLocal, message.source);
        return {
          success: true,
          source: await noteSources.readNoteSource(storageLocal, mediaKey),
        };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    },
  });
  const groups = [{ mediaKey, representative: note, notes: [note] }];
  const sourcesByKey = {
    [mediaKey]: await noteSources.readNoteSource(storageLocal, mediaKey),
  };
  const continuation = runtime.helpers.createNoteExportContinuation([mediaKey]);
  const precheck = runtime.helpers.buildNotesExportPrecheck(
    groups,
    sourcesByKey,
    "bilingual",
  );
  await runtime.helpers.grantNoteExportAuthorization(continuation, {
    groups,
    sourcesByKey,
    precheck,
  });
  actions.length = 0;

  runtime.helpers.handleNotesModeChange("original");
  await runtime.helpers.resumeNoteExportContinuation({
    mediaKeys: [mediaKey],
    mode: "original",
  });

  assert.equal(
    runtime.helpers.noteExportContinuationIsAuthorized(continuation),
    false,
  );
  assert.ok(documentImpl.findButton("notesExportPrecheck", "完整导出"));
  assert.equal(actions.includes("checkConfig"), false);
  assert.equal(
    actions.some((action) => action.startsWith("translateExport")),
    false,
  );
});

test("fresh confirmation for a ready original export downloads without AI configuration", async () => {
  const noteSources = require("../note-sources.js");
  const storageLocal = createMemoryStorageArea();
  const storageSession = createMemoryStorageArea();
  const mediaKey = "ready-original-video";
  await noteSources.writeNoteSource(storageLocal, {
    mediaKey,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${mediaKey}`,
    titleOriginal: "Ready original video",
    channelName: "Channel",
    descriptionOriginal: "Complete original description.",
    descriptionStatus: "present",
    sourceLanguage: "en",
  });
  const note = {
    id: "ready-original-note",
    mediaKey,
    videoId: mediaKey,
    videoTitle: "Ready original video",
    channelName: "Channel",
    text: "Original note.",
    sourceLanguage: "en",
  };
  const actions = [];
  const downloads = [];
  const documentImpl = createInteractiveDocument();
  const firstRuntime = loadSidepanelRuntime({ storageSession });
  await firstRuntime.helpers.persistNoteNavigationState({
    schemaVersion: 1,
    phase: "active",
    token: "ready-original-continuation",
    tabId: 77,
    routeKey: `youtube:${mediaKey}`,
    mediaKey,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${mediaKey}`,
    timestampedUrl: `https://www.youtube.com/watch?v=${mediaKey}&t=5s`,
    videoTitle: note.videoTitle,
    channelName: note.channelName,
    sourceLanguage: "en",
    duration: 120,
    showAll: true,
    captureMetadata: false,
    exportContinuation: { mediaKeys: [mediaKey], mode: "original" },
    createdAt: Date.now(),
    expiresAt: 0,
    activatedAt: Date.now(),
  });
  const runtime = loadSidepanelRuntime({
    storageLocal,
    storageSession,
    documentImpl,
    async sendMessage(message) {
      actions.push(message.action);
      if (message.action === "getNotes") return { success: true, notes: [note] };
      if (message.action === "upsertNoteSource") {
        await noteSources.writeNoteSource(storageLocal, message.source);
        return {
          success: true,
          source: await noteSources.readNoteSource(storageLocal, mediaKey),
        };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    },
  });
  runtime.sandbox.__downloadProbe = (text, filename) => {
    downloads.push({ text, filename });
  };
  runtime.evaluate(`
    downloadTextFile = (text, filename) =>
      globalThis.__downloadProbe(text, filename);
  `);
  await runtime.helpers.hydrateNoteNavigationState();
  const restored = JSON.parse(
    runtime.evaluate(
      "JSON.stringify((activeNotesOnlyContext || pendingNoteNavigation)?.exportContinuation || null)",
    ),
  );
  assert.equal(restored.mode, "original");

  await runtime.helpers.resumeNoteExportContinuation(restored);
  assert.equal(runtime.evaluate("currentNotesMode"), "original");
  assert.match(
    documentImpl.element("notesExportPrecheck").children[0].textContent,
    /范围：1 个视频、1 条笔记/,
  );
  const complete = documentImpl.findButton(
    "notesExportPrecheck",
    "完整导出",
  );
  assert.ok(complete);
  complete.click();
  await nextTurn();
  await nextTurn();

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename.endsWith(".txt"), true);
  assert.equal(actions.includes("checkConfig"), false);
  assert.equal(
    actions.some((action) => action.startsWith("translateExport")),
    false,
  );
});

test("notes export job identity includes the v4 TXT content contract", () => {
  const helpers = loadSidepanelHelpers();
  const intent = helpers.buildFrozenExportIntent({
    scope: "notes-current",
    mediaKeys: ["video-a"],
    mode: "bilingual",
    format: "txt",
    sourceRevisions: { "video-a": "source-r1" },
    notesRevision: "notes-r1",
    providerSnapshot: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      routeKey: "deepseek:deepseek-v4-flash",
      targetLanguage: "zh",
      translationVersion: "export-v2",
    },
  });
  assert.match(intent.scope, /^notes-current-v4-/);
  assert.equal(intent.format, "txt");
});

test("selected note export freezes only requested media keys and fails closed when one disappears", () => {
  const helpers = loadSidepanelHelpers();
  const groups = [
    { mediaKey: "video-b", notes: [{ id: "b" }] },
    { mediaKey: "video-a", notes: [{ id: "a" }] },
    { mediaKey: "video-c", notes: [{ id: "c" }] },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      helpers.normalizeExportMediaKeys(["video-c", "video-a", "video-a"]),
    )),
    ["video-a", "video-c"],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      helpers
        .filterNoteGroupsByMediaKeys(groups, ["video-c", "video-a"])
        .map((group) => group.mediaKey),
    )),
    ["video-a", "video-c"],
  );
  assert.throws(
    () => helpers.filterNoteGroupsByMediaKeys(groups, ["video-a", "deleted"]),
    (error) => error.code === "EXPORT_SELECTION_STALE",
  );
});

test("the real progress cancel button cancels the durable job and starts no later batch", async () => {
  const controller = createSidepanelJobController({
    holdFirstTranslation: true,
  });
  const documentImpl = createInteractiveDocument();
  const fixture = makeNoteRoundFixture(2);
  const runtime = loadSidepanelRuntime({
    sendMessage: controller.sendMessage,
    documentImpl,
    exportJobsImpl: createExportJobsBridge(),
  });
  const task = runtime.helpers.runConfirmedExportTranslation({
    plan: fixture.plan,
    sourcesByKey: {},
    groups: fixture.groups,
    scope: "notes-current",
    mode: "bilingual",
    format: "txt",
    panelId: "notesExportPrecheck",
    setStatus() {},
  });
  for (
    let attempt = 0;
    attempt < 20 && !controller.hasPendingTranslation();
    attempt += 1
  ) {
    await nextTurn();
  }
  assert.equal(controller.hasPendingTranslation(), true);
  const cancel = documentImpl.findButton(
    "notesExportPrecheck",
    "取消后续批次",
  );
  assert.ok(cancel, "the rendered progress panel exposes a real cancel button");
  cancel.click();
  await nextTurn();
  assert.equal(
    controller.actions.filter(
      (action) => action === "cancelExportTranslationJob",
    ).length,
    1,
  );

  controller.releaseFirstTranslation();
  await assert.rejects(task, (error) => {
    assert.equal(error.code, "EXPORT_TRANSLATION_CANCELLED");
    return true;
  });
  assert.equal(
    controller.actions.filter(
      (action) => action === "translateExportNotesBatch",
    ).length,
    1,
    "cancellation never starts the second batch",
  );
  assert.equal(controller.job().state, "cancelled");
});

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

function createMemoryStorage(initial = {}) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const state = clone(initial);
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return clone(state);
      if (typeof keys === "string") {
        return Object.hasOwn(state, keys) ? { [keys]: clone(state[keys]) } : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .filter((key) => Object.hasOwn(state, key))
            .map((key) => [key, clone(state[key])]),
        );
      }
      if (keys && typeof keys === "object") {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.hasOwn(state, key) ? clone(state[key]) : clone(fallback),
          ]),
        );
      }
      return {};
    },
    async set(items) {
      Object.entries(items || {}).forEach(([key, value]) => {
        state[key] = clone(value);
      });
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete state[key]);
    },
    async clear() {
      Object.keys(state).forEach((key) => delete state[key]);
    },
    snapshot() {
      return clone(state);
    },
  };
}

const clonePlain = (value) => JSON.parse(JSON.stringify(value));

function createNoteSourcesBridge(
  noteSources = require("../note-sources.js"),
) {
  return {
    ...noteSources,
    normalizeNoteSource: (value) =>
      noteSources.normalizeNoteSource(clonePlain(value)),
    readNoteSource: (adapter, key) => noteSources.readNoteSource(adapter, key),
    writeNoteSource: (adapter, value, options) =>
      noteSources.writeNoteSource(adapter, clonePlain(value), {
        ...clonePlain(options || {}),
        protectedKeys: new Set(options?.protectedKeys || []),
      }),
    preflightNoteSourceStorage: (adapter) =>
      noteSources.preflightNoteSourceStorage(adapter),
    clearNoteSources: (adapter) => noteSources.clearNoteSources(adapter),
    validateExportSourceTranslationUnits: (storedSource, request) =>
      noteSources.validateExportSourceTranslationUnits(
        clonePlain(storedSource),
        clonePlain(request),
      ),
    commitExportSourceTranslationBatch: (adapter, payload, options) =>
      noteSources.commitExportSourceTranslationBatch(
        adapter,
        {
          ...clonePlain(payload),
          translationsById: Object.fromEntries(payload.translationsById || []),
        },
        clonePlain({
          ...options,
          protectedKeys: [...(options?.protectedKeys || [])],
        }),
      ),
  };
}

function createExportJobsBridge(
  exportJobs = require("../export-jobs.js"),
) {
  return {
    ...exportJobs,
    normalizeExportJob: (value) =>
      exportJobs.normalizeExportJob(clonePlain(value)),
    createExportJob: (value) =>
      exportJobs.createExportJob(clonePlain(value)),
    readExportJob: (adapter, id) => exportJobs.readExportJob(adapter, id),
    upsertExportJob: (adapter, value, options) =>
      exportJobs.upsertExportJob(
        adapter,
        clonePlain(value),
        clonePlain(options || {}),
      ),
    preflightExportJobs: (adapter) => exportJobs.preflightExportJobs(adapter),
    clearExportJobs: (adapter) => exportJobs.clearExportJobs(adapter),
    checkpointExportJob: (adapter, id, patch, options) =>
      exportJobs.checkpointExportJob(
        adapter,
        id,
        clonePlain(patch),
        clonePlain(options || {}),
      ),
  };
}

function createInteractiveDocument() {
  const elements = new Map();
  const documentListeners = {};
  const dispatchToListeners = (listeners, event, currentTarget) => {
    const normalizedEvent = {
      type: String(event?.type || ""),
      target: currentTarget,
      currentTarget,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      ...(event || {}),
    };
    let result;
    for (const listener of listeners[normalizedEvent.type] || []) {
      result = listener(normalizedEvent);
    }
    return result;
  };
  const createElement = (tagName = "div") => {
    let text = "";
    const listeners = {};
    const classes = new Set();
    return {
      tagName: String(tagName).toUpperCase(),
      children: [],
      hidden: false,
      disabled: false,
      className: "",
      style: {},
      classList: {
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : !!force;
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
        add(...names) {
          names.forEach((name) => classes.add(name));
        },
        remove(...names) {
          names.forEach((name) => classes.delete(name));
        },
        contains(name) {
          return classes.has(name);
        },
      },
      setAttribute() {},
      addEventListener(type, listener) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(listener);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      append(...children) {
        this.children.push(...children);
      },
      click() {
        if (this.disabled) return undefined;
        return this.dispatchEvent({ type: "click" });
      },
      dispatchEvent(event) {
        return dispatchToListeners(listeners, event, this);
      },
      set textContent(value) {
        text = String(value);
      },
      get textContent() {
        return text;
      },
      set innerHTML(value) {
        text = String(value);
        this.children = [];
      },
      get innerHTML() {
        return text;
      },
    };
  };
  const element = (id) => {
    if (!elements.has(id)) {
      const node = createElement("div");
      node.id = id;
      elements.set(id, node);
    }
    return elements.get(id);
  };
  return {
    addEventListener(type, listener) {
      if (!documentListeners[type]) documentListeners[type] = [];
      documentListeners[type].push(listener);
    },
    dispatchEvent(event) {
      return dispatchToListeners(documentListeners, event, this);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: element,
    createElement,
    element,
    findButton(id, text) {
      const queue = [...element(id).children];
      while (queue.length) {
        const node = queue.shift();
        if (node.tagName === "BUTTON" && node.textContent === text) return node;
        queue.push(...(node.children || []));
      }
      return null;
    },
  };
}

function createSidepanelJobController({ holdFirstTranslation = false } = {}) {
  const actions = [];
  const translatedNoteIds = [];
  let job = null;
  let releaseFirstTranslation;
  const deepClone = (value) => (value === null ? null : clonePlain(value));
  const sendMessage = async (message) => {
    actions.push(message.action);
    if (message.action === "checkConfig") {
      return {
        hasAiKey: true,
        provider: {
          id: "deepseek",
          displayName: "DeepSeek",
          modelId: "deepseek-v4-flash",
          routeKey: "deepseek:deepseek-v4-flash",
          capabilities: ["translate"],
        },
      };
    }
    if (message.action === "getExportJob") {
      return job
        ? { success: true, code: "OK", job: deepClone(job) }
        : { success: false, code: "EXPORT_JOB_NOT_FOUND" };
    }
    if (message.action === "createOrResumeExportJob") {
      if (!job) job = deepClone(message.job);
      return { success: true, code: "OK", job: deepClone(job) };
    }
    if (message.action === "checkpointExportJob") {
      assert.ok(job, "checkpoint requires a persisted job");
      const patch = deepClone(message.patch || {});
      if (patch.completedUnitKeys) {
        const completed = new Set([
          ...(job.completedUnitKeys || []),
          ...patch.completedUnitKeys,
        ]);
        job.completedUnitKeys = job.orderedUnitKeys.filter((key) =>
          completed.has(key),
        );
      }
      for (const field of [
        "state",
        "currentBatch",
        "cursor",
        "exportClaim",
        "lastError",
      ]) {
        if (Object.hasOwn(patch, field)) job[field] = patch[field];
      }
      return { success: true, code: "OK", job: deepClone(job) };
    }
    if (message.action === "cancelExportTranslationJob") {
      if (job) {
        job.state = "cancelled";
        job.currentBatch = null;
        job.exportClaim = null;
      }
      return {
        success: true,
        code: "EXPORT_JOB_CANCELLED",
        jobState: "cancelled",
      };
    }
    if (message.action === "translateExportNotesBatch") {
      if (holdFirstTranslation && !releaseFirstTranslation) {
        await new Promise((resolve) => {
          releaseFirstTranslation = resolve;
        });
      }
      const translations = (message.notes || []).map((note) => {
        translatedNoteIds.push(String(note.id));
        return { id: note.id, textZh: `中文 ${note.id}` };
      });
      const titles = (message.titles || []).map((title) => ({
        mediaKey: title.mediaKey,
        titleZh: `中文 ${title.mediaKey}`,
      }));
      return { success: true, translations, titles };
    }
    throw new Error(`Unexpected sidepanel action: ${message.action}`);
  };
  return {
    sendMessage,
    actions,
    translatedNoteIds,
    job: () => deepClone(job),
    hasPendingTranslation: () => typeof releaseFirstTranslation === "function",
    releaseFirstTranslation: () => {
      assert.equal(
        typeof releaseFirstTranslation,
        "function",
        "first translation must be pending",
      );
      const release = releaseFirstTranslation;
      releaseFirstTranslation = null;
      release();
    },
  };
}

function makeNoteRoundFixture(batchCount) {
  const notes = Array.from({ length: batchCount }, (_, index) => ({
    id: `round-note-${index + 1}`,
    mediaKey: "round-video",
    videoId: "round-video",
    videoTitle: "Round test",
    text: `English note ${index + 1}`,
  }));
  return {
    notes,
    groups: [{ mediaKey: "round-video", notes }],
    plan: {
      overLimit: false,
      estimatedBatches: batchCount,
      maxProviderCalls: batchCount * 5,
      unitCount: batchCount,
      progress: {
        totalUnits: batchCount,
        completedUnits: 0,
        remainingUnits: batchCount,
        remainingBatches: batchCount,
        roundMaxBatches: 20,
      },
      noteBatches: notes.map((note) => [note]),
      titleBatches: [],
      sourceBatches: [],
      sourceWorkByKey: {},
    },
  };
}

function makeExportNotesBackground({ switchProviderBeforeFetch = false } = {}) {
  const noteSources = require("../note-sources.js");
  const exportJobs = require("../export-jobs.js");
  const mediaKey = "canonical-note-video";
  const note = {
    id: "canonical-note-1",
    mediaKey,
    videoId: mediaKey,
    platform: "youtube",
    videoTitle: "Canonical Stored Video Title",
    text: "Canonical stored English note body.",
    rawText: "Canonical stored English note body.",
    sourceLanguage: "en",
    textLanguage: "en",
    translatedText: "",
  };
  const noteUnitKey = `note:${noteSources.hashSourceText(note.id)}:${noteSources.hashSourceText(note.text)}`;
  const titleUnitKey = `title:${noteSources.hashSourceText(mediaKey)}:${noteSources.hashSourceText(note.videoTitle)}`;
  const notesRevision = noteSources.hashSourceText(
    JSON.stringify([[note.id, mediaKey, note.text, note.videoTitle]]),
  );
  const intent = {
    scope: "notes-current",
    mediaKeys: [mediaKey],
    mode: "bilingual",
    format: "markdown",
    autoExport: true,
  };
  const job = exportJobs.createExportJob({
    state: "running",
    intent,
    sourceRevisions: {},
    notesRevision,
    orderedUnitKeys: [noteUnitKey, titleUnitKey],
    completedUnitKeys: [],
    currentBatch: null,
    cursor: 0,
    roundBudget: { maxBatches: 20 },
    providerSnapshot: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      routeKey: "deepseek:deepseek-v4-flash",
      targetLanguage: "zh",
      translationVersion: "export-v2",
    },
    exportClaim: null,
    lastError: null,
  });
  const deepseekSettings = {
    provider: "deepseek",
    aiApiKeys: {
      deepseek: "deepseek-test-key-never-returned",
      zhipu: "zhipu-test-key-never-returned",
      dashscope: "",
      "tencent-hymt": "",
      siliconflow: "",
      fireworks: "",
    },
  };
  const zhipuSettings = { ...deepseekSettings, provider: "zhipu" };
  const storage = createMemoryStorage({
    ytd_settings: deepseekSettings,
    ytd_notes: [note],
    [exportJobs.STORAGE_KEY]: {
      schemaVersion: exportJobs.SCHEMA_VERSION,
      jobs: { [job.jobId]: job },
    },
  });
  let settingsReads = 0;
  let providerCalls = 0;
  const providerInputs = [];
  const background = loadBackgroundHelpers({
    storageGetImpl: async (keys) => {
      if (keys === "ytd_settings") {
        settingsReads += 1;
        return {
          ytd_settings:
            switchProviderBeforeFetch && settingsReads >= 2
              ? zhipuSettings
              : deepseekSettings,
        };
      }
      return storage.get(keys);
    },
    storageSetImpl: storage.set,
    storageRemoveImpl: storage.remove,
    storageClearImpl: storage.clear,
    noteSourcesImpl: createNoteSourcesBridge(noteSources),
    exportJobsImpl: createExportJobsBridge(exportJobs),
    fetchImpl: async (url, options = {}) => {
      if (String(url).startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      providerCalls += 1;
      const body = JSON.parse(options.body);
      const input = JSON.parse(body.messages.at(-1).content);
      providerInputs.push(input);
      const content = Array.isArray(input.notes)
        ? JSON.stringify({
            notes: input.notes.map((item) => ({
              id: item.id,
              textZh: "持久保存的中文笔记。",
            })),
          })
        : JSON.stringify({
            titles: input.titles.map((item) => ({
              mediaKey: item.mediaKey,
              titleZh: "持久保存的中文标题",
            })),
          });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: { content },
            },
          ],
        }),
      };
    },
  });
  return {
    background,
    storage,
    noteSources,
    exportJobs,
    job,
    mediaKey,
    note,
    noteUnitKey,
    titleUnitKey,
    providerCalls: () => providerCalls,
    providerInputs,
  };
}

function publicExportSourceUnit(unit) {
  const common = {
    unitKey: unit.id,
    sourceHash: unit.sourceHash,
    text: unit.text,
    kind: unit.kind,
  };
  return unit.kind === "description"
    ? { ...common, chunkIndex: unit.chunkIndex }
    : {
        ...common,
        segmentId: unit.segmentId,
        start: unit.start,
      };
}

function makeExportSourceProvider({
  holdFirst = false,
  holdPrompt = false,
  partialFirst = false,
  errorPayload = null,
  errorStatus = 500,
} = {}) {
  let providerCalls = 0;
  let releaseFirst;
  let releasePrompt;
  let promptPending = false;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).startsWith("chrome-extension://")) {
      if (holdPrompt && !promptPending && !releasePrompt) {
        promptPending = true;
        await new Promise((resolve) => {
          releasePrompt = resolve;
        });
      }
      return { ok: true, text: async () => read("prompts/translation.md") };
    }
    providerCalls += 1;
    const body = JSON.parse(options.body);
    const userPayload = JSON.parse(body.messages.at(-1).content);
    if (holdFirst && providerCalls === 1) {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    if (errorPayload) {
      return streamingResponse([encode(JSON.stringify(errorPayload))], {
        ok: false,
        status: errorStatus,
      });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                segments: userPayload.segments
                  .map((segment, index) => ({
                    id: segment.id,
                    text: `第 ${providerCalls} 批第 ${index + 1} 段中文译文。`,
                  }))
                  .filter(
                    (_segment, index) =>
                      !(partialFirst && providerCalls === 1 && index > 0),
                  ),
              }),
            },
          },
        ],
      }),
    };
  };
  return {
    fetchImpl,
    calls: () => providerCalls,
    promptPending: () => promptPending,
    releasePrompt: () => {
      assert.equal(typeof releasePrompt, "function", "prompt load is pending");
      const release = releasePrompt;
      releasePrompt = null;
      release();
    },
    releaseFirst: () => {
      assert.equal(typeof releaseFirst, "function", "first provider call is pending");
      releaseFirst();
    },
  };
}

function makeExportSourceBackground({
  segmentCount = 5,
  holdFirst = false,
  holdPrompt = false,
  descriptionOriginal = "",
  partialFirst = false,
  providerErrorPayload = null,
  providerErrorStatus = 500,
} = {}) {
  const noteSources = require("../note-sources.js");
  const exportJobs = require("../export-jobs.js");
  const mediaKey = "export-video-1";
  const titleOriginal = "Resumable export source translation";
  const source = noteSources.normalizeNoteSource({
    mediaKey,
    platform: "youtube",
    titleOriginal,
    descriptionOriginal,
    descriptionStatus: descriptionOriginal ? "present" : "confirmed-empty",
    transcriptOriginal: Array.from({ length: segmentCount }, (_, index) => ({
      segmentId: `segment-${index}`,
      start: index + 0.125,
      text: `English source segment ${index + 1} contains enough words for a real translation check.`,
    })),
    transcriptTruncated: false,
    updatedAt: 10,
  });
  const plan = noteSources.buildExportTranslationPlan({
    groups: [
      {
        mediaKey,
        representative: { videoTitle: titleOriginal },
        notes: [],
      },
    ],
    sourcesByKey: { [mediaKey]: source },
    mode: "bilingual",
    includeTitles: false,
    includeNotes: false,
    includeDescriptions: true,
    includeTranscript: true,
  });
  assert.ok(plan.sourceBatches.length >= 1, "fixture must create source batches");
  const orderedUnitKeys = plan.sourceBatches.flat().map((unit) => unit.id);
  const intent = {
    scope: "current",
    mediaKeys: [mediaKey],
    mode: "bilingual",
    format: "markdown",
    autoExport: true,
  };
  const job = exportJobs.createExportJob(
    {
      state: "running",
      intent,
      sourceRevisions: { [mediaKey]: source.sourceRevision },
      notesRevision: null,
      orderedUnitKeys,
      completedUnitKeys: [],
      currentBatch: null,
      cursor: 0,
      roundBudget: { maxBatches: 20 },
      providerSnapshot: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        routeKey: "deepseek:deepseek-v4-flash",
        targetLanguage: "zh",
        translationVersion: "export-v2",
      },
      exportClaim: null,
      lastError: null,
    },
    { now: 20 },
  );
  const settings = {
    provider: "deepseek",
    aiApiKey: "test-key-never-returned",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  };
  const storage = createMemoryStorage({
    ytd_settings: settings,
    [noteSources.STORAGE_KEY]: { [mediaKey]: source },
    [exportJobs.STORAGE_KEY]: {
      schemaVersion: exportJobs.SCHEMA_VERSION,
      jobs: { [job.jobId]: job },
    },
  });
  const provider = makeExportSourceProvider({
    holdFirst,
    holdPrompt,
    partialFirst,
    errorPayload: providerErrorPayload,
    errorStatus: providerErrorStatus,
  });
  // background.js executes in a vm realm while CommonJS modules execute in the
  // Node realm. Bridge structured inputs so the modules' strict plain-object
  // checks model one Chromium service-worker realm instead of rejecting test
  // objects solely because their prototypes come from different realms.
  const noteSourcesBridge = createNoteSourcesBridge(noteSources);
  const exportJobsBridge = createExportJobsBridge(exportJobs);
  const background = loadBackgroundHelpers({
    settings,
    storageGetImpl: storage.get,
    storageSetImpl: storage.set,
    storageRemoveImpl: storage.remove,
    storageClearImpl: storage.clear,
    fetchImpl: provider.fetchImpl,
    noteSourcesImpl: noteSourcesBridge,
    exportJobsImpl: exportJobsBridge,
  });
  const messageForBatch = (index) => ({
    action: "translateExportSourceBatch",
    jobId: job.jobId,
    mediaKey,
    sourceRevision: source.sourceRevision,
    units: plan.sourceBatches[index].map(publicExportSourceUnit),
    videoTitle: titleOriginal,
  });
  return {
    background,
    storage,
    provider,
    noteSources,
    exportJobs,
    mediaKey,
    source,
    plan,
    job,
    messageForBatch,
  };
}

async function waitForProviderCall(provider, count = 1) {
  for (let attempt = 0; attempt < 20 && provider.calls() < count; attempt += 1) {
    await nextTurn();
  }
  assert.equal(provider.calls(), count, `expected ${count} mocked provider call(s)`);
}

async function waitForPromptGate(provider) {
  for (let attempt = 0; attempt < 20 && !provider.promptPending(); attempt += 1) {
    await nextTurn();
  }
  assert.equal(provider.promptPending(), true, "expected prompt load gate");
}

test("export source batch duplicate submissions share one provider call and one commit", async () => {
  const fixture = makeExportSourceBackground({
    segmentCount: 2,
    holdFirst: true,
  });
  const message = fixture.messageForBatch(0);
  const first = dispatchBackgroundMessage(fixture.background, message);
  const duplicate = dispatchBackgroundMessage(fixture.background, {
    ...message,
    units: message.units.map((unit) => ({ ...unit })),
  });
  await waitForProviderCall(fixture.provider);
  fixture.provider.releaseFirst();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.equal(firstResult.success, true);
  assert.deepEqual(firstResult, duplicateResult);
  assert.equal(firstResult.actualProviderCalls, 1);
  assert.equal(fixture.provider.calls(), 1, "single-flight spends one mocked request");
  assert.doesNotMatch(JSON.stringify(firstResult), /test-key-never-returned/);
  assert.doesNotMatch(JSON.stringify(firstResult), /中文译文/);

  const snapshot = fixture.storage.snapshot();
  const persistedSource =
    snapshot[fixture.noteSources.STORAGE_KEY][fixture.mediaKey];
  const persistedJob =
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId];
  assert.equal(persistedSource.transcriptZh.length, 2);
  assert.deepEqual(persistedJob.completedUnitKeys, fixture.job.orderedUnitKeys);
  assert.equal(persistedJob.currentBatch, null);
});

test("description chunks use the same background commit path as transcript units", async () => {
  const fixture = makeExportSourceBackground({
    segmentCount: 0,
    descriptionOriginal:
      "This full video description is already present on the page and only needs its reusable Chinese translation.",
  });
  const result = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  assert.equal(result.success, true);
  assert.equal(result.actualProviderCalls, 1);
  const snapshot = fixture.storage.snapshot();
  const persistedSource =
    snapshot[fixture.noteSources.STORAGE_KEY][fixture.mediaKey];
  assert.equal(persistedSource.descriptionZhChunks.length, 1);
  assert.match(persistedSource.descriptionZh, /中文译文/);
});

test("completed job progress cannot override a changed source revision", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 1 });
  const first = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  assert.equal(first.success, true);
  const changedSource = fixture.noteSources.normalizeNoteSource({
    ...fixture.source,
    transcriptOriginal: [
      {
        ...fixture.source.transcriptOriginal[0],
        text: `${fixture.source.transcriptOriginal[0].text} Updated original.`,
      },
    ],
    transcriptZh: [],
  });
  await fixture.storage.set({
    [fixture.noteSources.STORAGE_KEY]: {
      [fixture.mediaKey]: changedSource,
    },
  });
  const repeated = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  assert.equal(repeated.success, false);
  assert.equal(repeated.code, "EXPORT_SOURCE_STALE");
  assert.equal(repeated.actualProviderCalls, 0);
  assert.equal(fixture.provider.calls(), 1);
  const snapshot = fixture.storage.snapshot();
  assert.equal(
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId].state,
    "stale",
  );
});

test("export source translations commit after every batch instead of at round end", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 5 });
  assert.equal(fixture.plan.sourceBatches.length, 2);

  const first = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.actualProviderCalls, 1);
  assert.equal(first.remainingCount, 1);
  let snapshot = fixture.storage.snapshot();
  let persistedSource =
    snapshot[fixture.noteSources.STORAGE_KEY][fixture.mediaKey];
  let persistedJob =
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId];
  assert.equal(persistedSource.transcriptZh.length, 4);
  assert.equal(persistedJob.completedUnitKeys.length, 4);
  assert.equal(persistedJob.currentBatch, null);

  const second = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(1),
  );
  assert.equal(second.success, true);
  assert.equal(second.remainingCount, 0);
  assert.equal(fixture.provider.calls(), 2);
  snapshot = fixture.storage.snapshot();
  persistedSource = snapshot[fixture.noteSources.STORAGE_KEY][fixture.mediaKey];
  persistedJob = snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId];
  assert.equal(persistedSource.transcriptZh.length, 5);
  assert.equal(persistedJob.completedUnitKeys.length, 5);

  const repeated = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(1),
  );
  assert.equal(repeated.success, true);
  assert.equal(repeated.code, "EXPORT_BATCH_ALREADY_COMPLETED");
  assert.equal(repeated.actualProviderCalls, 0);
  assert.equal(fixture.provider.calls(), 2, "completed units are never retranslated");
});

test("reopening from persisted source skips completed units and resumes at the first gap", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 5 });
  const firstRound = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  assert.equal(firstRound.success, true);
  assert.equal(fixture.provider.calls(), 1);

  // Rebuild exclusively from the durable storage snapshot, like reopening the
  // side panel after the service worker and page-local state have disappeared.
  const persisted = await fixture.noteSources.readNoteSource(
    fixture.storage,
    fixture.mediaKey,
  );
  assert.equal(persisted.transcriptZh.length, 4);
  const resumedPlan = fixture.noteSources.buildExportTranslationPlan({
    groups: [
      {
        mediaKey: fixture.mediaKey,
        representative: { videoTitle: persisted.titleOriginal },
        notes: [],
      },
    ],
    sourcesByKey: { [fixture.mediaKey]: persisted },
    mode: "bilingual",
    includeTitles: false,
    includeNotes: false,
    includeDescriptions: true,
    includeTranscript: true,
  });
  const resumedUnits = resumedPlan.sourceBatches.flat();
  assert.equal(resumedUnits.length, 1);
  assert.equal(resumedUnits[0].id, fixture.plan.sourceBatches[1][0].id);
  assert.equal(
    resumedUnits.some((unit) =>
      fixture.plan.sourceBatches[0].some((completed) => completed.id === unit.id),
    ),
    false,
  );

  const resumed = await dispatchBackgroundMessage(fixture.background, {
    action: "translateExportSourceBatch",
    jobId: fixture.job.jobId,
    mediaKey: fixture.mediaKey,
    sourceRevision: persisted.sourceRevision,
    units: resumedUnits.map(publicExportSourceUnit),
    videoTitle: persisted.titleOriginal,
  });
  assert.equal(resumed.success, true);
  assert.equal(resumed.actualProviderCalls, 1);
  assert.equal(fixture.provider.calls(), 2);
  const complete = await fixture.noteSources.readNoteSource(
    fixture.storage,
    fixture.mediaKey,
  );
  assert.equal(complete.transcriptZh.length, 5);
});

test("cancelling an in-flight export batch caches its valid response but starts no next batch", async () => {
  const fixture = makeExportSourceBackground({
    segmentCount: 5,
    holdFirst: true,
  });
  const current = dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  await waitForProviderCall(fixture.provider);
  const cancelled = await dispatchBackgroundMessage(fixture.background, {
    action: "cancelExportTranslationJob",
    jobId: fixture.job.jobId,
  });
  assert.equal(cancelled.success, true);
  assert.equal(cancelled.jobState, "cancelled");

  fixture.provider.releaseFirst();
  const currentResult = await current;
  assert.equal(currentResult.success, true);
  assert.equal(currentResult.code, "EXPORT_CANCELLED_BATCH_COMMITTED");
  assert.equal(currentResult.jobState, "cancelled");

  const later = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(1),
  );
  assert.equal(later.success, false);
  assert.equal(later.code, "EXPORT_JOB_NOT_RUNNING");
  assert.equal(fixture.provider.calls(), 1, "cancellation prevents the next request");

  const snapshot = fixture.storage.snapshot();
  const persistedSource =
    snapshot[fixture.noteSources.STORAGE_KEY][fixture.mediaKey];
  const persistedJob =
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId];
  assert.equal(persistedSource.transcriptZh.length, 4);
  assert.equal(persistedJob.completedUnitKeys.length, 4);
  assert.equal(persistedJob.state, "cancelled");
  assert.equal(persistedJob.exportClaim, null);
});

test("cancellation after batch claim but before fetch starts zero provider calls", async () => {
  const fixture = makeExportSourceBackground({
    segmentCount: 2,
    holdPrompt: true,
  });
  const pending = dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  await waitForPromptGate(fixture.provider);
  const cancelled = await dispatchBackgroundMessage(fixture.background, {
    action: "cancelExportTranslationJob",
    jobId: fixture.job.jobId,
  });
  assert.equal(cancelled.success, true);
  fixture.provider.releasePrompt();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, "EXPORT_JOB_NOT_RUNNING");
  assert.equal(result.actualProviderCalls, 0);
  assert.equal(fixture.provider.calls(), 0);
  const snapshot = fixture.storage.snapshot();
  const persistedJob =
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId];
  assert.equal(persistedJob.state, "cancelled");
  assert.equal(persistedJob.currentBatch, null);
});

test("provider route changes after confirmation fail closed before the request", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 1 });
  await fixture.storage.set({
    ytd_settings: {
      provider: "zhipu",
      aiApiKeys: {
        deepseek: "test-key-never-returned",
        zhipu: "zhipu-test-key-never-returned",
        dashscope: "",
        "tencent-hymt": "",
        siliconflow: "",
        fireworks: "",
      },
      supadataApiKey: "",
    },
  });
  const result = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "EXPORT_JOB_PROVIDER_MISMATCH");
  assert.equal(result.actualProviderCalls, 0);
  assert.equal(fixture.provider.calls(), 0);
  assert.doesNotMatch(JSON.stringify(result), /zhipu-test-key-never-returned/);
  const snapshot = fixture.storage.snapshot();
  const persistedJob =
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId];
  assert.equal(persistedJob.state, "paused");
  assert.equal(persistedJob.currentBatch, null);
  assert.equal(persistedJob.lastError.code, "EXPORT_JOB_PROVIDER_MISMATCH");
});

test("provider error bodies and non-typical secret keys never enter job snapshots", async () => {
  const rawMessage = "provider body credential=RAW_BODY_SECRET_7a91";
  const unusualSecret = "UNUSUAL_SECRET_VALUE_9931";
  const fixture = makeExportSourceBackground({
    segmentCount: 1,
    providerErrorPayload: {
      error: { message: rawMessage },
      "x-vendor-private-credential": unusualSecret,
      nested: { signing_material: "NESTED_SECRET_4432" },
    },
    providerErrorStatus: 500,
  });
  const result = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "EXPORT_SOURCE_PROVIDER_FAILED");
  assert.equal(result.actualProviderCalls, 1);
  const serializedResult = JSON.stringify(result);
  const snapshot = fixture.storage.snapshot();
  const persistedJob =
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId];
  const serializedJob = JSON.stringify(persistedJob);
  for (const secret of [rawMessage, unusualSecret, "NESTED_SECRET_4432"]) {
    assert.doesNotMatch(serializedResult, new RegExp(secret));
    assert.doesNotMatch(serializedJob, new RegExp(secret));
  }
  assert.deepEqual(Object.keys(persistedJob.lastError).sort(), [
    "at",
    "code",
    "message",
    "retryable",
  ]);
  assert.equal(persistedJob.lastError.code, "EXPORT_SOURCE_PROVIDER_FAILED");
});

test("an incomplete provider batch writes nothing and leaves a resumable failed job", async () => {
  const fixture = makeExportSourceBackground({
    segmentCount: 2,
    partialFirst: true,
  });
  const result = await dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "EXPORT_SOURCE_BATCH_PARTIAL");
  assert.equal(result.actualProviderCalls, 1);
  const snapshot = fixture.storage.snapshot();
  const persistedSource =
    snapshot[fixture.noteSources.STORAGE_KEY][fixture.mediaKey];
  const persistedJob =
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId];
  assert.equal(persistedSource.transcriptZh.length, 0);
  assert.equal(persistedJob.state, "failed");
  assert.equal(persistedJob.currentBatch, null);
});

test("clearing notes removes source/job state and a late response cannot recreate it", async () => {
  const fixture = makeExportSourceBackground({
    segmentCount: 2,
    holdFirst: true,
  });
  await fixture.storage.set({
    ytd_notes: [
      {
        id: "note-clear-1",
        mediaKey: fixture.mediaKey,
        videoId: fixture.mediaKey,
        text: "Saved note",
      },
    ],
  });
  const pending = dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  await waitForProviderCall(fixture.provider);
  const cleared = await dispatchBackgroundMessage(fixture.background, {
    action: "clearAllNotes",
  });
  assert.equal(cleared.success, true);
  fixture.provider.releaseFirst();
  const late = await pending;
  assert.equal(late.success, false);
  assert.equal(late.code, "EXPORT_JOB_NOT_FOUND");
  assert.equal(late.actualProviderCalls, 1);
  await nextTurn();
  const snapshot = fixture.storage.snapshot();
  assert.equal(Object.hasOwn(snapshot, "ytd_notes"), false);
  assert.equal(Object.hasOwn(snapshot, fixture.noteSources.STORAGE_KEY), false);
  assert.equal(Object.hasOwn(snapshot, fixture.exportJobs.STORAGE_KEY), false);
});

test("clearAllNotes generation barrier rejects a concurrent source upsert without resurrection", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 1 });
  const gate = createAsyncGate();
  let holdNotesRead = true;
  const storage = createMemoryStorage({
    ytd_settings: {
      provider: "deepseek",
      aiApiKey: "test-key-never-returned",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
    },
    ytd_notes: [
      {
        id: "clear-race-note",
        mediaKey: fixture.mediaKey,
        videoId: fixture.mediaKey,
        text: "Saved note",
      },
    ],
    [fixture.noteSources.STORAGE_KEY]: {
      [fixture.mediaKey]: fixture.source,
    },
    [fixture.exportJobs.STORAGE_KEY]: {
      schemaVersion: fixture.exportJobs.SCHEMA_VERSION,
      jobs: { [fixture.job.jobId]: fixture.job },
    },
  });
  const background = loadBackgroundHelpers({
    storageGetImpl: async (keys) => {
      if (keys === "ytd_notes" && holdNotesRead) {
        holdNotesRead = false;
        await gate.enter();
      }
      return storage.get(keys);
    },
    storageSetImpl: storage.set,
    storageRemoveImpl: storage.remove,
    storageClearImpl: storage.clear,
    noteSourcesImpl: createNoteSourcesBridge(fixture.noteSources),
    exportJobsImpl: createExportJobsBridge(fixture.exportJobs),
  });
  const incoming = fixture.noteSources.normalizeNoteSource({
    ...fixture.source,
    channelName: "must never return after clear",
    updatedAt: 80,
  });
  const pendingUpsert = dispatchBackgroundMessage(background, {
    action: "upsertNoteSource",
    source: incoming,
  });
  await gate.entered;
  const cleared = await dispatchBackgroundMessage(background, {
    action: "clearAllNotes",
  });
  assert.equal(cleared.success, true);
  gate.release();
  const late = await pendingUpsert;
  assert.equal(late.success, false);
  assert.equal(late.code, "EXPORT_JOB_NOT_FOUND");
  const snapshot = storage.snapshot();
  assert.equal(Object.hasOwn(snapshot, "ytd_notes"), false);
  assert.equal(Object.hasOwn(snapshot, fixture.noteSources.STORAGE_KEY), false);
  assert.equal(Object.hasOwn(snapshot, fixture.exportJobs.STORAGE_KEY), false);
});

test("reset generation barrier rejects a concurrent job create without resurrection", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 1 });
  const gate = createAsyncGate();
  const storage = createMemoryStorage({
    ytd_settings: {
      provider: "deepseek",
      aiApiKey: "test-key-never-returned",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
    },
    ytd_notes: [],
    [fixture.noteSources.STORAGE_KEY]: {
      [fixture.mediaKey]: fixture.source,
    },
    [fixture.exportJobs.STORAGE_KEY]: {
      schemaVersion: fixture.exportJobs.SCHEMA_VERSION,
      jobs: { [fixture.job.jobId]: fixture.job },
    },
  });
  const exportJobsBridge = createExportJobsBridge(fixture.exportJobs);
  let holdJobRead = true;
  const baseReadExportJob = exportJobsBridge.readExportJob;
  exportJobsBridge.readExportJob = async (adapter, jobId) => {
    if (holdJobRead) {
      holdJobRead = false;
      await gate.enter();
    }
    return baseReadExportJob(adapter, jobId);
  };
  const background = loadBackgroundHelpers({
    storageGetImpl: storage.get,
    storageSetImpl: storage.set,
    storageRemoveImpl: storage.remove,
    storageClearImpl: storage.clear,
    noteSourcesImpl: createNoteSourcesBridge(fixture.noteSources),
    exportJobsImpl: exportJobsBridge,
  });
  const pendingCreate = dispatchBackgroundMessage(background, {
    action: "createOrResumeExportJob",
    job: fixture.job,
  });
  await gate.entered;
  const reset = await dispatchBackgroundMessage(background, {
    action: "resetAllExtensionData",
    preferredLanguage: "zh-CN",
  });
  assert.equal(reset.success, true);
  gate.release();
  const late = await pendingCreate;
  assert.equal(late.success, false);
  assert.equal(late.code, "EXPORT_JOB_NOT_FOUND");
  assert.deepEqual(storage.snapshot(), { ytd_options_language: "zh-CN" });
});

test("clearAllNotes is all-or-nothing when either export store has a future schema", async () => {
  const noteSources = require("../note-sources.js");
  const exportJobs = require("../export-jobs.js");
  const cases = [
    {
      label: "future jobs",
      sources: {},
      jobs: { schemaVersion: exportJobs.SCHEMA_VERSION + 1, jobs: {} },
      expectedCode: "UNSUPPORTED_EXPORT_JOBS_SCHEMA",
    },
    {
      label: "future sources",
      sources: { schemaVersion: noteSources.SCHEMA_VERSION + 1 },
      jobs: { schemaVersion: exportJobs.SCHEMA_VERSION, jobs: {} },
      expectedCode: "UNSUPPORTED_NOTE_SOURCE_SCHEMA",
    },
  ];
  for (const item of cases) {
    const initial = {
      ytd_settings: {
        provider: "deepseek",
        aiApiKey: "test-key-never-returned",
      },
      ytd_notes: [{ id: `note-${item.label}`, text: "must survive" }],
      [noteSources.STORAGE_KEY]: item.sources,
      [exportJobs.STORAGE_KEY]: item.jobs,
    };
    const storage = createMemoryStorage(initial);
    const background = loadBackgroundHelpers({
      storageGetImpl: storage.get,
      storageSetImpl: storage.set,
      storageRemoveImpl: storage.remove,
      storageClearImpl: storage.clear,
      noteSourcesImpl: createNoteSourcesBridge(noteSources),
      exportJobsImpl: createExportJobsBridge(exportJobs),
    });
    const result = await dispatchBackgroundMessage(background, {
      action: "clearAllNotes",
    });
    assert.equal(result.success, false, item.label);
    assert.equal(result.code, item.expectedCode, item.label);
    assert.deepEqual(storage.snapshot(), initial, item.label);
  }
});

test("note source writes are available through the shared background queue action", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 1 });
  const incoming = fixture.noteSources.normalizeNoteSource({
    ...fixture.source,
    channelName: "Background-owned source queue",
    updatedAt: 40,
  });
  const result = await dispatchBackgroundMessage(fixture.background, {
    action: "upsertNoteSource",
    source: incoming,
  });
  assert.equal(result.success, true);
  assert.equal(result.mediaKey, fixture.mediaKey);
  assert.equal(result.sourceRevision, incoming.sourceRevision);
  const snapshot = fixture.storage.snapshot();
  assert.equal(
    snapshot[fixture.noteSources.STORAGE_KEY][fixture.mediaKey].channelName,
    "Background-owned source queue",
  );
});

test("export job create/resume and checkpoint mutations stay in the background realm", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 1 });
  const paused = await dispatchBackgroundMessage(fixture.background, {
    action: "checkpointExportJob",
    jobId: fixture.job.jobId,
    patch: { state: "paused", currentBatch: null },
  });
  assert.equal(paused.success, true);
  assert.equal(paused.job.state, "paused");

  const resumed = await dispatchBackgroundMessage(fixture.background, {
    action: "createOrResumeExportJob",
    job: {
      ...fixture.job,
      state: "running",
      updatedAt: Date.now() + 1000,
    },
  });
  assert.equal(resumed.success, true);
  assert.equal(resumed.job.state, "running");
  assert.doesNotMatch(JSON.stringify(resumed), /test-key-never-returned/);

  const rejected = await dispatchBackgroundMessage(fixture.background, {
    action: "checkpointExportJob",
    jobId: fixture.job.jobId,
    patch: { sourceText: "must never enter job metadata" },
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, "INVALID_EXPORT_JOB_PATCH");
});

test("recoverable export jobs can be listed without exposing provider keys or content", async () => {
  const fixture = makeExportNotesBackground();
  const result = await fixture.background.handleListExportTranslationJobs();
  assert.equal(result.success, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].jobId, fixture.job.jobId);
  const serialized = JSON.stringify(result.jobs);
  assert.doesNotMatch(serialized, /test-key|Canonical stored English note body/);
  assert.deepEqual(result.jobs[0].intent.mediaKeys, [fixture.mediaKey]);
});

test("duplicate create or resume preserves a running job's current batch lease", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 1 });
  const currentBatch = {
    batchId: "active-batch-lease",
    unitKeys: [...fixture.job.orderedUnitKeys],
    leaseUntil: Date.now() + 60_000,
  };
  const claimed = await dispatchBackgroundMessage(fixture.background, {
    action: "checkpointExportJob",
    jobId: fixture.job.jobId,
    patch: { currentBatch },
  });
  assert.equal(claimed.success, true);
  assert.deepEqual(clonePlain(claimed.job.currentBatch), currentBatch);

  const duplicate = await dispatchBackgroundMessage(fixture.background, {
    action: "createOrResumeExportJob",
    job: {
      ...fixture.job,
      state: "running",
      currentBatch: null,
      updatedAt: Date.now() + 120_000,
    },
  });
  assert.equal(duplicate.success, true);
  assert.deepEqual(clonePlain(duplicate.job.currentBatch), currentBatch);
  const snapshot = fixture.storage.snapshot();
  assert.deepEqual(
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId].currentBatch,
    currentBatch,
  );
});

test("job-aware note and title batches use canonical storage and persist validated translations", async () => {
  const fixture = makeExportNotesBackground();
  const noteResult = await dispatchBackgroundMessage(fixture.background, {
    action: "translateExportNotesBatch",
    jobId: fixture.job.jobId,
    unitKeys: [fixture.noteUnitKey],
    notes: [
      {
        id: fixture.note.id,
        text: "SPOOFED CALLER NOTE MUST NOT REACH PROVIDER",
        videoTitle: "Spoofed caller title",
      },
    ],
    titles: [],
  });
  assert.equal(noteResult.success, true, JSON.stringify(noteResult));
  assert.equal(noteResult.translations[0].textZh, "持久保存的中文笔记。");
  assert.equal(fixture.providerCalls(), 1);
  assert.match(
    JSON.stringify(fixture.providerInputs[0]),
    /Canonical stored English note body/,
  );
  assert.doesNotMatch(JSON.stringify(fixture.providerInputs[0]), /SPOOFED CALLER/);

  const titleResult = await dispatchBackgroundMessage(fixture.background, {
    action: "translateExportNotesBatch",
    jobId: fixture.job.jobId,
    unitKeys: [fixture.titleUnitKey],
    notes: [],
    titles: [
      {
        mediaKey: fixture.mediaKey,
        title: "SPOOFED CALLER TITLE MUST NOT REACH PROVIDER",
      },
    ],
  });
  assert.equal(titleResult.success, true, JSON.stringify(titleResult));
  assert.equal(titleResult.titles[0].titleZh, "持久保存的中文标题");
  assert.equal(fixture.providerCalls(), 2);
  assert.match(
    JSON.stringify(fixture.providerInputs[1]),
    /Canonical Stored Video Title/,
  );
  assert.doesNotMatch(JSON.stringify(fixture.providerInputs[1]), /SPOOFED CALLER/);

  const persisted = fixture.storage.snapshot().ytd_notes[0];
  assert.equal(persisted.translatedText, "持久保存的中文笔记。");
  assert.equal(persisted.translatedValidated, true);
  assert.equal(persisted.videoTitleZh, "持久保存的中文标题");
  assert.equal(persisted.videoTitleZhValidated, true);
  assert.equal(
    persisted.videoTitleZhSourceHash,
    fixture.noteSources.hashSourceText("Canonical Stored Video Title"),
  );
});

test("job-aware note translation rechecks the frozen route before provider fetch", async () => {
  const fixture = makeExportNotesBackground({
    switchProviderBeforeFetch: true,
  });
  const result = await dispatchBackgroundMessage(fixture.background, {
    action: "translateExportNotesBatch",
    jobId: fixture.job.jobId,
    unitKeys: [fixture.noteUnitKey],
    notes: [{ id: fixture.note.id, text: fixture.note.text }],
    titles: [],
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "EXPORT_JOB_PROVIDER_MISMATCH");
  assert.equal(fixture.providerCalls(), 0);
  const persistedJob =
    fixture.storage.snapshot()[fixture.exportJobs.STORAGE_KEY].jobs[
      fixture.job.jobId
    ];
  const serializedJob = JSON.stringify(persistedJob);
  assert.doesNotMatch(serializedJob, /deepseek-test-key-never-returned/);
  assert.doesNotMatch(serializedJob, /zhipu-test-key-never-returned/);
  assert.doesNotMatch(serializedJob, /Canonical stored English note body/);
});

test("a late export response writes nothing after the source revision changes", async () => {
  const fixture = makeExportSourceBackground({
    segmentCount: 2,
    holdFirst: true,
  });
  const pending = dispatchBackgroundMessage(
    fixture.background,
    fixture.messageForBatch(0),
  );
  await waitForProviderCall(fixture.provider);

  const changedSource = fixture.noteSources.normalizeNoteSource({
    ...fixture.source,
    transcriptOriginal: fixture.source.transcriptOriginal.map((entry, index) =>
      index === 0
        ? { ...entry, text: `${entry.text} The original source changed.` }
        : entry,
    ),
    transcriptZh: [],
    updatedAt: 30,
  });
  assert.notEqual(changedSource.sourceRevision, fixture.source.sourceRevision);
  await fixture.storage.set({
    [fixture.noteSources.STORAGE_KEY]: {
      [fixture.mediaKey]: changedSource,
    },
  });

  fixture.provider.releaseFirst();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, "EXPORT_SOURCE_STALE");
  assert.equal(result.actualProviderCalls, 1);
  await nextTurn();
  const snapshot = fixture.storage.snapshot();
  const persistedSource =
    snapshot[fixture.noteSources.STORAGE_KEY][fixture.mediaKey];
  const persistedJob =
    snapshot[fixture.exportJobs.STORAGE_KEY].jobs[fixture.job.jobId];
  assert.equal(persistedSource.sourceRevision, changedSource.sourceRevision);
  assert.equal(persistedSource.transcriptZh.length, 0);
  assert.equal(persistedJob.completedUnitKeys.length, 0);
  assert.equal(persistedJob.state, "stale");
  assert.equal(persistedJob.currentBatch, null);
});

test("export source action enforces four-unit and 12000-character hard limits", () => {
  const fixture = makeExportSourceBackground({ segmentCount: 1 });
  const base = fixture.messageForBatch(0);
  const makeUnit = (index, text = base.units[0].text) => ({
    ...base.units[0],
    unitKey: `t:fnv1a-0000000000000001:${index}:fnv1a-0000000000000002`,
    segmentId: `bounded-${index}`,
    start: index + 0.25,
    text,
  });
  assert.throws(
    () =>
      fixture.background.validateExportSourceBatchRequest({
        ...base,
        units: Array.from({ length: 5 }, (_, index) => makeUnit(index)),
      }),
    (error) => error.code === "INVALID_EXPORT_SOURCE_BATCH",
  );
  assert.throws(
    () =>
      fixture.background.validateExportSourceBatchRequest({
        ...base,
        units: Array.from({ length: 4 }, (_, index) =>
          makeUnit(index, "a".repeat(3001)),
        ),
      }),
    (error) => error.code === "INVALID_EXPORT_SOURCE_BATCH",
  );
});

test("export source action rejects supplied credentials before any provider request", async () => {
  const fixture = makeExportSourceBackground({ segmentCount: 1 });
  const config = await dispatchBackgroundMessage(fixture.background, {
    action: "checkConfig",
  });
  assert.equal(config.provider.modelId, "deepseek-v4-flash");
  assert.equal(config.provider.routeKey, "deepseek:deepseek-v4-flash");
  assert.doesNotMatch(JSON.stringify(config), /test-key-never-returned/);
  const result = await dispatchBackgroundMessage(fixture.background, {
    ...fixture.messageForBatch(0),
    ["api" + "Key"]: "must-not-be-accepted",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "INVALID_EXPORT_SOURCE_BATCH");
  assert.equal(result.actualProviderCalls, 0);
  assert.equal(fixture.provider.calls(), 0);
  assert.doesNotMatch(JSON.stringify(result), /must-not-be-accepted/);
});

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
      ) => {
        const resolvedMediaRef = mediaRef || {
          platform: "youtube",
          videoId,
          mediaKey: videoId,
          routeKey: routeKey || "youtube:" + videoId,
        };
        const resolvedRouteKey = routeKey;
        const transcriptText = "transcript-" + videoId;
        const transcriptTimestamped = "timestamped-" + videoId;
        const transcriptSource =
          resolvedMediaRef.platform === "bilibili" ? "bilibili" : "supadata";
        const transcriptFingerprint = transcriptContentFingerprint(
          transcriptTimestamped,
          transcriptText,
        );
        return {
        analysis: {
          marker: videoId,
          schemaVersion: 3,
          timestampAnchorVersion: 1,
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
        transcriptText,
        transcriptTimestamped,
        transcriptLanguage: sourceLanguage,
        transcriptSource,
        transcriptSourceAttempt: transcriptSource === "bilibili" ? "BILIBILI" : "SUPADATA",
        transcriptSelectedTrack: null,
        transcriptSelectedTrackIdentity: "none",
        transcriptRequestedLanguage: sourceLanguage,
        transcriptRequestedTrackKind: YOUTUBE_TRANSCRIPT_TRACK_KIND,
        transcriptFingerprint,
        transcriptArtifactIdentity: transcriptArtifactIdentity({
          source: transcriptSource,
          language: sourceLanguage,
          requestedLanguage: sourceLanguage,
          selectedTrack: null,
          fingerprint: transcriptFingerprint,
        }),
        transcriptSourcePolicyVersion: TRANSCRIPT_SOURCE_POLICY_VERSION,
        mediaRef: resolvedMediaRef,
        routeKey: resolvedRouteKey,
        timestamp: Date.now(),
        };
      };

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
        videoSourceLanguage: () => currentVideoSourceLanguage || null,
      };
    })()
  `);
}

/**
 * Exercises saved-note navigation through the real side-panel entry points.
 * The fixture intentionally does not inspect the implementation's pending
 * intent object: it observes only browser navigation, background messages and
 * visible panel state so the regression contract stays implementation-agnostic.
 */
function installNoteNavigationFixture(runtime, options = {}) {
  const targetPlatform =
    options.targetPlatform === "bilibili" ? "bilibili" : "youtube";
  const targetVideoId = String(
    options.targetVideoId ||
      (targetPlatform === "bilibili" ? "BV1e3411j7ZM" : "target-video"),
  );
  const targetMediaKey = String(
    options.targetMediaKey ||
      (targetPlatform === "bilibili"
        ? `bilibili:${targetVideoId}:200`
        : targetVideoId),
  );
  const targetUrl = String(
    options.targetUrl ||
      (targetPlatform === "bilibili"
        ? `https://www.bilibili.com/video/${targetVideoId}/?p=2&t=56`
        : `https://www.youtube.com/watch?v=${targetVideoId}&t=56s`),
  );
  const fixtureOptions = JSON.stringify({
    targetPlatform,
    targetVideoId,
    targetMediaKey,
    targetUrl,
    hasAiKey: options.hasAiKey !== false,
    hasSupadataKey: options.hasSupadataKey !== false,
    authorizedTranscriptSuccess: options.authorizedTranscriptSuccess === true,
    cachedTranscript: options.cachedTranscript === true,
    authorizedError: String(options.authorizedError || ""),
    omitMetadataVideoId: options.omitMetadataVideoId === true,
    metadataVideoId:
      options.metadataVideoId === undefined
        ? null
        : String(options.metadataVideoId),
    metadataTitle: String(options.metadataTitle || "Target video"),
    metadataRelayFailure: options.metadataRelayFailure || null,
    deferMetadataRelay: options.deferMetadataRelay === true,
  });
  return runtime.evaluate(`
    (() => {
      const fixtureOptions = ${fixtureOptions};
      const sourceVideoId = "source-video";
      const targetPlatform = fixtureOptions.targetPlatform;
      const targetVideoId = fixtureOptions.targetVideoId;
      const targetMediaKey = fixtureOptions.targetMediaKey;
      const targetUrl = fixtureOptions.targetUrl;
      const targetLocator = extractMediaLocator(targetUrl);
      const targetRouteKey = targetLocator.routeKey;
      const messages = [];
      const openedUrls = [];
      const createdTabs = [];
      const updatedTabs = [];
      const renderedNotes = [];
      let noteExportDownloads = 0;
      const elements = new Map();
      let panelClosed = false;
      let activeUrlValue =
        "https://www.youtube.com/watch?v=" + sourceVideoId;
      let activeTabId = 101;
      let nextCreatedTabId = 202;
      const createdTabById = new Map();
      let releaseMetadataRelay = null;
      let resolveMetadataRelayStarted = null;
      let metadataRelayBlocked = fixtureOptions.deferMetadataRelay;
      const metadataRelayStarted = new Promise((resolve) => {
        resolveMetadataRelayStarted = resolve;
      });

      const element = (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            id,
            style: { display: id === "resultsState" ? "block" : "none" },
            hidden: false,
            innerHTML: "",
            textContent: "",
            disabled: false,
            classList: {
              toggle() {},
              add() {},
              remove() {},
              contains() { return false; },
            },
            setAttribute() {},
            addEventListener() {},
            removeEventListener() {},
            focus() {},
          });
        }
        return elements.get(id);
      };

      const tabElements = ["transcript", "overview", "notes"].map((name) => {
        const entry = {
          dataset: { tab: name },
          active: name === "notes",
          classList: {
            toggle(className, force) {
              if (className === "active") entry.active = Boolean(force);
            },
          },
        };
        return entry;
      });
      const panelElements = ["transcript", "overview", "notes"].map((name) => ({
        dataset: { panel: name },
        classList: { toggle() {} },
      }));

      document.getElementById = element;
      document.querySelectorAll = (selector) => {
        if (selector === ".tab") return tabElements;
        if (selector === ".tab-panel") return panelElements;
        return [];
      };
      document.querySelector = (selector) => {
        if (selector === ".tab.active") {
          return tabElements.find((entry) => entry.active) || null;
        }
        return null;
      };
      window.close = () => {
        panelClosed = true;
      };

      renderNotes = (notes, filterVideoId) => {
        renderedNotes.push({
          filterVideoId: filterVideoId === undefined ? "undefined" : filterVideoId,
          ids: notes.map((note) => note.id),
        });
      };
      renderTranscript = () => {};
      renderAnalysisResults = () => {};
      highlightMomentsOnPage = () => {};
      downloadTextFile = () => { noteExportDownloads += 1; };
      setupExplainFeature = () => {};
      translateTranscript = () => {};
      loadFromCache = async (videoId) => {
        if (!fixtureOptions.cachedTranscript || videoId !== targetMediaKey) {
          return null;
        }
        return {
          analysis: null,
          analysisVideoId: targetMediaKey,
          transcript: [{ start: 0, text: "Cached target transcript" }],
          transcriptText: "Cached target transcript",
          transcriptTimestamped: "[0:00] Cached target transcript",
          transcriptLanguage: "en",
          transcriptSource: "supadata",
          transcriptSourceAttempt: "SUPADATA",
          routeKey: targetRouteKey,
          mediaRef: {
            ...targetLocator,
            platform: targetPlatform,
            mediaKey: targetMediaKey,
          },
          timestamp: Date.now(),
        };
      };
      saveToCache = async () => {};

      const targetNote = {
        id: "target-note",
        platform: targetPlatform,
        mediaKey: targetMediaKey,
        videoId: targetPlatform === "bilibili" ? targetMediaKey : targetVideoId,
        videoTitle: "Target video",
        videoTitleZh: "目标视频",
        videoTitleZhValidated: true,
        videoTitleZhValidationVersion: 1,
        channelName: "Target channel",
        timestamp: "0:56",
        timestampSeconds: 56,
        canonicalUrl: targetLocator.canonicalUrl,
        timestampedUrl: targetUrl,
        text: "Saved English note.",
        rawText: "Saved English note.",
        translatedText: "已保存的中文笔记。",
        translatedValidated: true,
        translatedValidationVersion: 1,
        sourceLanguage: targetPlatform === "bilibili" ? "zh-CN" : "en",
      };

      const activeTab = () => ({
        id: activeTabId,
        active: true,
        windowId: 1,
        url: activeUrlValue,
      });
      chrome.tabs.create = async ({ url, active = true }) => {
        openedUrls.push(url);
        const parsed = extractMediaLocator(url);
        const created = {
          id: nextCreatedTabId++,
          active: active !== false,
          windowId: 1,
          pendingUrl: url,
          url,
          routeKey: parsed?.routeKey || "",
        };
        createdTabById.set(created.id, created);
        createdTabs.push({ id: created.id, active: created.active, url });
        if (created.active) {
          activeTabId = created.id;
          activeUrlValue = created.url;
        }
        return { ...created };
      };
      chrome.tabs.update = async (tabId, changes) => {
        const created = createdTabById.get(tabId);
        if (!created) throw new Error("Unknown created tab: " + tabId);
        Object.assign(created, changes);
        updatedTabs.push({ tabId, ...changes });
        if (changes.active === true) {
          activeTabId = tabId;
          activeUrlValue = created.url;
        }
        return { ...created };
      };
      chrome.tabs.query = async () => [activeTab()];
      chrome.tabs.get = async () => activeTab();
      chrome.tabs.sendMessage = async (tabId, payload) => {
        messages.push({ action: "tabs.sendMessage", tabId, payload });
        return { success: true };
      };
      chrome.runtime.sendMessage = async (message) => {
        messages.push(JSON.parse(JSON.stringify(message)));
        if (message.action === "relayToContent") {
          if (message.payload?.action === "seekTo") {
            return { success: true, response: { success: true } };
          }
          if (fixtureOptions.metadataRelayFailure) {
            return { ...fixtureOptions.metadataRelayFailure };
          }
          const activeLocator = extractMediaLocator(activeUrlValue);
          const metadataResponse = {
            success: true,
            response: {
              ...(fixtureOptions.omitMetadataVideoId
                ? {}
                : {
                    videoId:
                      fixtureOptions.metadataVideoId ??
                      activeLocator?.videoId ??
                      "",
                  }),
              title: activeLocator?.routeKey === targetRouteKey
                ? fixtureOptions.metadataTitle
                : "Unrelated video",
              channelName: "Target channel",
              description: "Video description",
              descriptionStatus: "present",
              duration: 1800,
              sourceLanguage: "en",
            },
          };
          if (metadataRelayBlocked) {
            metadataRelayBlocked = false;
            resolveMetadataRelayStarted?.();
            await new Promise((resolve) => {
              releaseMetadataRelay = resolve;
            });
          }
          return metadataResponse;
        }
        if (message.action === "resolveBilibiliMedia") {
          return {
            success: true,
            mediaRef: {
              ...targetLocator,
              platform: "bilibili",
              bvid: targetVideoId,
              page: 2,
              cid: 200,
              mediaKey: targetMediaKey,
              title: "Target video",
              channelName: "Target channel",
              description: "Video description",
              descriptionStatus: "present",
              duration: 1800,
            },
          };
        }
        if (message.action === "getNotes") {
          return { success: true, notes: [targetNote] };
        }
        if (message.action === "upsertNoteSource") {
          await YTD_NOTE_SOURCES.writeNoteSource(
            chrome.storage.local,
            message.source,
          );
          const persisted = await YTD_NOTE_SOURCES.readNoteSource(
            chrome.storage.local,
            message.source.mediaKey,
          );
          return { success: true, source: persisted };
        }
        if (message.action === "fetchTranscript") {
          if (
            message.supadataConsent === true &&
            fixtureOptions.authorizedTranscriptSuccess
          ) {
            return {
              success: true,
              routeOutcome: "HAVE_TRANSCRIPT",
              runId: message.runId,
              routeKey: message.routeKey,
              source: "supadata",
              sourceAttempt: "SUPADATA",
              selectedTrack: null,
              transcript: [
                {
                  text: "Authorized target transcript",
                  start: 0,
                  duration: 2,
                  language: "en",
                },
              ],
              transcriptText: "Authorized target transcript",
              transcriptTextTimestamped: "[0:00] Authorized target transcript",
              language: "en",
            };
          }
          if (message.supadataConsent === true && fixtureOptions.authorizedError) {
            return {
              success: false,
              error: fixtureOptions.authorizedError,
              message: "Authorized provider failed.",
              routeOutcome: "UNKNOWN",
              runId: message.runId,
              routeKey: message.routeKey,
            };
          }
          if (message.captionRetry !== true) {
            return {
              success: false,
              error: "YOUTUBE_CAPTIONS_REQUIRED",
              message: "Enable YouTube captions and retry.",
              routeOutcome: "UNKNOWN",
              requiresCaptionEnable: true,
              supadataEligible: false,
              hasSupadataKey: fixtureOptions.hasSupadataKey,
              runId: message.runId,
              routeKey: message.routeKey,
            };
          }
          return {
            success: false,
            error: "NATIVE_TRANSCRIPT_UNKNOWN",
            message: "The free transcript routes did not produce a transcript.",
            routeOutcome: "UNKNOWN",
            hasSupadataKey: fixtureOptions.hasSupadataKey,
            runId: message.runId,
            routeKey: message.routeKey,
          };
        }
        if (message.action === "cancelExportTranslationJob") {
          return { success: true };
        }
        return { success: true };
      };

      currentConfigStatus = {
        hasAiKey: fixtureOptions.hasAiKey,
        hasSupadataKey: fixtureOptions.hasSupadataKey,
      };
      currentVideoId = sourceVideoId;
      currentVideoUrl =
        "https://www.youtube.com/watch?v=" + sourceVideoId;
      currentMediaRef = {
        platform: "youtube",
        videoId: sourceVideoId,
        mediaKey: sourceVideoId,
        routeKey: "youtube:" + sourceVideoId,
      };
      currentRouteKey = "youtube:" + sourceVideoId;
      currentVideoTitle = "Source video";
      currentChannelName = "Source channel";
      currentVideoDescription = "Source description";
      currentVideoDescriptionState = "present";
      currentVideoDuration = 1200;
      currentVideoSourceLanguage = "en";
      currentTranscript = [{ start: 0, text: "Source transcript" }];
      currentTranscriptText = "Source transcript";
      currentTranscriptTimestamped = "[0:00] Source transcript";
      currentTranscriptLanguage = "en";
      videoTabId = 101;
      notesFilterShowAll = true;
      currentNotesFilterVideoId = null;
      showState("results");
      setNotesFilter(true);

      const fetchCount = () =>
        messages.filter((message) => message.action === "fetchTranscript").length;
      const noteLoadMessages = () =>
        messages.filter((message) => message.action === "getNotes");
      return {
        targetVideoId,
        targetMediaKey,
        targetRouteKey,
        targetUrl,
        playTarget: () => playNote(targetNote),
        playTargetForSupplement: () =>
          playNote(targetNote, { captureMetadata: true }),
        playTargetForCompleteExport: async () => {
          currentNotesMode = "original";
          const exportContinuation = createNoteExportContinuation([
            targetMediaKey,
          ]);
          const groups = [
            {
              mediaKey: targetMediaKey,
              representative: targetNote,
              notes: [targetNote],
            },
          ];
          const sourcesByKey = {};
          const precheck = buildNotesExportPrecheck(
            groups,
            sourcesByKey,
            currentNotesMode,
          );
          await grantNoteExportAuthorization(exportContinuation, {
            groups,
            sourcesByKey,
            precheck,
          });
          return playNote(targetNote, {
            captureMetadata: true,
            exportContinuation,
          });
        },
        inspectActive: () => checkCurrentTab(),
        waitForMetadataRelay: () => metadataRelayStarted,
        releaseMetadataRelay: () => {
          const release = releaseMetadataRelay;
          releaseMetadataRelay = null;
          release?.();
        },
        openTranscript: () => switchTab("transcript"),
        clickConsentPrimary: () => errorAction?.(),
        clickConsentSecondary: () => errorSecondaryAction?.(),
        navigateFront: (url) => handleFrontTabUrl(url),
        setActiveVideo: (videoId) => {
          activeUrlValue =
            "https://www.youtube.com/watch?v=" + videoId +
            (videoId === targetVideoId ? "&t=56s" : "");
          activeTabId += 1;
        },
        setActiveTab: (url, tabId) => {
          activeUrlValue = url;
          activeTabId = tabId;
        },
        setHasAiKey: (value) => {
          currentConfigStatus = { hasAiKey: value === true };
        },
        setCurrentVideo: (videoId) => {
          currentVideoId = videoId;
          currentRouteKey = "youtube:" + videoId;
          currentMediaRef = {
            platform: "youtube",
            videoId,
            mediaKey: videoId,
            routeKey: currentRouteKey,
          };
          videoTabId = activeTabId;
        },
        snapshot: () => JSON.stringify({
          activeTab: tabElements.find((entry) => entry.active)?.dataset.tab || null,
          currentVideoId,
          currentRouteKey,
          videoTabId,
          currentMediaRef: currentMediaRef
            ? {
                platform: currentMediaRef.platform,
                mediaKey: currentMediaRef.mediaKey,
                bvid: currentMediaRef.bvid || "",
                cid: currentMediaRef.cid || 0,
                page: currentMediaRef.page || 0,
              }
            : null,
          notesFilterShowAll,
          currentNotesFilterVideoId:
            currentNotesFilterVideoId === undefined
              ? "undefined"
              : currentNotesFilterVideoId,
          resultsVisible: element("resultsState").style.display !== "none",
          errorVisible: element("errorState").style.display !== "none",
          panelClosed,
          errorTitle: element("errorTitle").textContent,
          errorSecondaryText: element("errorSecondaryBtn").textContent,
          errorSecondaryHidden: element("errorSecondaryBtn").hidden,
          noteExportStatus: element("notesExportStatus").textContent,
          fetchCount: fetchCount(),
          noteExportDownloads,
          metadataRelayCount: messages.filter(
            (message) =>
              message.action === "relayToContent" &&
              message.payload?.action === "getVideoInfo",
          ).length,
          bilibiliResolveCount: messages.filter(
            (message) => message.action === "resolveBilibiliMedia",
          ).length,
          upsertCount: messages.filter(
            (message) => message.action === "upsertNoteSource",
          ).length,
          supadataConsents: messages
            .filter((message) => message.action === "fetchTranscript")
            .map((message) => message.supadataConsent),
          captionRetries: messages
            .filter((message) => message.action === "fetchTranscript")
            .map((message) => message.captionRetry),
          currentTranscriptText,
          noteLoadCount: noteLoadMessages().length,
          noteLoadVideoIds: noteLoadMessages().map((message) =>
            message.videoId === undefined ? "undefined" : message.videoId),
          openedUrls,
          createdTabs,
          updatedTabs,
          sessionKeys: Object.keys(
            chrome.storage.session.snapshot?.() || {},
          ).sort(),
          sessionPhase:
            Object.values(chrome.storage.session.snapshot?.() || {})[0]?.phase || "",
          sessionCaptureMetadata:
            Object.values(chrome.storage.session.snapshot?.() || {})[0]
              ?.captureMetadata === true,
          backgroundActions: messages.map((message) => message.action),
          renderedNotes,
          tabSeekCount: messages.filter(
            (message) => message.action === "tabs.sendMessage",
          ).length,
          tabSeekTabIds: messages
            .filter((message) => message.action === "tabs.sendMessage")
            .map((message) => message.tabId),
          runtimeSeekCount: messages.filter(
            (message) =>
              message.action === "relayToContent" &&
              message.payload?.action === "seekTo",
          ).length,
        }),
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
  assert.match(
    html,
    /id="followPlaybackBar"[\s\S]*?id="followPlaybackHint"[\s\S]*?静置 5 秒后回到字幕[\s\S]*?id="followStayBtn"[\s\S]*?留在这里[\s\S]*?id="followPlaybackBtn"[\s\S]*?aria-label="立即跟随视频并回到当前播放位置"[\s\S]*?>[\s\S]*?立即跟随[\s\S]*?<\/button>/,
  );
  assert.doesNotMatch(html, /followPlaybackTime|回到 <span class="follow-time"/);
  assert.match(css, /\.header-actions\s*\{[\s\S]*?display:\s*flex/);
  assert.match(css, /--accent-gradient:\s*linear-gradient\(/);
  assert.match(
    css,
    /\.follow-playback-btn\s*\{[^}]*background:\s*var\(--accent-gradient\)[^}]*color:\s*#fff/,
  );
  assert.match(
    css,
    /\.follow-playback-btn:hover\s*\{[^}]*background:\s*var\(--accent-gradient-hover\)/,
  );
  assert.match(css, /\.follow-playback-bar\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.follow-stay-btn\s*\{/);
  assert.doesNotMatch(css, /\.follow-playback-btn::before/);
  assert.match(
    css,
    /\.icon-btn\.primary\s*\{[^}]*background:\s*var\(--accent-icon-gradient\)/,
  );
  assert.match(css, /\.language-mode-control\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(
    js,
    /function updateHeaderLanguageControlsVisibility\(\)[\s\S]*?const isBilibili = currentPlatformIsBilibili\(\)[\s\S]*?activeTab === "transcript" &&\s*!isBilibili[\s\S]*?activeTab === "overview" &&\s*!isBilibili[\s\S]*?notesControl\.hidden = !\(showingResults && activeTab === "notes"\)/,
  );
  // Bilibili notes keep the language control: the notes line closes right after
  // the "notes" tab check with no platform gate (positive match above pins it).
  assert.match(
    js,
    /function currentPlatformIsBilibili\(\)[\s\S]*?currentMediaRef\?\.platform === "bilibili"/,
  );
  // applyMediaLanguageDefaults must clear per-button hidden state so a switch
  // back to YouTube never inherits a Bilibili button that was left hidden.
  assert.match(
    js,
    /function applyMediaLanguageDefaults\(\)[\s\S]*?currentNotesMode = currentVideoIsChinese\(\)[\s\S]*?hasConfiguredAiService\(\)[\s\S]*?"bilingual"[\s\S]*?"original"[\s\S]*?\.transcript-mode-btn, \.overview-mode-btn, \.notes-mode-btn[\s\S]*?button\.hidden = false/,
  );
  assert.doesNotMatch(
    js,
    /button\.hidden = directChinese/,
  );
  // Bilibili original-mode badge folds the language into the source label
  // instead of appending the redundant 原文 mode word.
  assert.match(
    js,
    /function transcriptOriginalBadgeText\(\)[\s\S]*?currentPlatformIsBilibili\(\)[\s\S]*?\$\{transcriptSourceLabel\(\)\}（\$\{language\}）/,
  );
  assert.match(js, /function showState\(state\)[\s\S]*?updateHeaderLanguageControlsVisibility\(\)/);
  assert.match(js, /function switchTab\(tabName,[\s\S]*?updateHeaderLanguageControlsVisibility\(\)/);
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
  assert.match(js, /const REQUIRED_RUNTIME_PROTOCOL_VERSION = 12/);
  assert.match(
    js,
    /runtimeProtocolVersion\s*!==\s*REQUIRED_RUNTIME_PROTOCOL_VERSION[\s\S]*?showRuntimeVersionError\(\)/,
  );
  assert.match(js, /扩展后台未响应原文翻译请求，请重新加载扩展/);
  const backgroundSource = read("background.js");
  assert.match(backgroundSource, /const RUNTIME_PROTOCOL_VERSION = 12/);
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
  assert.match(js, /const TRANSCRIPT_SOURCE_POLICY_VERSION = 5/);
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
    /message\.action === "noteSaved" \|\| message\.action === "notesChanged"[\s\S]*?loadNotes\([\s\S]*?translateMissing:[\s\S]*?message\.action === "noteSaved"[\s\S]*?message\.preserveOriginalOnly !== true/,
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

test("opening another video's saved note stays in All Notes without requesting Supadata", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime);

  await fixture.playTarget();
  await fixture.inspectActive();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.errorTitle, "");
  assert.equal(snapshot.activeTab, "notes");
  assert.equal(snapshot.resultsVisible, true);
  assert.equal(snapshot.currentVideoId, fixture.targetVideoId);
  assert.equal(snapshot.currentRouteKey, `youtube:${fixture.targetVideoId}`);
  assert.equal(snapshot.notesFilterShowAll, true);
  assert.equal(snapshot.currentNotesFilterVideoId, null);
  assert.deepEqual(snapshot.noteLoadVideoIds, [null]);
  assert.deepEqual(snapshot.openedUrls, [
    `https://www.youtube.com/watch?v=${fixture.targetVideoId}&t=56s`,
  ]);
  assert.deepEqual(snapshot.createdTabs.map(({ active }) => active), [false]);
  assert.deepEqual(snapshot.updatedTabs, [
    { tabId: snapshot.createdTabs[0].id, active: true },
  ]);
  assert.equal(snapshot.sessionKeys.length, 1);
});

test("supplementing a YouTube note reads page metadata once and never fetches subtitles", async () => {
  const storageLocal = createMemoryStorageArea();
  const runtime = loadSidepanelRuntime({ storageLocal });
  const fixture = installNoteNavigationFixture(runtime, { hasAiKey: false });

  await fixture.playTargetForSupplement();
  await fixture.inspectActive();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.metadataRelayCount, 1);
  assert.equal(snapshot.bilibiliResolveCount, 0);
  assert.equal(snapshot.upsertCount, 1);
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.sessionCaptureMetadata, false);
  assert.equal(snapshot.activeTab, "notes");

  await fixture.inspectActive();
  await nextTurn();
  const repeated = JSON.parse(fixture.snapshot());
  assert.equal(repeated.metadataRelayCount, 1, "completed capture is not repeated");
  assert.equal(repeated.fetchCount, 0);

  const persisted = await require("../note-sources.js").readNoteSource(
    storageLocal,
    fixture.targetMediaKey,
  );
  assert.equal(persisted.descriptionStatus, "present");
  assert.equal(persisted.descriptionTruncated, false);
  assert.equal(JSON.parse(fixture.snapshot()).fetchCount, 0);
});

test("one complete-export click captures missing metadata and automatically downloads", async () => {
  const storageLocal = createMemoryStorageArea();
  const runtime = loadSidepanelRuntime({ storageLocal });
  const fixture = installNoteNavigationFixture(runtime, { hasAiKey: false });

  await fixture.playTargetForCompleteExport();
  await fixture.inspectActive();
  for (let index = 0; index < 5; index += 1) await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.metadataRelayCount, 1);
  assert.equal(snapshot.upsertCount >= 1, true);
  assert.equal(snapshot.noteExportDownloads, 1);
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.supadataConsents.length, 0);
  assert.equal(snapshot.sessionCaptureMetadata, false);
});

test("metadata supplement requires a refreshed content script even when a legacy title matches", async () => {
  const matchingRuntime = loadSidepanelRuntime();
  const matching = installNoteNavigationFixture(matchingRuntime, {
    omitMetadataVideoId: true,
  });
  await matching.playTargetForSupplement();
  await matching.inspectActive();
  await nextTurn();
  const matched = JSON.parse(matching.snapshot());
  assert.equal(matched.upsertCount, 0);
  assert.equal(matched.fetchCount, 0);
  assert.equal(matched.sessionCaptureMetadata, true);
  assert.match(matched.noteExportStatus, /刷新页面后再补充/);

  const staleRuntime = loadSidepanelRuntime();
  const stale = installNoteNavigationFixture(staleRuntime, {
    omitMetadataVideoId: true,
    metadataTitle: "Different stale video",
  });
  await stale.playTargetForSupplement();
  await stale.inspectActive();
  await nextTurn();
  const rejected = JSON.parse(stale.snapshot());
  assert.equal(rejected.upsertCount, 0);
  assert.equal(rejected.fetchCount, 0);
  assert.equal(rejected.sessionCaptureMetadata, true);
  assert.match(rejected.noteExportStatus, /刷新当前视频页/);
});

test("metadata supplement preserves the relay's actionable page-state error", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, {
    metadataRelayFailure: {
      success: false,
      error: "PAGE_CONTEXT_CHANGED",
      message: "视频页面正在加载，请稍后重试。",
    },
  });
  await fixture.playTargetForSupplement();
  await fixture.inspectActive();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.upsertCount, 0);
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.sessionCaptureMetadata, true);
  assert.equal(snapshot.noteExportStatus, "视频页面正在加载，请稍后重试。");
});

test("metadata supplement preserves an explicit refresh requirement", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, {
    metadataRelayFailure: {
      success: false,
      error: "PAGE_REFRESH_REQUIRED",
      message: "DigestDock 已更新，请刷新当前 YouTube 页面后重试。",
    },
  });
  await fixture.playTargetForSupplement();
  await fixture.inspectActive();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.upsertCount, 0);
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.sessionCaptureMetadata, true);
  assert.equal(
    snapshot.noteExportStatus,
    "DigestDock 已更新，请刷新当前 YouTube 页面后重试。",
  );
});

test("metadata supplement rejects an explicit response for another video", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, {
    metadataVideoId: "different-video",
  });
  await fixture.playTargetForSupplement();
  await fixture.inspectActive();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.upsertCount, 0);
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.sessionCaptureMetadata, true);
  assert.match(snapshot.noteExportStatus, /页面已切换，未写入旧视频资料/);
});

test("metadata supplement never writes after the target tab navigates during relay", async () => {
  const storageLocal = createMemoryStorageArea();
  const runtime = loadSidepanelRuntime({ storageLocal });
  const fixture = installNoteNavigationFixture(runtime, {
    deferMetadataRelay: true,
  });
  await fixture.playTargetForSupplement();

  const inspection = fixture.inspectActive();
  await fixture.waitForMetadataRelay();
  const openedTabId = JSON.parse(fixture.snapshot()).createdTabs[0].id;
  fixture.setActiveTab(
    "https://www.youtube.com/watch?v=navigated-away",
    openedTabId,
  );
  fixture.releaseMetadataRelay();
  await inspection;
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.upsertCount, 0);
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(
    await require("../note-sources.js").readNoteSource(
      storageLocal,
      fixture.targetMediaKey,
    ),
    null,
  );
});

test("supplementing the ordinary current video works without a transcript or note-only context", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, { hasAiKey: false });
  fixture.setActiveTab(fixture.targetUrl, 909);
  fixture.setCurrentVideo(fixture.targetVideoId);

  await fixture.playTargetForSupplement();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.metadataRelayCount, 1);
  assert.equal(snapshot.upsertCount, 1);
  assert.equal(snapshot.fetchCount, 0);
  assert.deepEqual(snapshot.openedUrls, []);
});

test("supplementing a Bilibili P2 note keeps the exact CID and never uses Supadata", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, {
    targetPlatform: "bilibili",
    targetVideoId: "BV1e3411j7ZM",
    targetMediaKey: "bilibili:BV1e3411j7ZM:200",
    targetUrl: "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2&t=56",
    hasAiKey: false,
  });

  await fixture.playTargetForSupplement();
  await fixture.inspectActive();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.bilibiliResolveCount, 1);
  assert.equal(snapshot.metadataRelayCount, 0);
  assert.equal(snapshot.upsertCount, 1);
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.currentVideoId, fixture.targetMediaKey);
  assert.equal(snapshot.sessionCaptureMetadata, false);
});

test("duplicate navigation events stay note-only until transcript is requested explicitly", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime);

  await fixture.playTarget();
  await fixture.inspectActive();
  // New tabs commonly emit activation, URL and complete events. A consumed
  // one-shot intent must therefore leave a route-scoped note-only state; a
  // second automatic inspection must not immediately reopen Supadata consent.
  await fixture.inspectActive();
  await nextTurn();
  assert.equal(JSON.parse(fixture.snapshot()).fetchCount, 0);

  await fixture.openTranscript();
  await nextTurn();
  await nextTurn();
  const afterCcPrompt = JSON.parse(fixture.snapshot());
  assert.equal(afterCcPrompt.fetchCount, 1);
  assert.equal(afterCcPrompt.activeTab, "transcript");
  assert.equal(afterCcPrompt.errorTitle, "请先打开 YouTube 字幕");
  assert.equal(afterCcPrompt.errorSecondaryText, "返回笔记");
  assert.deepEqual(afterCcPrompt.supadataConsents, [false]);
  assert.deepEqual(afterCcPrompt.captionRetries, [false]);

  await fixture.clickConsentPrimary();
  await nextTurn();
  const afterExplicitTranscript = JSON.parse(fixture.snapshot());
  assert.equal(afterExplicitTranscript.fetchCount, 2);
  assert.equal(
    afterExplicitTranscript.errorTitle,
    "是否使用 Supadata 获取字幕？",
  );
  assert.equal(afterExplicitTranscript.errorSecondaryText, "返回笔记");
  assert.deepEqual(afterExplicitTranscript.supadataConsents, [false, false]);
  assert.deepEqual(afterExplicitTranscript.captionRetries, [false, true]);
});

test("declining consent after a saved-note jump returns to All Notes without a third-party request", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime);

  await fixture.playTarget();
  await fixture.inspectActive();
  await fixture.openTranscript();
  await nextTurn();
  await nextTurn();

  const ccPrompt = JSON.parse(fixture.snapshot());
  assert.equal(ccPrompt.errorTitle, "请先打开 YouTube 字幕");
  assert.equal(ccPrompt.errorSecondaryText, "返回笔记");
  assert.deepEqual(ccPrompt.supadataConsents, [false]);
  assert.deepEqual(ccPrompt.captionRetries, [false]);

  await fixture.clickConsentPrimary();
  await nextTurn();

  const consent = JSON.parse(fixture.snapshot());
  assert.equal(consent.errorTitle, "是否使用 Supadata 获取字幕？");
  assert.equal(consent.errorSecondaryText, "返回笔记");
  assert.equal(consent.errorSecondaryHidden, false);
  assert.deepEqual(consent.supadataConsents, [false, false]);
  assert.deepEqual(consent.captionRetries, [false, true]);
  assert.equal(consent.sessionPhase, "active");

  await fixture.clickConsentSecondary();
  await nextTurn();

  const returned = JSON.parse(fixture.snapshot());
  assert.equal(returned.activeTab, "notes");
  assert.equal(returned.resultsVisible, true);
  assert.equal(returned.errorVisible, false);
  assert.equal(returned.notesFilterShowAll, true);
  assert.equal(returned.currentNotesFilterVideoId, null);
  assert.equal(returned.sessionPhase, "active");
  assert.deepEqual(returned.supadataConsents, [false, false]);
  assert.deepEqual(returned.noteLoadVideoIds, [null, null]);

  // An ordinary automatic inspection must continue to honor the restored
  // notes-only context instead of treating the decline as a digest request.
  await fixture.inspectActive();
  await nextTurn();
  const afterAutomaticCheck = JSON.parse(fixture.snapshot());
  assert.equal(afterAutomaticCheck.activeTab, "notes");
  assert.deepEqual(afterAutomaticCheck.supadataConsents, [false, false]);

  // A later explicit Transcript click starts a fresh unconsented probe. It
  // still cannot authorize Supadata without another primary-button click.
  await fixture.openTranscript();
  await nextTurn();
  await nextTurn();
  assert.equal(
    JSON.parse(fixture.snapshot()).errorTitle,
    "请先打开 YouTube 字幕",
  );
  await fixture.clickConsentPrimary();
  await nextTurn();
  const secondConsent = JSON.parse(fixture.snapshot());
  assert.equal(secondConsent.errorTitle, "是否使用 Supadata 获取字幕？");
  assert.deepEqual(secondConsent.supadataConsents, [false, false, false, false]);
  assert.deepEqual(secondConsent.captionRetries, [false, true, false, true]);
});

test("confirming consent after a saved-note jump is exactly false then true and clears the context on success", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, {
    authorizedTranscriptSuccess: true,
  });

  await fixture.playTarget();
  await fixture.inspectActive();
  await fixture.openTranscript();
  await nextTurn();
  await nextTurn();
  assert.equal(
    JSON.parse(fixture.snapshot()).errorTitle,
    "请先打开 YouTube 字幕",
  );

  await fixture.clickConsentPrimary();
  await nextTurn();
  const consent = JSON.parse(fixture.snapshot());
  assert.equal(consent.errorTitle, "是否使用 Supadata 获取字幕？");
  assert.deepEqual(consent.supadataConsents, [false, false]);
  assert.deepEqual(consent.captionRetries, [false, true]);

  await fixture.clickConsentPrimary();
  await nextTurn();

  const completed = JSON.parse(fixture.snapshot());
  assert.deepEqual(completed.supadataConsents, [false, false, true]);
  assert.deepEqual(completed.captionRetries, [false, true, false]);
  assert.equal(completed.currentTranscriptText, "Authorized target transcript");
  assert.equal(completed.activeTab, "transcript");
  assert.equal(completed.resultsVisible, true);
  assert.deepEqual(completed.sessionKeys, []);
});

test("a cached transcript opened from saved notes needs no consent and clears the notes-only context", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, {
    cachedTranscript: true,
  });

  await fixture.playTarget();
  await fixture.inspectActive();
  await fixture.openTranscript();
  await nextTurn();
  await nextTurn();

  const completed = JSON.parse(fixture.snapshot());
  assert.deepEqual(completed.supadataConsents, []);
  assert.equal(completed.currentTranscriptText, "Cached target transcript");
  assert.equal(completed.activeTab, "transcript");
  assert.equal(completed.resultsVisible, true);
  assert.deepEqual(completed.sessionKeys, []);
});

test("a provider failure after saved-note consent keeps a safe return to All Notes", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, {
    authorizedError: "RATE_LIMITED",
  });

  await fixture.playTarget();
  await fixture.inspectActive();
  await fixture.openTranscript();
  await nextTurn();
  await nextTurn();
  assert.equal(
    JSON.parse(fixture.snapshot()).errorTitle,
    "请先打开 YouTube 字幕",
  );
  await fixture.clickConsentPrimary();
  await nextTurn();
  assert.equal(
    JSON.parse(fixture.snapshot()).errorTitle,
    "是否使用 Supadata 获取字幕？",
  );
  await fixture.clickConsentPrimary();
  await nextTurn();

  const failed = JSON.parse(fixture.snapshot());
  assert.deepEqual(failed.supadataConsents, [false, false, true]);
  assert.deepEqual(failed.captionRetries, [false, true, false]);
  assert.equal(failed.errorTitle, "Supadata 暂时限流");
  assert.equal(failed.errorSecondaryText, "返回笔记");
  assert.equal(failed.errorSecondaryHidden, false);
  assert.equal(failed.sessionPhase, "active");

  await fixture.clickConsentSecondary();
  await nextTurn();
  const returned = JSON.parse(fixture.snapshot());
  assert.equal(returned.activeTab, "notes");
  assert.equal(returned.resultsVisible, true);
  assert.deepEqual(returned.supadataConsents, [false, false, true]);
});

test("a stale consent return cannot resurrect notes-only state on another route", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime);

  await fixture.playTarget();
  await fixture.inspectActive();
  await fixture.openTranscript();
  await nextTurn();
  await nextTurn();
  assert.equal(
    JSON.parse(fixture.snapshot()).errorTitle,
    "请先打开 YouTube 字幕",
  );
  await fixture.clickConsentPrimary();
  await nextTurn();
  const consent = JSON.parse(fixture.snapshot());
  assert.equal(consent.errorTitle, "是否使用 Supadata 获取字幕？");
  const targetTabId = consent.createdTabs[0].id;

  fixture.setActiveTab(
    "https://www.youtube.com/watch?v=another-video",
    targetTabId,
  );
  const returned = await fixture.clickConsentSecondary();
  await nextTurn();

  assert.equal(returned, false);
  const stale = JSON.parse(fixture.snapshot());
  assert.equal(stale.resultsVisible, false);
  assert.equal(stale.errorVisible, true);
  assert.deepEqual(stale.sessionKeys, []);
  assert.deepEqual(stale.supadataConsents, [false, false]);
  assert.deepEqual(stale.captionRetries, [false, true]);
});

test("saved-note navigation suppression is bound to one target route and is not reused", async () => {
  const unrelatedRuntime = loadSidepanelRuntime();
  const unrelated = installNoteNavigationFixture(unrelatedRuntime);
  await unrelated.playTarget();
  unrelated.setActiveVideo("unrelated-video");
  await unrelated.inspectActive();
  await nextTurn();
  assert.equal(
    JSON.parse(unrelated.snapshot()).fetchCount,
    1,
    "a pending target-video note intent must not suppress another video",
  );

  const oneShotRuntime = loadSidepanelRuntime();
  const oneShot = installNoteNavigationFixture(oneShotRuntime);
  await oneShot.playTarget();
  await oneShot.inspectActive();
  await nextTurn();
  assert.equal(JSON.parse(oneShot.snapshot()).fetchCount, 0);

  // Leaving the matched route ends its note-only navigation session. Returning
  // later without another saved-note click must use the ordinary transcript
  // flow rather than reusing the old intent.
  oneShot.setActiveVideo("later-video");
  await oneShot.inspectActive();
  oneShot.setActiveVideo(oneShot.targetVideoId);
  await oneShot.inspectActive();
  await nextTurn();
  assert.equal(JSON.parse(oneShot.snapshot()).fetchCount, 2);
});

test("playing a saved note for the current video still seeks without opening a tab", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime);
  fixture.setActiveTab(fixture.targetUrl, 303);
  fixture.setCurrentVideo(fixture.targetVideoId);

  await fixture.playTarget();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.deepEqual(snapshot.openedUrls, []);
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.tabSeekCount, 0);
  assert.equal(snapshot.runtimeSeekCount, 1);
  assert.deepEqual(snapshot.tabSeekTabIds, []);
});

test("an active saved-note context survives side-panel reconstruction without fetching a transcript", async () => {
  const sharedSession = createMemoryStorageArea();
  const firstRuntime = loadSidepanelRuntime({ storageSession: sharedSession });
  const first = installNoteNavigationFixture(firstRuntime);

  await first.playTarget();
  await first.inspectActive();
  await nextTurn();
  const firstSnapshot = JSON.parse(first.snapshot());
  assert.equal(firstSnapshot.fetchCount, 0);
  assert.equal(Object.values(sharedSession.snapshot())[0]?.phase, "active");

  // A newly constructed side panel starts with no in-memory intent. It must
  // hydrate the active tab+route context from chrome.storage.session and keep
  // the local All Notes view instead of treating reconstruction as a new visit.
  const rebuiltRuntime = loadSidepanelRuntime({ storageSession: sharedSession });
  const rebuilt = installNoteNavigationFixture(rebuiltRuntime);
  rebuilt.setActiveTab(
    first.targetUrl,
    firstSnapshot.createdTabs[0].id,
  );
  await rebuilt.inspectActive();
  await nextTurn();

  const rebuiltSnapshot = JSON.parse(rebuilt.snapshot());
  assert.equal(rebuiltSnapshot.fetchCount, 0);
  assert.equal(rebuiltSnapshot.errorTitle, "");
  assert.equal(rebuiltSnapshot.activeTab, "notes");
  assert.equal(rebuiltSnapshot.currentVideoId, first.targetMediaKey);
  assert.equal(rebuiltSnapshot.notesFilterShowAll, true);
  assert.deepEqual(rebuiltSnapshot.noteLoadVideoIds, [null]);
});

test("a Bilibili P2 note jump preserves its CID media identity and stays local without an AI key", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, {
    targetPlatform: "bilibili",
    targetVideoId: "BV1e3411j7ZM",
    targetMediaKey: "bilibili:BV1e3411j7ZM:200",
    targetUrl: "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2&t=56",
    hasAiKey: false,
  });

  await fixture.playTarget();
  await fixture.inspectActive();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.errorTitle, "");
  assert.equal(snapshot.currentVideoId, "bilibili:BV1e3411j7ZM:200");
  assert.equal(snapshot.currentRouteKey, "bilibili:BV1e3411j7ZM:p2");
  assert.equal(snapshot.currentMediaRef.platform, "bilibili");
  assert.equal(
    snapshot.currentMediaRef.mediaKey,
    "bilibili:BV1e3411j7ZM:200",
  );
  assert.equal(snapshot.currentMediaRef.bvid, "BV1e3411j7ZM");
  assert.equal(snapshot.currentMediaRef.page, 2);
  assert.equal(snapshot.activeTab, "notes");
  assert.equal(snapshot.notesFilterShowAll, true);
  assert.deepEqual(snapshot.noteLoadVideoIds, [null]);
  assert.deepEqual(snapshot.backgroundActions, ["getNotes"]);
});

test("a matching saved-note jump can read local notes when no AI provider key is configured", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installNoteNavigationFixture(runtime, { hasAiKey: false });

  await fixture.playTarget();
  await fixture.inspectActive();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.fetchCount, 0);
  assert.equal(snapshot.errorTitle, "");
  assert.equal(snapshot.resultsVisible, true);
  assert.equal(snapshot.activeTab, "notes");
  assert.deepEqual(snapshot.noteLoadVideoIds, [null]);
  assert.deepEqual(snapshot.backgroundActions, ["getNotes"]);
});

test("leaving an active saved-note route for an unsupported page clears the session context", async () => {
  const sharedSession = createMemoryStorageArea();
  const runtime = loadSidepanelRuntime({ storageSession: sharedSession });
  const fixture = installNoteNavigationFixture(runtime);

  await fixture.playTarget();
  await fixture.inspectActive();
  assert.equal(Object.values(sharedSession.snapshot())[0]?.phase, "active");

  fixture.navigateFront("https://example.com/not-a-video");
  await nextTurn();
  await nextTurn();

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(snapshot.panelClosed, true);
  assert.deepEqual(snapshot.sessionKeys, []);
  assert.deepEqual(sharedSession.snapshot(), {});
});

test("activating the same video in another tab clears note-only state and rebinds later seeks", async () => {
  const timers = new Map();
  let nextTimerId = 1;
  const runtime = loadSidepanelRuntime({
    setTimeoutImpl(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay, cancelled: false });
      return id;
    },
    clearTimeoutImpl(id) {
      if (timers.has(id)) timers.get(id).cancelled = true;
    },
  });
  const fixture = installNoteNavigationFixture(runtime);

  await fixture.playTarget();
  await fixture.inspectActive();
  const noteOnly = JSON.parse(fixture.snapshot());
  assert.equal(noteOnly.fetchCount, 0);
  assert.equal(noteOnly.videoTabId, noteOnly.createdTabs[0].id);
  assert.equal(noteOnly.sessionKeys.length, 1);

  const secondTabId = 909;
  fixture.setActiveTab(fixture.targetUrl, secondTabId);
  await runtime.tabActivatedListeners[0]({ tabId: secondTabId, windowId: 1 });
  await nextTurn();

  const afterActivation = JSON.parse(fixture.snapshot());
  assert.deepEqual(afterActivation.sessionKeys, []);
  const scheduledRefreshes = [...timers.values()].filter(
    (timer) => !timer.cancelled,
  );
  assert.equal(scheduledRefreshes.length, 1);
  assert.equal(scheduledRefreshes[0].delay, 600);

  scheduledRefreshes[0].callback();
  await nextTurn();
  await nextTurn();
  const afterRefresh = JSON.parse(fixture.snapshot());
  assert.equal(afterRefresh.videoTabId, secondTabId);
  assert.equal(afterRefresh.fetchCount, 1);

  await fixture.playTarget();
  await nextTurn();
  const afterPlay = JSON.parse(fixture.snapshot());
  assert.deepEqual(afterPlay.tabSeekTabIds, []);
  assert.equal(afterPlay.runtimeSeekCount, 1);
  assert.equal(afterPlay.openedUrls.length, 1);
});

test("a YouTube miss asks for CC before a free retry can reveal Supadata", async () => {
  const messages = [];
  const videoId = "abc123DEF45";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      messages.push({ ...message });
      if (message.action !== "fetchTranscript") {
        throw new Error(`Unexpected action: ${message.action}`);
      }
      if (message.supadataConsent === true) {
        return {
          success: true,
          routeOutcome: "HAVE_TRANSCRIPT",
          runId: message.runId,
          routeKey: message.routeKey,
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
      }
      if (message.captionRetry === true) {
        return {
          success: false,
          error: "SUPADATA_CONSENT_REQUIRED",
          message: "YouTube captions were still unavailable after retry.",
          routeOutcome: "UNKNOWN",
          supadataEligible: true,
          hasSupadataKey: true,
          runId: message.runId,
          routeKey: message.routeKey,
        };
      }
      return {
        success: false,
        error: "YOUTUBE_CAPTIONS_REQUIRED",
        message: "Enable YouTube captions and retry.",
        routeOutcome: "UNKNOWN",
        requiresCaptionEnable: true,
        supadataEligible: false,
        runId: message.runId,
        routeKey: message.routeKey,
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
    messages.map(({ supadataConsent, captionRetry }) => ({
      supadataConsent,
      captionRetry,
    })),
    [{ supadataConsent: false, captionRetry: false }],
  );
  assert.deepEqual(JSON.parse(fixture.errorSnapshot()), {
    title: "请先打开 YouTube 字幕",
    message:
      "请点击视频播放器右下角的“字幕 / CC”按钮，等待字幕显示后再重新读取。",
    primaryText: "已打开字幕，重新读取",
    primaryDisabled: false,
    secondaryText: "不使用",
    secondaryHidden: true,
  });

  const freeRetry = fixture.clickError();
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await freeRetry;
  assert.deepEqual(
    messages.map(({ supadataConsent, captionRetry }) => ({
      supadataConsent,
      captionRetry,
    })),
    [
      { supadataConsent: false, captionRetry: false },
      { supadataConsent: false, captionRetry: true },
    ],
  );
  assert.equal(
    JSON.parse(fixture.errorSnapshot()).title,
    "是否使用 Supadata 获取字幕？",
  );

  const approvedLoad = fixture.clickError();
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await approvedLoad;
  assert.deepEqual(
    messages.map(({ supadataConsent, captionRetry }) => ({
      supadataConsent,
      captionRetry,
    })),
    [
      { supadataConsent: false, captionRetry: false },
      { supadataConsent: false, captionRetry: true },
      { supadataConsent: true, captionRetry: false },
    ],
  );
  assert.equal(JSON.parse(fixture.saved()).at(-1).transcriptText, "Approved fallback");
});

test("a first CC prompt never exposes an unconfigured Supadata fallback", async () => {
  const messages = [];
  const videoId = "abc123DEF45";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      messages.push({ ...message });
      return message.captionRetry === true
        ? {
            success: false,
            error: "SUPADATA_NOT_CONFIGURED",
            routeOutcome: "UNKNOWN",
            supadataEligible: true,
            hasSupadataKey: false,
            runId: message.runId,
            routeKey: message.routeKey,
          }
        : {
            success: false,
            error: "YOUTUBE_CAPTIONS_REQUIRED",
            routeOutcome: "UNKNOWN",
            requiresCaptionEnable: true,
            supadataEligible: false,
            runId: message.runId,
            routeKey: message.routeKey,
          };
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setupEvents();

  const initialLoad = fixture.start(videoId);
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await initialLoad;
  assert.equal(JSON.parse(fixture.errorSnapshot()).title, "请先打开 YouTube 字幕");

  const freeRetry = fixture.clickError();
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await freeRetry;
  assert.equal(JSON.parse(fixture.errorSnapshot()).title, "免费字幕未能取得");
  assert.equal(messages.length, 2);
  assert.equal(messages.some((message) => message.supadataConsent === true), false);
});

test("a CC retry waits for an older automatic refresh and runs exactly once", async () => {
  const messages = [];
  const videoId = "abc123DEF45";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      messages.push({ ...message });
      if (message.captionRetry === true) {
        return {
          success: true,
          routeOutcome: "HAVE_TRANSCRIPT",
          runId: message.runId,
          routeKey: message.routeKey,
          source: "youtube-passive",
          sourceAttempt: "YOUTUBE_PASSIVE_RETRY",
          selectedTrack: { language: "en", kind: "manual" },
          transcript: [
            { text: "Caption retry", start: 0, duration: 2, language: "en" },
          ],
          transcriptText: "Caption retry",
          transcriptTextTimestamped: "[0:00] Caption retry",
          language: "en",
        };
      }
      return {
        success: false,
        error: "YOUTUBE_CAPTIONS_REQUIRED",
        routeOutcome: "UNKNOWN",
        requiresCaptionEnable: true,
        supadataEligible: false,
        runId: message.runId,
        routeKey: message.routeKey,
      };
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setupEvents();

  const initialLoad = fixture.start(videoId);
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await initialLoad;

  const olderRefresh = fixture.start(videoId);
  await nextTurn();
  const retry = fixture.clickError();
  fixture.resolveCache(videoId, null);
  await olderRefresh;

  await nextTurn();
  fixture.resolveLatestCache(videoId, null);
  await retry;

  assert.deepEqual(
    messages.map((message) => message.captionRetry),
    [false, false, true],
  );
  assert.equal(
    messages.filter((message) => message.captionRetry === true).length,
    1,
  );
  assert.equal(JSON.parse(fixture.saved()).at(-1).transcriptText, "Caption retry");
});

test("confirmed no-caption skips both the CC prompt and Supadata", async () => {
  const messages = [];
  const videoId = "abc123DEF45";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      messages.push({ ...message });
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "The page confirmed zero caption tracks.",
        routeOutcome: "CONFIRMED_UNAVAILABLE",
        supadataEligible: false,
        runId: message.runId,
        routeKey: message.routeKey,
      };
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setupEvents();

  const load = fixture.start(videoId);
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await load;
  const error = JSON.parse(fixture.errorSnapshot());
  assert.equal(error.title, "当前视频没有可用字幕");
  assert.equal(error.primaryText, "重试");
  assert.equal(messages.length, 1);
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
          error: "NATIVE_TRANSCRIPT_UNKNOWN",
          message: "The free transcript routes did not produce a transcript.",
          routeOutcome: "UNKNOWN",
          hasSupadataKey: true,
          runId: message.runId,
          routeKey: message.routeKey,
        };
      }
      return {
        success: true,
        routeOutcome: "HAVE_TRANSCRIPT",
        runId: message.runId,
        routeKey: message.routeKey,
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
  assert.equal(
    JSON.parse(fixture.errorSnapshot()).title,
    "请先打开 YouTube 字幕",
  );

  const freeRetry = fixture.clickError();
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await freeRetry;
  assert.deepEqual(JSON.parse(fixture.errorSnapshot()), {
    title: "是否使用 Supadata 获取字幕？",
    message:
      "此视频将通过 Supadata 获取 YouTube 原生字幕。点击后会把此视频的标准 YouTube 链接发送给 Supadata，并可能消耗你的 API 额度。",
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
    [false, false, true],
  );
  assert.deepEqual(
    messages.map((message) => message.captionRetry),
    [false, true, false],
  );
  assert.equal(JSON.parse(fixture.saved()).at(-1).transcriptText, "Approved fallback");
});

test("the API-primary side panel exposes no local transcript diagnostics", () => {
  const helpers = loadSidepanelHelpers();
  const panel = read("sidepanel.js");
  assert.equal(helpers.formatLocalTranscriptDiagnostics, undefined);
  assert.doesNotMatch(panel, /本地诊断|formatLocalTranscriptDiagnostics/);
});

test("declining Supadata sends no third-party request and retry restarts at the CC prompt", async () => {
  const messages = [];
  const videoId = "abc123DEF45";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      messages.push({ ...message });
      return {
        success: false,
        error: "NATIVE_TRANSCRIPT_UNKNOWN",
        message: "The free transcript routes did not produce a transcript.",
        routeOutcome: "UNKNOWN",
        hasSupadataKey: true,
        runId: message.runId,
        routeKey: message.routeKey,
      };
    },
  });
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setupEvents();

  const initialLoad = fixture.start(videoId);
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await initialLoad;

  const freeRetry = fixture.clickError();
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await freeRetry;
  fixture.clickErrorSecondary();

  assert.deepEqual(
    messages.map((message) => message.supadataConsent),
    [false, false],
  );
  const errorState = JSON.parse(fixture.errorSnapshot());
  assert.equal(errorState.title, "已跳过 Supadata 字幕");
  assert.match(errorState.message, /没有向 Supadata 发送视频链接/);
  assert.match(errorState.message, /重新在侧栏本次授权 Supadata/);
  assert.equal(errorState.primaryText, "重试");
  assert.equal(errorState.secondaryText, "管理 Supadata");
  assert.equal(errorState.secondaryHidden, false);

  const consentRetry = fixture.clickError();
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await consentRetry;

  assert.deepEqual(
    messages.map((message) => message.supadataConsent),
    [false, false, false],
  );
  assert.equal(
    JSON.parse(fixture.errorSnapshot()).title,
    "请先打开 YouTube 字幕",
  );
});

test("a consent click waits for an older unconsented refresh and still runs", async () => {
  const messages = [];
  const videoId = "abc123DEF45";
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      messages.push({ ...message });
      if (message.supadataConsent !== true) {
        return {
          success: false,
          error: "NATIVE_TRANSCRIPT_UNKNOWN",
          message: "The free transcript routes did not produce a transcript.",
          routeOutcome: "UNKNOWN",
          hasSupadataKey: true,
          runId: message.runId,
          routeKey: message.routeKey,
        };
      }
      return {
        success: true,
        routeOutcome: "HAVE_TRANSCRIPT",
        runId: message.runId,
        routeKey: message.routeKey,
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

  const freeRetry = fixture.clickError();
  await nextTurn();
  fixture.resolveCache(videoId, null);
  await freeRetry;
  assert.equal(
    JSON.parse(fixture.errorSnapshot()).title,
    "是否使用 Supadata 获取字幕？",
  );

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
    [false, false, false, true],
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

test("compact overview cache survives side-panel recreation with zero repeat provider calls", async () => {
  const storageLocal = createMemoryStorageArea();
  const videoId = "persisted-overview-video";
  const transcript = "[0:00] A stable transcript for the cached overview.";
  const analysis = {
    schemaVersion: 3,
    timestampAnchorVersion: 1,
    baseLanguage: "zh-Hans",
    sourceLanguage: "en-US",
    chapters: [
      {
        timestamp: "0:00",
        timestampSeconds: 0,
        titleZh: "缓存章节",
        summaryZh: "这是一段可以复用的中文概览。",
      },
    ],
    keyQuotes: [
      {
        timestamp: "0:00",
        timestampSeconds: 0,
        quoteOriginal: "Stable quote.",
        quoteZh: "稳定引用。",
      },
    ],
    keyMoments: [0],
  };

  const firstRuntime = loadSidepanelRuntime({ storageLocal });
  assert.equal(
    await firstRuntime.helpers.saveOverviewToCache(
      videoId,
      analysis,
      transcript,
      "en-US",
    ),
    true,
  );

  const persisted = storageLocal.snapshot();
  const cacheKey = firstRuntime.helpers.overviewCacheKey(videoId);
  assert.equal(Object.hasOwn(persisted, cacheKey), true);
  assert.doesNotMatch(JSON.stringify(persisted[cacheKey]), /stable transcript/i);
  assert.doesNotMatch(JSON.stringify(persisted[cacheKey]), /api.?key/i);

  let providerCalls = 0;
  const reopenedRuntime = loadSidepanelRuntime({
    storageLocal,
    sendMessage: async (message) => {
      if (message.action === "analyzeTranscript") providerCalls += 1;
      return { success: false, error: "UNEXPECTED_PROVIDER_CALL" };
    },
  });
  const restored = await reopenedRuntime.helpers.loadOverviewFromCache(
    videoId,
    transcript,
    "en",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored)),
    analysis,
    "primary-language variants should reuse the same transcript-bound overview",
  );
  reopenedRuntime.sandbox.__restoredOverview = restored;
  reopenedRuntime.evaluate(`
    currentVideoId = ${JSON.stringify(videoId)};
    currentRouteKey = "youtube:${videoId}";
    currentMediaRef = { platform: "youtube", mediaKey: ${JSON.stringify(videoId)} };
    currentTranscriptTimestamped = ${JSON.stringify(transcript)};
    currentAnalysis = globalThis.__restoredOverview;
  `);
  await reopenedRuntime.evaluate("triggerAnalysis()");
  assert.equal(providerCalls, 0);
});

test("digest loading restores the compact overview before an active tab can analyze again", async () => {
  const storageLocal = createMemoryStorageArea();
  const videoId = "overview-load-video";
  const routeKey = `youtube:${videoId}`;
  const transcript = "[0:00] Persisted transcript.";
  const analysis = {
    marker: "restored-overview",
    schemaVersion: 3,
    timestampAnchorVersion: 1,
    baseLanguage: "zh-Hans",
    sourceLanguage: "en",
    chapters: [
      {
        timestamp: "0:00",
        timestampSeconds: 0,
        titleZh: "恢复章节",
        summaryZh: "侧栏重建后应直接恢复概览。",
      },
    ],
    keyQuotes: [
      {
        timestamp: "0:00",
        timestampSeconds: 0,
        quoteOriginal: "Persisted quote.",
        quoteZh: "持久化引用。",
      },
    ],
    keyMoments: [0],
  };
  const seedRuntime = loadSidepanelRuntime({ storageLocal });
  assert.equal(
    await seedRuntime.helpers.saveOverviewToCache(
      videoId,
      analysis,
      transcript,
      "en",
      "supadata",
      null,
    ),
    true,
  );
  const transcriptFingerprint =
    seedRuntime.helpers.transcriptContentFingerprint(
      transcript,
      "Persisted transcript.",
    );
  await storageLocal.set({
    [`digest_${videoId}`]: {
      analysis: { ...analysis, marker: "legacy-digest-overview" },
      analysisVideoId: videoId,
      transcript: [{ start: 0, duration: 2, text: "Persisted transcript." }],
      transcriptText: "Persisted transcript.",
      transcriptTimestamped: transcript,
      transcriptLanguage: "en",
      transcriptSource: "supadata",
      transcriptSelectedTrack: null,
      transcriptSelectedTrackIdentity: "none",
      transcriptRequestedLanguage: "en",
      transcriptRequestedTrackKind: "manual-first",
      transcriptFingerprint,
      transcriptArtifactIdentity:
        seedRuntime.helpers.transcriptArtifactIdentity({
          source: "supadata",
          language: "en",
          requestedLanguage: "en",
          selectedTrack: null,
          fingerprint: transcriptFingerprint,
        }),
      mediaRef: {
        platform: "youtube",
        mediaKey: videoId,
        videoId,
      },
      routeKey,
      transcriptSourcePolicyVersion: 5,
      timestamp: Date.now(),
    },
  });

  let providerCalls = 0;
  const runtime = loadSidepanelRuntime({
    storageLocal,
    sendMessage: async (message) => {
      if (message.action === "analyzeTranscript") providerCalls += 1;
      return { success: false, error: "UNEXPECTED_PROVIDER_CALL" };
    },
  });
  runtime.evaluate(`
    (() => {
      const elements = new Map();
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
          });
        }
        return elements.get(id);
      };
      document.getElementById = element;
      document.querySelectorAll = () => [];
      document.querySelector = (selector) =>
        selector === ".tab.active" ? { dataset: { tab: "overview" } } : null;
      setOverviewModeButtons = () => {};
      clearOverviewResults = () => {};
      applyMediaLanguageDefaults = () => {};
      hydrateCurrentVideoNoteSource = async () => {};
      updateVideoMetaLine = () => {};
      renderTranscript = () => {};
      renderAnalysisResults = (value) => {
        globalThis.__restoredMarker = value?.marker || "";
      };
      highlightMomentsOnPage = () => {};
      showState = () => {};
      loadNotes = () => {};
      setupExplainFeature = () => {};
      translateTranscript = () => {};
    })()
  `);
  await runtime.evaluate(`startDigest(
    ${JSON.stringify(videoId)},
    "https://www.youtube.com/watch?v=${videoId}",
    { platform: "youtube", mediaKey: ${JSON.stringify(videoId)}, videoId: ${JSON.stringify(videoId)} },
    ${JSON.stringify(routeKey)}
  )`);

  assert.equal(runtime.sandbox.__restoredMarker, "restored-overview");
  assert.equal(providerCalls, 0);
});

test("overview cache invalidates a changed transcript fingerprint", async () => {
  const storageLocal = createMemoryStorageArea();
  const runtime = loadSidepanelRuntime({ storageLocal });
  const videoId = "overview-source-change";
  const analysis = {
    schemaVersion: 3,
    timestampAnchorVersion: 1,
    baseLanguage: "zh-Hans",
    sourceLanguage: "en",
    chapters: [
      {
        timestamp: "0:00",
        timestampSeconds: 0,
        titleZh: "原始章节",
        summaryZh: "原始字幕对应的中文概览。",
      },
    ],
    keyQuotes: [
      {
        timestamp: "0:00",
        timestampSeconds: 0,
        quoteOriginal: "Original quote.",
        quoteZh: "原始引用。",
      },
    ],
  };
  assert.equal(
    await runtime.helpers.saveOverviewToCache(
      videoId,
      analysis,
      "[0:00] Original transcript.",
      "en",
    ),
    true,
  );
  assert.equal(
    await runtime.helpers.loadOverviewFromCache(
      videoId,
      "[0:00] Changed transcript.",
      "en-US",
    ),
    null,
  );
  assert.equal(
    Object.hasOwn(
      storageLocal.snapshot(),
      runtime.helpers.overviewCacheKey(videoId),
    ),
    false,
  );
});

test("overview cache persistence failure is observable to the caller", async () => {
  const runtime = loadSidepanelRuntime({
    storageLocal: {
      get: async () => ({}),
      set: async () => {
        throw new Error("QUOTA_BYTES quota exceeded");
      },
      remove: async () => {},
      clear: async () => {},
    },
  });
  const analysis = {
    schemaVersion: 3,
    timestampAnchorVersion: 1,
    baseLanguage: "zh-Hans",
    sourceLanguage: "en",
    chapters: [
      {
        timestamp: "0:00",
        timestampSeconds: 0,
        titleZh: "容量章节",
        summaryZh: "本地保存失败必须被调用方看到。",
      },
    ],
    keyQuotes: [
      {
        timestamp: "0:00",
        timestampSeconds: 0,
        quoteOriginal: "Quota failure.",
        quoteZh: "容量失败。",
      },
    ],
  };
  assert.equal(
    await runtime.helpers.saveOverviewToCache(
      "quota-video",
      analysis,
      "[0:00] Quota failure.",
      "en",
    ),
    false,
  );
  assert.match(
    read("sidepanel.js"),
    /概览已生成，但本地保存失败；再次打开可能会重新生成并消耗 AI 额度。/,
  );
});

test("a newly confirmed audio language does not reset the same video's validated transcript", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = installSidepanelDigestFixture(runtime);
  fixture.setVideoSourceLanguage("en");
  const englishLoad = fixture.start("video-a");
  await nextTurn();
  fixture.resolveCache("video-a", fixture.makeCache("video-a"));
  await englishLoad;

  fixture.setVideoSourceLanguage("zh-CN");
  await fixture.start("video-a");

  const snapshot = JSON.parse(fixture.snapshot());
  assert.equal(fixture.videoSourceLanguage(), "zh-CN");
  assert.equal(snapshot.sourceLanguage, "en");
  assert.equal(snapshot.transcriptText, "transcript-video-a");
  assert.equal(snapshot.overviewMode, "zh");
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
          timestampAnchorVersion: 1,
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

test("free mode explains optional AI features with the selected provider name", () => {
  const runtime = loadSidepanelRuntime();
  runtime.evaluate(
    'currentConfigStatus = { hasAiKey: false, provider: { displayName: "智谱 GLM" } };',
  );

  assert.equal(runtime.helpers.hasConfiguredAiService(), false);
  assert.equal(runtime.helpers.activeAiServiceLabel(), "智谱 GLM");
  assert.match(
    runtime.helpers.aiFeatureSetupMessage("生成概览"),
    /字幕阅读、时间跳转和原文笔记无需 AI 密钥.*生成概览.*智谱 GLM/,
  );
  assert.match(
    runtime.helpers.summarizeNoteTranslationFailures([
      { code: "PROVIDER_ERROR" },
    ]),
    /智谱 GLM请求失败/,
  );
});

test("free mode saves the current timestamped note without an AI request", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      const actions = [];
      const label = { textContent: "保存当前时刻" };
      const button = {
        disabled: false,
        textContent: "",
        querySelector: () => label,
      };
      const status = {
        textContent: "",
        hidden: true,
        classList: { toggle() {} },
      };
      document.getElementById = (id) =>
        id === "saveCurrentMomentBtn" ? button :
        id === "notesLanguageStatus" ? status : null;
      currentConfigStatus = {
        hasAiKey: false,
        provider: { displayName: "DeepSeek" },
      };
      currentVideoId = "video-free-note";
      currentRouteKey = "youtube:video-free-note";
      currentVideoUrl = "https://www.youtube.com/watch?v=video-free-note";
      currentVideoTitle = "Free note video";
      currentChannelName = "Channel";
      currentTranscriptLanguage = "en";
      currentVideoSourceLanguage = "en";
      currentMediaRef = {
        platform: "youtube",
        mediaKey: "video-free-note",
        canonicalUrl: currentVideoUrl,
      };
      videoTabId = 42;
      chrome.runtime.sendMessage = async (message) => {
        actions.push(JSON.parse(JSON.stringify(message)));
        if (message.action === "relayToContent") {
          return { success: true, response: { currentTime: 12 } };
        }
        if (message.action === "saveNote") return { success: true };
        throw new Error("unexpected action: " + message.action);
      };
      return {
        run: () => saveCurrentMomentFromPanel(),
        snapshot: () => JSON.stringify({
          actions,
          label: label.textContent,
          status: status.textContent,
          disabled: button.disabled,
        }),
      };
    })()
  `);

  await fixture.run();
  const snapshot = JSON.parse(fixture.snapshot());
  assert.deepEqual(
    snapshot.actions.map((message) => message.action),
    ["relayToContent", "saveNote"],
  );
  assert.equal(snapshot.actions[1].timestamp, 9);
  assert.equal(snapshot.actions[0].expectedRouteKey, "youtube:video-free-note");
  assert.equal(snapshot.actions[1].expectedRouteKey, "youtube:video-free-note");
  assert.equal(snapshot.actions[1].skipAiCleanup, true);
  assert.equal(snapshot.actions.some((message) => /translate|analyze/i.test(message.action)), false);
  assert.equal(snapshot.label, "已保存");
  assert.equal(snapshot.status, "已保存当前时刻。");
  assert.equal(snapshot.disabled, false);
});

test("the current-moment action rejects a late time result from another video", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      const actions = [];
      const label = { textContent: "保存当前时刻" };
      const button = {
        disabled: false,
        textContent: "",
        querySelector: () => label,
      };
      const status = {
        textContent: "",
        hidden: true,
        classList: { toggle() {} },
      };
      document.getElementById = (id) =>
        id === "saveCurrentMomentBtn" ? button :
        id === "notesLanguageStatus" ? status : null;
      currentVideoId = "video-a";
      currentRouteKey = "youtube:video-a";
      currentVideoUrl = "https://www.youtube.com/watch?v=video-a";
      currentMediaRef = {
        platform: "youtube",
        videoId: "video-a",
        mediaKey: "video-a",
        canonicalUrl: currentVideoUrl,
      };
      videoTabId = 42;
      chrome.runtime.sendMessage = async (message) => {
        actions.push(JSON.parse(JSON.stringify(message)));
        if (message.action === "relayToContent") {
          currentVideoId = "video-b";
          currentRouteKey = "youtube:video-b";
          digestGeneration += 1;
          return { success: true, response: { currentTime: 12 } };
        }
        throw new Error("saveNote must not run for stale context");
      };
      return {
        run: () => saveCurrentMomentFromPanel(),
        snapshot: () => JSON.stringify({
          actions,
          label: label.textContent,
          status: status.textContent,
        }),
      };
    })()
  `);

  await fixture.run();
  const snapshot = JSON.parse(fixture.snapshot());
  assert.deepEqual(
    snapshot.actions.map((message) => message.action),
    ["relayToContent"],
  );
  assert.equal(snapshot.label, "保存当前时刻");
  assert.match(snapshot.status, /视频页面已切换/);
});

test("original current-moment notes bypass AI cleanup even when a key exists", async () => {
  const videoId = "free-note-with-key";
  let storedNotes = [];
  let providerCalls = 0;
  const runtimeMessages = [];
  const mediaRef = {
    platform: "youtube",
    videoId,
    mediaKey: videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: {
            provider: "deepseek",
            aiApiKeys: { deepseek: "configured-key" },
          },
        };
      }
      if (key === `digest_${videoId}`) {
        return {
          [`digest_${videoId}`]: {
            transcriptSourcePolicyVersion: 5,
            transcriptSource: "youtube-passive",
            transcriptLanguage: "en",
            transcript: [
              { start: 0, text: "Before the key idea.", language: "en" },
              { start: 8, text: "The key idea is local-first.", language: "en" },
              { start: 16, text: "After the key idea.", language: "en" },
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
    tabsImpl: {
      get: async () => ({
        id: 42,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      }),
    },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("provider must not run");
    },
    runtimeSendMessageImpl: async (message) => {
      runtimeMessages.push(JSON.parse(JSON.stringify(message)));
      return { success: true };
    },
  });

  const result = await background.handleSaveNote(
    mediaRef,
    9,
    "Free note video",
    "Channel",
    mediaRef.canonicalUrl,
    42,
    "en",
    `youtube:${videoId}`,
    true,
  );

  assert.equal(result.success, true);
  assert.equal(providerCalls, 0);
  assert.equal(storedNotes.length, 1);
  assert.match(storedNotes[0].text, /The key idea is local-first/);
  assert.equal(storedNotes[0].translatedText, "");
  const savedBroadcast = runtimeMessages.find(
    (message) => message.action === "noteSaved",
  );
  assert.ok(savedBroadcast);
  assert.equal(savedBroadcast.preserveOriginalOnly, true);
});

test("an original-only save notification never starts note translation", async () => {
  const actions = [];
  const runtime = loadSidepanelRuntime({
    sendMessage: async (message) => {
      actions.push(JSON.parse(JSON.stringify(message)));
      if (message.action === "getNotes") {
        return {
          success: true,
          notes: [
            {
              id: "original-only-note",
              videoId: "video-original-only",
              mediaKey: "video-original-only",
              platform: "youtube",
              videoTitle: "Original-only note",
              timestamp: "0:09",
              timestampSeconds: 9,
              text: "Keep this note local.",
              rawText: "Keep this note local.",
              translatedText: "",
              sourceLanguage: "en",
            },
          ],
        };
      }
      if (message.action === "translateNotes") {
        throw new Error("translateNotes must not run");
      }
      return { success: true };
    },
  });
  runtime.evaluate(`
    currentConfigStatus = {
      hasAiKey: true,
      provider: { displayName: "DeepSeek" },
    };
    currentNotesMode = "bilingual";
    currentVideoId = "video-original-only";
    notesFilterShowAll = false;
  `);
  const listener = runtime.runtimeMessageListeners[0];
  assert.equal(typeof listener, "function");

  listener(
    {
      action: "noteSaved",
      preserveOriginalOnly: true,
      note: { mediaKey: "different-video" },
    },
    {},
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    actions.map((message) => message.action),
    ["getNotes"],
  );
});

test("note save rejects a tab that changes route before persistence", async () => {
  const videoId = "note-route-a";
  let storedNotes = [];
  let tabReads = 0;
  const mediaRef = {
    platform: "youtube",
    videoId,
    mediaKey: videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") return { ytd_settings: {} };
      if (key === `digest_${videoId}`) {
        return {
          [`digest_${videoId}`]: {
            transcriptSourcePolicyVersion: 5,
            transcriptSource: "youtube-passive",
            transcriptLanguage: "en",
            transcript: [{ start: 0, text: "Route A note.", language: "en" }],
          },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (Array.isArray(items.ytd_notes)) storedNotes = items.ytd_notes;
    },
    tabsImpl: {
      get: async () => {
        tabReads += 1;
        return {
          id: 42,
          url:
            tabReads === 1
              ? `https://www.youtube.com/watch?v=${videoId}`
              : "https://www.youtube.com/watch?v=note-route-b",
        };
      },
    },
  });

  const result = await background.handleSaveNote(
    mediaRef,
    9,
    "Route A",
    "Channel",
    mediaRef.canonicalUrl,
    42,
    "en",
    `youtube:${videoId}`,
    true,
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "PAGE_CONTEXT_CHANGED");
  assert.equal(storedNotes.length, 0);
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

test("overview timestamps resolve from local cue ids, never model seconds", () => {
  const background = loadBackgroundHelpers();
  const cues = [
    { cueId: "cue-0", timestampSeconds: 0, text: "Opening" },
    { cueId: "cue-1", timestampSeconds: 20, text: "Main topic" },
    { cueId: "cue-2", timestampSeconds: 55, text: "Closing" },
  ];
  const normalized = background.validateAndFixTimestamps(
    {
      chapters: [
        {
          cueId: "cue-1",
          timestampSeconds: 7,
          titleZh: "主题",
          summaryZh: "进入主要内容。",
        },
      ],
      keyQuotes: [
        {
          cueId: "unknown-cue",
          timestampSeconds: 52,
          quoteOriginal: "Closing",
          quoteZh: "收尾。",
        },
      ],
      keyMoments: ["cue-0", 19],
    },
    55,
    "en",
    cues,
  );

  assert.equal(normalized.timestampAnchorVersion, 1);
  assert.equal(normalized.chapters[0].cueId, "cue-1");
  assert.equal(normalized.chapters[0].timestampSeconds, 20);
  assert.equal(normalized.keyQuotes[0].cueId, "cue-2");
  assert.equal(normalized.keyQuotes[0].timestampSeconds, 55);
  assert.deepEqual(normalized.keyMoments, [0, 20]);
});

test("overview cues share transcript display segments and canonical seek starts", () => {
  const helpers = loadSidepanelHelpers();
  const raw = [
    {
      start: 10,
      duration: 30,
      text: "这是一个没有标点而且足够长需要被拆成多个阅读段落的中文字幕内容用于验证时间显示不会再按字符比例伪造新的跳转时间这是同一个原始字幕块的后半部分",
    },
  ];
  const segments = helpers.groupTranscriptEntries(raw);
  const cues = helpers.buildOverviewAnalysisCues(raw);

  assert.ok(segments.length > 1);
  assert.ok(segments.some((segment) => segment.start > 10));
  assert.ok(segments.every((segment) => segment.seekStart === 10));
  assert.deepEqual(
    cues.map((cue) => cue.timestampSeconds),
    cues.map(() => 10),
  );
  assert.deepEqual(
    cues.map((cue) => cue.text),
    segments.map((segment) => segment.text),
  );
});

test("overview repairs raw control characters inside model JSON strings", async () => {
  const malformedContent = `{
    "detectedSourceLanguage": "en",
    "chapters": [{
      "titleZh": "开场",
      "summaryZh": "第一行,}
第二行\t补充",
      "timestampSeconds": 0
    }],
    "keyQuotes": [{
      "quoteOriginal": "He said \\"hello\\".\\nEscaped line.\\tTabbed.
Raw line.",
      "quoteZh": "你好，\r
世界。",
      "timestampSeconds": 0
    }],
    "keyMoments": [0],
  }`;
  let providerCalls = 0;
  const background = loadBackgroundHelpers({
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/analysis.md") };
      }
      providerCalls += 1;
      return streamingResponse([
        encode(JSON.stringify({
          choices: [{ message: { content: malformedContent } }],
        })),
      ]);
    },
  });

  const result = await background.handleAnalyzeTranscript(
    "[0:00] Hello world.",
    "Example video",
    "Example channel",
    "Example description",
    60,
    "en",
  );

  assert.equal(result.success, true);
  assert.equal(providerCalls, 1, "local repair does not spend a retry");
  assert.equal(
    result.analysis.chapters[0].summaryZh,
    "第一行,}\n第二行\t补充",
  );
  assert.equal(
    result.analysis.keyQuotes[0].quoteOriginal,
    'He said "hello".\nEscaped line.\tTabbed.\nRaw line.',
  );
  assert.equal(result.analysis.keyQuotes[0].quoteZh, "你好，\r\n世界。");
});

test("AI entry points fail closed with free-core guidance when no key is saved", async () => {
  let providerCalls = 0;
  const background = loadBackgroundHelpers({
    settings: { provider: "zhipu", aiApiKeys: { zhipu: "" } },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    },
  });

  const overview = await background.handleAnalyzeTranscript(
    "[0:00] Hello world.",
    "Example video",
    "Example channel",
    "Example description",
    60,
    "en",
  );
  assert.equal(overview.success, false);
  assert.equal(overview.error, "NO_AI_KEY");
  assert.match(overview.message, /字幕阅读、时间跳转和原文笔记仍可使用/);
  assert.match(overview.message, /智谱 GLM API 密钥/);

  const transcript = await background.handleTranslateContent(
    { segments: [{ id: "segment-1", text: "Hello world." }] },
    "transcriptBatch",
    "zh",
    "Example video",
  );
  assert.equal(transcript.success, false);
  assert.equal(transcript.code, "NO_AI_KEY");
  assert.equal(transcript.actualProviderCalls, 0);
  assert.match(transcript.error, /字幕阅读、时间跳转和原文笔记仍可使用/);
  assert.equal(providerCalls, 0);
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
  assert.equal(background.shouldUseChineseNoteCleanup("youtube", "zh-CN"), true);
  assert.equal(background.shouldUseChineseNoteCleanup("youtube", "zh-TW"), true);
  assert.equal(background.shouldUseChineseNoteCleanup("bilibili", "zh-CN"), true);
  assert.equal(background.shouldUseChineseNoteCleanup("bilibili", "zh-TW"), false);
  assert.equal(background.shouldUseChineseNoteCleanup("youtube", "ja"), false);
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

test("Bilibili v4 cache note saves polished Chinese once without refetching", async () => {
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
            transcriptSourcePolicyVersion: 4,
            transcriptSource: "bilibili",
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
  assert.equal(result.note.timestampSeconds, 0);
  assert.match(result.note.timestampedUrl, /BV1zfg36ZEXi\/\?t=0$/);
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
            transcriptSourcePolicyVersion: 4,
            transcriptSource: "bilibili",
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

test("saving a YouTube note also freezes exact page metadata for later export", async () => {
  const videoId = "save-source-yt";
  const noteSources = require("../note-sources.js");
  const storage = createMemoryStorage({
    ytd_settings: {},
    ytd_notes: [],
    [`digest_${videoId}`]: {
      transcriptSourcePolicyVersion: 5,
      transcriptSource: "supadata",
      transcriptLanguage: "zh-CN",
      transcript: [
        { start: 0, text: "保存笔记时同时保存页面资料。", language: "zh-CN" },
      ],
    },
  });
  const background = loadBackgroundHelpers({
    storageGetImpl: storage.get,
    storageSetImpl: storage.set,
    storageRemoveImpl: storage.remove,
    storageClearImpl: storage.clear,
    tabsImpl: {
      get: async () => ({
        id: 77,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      }),
    },
    scriptingImpl: {
      async executeScript() {
        return [{
          result: {
            videoId,
            title: "精确页面标题",
            channelName: "精确频道",
            description: "这是完整的视频简介。",
            descriptionStatus: "present",
            descriptionTruncated: false,
            duration: 900,
            sourceLanguage: "en",
          },
        }];
      },
    },
  });

  const result = await background.handleSaveNote(
    videoId,
    1,
    "按钮标题",
    "按钮频道",
    `https://www.youtube.com/watch?v=${videoId}`,
    77,
  );

  assert.equal(result.success, true);
  const source = await noteSources.readNoteSource(storage, videoId);
  assert.equal(source.titleOriginal, "精确页面标题");
  assert.equal(source.channelName, "精确频道");
  assert.equal(source.canonicalUrl, `https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(source.descriptionOriginal, "这是完整的视频简介。");
  assert.equal(source.descriptionStatus, "present");
  assert.equal(source.descriptionTruncated, false);
  assert.equal(source.sourceLanguage, "zh-CN", "actual caption language wins");
  assert.equal(source.transcriptOriginal.length, 1);
});

test("a stale YouTube player cannot block the note or attach another video's source", async () => {
  const videoId = "save-source-current";
  const noteSources = require("../note-sources.js");
  const storage = createMemoryStorage({
    ytd_settings: {},
    ytd_notes: [],
    [`digest_${videoId}`]: {
      transcriptSourcePolicyVersion: 5,
      transcriptSource: "supadata",
      transcriptLanguage: "zh-CN",
      transcript: [{ start: 0, text: "当前视频字幕。", language: "zh-CN" }],
    },
  });
  const background = loadBackgroundHelpers({
    storageGetImpl: storage.get,
    storageSetImpl: storage.set,
    storageRemoveImpl: storage.remove,
    storageClearImpl: storage.clear,
    tabsImpl: {
      get: async () => ({
        id: 78,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      }),
    },
    scriptingImpl: {
      async executeScript() {
        return [{
          result: {
            videoId: "different-video",
            title: "错误视频",
            channelName: "错误频道",
            description: "错误简介",
            descriptionStatus: "present",
            descriptionTruncated: false,
          },
        }];
      },
    },
  });

  const result = await background.handleSaveNote(
    videoId,
    1,
    "当前视频",
    "当前频道",
    `https://www.youtube.com/watch?v=${videoId}`,
    78,
  );

  assert.equal(result.success, true);
  assert.equal((await storage.get("ytd_notes")).ytd_notes.length, 1);
  assert.equal(await noteSources.readNoteSource(storage, videoId), null);
  assert.equal(await noteSources.readNoteSource(storage, "different-video"), null);
});

test("source persistence failure never reverses a successful note save", async () => {
  const videoId = "save-source-failure";
  const noteSources = require("../note-sources.js");
  const storage = createMemoryStorage({
    ytd_settings: {},
    ytd_notes: [],
    [`digest_${videoId}`]: {
      transcriptSourcePolicyVersion: 5,
      transcriptSource: "supadata",
      transcriptLanguage: "zh-CN",
      transcript: [{ start: 0, text: "笔记应继续保存。", language: "zh-CN" }],
    },
  });
  const background = loadBackgroundHelpers({
    storageGetImpl: storage.get,
    storageSetImpl: storage.set,
    storageRemoveImpl: storage.remove,
    storageClearImpl: storage.clear,
    tabsImpl: {
      get: async () => ({
        id: 79,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      }),
    },
    noteSourcesImpl: {
      ...noteSources,
      async writeNoteSource() {
        throw new Error("simulated source storage failure");
      },
    },
    scriptingImpl: {
      async executeScript() {
        return [{
          result: {
            videoId,
            title: "视频",
            channelName: "频道",
            description: "简介",
            descriptionStatus: "present",
            descriptionTruncated: false,
          },
        }];
      },
    },
  });

  const result = await background.handleSaveNote(
    videoId,
    1,
    "视频",
    "频道",
    `https://www.youtube.com/watch?v=${videoId}`,
    79,
  );

  assert.equal(result.success, true);
  assert.equal((await storage.get("ytd_notes")).ytd_notes.length, 1);
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

// ----------------------------------------------------------------
// Note video title translation
// ----------------------------------------------------------------

function loadTitleTranslationBackground({
  notesResponse,
  titlesResponse,
  onProviderCall = () => {},
  storedNotesRef,
} = {}) {
  const isTitleRequest = (options) => {
    try {
      const body = JSON.parse(options.body);
      return String(body.messages?.[1]?.content || "").includes('"titles"');
    } catch (_error) {
      return false;
    }
  };
  return loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") return { ytd_settings: { aiApiKey: "test-key" } };
      if (key === "ytd_notes") return { ytd_notes: storedNotesRef.notes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (Array.isArray(items.ytd_notes)) storedNotesRef.notes = items.ytd_notes;
    },
    fetchImpl: async (url, options) => {
      if (String(url).startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      const forTitles = isTitleRequest(options);
      onProviderCall(forTitles ? "titles" : "notes");
      const content = forTitles ? titlesResponse : notesResponse;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    },
  });
}

test("one title translation is generated per media identity and backfilled to every note", async () => {
  const notes = [
    {
      id: "n1",
      videoId: "vid1",
      mediaKey: "vid1",
      platform: "youtube",
      videoTitle: "The Future of AI",
      text: "First english note.",
      translatedText: "",
    },
    {
      id: "n2",
      videoId: "vid1",
      mediaKey: "vid1",
      platform: "youtube",
      videoTitle: "The Future of AI",
      text: "Second english note.",
      translatedText: "",
    },
  ];
  const storedNotesRef = { notes };
  const providerCalls = [];
  const background = loadTitleTranslationBackground({
    storedNotesRef,
    onProviderCall: (kind) => providerCalls.push(kind),
    notesResponse: JSON.stringify({
      notes: [
        { id: "n1", textZh: "第一条中文笔记。" },
        { id: "n2", textZh: "第二条中文笔记。" },
      ],
    }),
    titlesResponse: JSON.stringify({
      titles: [{ mediaKey: "vid1", titleZh: "人工智能的未来" }],
    }),
  });

  const result = await background.handleTranslateNotes({
    notes: notes.map((note) => ({ id: note.id, text: note.text, videoTitle: note.videoTitle, platform: "youtube" })),
    titles: [{ mediaKey: "vid1", title: "The Future of AI" }],
  });

  assert.equal(result.success, true);
  assert.equal(providerCalls.filter((kind) => kind === "titles").length, 1, "exactly one title provider call for the shared media");
  assert.equal(result.titles.length, 1);
  assert.equal(result.titles[0].mediaKey, "vid1");
  assert.equal(result.titles[0].titleZh, "人工智能的未来");
  // Both notes of the same media are backfilled with the validated title.
  assert.equal(storedNotesRef.notes.length, 2);
  storedNotesRef.notes.forEach((note) => {
    assert.equal(note.videoTitleZh, "人工智能的未来");
    assert.equal(note.videoTitleZhValidated, true);
    assert.equal(note.videoTitleZhValidationVersion, 1);
  });
});

test("a failed body still lets the title translate, and vice versa", async () => {
  // Body fails (empty), title succeeds.
  const bodyFail = { notes: [{ id: "n1", mediaKey: "vid1", videoId: "vid1", platform: "youtube", videoTitle: "Deep Dive", text: "English body.", translatedText: "" }] };
  const refA = { notes: bodyFail.notes };
  const backgroundA = loadTitleTranslationBackground({
    storedNotesRef: refA,
    notesResponse: JSON.stringify({ notes: [{ id: "n1", textZh: "" }] }),
    titlesResponse: JSON.stringify({ titles: [{ mediaKey: "vid1", titleZh: "深入解析" }] }),
  });
  const resultA = await backgroundA.handleTranslateNotes({
    notes: [{ id: "n1", text: "English body.", videoTitle: "Deep Dive", platform: "youtube" }],
    titles: [{ mediaKey: "vid1", title: "Deep Dive" }],
  });
  assert.equal(resultA.translations.length, 0, "body did not translate");
  assert.ok(resultA.failures.some((f) => f.id === "n1"));
  assert.equal(resultA.titles.length, 1, "title still translated");
  assert.equal(resultA.titles[0].titleZh, "深入解析");
  assert.equal(refA.notes[0].videoTitleZh, "深入解析");
  assert.equal(refA.notes[0].translatedText, "");

  // Body succeeds, title fails validation (returns English).
  const refB = { notes: [{ id: "n1", mediaKey: "vid2", videoId: "vid2", platform: "youtube", videoTitle: "Another One", text: "English body.", translatedText: "" }] };
  const backgroundB = loadTitleTranslationBackground({
    storedNotesRef: refB,
    notesResponse: JSON.stringify({ notes: [{ id: "n1", textZh: "英文正文的中文翻译。" }] }),
    titlesResponse: JSON.stringify({ titles: [{ mediaKey: "vid2", titleZh: "Another One" }] }),
  });
  const resultB = await backgroundB.handleTranslateNotes({
    notes: [{ id: "n1", text: "English body.", videoTitle: "Another One", platform: "youtube" }],
    titles: [{ mediaKey: "vid2", title: "Another One" }],
  });
  assert.equal(resultB.translations[0].textZh, "英文正文的中文翻译。", "body translated");
  assert.equal(resultB.titles.length, 0, "English title rejected");
  assert.ok(resultB.titleFailures.some((f) => f.mediaKey === "vid2" && f.code === "INVALID_TRANSLATION"));
  assert.equal(refB.notes[0].videoTitleZh, undefined, "no invalid title persisted");
  assert.equal(refB.notes[0].translatedText, "英文正文的中文翻译。");
});

test("a title-only request translates without any note bodies", async () => {
  const refC = { notes: [{ id: "n1", mediaKey: "vid3", videoId: "vid3", platform: "youtube", videoTitle: "Title Only", text: "已经翻译好的中文笔记。", translatedText: "已经翻译好的中文笔记。", translatedValidated: true, translatedValidationVersion: 1 }] };
  const providerCalls = [];
  const backgroundC = loadTitleTranslationBackground({
    storedNotesRef: refC,
    onProviderCall: (kind) => providerCalls.push(kind),
    notesResponse: JSON.stringify({ notes: [] }),
    titlesResponse: JSON.stringify({ titles: [{ mediaKey: "vid3", titleZh: "只有标题" }] }),
  });
  const resultC = await backgroundC.handleTranslateNotes({
    notes: [],
    titles: [{ mediaKey: "vid3", title: "Title Only" }],
  });
  assert.equal(resultC.success, true);
  assert.equal(providerCalls.length, 1, "no note-body provider call when notes are empty");
  assert.equal(providerCalls[0], "titles");
  assert.equal(resultC.titles.length, 1);
  assert.equal(resultC.titles[0].titleZh, "只有标题");
  assert.equal(refC.notes[0].videoTitleZh, "只有标题");
});

test("note title request/candidate validators enforce the contract", () => {
  const background = loadBackgroundHelpers();
  // De-dup by mediaKey, skip invalid, cap at 10.
  const normalized = background.validateNoteTitleTranslationRequest([
    { mediaKey: "vid1", title: "A" },
    { mediaKey: "vid1", title: "duplicate skipped" },
    { mediaKey: "bad key!", title: "invalid" },
    { mediaKey: "vid2", title: "" },
    { mediaKey: "vid3", title: "B" },
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].mediaKey, "vid1");
  assert.equal(normalized[0].title, "A");
  assert.equal(normalized[1].mediaKey, "vid3");
  assert.equal(background.validateNoteTitleTranslationRequest(undefined).length, 0);

  assert.equal(background.validateNoteTitleCandidate({ titleZh: "人工智能" }).titleZh, "人工智能");
  assert.equal(background.validateNoteTitleCandidate({ titleZh: "All English Title" }).failureCode, "INVALID_TRANSLATION");
  assert.equal(background.validateNoteTitleCandidate({ titleZh: "" }).failureCode, "EMPTY_RESPONSE");

  const mapped = background.normalizeNoteTitleTranslation(
    { titles: [{ mediaKey: "vid1", titleZh: "标题一" }, { mediaKey: "vid1", titleZh: "冲突" }] },
    [{ mediaKey: "vid1", title: "T1" }, { mediaKey: "vid2", title: "T2" }],
  );
  assert.equal(mapped[0].failureCode, "MULTIPLE_CANDIDATES");
  assert.equal(mapped[1].failureCode, "MISSING_ITEM");
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
  assert.equal(first.success, true, JSON.stringify(first));
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

test("YouTube getVideoInfo prefers exact player metadata and preserves completeness fields", async () => {
  const tab = {
    id: 31,
    url: "https://www.youtube.com/watch?v=player-video",
  };
  let contentMessageCount = 0;
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        contentMessageCount += 1;
        return {
          videoId: "player-video",
          title: "DOM fallback title",
          channelName: "DOM fallback channel",
          description: "Truncated fallback",
          descriptionStatus: "unknown",
          descriptionTruncated: true,
        };
      },
    },
    scriptingImpl: {
      async executeScript() {
        return [
          {
            result: {
              videoId: "player-video",
              title: "Canonical title",
              channelName: "Canonical channel",
              description: "Complete canonical description",
              descriptionStatus: "present",
              descriptionTruncated: false,
              duration: 123,
              sourceLanguage: "en",
            },
          },
        ];
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(contentMessageCount, 0, "canonical player data needs no content receiver");
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    success: true,
    response: {
      videoId: "player-video",
      title: "Canonical title",
      channelName: "Canonical channel",
      description: "Complete canonical description",
      descriptionStatus: "present",
      descriptionTruncated: false,
      duration: 123,
      sourceLanguage: "en",
      captionSelection: null,
    },
  });
});

test("the real MAIN-world player callback emits complete present-description metadata", async () => {
  const tab = {
    id: 40,
    url: "https://www.youtube.com/watch?v=real-player-callback",
  };
  let contentMessageCount = 0;
  const playerResponse = {
    videoDetails: {
      videoId: "real-player-callback",
      title: "Real callback title",
      author: "Real callback channel",
      shortDescription: "Real callback description",
      lengthSeconds: "321",
      defaultAudioLanguage: "en",
    },
  };
  const background = loadBackgroundHelpers({
    pageDocumentImpl: {
      getElementById(id) {
        return id === "movie_player"
          ? { getPlayerResponse: () => playerResponse }
          : null;
      },
    },
    pageWindowImpl: {},
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        contentMessageCount += 1;
        return null;
      },
    },
    scriptingImpl: {
      async executeScript({ func, world }) {
        if (world === "ISOLATED") {
          return [
            {
              result: {
                ready: true,
                videoId: "real-player-callback",
              },
            },
          ];
        }
        return [{ result: func() }];
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(contentMessageCount, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(response.response)), {
    videoId: "real-player-callback",
    title: "Real callback title",
    channelName: "Real callback channel",
    duration: 321,
    sourceLanguage: "en",
    captionSelection: null,
    description: "Real callback description",
    descriptionStatus: "present",
    descriptionTruncated: false,
  });
});

test("the real MAIN-world callback recognizes a confirmed-empty window fallback", async () => {
  const tab = {
    id: 41,
    url: "https://www.youtube.com/watch?v=window-player-fallback",
  };
  let contentMessageCount = 0;
  const background = loadBackgroundHelpers({
    pageDocumentImpl: { getElementById: () => null },
    pageWindowImpl: {
      ytInitialPlayerResponse: {
        videoDetails: {
          videoId: "window-player-fallback",
          title: "Window fallback title",
          author: "Window fallback channel",
          shortDescription: "",
          lengthSeconds: "12",
        },
      },
    },
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        contentMessageCount += 1;
        return null;
      },
    },
    scriptingImpl: {
      async executeScript({ func, world }) {
        if (world === "ISOLATED") {
          return [
            {
              result: {
                ready: true,
                videoId: "window-player-fallback",
              },
            },
          ];
        }
        return [{ result: func() }];
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(contentMessageCount, 0);
  assert.equal(response.response.videoId, "window-player-fallback");
  assert.equal(response.response.description, "");
  assert.equal(response.response.descriptionStatus, "confirmed-empty");
  assert.equal(response.response.descriptionTruncated, false);
});

test("YouTube getVideoInfo ignores stale player data and accepts the exact content response", async () => {
  const tab = {
    id: 32,
    url: "https://www.youtube.com/watch?v=current-video",
  };
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        return {
          videoId: "current-video",
          title: "Current title",
          channelName: "Current channel",
          description: "Current complete description",
          descriptionStatus: "present",
          descriptionTruncated: false,
          duration: 456,
          sourceLanguage: "en",
        };
      },
    },
    scriptingImpl: {
      async executeScript() {
        return [
          {
            result: {
              videoId: "previous-video",
              title: "Stale title",
              channelName: "Stale channel",
              description: "Stale description",
              descriptionStatus: "present",
              descriptionTruncated: false,
              duration: 999,
              sourceLanguage: "fr",
            },
          },
        ];
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(response.success, true);
  assert.equal(response.response.videoId, "current-video");
  assert.equal(response.response.title, "Current title");
  assert.equal(response.response.description, "Current complete description");
  assert.equal(response.response.descriptionStatus, "present");
  assert.equal(response.response.descriptionTruncated, false);
});

test("YouTube getVideoInfo falls back to exact content when player description is not ready", async () => {
  const tab = {
    id: 34,
    url: "https://www.youtube.com/watch?v=description-fallback",
  };
  let contentMessageCount = 0;
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        contentMessageCount += 1;
        return {
          videoId: "description-fallback",
          title: "Content title",
          channelName: "Content channel",
          description: "Exact embedded description",
          descriptionStatus: "present",
          descriptionTruncated: false,
        };
      },
    },
    scriptingImpl: {
      async executeScript() {
        return [
          {
            result: {
              videoId: "description-fallback",
              title: "Player title",
              channelName: "Player channel",
              description: "",
              descriptionStatus: "unknown",
              descriptionTruncated: false,
            },
          },
        ];
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(contentMessageCount, 1);
  assert.equal(response.success, true);
  assert.equal(response.response.videoId, "description-fallback");
  assert.equal(response.response.title, "Player title");
  assert.equal(response.response.description, "Exact embedded description");
  assert.equal(response.response.descriptionStatus, "present");
  assert.equal(response.response.descriptionTruncated, false);
});

test("YouTube getVideoInfo rejects mismatched player and content identities", async () => {
  const tab = {
    id: 35,
    url: "https://www.youtube.com/watch?v=expected-video",
  };
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        return {
          videoId: "other-content-video",
          title: "Wrong content title",
          descriptionStatus: "present",
          description: "Wrong content description",
        };
      },
    },
    scriptingImpl: {
      async executeScript() {
        return [
          {
            result: {
              videoId: "other-player-video",
              title: "Wrong player title",
              descriptionStatus: "present",
              description: "Wrong player description",
            },
          },
        ];
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(response.success, false);
  assert.equal(response.error, "PAGE_CONTEXT_CHANGED");
  assert.match(response.message, /页面已切换/);
});

test("YouTube getVideoInfo rejects mismatched content while exact player data is incomplete", async () => {
  const tab = {
    id: 39,
    url: "https://www.youtube.com/watch?v=expected-incomplete",
  };
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        return {
          videoId: "other-content-video",
          title: "Wrong content title",
          channelName: "Wrong content channel",
          description: "Wrong content description",
          descriptionStatus: "present",
          descriptionTruncated: false,
        };
      },
    },
    scriptingImpl: {
      async executeScript() {
        return [
          {
            result: {
              videoId: "expected-incomplete",
              title: "Expected title",
              channelName: "Expected channel",
              description: "",
              descriptionStatus: "unknown",
              descriptionTruncated: false,
            },
          },
        ];
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(response.success, false);
  assert.equal(response.error, "PAGE_CONTEXT_CHANGED");
  assert.match(response.message, /页面已切换/);
  assert.equal(response.response, undefined);
});

test("YouTube getVideoInfo requires refresh for a legacy response without videoId", async () => {
  const tab = {
    id: 37,
    url: "https://www.youtube.com/watch?v=legacy-response",
  };
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        return {
          title: "Legacy title without identity",
          channelName: "Legacy channel",
          description: "Legacy description",
        };
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(response.success, false);
  assert.equal(response.error, "PAGE_REFRESH_REQUIRED");
  assert.match(response.message, /刷新页面后再补充/);
  assert.equal(response.response, undefined);
});

test("YouTube getVideoInfo requires refresh when legacy content omits truncation evidence", async () => {
  const tab = {
    id: 38,
    url: "https://www.youtube.com/watch?v=legacy-truncation",
  };
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        return {
          videoId: "legacy-truncation",
          title: "Legacy title",
          channelName: "Legacy channel",
          description: "Collapsed legacy description...",
          descriptionStatus: "present",
        };
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(response.success, false);
  assert.equal(response.error, "PAGE_REFRESH_REQUIRED");
  assert.match(response.message, /刷新页面后再补充/);
  assert.equal(response.response, undefined);
});

test("a confirmed-empty player description never adopts a truncated DOM fallback", async () => {
  const tab = {
    id: 36,
    url: "https://www.youtube.com/watch?v=empty-description",
  };
  let contentMessageCount = 0;
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [tab];
      },
      async sendMessage() {
        contentMessageCount += 1;
        return {
          videoId: "empty-description",
          description: "Stale truncated text...",
          descriptionStatus: "unknown",
          descriptionTruncated: true,
        };
      },
    },
    scriptingImpl: {
      async executeScript() {
        return [
          {
            result: {
              videoId: "empty-description",
              title: "Empty description video",
              channelName: "Channel",
              description: "",
              descriptionStatus: "confirmed-empty",
              descriptionTruncated: false,
            },
          },
        ];
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(contentMessageCount, 0);
  assert.equal(response.success, true);
  assert.equal(response.response.description, "");
  assert.equal(response.response.descriptionStatus, "confirmed-empty");
  assert.equal(response.response.descriptionTruncated, false);
});

test("relayToContent honors a supported pending URL while a new tab is committing", async () => {
  const tab = {
    id: 33,
    url: "about:blank",
    pendingUrl: "https://www.youtube.com/watch?v=pending-video",
  };
  const background = loadBackgroundHelpers({
    tabsImpl: {
      async get() {
        return tab;
      },
      async query() {
        return [];
      },
      async sendMessage() {
        return {
          videoId: "pending-video",
          title: "Pending video",
          channelName: "Channel",
          description: "Description",
          descriptionStatus: "present",
          descriptionTruncated: false,
        };
      },
    },
  });

  const response = await dispatchBackgroundMessage(background, {
    action: "relayToContent",
    tabId: tab.id,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(response.success, true);
  assert.equal(response.response.videoId, "pending-video");
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

test("Chinese display fragments preserve raw cue boundaries and internal spaces", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const raw = [
    { start: 0, text: "AI Agent Skill 保留 natural spaces" },
    { start: 2, text: "第二个 cue 继续" },
    { start: 4, text: "第三个 cue 结束" },
  ];
  const segments = groupTranscriptEntries(raw, {
    minChars: 1,
    idealChars: 999,
    maxChars: 999,
    maxSeconds: 999,
  });

  assert.equal(segments.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(segments[0].texts)),
    raw.map((entry) => entry.text),
  );
  assert.match(segments[0].texts[0], /AI Agent Skill/);
  assert.match(segments[0].texts[0], /保留 natural spaces/);
  assert.doesNotMatch(segments[0].text, /\n|“|”/);
});

test("guardrail splits one oversized raw cue without inventing raw cue boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);

  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.texts.length === 1));
  assert.equal(
    segments.map((segment) => segment.text).join(" "),
    segments.flatMap((segment) => segment.texts).join(" "),
  );
});

test("sentence pieces from one raw cue remain one visual fragment", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [{ start: 0, text: "第一句。第二句。第三句。" }],
    { minChars: 100, idealChars: 999, maxChars: 999, maxSeconds: 999 },
  );

  assert.equal(segments.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(segments[0].texts)), [
    "第一句。第二句。第三句。",
  ]);
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

test("Chinese transcript fragments use block boundaries without invented delimiters", () => {
  const helpers = loadSidepanelHelpers();
  assert.equal(helpers.needsVisualChineseQuotes("这是一段没有标点的中文"), true);
  assert.equal(helpers.needsVisualChineseQuotes("这是一段有标点的中文。"), false);
  assert.equal(helpers.needsVisualChineseQuotes("“已经有引号”"), false);
  assert.equal(helpers.needsVisualChineseQuotes("English without punctuation"), false);

  const fragments = [
    "第一段有标点。",
    "第二个 cue 保留 internal spaces",
    "“第三段已经有引号”",
  ];
  const renderedFragments = helpers.renderTranscriptVisualFragments(fragments);
  assert.match(
    renderedFragments,
    /class="transcript-fragment-line">第一段有标点。<\/span>/,
  );
  assert.match(
    renderedFragments,
    /class="transcript-fragment-line">第二个 cue 保留 internal spaces<\/span>/,
  );
  assert.match(
    renderedFragments,
    /class="transcript-fragment-line">“第三段已经有引号”<\/span>/,
  );
  assert.equal(
    (renderedFragments.match(/transcript-fragment-line/g) || []).length,
    3,
  );
  assert.doesNotMatch(renderedFragments, /chinese-visual-quote/);
  assert.doesNotMatch(renderedFragments, /“第一段|”第二个/);

  const segment = {
    id: "segment-0-0",
    text: "第一段有标点。第二个 cue 保留 internal spaces",
    texts: fragments.slice(0, 2),
  };
  const canonicalText = segment.text;
  const cacheKey = helpers.transcriptTranslationCacheKey("video-1", segment);
  helpers.renderTranscriptVisualFragments(segment.texts);
  assert.equal(segment.text, canonicalText);
  assert.equal(
    helpers.transcriptTranslationCacheKey("video-1", segment),
    cacheKey,
  );

  const rendered = helpers.renderTranscriptSegmentContent(
    { text: "English source." },
    "zh",
    "这是一段有标点的中文。",
    "",
  );
  assert.match(
    rendered,
    /transcript-translation[^"]*"><span class="transcript-fragment-line">这是一段有标点的中文。<\/span>/,
  );
  assert.doesNotMatch(rendered, /“这是一段有标点的中文。”/);
  assert.doesNotMatch(rendered, /chinese-visual-quote/);
  const renderTranscriptSource = read("sidepanel.js").match(
    /function renderTranscript\(\)[\s\S]*?function copyTranscript\(/,
  )?.[0];
  assert.match(renderTranscriptSource || "", /renderTranscriptVisualFragments\(group\.texts\)/);
  assert.doesNotMatch(renderTranscriptSource || "", /chineseVisualQuoteClass\(group\.text\)/);
  assert.match(
    read("sidepanel.css"),
    /\.transcript-fragment-line\s*\{[\s\S]*?display:\s*block/,
  );

  const note = {
    platform: "youtube",
    sourceLanguage: "zh-CN",
    textLanguage: "zh-CN",
    text: "“已经有引号”",
    rawText: "已经有引号",
  };
  assert.doesNotMatch(
    helpers.renderNoteLanguageContent(note, "original"),
    /““|””/,
  );
});

test("transcript fragment rendering keeps safe subtitle formatting and escapes arbitrary HTML", () => {
  const { renderTranscriptVisualFragments } = loadSidepanelHelpers();
  const html = renderTranscriptVisualFragments([
    "<i>第一 cue</i><br>保留行内换行",
    '<strong>第二 cue</strong><img src=x onerror="alert(1)">',
  ]);

  assert.match(html, /<i>第一 cue<\/i><br>保留行内换行/);
  assert.match(html, /<strong>第二 cue<\/strong>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img\b/);
  assert.equal((html.match(/transcript-fragment-line/g) || []).length, 2);
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

test("an unterminated translation JSON response retries once and recovers", async () => {
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
            finish_reason: "stop",
            message: {
              content: requests.length === 1
                ? '{"segments":[{"id":"segment-0-0","text":"没有结束的字符串'
                : '{"segments":[{"id":"segment-0-0","text":"完整中文译文。"}]}',
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
  assert.equal(result.translatedContent.segments[0].text, "完整中文译文。");
});

test("repeated unterminated translation JSON becomes a product error, not a throw", async () => {
  let providerCalls = 0;
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      providerCalls += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            finish_reason: "stop",
            message: {
              content: '{"segments":[{"id":"segment-0-0","text":"仍然被截断',
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
  assert.equal(result.success, false);
  assert.equal(result.code, "INVALID_JSON");
  assert.match(result.error, /JSON 不完整.*重试/);
  assert.equal(providerCalls, 2, "malformed output recovery stays bounded");
});

test("long export translation batches receive a scaled output budget", async () => {
  let body;
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                segments: Array.from({ length: 4 }, (_, index) => ({
                  id: `s${index}`,
                  text: `第${index + 1}段完整译文。`,
                })),
              }),
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    {
      segments: Array.from({ length: 4 }, (_, index) => ({
        id: `s${index}`,
        text: "a".repeat(3000),
      })),
    },
    "transcriptBatch",
    "zh",
    "Long video",
  );
  assert.equal(result.success, true);
  assert.equal(body.max_tokens, 8192);
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

test("YouTube Chinese notes use the same contextual cleanup as Bilibili", async () => {
  const videoId = "vid_zh";
  const settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  };
  const makeDigest = (language) => ({
    transcriptSourcePolicyVersion: 5,
    transcriptSource: "supadata",
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
      fetchImpl: async (url, options) => {
        if (url.startsWith("chrome-extension://")) {
          return { ok: true, text: async () => read("prompts/note-cleanup.md") };
        }
        // Only the DeepSeek cleanup endpoint reaches here.
        cleanupCalls += 1;
        const request = JSON.parse(options.body);
        const chinesePrompt = request.messages.some((message) =>
          /整理成通顺、完整、可独立阅读的中文笔记/.test(message.content),
        );
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    quote: chinesePrompt
                      ? "整理后的中文笔记。"
                      : "Cleaned English.",
                  }),
                },
              },
            ],
          }),
        };
      },
    });
    const result = await background.handleSaveNote(videoId, 10, "视频", "频道");
    return { result, savedNote, cleanupCalls };
  };

  // Trusted YouTube Chinese tracks now share the contextual Chinese cleanup
  // contract instead of storing a single raw caption fragment.
  for (const language of ["zh-CN", "zh-Hans", "zh-SG", "zh-Hant", "zh-TW"]) {
    const { result, savedNote, cleanupCalls } = await runSave(language);
    assert.equal(result.success, true, `${language} save should succeed`);
    assert.equal(cleanupCalls, 1, `${language} must run one Chinese cleanup`);
    assert.equal(savedNote.text, "整理后的中文笔记。");
    assert.equal(savedNote.rawText, "第二句中文字幕内容。");
    assert.equal(savedNote.sourceLanguage, language);
    assert.equal(savedNote.textLanguage, language);
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

test("free YouTube Chinese notes keep local context and display it without AI", async () => {
  const videoId = "youtube-zh-free-note";
  let storedNote = null;
  let providerCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: {
            provider: "deepseek",
            aiApiKeys: { deepseek: "configured-key" },
          },
        };
      }
      if (key === `digest_${videoId}`) {
        return {
          [`digest_${videoId}`]: {
            transcriptSourcePolicyVersion: 5,
            transcriptSource: "youtube-passive",
            transcript: [
              { start: 0, text: "我们先理解问题", language: "zh-CN" },
              { start: 10, text: "再选择最小方案", language: "zh-CN" },
              { start: 20, text: "最后开始实现", language: "zh-CN" },
            ],
          },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: [] };
      return {};
    },
    storageSetImpl: async (items) => {
      if (Array.isArray(items.ytd_notes)) storedNote = items.ytd_notes[0];
    },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("skipAiCleanup must not call the provider");
    },
  });

  const result = await background.handleSaveNote(
    videoId,
    10,
    "中文视频",
    "频道",
    `https://www.youtube.com/watch?v=${videoId}`,
    null,
    "zh-CN",
    "",
    true,
  );

  assert.equal(result.success, true);
  assert.equal(providerCalls, 0);
  assert.equal(storedNote.textLanguage, "zh-CN");
  assert.equal(storedNote.rawText, "再选择最小方案");
  assert.match(storedNote.text, /我们先理解问题.*再选择最小方案.*最后开始实现/);
  assert.equal(storedNote.timestampSeconds, 10);
  assert.equal(loadSidepanelHelpers().noteOriginalText(storedNote), storedNote.text);
  assert.equal(
    background.exportStoredNoteOriginalText(storedNote),
    storedNote.text,
  );
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

test("Chinese transcripts never request translation and stay on original", async () => {
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
      IntersectionObserver = class {
        observe() {}
        disconnect() {}
      };
      renderTranscript = () => { renders += 1; };
      setTranscriptModeButtons = (mode) => { modeButtonCalls.push(mode); };
      currentVideoId = "vid_zh";
      currentTranscript = [
        { start: 0, text: "第一段简体中文字幕。" },
        { start: 8, text: "第二段简体中文字幕内容。" },
      ];
      currentTranscriptMode = "original";
      return {
        setLanguage: (language) => {
          currentTranscriptLanguage = language;
          currentTranscriptMode = "original";
          translateContentRequests = 0;
          renders = 0;
          modeButtonCalls.length = 0;
        },
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

  for (const language of [
    "zh",
    "zh-Hans",
    "zh-Hant",
    "zh-CN",
    "zh-TW",
    "cmn",
    "yue",
  ]) {
    fixture.setLanguage(language);

    // The control layer refuses to switch into zh / bilingual.
    await fixture.changeMode("bilingual");
    await fixture.changeMode("zh");
    let snap = JSON.parse(fixture.snapshot());
    assert.equal(snap.translateContentRequests, 0, language);
    assert.equal(snap.mode, "original", `${language} must stay on original`);

    // The fail-safe inside translateTranscript also protects the load-time path
    // (e.g. arriving from an English video still stuck in bilingual mode): it
    // collapses back to original with no request and no pending/duplicate row.
    await fixture.forceTranslate("bilingual");
    snap = JSON.parse(fixture.snapshot());
    assert.equal(snap.translateContentRequests, 0, language);
    assert.equal(snap.mode, "original", `${language} must reset to original`);
    assert.deepEqual(snap.modeButtonCalls, ["original"]);
    assert.ok(snap.renders >= 1, "the fail-safe re-renders the plain transcript");
  }
});

test("non-Chinese transcripts still enter the translation path", async () => {
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

  // English is unaffected: bilingual mode still translates.
  fixture.setLanguage("en");
  await fixture.changeMode("bilingual");
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    translateCalls: 1,
    mode: "bilingual",
  });
});

test("Bilibili original badge folds the language into the source label", () => {
  const runtime = loadSidepanelRuntime();
  const read = (code) => runtime.evaluate(code);
  read(`currentTranscriptSource = "bilibili"; currentTranscriptLanguage = "zh-CN";`);

  read(`currentMediaRef = { platform: "bilibili" };`);
  assert.equal(runtime.helpers.currentPlatformIsBilibili(), true);
  assert.equal(
    runtime.helpers.transcriptOriginalBadgeText(),
    "B 站视频字幕（zh-CN）",
    "Bilibili badge must not append the redundant 原文 mode word",
  );

  // A missing / non-code language degrades to the plain source label.
  read(`currentTranscriptLanguage = "";`);
  assert.equal(runtime.helpers.transcriptOriginalBadgeText(), "B 站视频字幕");

  // YouTube keeps its "<source> · 原文（<lang>）" form.
  read(
    `currentMediaRef = { platform: "youtube" }; currentTranscriptSource = ""; currentTranscriptLanguage = "en";`,
  );
  assert.equal(runtime.helpers.currentPlatformIsBilibili(), false);
  assert.equal(
    runtime.helpers.transcriptOriginalBadgeText(),
    "来自视频字幕 · 原文（en）",
  );
});

test("switching between bilingual and Chinese reuses active translation work", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      let translateCalls = 0;
      let modeOnlyRenders = 0;
      translateTranscript = () => {
        translateCalls += 1;
        return Promise.resolve();
      };
      renderTranscriptTranslationMode = () => {
        modeOnlyRenders += 1;
      };
      setTranscriptModeButtons = () => {};
      currentTranscript = [{ start: 0, text: "English source sentence." }];
      currentTranscriptLanguage = "en";
      currentTranscriptMode = "original";
      return {
        changeMode: (mode) => handleTranscriptModeChange(mode),
        snapshot: () => JSON.stringify({
          translateCalls,
          modeOnlyRenders,
          mode: currentTranscriptMode,
        }),
      };
    })()
  `);

  await fixture.changeMode("bilingual");
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    translateCalls: 1,
    modeOnlyRenders: 0,
    mode: "bilingual",
  });

  // Presentation changes must not restart the provider-backed translation.
  await fixture.changeMode("zh");
  assert.deepEqual(JSON.parse(fixture.snapshot()), {
    translateCalls: 1,
    modeOnlyRenders: 1,
    mode: "zh",
  });
});

test("an in-flight translation result survives a presentation mode change", async () => {
  const runtime = loadSidepanelRuntime();
  const fixture = runtime.evaluate(`
    (() => {
      let resolveRequest;
      let updatedRows = 0;
      sendTranslationMessage = () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        });
      setTranslatingSpinner = () => {};
      updateCache = async () => {};
      updateTranslatedRow = () => {
        updatedRows += 1;
      };
      currentVideoId = "vid_en";
      currentTranscriptMode = "bilingual";
      translationGeneration = 7;
      const segments = [{ id: "segment-0-0", text: "English source." }];
      return {
        start: () =>
          requestTranscriptTranslationBatch(
            [0],
            segments,
            7,
            "vid_en",
            "bilingual",
          ),
        switchMode: () => {
          currentTranscriptMode = "zh";
        },
        finish: () =>
          resolveRequest({
            success: true,
            translatedContent: {
              segments: [{ id: "segment-0-0", text: "中文译文。" }],
            },
          }),
        snapshot: () => JSON.stringify({ updatedRows }),
      };
    })()
  `);

  const pending = fixture.start();
  fixture.switchMode();
  fixture.finish();
  await pending;
  assert.deepEqual(JSON.parse(fixture.snapshot()), { updatedRows: 1 });
});

test("Chinese videos disable the Chinese and bilingual transcript buttons", () => {
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

  for (const language of ["zh", "zh-CN", "zh-TW", "cmn", "yue"]) {
    fixture.apply(language);
    assert.deepEqual(JSON.parse(fixture.snapshot()), [
      { mode: "original", disabled: false, ariaDisabled: null, title: null },
      {
        mode: "zh",
        disabled: true,
        ariaDisabled: "true",
        title: "字幕已是中文，无需翻译。",
      },
      {
        mode: "bilingual",
        disabled: true,
        ariaDisabled: "true",
        title: "字幕已是中文，无需翻译。",
      },
    ]);
  }

  // Switching to an English video re-enables every button.
  fixture.apply("en");
  assert.deepEqual(JSON.parse(fixture.snapshot()), [
    { mode: "original", disabled: false, ariaDisabled: null, title: null },
    { mode: "zh", disabled: false, ariaDisabled: null, title: null },
    { mode: "bilingual", disabled: false, ariaDisabled: null, title: null },
  ]);
});
