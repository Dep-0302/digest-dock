const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const core = require("../extension/core.js");

function capture(overrides = {}) {
  return {
    videoId: "jNQXAC9IVRw",
    language: "en",
    kind: "manual",
    format: "json3",
    status: 200,
    transport: "xhr",
    body: JSON.stringify({
      events: [
        {
          tStartMs: 1250,
          dDurationMs: 2000,
          segs: [{ utf8: "Hello " }, { utf8: "world" }],
        },
      ],
    }),
    ...overrides,
  };
}

test("normalizes an observed JSON3 response without initiating requests", () => {
  const result = core.normalizeCapture(capture(), "jNQXAC9IVRw");
  assert.equal(result.providerId, "youtube-passive");
  assert.equal(result.transcript[0].text, "Hello world");
  assert.equal(result.transcript[0].start, 1.25);
  assert.equal(result.diagnostics.requestsInitiated, 0);
  assert.equal(result.diagnostics.observedResponses, 1);
  assert.equal(JSON.stringify(result).includes("/api/timedtext"), false);
});

test("normalizes classic XML and srv3-shaped observed responses", () => {
  const classic = core.normalizeCapture(
    capture({
      format: "classic",
      body: '<transcript><text start="2.5" dur="1">Hello &amp; bye</text></transcript>',
      transport: "fetch",
    }),
  );
  assert.equal(classic.transcript[0].text, "Hello & bye");

  const srv3 = core.normalizeCapture(
    capture({
      format: "srv3",
      body: '<timedtext><body><p t="3000" d="1500"><s>Part </s><s>two</s></p></body></timedtext>',
    }),
  );
  assert.equal(srv3.transcript[0].text, "Part two");
  assert.equal(srv3.transcript[0].start, 3);
});

test("rejects stale videos, empty bodies, non-success status, and unknown transport", () => {
  assert.throws(
    () => core.normalizeCapture(capture(), "dQw4w9WgXcQ"),
    (error) => error.code === "PAGE_CONTEXT_CHANGED",
  );
  assert.throws(
    () => core.normalizeCapture(capture({ body: "" })),
    (error) => error.code === "EMPTY_TRANSCRIPT",
  );
  assert.throws(
    () => core.normalizeCapture(capture({ status: 429 })),
    (error) => error.code === "RATE_LIMITED",
  );
  assert.throws(
    () => core.normalizeCapture(capture({ transport: "beacon" })),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("the observer is document_start in MAIN and ISOLATED worlds", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.content_scripts.map(({ run_at, world }) => [run_at, world]),
    [
      ["document_start", "MAIN"],
      ["document_start", "ISOLATED"],
    ],
  );
});

test("the MAIN observer wraps existing requests but creates no request object", () => {
  const source = fs.readFileSync(
    path.join(root, "extension", "main-hook.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /new\s+XMLHttpRequest\s*\(/);
  assert.doesNotMatch(source, /originalFetch\s*\(\s*["'`]/);
  assert.match(source, /originalFetch\.apply\(this, args\)/);
  assert.match(source, /requestsInitiated|CAPTURE_CHANNEL/);
});

test("the bridge never writes transcript text to persistent local storage", () => {
  const bridge = fs.readFileSync(
    path.join(root, "extension", "bridge.js"),
    "utf8",
  );
  const worker = fs.readFileSync(
    path.join(root, "extension", "service-worker.js"),
    "utf8",
  );
  assert.doesNotMatch(bridge, /chrome\.storage/);
  assert.match(worker, /chrome\.storage\.session/);
  assert.doesNotMatch(worker, /chrome\.storage\.local/);
  assert.match(worker, /chrome\.tabs\.get\(tabId\)/);
  assert.match(worker, /MAX_CAPTURE_ENTRIES = 6/);
  assert.match(worker, /capture\.identity !== identity/);
  assert.match(worker, /captureMutationQueue/);
  assert.match(worker, /preferredLanguage/);
  assert.match(worker, /trackKind/);
  assert.doesNotMatch(worker, /staleKeys/);
});

test("fetch observation keeps one underlying request and the original response usable", async () => {
  const source = fs.readFileSync(
    path.join(root, "extension", "main-hook.js"),
    "utf8",
  );
  let underlyingFetches = 0;
  const messages = [];
  const listeners = new Map();
  const response = {
    url: "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en&fmt=json3",
    status: 200,
    clone() {
      return { text: async () => capture().body };
    },
    text: async () => capture().body,
  };
  class FakeXhr {}
  FakeXhr.prototype.open = function open() {};
  FakeXhr.prototype.send = function send() {};
  const window = {
    fetch: async () => {
      underlyingFetches += 1;
      return response;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message) {
      messages.push(message);
    },
  };
  window.window = window;
  const sandbox = {
    window,
    location: {
      href: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      origin: "https://www.youtube.com",
    },
    XMLHttpRequest: FakeXhr,
    URL,
    TextEncoder,
    TextDecoder,
  };
  vm.runInNewContext(source, sandbox);
  listeners.get("message")({
    source: window,
    origin: "https://www.youtube.com",
    data: {
      source: "digestdock-passive-control-v1",
      action: "connect",
      nonce: "a".repeat(32),
    },
  });

  const returned = await window.fetch(response.url);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(underlyingFetches, 1);
  assert.equal(await returned.text(), capture().body);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.transport, "fetch");
});

test("XHR observation keeps one underlying send and ignores non-timedtext", () => {
  const source = fs.readFileSync(
    path.join(root, "extension", "main-hook.js"),
    "utf8",
  );
  let sends = 0;
  const messages = [];
  let messageListener = null;
  class FakeXhr {
    constructor() {
      this.listeners = new Map();
      this.responseType = "";
      this.responseText = capture().body;
      this.responseURL =
        "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en&fmt=json3";
      this.status = 200;
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
  }
  FakeXhr.prototype.open = function open(_method, url) {
    this.openedUrl = url;
  };
  FakeXhr.prototype.send = function send() {
    sends += 1;
    this.listeners.get("load")?.();
  };
  const window = {
    fetch: async () => {},
    addEventListener(type, listener) {
      if (type === "message") messageListener = listener;
    },
    postMessage(message) {
      messages.push(message);
    },
  };
  window.window = window;
  vm.runInNewContext(source, {
    window,
    location: {
      href: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      origin: "https://www.youtube.com",
    },
    XMLHttpRequest: FakeXhr,
    URL,
    TextEncoder,
    TextDecoder,
  });
  messageListener({
    source: window,
    origin: "https://www.youtube.com",
    data: {
      source: "digestdock-passive-control-v1",
      action: "connect",
      nonce: "b".repeat(32),
    },
  });

  const timedtext = new FakeXhr();
  timedtext.open("GET", timedtext.responseURL);
  timedtext.send();
  const other = new FakeXhr();
  other.responseURL = "https://www.youtube.com/youtubei/v1/player";
  other.open("POST", other.responseURL);
  other.send();

  assert.equal(sends, 2);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.transport, "xhr");
});

test("timedtext tlang is treated as the actual captured text language", () => {
  const summary = core.summarizeTimedtextUrl(
    "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en&tlang=zh-CN&fmt=json3",
  );
  assert.equal(summary.sourceLanguage, "en");
  assert.equal(summary.translatedLanguage, "zh-CN");
  assert.equal(summary.language, "zh-CN");
});

test("MAIN and ISOLATED scripts require a per-document nonce handshake", () => {
  const main = fs.readFileSync(
    path.join(root, "extension", "main-hook.js"),
    "utf8",
  );
  const bridge = fs.readFileSync(
    path.join(root, "extension", "bridge.js"),
    "utf8",
  );
  assert.match(main, /action === "connect"/);
  assert.match(main, /event\.data\.nonce !== bridgeNonce/);
  assert.match(bridge, /crypto\.getRandomValues/);
  assert.match(bridge, /event\.data\?\.nonce !== nonce/);
});
