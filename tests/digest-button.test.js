const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);
const TEST_EXTENSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_BUTTON_ID =
  `digestdock-${TEST_EXTENSION_ID}-youtube-digest-button`;
const NOTE_BUTTON_ID =
  `digestdock-${TEST_EXTENSION_ID}-youtube-note-button`;
const REFRESH_NOTICE_ID =
  `digestdock-${TEST_EXTENSION_ID}-youtube-refresh-notice`;

class FakeElement {
  constructor({
    id = "",
    width = 100,
    height = 36,
    inMetadata = false,
    inPrimary = false,
  } = {}) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.inMetadata = inMetadata;
    this.inPrimary = inPrimary;
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.listeners = {};
  }

  get firstChild() {
    return this.children[0] || null;
  }

  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }

  closest(selector) {
    if (selector === "ytd-watch-metadata" && this.inMetadata) return this;
    if (selector === "#primary" && this.inPrimary) return this;
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];

    for (const child of this.children) {
      if (
        selector === "#top-level-buttons-computed" &&
        child.id === selector.slice(1)
      ) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }

    return matches;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
    this.isConnected = false;
  }
}

function createHarness({ sendMessageImpl, consoleImpl = console } = {}) {
  const actionRows = [];
  const fallbackRows = [];
  const elements = [];
  const documentListeners = {};
  const windowListeners = {};
  const observers = [];
  const timers = new Map();
  const intervals = new Map();
  let nextTimerId = 1;
  let intervalCalls = 0;
  let playerContainer = null;

  const document = {
    readyState: "loading",
    body: new FakeElement(),
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    },
    querySelectorAll(selector) {
      if (selector === "ytd-watch-metadata #actions-inner") return actionRows;
      if (/^#[A-Za-z0-9_-]+$/.test(selector)) {
        const id = selector.slice(1);
        return elements.filter(
          (element) => element.id === id && element.isConnected,
        );
      }
      if (selector.includes("top-level-buttons-computed")) return fallbackRows;
      return [];
    },
    querySelector(selector) {
      if (
        playerContainer?.isConnected &&
        selector.includes("#movie_player")
      ) {
        return playerContainer;
      }
      return null;
    },
    getElementById(id) {
      return elements.find((element) => element.id === id && element.isConnected);
    },
    createElement() {
      const element = new FakeElement();
      elements.push(element);
      return element;
    },
  };

  const context = vm.createContext({
    console: consoleImpl,
    URLSearchParams,
    document,
    window: {
      location: { pathname: "/watch" },
      addEventListener(type, listener) {
        windowListeners[type] = listener;
      },
      getComputedStyle(element) {
        return {
          display: element.display || "flex",
          visibility: element.visibility || "visible",
        };
      },
    },
    chrome: {
      runtime: {
        id: TEST_EXTENSION_ID,
        onMessage: { addListener() {} },
        async sendMessage(message) {
          return sendMessageImpl
            ? sendMessageImpl(message)
            : { success: true };
        },
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(callback) {
      intervalCalls += 1;
      const id = nextTimerId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  });

  vm.runInContext(contentScript, context);

  return {
    context,
    actionRows,
    fallbackRows,
    elements,
    documentListeners,
    windowListeners,
    observers,
    getIntervalCallCount() {
      return intervalCalls;
    },
    fireIntervalTicks(count) {
      for (let tick = 0; tick < count; tick += 1) {
        Array.from(intervals.values()).forEach((callback) => callback());
      }
    },
    setPlayerAvailable(available) {
      if (!available) {
        playerContainer?.remove();
        playerContainer = null;
        return;
      }
      if (playerContainer?.isConnected) return;
      playerContainer = new FakeElement({ id: "movie_player" });
      elements.push(playerContainer);
      document.body.appendChild(playerContainer);
    },
    flushTimers() {
      const callbacks = Array.from(timers.values());
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function createActionRow({ width, height }) {
  const row = new FakeElement({
    id: "actions-inner",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  const buttonGroup = new FakeElement({
    id: "top-level-buttons-computed",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  row.appendChild(buttonGroup);
  return { row, buttonGroup };
}

test("accidental duplicate content-script injection is idempotent", () => {
  const harness = createHarness();
  assert.equal(harness.context.__YTD_CONTENT_SCRIPT_ACTIVE__, true);
  assert.doesNotThrow(() => vm.runInContext(contentScript, harness.context));
  assert.equal(harness.context.__YTD_CONTENT_SCRIPT_ACTIVE__, true);
  assert.equal(typeof harness.context.injectDigestButton, "function");
});

test("video info reads the exact full description from embedded player data", () => {
  const harness = createHarness();
  const videoId = "0KHvXrq0gT8";
  harness.context.window.location.search = `?v=${videoId}`;
  harness.context.document.scripts = [
    {
      textContent:
        `var ytInitialPlayerResponse = {"videoDetails":{"videoId":"${videoId}",` +
        '"shortDescription":"First line\\nSecond line with \\\"quotes\\\".","lengthSeconds":"30"}};',
    },
  ];
  harness.context.document.querySelector = (selector) => {
    if (selector.includes("h1.ytd-watch-metadata")) {
      return { textContent: "Why Everyone Is Living The Same Life" };
    }
    if (selector.includes("#channel-name")) {
      return { textContent: "Mikey Posada" };
    }
    if (selector === "video.html5-main-video") return { duration: 30 };
    return null;
  };

  const info = vm.runInContext("extractVideoInfo()", harness.context);
  assert.equal(info.videoId, videoId);
  assert.equal(info.description, 'First line\nSecond line with "quotes".');
  assert.equal(info.descriptionStatus, "present");
});

test("video info distinguishes a confirmed empty description from an unready page", () => {
  const harness = createHarness();
  harness.context.window.location.search = "?v=empty123";
  harness.context.document.scripts = [
    {
      textContent:
        'var ytInitialPlayerResponse = {"videoDetails":{"videoId":"empty123","shortDescription":""}};',
    },
  ];
  harness.context.document.querySelector = () => null;
  const confirmedEmpty = vm.runInContext("extractVideoInfo()", harness.context);
  assert.equal(confirmedEmpty.description, "");
  assert.equal(confirmedEmpty.descriptionStatus, "confirmed-empty");

  harness.context.document.scripts = [];
  harness.context.document.querySelector = (selector) =>
    selector.includes("#description-inline-expander")
      ? { textContent: "" }
      : null;
  const unknown = vm.runInContext("extractVideoInfo()", harness.context);
  assert.equal(unknown.descriptionStatus, "unknown");
  assert.equal(unknown.descriptionTruncated, false);
});

test("a truncated DOM or meta description never counts as complete source material", () => {
  const harness = createHarness();
  harness.context.window.location.search = "?v=hydrating123";
  harness.context.document.scripts = [];
  harness.context.document.querySelector = (selector) => {
    if (selector === "meta[name='description']") {
      return {
        getAttribute(name) {
          return name === "content" ? "Truncated description..." : "";
        },
      };
    }
    return null;
  };
  const info = vm.runInContext("extractVideoInfo()", harness.context);
  assert.equal(info.description, "Truncated description...");
  assert.equal(info.descriptionStatus, "unknown");
  assert.equal(info.descriptionTruncated, true);
});

test("watch-page mutations do not restart the note-button retry loop", () => {
  const harness = createHarness();
  harness.documentListeners.DOMContentLoaded();
  assert.equal(harness.getIntervalCallCount(), 1);
  assert.equal(harness.observers.length, 1);

  for (let index = 0; index < 20; index += 1) {
    harness.observers[0].callback([]);
  }

  assert.equal(harness.getIntervalCallCount(), 1);
});

test("a late player mutation restores the note button without another retry loop", () => {
  const harness = createHarness();
  harness.documentListeners.DOMContentLoaded();
  harness.fireIntervalTicks(29);
  assert.equal(harness.getIntervalCallCount(), 1);

  harness.setPlayerAvailable(true);
  harness.observers[0].callback([]);

  assert.ok(harness.context.document.getElementById(NOTE_BUTTON_ID));
  assert.equal(harness.getIntervalCallCount(), 1);
});

test("Digest button skips a hidden responsive toolbar", () => {
  const harness = createHarness();
  const { row: hiddenRow, buttonGroup: hiddenGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  const { row: visibleRow, buttonGroup: visibleGroup } = createActionRow({
    width: 389,
    height: 36,
  });
  const nativeButton = new FakeElement();
  visibleGroup.appendChild(nativeButton);
  harness.actionRows.push(hiddenRow, visibleRow);

  assert.equal(harness.context.findDigestButtonHost(), visibleGroup);
  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(hiddenGroup.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.equal(visibleGroup.children[0].id, DIGEST_BUTTON_ID);
  // Compact icon + DDK opener with the full name kept in the accessible label.
  assert.match(visibleGroup.children[0].innerHTML, /<svg/);
  assert.match(visibleGroup.children[0].innerHTML, /#0A5FE9/);
  assert.match(visibleGroup.children[0].innerHTML, /#04B7D2/);
  assert.match(visibleGroup.children[0].innerHTML, /#D8F7FF/);
  assert.match(visibleGroup.children[0].innerHTML, /width="26" height="26"/);
  assert.doesNotMatch(visibleGroup.children[0].innerHTML, /#F26A4F/);
  assert.equal(visibleGroup.children[0]["aria-label"], "打开 DigestDock");
  assert.equal(visibleGroup.children[0].children[0].textContent, "DDK");
  assert.doesNotMatch(visibleGroup.children[0].innerHTML, /DigestDock<\/span>/);
  assert.equal(visibleGroup.children[1], nativeButton);
  assert.match(visibleGroup.children[0].style.cssText, /flex:\s*0 0 auto/);
  assert.match(visibleGroup.children[0].style.cssText, /width:\s*max-content/);
  assert.match(visibleGroup.children[0].style.cssText, /font:\s*700 12\.5px/);
});

test("stale extension buttons ask for a page refresh without logging another failure", async () => {
  const errors = [];
  const harness = createHarness({
    consoleImpl: Object.assign(Object.create(console), {
      error(...args) {
        errors.push(args);
      },
    }),
    async sendMessageImpl() {
      throw new Error("Extension context invalidated.");
    },
  });
  const { row, buttonGroup } = createActionRow({ width: 389, height: 36 });
  harness.actionRows.push(row);
  harness.context.injectDigestButton();
  const button = buttonGroup.children[0];

  await button.listeners.click({ preventDefault() {}, stopPropagation() {} });

  assert.equal(button.disabled, true);
  // Stale state stays icon-only: the SVG remains and only the accessible
  // name/tooltip change; the long brand label is never restored.
  assert.match(button.innerHTML, /<svg/);
  assert.doesNotMatch(button.innerHTML, /刷新 DigestDock/);
  assert.equal(button.title, "请刷新页面");
  assert.equal(button["aria-label"], "DigestDock 已更新，请刷新页面");
  const notice = harness.context.document.getElementById(
    REFRESH_NOTICE_ID,
  );
  assert.ok(notice);
  assert.match(notice.textContent, /请刷新当前 YouTube 页面/);
  assert.equal(errors.length, 0);
  assert.equal(
    harness.context.isExtensionContextInvalidatedError(
      new Error("Extension context invalidated."),
    ),
    true,
  );
  assert.equal(
    harness.context.isExtensionContextInvalidatedError(
      new TypeError("Cannot read properties of undefined (reading 'sendMessage')"),
    ),
    true,
  );
});

test("a reloaded extension with no runtime disables the stale opener before sending", async () => {
  let sendCalls = 0;
  const errors = [];
  const harness = createHarness({
    consoleImpl: Object.assign(Object.create(console), {
      error(...args) {
        errors.push(args);
      },
    }),
    async sendMessageImpl() {
      sendCalls += 1;
      return { success: true };
    },
  });
  const { row, buttonGroup } = createActionRow({ width: 389, height: 36 });
  harness.actionRows.push(row);
  harness.context.injectDigestButton();
  const button = buttonGroup.children[0];
  harness.context.chrome.runtime = undefined;

  await button.listeners.click({ preventDefault() {}, stopPropagation() {} });

  assert.equal(sendCalls, 0);
  assert.equal(button.disabled, true);
  assert.equal(button.title, "请刷新页面");
  assert.equal(button["aria-label"], "DigestDock 已更新，请刷新页面");
  const notice = harness.context.document.getElementById(REFRESH_NOTICE_ID);
  assert.ok(notice);
  assert.match(notice.textContent, /请刷新当前 YouTube 页面/);
  assert.equal(errors.length, 0);
});

test("ordinary side-panel messaging failures remain visible in the console", async () => {
  const errors = [];
  const harness = createHarness({
    consoleImpl: Object.assign(Object.create(console), {
      error(...args) {
        errors.push(args);
      },
    }),
    async sendMessageImpl() {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    },
  });
  const { row, buttonGroup } = createActionRow({ width: 389, height: 36 });
  harness.actionRows.push(row);
  harness.context.injectDigestButton();
  const button = buttonGroup.children[0];

  await button.listeners.click({ preventDefault() {}, stopPropagation() {} });

  assert.equal(button.disabled, undefined);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /Failed to open side panel/);
});

test("Digest button replaces stale instances and removes duplicates", () => {
  const harness = createHarness();
  const { row: staleRow, buttonGroup: staleGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  const { row: visibleRow, buttonGroup: visibleGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  harness.actionRows.push(staleRow, visibleRow);

  const staleButton = new FakeElement();
  staleButton.id = DIGEST_BUTTON_ID;
  const duplicateButton = new FakeElement();
  duplicateButton.id = DIGEST_BUTTON_ID;
  harness.elements.push(staleButton, duplicateButton);
  staleGroup.appendChild(staleButton);
  staleGroup.appendChild(duplicateButton);

  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(staleGroup.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.equal(visibleGroup.children.length, 1);
  assert.notEqual(visibleGroup.children[0], staleButton);
  assert.equal(visibleGroup.children[0].id, DIGEST_BUTTON_ID);
  assert.equal(staleButton.isConnected, false);
  assert.equal(duplicateButton.isConnected, false);
});

test("resize reconciliation follows YouTube to the newly visible toolbar", () => {
  const harness = createHarness();
  const { row: firstRow, buttonGroup: firstGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  const { row: secondRow, buttonGroup: secondGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  harness.actionRows.push(firstRow, secondRow);

  harness.context.injectDigestButton();
  harness.context.setupDigestButtonResizeListener();
  firstRow.width = 0;
  firstRow.height = 0;
  firstGroup.width = 0;
  firstGroup.height = 0;
  secondRow.width = 389;
  secondRow.height = 36;
  secondGroup.width = 389;
  secondGroup.height = 36;

  harness.windowListeners.resize();
  harness.flushTimers();

  assert.equal(firstGroup.children.length, 0);
  assert.equal(secondRow.children.length, 1);
  assert.equal(secondGroup.children.length, 1);
  assert.equal(secondGroup.children[0].id, DIGEST_BUTTON_ID);
});

test("DigestDock coexists with legacy YouTube Digest DOM controls", async () => {
  const sentActions = [];
  const harness = createHarness({
    async sendMessageImpl(message) {
      sentActions.push(message.action);
      return { success: true };
    },
  });
  const { row, buttonGroup } = createActionRow({ width: 500, height: 36 });
  harness.actionRows.push(row);
  harness.setPlayerAvailable(true);
  const player = harness.context.document.getElementById("movie_player");

  const legacyDigestButton = new FakeElement({ id: "ytd-digest-button" });
  const legacyNoteButton = new FakeElement({ id: "ytd-note-button" });
  harness.elements.push(legacyDigestButton, legacyNoteButton);
  buttonGroup.appendChild(legacyDigestButton);
  player.appendChild(legacyNoteButton);

  harness.documentListeners.DOMContentLoaded();

  const digestButton = harness.context.document.getElementById(DIGEST_BUTTON_ID);
  const noteButton = harness.context.document.getElementById(NOTE_BUTTON_ID);
  assert.ok(digestButton);
  assert.ok(noteButton);
  assert.equal(legacyDigestButton.isConnected, true);
  assert.equal(legacyNoteButton.isConnected, true);
  assert.equal(digestButton.parentElement, buttonGroup);
  assert.equal(noteButton.parentElement, player);
  assert.equal(noteButton.style.top, "58px");
  assert.equal(buttonGroup.children.includes(legacyDigestButton), true);
  assert.equal(player.children.includes(legacyNoteButton), true);

  await digestButton.listeners.click({
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(sentActions, ["openSidePanel"]);

  harness.documentListeners.keydown({
    key: "n",
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(
    sentActions,
    ["openSidePanel"],
    "the legacy build keeps the shared N shortcut while both are enabled",
  );

  harness.documentListeners["yt-navigate-finish"]();
  assert.equal(legacyDigestButton.isConnected, true);
  assert.equal(legacyNoteButton.isConnected, true);
  harness.flushTimers();
  harness.flushTimers();
  assert.ok(harness.context.document.getElementById(DIGEST_BUTTON_ID));
  assert.ok(harness.context.document.getElementById(NOTE_BUTTON_ID));
  assert.equal(legacyDigestButton.isConnected, true);
  assert.equal(legacyNoteButton.isConnected, true);
});

test("DOM mutation reconciliation repairs a replaced toolbar", () => {
  const harness = createHarness();
  const { row: oldRow, buttonGroup: oldGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  const { row: newRow, buttonGroup: newGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  harness.actionRows.push(oldRow, newRow);

  harness.context.injectDigestButton();
  harness.context.setupButtonObserver();
  oldRow.width = 0;
  oldRow.height = 0;
  oldGroup.width = 0;
  oldGroup.height = 0;
  newRow.width = 500;
  newRow.height = 36;
  newGroup.width = 500;
  newGroup.height = 36;

  harness.observers[0].callback([]);
  harness.flushTimers();

  assert.equal(oldGroup.children.length, 0);
  assert.equal(newRow.children.length, 1);
  assert.equal(newGroup.children.length, 1);
});

test("the player note button uses exact 20/50 default and 100 hover opacity", () => {
  const harness = createHarness();
  harness.setPlayerAvailable(true);
  harness.documentListeners.DOMContentLoaded();

  const noteButton = harness.context.document.getElementById(NOTE_BUTTON_ID);
  assert.ok(noteButton);
  assert.match(noteButton.style.cssText, /background:\s*linear-gradient\(/i);
  assert.match(noteButton.style.cssText, /rgba\(10, 95, 233, 0\.2\)/i);
  assert.match(noteButton.style.cssText, /rgba\(8, 127, 232, 0\.2\)/i);
  assert.match(noteButton.style.cssText, /rgba\(4, 183, 210, 0\.2\)/i);
  assert.match(
    noteButton.style.cssText,
    /color:\s*rgba\(255, 255, 255, 0\.5\)/i,
  );
  assert.match(noteButton.style.cssText, /backdrop-filter:\s*blur\(6px\)/i);
  assert.match(noteButton.style.cssText, /min-width:\s*128px/);
  assert.match(noteButton.style.cssText, /border-radius:\s*10px/);
  assert.match(noteButton.style.cssText, /box-shadow:\s*0 8px 18px rgba\(4, 73, 139/);
  // Icon + exact visible label, with the same text exposed accessibly.
  assert.match(noteButton.innerHTML, /<svg/);
  assert.equal(noteButton.children[0].textContent, "金句速记 (N)");
  assert.equal(noteButton["aria-label"], "金句速记 (N)");

  noteButton.listeners.mouseenter();
  assert.match(noteButton.style.background, /#0a5fe9/i);
  assert.match(noteButton.style.background, /#04b7d2/i);
  assert.equal(noteButton.style.color, "#ffffff");
  noteButton.listeners.mouseleave();
  assert.match(noteButton.style.background, /rgba\(10, 95, 233, 0\.2\)/i);
  assert.equal(noteButton.style.color, "rgba(255, 255, 255, 0.5)");
});

test("a cold-cache note points to the side-panel transcript task", () => {
  assert.match(
    contentScript,
    /result\.error === "TRANSCRIPT_TASK_REQUIRED"[\s\S]*?请先打开侧栏字幕/,
  );
  assert.match(
    contentScript,
    /result\.error === "SUPADATA_CONSENT_REQUIRED"[\s\S]*?请在侧栏授权/,
  );
  assert.match(
    contentScript,
    /result\.error === "SUPADATA_NOT_CONFIGURED"[\s\S]*?需在设置配置 Supadata/,
  );
});
