const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const panelModule = require("../youtube-transcript-panel.js");

const VIDEO_ID = "dQw4w9WgXcQ";

function makeRuntime(overrides = {}) {
  const state = {
    now: 0,
    videoId: VIDEO_ID,
    epoch: 0,
    descriptionExpanded: false,
    panelVisible: false,
    panelConnected: true,
    scrollerConnected: true,
    entryVisible: true,
    entryExists: true,
    scrollTop: 0,
    scrollHeight: 400,
    clientHeight: 100,
    pageScrollY: 360,
    initialPanelVisible: false,
    initialDescriptionExpanded: false,
    initialScrollerTop: 17,
    panelError: null,
    panelLanguage: "en",
    panelTrackKind: "manual",
    closeCalled: 0,
    closeWorks: true,
    closeDelayMs: 0,
    panelCloseAt: null,
    freshOpened: false,
    initialOtherPanelVisible: false,
    otherPanelRestorable: true,
    otherPanelVisible: false,
    otherPanelRestoreCalled: 0,
    restoreCalled: 0,
    openCalled: 0,
    expandCalled: 0,
    readCalled: 0,
    setScrollCalls: [],
    restored: null,
    ...overrides,
  };
  state.panel = { kind: "panel" };
  state.scroller = { kind: "scroller" };
  state.entry = { kind: "entry" };

  state.otherPanelVisible = state.initialOtherPanelVisible;

  const rowsForScroll = () => {
    if (!state.freshOpened && Array.isArray(state.beforeOpenRows)) {
      return state.beforeOpenRows;
    }
    if (state.freshOpened && Array.isArray(state.afterOpenRows)) {
      return state.afterOpenRows;
    }
    if (typeof state.rowsForScroll === "function") {
      return state.rowsForScroll(state.scrollTop, state);
    }
    const index = Math.round(state.scrollTop / 75);
    return [
      {
        timestamp: `0:${String(index * 10).padStart(2, "0")}`,
        text: `segment-${index}`,
      },
    ];
  };

  const runtime = {
    now: () => state.now,
    wait: async (milliseconds) => {
      state.now += Number(milliseconds) || 0;
      if (typeof state.onWait === "function") state.onWait(state);
    },
    navigationEpoch: () => state.epoch,
    currentVideoId: () => state.videoId,
    isConnected: (node) =>
      node === state.panel ? state.panelConnected : state.scrollerConnected,
    findTranscriptEntry: ({ visibleOnly } = {}) =>
      state.entryExists && (!visibleOnly || state.entryVisible)
        ? state.entry
        : null,
    findVisiblePanel: () => {
      if (
        state.panelCloseAt !== null &&
        state.now >= state.panelCloseAt
      ) {
        state.panelVisible = false;
        state.panelCloseAt = null;
      }
      return state.panelVisible ? state.panel : null;
    },
    findScroller: () => state.scrollerAvailable === false ? null : state.scroller,
    readRows: () => {
      state.readCalled += 1;
      return state.emptyRows ? [] : rowsForScroll();
    },
    panelErrorCode: () => state.panelError,
    panelLanguage: () => state.panelLanguage,
    panelTrackKind: () => state.panelTrackKind,
    closePanel: () => {
      state.closeCalled += 1;
      if (!state.closeWorks) return false;
      if (Number.isFinite(state.closeDelayMs) && state.closeDelayMs > 0) {
        state.panelCloseAt = state.now + state.closeDelayMs;
      } else if (state.closeDelayMs === Infinity) {
        state.panelCloseAt = Infinity;
      } else {
        state.panelVisible = false;
      }
      return true;
    },
    metrics: () => ({
      scrollTop: state.scrollTop,
      scrollHeight: state.scrollHeight,
      clientHeight: state.clientHeight,
    }),
    setScrollTop: (_scroller, value) => {
      state.scrollTop = Math.max(
        0,
        Math.min(state.scrollHeight - state.clientHeight, Number(value) || 0),
      );
      state.setScrollCalls.push(state.scrollTop);
    },
    capture: () => ({
      videoId: state.videoId,
      navigationEpoch: state.epoch,
      scrollX: 0,
      scrollY: state.pageScrollY,
      descriptionExpanded: state.initialDescriptionExpanded,
      panel: state.initialPanelVisible ? state.panel : null,
      engagementPanels: [
        ...(state.initialPanelVisible
          ? [{
              element: state.panel,
              identity: "transcript-panel",
              transcript: true,
              restoreControl: null,
            }]
          : []),
        ...(state.initialOtherPanelVisible
          ? [{
              element: { kind: "other-panel" },
              identity: "chapters-panel",
              transcript: false,
              restoreControl: state.otherPanelRestorable
                ? { kind: "chapters-control" }
                : null,
            }]
          : []),
      ],
    }),
    canRestoreEngagementPanels: () =>
      !(state.initialPanelVisible && state.initialOtherPanelVisible) &&
      (!state.initialOtherPanelVisible || state.otherPanelRestorable),
    expandDescription: () => {
      state.expandCalled += 1;
      state.descriptionExpanded = true;
      state.entryVisible = true;
      return { changed: true, control: { kind: "description" } };
    },
    openTranscriptPanel: async (entry) => {
      state.openCalled += 1;
      if (!entry || state.openFails) {
        return { opened: false, overflowOpened: false };
      }
      state.panelVisible = true;
      state.otherPanelVisible = false;
      state.freshOpened = true;
      return { opened: true, overflowOpened: false };
    },
    restore: async (context) => {
      state.restoreCalled += 1;
      state.scrollTop = context.scrollerScrollTop;
      state.panelVisible = state.initialPanelVisible;
      state.otherPanelVisible = state.initialOtherPanelVisible;
      if (state.initialOtherPanelVisible) state.otherPanelRestoreCalled += 1;
      state.descriptionExpanded = state.initialDescriptionExpanded;
      state.pageScrollY = context.snapshot.scrollY;
      state.restored = {
        scrollTop: state.scrollTop,
        panelVisible: state.panelVisible,
        descriptionExpanded: state.descriptionExpanded,
        pageScrollY: state.pageScrollY,
        otherPanelVisible: state.otherPanelVisible,
      };
      return state.restoreFails
        ? { ok: false, errors: ["fixture-restore-failure"] }
        : { ok: true, errors: [] };
    },
  };
  return { runtime, state };
}

function request(overrides = {}) {
  return {
    videoId: VIDEO_ID,
    runId: "panel-run-1",
    preferredLanguage: "en",
    eligibility: {
      activeFoundCaptionTrack: true,
      selectedTrack: { language: "en", kind: "manual" },
      selectedTrackEvidence: "active",
    },
    ...overrides,
  };
}

test("exposes the frozen UMD/CommonJS run interface", () => {
  assert.equal(typeof panelModule.run, "function");
  assert.equal(typeof panelModule.create, "function");
  assert.equal(globalThis.DIGESTDOCK_YOUTUBE_PANEL, panelModule);
});

test("repeated product-file injection reuses one compatible global instance", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "youtube-transcript-panel.js"),
    "utf8",
  );
  let listenerCount = 0;
  const document = {
    addEventListener() {
      listenerCount += 1;
    },
  };
  const context = vm.createContext({
    URL,
    document,
    location: { href: `https://www.youtube.com/watch?v=${VIDEO_ID}` },
    setTimeout,
    clearTimeout,
    addEventListener() {
      listenerCount += 1;
    },
  });
  vm.runInContext(source, context);
  const first = context.DIGESTDOCK_YOUTUBE_PANEL;
  const afterFirst = listenerCount;
  vm.runInContext(source, context);

  assert.equal(context.DIGESTDOCK_YOUTUBE_PANEL, first);
  assert.equal(afterFirst, 4);
  assert.equal(listenerCount, afterFirst);
});

test("contains no direct fetch or XMLHttpRequest call path", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "youtube-transcript-panel.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bnew\s+XMLHttpRequest\b|\bXMLHttpRequest\s*\(/);
});

test("timestamp, row, and coverage helpers preserve complete transcript evidence", () => {
  const helpers = panelModule.__testing;
  assert.equal(helpers.parseTimestamp("1:02:03"), 3723);
  assert.equal(helpers.parseTimestamp("1:99"), null);
  assert.deepEqual(
    helpers.rowsToSegments(
      [
        { timestamp: "0:00", text: " first " },
        { timestamp: "0:03", text: "second" },
      ],
      "en",
    ),
    [
      { text: "first", start: 0, duration: 3, language: "en" },
      { text: "second", start: 3, duration: 0, language: "en" },
    ],
  );
  assert.deepEqual(
    helpers.coverageMetrics(
      [
        [0, 100],
        [75, 175],
        [150, 250],
      ],
      250,
    ),
    { complete: true, ratio: 1, ranges: [[0, 250]] },
  );
});

test("does not open page UI when neither Active nor the DOM provides eligibility", async () => {
  const { runtime, state } = makeRuntime({
    entryExists: false,
    entryVisible: false,
  });
  const api = panelModule.create({ runtime, timeoutMs: 500, settleMs: 0 });
  const result = await api.run(
    request({ eligibility: { activeFoundCaptionTrack: false } }),
  );

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_INELIGIBLE");
  assert.equal(result.runId, "panel-run-1");
  assert.equal(state.expandCalled, 0);
  assert.equal(state.openCalled, 0);
  assert.equal(state.restoreCalled, 1);
  assert.equal(result.diagnostics.extensionDirectRequests, 0);
  assert.deepEqual(result.diagnostics.pageInducedRequests, {
    status: "unknown",
    count: null,
  });
});

test("automatically opens, continuously scrolls, collects, and restores the panel", async () => {
  const { runtime, state } = makeRuntime({
    entryVisible: false,
    initialScrollerTop: 17,
    scrollTop: 17,
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 1_000,
    pollMs: 1,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.ok, true);
  assert.equal(result.providerId, "youtube-panel");
  assert.equal(result.providerVariant, "auto-rendered-panel");
  assert.equal(result.videoId, VIDEO_ID);
  assert.equal(result.runId, "panel-run-1");
  assert.equal(result.complete, true);
  assert.equal(result.completenessEvidence, "auto-top-middle-bottom");
  assert.ok(result.transcript.length >= 5);
  assert.equal(result.transcript[0].start, 0);
  assert.match(result.transcriptTextTimestamped, /^\[0:00\] segment-0/m);
  assert.equal(result.language, "en");
  assert.deepEqual(result.selectedTrack, { language: "en", kind: "manual" });
  assert.equal(result.diagnostics.requestedLanguage, "en");
  assert.equal(result.diagnostics.extensionDirectRequests, 0);
  assert.deepEqual(result.diagnostics.pageInducedRequests, {
    status: "unknown",
    count: null,
  });
  assert.deepEqual(result.diagnostics.providerInitiated, {
    youtubePlayer: 0,
    youtubeTimedtext: 0,
    thirdParty: 0,
    loopback: 0,
  });
  assert.equal(state.expandCalled, 1);
  assert.equal(state.openCalled, 1);
  assert.equal(state.restoreCalled, 1);
  assert.deepEqual(state.restored, {
    scrollTop: 17,
    panelVisible: false,
    descriptionExpanded: false,
    pageScrollY: 360,
    otherPanelVisible: false,
  });
});

test("diagnostics separate direct requests from page-induced observations", async () => {
  const { runtime } = makeRuntime();
  const api = panelModule.create({ runtime, timeoutMs: 1_000, settleMs: 1 });
  const result = await api.run(
    request({
      eligibility: {
        activeFoundCaptionTrack: true,
        selectedTrack: { language: "en", kind: "manual" },
        observedGetTranscriptRequests: 1,
      },
    }),
  );

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.diagnostics.extensionDirectRequests, 0);
  assert.deepEqual(result.diagnostics.pageInducedRequests, {
    status: "observed",
    count: 1,
  });
  assert.equal("networkRequests" in result.diagnostics, false);
});

test("supports a complete short transcript that fits in one panel viewport", async () => {
  const { runtime, state } = makeRuntime({
    panelVisible: true,
    scrollHeight: 80,
    clientHeight: 100,
    rowsForScroll: () => [
      { timestamp: "0:00", text: "short transcript" },
    ],
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 500,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.transcript.length, 1);
  assert.equal(result.diagnostics.sawTop, true);
  assert.equal(result.diagnostics.sawMiddle, true);
  assert.equal(result.diagnostics.sawBottom, true);
  assert.equal(result.diagnostics.coverageRatio, 1);
  assert.equal(state.restoreCalled, 1);
});

test("a verified rendered language mismatch fails closed", async () => {
  const { runtime } = makeRuntime({
    panelVisible: true,
    panelLanguage: "en",
  });
  const api = panelModule.create({ runtime, timeoutMs: 500, settleMs: 1 });
  const result = await api.run(request({ preferredLanguage: "fr" }));

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_LANGUAGE_MISMATCH");
});

test("panel-explicit language does not invent Active track evidence", async () => {
  const { runtime } = makeRuntime({ panelVisible: true, panelLanguage: "en" });
  const api = panelModule.create({ runtime, timeoutMs: 500, settleMs: 1 });
  const result = await api.run(
    request({
      eligibility: { captionTrackCount: 1 },
    }),
  );

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.languageEvidence, "panel-explicit");
  assert.equal(result.diagnostics.selectedTrackEvidence, null);
});

test("real UI without data-language-code uses exact Active track language evidence", async () => {
  const { runtime } = makeRuntime({
    panelLanguage: null,
  });
  const api = panelModule.create({ runtime, timeoutMs: 500, settleMs: 1 });
  const result = await api.run(request());

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.language, "en");
  assert.equal(result.languageEvidence, "active-exact-selected-track");
  assert.equal(result.diagnostics.panelLanguage, null);
});

test("real UI labels page-default track evidence without claiming Active", async () => {
  const { runtime } = makeRuntime({ panelLanguage: null });
  const api = panelModule.create({ runtime, timeoutMs: 500, settleMs: 1 });
  const result = await api.run(
    request({
      eligibility: {
        captionTrackCount: 1,
        selectedTrack: { language: "en", kind: "manual" },
        selectedTrackEvidence: "page-default",
      },
    }),
  );

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.languageEvidence, "page-default-track");
  assert.equal(result.diagnostics.selectedTrackEvidence, "page-default");
});

test("missing Panel language and missing exact Active track fail closed", async () => {
  const { runtime } = makeRuntime({ panelLanguage: null });
  const api = panelModule.create({ runtime, timeoutMs: 500, settleMs: 1 });
  const result = await api.run(
    request({
      eligibility: undefined,
      activeEvidence: { sawTracks: true },
    }),
  );

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_LANGUAGE_UNVERIFIED");
});

test("selectedTrack is omitted unless Panel and Active provide matching kind evidence", async () => {
  const { runtime } = makeRuntime({
    panelVisible: true,
    panelLanguage: "en",
    panelTrackKind: null,
  });
  const api = panelModule.create({ runtime, timeoutMs: 500, settleMs: 1 });
  const result = await api.run(request());

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.language, "en");
  assert.equal(result.selectedTrack, null);
});

test("an already-open panel is read and its own scroll state is restored", async () => {
  const { runtime, state } = makeRuntime({
    panelVisible: true,
    initialPanelVisible: true,
    scrollTop: 29,
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 1_000,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(state.closeCalled, 1);
  assert.equal(state.openCalled, 1);
  assert.equal(state.expandCalled, 0);
  assert.equal(state.restored.scrollTop, 29);
  assert.equal(state.restored.panelVisible, true);
});

test("a residual SPA panel must disappear and reopen before its rows are accepted", async () => {
  const { runtime, state } = makeRuntime({
    panelVisible: true,
    initialPanelVisible: true,
    closeDelayMs: 900,
    beforeOpenRows: [{ timestamp: "0:00", text: "old-video-row" }],
    afterOpenRows: [{ timestamp: "0:00", text: "current-video-row" }],
    scrollHeight: 80,
    clientHeight: 100,
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 5_000,
    pollMs: 100,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(state.closeCalled, 1);
  assert.equal(state.openCalled, 1);
  assert.ok(state.now >= 900);
  assert.equal(result.transcriptText, "current-video-row");
  assert.notEqual(
    result.diagnostics.preOpenRowSignature,
    result.diagnostics.postOpenRowSignature,
  );
  assert.equal(result.diagnostics.panelDisappearedBeforeOpen, true);
});

test("A to B to A may reuse row content only after epoch-stable close and reopen", async () => {
  const sameRows = [{ timestamp: "0:00", text: "video-a-row" }];
  const { runtime, state } = makeRuntime({
    epoch: 2,
    panelVisible: true,
    initialPanelVisible: true,
    beforeOpenRows: sameRows,
    afterOpenRows: sameRows,
    scrollHeight: 80,
    clientHeight: 100,
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 2_000,
    pollMs: 10,
    settleMs: 1,
  });
  const result = await api.run(request({ runId: "video-a-cycle-3" }));

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(state.closeCalled, 1);
  assert.equal(state.openCalled, 1);
  assert.equal(
    result.diagnostics.preOpenRowSignature,
    result.diagnostics.postOpenRowSignature,
  );
  assert.equal(result.diagnostics.panelDisappearedBeforeOpen, true);
});

test("an A to B to A navigation during stale-panel clearing cancels the old run", async () => {
  let waits = 0;
  const { runtime, state } = makeRuntime({
    panelVisible: true,
    initialPanelVisible: true,
    closeDelayMs: 900,
    onWait(current) {
      waits += 1;
      if (waits === 1) {
        current.epoch += 1;
        current.videoId = "aqz-KE-bpKQ";
        current.epoch += 1;
        current.videoId = VIDEO_ID;
      }
    },
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 5_000,
    pollMs: 100,
    settleMs: 1,
  });
  const result = await api.run(request({ runId: "a-b-a-old-run" }));

  assert.equal(result.status, "PAGE_CONTEXT_CHANGED");
  assert.equal(result.errorCode, "PAGE_CONTEXT_CHANGED");
  assert.equal(state.openCalled, 0);
});

test("a residual panel that never disappears fails closed without reopening", async () => {
  const { runtime, state } = makeRuntime({
    panelVisible: true,
    initialPanelVisible: true,
    closeDelayMs: Infinity,
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 5_000,
    pollMs: 100,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_STALE");
  assert.equal(state.openCalled, 0);
  assert.equal(state.restoreCalled, 1);
});

test("a restorable existing Chapters panel is restored after Transcript", async () => {
  const { runtime, state } = makeRuntime({
    initialOtherPanelVisible: true,
    otherPanelRestorable: true,
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 1_000,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(state.openCalled, 1);
  assert.equal(state.otherPanelRestoreCalled, 1);
  assert.equal(state.restored.otherPanelVisible, true);
});

test("an unrestorable existing engagement panel fails before opening Transcript", async () => {
  const { runtime, state } = makeRuntime({
    initialOtherPanelVisible: true,
    otherPanelRestorable: false,
  });
  const api = panelModule.create({ runtime, timeoutMs: 1_000, settleMs: 1 });
  const result = await api.run(request());

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_EXISTING_UI_UNRESTORABLE");
  assert.equal(state.openCalled, 0);
  assert.equal(state.expandCalled, 0);
});

test("400, empty, no-entry, and missing scroller are UNKNOWN, never unavailable", async (t) => {
  const cases = [
    {
      name: "400 evidence",
      setup: {},
      input: request({ eligibility: { panelHttpStatus: 400 } }),
      expected: "PANEL_HTTP_400",
    },
    {
      name: "empty panel",
      setup: { panelVisible: true, emptyRows: true },
      input: request(),
      expected: "PANEL_EMPTY",
    },
    {
      name: "no entry",
      setup: { entryExists: false, entryVisible: false, openFails: true },
      input: request(),
      expected: "PANEL_NO_ENTRY",
    },
    {
      name: "DOM/scroller change",
      setup: { panelVisible: true, scrollerAvailable: false },
      input: request(),
      expected: "PANEL_SCROLL_CONTAINER_UNKNOWN",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { runtime, state } = makeRuntime(fixture.setup);
      const api = panelModule.create({
        runtime,
        timeoutMs: fixture.expected === "PANEL_EMPTY" ? 4_000 : 20,
        pollMs: 2,
        settleMs: 1,
      });
      const result = await api.run(fixture.input);
      assert.equal(result.status, "UNKNOWN");
      assert.equal(result.errorCode, fixture.expected);
      assert.notEqual(result.status, "CONFIRMED_UNAVAILABLE");
      assert.notEqual(result.errorCode, "NO_TRANSCRIPT");
      assert.equal(state.restoreCalled, 1);
    });
  }
});

test("timeout returns UNKNOWN within the configured and product hard limits", async () => {
  const { runtime, state } = makeRuntime({
    panelVisible: true,
    emptyRows: true,
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 25,
    pollMs: 10,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_TIMEOUT");
  assert.ok(state.now <= 25);
  assert.equal(state.restoreCalled, 1);
  assert.equal(panelModule.__testing.MAX_TIMEOUT_MS, 15_000);
});

test("navigation cancels immediately and restores every module-owned page change", async () => {
  let waits = 0;
  const { runtime, state } = makeRuntime({
    entryVisible: true,
    onWait(current) {
      waits += 1;
      if (waits === 1) {
        current.epoch += 1;
        current.videoId = "aqz-KE-bpKQ";
      }
    },
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 500,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "PAGE_CONTEXT_CHANGED");
  assert.equal(result.errorCode, "PAGE_CONTEXT_CHANGED");
  assert.equal(state.openCalled, 1);
  assert.equal(state.restoreCalled, 1);
  assert.deepEqual(state.restored, {
    scrollTop: 0,
    panelVisible: false,
    descriptionExpanded: false,
    pageScrollY: 360,
    otherPanelVisible: false,
  });
});

test("incomplete scrolling and a mid-run DOM replacement stay UNKNOWN and restore", async (t) => {
  await t.test("incomplete coverage", async () => {
    const { runtime, state } = makeRuntime({ panelVisible: true });
    runtime.setScrollTop = () => {
      state.setScrollCalls.push(state.scrollTop);
    };
    const api = panelModule.create({
      runtime,
      timeoutMs: 1_000,
      pollMs: 0,
      settleMs: 0,
    });
    const result = await api.run(request());
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.errorCode, "PANEL_INCOMPLETE");
    assert.equal(state.restoreCalled, 1);
  });

  await t.test("DOM replacement", async () => {
    let waits = 0;
    const { runtime, state } = makeRuntime({
      panelVisible: true,
      onWait(current) {
        waits += 1;
        if (waits === 2) current.panelConnected = false;
      },
    });
    const api = panelModule.create({
      runtime,
      timeoutMs: 1_000,
      settleMs: 1,
    });
    const result = await api.run(request());
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.errorCode, "PANEL_DOM_CHANGED");
    assert.equal(state.restoreCalled, 1);
  });

  await t.test("mid-run 400", async () => {
    let waits = 0;
    const { runtime, state } = makeRuntime({
      panelVisible: true,
      onWait(current) {
        waits += 1;
        if (waits === 2) current.panelError = "PANEL_HTTP_400";
      },
    });
    const api = panelModule.create({
      runtime,
      timeoutMs: 1_000,
      settleMs: 1,
    });
    const result = await api.run(request());
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.errorCode, "PANEL_HTTP_400");
    assert.equal(state.restoreCalled, 1);
  });
});

test("accepts the eligibilityEvidence alias without widening the route", async () => {
  const { runtime } = makeRuntime({ entryExists: false, entryVisible: false });
  const api = panelModule.create({ runtime, timeoutMs: 1_000, settleMs: 1 });
  const result = await api.run(
    request({
      eligibility: undefined,
      eligibilityEvidence: {
        activeFoundCaptionTrack: true,
        selectedTrack: { language: "en", kind: "manual" },
      },
    }),
  );
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_NO_ENTRY");
});

test("accepts the background activeEvidence sawTracks contract", async () => {
  const { runtime } = makeRuntime({ entryExists: false, entryVisible: false });
  const api = panelModule.create({ runtime, timeoutMs: 1_000, settleMs: 1 });
  const result = await api.run(
    request({
      eligibility: undefined,
      activeEvidence: { sawTracks: true },
    }),
  );
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_NO_ENTRY");
});

test("an explicit run cancellation returns PAGE_CONTEXT_CHANGED and restores", async () => {
  const { runtime, state } = makeRuntime({
    panelVisible: true,
    onWait() {
      api.cancel("panel-run-1");
    },
  });
  const api = panelModule.create({
    runtime,
    timeoutMs: 500,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "PAGE_CONTEXT_CHANGED");
  assert.equal(result.diagnostics.stopReason, "cancelled");
  assert.equal(state.restoreCalled, 1);
});

test("a restoration failure invalidates an otherwise successful transcript", async () => {
  const { runtime } = makeRuntime({ restoreFails: true });
  const api = panelModule.create({
    runtime,
    timeoutMs: 1_000,
    settleMs: 1,
  });
  const result = await api.run(request());

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_RESTORE_FAILED");
  assert.equal(result.diagnostics.restoreErrorCount, 1);
});

test("invalid requests fail closed without touching the page", async () => {
  const { runtime, state } = makeRuntime();
  const api = panelModule.create({ runtime });
  const result = await api.run({ videoId: "bad", runId: "" });

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PANEL_INVALID_REQUEST");
  assert.equal(state.restoreCalled, 0);
  assert.equal(state.openCalled, 0);
});

test("browser runtime never clicks an unrelated overflow-menu button", async () => {
  let clicks = 0;
  const unrelated = {
    isConnected: true,
    textContent: "Share",
    getClientRects: () => [{}],
    getAttribute(name) {
      return name === "aria-label" ? "Share" : null;
    },
    click() {
      clicks += 1;
    },
  };
  const document = {
    addEventListener() {},
    querySelectorAll(selector) {
      return selector.includes("ytd-watch-metadata ytd-menu-renderer")
        ? [unrelated]
        : [];
    },
    querySelector() {
      return null;
    },
  };
  const root = {
    document,
    location: { href: `https://www.youtube.com/watch?v=${VIDEO_ID}` },
    addEventListener() {},
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      overflowY: "visible",
    }),
    setTimeout,
  };
  const runtime = panelModule.__testing.createBrowserRuntime(root);
  const result = await runtime.openTranscriptPanel(null);

  assert.deepEqual(result, { opened: false, overflowOpened: false });
  assert.equal(clicks, 0);
});

test("browser runtime never uses a document-global unrelated Show more control", () => {
  const unrelated = {
    isConnected: true,
    textContent: "Show more",
    getClientRects: () => [{}],
    getAttribute: () => null,
  };
  const document = {
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === "button,[role='button']" ? [unrelated] : [];
    },
  };
  const root = {
    document,
    addEventListener() {},
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      overflowY: "visible",
    }),
    setTimeout,
  };
  const runtime = panelModule.__testing.createBrowserRuntime(root);
  assert.equal(runtime.findDescriptionControl("expand"), null);
});

test("browser runtime ignores a non-description inline expander", () => {
  let clicks = 0;
  const unrelatedButton = {
    isConnected: true,
    textContent: "Show more",
    getClientRects: () => [{}],
    getAttribute: () => null,
    click() {
      clicks += 1;
    },
  };
  const unrelatedExpander = {
    isConnected: true,
    querySelectorAll: () => [unrelatedButton],
  };
  const document = {
    addEventListener() {},
    querySelector(selector) {
      return selector === "ytd-text-inline-expander"
        ? unrelatedExpander
        : null;
    },
    querySelectorAll: () => [],
  };
  const root = {
    document,
    addEventListener() {},
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      overflowY: "visible",
    }),
    setTimeout,
  };
  const runtime = panelModule.__testing.createBrowserRuntime(root);

  assert.equal(runtime.findDescriptionControl("expand"), null);
  assert.deepEqual(runtime.expandDescription(), {
    changed: false,
    control: null,
  });
  assert.equal(clicks, 0);
});

test("browser runtime recognizes a fitted non-overflow transcript scroller", () => {
  const scroller = {
    isConnected: true,
    scrollHeight: 80,
    clientHeight: 100,
    parentElement: null,
  };
  const row = { parentElement: scroller };
  const panel = {
    contains: (node) => node === scroller,
    querySelectorAll(selector) {
      return selector.includes("transcript-segment") ? [row] : [];
    },
    querySelector() {
      return null;
    },
  };
  const root = {
    document: { addEventListener() {} },
    addEventListener() {},
    getComputedStyle(node) {
      return {
        display: "block",
        visibility: "visible",
        overflowY: node === scroller ? "auto" : "visible",
      };
    },
    setTimeout,
  };
  const runtime = panelModule.__testing.createBrowserRuntime(root);
  assert.equal(runtime.findScroller(panel), scroller);
});

test("browser runtime snapshots non-transcript engagement panels fail-closed", () => {
  const chapters = {
    isConnected: true,
    id: "",
    textContent: "Chapters",
    getClientRects: () => [{}],
    getAttribute(name) {
      return name === "target-id" ? "engagement-panel-chapters" : null;
    },
    querySelectorAll: () => [],
  };
  const document = {
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "ytd-engagement-panel-section-list-renderer") {
        return [chapters];
      }
      return [];
    },
  };
  const root = {
    document,
    location: { href: `https://www.youtube.com/watch?v=${VIDEO_ID}` },
    addEventListener() {},
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      overflowY: "visible",
    }),
    setTimeout,
  };
  const runtime = panelModule.__testing.createBrowserRuntime(root);
  const snapshot = runtime.capture();

  assert.equal(snapshot.engagementPanels.length, 1);
  assert.equal(snapshot.engagementPanels[0].identity, "engagement-panel-chapters");
  assert.equal(snapshot.engagementPanels[0].transcript, false);
  assert.equal(snapshot.engagementPanels[0].restoreControl, null);
  assert.equal(runtime.canRestoreEngagementPanels(snapshot), false);
});

test("browser runtime rejects URL and current player identity disagreement", () => {
  const document = {
    addEventListener() {},
    querySelector(selector) {
      if (selector === "ytd-watch-flexy") {
        return {
          getAttribute(name) {
            return name === "video-id" ? "aqz-KE-bpKQ" : null;
          },
        };
      }
      return null;
    },
  };
  const root = {
    document,
    location: { href: `https://www.youtube.com/watch?v=${VIDEO_ID}` },
    addEventListener() {},
    setTimeout,
  };
  const runtime = panelModule.__testing.createBrowserRuntime(root);
  assert.equal(runtime.currentVideoId(), null);
});

test("browser runtime bounded-polls restoration instead of trusting a click", async (t) => {
  function fixture({ closeWorks, closeDelayMs = 0 }) {
    let panelVisible = true;
    let scrollY = 90;
    const close = {
      isConnected: true,
      textContent: "",
      getClientRects: () => [{}],
      getAttribute(name) {
        return name === "aria-label" ? "Close" : null;
      },
      click() {
        if (closeWorks) {
          setTimeout(() => {
            panelVisible = false;
          }, closeDelayMs);
        }
      },
    };
    const panel = {
      isConnected: true,
      id: "",
      textContent: "Transcript",
      getClientRects: () => panelVisible ? [{}] : [],
      getAttribute(name) {
        return name === "target-id" ? "engagement-panel-transcript" : null;
      },
      querySelector(selector) {
        return selector.includes("Close") || selector.includes("close")
          ? close
          : null;
      },
      querySelectorAll(selector) {
        return selector === "button,[role='button']" ? [close] : [];
      },
    };
    const document = {
      addEventListener() {},
      dispatchEvent() {},
      querySelector() {
        return null;
      },
      querySelectorAll(selector) {
        return selector === "ytd-engagement-panel-section-list-renderer"
          ? [panel]
          : [];
      },
    };
    const root = {
      document,
      location: { href: `https://www.youtube.com/watch?v=${VIDEO_ID}` },
      scrollX: 0,
      get scrollY() {
        return scrollY;
      },
      addEventListener() {},
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        overflowY: "auto",
      }),
      scrollTo(_x, y) {
        scrollY = y;
      },
      setTimeout,
    };
    return {
      runtime: panelModule.__testing.createBrowserRuntime(root),
      panel,
    };
  }

  for (const closeWorks of [true, false]) {
    await t.test(closeWorks ? "restored" : "failed verification", async () => {
      const { runtime, panel } = fixture({ closeWorks });
      const snapshot = {
        videoId: VIDEO_ID,
        navigationEpoch: runtime.navigationEpoch(),
        scrollX: 0,
        scrollY: 90,
        descriptionExpanded: false,
        panel: null,
      };
      const result = await runtime.restore({
        snapshot,
        panel,
        scroller: null,
        scrollerScrollTop: 0,
        openedPanel: true,
        overflowOpened: false,
        descriptionExpandedByModule: false,
        descriptionControl: null,
        deadline: Date.now() + (closeWorks ? 100 : 5),
        pollMs: 2,
      });
      assert.equal(result.ok, closeWorks);
      if (!closeWorks) assert.ok(result.errors.includes("PANEL_CLOSE_FAILED"));
    });
  }

  await t.test("delayed close is observed within the restore budget", async () => {
    const { runtime, panel } = fixture({
      closeWorks: true,
      closeDelayMs: 15,
    });
    const result = await runtime.restore({
      snapshot: {
        videoId: VIDEO_ID,
        navigationEpoch: runtime.navigationEpoch(),
        scrollX: 0,
        scrollY: 90,
        descriptionExpanded: false,
        panel: null,
        engagementPanels: [],
      },
      panel,
      scroller: null,
      scrollerScrollTop: 0,
      openedPanel: true,
      overflowOpened: false,
      descriptionExpandedByModule: false,
      descriptionControl: null,
      deadline: Date.now() + 100,
      pollMs: 2,
    });
    assert.equal(result.ok, true);
  });
});
