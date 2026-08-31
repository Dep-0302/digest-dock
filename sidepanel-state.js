(function attachDigestDockSidepanelState(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DIGESTDOCK_SIDEPANEL_STATE = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const SCHEMA_VERSION = 1;

  const EVENTS = Object.freeze({
    SESSION_BIND: "SESSION_BIND",
    SESSION_UNSUPPORTED: "SESSION_UNSUPPORTED",
    PAGE_EPOCH_CHANGED: "PAGE_EPOCH_CHANGED",
    TRANSCRIPT_RESULT: "TRANSCRIPT_RESULT",
    USER_RETRY_FREE: "USER_RETRY_FREE",
    USER_CONSENT: "USER_CONSENT",
    SUPADATA_REQUEST_DISPATCHED: "SUPADATA_REQUEST_DISPATCHED",
    USER_DECLINE: "USER_DECLINE",
    USER_RECONSIDER: "USER_RECONSIDER",
    USER_RESTART_FREE: "USER_RESTART_FREE",
    USER_RETURN_TO_CAPTIONS: "USER_RETURN_TO_CAPTIONS",
    KEY_SAVED: "KEY_SAVED",
    USER_BACK_WITHOUT_KEY: "USER_BACK_WITHOUT_KEY",
    USER_RESOLVED: "USER_RESOLVED",
    USER_RECONNECT_CURRENT_VIDEO: "USER_RECONNECT_CURRENT_VIDEO",
    USER_RECOVER_ERROR: "USER_RECOVER_ERROR",
    USER_SELECT_TAB: "USER_SELECT_TAB",
    USER_GENERATE_OVERVIEW: "USER_GENERATE_OVERVIEW",
    USER_REGENERATE_OVERVIEW: "USER_REGENERATE_OVERVIEW",
    OVERVIEW_RESULT: "OVERVIEW_RESULT",
    TAB_STATE_SAVED: "TAB_STATE_SAVED",
    OPEN_SUPADATA_SETTINGS: "OPEN_SUPADATA_SETTINGS",
    USER_RETURN_TO_NOTES: "USER_RETURN_TO_NOTES",
  });

  const TASK_ORIGINS = Object.freeze({
    INITIAL_LOAD: "INITIAL_LOAD",
    PASSIVE: "PASSIVE",
    AUTOMATIC_REFRESH: "AUTOMATIC_REFRESH",
    USER_RETRY_FREE: "USER_RETRY_FREE",
    USER_CONSENT: "USER_CONSENT",
    USER_RESOLVED: "USER_RESOLVED",
    USER_RECONNECT_CURRENT_VIDEO: "USER_RECONNECT_CURRENT_VIDEO",
    USER_RECOVER_ERROR: "USER_RECOVER_ERROR",
    USER_ENTER_READY_TAB: "USER_ENTER_READY_TAB",
    USER_GENERATE: "USER_GENERATE",
    USER_REGENERATE: "USER_REGENERATE",
  });

  const TRANSCRIPT_STATUSES = Object.freeze({
    LOADING: "loading",
    READY: "ready",
    NEEDS_CC: "needs_cc",
    RETRYING_FREE: "retrying_free",
    NEEDS_SUPADATA_CHOICE: "needs_supadata_choice",
    NEEDS_SUPADATA_CONFIG: "needs_supadata_config",
    FETCHING_SUPADATA: "fetching_supadata",
    FALLBACK_DECLINED: "fallback_declined",
    TERMINAL: "terminal",
    ERROR: "error",
  });

  const OVERVIEW_STATUSES = Object.freeze({
    BLOCKED: "blocked",
    IDLE: "idle",
    GENERATING: "generating",
    READY: "ready",
    ERROR: "error",
  });

  const COMPONENT_KINDS = Object.freeze({
    PROGRESS: "Progress",
    ACTION: "Action",
    CONSENT: "Consent",
    TERMINAL: "Terminal",
    ERROR: "Error",
    READY: "Ready",
  });

  const TIMING = Object.freeze({
    CACHE_SKELETON_DELAY_MS: 150,
    SHORT_SUCCESS_FEEDBACK_MS: 1200,
    DISPATCH_FEEDBACK_BUDGET_MS: 100,
    LOCAL_TASK_STATUS_BUDGET_MS: 300,
  });

  const TABS = new Set(["transcript", "overview", "notes"]);
  const OPPORTUNISTIC_ORIGINS = new Set([
    TASK_ORIGINS.PASSIVE,
    TASK_ORIGINS.AUTOMATIC_REFRESH,
  ]);
  const PROMPT_UNKNOWN_CODES = new Set([
    "UNKNOWN",
    "YOUTUBE_CAPTIONS_REQUIRED",
    "YOUTUBE_CAPTIONS_STILL_UNAVAILABLE",
    "SUPADATA_CONSENT_REQUIRED",
    "SUPADATA_NOT_CONFIGURED",
  ]);
  const TECHNICAL_ERROR_CODES = new Set([
    "RATE_LIMITED",
    "TRANSCRIPT_ERROR",
    "PROVIDER_TIMEOUT",
    "RESPONSE_TOO_LARGE",
    "NETWORK_ERROR",
    "PROVIDER_HTTP_ERROR",
    "PROVIDER_FAILED",
    "PROVIDER_ERROR",
    "INVALID_SUPADATA_KEY",
  ]);

  function nonNegativeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
  }

  function normalizeIdentity(value = {}) {
    value = value || {};
    const videoId = String(value.videoId || "").trim();
    const routeKey = String(value.routeKey || "").trim();
    if (!videoId || !routeKey) return null;
    return {
      videoId,
      routeKey,
      generation: nonNegativeInteger(value.generation),
      epoch: nonNegativeInteger(value.epoch),
    };
  }

  function identityKey(value) {
    const identity = normalizeIdentity(value);
    return identity
      ? JSON.stringify([
          identity.videoId,
          identity.routeKey,
          identity.generation,
          identity.epoch,
        ])
      : "";
  }

  function sameIdentity(left, right) {
    const leftKey = identityKey(left);
    return Boolean(leftKey) && leftKey === identityKey(right);
  }

  function identityFromSession(session) {
    return normalizeIdentity(session || {});
  }

  function isYoutubeRoute(routeKey) {
    const value = String(routeKey || "").trim().toLowerCase();
    return value === "youtube" || value.startsWith("youtube:");
  }

  function makeTask(identity, taskId, origin) {
    const normalizedIdentity = normalizeIdentity(identity);
    const id = String(taskId || "").trim();
    const normalizedOrigin = String(origin || "").trim();
    if (!normalizedIdentity || !id || !normalizedOrigin) return null;
    return {
      id,
      origin: normalizedOrigin,
      identity: normalizedIdentity,
    };
  }

  function createTranscriptState(overrides = {}) {
    return {
      status: TRANSCRIPT_STATUSES.LOADING,
      retryUsed: false,
      taskOrigin: TASK_ORIGINS.INITIAL_LOAD,
      activeTask: null,
      consentToken: null,
      consentConsumed: false,
      cooldownUntil: 0,
      reason: null,
      errorKind: null,
      errorSource: null,
      displayMessage: null,
      retainedReady: false,
      payload: null,
      supadataConfigured: null,
      ...overrides,
    };
  }

  function createOverviewState(overrides = {}) {
    return {
      status: OVERVIEW_STATUSES.BLOCKED,
      reason: "no_transcript",
      source: null,
      errorKind: null,
      activeTask: null,
      payload: null,
      readOnly: false,
      ...overrides,
    };
  }

  function createNotesState(overrides = {}) {
    return {
      scope: "current",
      language: "bilingual",
      scrollTop: 0,
      expandedIds: [],
      selectedIds: [],
      writesDisabled: true,
      task: { status: "idle", kind: null },
      ...overrides,
    };
  }

  function createFollowState(overrides = {}) {
    return {
      mode: "following",
      anchorTime: 0,
      programmaticToken: null,
      scrollTop: 0,
      currentCueTime: 0,
      ...overrides,
    };
  }

  function createTabSnapshots() {
    return {
      transcript: { scrollTop: 0 },
      overview: { scrollTop: 0 },
      notes: { scrollTop: 0 },
    };
  }

  function createInitialState(options = {}) {
    const identity = normalizeIdentity(options);
    const taskOrigin = String(
      options.taskOrigin || TASK_ORIGINS.INITIAL_LOAD,
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      session: {
        status: identity ? "ready" : "resolving",
        videoId: identity?.videoId || null,
        routeKey: identity?.routeKey || null,
        generation: identity?.generation || 0,
        epoch: identity?.epoch || 0,
        readOnly: false,
      },
      activeTab: TABS.has(options.activeTab)
        ? options.activeTab
        : "transcript",
      tabs: createTabSnapshots(),
      transcript: createTranscriptState({
        taskOrigin,
        activeTask: makeTask(identity, options.taskId, taskOrigin),
      }),
      overview: createOverviewState(),
      notes: createNotesState({ language: options.notesLanguage || "bilingual" }),
      follow: createFollowState(),
    };
  }

  function transcriptLoadingState(previous, identity, options = {}) {
    const retainedReady = options.retainReady === true;
    const taskOrigin = String(
      options.taskOrigin || TASK_ORIGINS.INITIAL_LOAD,
    );
    return createTranscriptState({
      status: TRANSCRIPT_STATUSES.LOADING,
      taskOrigin,
      activeTask: makeTask(identity, options.taskId, taskOrigin),
      retainedReady,
      payload: retainedReady ? previous?.payload || null : null,
    });
  }

  function interactiveTranscriptState(status, previous, overrides = {}) {
    return createTranscriptState({
      status,
      retryUsed: previous?.retryUsed === true,
      payload: previous?.payload || null,
      retainedReady: previous?.retainedReady === true,
      supadataConfigured: previous?.supadataConfigured ?? null,
      ...overrides,
    });
  }

  function eventIdentity(event) {
    return normalizeIdentity(event?.identity || event || {});
  }

  function eventMatchesSession(state, event) {
    return sameIdentity(identityFromSession(state.session), eventIdentity(event));
  }

  function isOpportunisticOrigin(origin) {
    return OPPORTUNISTIC_ORIGINS.has(String(origin || ""));
  }

  function transcriptResultIsCurrent(state, event) {
    if (!eventMatchesSession(state, event)) return false;
    if (isOpportunisticOrigin(event.taskOrigin)) return true;
    const activeTask = state.transcript.activeTask;
    if (!activeTask || String(event.taskId || "") !== activeTask.id) return false;
    if (!sameIdentity(activeTask.identity, eventIdentity(event))) return false;
    return (
      !event.taskOrigin || String(event.taskOrigin) === activeTask.origin
    );
  }

  function resultCode(result) {
    return String(
      result?.error || result?.errorCode || result?.code || "",
    )
      .trim()
      .toUpperCase();
  }

  function routeOutcome(result) {
    return String(result?.routeOutcome || result?.status || "")
      .trim()
      .toUpperCase();
  }

  function terminalReason(result) {
    const outcome = routeOutcome(result);
    const code = resultCode(result);
    if (outcome === "PAGE_CONTEXT_CHANGED" || code === "PAGE_CONTEXT_CHANGED") {
      return "page_context_changed";
    }
    if (
      code === "LOGIN_REQUIRED" ||
      code === "AGE_CHECK_REQUIRED" ||
      code === "AGE_VERIFICATION_REQUIRED" ||
      code === "CONTENT_CHECK_REQUIRED" ||
      code === "MEMBERS_ONLY" ||
      code === "REGION_BLOCKED"
    ) {
      return "login_required";
    }
    if (
      code === "VIDEO_UNAVAILABLE" ||
      code === "UNPLAYABLE" ||
      code === "LIVE_STREAM_OFFLINE"
    ) {
      return "video_unavailable";
    }
    if (code === "NO_TRANSCRIPT") return "no_transcript";
    if (
      outcome === "CONFIRMED_UNAVAILABLE" ||
      code === "CONFIRMED_UNAVAILABLE" ||
      code === "TRACK_UNAVAILABLE"
    ) {
      return "confirmed_unavailable";
    }
    return null;
  }

  function adaptTranscriptOutcome(result = {}, context = {}) {
    const outcome = routeOutcome(result);
    const code = resultCode(result);
    const sourceState = String(context.sourceState || "");

    const reason = terminalReason(result);
    if (reason) {
      const message = String(result?.message || "").trim();
      return {
        type: "terminal",
        reason,
        ...(message ? { message } : {}),
      };
    }

    if (result.success === true || outcome === "HAVE_TRANSCRIPT") {
      return { type: "ready", payload: result };
    }

    if (
      code === "SUPADATA_NOT_CONFIGURED" &&
      sourceState === TRANSCRIPT_STATUSES.FETCHING_SUPADATA
    ) {
      const message = String(result?.message || "").trim();
      return {
        type: "needs_supadata_config",
        ...(message ? { message } : {}),
      };
    }

    if (code === "RATE_LIMITED") {
      if (sourceState === TRANSCRIPT_STATUSES.FETCHING_SUPADATA) {
        const message = String(result?.message || "").trim();
        return {
          type: "rate_limited",
          cooldownUntil: nonNegativeInteger(
            result.cooldownUntil || context.cooldownUntil,
          ),
          ...(message ? { message } : {}),
        };
      }
      const message = String(result?.message || "").trim();
      return {
        type: "error",
        kind: "rate_limited",
        source: sourceState,
        ...(message ? { message } : {}),
      };
    }

    if (TECHNICAL_ERROR_CODES.has(code)) {
      const message = String(result?.message || "").trim();
      return {
        type: "error",
        kind: code.toLowerCase(),
        source: sourceState,
        ...(message ? { message } : {}),
      };
    }

    if (
      outcome === "UNKNOWN" ||
      result.requiresCaptionEnable === true ||
      PROMPT_UNKNOWN_CODES.has(code)
    ) {
      return { type: "unknown" };
    }

    return { type: "terminal", reason: "unknown_reason" };
  }

  function terminalTranscript(previous, reason, message = null) {
    return interactiveTranscriptState(TRANSCRIPT_STATUSES.TERMINAL, previous, {
      retryUsed: false,
      taskOrigin: null,
      activeTask: null,
      consentToken: null,
      consentConsumed: false,
      cooldownUntil: 0,
      reason: reason || "unknown_reason",
      errorKind: null,
      errorSource: null,
      displayMessage: message,
      retainedReady: false,
    });
  }

  function errorTranscript(previous, normalized) {
    const source = normalized.source || previous.status || "loading";
    return interactiveTranscriptState(TRANSCRIPT_STATUSES.ERROR, previous, {
      retryUsed:
        source === TRANSCRIPT_STATUSES.FETCHING_SUPADATA &&
        previous.retryUsed === true,
      taskOrigin: null,
      activeTask: null,
      consentToken: null,
      consentConsumed: false,
      cooldownUntil: 0,
      reason: null,
      errorKind: normalized.kind || "unknown_error",
      errorSource: source,
      displayMessage: normalized.message || null,
      retainedReady: false,
    });
  }

  function applyTranscriptReady(state, normalized) {
    const overview =
      state.overview.status === OVERVIEW_STATUSES.BLOCKED
        ? createOverviewState({
            status: OVERVIEW_STATUSES.IDLE,
            reason: null,
          })
        : { ...state.overview, readOnly: false };
    return {
      ...state,
      session: { ...state.session, readOnly: false },
      transcript: createTranscriptState({
        status: TRANSCRIPT_STATUSES.READY,
        taskOrigin: null,
        payload: normalized.payload || null,
      }),
      overview,
      notes: { ...state.notes, writesDisabled: false },
    };
  }

  function applyTranscriptTerminal(state, reason, message = null) {
    return {
      ...state,
      transcript: terminalTranscript(state.transcript, reason, message),
      overview: createOverviewState(),
      notes: { ...state.notes, writesDisabled: true },
    };
  }

  function applyTranscriptError(state, normalized) {
    return {
      ...state,
      transcript: errorTranscript(state.transcript, normalized),
      overview: createOverviewState(),
      notes: { ...state.notes, writesDisabled: true },
    };
  }

  function applyTranscriptUnknown(state, event) {
    const transcript = state.transcript;
    if (!isYoutubeRoute(state.session.routeKey)) {
      return applyTranscriptTerminal(state, "unknown_reason");
    }

    if (transcript.status === TRANSCRIPT_STATUSES.FETCHING_SUPADATA) {
      return applyTranscriptError(state, {
        kind: "provider_unknown",
        source: TRANSCRIPT_STATUSES.FETCHING_SUPADATA,
      });
    }

    const unlocksSupadata =
      transcript.status === TRANSCRIPT_STATUSES.RETRYING_FREE &&
      transcript.retryUsed === true &&
      event.taskOrigin === TASK_ORIGINS.USER_RETRY_FREE &&
      transcript.activeTask?.origin === TASK_ORIGINS.USER_RETRY_FREE &&
      transcript.activeTask?.id === String(event.taskId || "");

    if (unlocksSupadata) {
      const hasKey = event.result?.hasSupadataKey;
      return {
        ...state,
        transcript: interactiveTranscriptState(
          TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
          transcript,
          {
            retryUsed: true,
            taskOrigin: null,
            activeTask: null,
            consentToken: null,
            consentConsumed: false,
            cooldownUntil: 0,
            supadataConfigured:
              hasKey === true ? true : hasKey === false ? false : null,
          },
        ),
      };
    }

    return {
      ...state,
      transcript: interactiveTranscriptState(
        TRANSCRIPT_STATUSES.NEEDS_CC,
        transcript,
        {
          retryUsed: false,
          taskOrigin: null,
          activeTask: null,
          consentToken: null,
          consentConsumed: false,
          cooldownUntil: 0,
        },
      ),
      overview: createOverviewState(),
      notes: { ...state.notes, writesDisabled: true },
    };
  }

  function reduceTranscriptResult(state, event) {
    if (!transcriptResultIsCurrent(state, event)) return state;
    if (state.transcript.status === TRANSCRIPT_STATUSES.READY) return state;

    const normalized = adaptTranscriptOutcome(event.result, {
      routeKey: state.session.routeKey,
      sourceState: state.transcript.status,
      taskOrigin: event.taskOrigin,
      cooldownUntil: event.cooldownUntil,
    });

    if (isOpportunisticOrigin(event.taskOrigin)) {
      if (normalized.type === "ready") {
        return applyTranscriptReady(state, normalized);
      }
      if (normalized.type === "terminal") {
        return applyTranscriptTerminal(
          state,
          normalized.reason,
          normalized.message,
        );
      }
      return state;
    }

    if (normalized.type === "ready") {
      return applyTranscriptReady(state, normalized);
    }
    if (normalized.type === "terminal") {
      return applyTranscriptTerminal(
        state,
        normalized.reason,
        normalized.message,
      );
    }
    if (normalized.type === "error") {
      return applyTranscriptError(state, normalized);
    }
    if (normalized.type === "needs_supadata_config") {
      if (
        state.transcript.status !== TRANSCRIPT_STATUSES.FETCHING_SUPADATA ||
        state.transcript.consentConsumed !== true
      ) {
        return applyTranscriptTerminal(state, "unknown_reason");
      }
      return {
        ...state,
        transcript: interactiveTranscriptState(
          TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG,
          state.transcript,
          {
            retryUsed: true,
            taskOrigin: null,
            activeTask: null,
            consentToken: null,
            consentConsumed: false,
            supadataConfigured: false,
            displayMessage: normalized.message,
          },
        ),
      };
    }
    if (normalized.type === "rate_limited") {
      if (state.transcript.status !== TRANSCRIPT_STATUSES.FETCHING_SUPADATA) {
        return applyTranscriptError(state, {
          kind: "rate_limited",
          source: state.transcript.status,
        });
      }
      return {
        ...state,
        transcript: interactiveTranscriptState(
          TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
          state.transcript,
          {
            retryUsed: true,
            taskOrigin: null,
            activeTask: null,
            consentToken: null,
            consentConsumed: false,
            cooldownUntil: normalized.cooldownUntil,
            displayMessage: normalized.message,
          },
        ),
      };
    }
    return applyTranscriptUnknown(state, event);
  }

  function bindSession(state, event) {
    const videoId = String(event.videoId || "").trim();
    const routeKey = String(event.routeKey || "").trim();
    if (!videoId || !routeKey) return state;

    const identityChanged =
      state.session.videoId !== videoId || state.session.routeKey !== routeKey;
    const forceGeneration = event.forceGeneration === true;
    if (!identityChanged && !forceGeneration) {
      const nextEpoch = nonNegativeInteger(event.epoch, state.session.epoch);
      if (nextEpoch > state.session.epoch) {
        return changePageEpoch(state, { ...event, epoch: nextEpoch });
      }
      return state;
    }

    return createInitialState({
      videoId,
      routeKey,
      generation: state.session.generation + 1,
      epoch: nonNegativeInteger(event.epoch),
      taskId: event.taskId,
      taskOrigin: event.taskOrigin || TASK_ORIGINS.INITIAL_LOAD,
    });
  }

  function changePageEpoch(state, event) {
    if (
      state.session.videoId !== String(event.videoId || state.session.videoId) ||
      state.session.routeKey !== String(event.routeKey || state.session.routeKey)
    ) {
      return state;
    }
    const nextEpoch = nonNegativeInteger(event.epoch, state.session.epoch + 1);
    if (nextEpoch <= state.session.epoch) return state;
    const identity = normalizeIdentity({
      ...state.session,
      epoch: nextEpoch,
    });
    const retainReady = state.transcript.status === TRANSCRIPT_STATUSES.READY;
    const keepOverview =
      retainReady && state.overview.status === OVERVIEW_STATUSES.READY;
    return {
      ...state,
      session: {
        ...state.session,
        status: "ready",
        epoch: nextEpoch,
        readOnly: retainReady,
      },
      transcript: transcriptLoadingState(state.transcript, identity, {
        retainReady,
        taskId: event.taskId,
        taskOrigin:
          event.taskOrigin || TASK_ORIGINS.USER_RECONNECT_CURRENT_VIDEO,
      }),
      overview: keepOverview
        ? { ...state.overview, activeTask: null, readOnly: true }
        : createOverviewState(),
      notes: {
        ...state.notes,
        writesDisabled: true,
        task: { status: "idle", kind: null },
      },
    };
  }

  function transcriptNeedsCc(previous) {
    return interactiveTranscriptState(TRANSCRIPT_STATUSES.NEEDS_CC, previous, {
      retryUsed: false,
      taskOrigin: null,
      activeTask: null,
      consentToken: null,
      consentConsumed: false,
      cooldownUntil: 0,
    });
  }

  function startOverviewTask(state, event, origin) {
    const identity = identityFromSession(state.session);
    const activeTask = makeTask(identity, event.taskId, origin);
    if (!activeTask) return state;
    return {
      ...state,
      overview: createOverviewState({
        status: OVERVIEW_STATUSES.GENERATING,
        reason: null,
        activeTask,
      }),
    };
  }

  function overviewResultIsCurrent(state, event) {
    const task = state.overview.activeTask;
    return Boolean(
      task &&
        eventMatchesSession(state, event) &&
        task.id === String(event.taskId || "") &&
        sameIdentity(task.identity, eventIdentity(event)),
    );
  }

  function sanitizeTabSnapshot(snapshot = {}) {
    const clean = {};
    const scrollTop = Number(snapshot.scrollTop);
    if (Number.isFinite(scrollTop) && scrollTop >= 0) clean.scrollTop = scrollTop;
    if (typeof snapshot.filter === "string") clean.filter = snapshot.filter;
    if (Array.isArray(snapshot.selection)) {
      clean.selection = snapshot.selection.filter(
        (value) => typeof value === "string" || Number.isFinite(value),
      );
    }
    if (Array.isArray(snapshot.expanded)) {
      clean.expanded = snapshot.expanded.filter(
        (value) => typeof value === "string" || Number.isFinite(value),
      );
    }
    if (snapshot.follow && typeof snapshot.follow === "object") {
      clean.follow = {
        mode: snapshot.follow.mode === "paused" ? "paused" : "following",
        anchorTime: Math.max(0, Number(snapshot.follow.anchorTime) || 0),
      };
    }
    return clean;
  }

  function reduceSidepanelState(state, event = {}) {
    const current = state || createInitialState();
    switch (event.type) {
      case EVENTS.SESSION_BIND:
        return bindSession(current, event);

      case EVENTS.SESSION_UNSUPPORTED:
        return {
          ...createInitialState({
            generation: current.session.generation + 1,
          }),
          session: {
            status: "unsupported",
            videoId: null,
            routeKey: null,
            generation: current.session.generation + 1,
            epoch: 0,
            readOnly: false,
          },
        };

      case EVENTS.PAGE_EPOCH_CHANGED:
        return changePageEpoch(current, event);

      case EVENTS.TRANSCRIPT_RESULT:
        return reduceTranscriptResult(current, event);

      case EVENTS.USER_RETRY_FREE: {
        if (
          current.transcript.status !== TRANSCRIPT_STATUSES.NEEDS_CC ||
          !isYoutubeRoute(current.session.routeKey)
        ) {
          return current;
        }
        const identity = identityFromSession(current.session);
        const activeTask = makeTask(
          identity,
          event.taskId,
          TASK_ORIGINS.USER_RETRY_FREE,
        );
        if (!activeTask) return current;
        return {
          ...current,
          transcript: interactiveTranscriptState(
            TRANSCRIPT_STATUSES.RETRYING_FREE,
            current.transcript,
            {
              retryUsed: true,
              taskOrigin: TASK_ORIGINS.USER_RETRY_FREE,
              activeTask,
              consentToken: null,
              consentConsumed: false,
            },
          ),
        };
      }

      case EVENTS.USER_CONSENT: {
        if (
          current.transcript.status !==
            TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE ||
          !eventMatchesSession(current, event)
        ) {
          return current;
        }
        const now = nonNegativeInteger(event.now, Date.now());
        if (
          current.transcript.cooldownUntil > 0 &&
          now < current.transcript.cooldownUntil
        ) {
          return current;
        }
        if (event.hasKey !== true) {
          return {
            ...current,
            transcript: interactiveTranscriptState(
              TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG,
              current.transcript,
              {
                retryUsed: true,
                taskOrigin: null,
                activeTask: null,
                consentToken: null,
                consentConsumed: false,
                supadataConfigured: false,
              },
            ),
          };
        }
        const token = String(event.consentToken || "").trim();
        const identity = identityFromSession(current.session);
        const activeTask = makeTask(
          identity,
          event.taskId,
          TASK_ORIGINS.USER_CONSENT,
        );
        if (!token || !activeTask) return current;
        return {
          ...current,
          transcript: interactiveTranscriptState(
            TRANSCRIPT_STATUSES.FETCHING_SUPADATA,
            current.transcript,
            {
              retryUsed: true,
              taskOrigin: TASK_ORIGINS.USER_CONSENT,
              activeTask,
              consentToken: token,
              consentConsumed: false,
              cooldownUntil: 0,
              supadataConfigured: true,
            },
          ),
        };
      }

      case EVENTS.SUPADATA_REQUEST_DISPATCHED: {
        if (
          current.transcript.status !==
            TRANSCRIPT_STATUSES.FETCHING_SUPADATA ||
          !eventMatchesSession(current, event) ||
          current.transcript.activeTask?.id !== String(event.taskId || "") ||
          current.transcript.consentToken !==
            String(event.consentToken || "")
        ) {
          return current;
        }
        return {
          ...current,
          transcript: {
            ...current.transcript,
            consentToken: null,
            consentConsumed: true,
          },
        };
      }

      case EVENTS.USER_DECLINE:
        if (
          current.transcript.status !==
          TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE
        ) {
          return current;
        }
        return {
          ...current,
          transcript: interactiveTranscriptState(
            TRANSCRIPT_STATUSES.FALLBACK_DECLINED,
            current.transcript,
            {
              retryUsed: true,
              taskOrigin: null,
              activeTask: null,
              consentToken: null,
              consentConsumed: false,
            },
          ),
        };

      case EVENTS.USER_RECONSIDER:
        if (
          current.transcript.status !== TRANSCRIPT_STATUSES.FALLBACK_DECLINED
        ) {
          return current;
        }
        return {
          ...current,
          transcript: interactiveTranscriptState(
            TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
            current.transcript,
            {
              retryUsed: true,
              consentToken: null,
              consentConsumed: false,
            },
          ),
        };

      case EVENTS.USER_RESTART_FREE:
      case EVENTS.USER_RETURN_TO_CAPTIONS:
        if (
          ![
            TRANSCRIPT_STATUSES.FALLBACK_DECLINED,
            TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
          ].includes(current.transcript.status)
        ) {
          return current;
        }
        return {
          ...current,
          transcript: transcriptNeedsCc(current.transcript),
        };

      case EVENTS.KEY_SAVED:
        if (
          current.transcript.status !==
          TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG
        ) {
          return current;
        }
        return {
          ...current,
          transcript: interactiveTranscriptState(
            TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
            current.transcript,
            {
              retryUsed: true,
              taskOrigin: null,
              activeTask: null,
              consentToken: null,
              consentConsumed: false,
              supadataConfigured: true,
            },
          ),
        };

      case EVENTS.USER_BACK_WITHOUT_KEY:
        if (
          current.transcript.status !==
          TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG
        ) {
          return current;
        }
        return {
          ...current,
          transcript: interactiveTranscriptState(
            TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
            current.transcript,
            {
              retryUsed: true,
              taskOrigin: null,
              activeTask: null,
              consentToken: null,
              consentConsumed: false,
              supadataConfigured: false,
            },
          ),
        };

      case EVENTS.USER_RESOLVED: {
        if (
          current.transcript.status !== TRANSCRIPT_STATUSES.TERMINAL ||
          current.transcript.reason !== "login_required"
        ) {
          return current;
        }
        const identity = identityFromSession(current.session);
        const nextTranscript = transcriptLoadingState(
          current.transcript,
          identity,
          {
            taskId: event.taskId,
            taskOrigin: TASK_ORIGINS.USER_RESOLVED,
          },
        );
        if (!nextTranscript.activeTask) return current;
        return {
          ...current,
          transcript: nextTranscript,
          overview: createOverviewState(),
        };
      }

      case EVENTS.USER_RECONNECT_CURRENT_VIDEO:
        if (
          current.transcript.status !== TRANSCRIPT_STATUSES.TERMINAL ||
          current.transcript.reason !== "page_context_changed" ||
          !event.taskId
        ) {
          return current;
        }
        return changePageEpoch(current, {
          ...event,
          videoId: current.session.videoId,
          routeKey: current.session.routeKey,
          epoch: Math.max(
            current.session.epoch + 1,
            nonNegativeInteger(event.epoch),
          ),
          taskOrigin: TASK_ORIGINS.USER_RECONNECT_CURRENT_VIDEO,
        });

      case EVENTS.USER_RECOVER_ERROR: {
        if (current.transcript.status !== TRANSCRIPT_STATUSES.ERROR) return current;
        if (
          current.transcript.errorSource ===
          TRANSCRIPT_STATUSES.FETCHING_SUPADATA
        ) {
          return {
            ...current,
            transcript: interactiveTranscriptState(
              TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE,
              current.transcript,
              {
                retryUsed: true,
                taskOrigin: null,
                activeTask: null,
                consentToken: null,
                consentConsumed: false,
              },
            ),
          };
        }
        if (
          current.transcript.errorSource ===
          TRANSCRIPT_STATUSES.RETRYING_FREE
        ) {
          return {
            ...current,
            transcript: transcriptNeedsCc(current.transcript),
          };
        }
        const identity = identityFromSession(current.session);
        const nextTranscript = transcriptLoadingState(
          current.transcript,
          identity,
          {
            taskId: event.taskId,
            taskOrigin: TASK_ORIGINS.USER_RECOVER_ERROR,
          },
        );
        if (!nextTranscript.activeTask) return current;
        return { ...current, transcript: nextTranscript };
      }

      case EVENTS.USER_SELECT_TAB: {
        const tab = String(event.tab || "");
        if (!TABS.has(tab)) return current;
        let next = { ...current, activeTab: tab };
        if (
          tab === "overview" &&
          current.activeTab !== "overview" &&
          current.transcript.status === TRANSCRIPT_STATUSES.READY &&
          current.overview.status === OVERVIEW_STATUSES.IDLE
        ) {
          next = startOverviewTask(
            next,
            event,
            TASK_ORIGINS.USER_ENTER_READY_TAB,
          );
        }
        return next;
      }

      case EVENTS.USER_GENERATE_OVERVIEW:
        if (
          current.transcript.status !== TRANSCRIPT_STATUSES.READY ||
          current.overview.status !== OVERVIEW_STATUSES.IDLE
        ) {
          return current;
        }
        return startOverviewTask(current, event, TASK_ORIGINS.USER_GENERATE);

      case EVENTS.USER_REGENERATE_OVERVIEW:
        if (current.overview.status !== OVERVIEW_STATUSES.ERROR) return current;
        return startOverviewTask(current, event, TASK_ORIGINS.USER_REGENERATE);

      case EVENTS.OVERVIEW_RESULT:
        if (!overviewResultIsCurrent(current, event)) return current;
        if (event.result?.success === true) {
          return {
            ...current,
            overview: createOverviewState({
              status: OVERVIEW_STATUSES.READY,
              reason: null,
              source: event.result.source === "cache" ? "cache" : "fresh",
              payload: event.result,
            }),
          };
        }
        return {
          ...current,
          overview: createOverviewState({
            status: OVERVIEW_STATUSES.ERROR,
            reason: null,
            errorKind: String(event.result?.error || "overview_error"),
          }),
        };

      case EVENTS.TAB_STATE_SAVED: {
        const tab = String(event.tab || "");
        if (!TABS.has(tab)) return current;
        return {
          ...current,
          tabs: {
            ...current.tabs,
            [tab]: {
              ...current.tabs[tab],
              ...sanitizeTabSnapshot(event.snapshot),
            },
          },
        };
      }

      default:
        return current;
    }
  }

  function action(id, label, kind, event) {
    return { id, label, kind, event };
  }

  function deriveTranscriptActions(state, options = {}) {
    const transcript = state.transcript;
    const actions = [];
    const now = nonNegativeInteger(options.now, Date.now());

    if (transcript.status === TRANSCRIPT_STATUSES.NEEDS_CC) {
      actions.push(
        action(
          "retry-free",
          "已看到字幕，重新读取",
          "primary",
          { type: EVENTS.USER_RETRY_FREE },
        ),
      );
    } else if (
      transcript.status === TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE
    ) {
      const coolingDown =
        transcript.cooldownUntil > 0 && now < transcript.cooldownUntil;
      actions.push(
        action(
          "use-supadata",
          "本次使用 Supadata",
          "primary",
          { type: EVENTS.USER_CONSENT },
        ),
        action("decline-supadata", "暂不使用", "secondary", {
          type: EVENTS.USER_DECLINE,
        }),
      );
      if (coolingDown) {
        actions.push(
          action("return-to-captions", "返回字幕提示", "secondary", {
            type: EVENTS.USER_RETURN_TO_CAPTIONS,
          }),
        );
      }
    } else if (
      transcript.status === TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG
    ) {
      actions.push(
        action("manage-supadata", "管理 Supadata 设置", "primary", {
          type: EVENTS.OPEN_SUPADATA_SETTINGS,
        }),
        action("back-without-key", "返回 Supadata 选择", "secondary", {
          type: EVENTS.USER_BACK_WITHOUT_KEY,
        }),
      );
    } else if (
      transcript.status === TRANSCRIPT_STATUSES.FALLBACK_DECLINED
    ) {
      actions.push(
        action("reconsider-supadata", "再次选择 Supadata", "primary", {
          type: EVENTS.USER_RECONSIDER,
        }),
        action("restart-free", "返回字幕提示", "secondary", {
          type: EVENTS.USER_RESTART_FREE,
        }),
      );
    } else if (transcript.status === TRANSCRIPT_STATUSES.TERMINAL) {
      if (transcript.reason === "login_required") {
        actions.push(
          action("resolved-login", "我已完成登录，重新检查", "primary", {
            type: EVENTS.USER_RESOLVED,
          }),
        );
      } else if (transcript.reason === "page_context_changed") {
        actions.push(
          action("reconnect-video", "重新连接当前视频", "primary", {
            type: EVENTS.USER_RECONNECT_CURRENT_VIDEO,
          }),
        );
      }
    } else if (transcript.status === TRANSCRIPT_STATUSES.ERROR) {
      actions.push(
        action(
          "recover-transcript",
          transcript.errorSource === TRANSCRIPT_STATUSES.FETCHING_SUPADATA
            ? "再次选择 Supadata"
            : transcript.errorSource === TRANSCRIPT_STATUSES.RETRYING_FREE
              ? "返回字幕提示"
              : "重新读取字幕",
          "primary",
          { type: EVENTS.USER_RECOVER_ERROR },
        ),
      );
    }

    if (options.canReturnToNotes === true && transcript.status !== "ready") {
      actions.push(
        action("return-to-notes", "返回笔记", "secondary", {
          type: EVENTS.USER_RETURN_TO_NOTES,
        }),
      );
    }
    return actions;
  }

  function terminalCopy(reason) {
    const copy = {
      no_transcript: ["此视频没有字幕", "当前视频已确认没有可用字幕。"],
      confirmed_unavailable: [
        "当前视频无法取得字幕",
        "字幕来源已确认不可用，流程已停止。",
      ],
      login_required: [
        "需要完成登录或访问验证",
        "完成后可重新检查当前视频。",
      ],
      video_unavailable: ["视频当前不可用", "请切换到其他可用视频。"],
      page_context_changed: [
        "页面上下文已变化",
        "请重新连接当前视频后再读取。",
      ],
      unknown_reason: ["当前字幕流程已停止", "请切换视频或等待页面状态变化。"],
    };
    return copy[reason] || copy.unknown_reason;
  }

  function deriveTranscriptComponent(state, options = {}) {
    const transcript = state.transcript;
    const now = nonNegativeInteger(options.now, Date.now());
    switch (transcript.status) {
      case TRANSCRIPT_STATUSES.LOADING:
        return {
          kind: COMPONENT_KINDS.PROGRESS,
          status: transcript.status,
          title: "正在获取字幕",
          message: "正在读取当前视频的字幕状态。",
          retainedReady: transcript.retainedReady === true,
        };
      case TRANSCRIPT_STATUSES.RETRYING_FREE:
        return {
          kind: COMPONENT_KINDS.PROGRESS,
          status: transcript.status,
          title: "正在重新读取字幕",
          message: "只检查当前页面已经加载的免费字幕。",
        };
      case TRANSCRIPT_STATUSES.FETCHING_SUPADATA:
        return {
          kind: COMPONENT_KINDS.PROGRESS,
          status: transcript.status,
          title: "正在通过 Supadata 获取字幕",
          message: "本次请求可能消耗你的 Supadata 额度。",
        };
      case TRANSCRIPT_STATUSES.NEEDS_CC:
        return {
          kind: COMPONENT_KINDS.ACTION,
          status: transcript.status,
          title: "请先打开 YouTube 字幕",
          message: "① 在 YouTube 打开 CC  ② 回到这里重新读取",
        };
      case TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CHOICE:
      {
        const cooldownRemainingMs = Math.max(
          0,
          transcript.cooldownUntil - now,
        );
        return {
          kind: COMPONENT_KINDS.CONSENT,
          status: transcript.status,
          title: "是否为当前视频使用 Supadata？",
          message:
            transcript.displayMessage ||
            "免费重新读取仍未取得字幕。授权仅限当前视频、本次调用，并可能消耗额度。",
          cooldownRemainingMs,
          disabledActionIds:
            cooldownRemainingMs > 0 ? ["use-supadata"] : [],
        };
      }
      case TRANSCRIPT_STATUSES.NEEDS_SUPADATA_CONFIG:
        return {
          kind: COMPONENT_KINDS.CONSENT,
          status: transcript.status,
          title: "需要配置 Supadata",
          message: "保存密钥不会自动调用；返回后仍需重新明确授权。",
        };
      case TRANSCRIPT_STATUSES.FALLBACK_DECLINED:
        return {
          kind: COMPONENT_KINDS.ACTION,
          status: transcript.status,
          title: "已暂不使用 Supadata",
          message: "没有向第三方发送当前视频。",
        };
      case TRANSCRIPT_STATUSES.TERMINAL: {
        const [title, message] = terminalCopy(transcript.reason);
        return {
          kind: COMPONENT_KINDS.TERMINAL,
          status: transcript.status,
          reason: transcript.reason,
          title,
          message: transcript.displayMessage || message,
        };
      }
      case TRANSCRIPT_STATUSES.ERROR:
        return {
          kind: COMPONENT_KINDS.ERROR,
          status: transcript.status,
          errorKind: transcript.errorKind,
          title: "字幕处理失败",
          message:
            transcript.displayMessage ||
            "请使用下方与当前来源对应的恢复动作。",
        };
      case TRANSCRIPT_STATUSES.READY:
        return {
          kind: COMPONENT_KINDS.READY,
          status: transcript.status,
          title: "字幕已就绪",
          message: "",
        };
      default:
        return {
          kind: COMPONENT_KINDS.TERMINAL,
          status: "terminal",
          reason: "unknown_reason",
          title: "当前字幕流程已停止",
          message: "未登记状态已按失败关闭处理。",
        };
    }
  }

  function deriveOverviewActions(state) {
    if (
      state.overview.status === OVERVIEW_STATUSES.IDLE &&
      state.transcript.status === TRANSCRIPT_STATUSES.READY
    ) {
      return [
        action("generate-overview", "生成概览", "primary", {
          type: EVENTS.USER_GENERATE_OVERVIEW,
        }),
      ];
    }
    if (state.overview.status === OVERVIEW_STATUSES.ERROR) {
      return [
        action("regenerate-overview", "重新生成概览", "primary", {
          type: EVENTS.USER_REGENERATE_OVERVIEW,
        }),
      ];
    }
    return [];
  }

  function deriveOverviewComponent(state) {
    const overview = state.overview;
    if (overview.status === OVERVIEW_STATUSES.BLOCKED) {
      return {
        kind: COMPONENT_KINDS.ACTION,
        status: overview.status,
        title: "字幕就绪后可生成概览",
        message: "",
      };
    }
    if (overview.status === OVERVIEW_STATUSES.IDLE) {
      return {
        kind: COMPONENT_KINDS.ACTION,
        status: overview.status,
        title: "可以生成概览",
        message: "点击后才会开始生成。",
      };
    }
    if (overview.status === OVERVIEW_STATUSES.GENERATING) {
      return {
        kind: COMPONENT_KINDS.PROGRESS,
        status: overview.status,
        title: "正在生成概览",
        message: "任务会在概览区域继续。",
      };
    }
    if (overview.status === OVERVIEW_STATUSES.ERROR) {
      return {
        kind: COMPONENT_KINDS.ERROR,
        status: overview.status,
        title: "概览生成失败",
        message: "只有明确点击重新生成才会再次请求。",
      };
    }
    return {
      kind: COMPONENT_KINDS.READY,
      status: overview.status,
      title: "概览已就绪",
      message: "",
      source: overview.source,
      readOnly: overview.readOnly === true,
    };
  }

  function deriveView(state, options = {}) {
    return {
      session: { ...state.session },
      activeTab: state.activeTab,
      transcript: {
        component: deriveTranscriptComponent(state, options),
        actions: deriveTranscriptActions(state, options),
      },
      overview: {
        component: deriveOverviewComponent(state),
        actions: deriveOverviewActions(state),
      },
      notes: {
        writesDisabled: state.notes.writesDisabled === true,
        scope: state.notes.scope,
        language: state.notes.language,
      },
    };
  }

  return Object.freeze({
    SCHEMA_VERSION,
    EVENTS,
    TASK_ORIGINS,
    TRANSCRIPT_STATUSES,
    OVERVIEW_STATUSES,
    COMPONENT_KINDS,
    TIMING,
    normalizeIdentity,
    identityKey,
    sameIdentity,
    isYoutubeRoute,
    createInitialState,
    adaptTranscriptOutcome,
    reduceSidepanelState,
    deriveTranscriptActions,
    deriveTranscriptComponent,
    deriveOverviewActions,
    deriveOverviewComponent,
    deriveView,
  });
});
