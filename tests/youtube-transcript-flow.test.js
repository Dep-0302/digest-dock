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

function timedJson3Body() {
  return JSON.stringify({
    events: [
      {
        tStartMs: 62_040,
        dDurationMs: 6_120,
        segs: [
          { utf8: "beginning ", tOffsetMs: 0 },
          { utf8: "to ", tOffsetMs: 420 },
          { utf8: "forget. ", tOffsetMs: 920 },
          { utf8: "The ", tOffsetMs: 1_480 },
          { utf8: "absence of AI", tOffsetMs: 2_100 },
        ],
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
        availableTracks: Array.isArray(options.availableTracks)
          ? options.availableTracks
          : [],
        pageDefaultTrack: options.pageDefaultTrack || null,
        pageCurrentTrack: options.pageCurrentTrack || null,
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
  tabsGet,
  scriptingExecuteScript,
  storageLocalGet,
  pageSnapshotOptions = {},
  pageSnapshotRun,
  bilibiliAdapterImpl = bilibiliAdapter,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = Date.now,
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
  const tabUpdatedListeners = [];
  const listeners = { addListener() {} };

  const executeScript = async (details) => {
    if (typeof scriptingExecuteScript === "function") {
      return scriptingExecuteScript(details);
    }
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
    if (typeof pageSnapshotRun === "function") {
      return pageSnapshotRun(details, pageSnapshotOptions);
    }
    return pageSnapshot(
      tabVideoIds.get(details.target?.tabId) || VIDEO_ID,
      pageSnapshotOptions,
    );
  };

  const SandboxDate = class extends Date {
    static now() {
      return nowImpl();
    }
  };
  const sandbox = {
    console,
    Date: SandboxDate,
    URL,
    TextDecoder,
    TextEncoder,
    Intl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
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
        onUpdated: {
          addListener(listener) {
            tabUpdatedListeners.push(listener);
          },
        },
        onActivated: listeners,
        get:
          tabsGet ||
          (async (tabId) => {
            const videoId = tabVideoIds.get(tabId);
            if (!videoId) throw new Error("tab missing");
            return {
              id: tabId,
              url: `https://www.youtube.com/watch?v=${videoId}`,
            };
          }),
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
    triggerTabUpdated(tabId, changeInfo) {
      for (const listener of tabUpdatedListeners) listener(tabId, changeInfo);
    },
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

function createManualTimers() {
  const timers = new Map();
  const scheduledDelays = [];
  let nextId = 1;
  let now = 0;
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      scheduledDelays.push(delay);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    delays() {
      return [...timers.values()].map((timer) => timer.delay);
    },
    scheduledDelays() {
      return [...scheduledDelays];
    },
    now() {
      return now;
    },
    advance(delay) {
      now += delay;
    },
    runAll() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        now += timer.delay;
        timer.callback();
      }
    },
  };
}

async function flushTurns(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

test("Passive JSON3 preserves exact word timing without changing the cue", async () => {
  const worker = loadBackground();
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "inflight",
        videoId: VIDEO_ID,
        language: "en",
        kind: "asr",
        status: 0,
        inFlight: true,
      },
    },
    { tab: { id: 1 } },
  );
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "capture",
        videoId: VIDEO_ID,
        language: "en",
        kind: "asr",
        status: 200,
        inFlight: false,
        format: "json3",
        body: timedJson3Body(),
      },
    },
    { tab: { id: 1 } },
  );

  const result = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    { ...nativeOptions("passive-word-time"), trackKind: "asr" },
  );

  assert.equal(result.source, "youtube-passive");
  assert.equal(
    result.transcript[0].text,
    "beginning to forget. The absence of AI",
  );
  assert.equal(result.transcript[0].start, 62.04);
  assert.equal(result.transcript[0].duration, 6.12);
  assert.deepEqual(JSON.parse(JSON.stringify(result.transcript[0].timingPoints)), [
    { charIndex: 0, start: 62.04 },
    { charIndex: 10, start: 62.46 },
    { charIndex: 13, start: 62.96 },
    { charIndex: 21, start: 63.52 },
    { charIndex: 25, start: 64.14 },
  ]);
  assert.equal(worker.counts.activeRun, 0);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});

test("Active normalization preserves exact word timing through the background whitelist", async () => {
  const worker = loadBackground({
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "en", kind: "asr" }],
      pageDefaultTrack: { language: "en", kind: "asr" },
    },
    activeResult: {
      ...transcriptResult("timed Active"),
      selectedTrack: { language: "en", kind: "asr" },
      transcript: [
        {
          text: "beginning to forget. The absence of AI",
          start: 62.04,
          duration: 6.12,
          language: "en",
          timingPoints: [
            { charIndex: 0, start: 62.04 },
            { charIndex: 21, start: 63.52 },
          ],
        },
      ],
    },
  });

  const result = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    { ...nativeOptions("active-word-time"), trackKind: "asr" },
  );

  assert.equal(result.source, "youtube-active");
  assert.deepEqual(JSON.parse(JSON.stringify(result.transcript[0].timingPoints)), [
    { charIndex: 0, start: 62.04 },
    { charIndex: 21, start: 63.52 },
  ]);
  assert.equal(worker.counts.activeRun, 1);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});

test("concurrent Passive inflight and capture preserve arrival order across delayed tab checks", async () => {
  let releaseFirstTabLookup;
  let tabLookupCount = 0;
  const worker = loadBackground({
    tabsGet: async (tabId) => {
      tabLookupCount += 1;
      if (tabLookupCount === 1) {
        await new Promise((resolve) => {
          releaseFirstTabLookup = resolve;
        });
      }
      return {
        id: tabId,
        url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      };
    },
  });

  const inflight = worker.dispatch(
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
  const capture = worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "capture",
        videoId: VIDEO_ID,
        language: "en",
        kind: "manual",
        status: 200,
        inFlight: false,
        body: json3Body("ordered after delayed identity check"),
      },
    },
    { tab: { id: 1 } },
  );

  while (!releaseFirstTabLookup) await Promise.resolve();
  assert.equal(
    tabLookupCount,
    1,
    "the capture must wait behind the inflight event's identity check",
  );
  releaseFirstTabLookup();
  const [inflightResult, captureResult] = await Promise.all([inflight, capture]);
  assert.equal(inflightResult.ok, true);
  assert.equal(captureResult.ok, true);

  const gate = await worker.helpers.readYoutubePassiveGate({
    tabId: 1,
    videoId: VIDEO_ID,
    preferredLanguage: "en",
    trackKind: "manual-first",
  });
  assert.equal(
    gate.capture?.transcript?.[0]?.text,
    "ordered after delayed identity check",
  );
  assert.equal(gate.inFlight, false);
});

test("Passive falls back to an actually observed non-preferred language", async () => {
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
        body: json3Body("visible English captions"),
      },
    },
    { tab: { id: 1 } },
  );

  const result = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "zh-Hans",
    1,
    nativeOptions("71"),
  );
  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-passive");
  assert.equal(result.language, "en");
  assert.equal(result.selectedTrack.language, "en");
  assert.equal(result.transcript[0].text, "visible English captions");
  assert.equal(worker.counts.activeRun, 0);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});

test("Passive ranks exact language ahead of a manual non-preferred track", async () => {
  const worker = loadBackground();
  for (const track of [
    { language: "en", kind: "manual", text: "manual English" },
    { language: "zh-Hans", kind: "asr", text: "exact Chinese" },
  ]) {
    await worker.dispatch(
      {
        action: "youtubePassiveState",
        payload: {
          type: "inflight",
          videoId: VIDEO_ID,
          language: track.language,
          kind: track.kind,
          status: 0,
          inFlight: true,
        },
      },
      { tab: { id: 1 } },
    );
    await worker.dispatch(
      {
        action: "youtubePassiveState",
        payload: {
          type: "capture",
          videoId: VIDEO_ID,
          language: track.language,
          kind: track.kind,
          status: 200,
          inFlight: false,
          body: json3Body(track.text),
        },
      },
      { tab: { id: 1 } },
    );
  }

  const result = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "zh-Hans",
    1,
    nativeOptions("72"),
  );
  assert.equal(result.success, true);
  assert.equal(result.language, "zh-Hans");
  assert.equal(result.selectedTrack.kind, "asr");
  assert.equal(result.transcript[0].text, "exact Chinese");
});

test("automatic track selection treats Chinese varieties equally and keeps manual source order", () => {
  const worker = loadBackground();
  const selected = worker.helpers.chooseYoutubeAutomaticTrack({
    captionTrackCountKnown: true,
    captionTrackCount: 5,
    availableTracks: [
      { language: "en", kind: "manual" },
      { language: "zh-Hans", kind: "asr" },
      { language: "yue-HK", kind: "manual" },
      { language: "zh-Hant", kind: "manual" },
      { language: "cmn-Hans", kind: "asr" },
    ],
    currentTrack: { language: "en", kind: "manual" },
    selectedTrack: { language: "en", kind: "manual" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), {
    language: "yue-HK",
    kind: "manual",
  });
});

test("without Chinese, automatic selection uses the current track then the page default", () => {
  const worker = loadBackground();
  const evidence = {
    captionTrackCountKnown: true,
    captionTrackCount: 2,
    availableTracks: [
      { language: "en", kind: "manual" },
      { language: "de", kind: "manual" },
    ],
    selectedTrack: { language: "en", kind: "manual" },
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(worker.helpers.chooseYoutubeAutomaticTrack({
      ...evidence,
      currentTrack: { language: "de", kind: "manual" },
    }))),
    { language: "de", kind: "manual" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(worker.helpers.chooseYoutubeAutomaticTrack(evidence))),
    { language: "en", kind: "manual" },
  );
});

test("Passive miss runs one fixed Active request for the page-selected Chinese track", async () => {
  const worker = loadBackground({
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 4,
      availableTracks: [
        { language: "en", kind: "manual" },
        { language: "zh-Hans", kind: "asr" },
        { language: "zh-Hant", kind: "manual" },
        { language: "yue-HK", kind: "manual" },
      ],
      pageDefaultTrack: { language: "en", kind: "manual" },
    },
    activeRun: async (request) => {
      assert.equal(request.language, "zh-Hant");
      assert.equal(request.trackKind, "manual");
      return {
        ...transcriptResult("Chinese Active"),
        language: "zh-Hant",
        selectedTrack: { language: "zh-Hant", kind: "manual" },
        transcript: [
          { text: "中文", start: 0, duration: 2, language: "zh-Hant" },
        ],
      };
    },
  });
  const result = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("active-zh"),
  );
  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-active");
  assert.equal(result.language, "zh-Hant");
  assert.equal(result.selectedTrack.kind, "manual");
  assert.equal(worker.counts.activeInject, 1);
  assert.equal(worker.counts.activeRun, 1);
  assert.equal(worker.counts.panelInject, 0);
  assert.equal(worker.counts.panelRun, 0);
});

test("duplicate automatic requests share one Active flight and keep caller identities", async () => {
  let releaseActive;
  let markActiveStarted;
  const activeStarted = new Promise((resolve) => {
    markActiveStarted = resolve;
  });
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve;
  });
  const worker = loadBackground({
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "en", kind: "manual" }],
      pageDefaultTrack: { language: "en", kind: "manual" },
    },
    activeRun: async () => {
      markActiveStarted();
      await activeGate;
      return transcriptResult("shared Active");
    },
  });
  const first = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("active-shared-1"),
  );
  const second = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    2,
    nativeOptions("active-shared-2"),
  );
  await activeStarted;
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseActive();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.success, true);
  assert.equal(secondResult.success, true);
  assert.equal(firstResult.runId, "active-shared-1");
  assert.equal(secondResult.runId, "active-shared-2");
  assert.equal(worker.counts.activeRun, 1);
  assert.equal(worker.counts.panelRun, 0);
});

test("an ordinary Active miss returns the first CC prompt without Panel or Supadata", async () => {
  const worker = loadBackground({
    settings: { aiApiKey: "test", supadataApiKey: "optional-key" },
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "en", kind: "manual" }],
      pageDefaultTrack: { language: "en", kind: "manual" },
    },
    activeResult: {
      status: "UNKNOWN",
      errorCode: "NETWORK",
      diagnostics: {
        providerInitiated: {
          youtubePlayer: 1,
          youtubeTimedtext: 0,
          thirdParty: 0,
          loopback: 0,
        },
      },
    },
  });
  const result = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("active-miss"),
  );
  assert.equal(result.error, "YOUTUBE_CAPTIONS_REQUIRED");
  assert.equal(result.requiresCaptionEnable, true);
  assert.equal(result.supadataEligible, false);
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(worker.counts.activeRun, 1);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});

test("one Active 429 starts cooldown and never reaches CC, Panel, or Supadata", async () => {
  const worker = loadBackground({
    settings: { aiApiKey: "test", supadataApiKey: "optional-key" },
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "en", kind: "manual" }],
      pageDefaultTrack: { language: "en", kind: "manual" },
    },
    activeResult: {
      status: "RATE_LIMITED",
      errorCode: "RATE_LIMITED",
      diagnostics: {
        providerInitiated: {
          youtubePlayer: 1,
          youtubeTimedtext: 0,
          thirdParty: 0,
          loopback: 0,
        },
      },
    },
  });
  const first = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("active-429"),
  );
  assert.equal(first.error, "RATE_LIMITED");
  assert.equal(first.routeOutcome, "RATE_LIMITED");
  assert.equal(first.supadataEligible, false);
  const second = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("active-429-again"),
  );
  assert.equal(second.error, "RATE_LIMITED");
  assert.equal(second.supadataEligible, false);
  assert.equal(worker.counts.activeRun, 1);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});

test("a stale Passive bridge stops before the transcript and provider routes", async () => {
  const worker = loadBackground({
    scriptingExecuteScript: async (details) => {
      assert.equal(details.world, "ISOLATED");
      return [
        {
          result: {
            ready: false,
            videoId: VIDEO_ID,
          },
        },
      ];
    },
  });

  const response = await worker.dispatch({
    action: "relayToContent",
    tabId: 1,
    payload: { action: "getVideoInfo" },
  });
  assert.equal(response.success, false);
  assert.equal(response.error, "PAGE_REFRESH_REQUIRED");
  assert.match(response.message, /刷新当前 YouTube 页面/);
  assert.equal(worker.counts.activeRun, 0);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
});

test("Passive bridge health requires a live runtime roundtrip, not only a stale marker", async (t) => {
  for (const [label, pingResult, expectedReady] of [
    ["live", true, true],
    ["invalidated", false, false],
  ]) {
    await t.test(label, async () => {
      const worker = loadBackground({
        scriptingExecuteScript: async (details) => {
          const context = {
            URL,
            String,
            location: {
              href: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
            },
            __DIGESTDOCK_YOUTUBE_PASSIVE_BRIDGE_V1__: {
              active: true,
              pingRuntime: async () => pingResult,
            },
          };
          const result = await vm.runInNewContext(
            `(${details.func.toString()})()`,
            context,
          );
          return [{ result }];
        },
      });
      const health = await worker.helpers.readYoutubePassiveBridgeHealth(1);
      assert.equal(health.ready, expectedReady);
      assert.equal(health.videoId, VIDEO_ID);
      assert.equal(worker.counts.fetch, 0);
    });
  }
});

test("an empty Passive gate enters Active without arming the 1.5 second wait", async () => {
  const timers = createManualTimers();
  const worker = loadBackground({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "en", kind: "manual" }],
      pageDefaultTrack: { language: "en", kind: "manual" },
    },
    activeResult: transcriptResult("immediate Active"),
  });

  const pending = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("empty-fast"),
  );
  await flushTurns();

  const activeRunsBeforeAnyTimer = worker.counts.activeRun;
  const waitsBeforeActive = timers.delays();
  // Release an old implementation's bounded waiter so the red test always
  // settles cleanly instead of leaving a fake timer or route promise behind.
  timers.runAll();
  const result = await pending;

  assert.deepEqual(
    { activeRunsBeforeAnyTimer, waitsBeforeActive },
    { activeRunsBeforeAnyTimer: 1, waitsBeforeActive: [] },
    "an empty Passive buffer must reach Active without arming the 1.5 second budget",
  );
  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-active");
});

test("a Passive capture arriving during the page snapshot wins before Active starts", async () => {
  let releaseSnapshot;
  let markSnapshotStarted;
  const snapshotStarted = new Promise((resolve) => {
    markSnapshotStarted = resolve;
  });
  const snapshotGate = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  const worker = loadBackground({
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "en", kind: "manual" }],
      pageDefaultTrack: { language: "en", kind: "manual" },
    },
    pageSnapshotRun: async (_details, options) => {
      markSnapshotStarted();
      await snapshotGate;
      return pageSnapshot(VIDEO_ID, options);
    },
    activeResult: transcriptResult("must not start"),
  });

  const pending = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "en",
    1,
    nativeOptions("snapshot-race"),
  );
  await snapshotStarted;
  assert.equal(
    worker.counts.activeRun,
    0,
    "the route is still reading the page track snapshot",
  );

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
        body: json3Body("captured during page snapshot"),
      },
    },
    { tab: { id: 1 } },
  );
  releaseSnapshot();

  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-passive");
  assert.equal(result.transcript[0].text, "captured during page snapshot");
  assert.equal(worker.counts.activeInject, 0);
  assert.equal(worker.counts.activeRun, 0);
});

test("an in-flight Passive response waits once and wins before the CC prompt", async () => {
  const timers = createManualTimers();
  const worker = loadBackground({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    nowImpl: timers.now,
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
    nativeOptions("8"),
  );
  await flushTurns();
  assert.deepEqual(timers.delays(), [1_500]);
  assert.equal(worker.counts.activeRun, 0);
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
  assert.deepEqual(timers.delays(), []);
});

test("two Passive gate checks share one total 1.5 second deadline", async () => {
  const timers = createManualTimers();
  const worker = loadBackground({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    nowImpl: timers.now,
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "en", kind: "manual" }],
      pageDefaultTrack: { language: "en", kind: "manual" },
    },
    activeResult: transcriptResult("active after one Passive budget"),
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
    nativeOptions("one-total-budget"),
  );
  await flushTurns();
  assert.deepEqual(timers.delays(), [1_500]);
  timers.runAll();
  const result = await pending;

  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-active");
  assert.equal(worker.counts.activeRun, 1);
  assert.deepEqual(timers.scheduledDelays(), [1_500]);
});

test("an aged Passive request waits only the remainder of its original 1.5 second budget", async () => {
  const timers = createManualTimers();
  const worker = loadBackground({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    nowImpl: timers.now,
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "zh-Hans", kind: "manual" }],
      pageDefaultTrack: { language: "zh-Hans", kind: "manual" },
    },
    activeResult: transcriptResult("active after aged Passive budget"),
  });
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "inflight",
        videoId: VIDEO_ID,
        language: "zh-Hans",
        kind: "manual",
        status: 0,
        inFlight: true,
      },
    },
    { tab: { id: 1 } },
  );
  timers.advance(1_400);

  const pending = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "zh-Hans",
    1,
    nativeOptions("aged-passive"),
  );
  await flushTurns();
  assert.deepEqual(timers.delays(), [100]);
  timers.runAll();
  const result = await pending;

  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-active");
  assert.equal(worker.counts.activeRun, 1);
  assert.deepEqual(timers.scheduledDelays(), [100]);
});

test("damaged Passive startedAt values fall back to a valid updatedAt without starting Active early", async () => {
  for (const damagedStartedAt of [null, "", false, 9_999]) {
    const timers = createManualTimers();
    timers.advance(1_000);
    const worker = loadBackground({
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
      nowImpl: timers.now,
    });
    await worker.dispatch(
      {
        action: "youtubePassiveState",
        payload: {
          type: "inflight",
          videoId: VIDEO_ID,
          language: "zh-Hans",
          kind: "manual",
          status: 0,
          inFlight: true,
        },
      },
      { tab: { id: 1 } },
    );
    const [entry] = worker.sessionState.youtube_passive_session_buffer;
    entry.startedAt = damagedStartedAt;
    entry.updatedAt = 1_000;
    timers.advance(400);

    const pending = worker.helpers.awaitYoutubePassiveGate(
      {
        tabId: 1,
        videoId: VIDEO_ID,
        preferredLanguage: "zh-Hans",
        trackKind: "manual-first",
      },
      timers.now() + 1_500,
    );
    await flushTurns();
    assert.deepEqual(
      timers.delays(),
      [1_100],
      `startedAt=${String(damagedStartedAt)} must use the fresh updatedAt`,
    );
    timers.runAll();
    assert.equal(await pending, null);
  }
});

test("repeated inflight and concurrent capture never refill the Passive startedAt budget", async () => {
  const timers = createManualTimers();
  const worker = loadBackground({ nowImpl: timers.now });
  const send = (payload) =>
    worker.dispatch(
      {
        action: "youtubePassiveState",
        payload: {
          videoId: VIDEO_ID,
          language: "zh-Hans",
          kind: "manual",
          status: 0,
          inFlight: true,
          ...payload,
        },
      },
      { tab: { id: 1 } },
    );

  await send({ type: "inflight" });
  assert.equal(
    worker.sessionState.youtube_passive_session_buffer[0].startedAt,
    0,
  );
  timers.advance(600);
  await send({ type: "inflight" });
  assert.equal(
    worker.sessionState.youtube_passive_session_buffer[0].startedAt,
    0,
    "a duplicate begin must retain the first observed start",
  );
  timers.advance(300);
  await send({
    type: "capture",
    status: 200,
    body: json3Body("capture with another request still running"),
  });
  assert.equal(
    worker.sessionState.youtube_passive_session_buffer[0].startedAt,
    0,
    "a capture that reports concurrent work must not renew the budget",
  );
});

test("a fresh independent Passive identity keeps its own bounded wait beside an older request", async () => {
  const timers = createManualTimers();
  const worker = loadBackground({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    nowImpl: timers.now,
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "zh-Hans", kind: "manual" }],
      pageDefaultTrack: { language: "zh-Hans", kind: "manual" },
    },
    activeResult: transcriptResult("active after independent Passive budget"),
  });
  const begin = (language) =>
    worker.dispatch(
      {
        action: "youtubePassiveState",
        payload: {
          type: "inflight",
          videoId: VIDEO_ID,
          language,
          kind: "manual",
          status: 0,
          inFlight: true,
        },
      },
      { tab: { id: 1 } },
    );

  await begin("en");
  timers.advance(1_400);
  await begin("zh-Hans");

  const pending = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "zh-Hans",
    1,
    nativeOptions("independent-passive"),
  );
  await flushTurns();
  assert.deepEqual(
    timers.delays(),
    [1_500],
    "the old identity must not force Active to overlap the fresh request",
  );
  timers.runAll();
  const result = await pending;

  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-active");
  assert.equal(worker.counts.activeRun, 1);
  assert.deepEqual(timers.scheduledDelays(), [1_500]);
});

test("a fresh identity observed during an old wait can use the remaining shared request budget", async () => {
  const timers = createManualTimers();
  const worker = loadBackground({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    nowImpl: timers.now,
  });
  const send = (payload) =>
    worker.dispatch(
      {
        action: "youtubePassiveState",
        payload: {
          videoId: VIDEO_ID,
          kind: "manual",
          status: 0,
          inFlight: true,
          ...payload,
        },
      },
      { tab: { id: 1 } },
    );

  await send({ type: "inflight", language: "en" });
  timers.advance(1_400);
  const pending = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "zh-Hans",
    1,
    nativeOptions("fresh-during-wait"),
  );
  await flushTurns();
  assert.deepEqual(timers.delays(), [100]);

  await send({ type: "inflight", language: "zh-Hans" });
  await flushTurns();
  assert.deepEqual(
    timers.delays(),
    [1_500],
    "the new identity may wait only until the original request deadline",
  );

  await send({
    type: "capture",
    language: "zh-Hans",
    status: 200,
    inFlight: false,
    body: json3Body("fresh identity capture"),
  });
  const result = await pending;
  assert.equal(result.source, "youtube-passive");
  assert.equal(result.transcript[0].text, "fresh identity capture");
  assert.equal(worker.counts.activeRun, 0);
  assert.deepEqual(timers.delays(), []);
});

test("an over-age Passive entry falls through without a timer and remains available for a late 429", async () => {
  const timers = createManualTimers();
  const worker = loadBackground({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    nowImpl: timers.now,
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "zh-Hans", kind: "manual" }],
      pageDefaultTrack: { language: "zh-Hans", kind: "manual" },
    },
    activeResult: transcriptResult("active after expired Passive budget"),
  });
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "inflight",
        videoId: VIDEO_ID,
        language: "zh-Hans",
        kind: "manual",
        status: 0,
        inFlight: true,
      },
    },
    { tab: { id: 1 } },
  );
  timers.advance(1_501);

  const result = await worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "zh-Hans",
    1,
    nativeOptions("expired-passive"),
  );
  assert.equal(result.success, true);
  assert.equal(result.source, "youtube-active");
  assert.equal(worker.counts.activeRun, 1);
  assert.deepEqual(timers.scheduledDelays(), []);
  assert.equal(
    worker.sessionState.youtube_passive_session_buffer.length,
    1,
    "timeout must not delete evidence needed by a late response",
  );

  const observed = await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "capture",
        videoId: VIDEO_ID,
        language: "zh-Hans",
        kind: "manual",
        status: 429,
        inFlight: false,
        body: "bounded error body",
      },
    },
    { tab: { id: 1 } },
  );
  assert.equal(observed.ok, true);
  assert.equal(observed.state, "rate-limited");
  assert.equal(worker.sessionState.youtube_passive_session_buffer.length, 0);
  assert.ok(
    Number(worker.sessionState.youtube_native_cooldown_until) > timers.now(),
  );
});

test("a Passive 429 observed during the bounded wait prevents every automatic fallback", async () => {
  const timers = createManualTimers();
  const worker = loadBackground({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    nowImpl: timers.now,
    pageSnapshotOptions: {
      captionTrackCountKnown: true,
      captionTrackCount: 1,
      availableTracks: [{ language: "zh-Hans", kind: "manual" }],
      pageDefaultTrack: { language: "zh-Hans", kind: "manual" },
    },
  });
  await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "inflight",
        videoId: VIDEO_ID,
        language: "zh-Hans",
        kind: "manual",
        status: 0,
        inFlight: true,
      },
    },
    { tab: { id: 1 } },
  );

  const pending = worker.helpers.handleFetchYoutubeNativeTranscript(
    VIDEO_ID,
    "zh-Hans",
    1,
    nativeOptions("passive-429-during-wait"),
  );
  await flushTurns();
  assert.deepEqual(timers.delays(), [1_500]);

  const observed = await worker.dispatch(
    {
      action: "youtubePassiveState",
      payload: {
        type: "capture",
        videoId: VIDEO_ID,
        language: "zh-Hans",
        kind: "manual",
        status: 429,
        inFlight: false,
        body: "bounded error body",
      },
    },
    { tab: { id: 1 } },
  );
  const result = await pending;

  assert.equal(observed.ok, true);
  assert.equal(observed.state, "rate-limited");
  assert.equal(result.success, false);
  assert.equal(result.routeOutcome, "RATE_LIMITED");
  assert.equal(worker.counts.activeRun, 0);
  assert.equal(worker.counts.panelRun, 0);
  assert.equal(worker.counts.fetch, 0);
  assert.deepEqual(timers.delays(), []);
});

test("URL updates preserve the current video's Passive capture and clear only old video identities", async () => {
  const worker = loadBackground();
  const storeCapture = async (videoId, text) => {
    await worker.dispatch(
      {
        action: "youtubePassiveState",
        payload: {
          type: "inflight",
          videoId,
          language: "en",
          kind: "manual",
          status: 0,
          inFlight: true,
        },
      },
      { tab: { id: 1 } },
    );
    await worker.dispatch(
      {
        action: "youtubePassiveState",
        payload: {
          type: "capture",
          videoId,
          language: "en",
          kind: "manual",
          status: 200,
          inFlight: false,
          body: json3Body(text),
        },
      },
      { tab: { id: 1 } },
    );
  };

  await storeCapture(VIDEO_ID, "same video capture");
  worker.triggerTabUpdated(1, {
    url: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=30`,
  });
  const sameVideo = await worker.helpers.readYoutubePassiveGate({
    tabId: 1,
    videoId: VIDEO_ID,
    preferredLanguage: "en",
    trackKind: "manual-first",
  });
  assert.equal(sameVideo.capture?.transcript?.[0]?.text, "same video capture");

  // A new video's request can finish before Chrome delivers onUpdated. The
  // delayed cleanup must retain that new identity while removing the old one.
  worker.tabVideoIds.set(1, OTHER_VIDEO_ID);
  await storeCapture(OTHER_VIDEO_ID, "new video capture");
  worker.triggerTabUpdated(1, {
    url: `https://www.youtube.com/watch?v=${OTHER_VIDEO_ID}`,
  });
  const newVideo = await worker.helpers.readYoutubePassiveGate({
    tabId: 1,
    videoId: OTHER_VIDEO_ID,
    preferredLanguage: "en",
    trackKind: "manual-first",
  });
  const oldVideo = await worker.helpers.readYoutubePassiveGate({
    tabId: 1,
    videoId: VIDEO_ID,
    preferredLanguage: "en",
    trackKind: "manual-first",
  });
  assert.equal(newVideo.capture?.transcript?.[0]?.text, "new video capture");
  assert.equal(oldVideo.capture, null);
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

test("empty Passive bodies close inflight state without becoming a transcript", async (t) => {
  for (const testCase of [
    { name: "zero bytes", body: "" },
    { name: "empty events", body: JSON.stringify({ events: [] }) },
  ]) {
    await t.test(testCase.name, async () => {
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
            body: testCase.body,
          },
        },
        { tab: { id: 1 } },
      );
      assert.equal(response.ok, false);
      assert.equal(response.error, "INVALID_PASSIVE_CAPTURE");
      assert.deepEqual(
        JSON.parse(
          JSON.stringify(worker.sessionState.youtube_passive_session_buffer),
        ),
        [],
      );
      const gate = await worker.helpers.readYoutubePassiveGate({
        tabId: 1,
        videoId: VIDEO_ID,
        preferredLanguage: "en",
        trackKind: "manual-first",
      });
      assert.equal(gate.capture, null);
      assert.equal(gate.inFlight, false);
      assert.equal(worker.counts.fetch, 0);
    });
  }
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
      assert.equal(first.routeOutcome, "RATE_LIMITED");
      assert.equal(first.error, "RATE_LIMITED");
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
      assert.equal(retry.routeOutcome, "RATE_LIMITED");
      assert.equal(retry.error, "RATE_LIMITED");
      assert.equal(retry.supadataEligible, false);
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

test("Supadata 429 returns an exact cooldown and blocks an immediate second provider call", async () => {
  const worker = loadBackground({
    settings: { aiApiKey: "test", supadataApiKey: "optional-key" },
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    }),
  });

  const first = await worker.helpers.handleFetchYoutubeTranscript(
    VIDEO_ID,
    "en",
    1,
    true,
    nativeOptions("cooldown-1"),
  );
  assert.equal(first.success, false);
  assert.equal(first.error, "RATE_LIMITED");
  assert.equal(first.routeOutcome, "UNKNOWN");
  assert.ok(first.cooldownUntil > Date.now());
  assert.equal(worker.counts.fetch, 1);

  const second = await worker.helpers.handleFetchYoutubeTranscript(
    VIDEO_ID,
    "en",
    1,
    true,
    nativeOptions("cooldown-2"),
  );
  assert.equal(second.error, "RATE_LIMITED");
  assert.equal(second.cooldownUntil, first.cooldownUntil);
  assert.equal(worker.counts.fetch, 1);
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
  const timers = createManualTimers();
  const mediaRef = {
    platform: "bilibili",
    bvid: "BV1zfg36ZEXi",
    aid: 123,
    cid: 456,
    page: 1,
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/",
  };
  const worker = loadBackground({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
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
  assert.deepEqual(
    timers.delays(),
    [],
    "Bilibili must never enter the YouTube Passive wait budget",
  );
});
