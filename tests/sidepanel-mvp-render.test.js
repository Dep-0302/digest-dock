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

function createHarness() {
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
        sendMessage: async () => ({}),
        getURL: (value) => `chrome-extension://test/${value}`,
      },
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        onRemoved: listeners,
      },
      storage: { onChanged: listeners },
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
