const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { documentFor, read, settle } = require("./helpers/thought-layer-harness.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ reply, status = "needs_cc", cache = {} } = {}) {
  const document = documentFor(read("sidepanel.html"));
  document.createTextNode = (text) => {
    const wrapper = document.createElement("span");
    wrapper.textContent = text;
    return wrapper.firstChild;
  };
  const transcriptParent = document.getElementById("transcriptList").parentElement;
  transcriptParent.insertBefore = function (node, reference) {
    node.remove();
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    node.parentElement = this;
  };
  const messages = [];
  const errors = [];
  const stored = { ...cache };
  const messageListeners = [];
  const ignored = { addListener() {} };
  const fence = { runtimeInstanceId: "worker-recovery", dataGeneration: 0 };
  const sandbox = {
    console: { log() {}, warn(...args) { errors.push(args); }, error(...args) { errors.push(args); } },
    URL, TextEncoder, TextDecoder,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document,
    window: { getSelection: () => null, close() {}, matchMedia: () => ({ matches: true }) },
    IntersectionObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (value) => value },
    chrome: {
      runtime: {
        id: "test",
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        getURL: (path) => `chrome-extension://test/${path}`,
        async sendMessage(message) {
          messages.push(message);
          if (message.action === "readYoutubePassiveTranscript") {
            return reply ? reply(message) : success(message);
          }
          if (message.action === "getNotes") return { success: true, notes: [] };
          if (message.action === "readNoteSource") return { success: true, source: null, ...fence };
          if (message.action === "removeNoteSources") return { success: true, ...fence };
          if (message.action === "persistResetFencedCache") {
            stored[message.key] = message.record;
            return { success: true, ...fence };
          }
          throw new Error(`Unexpected action: ${message.action}`);
        },
      },
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: { onUpdated: ignored, onActivated: ignored, onRemoved: ignored },
      storage: { local: {
        get: async (key) => typeof key === "string" ? {[key]:stored[key]} : {...stored},
        set: async () => {}, remove: async () => {},
      } },
    },
    YTD_SETTINGS: require("../settings.js"),
    BILIBILI_ADAPTER: require("../bilibili.js"),
    YTD_NOTE_EXPORT: require("../note-export.js"),
    YTD_NOTE_SOURCES: require("../note-sources.js"),
  };
  const context = vm.createContext(sandbox);
  const run = (source) => vm.runInContext(source, context);
  for (const file of ["sidepanel-state.js", "sidepanel-effects.js", "sidepanel.js"]) run(read(file));
  run(`const originalDigestLoad = runDigestLoad;
    runDigestLoad = async (...args) => {
      try { return await originalDigestLoad(...args); }
      catch (error) { console.error(error.stack); throw error; }
    };`);
  run(`
    currentVideoId = 'video_00001'; currentRouteKey = 'youtube:video_00001';
    currentMediaRef = {platform:'youtube', videoId:currentVideoId, mediaKey:currentVideoId};
    videoTabId = 7; digestGeneration = 1;
    extensionDataRuntimeInstanceId = 'worker-recovery';
    currentConfigStatus = {hasAiKey:true}; currentVideoSourceLanguage = 'en';
    sidepanelMvpBindSession(currentVideoId, currentRouteKey);
    sidepanelMvpState = {...sidepanelMvpState, transcript:{...sidepanelMvpState.transcript,
      status:${JSON.stringify(status)}, retryUsed:${status !== "needs_cc"}}};
    renderSidepanelMvpTranscriptState();
  `);
  function success(message) {
    return {
      ...fence, runId: message.runId, routeKey: message.routeKey,
      success: true, routeOutcome: "HAVE_TRANSCRIPT", source: "youtube-passive",
      language: "en", selectedTrack: { language: "en", kind: "asr" },
      transcript: [{ start: 0, duration: 2, text: "A late English caption", language: "en" }],
      transcriptText: "A late English caption", transcriptTextTimestamped: "[0:00] A late English caption",
    };
  }
  const notification = {
    action: "youtubePassiveTranscriptAvailable", tabId: 7, videoId: "video_00001",
    language: "en", trackKind: "asr", captureRevision: 1, ...fence,
  };
  async function notify(overrides = {}, sender = { id: "test" }) {
    for (const listener of messageListeners) listener({ ...notification, ...overrides }, sender, () => {});
    await settle();
    await run("youtubePassiveRecoveryFlight");
  }
  return { run, notify, messages, errors, stored, document, success, notification };
}

for (const status of ["needs_cc", "needs_supadata_choice", "needs_supadata_config", "fallback_declined"]) {
  test(`late captured English captions recover ${status} without reopening or provider calls`, async () => {
    const h = harness({ status });
    await h.notify();
    assert.equal(h.run("sidepanelMvpState.transcript.status"), "ready", JSON.stringify({ messages: h.messages, errors: h.errors }));
    assert.match(h.document.getElementById("transcriptList").textContent, /A late English caption/);
    assert.equal(h.document.getElementById("transcriptStateRegion").hidden, true);
    assert.equal(h.stored.digest_video_00001.transcript[0].text, "A late English caption");
    assert.equal(h.messages.filter((m) => m.action === "readYoutubePassiveTranscript").length, 1);
    assert.equal(h.messages.some((m) => /fetchTranscript|translate|analyze/i.test(m.action)), false);
    assert.deepEqual(h.errors, []);
    await h.notify();
    assert.equal(h.messages.filter((m) => m.action === "readYoutubePassiveTranscript").length, 1);
  });
}

test("a notification arriving while the original task is loading recovers immediately", async () => {
  const h = harness({ status: "loading" });
  await h.notify();
  assert.equal(h.run("sidepanelMvpState.transcript.status"), "ready");
  assert.equal(h.messages.filter((m) => m.action === "readYoutubePassiveTranscript").length, 1);
  assert.match(h.document.getElementById("transcriptList").textContent, /A late English caption/);
});

test("missing or evicted Passive data preserves the existing Supadata choice", async () => {
  const h = harness({ status: "needs_supadata_choice", reply: async () => ({ success: false }) });
  const previous = h.run("sidepanelMvpState.transcript");
  await h.notify();
  assert.equal(h.run("sidepanelMvpState.transcript"), previous);
  assert.equal(h.messages.length, 1);
});

test("duplicate notifications are coalesced and stale results cannot overwrite navigation", async () => {
  const gate = deferred();
  let request;
  const h = harness({ reply: (message) => { request = message; return gate.promise; } });
  const first = h.notify();
  const second = h.notify();
  await settle();
  assert.equal(h.messages.length, 1);
  h.run(`currentVideoId = 'video_00002'; currentRouteKey = 'youtube:video_00002'; digestGeneration += 1;
    sidepanelMvpBindSession(currentVideoId, currentRouteKey);`);
  gate.resolve(h.success(request));
  await Promise.all([first, second]);
  assert.equal(h.run("currentTranscript"), null);
  assert.equal(h.run("sidepanelMvpState.session.videoId"), "video_00002");
});

test("the same revision on a second caption track is not discarded as a duplicate", async () => {
  let reads = 0;
  let h;
  h = harness({
    status: "needs_supadata_choice",
    reply: (message) => {
      reads += 1;
      if (reads === 1) return { success: false };
      return {
        ...h.success(message),
        language: "zh-TW",
        selectedTrack: { language: "zh-TW", kind: "manual" },
        transcript: [
          {
            start: 0,
            duration: 2,
            text: "真正可用的中文字幕",
            language: "zh-TW",
          },
        ],
        transcriptText: "真正可用的中文字幕",
        transcriptTextTimestamped: "[0:00] 真正可用的中文字幕",
      };
    },
  });

  await h.notify({ language: "en", trackKind: "asr", captureRevision: 1 });
  assert.equal(h.run("sidepanelMvpState.transcript.status"), "needs_supadata_choice");

  await h.notify({
    language: "zh-TW",
    trackKind: "manual",
    captureRevision: 1,
  });

  assert.equal(h.messages.filter((m) => m.action === "readYoutubePassiveTranscript").length, 2);
  assert.equal(h.run("sidepanelMvpState.transcript.status"), "ready");
  assert.match(
    h.document.getElementById("transcriptList").textContent,
    /真正可用的中文字幕/,
  );
});

test("reset or a user action during recovery invalidates the result", async () => {
  for (const change of [
    "applyExtensionDataResetFence('worker-recovery', 1)",
    "sidepanelMvpHandleAction(SIDEPANEL_STATE_API.EVENTS.USER_DECLINE)",
  ]) {
    const gate = deferred();
    let request;
    const h = harness({ status: "needs_supadata_choice", reply: (message) => { request = message; return gate.promise; } });
    const done = h.notify();
    await settle();
    await h.run(change);
    gate.resolve(h.success(request));
    await done;
    assert.equal(h.run("currentTranscript"), null);
  }
});

test("notifications from other pages/workers or protected states cause no reads", async () => {
  for (const overrides of [{ tabId: 99 }, { videoId: "video_00002" }, { runtimeInstanceId: "old-worker" }, { dataGeneration: 2 }]) {
    const h = harness();
    await h.notify(overrides);
    assert.equal(h.messages.length, 0);
  }
  for (const sender of [{ id: "other" }, { id: "test", tab: { id: 7 } }]) {
    const h = harness();
    await h.notify({}, sender);
    assert.equal(h.messages.length, 0);
  }
  for (const status of ["terminal", "error", "fetching_supadata"]) {
    const h = harness({ status });
    await h.notify();
    assert.equal(h.messages.length, 0);
  }
});

test("a later Passive chunk expands an already visible incomplete transcript", async () => {
  let h;
  h = harness({
    status: "ready",
    reply: (message) => ({
      ...h.success(message),
      transcript: [
        { start: 0, duration: 2, text: "Opening caption", language: "en" },
        { start: 55, duration: 2, text: "A late English caption", language: "en" },
      ],
      transcriptText: "Opening caption A late English caption",
      transcriptTextTimestamped:
        "[0:00] Opening caption\n[0:55] A late English caption",
    }),
  });
  h.run(`
    currentTranscript = [{ start: 55, duration: 2, text: 'A late English caption', language: 'en' }];
    currentTranscriptText = 'A late English caption';
    currentTranscriptTimestamped = '[0:55] A late English caption';
    currentTranscriptLanguage = 'en';
    currentTranscriptSource = 'youtube-passive';
    currentTranscriptSelectedTrack = { language: 'en', kind: 'asr' };
  `);

  await h.notify();

  assert.equal(h.run("currentTranscript.length"), 2);
  assert.equal(h.run("currentTranscript[0].start"), 0);
  assert.match(h.document.getElementById("transcriptList").textContent, /Opening caption/);
  assert.equal(h.stored.digest_video_00001.transcript.length, 2);
});

test("a later Passive revision completes truncated text at the same timestamp", async () => {
  let h;
  h = harness({
    status: "ready",
    reply: (message) => ({
      ...h.success(message),
      transcript: [
        {
          start: 55,
          duration: 2,
          text: "A late English caption is now complete",
          language: "en",
        },
      ],
      transcriptText: "A late English caption is now complete",
      transcriptTextTimestamped:
        "[0:55] A late English caption is now complete",
    }),
  });
  h.run(`
    currentTranscript = [{ start: 55, duration: 2, text: 'A late English caption', language: 'en' }];
    currentTranscriptText = 'A late English caption';
    currentTranscriptTimestamped = '[0:55] A late English caption';
    currentTranscriptLanguage = 'en';
    currentTranscriptSource = 'youtube-passive';
    currentTranscriptSelectedTrack = { language: 'en', kind: 'asr' };
  `);

  await h.notify();

  assert.equal(
    h.run("currentTranscript[0].text"),
    "A late English caption is now complete",
  );
  assert.match(
    h.document.getElementById("transcriptList").textContent,
    /now complete/,
  );
});

test("automatic recovery never spends AI credits for an already selected translated view", async () => {
  const h = harness();
  h.run(`currentTranscriptMode = 'zh'; sidepanelMvpDispatch({type:SIDEPANEL_STATE_API.EVENTS.USER_SELECT_TAB, tab:'overview'});`);
  await h.notify();
  assert.equal(h.run("sidepanelMvpState.transcript.status"), "ready");
  assert.equal(h.messages.some((m) => /fetchTranscript|translate|analyze/i.test(m.action)), false);
  assert.deepEqual(h.errors, []);
});

test("a response from a stale worker, another request, or another provider is discarded", async () => {
  for (const change of [
    { runtimeInstanceId: "restarted-worker" }, { dataGeneration: 2 },
    { runId: "older-run" }, { routeKey: "youtube:video_00002" }, { source: "supadata" },
  ]) {
    const h = harness({ reply: (message) => ({ ...h.success(message), ...change }) });
    await h.notify();
    assert.equal(h.run("sidepanelMvpState.transcript.status"), "needs_cc");
    assert.equal(h.run("currentTranscript"), null);
    assert.equal(h.messages.length, 1);
  }
});

test("the complete long transcript renders, persists and reopens from cache without requests", async () => {
  const fixture=require("./helpers/long-youtube-transcript.js")();
  const active=require("../youtube-transcript-active.js");
  let requests=0;
  const parsed=await active.run({videoId:"video_00001",language:"en",trackKind:"asr"},{
    fetchImpl:async()=>new Response(++requests===1?JSON.stringify({playabilityStatus:{status:"OK"},
      captions:{playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:"en",kind:"asr",
        baseUrl:"https://www.youtube.com/api/timedtext?v=video_00001&lang=en&kind=asr"}]}}}):fixture.body),
  });
  assert.equal(parsed.status,"HAVE_TRANSCRIPT");
  const h=harness({reply:(message)=>({...h.success(message),transcript:parsed.transcript,
    transcriptText:parsed.text,transcriptTextTimestamped:parsed.timestamped})});
  await h.notify();
  assert.equal(h.run("sidepanelMvpState.transcript.status"),"ready");
  assert.match(h.document.getElementById("transcriptList").textContent,/LAST-16199-9/);
  assert.equal(h.stored.digest_video_00001.transcript.length,fixture.cueCount);
  assert.match(h.stored.digest_video_00001.transcriptTimestamped,/LAST-16199-9/);
  assert.deepEqual(h.errors,[]);
  const reopened=harness({status:"loading",cache:h.stored});
  await reopened.run(`runDigestLoad(currentVideoId,digestGeneration,true,currentMediaRef,currentRouteKey,false,false,
    {mvpTask:sidepanelMvpState.transcript.activeTask,videoTabId,translateMissingNotes:false})`);
  await settle();
  assert.equal(reopened.run("sidepanelMvpState.transcript.status"),"ready");
  assert.match(reopened.document.getElementById("transcriptList").textContent,/LAST-16199-9/);
  assert.equal(reopened.messages.some((m)=>/fetchTranscript|readYoutubePassiveTranscript|translate|analyze/i.test(m.action)),false);
  assert.deepEqual(reopened.errors,[]);
});
