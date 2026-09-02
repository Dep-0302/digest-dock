// Passive-first YouTube transcript and explicit Supadata fallback contract.
//
// The mainline is cache/Passive -> prompt the user to enable CC -> one explicit
// free retry. Supadata is reachable only after that retry still returns UNKNOWN
// and the user explicitly authorizes that video. These offline tests retain the
// provider boundary and migration coverage without any real network, Chrome,
// or Supadata call. The file keeps its historical name so commands stay stable.

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

// Read-only page gate result: identity, playability, source language, and an
// optional text-free caption-track summary. It carries no track URL or body.
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
  assert.match(gate, /captionTrackCountKnown/);
  assert.match(gate, /captionTrackCount/);
  assert.match(gate, /availableTracks/);
  assert.match(gate, /pageDefaultTrack/);
  assert.match(gate, /pageCurrentTrack/);
});

function executePageGateWithResponse(response, { live = true } = {}) {
  return async (details) => {
    const source = `(${details.func.toString()})(${JSON.stringify(details.args?.[0])})`;
    const result = vm.runInNewContext(source, {
      document: {
        getElementById: () => ({
          getPlayerResponse: () => (live ? response : null),
        }),
      },
      window: { ytInitialPlayerResponse: response },
      Object,
      String,
      Array,
      Boolean,
      RegExp,
    });
    return [{ result }];
  };
}

function executePlayerDetailsWithResponse(response, currentTrack = null) {
  return async (details) => {
    const source = `(${details.func.toString()})()`;
    const result = vm.runInNewContext(source, {
      document: {
        getElementById: () => ({
          getPlayerResponse: () => response,
          getOption: () => currentTrack,
        }),
      },
      window: { ytInitialPlayerResponse: response },
      Object,
      String,
      Array,
      Boolean,
      RegExp,
      Set,
      Number,
    });
    return [{ result }];
  };
}

test("page gate confirms zero tracks only from the exact live playable response", async () => {
  const response = {
    videoDetails: { videoId: "jNQXAC9IVRw", isLiveContent: false },
    playabilityStatus: { status: "OK" },
  };
  const liveGate = loadBackground({
    executeScript: executePageGateWithResponse(response),
  }).helpers;
  const live = await liveGate.readYouTubePlayabilitySnapshot(
    42,
    "jNQXAC9IVRw",
  );
  assert.equal(live.captionTrackCountKnown, true);
  assert.equal(live.captionTrackCount, 0);
  assert.equal(live.pageDefaultTrack, null);

  const fallbackGate = loadBackground({
    executeScript: executePageGateWithResponse(response, { live: false }),
  }).helpers;
  const fallback = await fallbackGate.readYouTubePlayabilitySnapshot(
    42,
    "jNQXAC9IVRw",
  );
  assert.equal(fallback.captionTrackCountKnown, false);
  assert.equal(fallback.captionTrackCount, null);

  for (const isLiveContent of [true, undefined]) {
    const uncertainResponse = {
      ...response,
      videoDetails: {
        videoId: "jNQXAC9IVRw",
        ...(isLiveContent === undefined ? {} : { isLiveContent }),
      },
    };
    const uncertainGate = loadBackground({
      executeScript: executePageGateWithResponse(uncertainResponse),
    }).helpers;
    const uncertain = await uncertainGate.readYouTubePlayabilitySnapshot(
      42,
      "jNQXAC9IVRw",
    );
    assert.equal(uncertain.captionTrackCountKnown, false);
    assert.equal(uncertain.captionTrackCount, null);
  }
});

test("page gate returns one sanitized default track without signed fields", async () => {
  const response = {
    videoDetails: { videoId: "jNQXAC9IVRw", isLiveContent: false },
    playabilityStatus: { status: "OK" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            languageCode: "en_US",
            kind: "asr",
            vssId: "a.en",
            baseUrl: "https://www.youtube.com/api/timedtext?signature=secret",
          },
        ],
      },
    },
  };
  const helpers = loadBackground({
    executeScript: executePageGateWithResponse(response),
  }).helpers;
  const snapshot = await helpers.readYouTubePlayabilitySnapshot(
    42,
    "jNQXAC9IVRw",
  );
  assert.equal(snapshot.captionTrackCountKnown, true);
  assert.equal(snapshot.captionTrackCount, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.pageDefaultTrack)),
    { language: "en-US", kind: "asr" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.availableTracks)),
    [{ language: "en-US", kind: "asr" }],
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /baseUrl|signature|timedtext|secret/i,
  );
});

test("page gate does not guess a default from multiple unranked tracks", async () => {
  const response = {
    videoDetails: { videoId: "jNQXAC9IVRw", isLiveContent: false },
    playabilityStatus: { status: "OK" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "en", vssId: ".en" },
          { languageCode: "de", vssId: ".de" },
        ],
      },
    },
  };
  const helpers = loadBackground({
    executeScript: executePageGateWithResponse(response),
  }).helpers;
  const snapshot = await helpers.readYouTubePlayabilitySnapshot(
    42,
    "jNQXAC9IVRw",
  );
  assert.equal(snapshot.captionTrackCountKnown, true);
  assert.equal(snapshot.captionTrackCount, 2);
  assert.equal(snapshot.pageDefaultTrack, null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.availableTracks)),
    [
      { language: "en", kind: "manual" },
      { language: "de", kind: "manual" },
    ],
  );
});

test("video metadata exposes only the automatic caption selection and no signed fields", async () => {
  const response = {
    videoDetails: {
      videoId: "jNQXAC9IVRw",
      title: "title",
      author: "author",
      shortDescription: "description",
      lengthSeconds: "10",
      defaultAudioLanguage: "en",
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "en", vssId: ".en", baseUrl: "https://secret" },
          { languageCode: "zh-Hans", kind: "asr", vssId: "a.zh" },
          { languageCode: "zh-Hant", vssId: ".zh-Hant" },
          { languageCode: "yue-HK", vssId: ".yue" },
        ],
      },
    },
  };
  const helpers = loadBackground({
    executeScript: executePlayerDetailsWithResponse(
      response,
      response.captions.playerCaptionsTracklistRenderer.captionTracks[0],
    ),
  }).helpers;
  const details = await helpers.getPlayerVideoDetails(42);
  assert.deepEqual(JSON.parse(JSON.stringify(details.captionSelection)), {
    language: "zh-Hant",
    kind: "manual",
  });
  assert.doesNotMatch(JSON.stringify(details), /baseUrl|https:\/\/secret/);

  const merged = helpers.mergeYouTubeVideoInfo(
    details,
    { videoId: "jNQXAC9IVRw" },
    "jNQXAC9IVRw",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(merged.captionSelection)), {
    language: "zh-Hant",
    kind: "manual",
  });
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

test("explicit consent without an exact tab identity sends no provider request", async () => {
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
    null,
    true,
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(supadataCalls, 0);
});

test("consent triggers exactly one canonical mode=native request", async () => {
  const requestedUrls = [];
  const { helpers } = loadBackground({
    settings: { supadataApiKey: "optional-key" },
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

test("a simultaneous navigation cannot erase Supadata 429 cooldown", async () => {
  let tabsGetCalls = 0;
  let supadataCalls = 0;
  const sessionState = {};
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
    storageSessionGet: async (key) => ({ [key]: sessionState[key] }),
    storageSessionSet: async (items) => Object.assign(sessionState, items),
    fetchImpl: async () => {
      supadataCalls += 1;
      return jsonResponse({}, 429);
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
  assert.ok(Number(sessionState.digestdock_supadata_cooldown_until) > Date.now());
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
            transcriptSourcePolicyVersion: 5,
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
    "",
    true,
  );
  assert.equal(result.success, true);
  assert.equal(savedNotes[0].text, "中文字幕。");
  assert.equal(supadataCalls, 0);
});

test("a legacy v4 YouTube cache cannot masquerade as a current native result", async () => {
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
  assert.equal(result.error, "TRANSCRIPT_TASK_REQUIRED");
  assert.match(result.message, /侧栏.*字幕任务/);
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
  assert.equal(result.error, "TRANSCRIPT_TASK_REQUIRED");
  assert.match(result.message, /侧栏.*字幕任务/);
  assert.equal(supadataCalls, 0);
  assert.equal(savedNotes.length, 0);
});

test("side panel and background stay wired to the Passive-first contract", () => {
  const panel = read("sidepanel.js");
  const background = read("background.js");

  // Protocol and cache-policy versions moved forward together.
  assert.match(panel, /const REQUIRED_RUNTIME_PROTOCOL_VERSION = 12/);
  assert.match(background, /const RUNTIME_PROTOCOL_VERSION = 12/);
  assert.match(panel, /const TRANSCRIPT_SOURCE_POLICY_VERSION = 5/);
  assert.match(background, /const TRANSCRIPT_SOURCE_POLICY_VERSION = 5/);

  // Run identity, request shape, and per-attempt third-party gating.
  assert.match(
    panel,
    /function buildTranscriptFetchRequest[\s\S]*?trackKind: YOUTUBE_TRANSCRIPT_TRACK_KIND,[\s\S]*?runId,[\s\S]*?digestGeneration: generation,[\s\S]*?routeKey,[\s\S]*?supadataConsent: supadataConsent === true,[\s\S]*?captionRetry: captionRetry === true/,
  );
  assert.match(
    panel,
    /action: "saveNote"[\s\S]*?tabId: videoTabId,[\s\S]*?preferredLanguage:/,
  );
  assert.match(background, /message\.supadataConsent === true/);
  assert.match(background, /supadataConsent !== true/);
  assert.match(background, /tab\?\.pendingUrl \|\| tab\?\.url/);
  assert.match(panel, /latestTab\.pendingUrl \|\| latestTab\.url/);

  // The first miss shows the CC prompt; Supadata remains an explicit fallback
  // shown only after the user's free retry still ends UNKNOWN.
  assert.match(panel, /请先打开 YouTube 字幕/);
  assert.match(panel, /已打开字幕，重新读取/);
  assert.match(panel, /captionRetry: captionRetry === true/);
  assert.match(background, /captionRetry: message\.captionRetry === true/);
  assert.match(panel, /function shouldOfferSupadata\(result\)[\s\S]*?=== "UNKNOWN"/);
  assert.match(panel, /本次使用 Supadata/);
  assert.match(panel, /不使用第三方服务/);
  assert.match(panel, /SUPADATA_NOT_CONFIGURED/);
  assert.match(panel, /showSupadataRateLimited/);
  assert.match(panel, /showSupadataProviderError/);
  assert.match(panel, /showSupadataInvalidKey/);
  assert.match(panel, /Supadata 暂时限流/);
  assert.doesNotMatch(panel, /YouTube 暂时限流/);
  assert.doesNotMatch(panel, /继续使用 YouTube 原生字幕/);
  assert.doesNotMatch(panel, /重试 YouTube 原生字幕/);
  assert.doesNotMatch(panel, /formatLocalTranscriptDiagnostics/);

  // v5 keeps old positive caches readable. Active is the one fixed automatic
  // route after Passive; Panel remains experiment-only.
  for (const source of [
    "youtube-passive",
    "youtube-active",
    "youtube-panel",
    "supadata",
  ]) {
    assert.match(panel, new RegExp(`YOUTUBE_TRANSCRIPT_SOURCES[\\s\\S]*?${source}`));
    assert.match(background, new RegExp(`YOUTUBE_TRANSCRIPT_CACHE_SOURCES[\\s\\S]*?${source}`));
  }
  const nativeHandler = background.match(
    /async function handleFetchYoutubeNativeTranscript[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(nativeHandler);
  assert.ok(
    nativeHandler.indexOf("awaitYoutubePassiveGate") <
      nativeHandler.indexOf("chooseYoutubeAutomaticTrack") &&
      nativeHandler.indexOf("chooseYoutubeAutomaticTrack") <
        nativeHandler.indexOf("runYoutubeNativeSingleFlight") &&
      nativeHandler.indexOf("runYoutubeNativeSingleFlight") <
      nativeHandler.indexOf("YOUTUBE_CAPTIONS_REQUIRED"),
  );
  assert.match(nativeHandler, /runYoutubeNativeRouteLeader/);
  assert.match(nativeHandler, /runYoutubeNativeSingleFlight/);
  assert.doesNotMatch(background, /YOUTUBE_PANEL_PRODUCT_FILE/);
  assert.match(background, /if \(supadataConsent === true\)/);
  assert.match(background, /youtubeUnknownFallbackResult/);

  // The stored transcript-source-attempt sanitizer never leaks a signed URL.
  const sanitizer = panel.match(
    /function sanitizeTranscriptSelectedTrack\(track\)[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(sanitizer);
  assert.doesNotMatch(sanitizer, /baseUrl|signature|token/i);
});
