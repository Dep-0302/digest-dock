const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);

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

function createHarness({ sendMessageImpl } = {}) {
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
      if (selector === "#ytd-digest-button") {
        return elements.filter(
          (element) => element.id === "ytd-digest-button" && element.isConnected,
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
    console,
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

  assert.ok(harness.context.document.getElementById("ytd-note-button"));
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
  assert.equal(visibleGroup.children[0].id, "ytd-digest-button");
  assert.equal(visibleGroup.children[1], nativeButton);
  assert.match(visibleGroup.children[0].style.cssText, /flex:\s*0 0 auto/);
  assert.match(visibleGroup.children[0].style.cssText, /width:\s*max-content/);
});

test("stale extension buttons ask for a page refresh without logging another failure", async () => {
  const harness = createHarness({
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
  assert.match(button.innerHTML, /请刷新页面/);
  const notice = harness.context.document.getElementById(
    "ytd-extension-refresh-notice",
  );
  assert.ok(notice);
  assert.match(notice.textContent, /请刷新当前 YouTube 页面/);
  assert.equal(
    harness.context.isExtensionContextInvalidatedError(
      new Error("Extension context invalidated."),
    ),
    true,
  );
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
  staleButton.id = "ytd-digest-button";
  const duplicateButton = new FakeElement();
  duplicateButton.id = "ytd-digest-button";
  harness.elements.push(staleButton, duplicateButton);
  staleGroup.appendChild(staleButton);
  staleGroup.appendChild(duplicateButton);

  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(staleGroup.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.equal(visibleGroup.children.length, 1);
  assert.notEqual(visibleGroup.children[0], staleButton);
  assert.equal(visibleGroup.children[0].id, "ytd-digest-button");
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
  assert.equal(secondGroup.children[0].id, "ytd-digest-button");
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

test("a note that needs third-party transcript consent points the user to the side panel", () => {
  assert.match(
    contentScript,
    /result\.error === "SUPADATA_CONSENT_REQUIRED"[\s\S]*?请在侧栏确认/,
  );
  assert.match(
    contentScript,
    /result\.error === "SUPADATA_NOT_CONFIGURED"[\s\S]*?可在设置中配置回退/,
  );
});
