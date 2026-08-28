const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const backgroundSource = fs.readFileSync(
  path.join(root, "background.js"),
  "utf8",
);
const bilibiliAdapter = require("../bilibili.js");

const VIDEO_ID = "jNQXAC9IVRw";
const OTHER_VIDEO_ID = "aqz-KE-bpKQ";

function transcriptResult(label = "native") {
  return {
    status: "HAVE_TRANSCRIPT",
    providerVariant: "isolated-tab",
    language: "en",
    selectedTrack: { language: "en", kind: "manual" },
    transcript: [
      { text: `${label} line`, start: 0, duration: 2, language: "en" },
    ],
    diagnostics: {
      providerInitiated: {
        youtubePlayer: 1,
        youtubeTimedtext: 1,
        thirdParty: 0,
        loopback: 0,
      },
    },
  };
}

function json3Body(text = "passive line") {
  return JSON.stringify({
    events: [
      {
        tStartMs: 0,
        dDurationMs: 2000,
        segs: [{ utf8: text }],
      },
    ],
  });
}

function pageSnapshot(videoId = VIDEO_ID, options = {}) {
  return [
    {
      result: {
        ok: true,
        videoId,
        playability: options.playability || "OK",
        playabilityReason: options.playabilityReason || "",
        sourceLanguage: options.sourceLanguage || "en",
        captionTrackCountKnown: options.captionTrackCountKnown === true,
        captionTrackCount:
          options.captionTrackCountKnown === true
            ? Number(options.captionTrackCount || 0)
            : null,
        pageDefaultTrack: options.pageDefaultTrack || null,
      },
    },
  ];
}

function loadBackground({
  settings = { aiApiKey: "test", supadataApiKey: "" },
  activeResult = transcriptResult("active"),
  panelResult = transcriptResult("panel"),
  activeRun,
  panelRun,
  tabVideoIds = new Map([
    [1, VIDEO_ID],
    [2, VIDEO_ID],
  ]),
  fetchImpl = async () => {
    throw new Error("unexpected network request");
  },
  storageLocalGet,
  pageSnapshotOptions = {},
  bilibiliAdapterImpl = bilibiliAdapter,
} = {}) {
  const counts = {
    activeInject: 0,
    activeRun: 0,
    panelInject: 0,
    panelRun: 0,
    fetch: 0,
  };
  const localState = { ytd_settings: settings };
  const sessionState = {};
  const runtimeMessageListeners = [];
  const listeners = { addListener() {} };

  const executeScript = async (details) => {
    if (details.files?.includes("youtube-transcript-active.js")) {
      counts.activeInject += 1;
      return [];
    }
    if (details.files?.includes("youtube-transcript-panel.js")) {
      counts.panelInject += 1;
      return [];
    }
    if (details.args?.[0] === "DIGESTDOCK_YOUTUBE_ACTIVE") {
      counts.activeRun += 1;
      const request = details.args[1];
      return [
        {
          result: activeRun
            ? await activeRun(request)
            : typeof activeResult === "function"
              ? await activeResult(request)
              : activeResult,
        },
      ];
    }
    if (details.args?.[0] === "DIGESTDOCK_YOUTUBE_PANEL") {
      counts.panelRun += 1;
      const request = details.args[1];
      return [
        {
          result: panelRun
            ? await panelRun(request)
            : typeof panelResult === "function"
              ? await panelResult(request)
              : panelResult,
        },
      ];
    }
    return pageSnapshot(
      tabVideoIds.get(details.target?.tabId) || VIDEO_ID,
      pageSnapshotOptions,
    );
  };

  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    Intl,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (...args) => {
      counts.fetch += 1;
      return fetchImpl(...args);
    },
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get:
            storageLocalGet ||
            (async (key) =>
              typeof key === "string"
                ? { [key]: localState[key] }
                : { ...localState }),
          set: async (items) => Object.assign(localState, items),
          remove: async (key) => delete localState[key],
          clear: async () => {
            for (const key of Object.keys(localState)) delete localState[key];
          },
        },
        session: {
          get: async (key) =>
            typeof key === "string"
              ? { [key]: sessionState[key] }
              : { ...sessionState },
          set: async (items) => Object.assign(sessionState, items),
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: async () => {},
        open: async () => {},
      },
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            runtimeMessageListeners.push(listener);
          },
        },
        openOptionsPage() {},
        getURL: (value) => `chrome-extension://test/${value}`,
        getManifest: () => ({ version: "test" }),
        sendMessage: async () => ({ success: true }),
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        get: async (tabId) => {
          const videoId = tabVideoIds.get(tabId);
          if (!videoId) throw new Error("tab missing");
          return {
            id: tabId,
            url: `https://www.youtube.com/watch?v=${videoId}`,
          };
        },
        query: async () => [],
        sendMessage: async () => ({ success: true }),
      },
      scripting: { executeScript },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value || {},
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      apiKeyFor: () => "test",
    },
    BILIBILI_ADAPTER: bilibiliAdapterImpl,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(backgroundSource, sandbox);

  const dispatch = (message, sender = {}) =>
    new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of runtimeMessageListeners) {
        const keepOpen = listener(message, sender, resolve);
        if (keepOpen === true) {
          handled = true;
          break;
        }
      }
      if (!handled) reject(new Error(`unhandled action: ${message.action}`));
    });

  return {
    helpers: sandbox.__YTD_TRANSLATION_TESTING__,
    counts,
    sessionState,
    tabVideoIds,
    dispatch,
  };
}

function nativeOptions(
  runId = "1",
  routeKey = `youtube:${VIDEO_ID}`,
  captionRetry = false,
) {
  return {
    runId,
    digestGeneration: Number(runId),
    routeKey,
    trackKind: "manual-first",
    captionRetry: captionRetry === true,
  };
}

test("Passive capture ends the route with zero Active, Panel, and third-party calls", async () => {
  const worker = loadBackground();
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "inflight",
        videoId: VIDEO_ID,
        language: "en",
        kind: "manual",
        status: 0,
        inFlight: true,
      },
    },
    { tab: { id: 1 } },
  );
  const passive = await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "capture",
        videoId: VIDEO_ID,
        language: "en",
        kind: "manual",
        status: 200,
        inFlight: false,
        body: json3Body(),
      },
    },
    { tab: { id: 1 } },
  );
  assert.equal(passive.ok, true);

  const result = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("7"),
  );
  assert.equal(result.success, true);
  assert.equal(result.routeOutcome, "HAVE_TRANSCRIPT");
  assert.equal(result.source, "youtube-passive");
  assert.equal(result.transcript[0].text, "passive line");
  assert.equal(result.runId, "7");
  assert.equal(result.routeKey, `youtube:${VIDEO_ID}`);
  assert.equal(worker.counts.activeRun, 0);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
  assert.doesNotMatch(
    JSON.stringify(worker.sessionState.youtube_passive_session_buffer),
    /https?:|signature|expire/i,
  );
});

test("an in-flight Passive response waits once and wins before the CC prompt", async () => {
  const worker = loadBackground();
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "inflight",
        videoId: VIDEO_ID,
        language: "en",
        kind: "manual",
        status: 0,
        inFlight: true,
      },
    },
    { tab: { id: 1 } },
  );

  const pending = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("8"),
  );
  await Promise.resolve();
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "capture",
        videoId: VIDEO_ID,
        language: "en",
        kind: "manual",
        status: 200,
        inFlight: false,
        body: json3Body("arrived while waiting"),
      },
    },
    { tab: { id: 1 } },
  );
  const result = await pending;
  assert.equal(result.source, "youtube-passive");
  assert.equal(result.transcript[0].text, "arrived while waiting");
  assert.equal(worker.counts.activeRun, 0);
});

test("an unsolicited Passive body is rejected and never enters the session buffer", async () => {
  const worker = loadBackground();
  const response = await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "capture",
        videoId: VIDEO_ID,
        language: "en",
        kind: "manual",
        status: 200,
        inFlight: false,
        body: json3Body("unsolicited"),
      },
    },
    { tab: { id: 1 } },
  );
  assert.equal(response.ok, false);
  assert.equal(response.error, "PASSIVE_CAPTURE_NOT_INFLIGHT");
  assert.equal(worker.sessionState.youtube_passive_session_buffer, undefined);
});

test("an observed Passive 429 clears inflight state and blocks automatic routes", async (t) => {
  for (const type of ["clear", "capture"]) {
    await t.test(type, async () => {
      const worker = loadBackground();
      await worker.dispatch(
        {
          action: "youtubePassiveState",
          payload: {
            type: "inflight",
            videoId: VIDEO_ID,
            language: "en",
            kind: "manual",
            status: 0,
            inFlight: true,
          },
        },
        { tab: { id: 1 } },
      );
      const observed = await worker.dispatch(
        {
          action: "youtubePassiveState",
          payload: {
            type,
            videoId: VIDEO_ID,
            language: "en",
            kind: "manual",
            status: 429,
            inFlight: false,
            ...(type === "capture" ? { body: "bounded error body" } : {}),
          },
        },
        { tab: { id: 1 } },
      );
      assert.equal(observed.ok, true);
      assert.equal(observed.state, "rate-limited");
      assert.equal(
        worker.sessionState.youtube_passive_session_buffer.length,
        0,
      );
      assert.ok(
        Number(worker.sessionState.youtube_native_cooldown_until) > Date.now(),
      );

      const first = await worker.helpers.handleFetchYoutubeNativeTranscript(
        VIDEO_ID,
        "en",
        1,
        nativeOptions(type === "clear" ? "81" : "82"),
      );
      assert.equal(first.routeOutcome, "UNKNOWN");
      assert.equal(first.error, "YOUTUBE_CAPTIONS_REQUIRED");
      assert.equal(first.supadataEligible, false);

      const retry = await worker.helpers.handleFetchYoutubeNativeTranscript(
        VIDEO_ID,
        "en",
        1,
        nativeOptions(
          type === "clear" ? "83" : "84",
          `youtube:${VIDEO_ID}`,
          true,
        ),
      );
      assert.equal(retry.routeOutcome, "UNKNOWN");
      assert.equal(retry.error, "RATE_LIMITED");
      assert.equal(retry.supadataEligible, true);
      assert.equal(worker.counts.activeRun, 0);
      assert.equal(worker.counts.panelRun, 0);
    });
  }
});

test("Passive miss asks the user to enable CC without Active, Panel, or Supadata", async () => {
  const worker = loadBackground({
    settings: { aiApiKey: "test", supadataApiKey: "optional-key" },
  });
  const result = await worker.helpers.handleFetchYoutubeTranscript(
    VIDEO_ID,
    "en",
    1,
    false,
    nativeOptions("9"),
  );

  assert.equal(result.success, false);
  assert.equal(result.routeOutcome, "UNKNOWN");
  assert.equal(result.supadataEligible, false);
  assert.match(result.message, /打开.*字幕|字幕.*打开|CC/i);
  assert.equal(worker.counts.activeInject, 0);
  assert.equal(worker.counts.activeRun, 0);
  assert.equal(worker.counts.panelInject, 0);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});

test("page-confirmed zero caption tracks stay terminal before and after caption retry", async () => {
  const worker = loadBackground({
    settings: { aiApiKey: "test", supadataApiKey: "optional-key" },
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 0,
    },
  });

  const results = [
    await worker.helpers.handleFetchYoutubeNativeTranscript(
      VIDEO_ID,
      "en",
      1,
      nativeOptions("83"),
    ),
    await worker.helpers.handleFetchYoutubeNativeTranscript(
      VIDEO_ID,
      "en",
      1,
      nativeOptions("84", "youtube:" + VIDEO_ID, true),
    ),
  ];

  for (const result of results) {
    assert.equal(result.success, false);
    assert.equal(result.routeOutcome, "CONFIRMED_UNAVAILABLE");
    assert.equal(result.error, "NO_TRANSCRIPT");
    assert.equal(result.supadataEligible, false);
  }
  assert.equal(worker.counts.activeInject, 0);
  assert.equal(worker.counts.activeRun, 0);
  assert.equal(worker.counts.panelInject, 0);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});

test("login-required and unavailable pages stay terminal without fallbacks", async (t) => {
  for (const testCase of [
    {
      playability: "LOGIN_REQUIRED",
      error: "LOGIN_REQUIRED",
      runId: "85",
    },
    {
      playability: "UNPLAYABLE",
      error: "VIDEO_UNAVAILABLE",
      runId: "86",
    },
  ]) {
    await t.test(testCase.playability, async () => {
      const worker = loadBackground({
        settings: { aiApiKey: "test", supadataApiKey: "optional-key" },
        pageSnapshotOptions: { playability: testCase.playability },
      });
      const result = await worker.helpers.handleFetchYoutubeNativeTranscript(
        VIDEO_ID,
        "en",
        1,
        nativeOptions(testCase.runId, "youtube:" + VIDEO_ID, true),
      );

      assert.equal(result.success, false);
      assert.equal(result.routeOutcome, "CONFIRMED_UNAVAILABLE");
      assert.equal(result.error, testCase.error);
      assert.equal(result.supadataEligible, false);
      assert.equal(worker.counts.activeInject, 0);
      assert.equal(worker.counts.activeRun, 0);
      assert.equal(worker.counts.panelInject, 0);
      assert.equal(worker.counts.panelRun, 0);
      assert.equal(worker.counts.fetch, 0);
    });
  }
});

test("only strict captionRetry true exposes configured or unconfigured Supadata fallback", async (t) => {
  for (const testCase of [
    {
      name: "configured",
      supadataApiKey: "optional-key",
      expectedError: "SUPADATA_CONSENT_REQUIRED",
    },
    {
      name: "unconfigured",
      supadataApiKey: "",
      expectedError: "SUPADATA_NOT_CONFIGURED",
    },
  ]) {
    await t.test(testCase.name, async () => {
      const worker = loadBackground({
        settings: {
          aiApiKey: "test",
          supadataApiKey: testCase.supadataApiKey,
        },
      });
      const baseMessage = {
        action: "fetchTranscript",
        mediaRef: { platform: "youtube", videoId: VIDEO_ID },
        videoId: VIDEO_ID,
        preferredLanguage: "en",
        tabId: 1,
        trackKind: "manual-first",
        supadataConsent: false,
      };

      const truthyOnly = await worker.dispatch(
        {
          ...baseMessage,
          runId: "truthy-" + testCase.name,
          digestGeneration: 91,
          routeKey: "youtube:" + VIDEO_ID,
          captionRetry: "true",
        },
        { tab: { id: 1 } },
      );
      assert.equal(truthyOnly.routeOutcome, "UNKNOWN");
      assert.equal(truthyOnly.supadataEligible, false);
      assert.notEqual(truthyOnly.error, testCase.expectedError);

      const strict = await worker.dispatch(
        {
          ...baseMessage,
          runId: "strict-" + testCase.name,
          digestGeneration: 92,
          routeKey: "youtube:" + VIDEO_ID,
          captionRetry: true,
        },
        { tab: { id: 1 } },
      );
      assert.equal(strict.success, false);
      assert.equal(strict.routeOutcome, "UNKNOWN");
      assert.equal(strict.error, testCase.expectedError);
      assert.equal(strict.supadataEligible, true);
      assert.equal(worker.counts.activeInject, 0);
      assert.equal(worker.counts.activeRun, 0);
      assert.equal(worker.counts.panelInject, 0);
      assert.equal(worker.counts.panelRun, 0);
      assert.equal(worker.counts.fetch, 0);
    });
  }
});

test("page changes remain PAGE_CONTEXT_CHANGED while waiting for Passive", async () => {
  const worker = loadBackground({
    settings: { aiApiKey: "test", supadataApiKey: "optional-key" },
  });
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "inflight",
        videoId: VIDEO_ID,
        language: "en",
        kind: "manual",
        status: 0,
        inFlight: true,
      },
    },
    { tab: { id: 1 } },
  );

  const pending = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("12", "youtube:" + VIDEO_ID, true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  worker.tabVideoIds.set(1, OTHER_VIDEO_ID);
  worker.helpers.bumpYoutubeTabNavigationEpoch(1);
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "clear",
        videoId: VIDEO_ID,
        language: "en",
        kind: "manual",
        status: 0,
        inFlight: false,
      },
    },
    { tab: { id: 1 } },
  );

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.routeOutcome, "PAGE_CONTEXT_CHANGED");
  assert.equal(result.error, "PAGE_CONTEXT_CHANGED");
  assert.equal(result.supadataEligible, false);
  assert.equal(result.runId, "12");
  assert.equal(worker.counts.activeInject, 0);
  assert.equal(worker.counts.activeRun, 0);
  assert.equal(worker.counts.panelInject, 0);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});

test("an explicit CC retry offers Supadata without calling it; consent bypasses the free chain", async () => {
  const noConsent = loadBackground({
    settings: { aiApiKey: "test", supadataApiKey: "optional-key" },
    activeResult: { status: "UNKNOWN", errorCode: "PROBE_FAILED" },
    panelResult: { status: "UNKNOWN", errorCode: "PANEL_HTTP_400" },
  });
  const unknown = await noConsent.helpers.handleFetchYoutubeTranscript(
    VIDEO_ID,
    "en",
    1,
    false,
    nativeOptions("41", `youtube:${VIDEO_ID}`, true),
  );
  assert.equal(unknown.routeOutcome, "UNKNOWN");
  assert.equal(unknown.error, "SUPADATA_CONSENT_REQUIRED");
  assert.equal(unknown.nativeError, "YOUTUBE_CAPTIONS_STILL_UNAVAILABLE");
  assert.equal(unknown.supadataEligible, true);
  assert.equal(noConsent.counts.fetch, 0);

  const consented = loadBackground({
    settings: { aiApiKey: "test", supadataApiKey: "optional-key" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          { text: "paid fallback", offset: 0, duration: 1000, lang: "en" },
        ],
        lang: "en",
      }),
    }),
  });
  const paid = await consented.helpers.handleFetchYoutubeTranscript(
    VIDEO_ID,
    "en",
    1,
    true,
    nativeOptions("42"),
  );
  assert.equal(paid.success, true);
  assert.equal(paid.routeOutcome, "HAVE_TRANSCRIPT");
  assert.equal(paid.source, "supadata");
  assert.equal(paid.runId, "42");
  assert.equal(consented.counts.fetch, 1);
  assert.equal(consented.counts.activeRun, 0);
  assert.equal(consented.counts.panelRun, 0);
});

test("an unexpected YouTube orchestration error still echoes run identity", async () => {
  const worker = loadBackground({
    activeResult: { status: "UNKNOWN", errorCode: "PROBE_FAILED" },
    panelResult: { status: "UNKNOWN", errorCode: "PANEL_HTTP_400" },
    storageLocalGet: async () => {
      throw new Error("simulated settings read failure");
    },
  });
  const result = await worker.dispatch(
    {
      action: "fetchTranscript",
      mediaRef: { platform: "youtube", videoId: VIDEO_ID },
      videoId: VIDEO_ID,
      preferredLanguage: "en",
      tabId: 1,
      runId: "91",
      digestGeneration: 91,
      routeKey: `youtube:${VIDEO_ID}`,
      trackKind: "manual-first",
      captionRetry: true,
      supadataConsent: false,
    },
    { tab: { id: 1 } },
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "TRANSCRIPT_ERROR");
  assert.equal(result.routeOutcome, "UNKNOWN");
  assert.equal(result.runId, "91");
  assert.equal(result.routeKey, `youtube:${VIDEO_ID}`);
});

test("Bilibili keeps its existing adapter path", async () => {
  const mediaRef = {
    platform: "bilibili",
    bvid: "BV1zfg36ZEXi",
    aid: 123,
    cid: 456,
    page: 1,
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/",
  };
  const worker = loadBackground({
    bilibiliAdapterImpl: {
      ...bilibiliAdapter,
      async fetchTranscript() {
        return {
          transcript: [
            { text: "中文字幕", start: 0, duration: 2, language: "zh-CN" },
          ],
          transcriptText: "中文字幕",
          transcriptTextTimestamped: "[0:00] 中文字幕",
          language: "zh-CN",
        };
      },
    },
  });
  const result = await worker.helpers.handleFetchMediaTranscript(
    mediaRef,
    "zh-CN",
    1,
    false,
    nativeOptions("50"),
  );
  assert.equal(result.success, true);
  assert.equal(result.source, "bilibili");
  assert.equal(worker.counts.activeRun, 0);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});
