const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(
  path.join(root, "youtube-passive-main.js"),
  "utf8",
);
const bridgeSource = fs.readFileSync(
  path.join(root, "youtube-passive-bridge.js"),
  "utf8",
);
const VIDEO_A = "jNQXAC9IVRw";
const VIDEO_B = "dQw4w9WgXcQ";
const CHANNEL = "digestdock-youtube-passive-state-v1";
const CONTROL = "digestdock-youtube-passive-control-v1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((candidate) => candidate !== listener),
      );
    },
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
  };
}

function mutableLocation(initialHref) {
  let href = initialHref;
  return {
    get href() {
      return href;
    },
    set href(value) {
      href = String(value);
    },
    get origin() {
      return new URL(href).origin;
    },
  };
}

class FakeXhr {
  constructor() {
    this.listeners = new Map();
    this.responseType = "";
    this.responseText = "";
    this.responseURL = "";
    this.status = 0;
    this.headers = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type) {
    for (const listener of this.listeners.get(type) || []) listener();
  }

  getResponseHeader(name) {
    return this.headers.get(String(name).toLowerCase()) || null;
  }
}

FakeXhr.prototype.open = function originalOpen(_method, url) {
  this.openedUrl = String(url);
};
FakeXhr.prototype.send = function originalSend() {
  this.sendCalls = (this.sendCalls || 0) + 1;
};

function responseDouble(url, body, status = 200, contentLength = null) {
  const headers = {
    get(name) {
      return String(name).toLowerCase() === "content-length" &&
        contentLength !== null
        ? String(contentLength)
        : null;
    },
  };
  return {
    url,
    status,
    headers,
    clone() {
      return { headers, body: null, text: async () => body };
    },
    text: async () => body,
  };
}

function loadMain({ href, fetchImpl, setTimeoutImpl, clearTimeoutImpl } = {}) {
  const events = eventTarget();
  const location = mutableLocation(
    href || `https://www.youtube.com/watch?v=${VIDEO_A}`,
  );
  const posted = [];
  const window = {
    fetch: fetchImpl || (async () => responseDouble("", "")),
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
  };
  window.window = window;
  const original = {
    open: FakeXhr.prototype.open,
    send: FakeXhr.prototype.send,
    fetch: window.fetch,
  };
  vm.runInNewContext(mainSource, {
    window,
    location,
    XMLHttpRequest: FakeXhr,
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout: setTimeoutImpl || setTimeout,
    clearTimeout: clearTimeoutImpl || clearTimeout,
  });
  const connect = (nonce = "a".repeat(32)) =>
    events.dispatch("message", {
      source: window,
      origin: location.origin,
      data: { source: CONTROL, action: "connect", nonce },
    });
  return { events, location, posted, window, original, connect };
}

function passivePayloads(posted) {
  return posted
    .map((entry) => entry.message)
    .filter((message) => message.source === CHANNEL)
    .map((message) => message.payload);
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("MAIN observes one exact timedtext fetch without adding a request or leaking its signed URL", async () => {
  const signedUrl =
    `https://www.youtube.com/api/timedtext?v=${VIDEO_A}` +
    "&lang=en&fmt=json3&expire=999999&signature=DO_NOT_FORWARD";
  const body = JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Line" }] }],
  });
  const calls = [];
  const response = responseDouble(signedUrl, body);
  const harness = loadMain({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response;
    },
  });
  harness.connect();

  const returned = await harness.window.fetch(signedUrl, { credentials: "include" });
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], signedUrl);
  assert.equal(returned, response);
  assert.equal(await returned.text(), body);
  const payloads = passivePayloads(harness.posted);
  assert.deepEqual(
    payloads.map((payload) => payload.type),
    ["inflight", "capture"],
  );
  assert.equal(payloads[0].inFlight, true);
  assert.equal("body" in payloads[0], false);
  assert.equal(payloads[1].body, body);
  assert.equal(payloads[1].inFlight, false);
  assert.equal(payloads[1].videoId, VIDEO_A);
  assert.equal(payloads[1].language, "en");
  assert.equal(payloads[1].kind, "manual");
  const serialized = JSON.stringify(payloads);
  assert.doesNotMatch(serialized, /DO_NOT_FORWARD|signature|expire|https?:|url/i);
  harness.events.dispatch("pagehide");
});

test("MAIN ignores every host/path except exact www.youtube.com/api/timedtext", async () => {
  const calls = [];
  const harness = loadMain({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return responseDouble(String(url), "not a transcript");
    },
  });
  harness.connect();
  const urls = [
    `https://youtube.com/api/timedtext?v=${VIDEO_A}&lang=en`,
    `https://www.youtube.com/api/timedtext/extra?v=${VIDEO_A}&lang=en`,
    "https://www.youtube.com/youtubei/v1/player",
    `https://evil.example/api/timedtext?v=${VIDEO_A}&lang=en`,
  ];
  for (const url of urls) await harness.window.fetch(url);
  await flush();

  assert.deepEqual(calls, urls);
  assert.deepEqual(passivePayloads(harness.posted), []);
  harness.events.dispatch("pagehide");
});

test("MAIN emits in-flight then clear for a failed/oversized response and restores hooks", async () => {
  const timedtext =
    `https://www.youtube.com/api/timedtext?v=${VIDEO_A}&lang=en&kind=asr`;
  let requests = 0;
  const response = responseDouble(timedtext, "must not be read", 200, MAX_BODY_BYTES + 1);
  const harness = loadMain({
    fetchImpl: async () => {
      requests += 1;
      return response;
    },
  });
  harness.connect("b".repeat(32));

  assert.notEqual(FakeXhr.prototype.open, harness.original.open);
  assert.notEqual(FakeXhr.prototype.send, harness.original.send);
  assert.notEqual(harness.window.fetch, harness.original.fetch);
  await harness.window.fetch(timedtext);
  await flush();

  assert.equal(requests, 1);
  const payloads = passivePayloads(harness.posted);
  assert.deepEqual(
    payloads.map((payload) => payload.type),
    ["inflight", "clear"],
  );
  assert.equal(payloads[0].kind, "asr");
  assert.equal(payloads[1].inFlight, false);
  assert.equal(payloads.some((payload) => "body" in payload), false);

  harness.events.dispatch("pagehide");
  assert.equal(FakeXhr.prototype.open, harness.original.open);
  assert.equal(FakeXhr.prototype.send, harness.original.send);
  assert.equal(harness.window.fetch, harness.original.fetch);
});

test("MAIN times out only its clone reader and clears passive state", async () => {
  const timedtext =
    `https://www.youtube.com/api/timedtext?v=${VIDEO_A}&lang=en&fmt=json3`;
  let cloneCancels = 0;
  const headers = { get: () => null };
  const originalResponse = {
    url: timedtext,
    status: 200,
    headers,
    clone() {
      return {
        headers,
        body: {
          getReader() {
            return {
              read: () => new Promise(() => {}),
              cancel() {
                cloneCancels += 1;
                return Promise.resolve();
              },
              releaseLock() {},
            };
          },
        },
      };
    },
  };
  const harness = loadMain({
    fetchImpl: async () => originalResponse,
    setTimeoutImpl(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeoutImpl() {},
  });
  harness.connect("f".repeat(32));

  const returned = await harness.window.fetch(timedtext);
  assert.equal(returned, originalResponse, "the page response remains untouched");
  await flush();

  assert.equal(cloneCancels, 1);
  assert.deepEqual(
    passivePayloads(harness.posted).map((payload) => payload.type),
    ["inflight", "clear"],
  );
  harness.events.dispatch("pagehide");
});

test("MAIN observes XHR with one original send and clears it on completion", () => {
  const timedtext =
    `https://www.youtube.com/api/timedtext?v=${VIDEO_A}&lang=zh-Hans&fmt=json3`;
  const body = '{"events":[]}';
  const harness = loadMain();
  harness.connect("c".repeat(32));
  const xhr = new FakeXhr();
  xhr.responseURL = timedtext;
  xhr.responseText = body;
  xhr.status = 200;

  xhr.open("GET", timedtext);
  xhr.send();
  assert.equal(xhr.sendCalls, 1);
  xhr.emit("load");

  const payloads = passivePayloads(harness.posted);
  assert.deepEqual(
    payloads.map((payload) => payload.type),
    ["inflight", "capture"],
  );
  assert.equal(payloads[1].language, "zh-Hans");
  assert.equal(payloads[1].body, body);
  harness.events.dispatch("pagehide");
});

test("MAIN preserves a page fetch rejection while clearing passive in-flight state", async () => {
  const timedtext =
    `https://www.youtube.com/api/timedtext?v=${VIDEO_A}&lang=en&fmt=json3`;
  const expected = new Error("page fetch failed");
  let requests = 0;
  const harness = loadMain({
    fetchImpl: async () => {
      requests += 1;
      throw expected;
    },
  });
  harness.connect("d".repeat(32));

  await assert.rejects(harness.window.fetch(timedtext), (error) => error === expected);
  assert.equal(requests, 1);
  assert.deepEqual(
    passivePayloads(harness.posted).map((payload) => payload.type),
    ["inflight", "clear"],
  );
  harness.events.dispatch("pagehide");
});

test("MAIN rejects an old A response after an A to B to A SPA cycle", async () => {
  const timedtext =
    `https://www.youtube.com/api/timedtext?v=${VIDEO_A}&lang=en&fmt=json3`;
  let resolveFetch;
  const harness = loadMain({
    fetchImpl: () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
  });
  harness.connect("e".repeat(32));

  const pageRequest = harness.window.fetch(timedtext);
  assert.deepEqual(
    passivePayloads(harness.posted).map((payload) => payload.type),
    ["inflight"],
  );
  harness.events.dispatch("yt-navigate-start");
  harness.location.href = `https://www.youtube.com/watch?v=${VIDEO_B}`;
  harness.events.dispatch("yt-navigate-start");
  harness.location.href = `https://www.youtube.com/watch?v=${VIDEO_A}`;
  resolveFetch(responseDouble(timedtext, "stale A body"));
  await pageRequest;
  await flush();

  const payloads = passivePayloads(harness.posted);
  assert.deepEqual(
    payloads.map((payload) => payload.type),
    ["inflight", "clear"],
  );
  assert.equal(
    payloads.some(
      (payload) => payload.type === "capture" && payload.body === "stale A body",
    ),
    false,
  );
  harness.events.dispatch("pagehide");
});

function loadBridge({ href } = {}) {
  const events = eventTarget();
  const location = mutableLocation(
    href || `https://www.youtube.com/watch?v=${VIDEO_A}`,
  );
  const controls = [];
  const runtimeMessages = [];
  const timers = new Map();
  let nextTimerId = 1;
  const window = {
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    postMessage(message, targetOrigin) {
      controls.push({ message, targetOrigin });
    },
  };
  window.window = window;
  const sandbox = {
    window,
    location,
    URL,
    TextEncoder,
    Uint8Array,
    crypto: {
      getRandomValues(array) {
        array.fill(0xab);
        return array;
      },
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          runtimeMessages.push(message);
          return Promise.resolve({ ok: true });
        },
      },
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(bridgeSource, context);
  const nonce = "ab".repeat(16);
  const fromMain = (payload, messageNonce = nonce) =>
    events.dispatch("message", {
      source: window,
      origin: location.origin,
      data: { source: CHANNEL, nonce: messageNonce, payload },
    });
  const runTimers = (delay) => {
    for (const [id, timer] of [...timers]) {
      if (delay === undefined || timer.delay === delay) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return {
    controls,
    context,
    events,
    fromMain,
    location,
    nonce,
    runTimers,
    runtimeMessages,
    timers,
    window,
  };
}

function inflight(videoId = VIDEO_A, language = "en", kind = "manual") {
  return { type: "inflight", videoId, language, kind, status: 0, inFlight: true };
}

function capture(videoId = VIDEO_A, body = "caption", extra = {}) {
  return {
    type: "capture",
    videoId,
    language: "en",
    kind: "manual",
    status: 200,
    body,
    inFlight: false,
    ...extra,
  };
}

test("bridge requires its per-document nonce and forwards only whitelisted state", () => {
  const harness = loadBridge();
  assert.equal(harness.controls[0].message.action, "connect");
  assert.equal(harness.controls[0].message.nonce, harness.nonce);

  harness.fromMain(inflight(), "00".repeat(16));
  assert.equal(harness.runtimeMessages.length, 0);
  harness.fromMain(inflight());
  harness.fromMain(
    capture(VIDEO_A, "safe body", {
      url: "https://www.youtube.com/api/timedtext?signature=SECRET",
      signature: "SECRET",
      unexpected: true,
    }),
  );

  assert.equal(harness.runtimeMessages.length, 2);
  assert.ok(
    harness.runtimeMessages.every(
      (message) => message.action === "youtubePassiveState",
    ),
  );
  const [started, completed] = harness.runtimeMessages.map(
    (message) => message.payload,
  );
  assert.equal(started.type, "inflight");
  assert.equal("body" in started, false);
  assert.equal(completed.type, "capture");
  assert.equal(completed.body, "safe body");
  assert.deepEqual(Object.keys(completed).sort(), [
    "body",
    "inFlight",
    "kind",
    "language",
    "status",
    "type",
    "videoId",
  ]);
  assert.doesNotMatch(JSON.stringify(completed), /SECRET|signature|https?:|url/i);
});

test("bridge rejects stale SPA captures, clears the old identity, and accepts the current video", () => {
  const harness = loadBridge();
  harness.fromMain(inflight());
  harness.fromMain(capture());
  assert.equal(harness.runtimeMessages.length, 2);

  harness.location.href = `https://www.youtube.com/watch?v=${VIDEO_B}`;
  harness.events.dispatch("yt-navigate-finish");
  harness.runTimers(0);
  assert.equal(harness.runtimeMessages.at(-1).payload.type, "clear");
  assert.equal(harness.runtimeMessages.at(-1).payload.videoId, VIDEO_A);

  harness.fromMain(capture(VIDEO_A, "stale"));
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.payload.type === "capture" && message.payload.body === "stale",
    ).length,
    0,
  );
  harness.fromMain(inflight(VIDEO_B));
  harness.fromMain(capture(VIDEO_B, "current"));
  assert.equal(harness.runtimeMessages.at(-1).payload.type, "capture");
  assert.equal(harness.runtimeMessages.at(-1).payload.videoId, VIDEO_B);
  assert.equal(harness.runtimeMessages.at(-1).payload.body, "current");
});

test("bridge reinitialization rotates its nonce without disconnecting the live MAIN observer", () => {
  const harness = loadBridge();
  vm.runInContext(bridgeSource, harness.context);

  const actions = harness.controls.map((entry) => entry.message.action);
  assert.equal(actions.filter((action) => action === "connect").length, 2);
  assert.equal(actions.filter((action) => action === "disconnect").length, 0);
  harness.events.dispatch("pagehide");
  assert.equal(harness.controls.at(-1).message.action, "disconnect");
});

test("bridge enforces the 8 MiB boundary and clears known state on page teardown", () => {
  const harness = loadBridge();
  harness.fromMain(inflight());
  harness.fromMain(capture(VIDEO_A, "x".repeat(MAX_BODY_BYTES + 1)));
  assert.deepEqual(
    harness.runtimeMessages.map((message) => message.payload.type),
    ["inflight"],
  );

  harness.events.dispatch("pagehide");
  assert.equal(harness.runtimeMessages.at(-1).payload.type, "clear");
  assert.equal(harness.runtimeMessages.at(-1).payload.videoId, VIDEO_A);
  assert.equal(harness.controls.at(-1).message.action, "disconnect");
  assert.equal(harness.timers.size, 0);
});
