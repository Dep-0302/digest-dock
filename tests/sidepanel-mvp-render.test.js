const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this._text = "";
    this._className = "";
    this._innerHTML = "";
  }

  set className(value) {
    this._className = String(value);
    this.classList = new FakeClassList();
    this._className
      .split(/\s+/)
      .filter(Boolean)
      .forEach((item) => this.classList.add(item));
  }

  get className() {
    return this._className;
  }

  set textContent(value) {
    this._text = String(value ?? "");
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent || "").join("");
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
  }

  get innerHTML() {
    return this._innerHTML;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
    this._text = "";
    this._innerHTML = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  addEventListener() {}
}

function createHarness({
  sendMessage = async () => ({}),
  storageGet = async () => ({}),
} = {}) {
  const ids = new Map();
  const element = (id, tag = "div") => {
    const node = new FakeElement(tag, id);
    ids.set(id, node);
    return node;
  };

  const welcome = element("welcomeState");
  const loading = element("loadingState");
  const error = element("errorState");
  const results = element("resultsState");
  results.style.display = "none";
  const tabsNav = element("tabsNav");
  tabsNav.style.display = "none";
  const videoInfo = element("videoInfo");
  videoInfo.style.display = "none";
  element("videoTitle");
  element("videoChannel");
  element("transcriptModeControl");
  element("overviewModeControl");
  element("notesModeControl");
  element("exportTranscriptBtn", "button");
  const stateRegion = element("transcriptStateRegion");
  stateRegion.hidden = true;
  const readyRegion = element("transcriptReadyRegion");

  const transcriptTab = new FakeElement("button", "transcriptTab");
  transcriptTab.dataset.tab = "transcript";
  transcriptTab.classList.add("active");
  const overviewTab = new FakeElement("button", "overviewTab");
  overviewTab.dataset.tab = "overview";
  const notesTab = new FakeElement("button", "notesTab");
  notesTab.dataset.tab = "notes";
  const tabs = [transcriptTab, overviewTab, notesTab];

  const panels = ["transcript", "overview", "notes"].map((name) => {
    const panel = new FakeElement("div", `${name}Panel`);
    panel.dataset.panel = name;
    if (name === "transcript") panel.classList.add("active");
    return panel;
  });

  const document = {
    addEventListener() {},
    getElementById: (id) => ids.get(id) || null,
    querySelectorAll(selector) {
      if (selector === ".tab") return tabs;
      if (selector === ".tab-panel") return panels;
      return [];
    },
    querySelector(selector) {
      if (selector === ".tab.active") {
        return tabs.find((tab) => tab.classList.contains("active")) || null;
      }
      return null;
    },
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
  };

  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document,
    chrome: {
      runtime: {
        onMessage: listeners,
        sendMessage,
        getURL: (value) => `chrome-extension://test/${value}`,
      },
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        onRemoved: listeners,
      },
      storage: {
        local: {
          get: storageGet,
          set: async () => {},
          remove: async () => {},
        },
        onChanged: listeners,
      },
    },
    YTD_SETTINGS: require("../settings.js"),
    BILIBILI_ADAPTER: require("../bilibili.js"),
    YTD_NOTE_EXPORT: require("../note-export.js"),
    YTD_NOTE_SOURCES: require("../note-sources.js"),
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read("sidepanel-state.js"), context);
  vm.runInContext(read("sidepanel-effects.js"), context);
  vm.runInContext(read("sidepanel.js"), context);

  return {
    helpers: sandbox.__YTD_TRANSCRIPT_TESTING__,
    stateApi: sandbox.DIGESTDOCK_SIDEPANEL_STATE,
    evaluate: (code) => vm.runInContext(code, context),
    elements: {
      welcome,
      loading,
      error,
      results,
      tabsNav,
      videoInfo,
      stateRegion,
      readyRegion,
    },
  };
}

function findButtons(node, found = []) {
  if (node?.tagName === "BUTTON") found.push(node);
  for (const child of node?.children || []) findButtons(child, found);
  return found;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function bindCurrentVideo(harness, videoId, generation) {
  harness.evaluate(`currentVideoId = ${JSON.stringify(videoId)}; currentRouteKey = ${JSON.stringify(`youtube:${videoId}`)}; currentMediaRef = { platform: "youtube", videoId: ${JSON.stringify(videoId)}, mediaKey: ${JSON.stringify(videoId)} }; digestGeneration = ${generation}; videoTabId = 7;`);
  return harness.helpers.sidepanelMvpBindSession(videoId, `youtube:${videoId}`);
}

function moveToConsentChoice(harness, videoId, generation) {
  const { helpers, stateApi } = harness;
  const firstTask = bindCurrentVideo(harness, videoId, generation);
  helpers.sidepanelMvpResolveTranscript(
    {
      routeOutcome: "UNKNOWN",
      error: "YOUTUBE_CAPTIONS_REQUIRED",
      requiresCaptionEnable: true,
    },
    firstTask,
  );
  const retryTask = helpers.sidepanelMvpBeginEvent(
    stateApi.EVENTS.USER_RETRY_FREE,
    stateApi.TASK_ORIGINS.USER_RETRY_FREE,
  );
  helpers.sidepanelMvpResolveTranscript(
    {
      routeOutcome: "UNKNOWN",
      error: "SUPADATA_CONSENT_REQUIRED",
      hasSupadataKey: true,
    },
    retryTask,
  );
  return helpers.getSidepanelMvpState();
}

test("persistent shell survives loading, CC guidance, retry, and ready transitions", () => {
  const harness = createHarness();
  const { helpers, stateApi, elements } = harness;
  const firstTask = helpers.sidepanelMvpBindSession(
    "video-1",
    "youtube:video-1",
  );

  assert.equal(elements.welcome.style.display, "none");
  assert.equal(elements.loading.style.display, "none");
  assert.equal(elements.error.style.display, "none");
  assert.equal(elements.results.style.display, "block");
  assert.equal(elements.tabsNav.style.display, "flex");
  assert.equal(elements.videoInfo.style.display, "block");
  assert.equal(elements.stateRegion.hidden, false);
  assert.equal(elements.readyRegion.hidden, true);
  assert.match(elements.stateRegion.textContent, /正在获取字幕/);

  helpers.sidepanelMvpResolveTranscript(
    {
      success: false,
      routeOutcome: "UNKNOWN",
      error: "YOUTUBE_CAPTIONS_REQUIRED",
      requiresCaptionEnable: true,
    },
    firstTask,
  );
  assert.match(elements.stateRegion.textContent, /请先打开 YouTube 字幕/);
  assert.deepEqual(
    findButtons(elements.stateRegion).map((button) => button.textContent),
    ["已看到字幕，重新读取"],
  );
  assert.equal(elements.tabsNav.style.display, "flex");

  const retryTask = helpers.sidepanelMvpBeginEvent(
    stateApi.EVENTS.USER_RETRY_FREE,
    stateApi.TASK_ORIGINS.USER_RETRY_FREE,
  );
  assert.match(elements.stateRegion.textContent, /正在重新读取字幕/);
  helpers.sidepanelMvpResolveTranscript(
    { success: true, routeOutcome: "HAVE_TRANSCRIPT" },
    retryTask,
  );
  assert.equal(elements.stateRegion.hidden, true);
  assert.equal(elements.readyRegion.hidden, false);
  assert.equal(elements.tabsNav.style.display, "flex");
});

test("rejected MVP events never reuse the current task", () => {
  const harness = createHarness();
  const initialTask = bindCurrentVideo(harness, "video-loading", 1);
  const rejectedTask = harness.helpers.sidepanelMvpBeginEvent(
    harness.stateApi.EVENTS.USER_CONSENT,
    harness.stateApi.TASK_ORIGINS.USER_CONSENT,
    {
      hasKey: true,
      consentToken: "stale-token",
      now: Date.now(),
    },
  );

  assert.equal(rejectedTask, null);
  assert.equal(
    harness.helpers.getSidepanelMvpState().transcript.activeTask.id,
    initialTask.id,
  );
  assert.equal(
    harness.helpers.getSidepanelMvpState().transcript.activeTask.origin,
    harness.stateApi.TASK_ORIGINS.INITIAL_LOAD,
  );
});

test("rejected retry actions do not run an existing task", async () => {
  const messages = [];
  const harness = createHarness({
    sendMessage: async (message) => {
      messages.push(message);
      return {};
    },
  });
  const initialTask = bindCurrentVideo(harness, "video-loading", 1);

  await harness.helpers.sidepanelMvpHandleAction(
    harness.stateApi.EVENTS.USER_RETRY_FREE,
  );

  assert.deepEqual(messages, []);
  assert.equal(
    harness.helpers.getSidepanelMvpState().transcript.activeTask.id,
    initialTask.id,
  );
});

test("Supadata consent cannot move to another video during config refresh", async () => {
  const configGate = deferred();
  const messages = [];
  const harness = createHarness({
    sendMessage: async (message) => {
      messages.push(JSON.parse(JSON.stringify(message)));
      if (message.action === "checkConfig") return configGate.promise;
      return {
        success: false,
        error: "PAGE_CONTEXT_CHANGED",
        routeOutcome: "PAGE_CONTEXT_CHANGED",
        runId: message.runId,
        routeKey: message.routeKey,
      };
    },
  });
  const { helpers, stateApi } = harness;

  const firstTask = bindCurrentVideo(harness, "video-a", 1);
  helpers.sidepanelMvpResolveTranscript(
    {
      routeOutcome: "UNKNOWN",
      error: "YOUTUBE_CAPTIONS_REQUIRED",
      requiresCaptionEnable: true,
    },
    firstTask,
  );
  const retryTask = helpers.sidepanelMvpBeginEvent(
    stateApi.EVENTS.USER_RETRY_FREE,
    stateApi.TASK_ORIGINS.USER_RETRY_FREE,
  );
  helpers.sidepanelMvpResolveTranscript(
    {
      routeOutcome: "UNKNOWN",
      error: "SUPADATA_CONSENT_REQUIRED",
      hasSupadataKey: true,
    },
    retryTask,
  );
  assert.equal(
    helpers.getSidepanelMvpState().transcript.status,
    stateApi.TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
  );

  const consentRequest = helpers.sidepanelMvpHandleAction(
    stateApi.EVENTS.USER_CONSENT,
  );
  await Promise.resolve();
  assert.deepEqual(messages.map((message) => message.action), ["checkConfig"]);

  const secondTask = bindCurrentVideo(harness, "video-b", 2);
  helpers.sidepanelMvpResolveTranscript(
    {
      routeOutcome: "UNKNOWN",
      error: "YOUTUBE_CAPTIONS_REQUIRED",
      requiresCaptionEnable: true,
    },
    secondTask,
  );
  const secondRetryTask = helpers.sidepanelMvpBeginEvent(
    stateApi.EVENTS.USER_RETRY_FREE,
    stateApi.TASK_ORIGINS.USER_RETRY_FREE,
  );
  helpers.sidepanelMvpResolveTranscript(
    {
      routeOutcome: "UNKNOWN",
      error: "SUPADATA_CONSENT_REQUIRED",
      hasSupadataKey: true,
    },
    secondRetryTask,
  );

  configGate.resolve({ runtimeProtocolVersion: 12, hasSupadataKey: true });
  await consentRequest;

  const state = helpers.getSidepanelMvpState();
  assert.equal(state.session.videoId, "video-b");
  assert.equal(
    state.transcript.status,
    stateApi.TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
  );
  assert.equal(state.transcript.activeTask, null);
  assert.deepEqual(
    messages.map((message) => message.action),
    ["checkConfig"],
    "the stale A consent must not dispatch a transcript request for B",
  );
});

test("old consent cannot authorize a renewed prompt for the same identity", async () => {
  const configGate = deferred();
  const messages = [];
  const harness = createHarness({
    sendMessage: async (message) => {
      messages.push(JSON.parse(JSON.stringify(message)));
      if (message.action === "checkConfig") return configGate.promise;
      return {};
    },
  });
  const { helpers, stateApi } = harness;
  moveToConsentChoice(harness, "video-a", 1);

  const consentRequest = helpers.sidepanelMvpHandleAction(
    stateApi.EVENTS.USER_CONSENT,
  );
  await Promise.resolve();
  const firstPrompt = helpers.getSidepanelMvpState().transcript;
  await helpers.sidepanelMvpHandleAction(stateApi.EVENTS.USER_DECLINE);
  await helpers.sidepanelMvpHandleAction(stateApi.EVENTS.USER_RECONSIDER);
  const renewedPrompt = helpers.getSidepanelMvpState().transcript;
  assert.notEqual(renewedPrompt, firstPrompt);
  assert.equal(
    renewedPrompt.status,
    stateApi.TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
  );

  configGate.resolve({ runtimeProtocolVersion: 12, hasSupadataKey: true });
  await consentRequest;

  assert.equal(
    helpers.getSidepanelMvpState().transcript,
    renewedPrompt,
    "the renewed prompt must remain untouched by the old click",
  );
  assert.deepEqual(messages.map((message) => message.action), ["checkConfig"]);
});

test("stale config errors do not settle a new video's task", async () => {
  const configGate = deferred();
  const messages = [];
  const harness = createHarness({
    sendMessage: async (message) => {
      messages.push(JSON.parse(JSON.stringify(message)));
      if (message.action === "checkConfig") return configGate.promise;
      return {};
    },
  });
  const { helpers, stateApi } = harness;
  moveToConsentChoice(harness, "video-a", 1);
  const consentRequest = helpers.sidepanelMvpHandleAction(
    stateApi.EVENTS.USER_CONSENT,
  );
  await Promise.resolve();

  const secondTask = bindCurrentVideo(harness, "video-b", 2);
  const beforeReject = helpers.getSidepanelMvpState();
  configGate.reject(new Error("stale config failure"));
  await assert.doesNotReject(consentRequest);

  const afterReject = helpers.getSidepanelMvpState();
  assert.equal(afterReject, beforeReject);
  assert.equal(afterReject.transcript.activeTask.id, secondTask.id);
  assert.equal(
    afterReject.transcript.activeTask.origin,
    stateApi.TASK_ORIGINS.INITIAL_LOAD,
  );
  assert.deepEqual(messages.map((message) => message.action), ["checkConfig"]);
});

test("consent, terminal, and error use distinct local structures", () => {
  const consentHarness = createHarness();
  const firstTask = consentHarness.helpers.sidepanelMvpBindSession(
    "video-1",
    "youtube:video-1",
  );
  consentHarness.helpers.sidepanelMvpResolveTranscript(
    { routeOutcome: "UNKNOWN", error: "YOUTUBE_CAPTIONS_REQUIRED" },
    firstTask,
  );
  const retryTask = consentHarness.helpers.sidepanelMvpBeginEvent(
    "USER_RETRY_FREE",
    "USER_RETRY_FREE",
  );
  consentHarness.helpers.sidepanelMvpResolveTranscript(
    {
      routeOutcome: "UNKNOWN",
      error: "SUPADATA_CONSENT_REQUIRED",
      hasSupadataKey: true,
    },
    retryTask,
  );
  assert.match(consentHarness.elements.stateRegion.className, /kind-consent/);
  assert.match(
    consentHarness.elements.stateRegion.textContent,
    /仅当前视频.*仅本次调用.*可能消耗额度/,
  );
  assert.deepEqual(
    findButtons(consentHarness.elements.stateRegion).map(
      (button) => button.textContent,
    ),
    ["本次使用 Supadata", "暂不使用"],
  );

  const terminalHarness = createHarness();
  const terminalTask = terminalHarness.helpers.sidepanelMvpBindSession(
    "video-2",
    "youtube:video-2",
  );
  terminalHarness.helpers.sidepanelMvpResolveTranscript(
    {
      routeOutcome: "CONFIRMED_UNAVAILABLE",
      error: "NO_TRANSCRIPT",
      message: "当前视频确认没有字幕。",
    },
    terminalTask,
  );
  assert.match(terminalHarness.elements.stateRegion.className, /kind-terminal/);
  assert.doesNotMatch(terminalHarness.elements.stateRegion.className, /kind-error/);
  assert.match(
    terminalHarness.elements.stateRegion.textContent,
    /当前视频确认没有字幕/,
  );
  assert.deepEqual(findButtons(terminalHarness.elements.stateRegion), []);

  const errorHarness = createHarness();
  const errorTask = errorHarness.helpers.sidepanelMvpBindSession(
    "video-3",
    "youtube:video-3",
  );
  errorHarness.helpers.sidepanelMvpResolveTranscript(
    {
      routeOutcome: "UNKNOWN",
      error: "NETWORK_ERROR",
      message: "网络暂时不可用。",
    },
    errorTask,
  );
  assert.match(errorHarness.elements.stateRegion.className, /kind-error/);
  assert.equal(errorHarness.elements.stateRegion.getAttribute("role"), "alert");
  assert.match(errorHarness.elements.stateRegion.textContent, /网络暂时不可用/);
});
