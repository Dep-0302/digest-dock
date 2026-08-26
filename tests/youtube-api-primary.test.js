// API-primary YouTube transcript contract.
//
// The mainline no longer extracts YouTube captions in the page. YouTube caption
// bodies come only from the user-authorized Supadata provider, gated by a
// read-only page identity/playability check, a saved key, and strict per-attempt
// consent, and collapsed by a background single-flight with a bounded 429
// cooldown. These offline tests pin that contract without any real network,
// Chrome, or Supadata call. (The file keeps its historical name; its subject is
// now the API-primary provider switch.)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const bilibiliAdapter = require("../bilibili.js");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

// A fetch double that never resolves but rejects with AbortError when the
// request signal aborts (used together with an immediate setTimeout to drive the
// provider timeout path deterministically).
function abortableFetch() {
  return async (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function loadBackground({
  settings = {
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "",
  },
  executeScript = async () => [{ result: null }],
  tabsGet = async (tabId) => ({
    id: tabId,
    url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  }),
  fetchImpl = async () => {
    throw new Error("unexpected fetch");
  },
  storageGet,
  storageSet = async () => {},
  storageSessionGet = async () => ({}),
  storageSessionSet = async () => {},
  bilibiliAdapterImpl = bilibiliAdapter,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const listeners = { addListener() {} };
  const runtimeMessageListeners = [];
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    Intl,
    AbortController,
    fetch: fetchImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get:
            storageGet ||
            (async (key) =>
              key === "ytd_settings" ? { ytd_settings: settings } : {}),
          set: storageSet,
          remove: async () => {},
        },
        session: {
          get: storageSessionGet,
          set: storageSessionSet,
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: async () => {},
      },
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            runtimeMessageListeners.push(listener);
          },
        },
        openOptionsPage() {},
        getURL: (resource) => `chrome-extension://test/${resource}`,
        sendMessage: async () => ({ success: true }),
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        get: tabsGet,
      },
      scripting: { executeScript },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
    BILIBILI_ADAPTER: bilibiliAdapterImpl,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return {
    helpers: sandbox.__YTD_TRANSLATION_TESTING__,
    runtimeMessageListeners,
    sandbox,
  };
}

// Read-only page gate result: identity + playability + source language only.
// It deliberately carries no caption tracks or signed request URLs.
function pageSnapshot(
  videoId = "jNQXAC9IVRw",
  language = "en",
  playability = "OK",
  playabilityReason = "",
) {
  return [
    {
      result: {
        ok: true,
        videoId,
        playability,
        playabilityReason,
        sourceLanguage: language,
      },
    },
  ];
}

test("the page gate reads no signed caption URL", () => {
  const background = read("background.js");
  const gate = background.match(
    /async function readYouTubePlayabilitySnapshot[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(gate, "expected the read-only playability snapshot function");
  assert.doesNotMatch(gate, /baseUrl/);
  assert.doesNotMatch(gate, /signature|timedtext/i);
  assert.match(gate, /playability/);
  assert.match(gate, /sourceLanguage/);
});

test("a new video without a Supadata key never touches the network", async () => {
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "" },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
  });

  for (const consent of [false, true]) {
    const result = await helpers.handleFetchYoutubeTranscript(
      "jNQXAC9IVRw",
      "en",
      42,
      consent,
    );
    assert.equal(result.success, false);
    assert.equal(result.error, "SUPADATA_NOT_CONFIGURED");
    assert.match(result.message, /Supadata/);
  }
  assert.equal(supadataCalls, 0);
});

test("a saved key without consent shows the single-attempt authorization", async () => {
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
  });

  const result = await helpers.handleFetchYoutubeTranscript(
    "jNQXAC9IVRw",
    "en",
    42,
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "SUPADATA_CONSENT_REQUIRED");
  assert.match(result.message, /Supadata/);
  assert.equal(supadataCalls, 0);
});

test("only strict boolean true authorizes the provider", async () => {
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({
        content: [{ text: "Line", offset: 0, duration: 1000, lang: "en" }],
        lang: "en",
      });
    },
  });

  for (const consent of [undefined, false, "true", 1, 0, null]) {
    const result = await helpers.handleFetchYoutubeTranscript(
      "jNQXAC9IVRw",
      "en",
      42,
      consent,
    );
    assert.equal(result.error, "SUPADATA_CONSENT_REQUIRED");
  }
  assert.equal(supadataCalls, 0);
});

test("consent triggers exactly one canonical mode=native request", async () => {
  const requestedUrls = [];
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot("jNQXAC9IVRw", "en"),
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return jsonResponse({
        content: [
          { text: "Approved line", offset: 1000, duration: 2000, lang: "en" },
        ],
        lang: "en",
      });
    },
  });

  const result = await helpers.handleFetchYoutubeTranscript(
    "jNQXAC9IVRw",
    "en-US",
    42,
    true,
  );

  assert.equal(result.success, true);
  assert.equal(result.source, "supadata");
  assert.equal(result.sourceAttempt, "SUPADATA");
  assert.equal(result.transcript[0].text, "Approved line");
  assert.equal(requestedUrls.length, 1);
  const url = new URL(requestedUrls[0]);
  assert.equal(url.hostname, "api.supadata.ai");
  assert.equal(
    url.searchParams.get("url"),
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  );
  assert.equal(url.searchParams.get("mode"), "native");
  assert.equal(url.searchParams.get("text"), "false");
  assert.equal(url.searchParams.get("lang"), "en-US");
  // The shared URL carries no browsing parameters.
  assert.equal(url.searchParams.get("list"), null);
  assert.equal(url.searchParams.get("t"), null);
});

test("duplicate authorized requests collapse into one provider call", async () => {
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot("jNQXAC9IVRw", "en"),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({
        content: [{ text: "Shared", offset: 0, duration: 1000, lang: "en" }],
        lang: "en",
      });
    },
  });

  // Side-panel init, the in-page Digest button, a page "complete" broadcast, and
  // a second window all target the same tab, video, and language at once.
  const results = await Promise.all([
    helpers.handleFetchYoutubeTranscript("jNQXAC9IVRw", "en", 42, true),
    helpers.handleFetchYoutubeTranscript("jNQXAC9IVRw", "en", 42, true),
    helpers.handleFetchYoutubeTranscript("jNQXAC9IVRw", "en", 42, true),
    helpers.handleFetchYoutubeTranscript("jNQXAC9IVRw", "en", 42, true),
  ]);

  for (const result of results) {
    assert.equal(result.success, true);
    assert.equal(result.transcript[0].text, "Shared");
  }
  assert.equal(supadataCalls, 1);
});

test("a stale page video is never sent to Supadata", async () => {
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => [
      { result: { ok: false, error: "PAGE_CONTEXT_CHANGED" } },
    ],
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
  });

  const result = await helpers.handleFetchYoutubeTranscript(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(supadataCalls, 0);
});

test("a pending navigation blocks an approved request for the old video", async () => {
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    tabsGet: async (tabId) => ({
      id: tabId,
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      pendingUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    }),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
  });

  const result = await helpers.handleFetchYoutubeTranscript(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(supadataCalls, 0);
});

test("a Supadata result is rejected if the tab navigates mid-flight", async () => {
  let tabsGetCalls = 0;
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    tabsGet: async (tabId) => {
      tabsGetCalls += 1;
      return {
        id: tabId,
        url:
          tabsGetCalls <= 2
            ? "https://www.youtube.com/watch?v=jNQXAC9IVRw"
            : "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      };
    },
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({
        content: [
          { text: "Old fallback line", offset: 0, duration: 1000, lang: "en" },
        ],
        lang: "en",
      });
    },
  });

  const result = await helpers.handleFetchYoutubeTranscript(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(supadataCalls, 1);
});

test("clear LOGIN/AGE/UNPLAYABLE states never reach Supadata", async (t) => {
  const cases = [
    { playability: "LOGIN_REQUIRED", code: "LOGIN_REQUIRED" },
    { playability: "AGE_CHECK_REQUIRED", code: "LOGIN_REQUIRED" },
    { playability: "UNPLAYABLE", code: "VIDEO_UNAVAILABLE" },
    { playability: "ERROR", code: "VIDEO_UNAVAILABLE" },
  ];
  for (const { playability, code } of cases) {
    await t.test(playability, async () => {
      let supadataCalls = 0;
      const { helpers } = loadBackground({
        settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
        executeScript: async () =>
          pageSnapshot("jNQXAC9IVRw", "en", playability),
        fetchImpl: async () => {
          supadataCalls += 1;
          return jsonResponse({});
        },
      });

      for (const consent of [false, true]) {
        const result = await helpers.handleFetchYoutubeTranscript(
          "jNQXAC9IVRw",
          "en",
          42,
          consent,
        );
        assert.equal(result.success, false);
        assert.equal(result.error, code);
        assert.equal(result.supadataEligible, false);
        assert.doesNotMatch(result.message, /本次使用 Supadata|Supadata 提取/);
      }
      assert.equal(supadataCalls, 0);
    });
  }
});

test("the classifier lets OK and unknown states proceed", () => {
  const { helpers } = loadBackground();
  assert.equal(helpers.classifyYouTubePlayability("OK"), null);
  assert.equal(helpers.classifyYouTubePlayability(""), null);
  assert.equal(helpers.classifyYouTubePlayability("SOMETHING_NEW"), null);
  assert.equal(
    helpers.classifyYouTubePlayability("LOGIN_REQUIRED"),
    "LOGIN_REQUIRED",
  );
  assert.equal(
    helpers.classifyYouTubePlayability("CONTENT_CHECK_REQUIRED"),
    "LOGIN_REQUIRED",
  );
  assert.equal(
    helpers.classifyYouTubePlayability("UNPLAYABLE", "This live event has ended"),
    "VIDEO_UNAVAILABLE",
  );
  assert.equal(
    helpers.classifyYouTubePlayability("ERROR", "members-only content"),
    "LOGIN_REQUIRED",
  );
});

test("the provider returns stable codes for every failure mode", async (t) => {
  const makeHelpers = (fetchImpl, extra = {}) =>
    loadBackground({
      settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
      fetchImpl,
      ...extra,
    }).helpers;

  await t.test("401 invalid key", async () => {
    const helpers = makeHelpers(async () => jsonResponse({}, 401));
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, "INVALID_SUPADATA_KEY");
  });

  await t.test("404 no transcript", async () => {
    const helpers = makeHelpers(async () => jsonResponse({}, 404));
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, "NO_TRANSCRIPT");
  });

  await t.test("206 no native track", async () => {
    const helpers = makeHelpers(async () => jsonResponse({}, 206));
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, "NO_TRANSCRIPT");
  });

  await t.test("429 rate limited", async () => {
    const helpers = makeHelpers(async () => jsonResponse({}, 429));
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, "RATE_LIMITED");
  });

  await t.test("provider HTTP failure", async () => {
    const helpers = makeHelpers(async () => jsonResponse({}, 503));
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, "PROVIDER_HTTP_ERROR");
    assert.match(result.message, /Supadata/);
  });

  await t.test("empty transcript", async () => {
    const helpers = makeHelpers(async () =>
      jsonResponse({ content: [], lang: "en" }),
    );
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, "EMPTY_TRANSCRIPT");
  });

  await t.test("network failure", async () => {
    const helpers = makeHelpers(async () => {
      throw new Error("connection reset");
    });
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, "NETWORK_ERROR");
  });

  await t.test("hard timeout", async () => {
    const helpers = makeHelpers(abortableFetch(), {
      setTimeoutImpl(callback) {
        callback();
        return 1;
      },
    });
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, "PROVIDER_TIMEOUT");
  });

  await t.test("response too large", async () => {
    const helpers = makeHelpers(async () =>
      textResponse("x".repeat(4096), 200),
    );
    const result = await helpers.handleFetchTranscript("v", "en", null, {
      maxResponseBytes: 16,
    });
    assert.equal(result.error, "RESPONSE_TOO_LARGE");
  });
});

test("a first Supadata 429 starts a bounded cooldown with no further network", async () => {
  let supadataCalls = 0;
  let sessionState = {};
  const storageSessionGet = async () => ({ ...sessionState });
  const storageSessionSet = async (items) => {
    sessionState = { ...sessionState, ...items };
  };
  const firstWorker = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    storageSessionGet,
    storageSessionSet,
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({}, 429);
    },
  });

  const first = await firstWorker.helpers.handleFetchYoutubeTranscript(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(first.error, "RATE_LIMITED");
  assert.equal(supadataCalls, 1);
  assert.ok(
    Number(sessionState.digestdock_supadata_cooldown_until) > Date.now(),
  );

  // A fresh service-worker instance must honor the session-stored cooldown.
  const secondWorker = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    storageSessionGet,
    storageSessionSet,
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
  });
  const second = await secondWorker.helpers.handleFetchYoutubeTranscript(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(second.error, "RATE_LIMITED");
  assert.match(second.message, /Supadata/);
  assert.doesNotMatch(second.message, /YouTube 限流|YouTube 暂时限/);
  // The cooldown kept the network-call count flat.
  assert.equal(supadataCalls, 1);
});

test("an out-of-range stored cooldown cannot disable Supadata indefinitely", async () => {
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    storageSessionGet: async () => ({
      digestdock_supadata_cooldown_until: Date.now() + 24 * 60 * 60 * 1000,
    }),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({
        content: [
          { text: "Allowed", offset: 0, duration: 1000, lang: "en" },
        ],
        lang: "en",
      });
    },
  });

  const result = await helpers.handleFetchYoutubeTranscript(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(result.success, true);
  assert.equal(supadataCalls, 1);
});

test("an async 202 job completes within the same authorization", async () => {
  let fetchCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    setTimeoutImpl(callback) {
      callback();
      return 1;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return jsonResponse({ jobId: "job-1" }, 202);
      return jsonResponse({
        status: "completed",
        content: [
          { text: "Async line", offset: 0, duration: 1000, lang: "en" },
        ],
        lang: "en",
      });
    },
  });

  const result = await helpers.handleFetchYoutubeTranscript(
    "jNQXAC9IVRw",
    "en",
    42,
    true,
  );
  assert.equal(result.success, true);
  assert.equal(result.source, "supadata");
  assert.equal(result.transcript[0].text, "Async line");
  assert.equal(fetchCalls, 2);
});

test("async polling stops when the user leaves the video", async () => {
  let fetchCalls = 0;
  let contextChecks = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    setTimeoutImpl(callback) {
      callback();
      return 1;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ jobId: "job-1" }, 202);
    },
  });

  const result = await helpers.handleFetchTranscript(
    "jNQXAC9IVRw",
    "en",
    async () => {
      contextChecks += 1;
      return contextChecks === 1;
    },
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(fetchCalls, 1);
});

test("async polling propagates provider-specific errors", async (t) => {
  const pollError = (status, code) => async () => {
    const { helpers } = loadBackground({
      settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
      setTimeoutImpl(callback) {
        callback();
        return 1;
      },
      fetchImpl: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls === 1) return jsonResponse({ jobId: "job-1" }, 202);
          return jsonResponse({}, status);
        };
      })(),
    });
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, code);
  };

  await t.test("polling 401", pollError(401, "INVALID_SUPADATA_KEY"));
  await t.test("polling 429", pollError(429, "RATE_LIMITED"));
  await t.test("polling 503", pollError(503, "PROVIDER_HTTP_ERROR"));
});

test("async polling returns stable failed and timeout codes", async (t) => {
  await t.test("provider job failed", async () => {
    let calls = 0;
    const { helpers } = loadBackground({
      settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
      setTimeoutImpl(callback) {
        callback();
        return 1;
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ jobId: "job-1" }, 202);
        return jsonResponse({ status: "failed" });
      },
    });
    const result = await helpers.handleFetchTranscript("v", "en");
    assert.equal(result.error, "PROVIDER_FAILED");
  });

  await t.test("provider job polling exhausted", async () => {
    let calls = 0;
    const { helpers } = loadBackground({
      settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
      setTimeoutImpl(callback) {
        callback();
        return 1;
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ jobId: "job-1" }, 202);
        return jsonResponse({ status: "active" });
      },
    });
    const result = await helpers.handleFetchTranscript("v", "en", null, {
      maxPollAttempts: 1,
    });
    assert.equal(result.error, "PROVIDER_TIMEOUT");
  });
});

test("a completed async job still rejects an empty transcript", async () => {
  let fetchCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    setTimeoutImpl(callback) {
      callback();
      return 1;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return jsonResponse({ jobId: "job-1" }, 202);
      return jsonResponse({ status: "completed", content: [], lang: "en" });
    },
  });

  const result = await helpers.handleFetchTranscript("jNQXAC9IVRw", "en");
  assert.equal(result.success, false);
  assert.equal(result.error, "EMPTY_TRANSCRIPT");
  assert.equal(fetchCalls, 2);
});

test("the media router keeps Bilibili isolated from Supadata", async () => {
  let supadataCalls = 0;
  let executeScriptCalls = 0;
  const mediaRef = {
    platform: "bilibili",
    bvid: "BV1zfg36ZEXi",
    aid: 123,
    cid: 456,
    page: 1,
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/",
  };
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => {
      executeScriptCalls += 1;
      return pageSnapshot();
    },
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
    bilibiliAdapterImpl: {
      ...bilibiliAdapter,
      async fetchTranscript() {
        return {
          transcript: [
            { text: "中文字幕。", start: 0, duration: 3, language: "zh-CN" },
          ],
          transcriptText: "中文字幕。",
          transcriptTextTimestamped: "[0:00] 中文字幕。",
          language: "zh-CN",
          selectedTrack: { language: "zh-CN", kind: "manual" },
        };
      },
    },
  });

  const result = await helpers.handleFetchMediaTranscript(mediaRef, "zh-CN", 42);
  assert.equal(result.success, true);
  assert.equal(result.source, "bilibili");
  assert.equal(supadataCalls, 0);
  assert.equal(executeScriptCalls, 0);
});

test("a cache-hit YouTube note reuses the cached transcript with no provider call", async () => {
  let supadataCalls = 0;
  let savedNotes = [];
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
    storageGet: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
        };
      }
      if (key === "digest_jNQXAC9IVRw") {
        return {
          digest_jNQXAC9IVRw: {
            transcript: [
              { text: "中文字幕。", start: 0, duration: 3, language: "zh-CN" },
            ],
            transcriptSourcePolicyVersion: 4,
            transcriptSource: "supadata",
            mediaRef: { platform: "youtube", videoId: "jNQXAC9IVRw" },
          },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: savedNotes };
      return {};
    },
    storageSet: async (items) => {
      if (Array.isArray(items.ytd_notes)) savedNotes = items.ytd_notes;
    },
  });

  const result = await helpers.handleSaveNote(
    "jNQXAC9IVRw",
    1,
    "视频",
    "频道",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    42,
    "zh-CN",
  );
  assert.equal(result.success, true);
  assert.equal(savedNotes[0].text, "中文字幕。");
  assert.equal(supadataCalls, 0);
});

test("a legacy local YouTube cache cannot masquerade as an API-primary result", async () => {
  let supadataCalls = 0;
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
    storageGet: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
        };
      }
      if (key === "digest_jNQXAC9IVRw") {
        return {
          digest_jNQXAC9IVRw: {
            transcript: [
              { text: "Legacy", start: 0, duration: 3, language: "en" },
            ],
            transcriptSourcePolicyVersion: 4,
            transcriptSource: "youtube-timedtext",
            mediaRef: { platform: "youtube", videoId: "jNQXAC9IVRw" },
          },
        };
      }
      return {};
    },
  });

  const result = await helpers.handleSaveNote(
    "jNQXAC9IVRw",
    1,
    "Video",
    "Channel",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    42,
    "en",
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "SUPADATA_CONSENT_REQUIRED");
  assert.equal(supadataCalls, 0);
});

test("a cache-miss YouTube note points the user to the side panel and calls no provider", async () => {
  let supadataCalls = 0;
  let savedNotes = [];
  const { helpers } = loadBackground({
    settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
    executeScript: async () => pageSnapshot(),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({});
    },
    storageGet: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: { aiApiKey: "test-key", supadataApiKey: "optional-key" },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: savedNotes };
      return {};
    },
    storageSet: async (items) => {
      if (Array.isArray(items.ytd_notes)) savedNotes = items.ytd_notes;
    },
  });

  const result = await helpers.handleSaveNote(
    "jNQXAC9IVRw",
    1,
    "视频",
    "频道",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    42,
    "en",
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "SUPADATA_CONSENT_REQUIRED");
  assert.match(result.message, /侧栏.*授权/);
  assert.equal(supadataCalls, 0);
  assert.equal(savedNotes.length, 0);
});

test("side panel and background stay wired to the API-primary contract", () => {
  const panel = read("sidepanel.js");
  const background = read("background.js");

  // Protocol and cache-policy versions moved forward together.
  assert.match(panel, /const REQUIRED_RUNTIME_PROTOCOL_VERSION = 11/);
  assert.match(background, /const RUNTIME_PROTOCOL_VERSION = 11/);
  assert.match(panel, /const TRANSCRIPT_SOURCE_POLICY_VERSION = 4/);
  assert.match(background, /const TRANSCRIPT_SOURCE_POLICY_VERSION = 4/);

  // Consent threading and per-attempt gating.
  assert.match(
    panel,
    /action: "fetchTranscript"[\s\S]*?preferredLanguage: currentVideoSourceLanguage,[\s\S]*?tabId: videoTabId,[\s\S]*?supadataConsent: supadataConsent === true/,
  );
  assert.match(
    panel,
    /action: "saveNote"[\s\S]*?tabId: videoTabId,[\s\S]*?preferredLanguage:/,
  );
  assert.match(background, /message\.supadataConsent === true/);
  assert.match(background, /supadataConsent !== true/);
  assert.match(background, /tab\?\.pendingUrl \|\| tab\?\.url/);
  assert.match(panel, /latestTab\.pendingUrl \|\| latestTab\.url/);

  // API-primary consent copy; no local-first framing.
  assert.match(panel, /本次使用 Supadata/);
  assert.match(panel, /不使用第三方服务/);
  assert.match(panel, /SUPADATA_CONSENT_REQUIRED/);
  assert.match(panel, /SUPADATA_NOT_CONFIGURED/);
  assert.match(panel, /showSupadataRateLimited/);
  assert.match(panel, /showSupadataProviderError/);
  assert.match(panel, /showSupadataInvalidKey/);
  assert.match(panel, /Supadata 暂时限流/);
  assert.doesNotMatch(panel, /YouTube 暂时限流/);
  assert.doesNotMatch(panel, /继续使用 YouTube 原生字幕/);
  assert.doesNotMatch(panel, /重试 YouTube 原生字幕/);
  assert.doesNotMatch(panel, /formatLocalTranscriptDiagnostics/);

  // v4 accepts only the provider bound to the cached platform.
  assert.match(
    panel,
    /cachedPlatform === "bilibili" \? "bilibili" : "supadata"[\s\S]*?cached\.transcriptSource !== expectedSource/,
  );

  // The stored transcript-source-attempt sanitizer never leaks a signed URL.
  const sanitizer = panel.match(
    /function sanitizeTranscriptSelectedTrack\(track\)[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(sanitizer);
  assert.doesNotMatch(sanitizer, /baseUrl|signature|token/i);
});
