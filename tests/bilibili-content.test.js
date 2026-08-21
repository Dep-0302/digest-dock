const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "content-bilibili.js"),
  "utf8",
);
const TEST_EXTENSION_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BILI_DIGEST_BUTTON_ID =
  `digestdock-${TEST_EXTENSION_ID}-bilibili-digest-button`;
const BILI_NOTE_BUTTON_ID =
  `digestdock-${TEST_EXTENSION_ID}-bilibili-note-button`;

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.id = "";
    this.className = "";
    this.textContent = "";
    this.type = "";
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.listeners = new Map();
    this.attributes = {};
    this.disabled = false;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get nextSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.setConnected(this.isConnected);
    return child;
  }

  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const index = this.children.indexOf(before);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentElement = this;
    child.setConnected(this.isConnected);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
    child.setConnected(false);
  }

  remove() {
    this.parentElement?.removeChild(this);
    this.setConnected(false);
  }

  setConnected(value) {
    this.isConnected = Boolean(value);
    this.children.forEach((child) => child.setConnected(value));
  }

  querySelector(selector) {
    if (selector === ".video-note") {
      return this.children.find((child) => child.className === "video-note") || null;
    }
    return null;
  }

  closest(selector) {
    if (
      selector === "#bilibili-player, .bpx-player-container" &&
      this.playerContainer
    ) {
      return this.playerContainer;
    }
    return null;
  }

  async emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) {
      await listener(event);
    }
  }
}

function createHarness({
  href = "https://www.bilibili.com/video/BV1e3411j7ZM/",
  sendMessage,
} = {}) {
  const elements = [];
  const selectors = [];
  const documentListeners = new Map();
  const messages = [];
  const responses = [];
  const timers = new Map();
  const intervals = new Map();
  const observers = [];
  let nextTimerId = 1;
  let currentUrl = new URL(href);

  const body = new FakeElement("body");
  body.setConnected(true);
  const head = new FakeElement("head");
  head.setConnected(true);
  const toolbar = new FakeElement("div");
  toolbar.setConnected(true);
  const nativeNote = new FakeElement("button");
  nativeNote.className = "video-note";
  toolbar.appendChild(nativeNote);

  const player = new FakeElement("div");
  player.id = "bilibili-player";
  player.setConnected(true);
  const video = new FakeElement("video");
  video.currentTime = 10.9;
  video.duration = 180;
  video.paused = true;
  video.playCalls = 0;
  video.play = async () => {
    video.playCalls += 1;
    video.paused = false;
  };
  video.playerContainer = player;
  player.appendChild(video);

  const title = new FakeElement("h1");
  title.textContent = "  测试标题  ";
  const creator = new FakeElement("a");
  creator.textContent = "  测试 UP  ";
  const description = new FakeElement("div");
  description.textContent = "  测试简介  ";
  elements.push(body, head, toolbar, nativeNote, player, video, title, creator, description);

  const location = {};
  function syncLocation() {
    location.href = currentUrl.href;
    location.pathname = currentUrl.pathname;
    location.search = currentUrl.search;
  }
  syncLocation();

  const document = {
    readyState: "loading",
    body,
    head,
    activeElement: null,
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      elements.push(element);
      return element;
    },
    querySelector(selector) {
      selectors.push(selector);
      if (selector === "#bilibili-player video, .bpx-player-container video") {
        return video;
      }
      if (selector === "#bilibili-player, .bpx-player-container") return player;
      if (selector === "#arc_toolbar_report .video-toolbar-right") return toolbar;
      if (selector === "h1.video-title") return title;
      if (selector === ".up-info-container .up-name") return creator;
      if (selector === ".basic-desc-info .desc-info-text") return description;
      return null;
    },
    querySelectorAll(selector) {
      const ids = Array.from(String(selector).matchAll(/#([\w-]+)/g)).map(
        (match) => match[1],
      );
      if (!ids.length) return [];
      return elements.filter(
        (element) => element.isConnected && ids.includes(element.id),
      );
    },
    getElementById(id) {
      return elements.find(
        (element) => element.id === id && element.isConnected,
      ) || null;
    },
  };

  let messageListener = null;
  const context = vm.createContext({
    console,
    URL,
    Promise,
    globalThis: null,
    document,
    navigator: {
      clipboard: { async writeText() {} },
    },
    window: {
      location,
      addEventListener() {},
      getComputedStyle() {
        return { position: "static", display: "block", visibility: "visible" };
      },
    },
    BILIBILI_ADAPTER: {
      parseBilibiliVideoUrl(rawUrl) {
        const url = new URL(rawUrl);
        const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{6,20})/);
        if (url.hostname !== "www.bilibili.com" || !match) throw new Error("unsupported");
        const page = Number(url.searchParams.get("p") || 1);
        return {
          bvid: match[1],
          page,
          canonicalUrl:
            page > 1
              ? `https://www.bilibili.com/video/${match[1]}/?p=${page}`
              : `https://www.bilibili.com/video/${match[1]}/`,
        };
      },
    },
    chrome: {
      runtime: {
        id: TEST_EXTENSION_ID,
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
        async sendMessage(message) {
          messages.push(message);
          return sendMessage
            ? sendMessage(message)
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
      const id = nextTimerId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  });
  context.globalThis = context;
  vm.runInContext(source, context);

  return {
    context,
    document,
    documentListeners,
    elements,
    intervals,
    messages,
    nativeNote,
    observers,
    player,
    responses,
    selectors,
    toolbar,
    video,
    dispatch(action, payload = {}) {
      let response;
      const asyncResponse = messageListener(
        { action, ...payload },
        {},
        (value) => {
          response = value;
          responses.push(value);
        },
      );
      return { asyncResponse, response };
    },
    flushTimeouts() {
      const callbacks = Array.from(timers.values());
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
    setUrl(nextHref) {
      currentUrl = new URL(nextHref);
      syncLocation();
    },
  };
}

test("uses the standard Bilibili selectors and routes content messages", () => {
  const harness = createHarness();

  const info = harness.dispatch("getVideoInfo").response;
  assert.deepEqual(JSON.parse(JSON.stringify(info)), {
    platform: "bilibili",
    videoId: "BV1e3411j7ZM",
    videoUrl: "https://www.bilibili.com/video/BV1e3411j7ZM/",
    title: "测试标题",
    channelName: "测试 UP",
    description: "测试简介",
    duration: 180,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.dispatch("getCurrentTime").response)),
    { currentTime: 10, paused: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.dispatch("highlightMoments").response)),
    { success: true },
  );
  assert.ok(
    harness.selectors.includes(
      "#bilibili-player video, .bpx-player-container video",
    ),
  );
  assert.ok(harness.selectors.includes("h1.video-title"));
  assert.ok(harness.selectors.includes(".up-info-container .up-name"));
  assert.ok(
    harness.selectors.includes(".basic-desc-info .desc-info-text"),
  );
});

test("inserts one Digest button immediately before Bilibili's native note button", async () => {
  const harness = createHarness();

  assert.equal(harness.context.biliInjectDigestButton(), true);
  assert.equal(harness.context.biliInjectDigestButton(), true);
  const buttons = harness.document.querySelectorAll(
    `#${BILI_DIGEST_BUTTON_ID}`,
  );
  assert.equal(buttons.length, 1);
  assert.equal(harness.toolbar.children[0], buttons[0]);
  assert.equal(harness.toolbar.children[1], harness.nativeNote);
  // Icon-only brand opener: no "▶" glyph child, no "DigestDock" text child,
  // accessible name via aria-label, and a self-contained inline-SVG icon.
  assert.equal(buttons[0].children.length, 0);
  assert.equal(buttons[0].attributes["aria-label"], "打开 DigestDock");
  assert.match(buttons[0].style.cssText, /data:image\/svg\+xml/);

  await buttons[0].emit("click", {
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(harness.messages[0].action, "openSidePanel");
  assert.equal(harness.messages[0].videoUrl, "https://www.bilibili.com/video/BV1e3411j7ZM/");
});

test("seekTo controls the Bilibili HTML5 video and starts paused playback", async () => {
  const harness = createHarness();

  const result = harness.dispatch("seekTo", { seconds: 42.5 }).response;
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true });
  assert.equal(harness.video.currentTime, 42.5);
  assert.equal(harness.video.playCalls, 1);
});

test("overlay note save includes canonical videoUrl, fallback timestamp, title, and author", async () => {
  const harness = createHarness({
    href: "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2&spm_id_from=test",
    sendMessage(message) {
      if (message.action === "saveNote") return { success: true };
      return { success: true };
    },
  });

  assert.equal(harness.context.biliInjectNoteButton(), true);
  const result = await harness.context.biliSaveCurrentNote();
  const saveMessage = harness.messages.find(
    (message) => message.action === "saveNote",
  );

  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(saveMessage)), {
    action: "saveNote",
    platform: "bilibili",
    videoId: "BV1e3411j7ZM",
    videoUrl: "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2",
    timestamp: 7,
    videoTitle: "测试标题",
    channelName: "测试 UP",
  });
});

test("pathname and p polling cleans stale buttons and reinjects for SPA navigation", () => {
  const harness = createHarness();
  harness.context.biliInit();
  const firstDigestButton = harness.document.getElementById(
    BILI_DIGEST_BUTTON_ID,
  );
  const firstNoteButton = harness.document.getElementById(BILI_NOTE_BUTTON_ID);
  assert.ok(firstDigestButton);
  assert.ok(firstNoteButton);

  harness.setUrl("https://www.bilibili.com/video/BV1e3411j7ZM/?p=2");
  assert.equal(harness.context.biliPollNavigation(), true);
  assert.equal(firstDigestButton.isConnected, false);
  assert.equal(firstNoteButton.isConnected, false);

  harness.flushTimeouts();
  assert.notEqual(
    harness.document.getElementById(BILI_DIGEST_BUTTON_ID),
    firstDigestButton,
  );
  assert.notEqual(
    harness.document.getElementById(BILI_NOTE_BUTTON_ID),
    firstNoteButton,
  );
});

test("DigestDock keeps legacy Bilibili controls separate", async () => {
  const harness = createHarness();
  const legacyDigestButton = new FakeElement("button");
  legacyDigestButton.id = "bili-digest-button";
  const legacyNoteButton = new FakeElement("button");
  legacyNoteButton.id = "bili-note-button";
  harness.elements.push(legacyDigestButton, legacyNoteButton);
  harness.toolbar.insertBefore(legacyDigestButton, harness.nativeNote);
  harness.player.appendChild(legacyNoteButton);

  assert.equal(harness.context.biliInjectDigestButton(), true);
  assert.equal(harness.context.biliInjectNoteButton(), true);

  const digestButton = harness.document.getElementById(BILI_DIGEST_BUTTON_ID);
  const noteButton = harness.document.getElementById(BILI_NOTE_BUTTON_ID);
  assert.ok(digestButton);
  assert.ok(noteButton);
  assert.equal(legacyDigestButton.isConnected, true);
  assert.equal(legacyNoteButton.isConnected, true);
  assert.equal(noteButton.style.top, "58px");

  await digestButton.emit("click", {
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(harness.messages[0].action, "openSidePanel");

  harness.context.biliHandleNoteKeyboardShortcut({
    key: "n",
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(
    harness.messages.length,
    1,
    "the legacy build keeps the shared N shortcut while both are enabled",
  );

  harness.context.biliCleanupPageArtifacts();
  assert.equal(digestButton.isConnected, false);
  assert.equal(noteButton.isConnected, false);
  assert.equal(legacyDigestButton.isConnected, true);
  assert.equal(legacyNoteButton.isConnected, true);
});

test("the player note button uses the neutral graphite bookmark control, not a coral pill", () => {
  const harness = createHarness();

  assert.equal(harness.context.biliInjectNoteButton(), true);
  const noteButton = harness.document.getElementById(BILI_NOTE_BUTTON_ID);
  assert.ok(noteButton);
  // Deep graphite surface with a ~10px radius and a restrained neutral shadow.
  assert.match(noteButton.style.cssText, /background-color:\s*#1f2933/i);
  assert.match(noteButton.style.cssText, /border-radius:\s*10px/);
  assert.match(
    noteButton.style.cssText,
    /box-shadow:\s*0 4px 12px rgba\(23, 33, 42/,
  );
  // The old coral circle/pill is gone.
  assert.doesNotMatch(noteButton.style.cssText, /border-radius:\s*999px/);
  assert.doesNotMatch(noteButton.style.cssText, /#c8674f/i);
  // Text-free icon control: the bookmark renders as a background image, no
  // text child, and the accessible name lives on aria-label.
  assert.equal(noteButton.children.length, 0);
  assert.match(noteButton.style.cssText, /data:image\/svg\+xml/);
  assert.equal(
    noteButton.attributes["aria-label"],
    "用 DigestDock 保存当前时刻的笔记（快捷键 N）",
  );
});

test("note feedback renders hostile dynamic content as text and rejects unsafe URLs", () => {
  const harness = createHarness();
  const hostile = '<img src=x onerror="globalThis.pwned=true">';
  const toast = harness.context.biliShowNoteSavedToast({
    timestamp: hostile,
    videoTitle: hostile,
    text: hostile,
    timestampedUrl: "javascript:alert(1)",
  });

  assert.equal(harness.context.pwned, undefined);
  assert.equal(toast.children[1].textContent, `${hostile} — ${hostile}`);
  assert.equal(toast.children[2].textContent, hostile);
  assert.equal(toast.children.length, 3);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});
