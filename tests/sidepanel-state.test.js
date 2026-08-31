const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const stateApi = require("../sidepanel-state.js");

const {
  EVENTS,
  TASK_ORIGINS,
  TRANSCRIPT_STATUSES,
  OVERVIEW_STATUSES,
  COMPONENT_KINDS,
  TIMING,
  createInitialState,
  adaptTranscriptOutcome,
  reduceSidepanelState,
  deriveTranscriptActions,
  deriveTranscriptComponent,
  deriveOverviewActions,
  deriveOverviewComponent,
  deriveView,
} = stateApi;

const root = path.resolve(__dirname, "..");
const VIDEO_A = "video-a";
const VIDEO_B = "video-b";

function identity(state) {
  return {
    videoId: state.session.videoId,
    routeKey: state.session.routeKey,
    generation: state.session.generation,
    epoch: state.session.epoch,
  };
}

function bind({
  videoId = VIDEO_A,
  routeKey = `youtube:${VIDEO_A}`,
  taskId = "initial-1",
  epoch = 0,
} = {}) {
  return reduceSidepanelState(createInitialState(), {
    type: EVENTS.SESSION_BIND,
    videoId,
    routeKey,
    epoch,
    taskId,
    taskOrigin: TASK_ORIGINS.INITIAL_LOAD,
  });
}

function transcriptResult(state, result, overrides = {}) {
  return reduceSidepanelState(state, {
    type: EVENTS.TRANSCRIPT_RESULT,
    identity: overrides.identity || identity(state),
    taskId:
      overrides.taskId === undefined
        ? state.transcript.activeTask?.id
        : overrides.taskId,
    taskOrigin:
      overrides.taskOrigin === undefined
        ? state.transcript.activeTask?.origin
        : overrides.taskOrigin,
    result,
  });
}

function firstUnknown(state = bind()) {
  return transcriptResult(state, {
    success: false,
    routeOutcome: "UNKNOWN",
    error: "YOUTUBE_CAPTIONS_REQUIRED",
    requiresCaptionEnable: true,
    supadataEligible: false,
  });
}

function freeRetry(state = firstUnknown(), taskId = "retry-1") {
  return reduceSidepanelState(state, {
    type: EVENTS.USER_RETRY_FREE,
    taskId,
  });
}

function finalUnknown(state = freeRetry(), taskId = "retry-1") {
  return transcriptResult(
    state,
    {
      success: false,
      routeOutcome: "UNKNOWN",
      error: "SUPADATA_CONSENT_REQUIRED",
      supadataEligible: true,
      hasSupadataKey: true,
    },
    { taskId, taskOrigin: TASK_ORIGINS.USER_RETRY_FREE },
  );
}

function fetchingSupadata({ taskId = "supadata-1", token = "token-1" } = {}) {
  const choice = finalUnknown();
  return reduceSidepanelState(choice, {
    type: EVENTS.USER_CONSENT,
    identity: choice.session,
    hasKey: true,
    consentToken: token,
    taskId,
    now: 1000,
  });
}

function dispatchedSupadata(options = {}) {
  const fetching = fetchingSupadata(options);
  return reduceSidepanelState(fetching, {
    type: EVENTS.SUPADATA_REQUEST_DISPATCHED,
    identity: identity(fetching),
    taskId: options.taskId || "supadata-1",
    consentToken: options.token || "token-1",
  });
}

test("phase-one state module is pure and publishes fixed timing contracts", () => {
  const source = fs.readFileSync(path.join(root, "sidepanel-state.js"), "utf8");
  assert.doesNotMatch(source, /chrome\s*\./);
  assert.doesNotMatch(source, /youtube-active|youtube-panel/i);
  assert.deepEqual(TIMING, {
    CACHE_SKELETON_DELAY_MS: 150,
    SHORT_SUCCESS_FEEDBACK_MS: 1200,
    DISPATCH_FEEDBACK_BUDGET_MS: 100,
    LOCAL_TASK_STATUS_BUDGET_MS: 300,
  });
});

test("initial contract keeps persistent workspace state separate from media identity", () => {
  const state = createInitialState();
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.session, {
    status: "resolving",
    videoId: null,
    routeKey: null,
    generation: 0,
    epoch: 0,
    readOnly: false,
  });
  assert.equal(state.activeTab, "transcript");
  assert.equal(state.transcript.status, TRANSCRIPT_STATUSES.LOADING);
  assert.equal(state.overview.status, OVERVIEW_STATUSES.BLOCKED);
  assert.equal(state.notes.writesDisabled, true);
  assert.deepEqual(state.follow, {
    mode: "following",
    anchorTime: 0,
    programmaticToken: null,
    scrollTop: 0,
    currentCueTime: 0,
  });
});

test("binding a new video increments generation and hard-resets workspace state", () => {
  let state = bind();
  state = reduceSidepanelState(state, {
    type: EVENTS.TAB_STATE_SAVED,
    tab: "notes",
    snapshot: { scrollTop: 412, selection: ["note-1"] },
  });
  state = finalUnknown(freeRetry(firstUnknown(state), "retry-a"), "retry-a");
  assert.equal(state.transcript.status, TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE);

  const next = reduceSidepanelState(state, {
    type: EVENTS.SESSION_BIND,
    videoId: VIDEO_B,
    routeKey: `youtube:${VIDEO_B}`,
    taskId: "initial-b",
    taskOrigin: TASK_ORIGINS.INITIAL_LOAD,
  });

  assert.equal(next.session.generation, 2);
  assert.equal(next.session.videoId, VIDEO_B);
  assert.equal(next.session.epoch, 0);
  assert.equal(next.transcript.status, TRANSCRIPT_STATUSES.LOADING);
  assert.equal(next.transcript.retryUsed, false);
  assert.equal(next.transcript.consentToken, null);
  assert.equal(next.tabs.notes.scrollTop, 0);
  assert.deepEqual(next.tabs.notes, { scrollTop: 0 });
});

test("an explicit same-video rebind starts a new generation without changing route identity", () => {
  const state = bind();
  const rebound = reduceSidepanelState(state, {
    type: EVENTS.SESSION_BIND,
    videoId: VIDEO_A,
    routeKey: `youtube:${VIDEO_A}`,
    forceGeneration: true,
    taskId: "source-track-rebind",
    taskOrigin: TASK_ORIGINS.INITIAL_LOAD,
  });
  assert.equal(rebound.session.videoId, VIDEO_A);
  assert.equal(rebound.session.routeKey, `youtube:${VIDEO_A}`);
  assert.equal(rebound.session.generation, state.session.generation + 1);
  assert.equal(rebound.session.epoch, 0);
  assert.equal(rebound.transcript.activeTask.id, "source-track-rebind");
});

test("page epoch change preserves verified content read-only and rejects the old epoch", () => {
  const loading = bind();
  const ready = transcriptResult(loading, {
    success: true,
    routeOutcome: "HAVE_TRANSCRIPT",
    transcript: [{ start: 0, text: "ready" }],
  });
  const oldIdentity = identity(ready);

  const reconnected = reduceSidepanelState(ready, {
    type: EVENTS.PAGE_EPOCH_CHANGED,
    videoId: VIDEO_A,
    routeKey: `youtube:${VIDEO_A}`,
    epoch: 1,
    taskId: "epoch-1",
  });

  assert.equal(reconnected.session.generation, 1);
  assert.equal(reconnected.session.epoch, 1);
  assert.equal(reconnected.session.readOnly, true);
  assert.equal(reconnected.transcript.status, TRANSCRIPT_STATUSES.LOADING);
  assert.equal(reconnected.transcript.retainedReady, true);
  assert.equal(reconnected.transcript.retryUsed, false);
  assert.equal(reconnected.notes.writesDisabled, true);

  const stale = transcriptResult(
    reconnected,
    { success: false, routeOutcome: "UNKNOWN" },
    {
      identity: oldIdentity,
      taskId: "initial-1",
      taskOrigin: TASK_ORIGINS.INITIAL_LOAD,
    },
  );
  assert.strictEqual(stale, reconnected);
});

test("first YouTube UNKNOWN becomes a CC action with no Supadata surface", () => {
  const state = firstUnknown();
  const component = deriveTranscriptComponent(state);
  const actions = deriveTranscriptActions(state);

  assert.equal(state.transcript.status, TRANSCRIPT_STATUSES.NEEDS_CC);
  assert.equal(state.transcript.retryUsed, false);
  assert.equal(component.kind, COMPONENT_KINDS.ACTION);
  assert.equal(component.title, "请先打开 YouTube 字幕");
  assert.deepEqual(actions, [
    {
      id: "retry-free",
      label: "已看到字幕，重新读取",
      kind: "primary",
      event: { type: EVENTS.USER_RETRY_FREE },
    },
  ]);
  assert.doesNotMatch(JSON.stringify({ component, actions }), /Supadata/i);
});

test("Passive or automatic UNKNOWN does not move an interactive state or change retryUsed", () => {
  const needsCc = firstUnknown();
  const passive = transcriptResult(
    needsCc,
    { success: false, routeOutcome: "UNKNOWN" },
    { taskId: null, taskOrigin: TASK_ORIGINS.PASSIVE },
  );
  assert.strictEqual(passive, needsCc);

  const retrying = freeRetry(needsCc, "retry-passive");
  const automatic = transcriptResult(
    retrying,
    { success: false, routeOutcome: "UNKNOWN" },
    { taskId: null, taskOrigin: TASK_ORIGINS.AUTOMATIC_REFRESH },
  );
  assert.strictEqual(automatic, retrying);
  assert.equal(automatic.transcript.retryUsed, true);
});

test("same-identity Passive success and terminal facts may leave interactive states", () => {
  const needsCc = firstUnknown();
  const ready = transcriptResult(
    needsCc,
    { success: true, routeOutcome: "HAVE_TRANSCRIPT" },
    { taskId: null, taskOrigin: TASK_ORIGINS.PASSIVE },
  );
  assert.equal(ready.transcript.status, TRANSCRIPT_STATUSES.READY);

  const terminal = transcriptResult(
    firstUnknown(),
    {
      success: false,
      routeOutcome: "CONFIRMED_UNAVAILABLE",
      error: "NO_TRANSCRIPT",
    },
    { taskId: null, taskOrigin: TASK_ORIGINS.PASSIVE },
  );
  assert.equal(terminal.transcript.status, TRANSCRIPT_STATUSES.TERMINAL);
  assert.equal(terminal.transcript.reason, "no_transcript");
});

test("only the same explicit free-retry task can unlock Supadata choice", () => {
  const retrying = freeRetry(firstUnknown(), "retry-exact");
  assert.equal(retrying.transcript.status, TRANSCRIPT_STATUSES.RETRYING_FREE);
  assert.equal(retrying.transcript.retryUsed, true);

  const wrongTask = transcriptResult(
    retrying,
    { success: false, routeOutcome: "UNKNOWN" },
    { taskId: "retry-other", taskOrigin: TASK_ORIGINS.USER_RETRY_FREE },
  );
  assert.strictEqual(wrongTask, retrying);

  const wrongOrigin = transcriptResult(
    retrying,
    { success: false, routeOutcome: "UNKNOWN" },
    { taskId: "retry-exact", taskOrigin: TASK_ORIGINS.INITIAL_LOAD },
  );
  assert.strictEqual(wrongOrigin, retrying);

  const choice = finalUnknown(retrying, "retry-exact");
  assert.equal(
    choice.transcript.status,
    TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
  );
  assert.equal(choice.transcript.retryUsed, true);
  assert.equal(
    deriveTranscriptActions(choice)[0].label,
    "本次使用 Supadata",
  );
});

test("a free-retry technical failure never unlocks Supadata", () => {
  const retrying = freeRetry(firstUnknown(), "retry-rate");
  const failed = transcriptResult(
    retrying,
    {
      success: false,
      routeOutcome: "UNKNOWN",
      error: "RATE_LIMITED",
      supadataEligible: true,
    },
    { taskId: "retry-rate", taskOrigin: TASK_ORIGINS.USER_RETRY_FREE },
  );

  assert.equal(failed.transcript.status, TRANSCRIPT_STATUSES.ERROR);
  assert.equal(failed.transcript.errorSource, TRANSCRIPT_STATUSES.RETRYING_FREE);
  assert.equal(failed.transcript.retryUsed, false);
  assert.equal(deriveTranscriptActions(failed)[0].label, "返回字幕提示");
});

test("non-YouTube UNKNOWN fails closed without CC or Supadata", () => {
  const loading = bind({
    routeKey: "bilibili:BV1test",
    videoId: "BV1test",
  });
  const state = transcriptResult(loading, {
    success: false,
    routeOutcome: "UNKNOWN",
  });

  assert.equal(state.transcript.status, TRANSCRIPT_STATUSES.TERMINAL);
  assert.equal(state.transcript.reason, "unknown_reason");
  assert.equal(deriveTranscriptActions(state).length, 0);
  assert.doesNotMatch(JSON.stringify(deriveView(state)), /CC|Supadata/i);
});

test("outcome adapter maps terminal facts precisely and fails unknown codes closed", () => {
  const cases = [
    [{ routeOutcome: "PAGE_CONTEXT_CHANGED" }, "page_context_changed"],
    [
      { routeOutcome: "CONFIRMED_UNAVAILABLE", error: "NO_TRANSCRIPT" },
      "no_transcript",
    ],
    [
      { routeOutcome: "CONFIRMED_UNAVAILABLE", error: "LOGIN_REQUIRED" },
      "login_required",
    ],
    [
      { routeOutcome: "CONFIRMED_UNAVAILABLE", error: "VIDEO_UNAVAILABLE" },
      "video_unavailable",
    ],
    [
      { routeOutcome: "CONFIRMED_UNAVAILABLE", error: "TRACK_UNAVAILABLE" },
      "confirmed_unavailable",
    ],
  ];
  for (const [result, reason] of cases) {
    assert.deepEqual(adaptTranscriptOutcome(result), {
      type: "terminal",
      reason,
    });
  }
  assert.deepEqual(adaptTranscriptOutcome({ error: "NEW_UNREGISTERED_CODE" }), {
    type: "terminal",
    reason: "unknown_reason",
  });
  assert.deepEqual(
    adaptTranscriptOutcome({
      success: true,
      routeOutcome: "HAVE_TRANSCRIPT",
      error: "PAGE_CONTEXT_CHANGED",
    }),
    { type: "terminal", reason: "page_context_changed" },
  );
  assert.deepEqual(
    adaptTranscriptOutcome({
      routeOutcome: "CONFIRMED_UNAVAILABLE",
      error: "LOGIN_REQUIRED",
      message: "请先完成登录验证。",
    }),
    {
      type: "terminal",
      reason: "login_required",
      message: "请先完成登录验证。",
    },
  );
});

test("terminal states expose only reason-specific recovery actions and zero Supadata", () => {
  for (const [result, expectedReason, expectedLabel] of [
    [
      { routeOutcome: "CONFIRMED_UNAVAILABLE", error: "NO_TRANSCRIPT" },
      "no_transcript",
      null,
    ],
    [
      { routeOutcome: "CONFIRMED_UNAVAILABLE", error: "LOGIN_REQUIRED" },
      "login_required",
      "我已完成登录，重新检查",
    ],
    [
      { routeOutcome: "PAGE_CONTEXT_CHANGED", error: "PAGE_CONTEXT_CHANGED" },
      "page_context_changed",
      "重新连接当前视频",
    ],
  ]) {
    const state = transcriptResult(bind(), result);
    const actions = deriveTranscriptActions(state);
    assert.equal(state.transcript.reason, expectedReason);
    assert.equal(actions[0]?.label || null, expectedLabel);
    assert.doesNotMatch(JSON.stringify(actions), /Supadata/i);
  }
});

test("login recovery is a new first read whose UNKNOWN can only return to needs_cc", () => {
  const terminal = transcriptResult(bind(), {
    routeOutcome: "CONFIRMED_UNAVAILABLE",
    error: "LOGIN_REQUIRED",
  });
  const loading = reduceSidepanelState(terminal, {
    type: EVENTS.USER_RESOLVED,
    taskId: "login-resolved",
  });
  assert.equal(loading.transcript.status, TRANSCRIPT_STATUSES.LOADING);
  assert.equal(loading.transcript.retryUsed, false);
  assert.equal(loading.transcript.taskOrigin, TASK_ORIGINS.USER_RESOLVED);

  const unknown = transcriptResult(loading, {
    routeOutcome: "UNKNOWN",
    error: "YOUTUBE_CAPTIONS_REQUIRED",
  });
  assert.equal(unknown.transcript.status, TRANSCRIPT_STATUSES.NEEDS_CC);
  assert.equal(unknown.transcript.retryUsed, false);
});

test("page-context recovery requires an explicit reconnect and starts a new epoch", () => {
  const terminal = transcriptResult(bind({ epoch: 4 }), {
    routeOutcome: "PAGE_CONTEXT_CHANGED",
    error: "PAGE_CONTEXT_CHANGED",
  });
  const ignored = reduceSidepanelState(terminal, {
    type: EVENTS.USER_RESOLVED,
    taskId: "wrong-recovery",
  });
  assert.strictEqual(ignored, terminal);

  const loading = reduceSidepanelState(terminal, {
    type: EVENTS.USER_RECONNECT_CURRENT_VIDEO,
    taskId: "reconnect-5",
  });
  assert.equal(loading.session.epoch, 5);
  assert.equal(loading.transcript.status, TRANSCRIPT_STATUSES.LOADING);
  assert.equal(loading.transcript.retryUsed, false);

  const unknown = transcriptResult(loading, { routeOutcome: "UNKNOWN" });
  assert.equal(unknown.transcript.status, TRANSCRIPT_STATUSES.NEEDS_CC);
});

test("ready is absorbing for same-generation late downgrade results", () => {
  const ready = transcriptResult(bind(), {
    success: true,
    routeOutcome: "HAVE_TRANSCRIPT",
  });
  const lateUnknown = transcriptResult(
    ready,
    { routeOutcome: "UNKNOWN" },
    { taskId: null, taskOrigin: TASK_ORIGINS.PASSIVE },
  );
  const lateTerminal = transcriptResult(
    ready,
    { routeOutcome: "CONFIRMED_UNAVAILABLE", error: "NO_TRANSCRIPT" },
    { taskId: null, taskOrigin: TASK_ORIGINS.PASSIVE },
  );
  assert.strictEqual(lateUnknown, ready);
  assert.strictEqual(lateTerminal, ready);
});

test("consent without a key opens configuration; saving a key returns to consent with zero request task", () => {
  const choice = finalUnknown();
  const config = reduceSidepanelState(choice, {
    type: EVENTS.USER_CONSENT,
    identity: choice.session,
    hasKey: false,
    now: 1000,
  });
  assert.equal(
    config.transcript.status,
    TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG,
  );
  assert.equal(config.transcript.activeTask, null);
  assert.equal(config.transcript.consentToken, null);

  const saved = reduceSidepanelState(config, { type: EVENTS.KEY_SAVED });
  assert.equal(
    saved.transcript.status,
    TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
  );
  assert.equal(saved.transcript.supadataConfigured, true);
  assert.equal(saved.transcript.activeTask, null);
  assert.equal(saved.transcript.consentToken, null);
});

test("consent fails closed without the exact session identity", () => {
  const choice = finalUnknown();
  const event = {
    type: EVENTS.USER_CONSENT,
    hasKey: true,
    consentToken: "token-identity",
    taskId: "task-identity",
    now: 1000,
  };

  assert.strictEqual(reduceSidepanelState(choice, event), choice);
  assert.strictEqual(
    reduceSidepanelState(choice, {
      ...event,
      identity: {
        ...choice.session,
        videoId: "another-video",
        routeKey: "youtube:another-video",
      },
    }),
    choice,
  );
  assert.equal(
    reduceSidepanelState(choice, {
      ...event,
      identity: choice.session,
    }).transcript.status,
    TRANSCRIPT_STATUSES.FETCHING_SUPADATA,
  );
});

test("per-attempt consent is held only until request dispatch and provider recovery requires a new choice", () => {
  const fetching = fetchingSupadata();
  assert.equal(
    fetching.transcript.status,
    TRANSCRIPT_STATUSES.FETCHING_SUPADATA,
  );
  assert.equal(fetching.transcript.consentToken, "token-1");
  assert.equal(fetching.transcript.consentConsumed, false);

  const dispatched = reduceSidepanelState(fetching, {
    type: EVENTS.SUPADATA_REQUEST_DISPATCHED,
    identity: identity(fetching),
    taskId: "supadata-1",
    consentToken: "token-1",
  });
  assert.equal(dispatched.transcript.consentToken, null);
  assert.equal(dispatched.transcript.consentConsumed, true);

  const failed = transcriptResult(dispatched, {
    routeOutcome: "UNKNOWN",
    error: "PROVIDER_TIMEOUT",
  });
  assert.equal(failed.transcript.status, TRANSCRIPT_STATUSES.ERROR);
  assert.equal(
    failed.transcript.errorSource,
    TRANSCRIPT_STATUSES.FETCHING_SUPADATA,
  );

  const recovered = reduceSidepanelState(failed, {
    type: EVENTS.USER_RECOVER_ERROR,
  });
  assert.equal(
    recovered.transcript.status,
    TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
  );
  assert.equal(recovered.transcript.consentToken, null);
  assert.equal(recovered.transcript.activeTask, null);
});

test("configured-provider mismatch is accepted only after a consumed consent token", () => {
  const beforeDispatch = fetchingSupadata();
  const failClosed = transcriptResult(beforeDispatch, {
    routeOutcome: "UNKNOWN",
    error: "SUPADATA_NOT_CONFIGURED",
  });
  assert.equal(failClosed.transcript.status, TRANSCRIPT_STATUSES.TERMINAL);
  assert.equal(failClosed.transcript.reason, "unknown_reason");

  const afterDispatch = dispatchedSupadata();
  const config = transcriptResult(afterDispatch, {
    routeOutcome: "UNKNOWN",
    error: "SUPADATA_NOT_CONFIGURED",
  });
  assert.equal(
    config.transcript.status,
    TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG,
  );
});

test("Supadata 429 returns to a disabled consent card and returning to captions resets the free gate", () => {
  const fetching = dispatchedSupadata();
  const cooled = transcriptResult(fetching, {
    routeOutcome: "UNKNOWN",
    error: "RATE_LIMITED",
    cooldownUntil: 5000,
  });

  assert.equal(
    cooled.transcript.status,
    TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
  );
  assert.equal(cooled.transcript.cooldownUntil, 5000);
  const actions = deriveTranscriptActions(cooled, { now: 1000 });
  assert.equal(actions[0].label, "本次使用 Supadata");
  assert.deepEqual(
    deriveTranscriptComponent(cooled, { now: 1000 }).disabledActionIds,
    ["use-supadata"],
  );
  assert.ok(actions.some((item) => item.label === "返回字幕提示"));

  const needsCc = reduceSidepanelState(cooled, {
    type: EVENTS.USER_RETURN_TO_CAPTIONS,
  });
  assert.equal(needsCc.transcript.status, TRANSCRIPT_STATUSES.NEEDS_CC);
  assert.equal(needsCc.transcript.retryUsed, false);
  assert.equal(needsCc.transcript.cooldownUntil, 0);
});

test("declining Supadata sends no task and reconsidering returns to the authorization card", () => {
  const choice = finalUnknown();
  const declined = reduceSidepanelState(choice, {
    type: EVENTS.USER_DECLINE,
  });
  assert.equal(
    declined.transcript.status,
    TRANSCRIPT_STATUSES.FALLBACK_DECLINED,
  );
  assert.equal(declined.transcript.activeTask, null);
  assert.equal(declined.transcript.consentToken, null);

  const reconsidered = reduceSidepanelState(declined, {
    type: EVENTS.USER_RECONSIDER,
  });
  assert.equal(
    reconsidered.transcript.status,
    TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
  );
  assert.equal(reconsidered.transcript.activeTask, null);
});

test("video switch invalidates every in-state retry and consent capability", () => {
  const fetching = fetchingSupadata();
  const next = reduceSidepanelState(fetching, {
    type: EVENTS.SESSION_BIND,
    videoId: VIDEO_B,
    routeKey: `youtube:${VIDEO_B}`,
    taskId: "video-b-initial",
  });
  assert.equal(next.session.generation, fetching.session.generation + 1);
  assert.equal(next.transcript.retryUsed, false);
  assert.equal(next.transcript.consentToken, null);
  assert.equal(next.transcript.consentConsumed, false);
});

test("component kinds are derived from state and reserve Error for technical failures", () => {
  const base = bind();
  const expected = new Map([
    [TRANSCRIPT_STATUSES.LOADING, COMPONENT_KINDS.PROGRESS],
    [TRANSCRIPT_STATUSES.RETRYING_FREE, COMPONENT_KINDS.PROGRESS],
    [TRANSCRIPT_STATUSES.FETCHING_SUPADATA, COMPONENT_KINDS.PROGRESS],
    [TRANSCRIPT_STATUSES.NEEDS_CC, COMPONENT_KINDS.ACTION],
    [TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE, COMPONENT_KINDS.CONSENT],
    [TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG, COMPONENT_KINDS.CONSENT],
    [TRANSCRIPT_STATUSES.FALLBACK_DECLINED, COMPONENT_KINDS.ACTION],
    [TRANSCRIPT_STATUSES.TERMINAL, COMPONENT_KINDS.TERMINAL],
    [TRANSCRIPT_STATUSES.ERROR, COMPONENT_KINDS.ERROR],
    [TRANSCRIPT_STATUSES.READY, COMPONENT_KINDS.READY],
  ]);

  for (const [status, kind] of expected) {
    const state = {
      ...base,
      transcript: {
        ...base.transcript,
        status,
        reason: status === "terminal" ? "no_transcript" : null,
      },
    };
    assert.equal(deriveTranscriptComponent(state).kind, kind, status);
  }
});

test("every derived button is data-only and has exactly id, label, kind, and event", () => {
  const states = [
    firstUnknown(),
    finalUnknown(),
    reduceSidepanelState(finalUnknown(), { type: EVENTS.USER_DECLINE }),
    transcriptResult(bind(), {
      routeOutcome: "CONFIRMED_UNAVAILABLE",
      error: "LOGIN_REQUIRED",
    }),
  ];
  for (const state of states) {
    for (const button of deriveTranscriptActions(state, {
      canReturnToNotes: true,
    })) {
      assert.deepEqual(Object.keys(button).sort(), [
        "event",
        "id",
        "kind",
        "label",
      ]);
      assert.equal(typeof button.event, "object");
      assert.equal(typeof button.event.type, "string");
    }
  }
});

test("overview remains blocked without transcript and never generates from a blocked tab click", () => {
  const loading = bind();
  const selected = reduceSidepanelState(loading, {
    type: EVENTS.USER_SELECT_TAB,
    tab: "overview",
    taskId: "must-not-run",
  });
  assert.equal(selected.activeTab, "overview");
  assert.equal(selected.overview.status, OVERVIEW_STATUSES.BLOCKED);
  assert.equal(deriveOverviewActions(selected).length, 0);
  const component = deriveOverviewComponent(selected);
  assert.equal(component.title, "字幕就绪后可生成概览");
  assert.equal(component.message, "");
});

test("transcript becoming ready while Overview is visible moves only to idle", () => {
  let state = bind();
  state = reduceSidepanelState(state, {
    type: EVENTS.USER_SELECT_TAB,
    tab: "overview",
  });
  state = transcriptResult(state, {
    success: true,
    routeOutcome: "HAVE_TRANSCRIPT",
  });

  assert.equal(state.activeTab, "overview");
  assert.equal(state.overview.status, OVERVIEW_STATUSES.IDLE);
  assert.equal(state.overview.activeTask, null);
  assert.equal(deriveOverviewActions(state)[0].label, "生成概览");

  const generating = reduceSidepanelState(state, {
    type: EVENTS.USER_GENERATE_OVERVIEW,
    taskId: "overview-explicit",
  });
  assert.equal(generating.overview.status, OVERVIEW_STATUSES.GENERATING);
});

test("entering an idle ready Overview tab is explicit generation intent and cache result is terminal for that task", () => {
  const ready = transcriptResult(bind(), {
    success: true,
    routeOutcome: "HAVE_TRANSCRIPT",
  });
  const generating = reduceSidepanelState(ready, {
    type: EVENTS.USER_SELECT_TAB,
    tab: "overview",
    taskId: "overview-enter",
  });
  assert.equal(generating.overview.status, OVERVIEW_STATUSES.GENERATING);
  assert.equal(
    generating.overview.activeTask.origin,
    TASK_ORIGINS.USER_ENTER_READY_TAB,
  );

  const cached = reduceSidepanelState(generating, {
    type: EVENTS.OVERVIEW_RESULT,
    identity: identity(generating),
    taskId: "overview-enter",
    result: { success: true, source: "cache", overview: {} },
  });
  assert.equal(cached.overview.status, OVERVIEW_STATUSES.READY);
  assert.equal(cached.overview.source, "cache");

  const noRepeat = reduceSidepanelState(cached, {
    type: EVENTS.USER_SELECT_TAB,
    tab: "overview",
    taskId: "overview-repeat",
  });
  assert.equal(noRepeat.overview.status, OVERVIEW_STATUSES.READY);
});

test("overview failure waits for a named regenerate event", () => {
  const ready = transcriptResult(bind(), {
    success: true,
    routeOutcome: "HAVE_TRANSCRIPT",
  });
  const generating = reduceSidepanelState(ready, {
    type: EVENTS.USER_SELECT_TAB,
    tab: "overview",
    taskId: "overview-fail",
  });
  const failed = reduceSidepanelState(generating, {
    type: EVENTS.OVERVIEW_RESULT,
    identity: identity(generating),
    taskId: "overview-fail",
    result: { success: false, error: "PROVIDER_TIMEOUT" },
  });
  assert.equal(failed.overview.status, OVERVIEW_STATUSES.ERROR);
  assert.equal(deriveOverviewActions(failed)[0].label, "重新生成概览");

  const reentered = reduceSidepanelState(failed, {
    type: EVENTS.USER_SELECT_TAB,
    tab: "transcript",
  });
  const back = reduceSidepanelState(reentered, {
    type: EVENTS.USER_SELECT_TAB,
    tab: "overview",
    taskId: "must-not-auto-retry",
  });
  assert.equal(back.overview.status, OVERVIEW_STATUSES.ERROR);

  const retrying = reduceSidepanelState(back, {
    type: EVENTS.USER_REGENERATE_OVERVIEW,
    taskId: "overview-retry",
  });
  assert.equal(retrying.overview.status, OVERVIEW_STATUSES.GENERATING);
});

test("tab snapshots retain only serializable view state", () => {
  const state = reduceSidepanelState(bind(), {
    type: EVENTS.TAB_STATE_SAVED,
    tab: "transcript",
    snapshot: {
      scrollTop: 333.5,
      filter: "manual",
      selection: ["a", 2, {}, () => {}],
      expanded: ["x", null],
      follow: { mode: "paused", anchorTime: 201 },
      callback() {},
    },
  });
  assert.deepEqual(state.tabs.transcript, {
    scrollTop: 333.5,
    filter: "manual",
    selection: ["a", 2],
    expanded: ["x"],
    follow: { mode: "paused", anchorTime: 201 },
  });
});

test("pure dispatch produces a local pending view instruction inside the 100ms contract", () => {
  const state = firstUnknown();
  const started = performance.now();
  const pending = reduceSidepanelState(state, {
    type: EVENTS.USER_RETRY_FREE,
    taskId: "performance-retry",
  });
  const view = deriveView(pending);
  const elapsed = performance.now() - started;

  assert.equal(pending.transcript.status, TRANSCRIPT_STATUSES.RETRYING_FREE);
  assert.equal(view.transcript.component.kind, COMPONENT_KINDS.PROGRESS);
  assert.ok(elapsed < TIMING.DISPATCH_FEEDBACK_BUDGET_MS, `${elapsed}ms`);
});
