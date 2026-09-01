const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelHelpers() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({
        style: {},
        classList: { toggle() {} },
        set textContent(value) {
          this._text = String(value);
        },
        get innerHTML() {
          return this._text || "";
        },
      }),
    },
    chrome: {
      runtime: {
        onMessage: listeners,
        sendMessage: () => Promise.resolve({}),
        getURL: (value) => `chrome-extension://test/${value}`,
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        onRemoved: listeners,
      },
    },
    YTD_SETTINGS: {},
    BILIBILI_ADAPTER: require("../bilibili.js"),
    YTD_NOTE_EXPORT: require("../note-export.js"),
    YTD_NOTE_SOURCES: require("../note-sources.js"),
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read("sidepanel-state.js"), context);
  vm.runInContext(read("sidepanel-effects.js"), context);
  vm.runInContext(read("sidepanel.js"), context);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function youtubeCacheRecord(helpers, source = "youtube-active") {
  const transcriptTimestamped = "[0:00] hello\n[0:02] world";
  const selectedTrack = {
    index: 0,
    language: "en",
    kind: "manual",
    isGenerated: false,
  };
  const transcriptFingerprint = helpers.transcriptContentFingerprint(
    transcriptTimestamped,
  );
  return {
    transcriptSourcePolicyVersion: helpers.TRANSCRIPT_SOURCE_POLICY_VERSION,
    transcript: [
      { start: 0, text: "hello" },
      { start: 2, text: "world" },
    ],
    transcriptText: "hello world",
    transcriptTimestamped,
    transcriptLanguage: "en",
    transcriptSource: source,
    transcriptSelectedTrack: selectedTrack,
    transcriptSelectedTrackIdentity:
      helpers.transcriptSelectedTrackIdentity(selectedTrack),
    transcriptFingerprint,
    transcriptRequestedLanguage: "en-US",
    transcriptRequestedTrackKind: helpers.YOUTUBE_TRANSCRIPT_TRACK_KIND,
    transcriptArtifactIdentity: helpers.transcriptArtifactIdentity({
      source,
      language: "en",
      requestedLanguage: "en-US",
      selectedTrack,
      fingerprint: transcriptFingerprint,
    }),
    mediaRef: {
      platform: "youtube",
      mediaKey: "video-1",
      videoId: "video-1",
    },
    routeKey: "youtube:video-1",
    timestamp: Date.now(),
  };
}

test("YouTube cache policy accepts only the four shortlisted sources", () => {
  const helpers = loadSidepanelHelpers();
  const expected = {
    videoId: "video-1",
    mediaRef: { platform: "youtube", mediaKey: "video-1" },
    requestedLanguage: "en-US",
    trackKind: "manual-first",
    routeKey: "youtube:video-1",
  };

  for (const source of [
    "youtube-passive",
    "youtube-active",
    "youtube-panel",
    "supadata",
  ]) {
    const record = youtubeCacheRecord(helpers, source);
    if (source === "supadata") {
      record.transcriptSelectedTrack = null;
      record.transcriptSelectedTrackIdentity = "none";
      record.transcriptArtifactIdentity = helpers.transcriptArtifactIdentity({
        source,
        language: "en",
        requestedLanguage: "en-US",
        selectedTrack: null,
        fingerprint: record.transcriptFingerprint,
      });
    }
    assert.ok(helpers.validateTranscriptCacheRecord(record, expected), source);
  }

  const panelWithoutKind = youtubeCacheRecord(helpers, "youtube-panel");
  panelWithoutKind.transcriptSelectedTrack = null;
  panelWithoutKind.transcriptSelectedTrackIdentity = "none";
  panelWithoutKind.transcriptArtifactIdentity = helpers.transcriptArtifactIdentity({
    source: "youtube-panel",
    language: "en",
    requestedLanguage: "en-US",
    selectedTrack: null,
    fingerprint: panelWithoutKind.transcriptFingerprint,
  });
  assert.ok(
    helpers.validateTranscriptCacheRecord(panelWithoutKind, expected),
    "Panel may cache verified language/coverage without inventing a track kind",
  );

  assert.equal(
    helpers.validateTranscriptCacheRecord(
      youtubeCacheRecord(helpers, "youtube-unknown"),
      expected,
    ),
    null,
  );
});

test("cache validation rejects language, selected-track, and fingerprint drift", () => {
  const helpers = loadSidepanelHelpers();
  const expected = {
    videoId: "video-1",
    mediaRef: { platform: "youtube", mediaKey: "video-1" },
    requestedLanguage: "en-US",
    trackKind: "manual-first",
    routeKey: "youtube:video-1",
  };

  const languageDrift = youtubeCacheRecord(helpers);
  languageDrift.transcriptRequestedLanguage = "fr";
  assert.equal(
    helpers.validateTranscriptCacheRecord(languageDrift, expected),
    null,
  );

  const languageVariantDrift = youtubeCacheRecord(helpers);
  assert.equal(
    helpers.validateTranscriptCacheRecord(languageVariantDrift, {
      ...expected,
      requestedLanguage: "en-GB",
    }),
    null,
  );

  const trackDrift = youtubeCacheRecord(helpers);
  trackDrift.transcriptSelectedTrack.kind = "asr";
  assert.equal(helpers.validateTranscriptCacheRecord(trackDrift, expected), null);

  const fingerprintDrift = youtubeCacheRecord(helpers);
  fingerprintDrift.transcriptTimestamped += " changed";
  assert.equal(
    helpers.validateTranscriptCacheRecord(fingerprintDrift, expected),
    null,
  );
});

test("Bilibili cache source remains isolated from YouTube source policy", () => {
  const helpers = loadSidepanelHelpers();
  const transcriptTimestamped = "[0:00] 你好";
  const transcriptFingerprint = helpers.transcriptContentFingerprint(
    transcriptTimestamped,
  );
  const record = {
    transcriptSourcePolicyVersion: helpers.TRANSCRIPT_SOURCE_POLICY_VERSION,
    transcript: [{ start: 0, text: "你好" }],
    transcriptText: "你好",
    transcriptTimestamped,
    transcriptLanguage: "zh-CN",
    transcriptSource: "bilibili",
    transcriptSelectedTrack: null,
    transcriptSelectedTrackIdentity: "none",
    transcriptFingerprint,
    transcriptRequestedLanguage: null,
    transcriptRequestedTrackKind: null,
    transcriptArtifactIdentity: helpers.transcriptArtifactIdentity({
      source: "bilibili",
      language: "zh-CN",
      selectedTrack: null,
      fingerprint: transcriptFingerprint,
    }),
    mediaRef: {
      platform: "bilibili",
      mediaKey: "bilibili:BV1x:10",
    },
    routeKey: "bilibili:BV1x:10",
  };
  const expected = {
    videoId: "bilibili:BV1x:10",
    mediaRef: { platform: "bilibili", mediaKey: "bilibili:BV1x:10" },
    routeKey: "bilibili:BV1x:10",
  };
  assert.ok(helpers.validateTranscriptCacheRecord(record, expected));
  const legacyRecord = {
    ...record,
    transcriptSourcePolicyVersion: 4,
  };
  delete legacyRecord.transcriptFingerprint;
  delete legacyRecord.transcriptSelectedTrackIdentity;
  delete legacyRecord.transcriptArtifactIdentity;
  assert.ok(
    helpers.validateTranscriptCacheRecord(legacyRecord, expected),
    "Bilibili v4 cache remains valid across the YouTube policy bump",
  );
  record.transcriptSource = "youtube-active";
  assert.equal(helpers.validateTranscriptCacheRecord(record, expected), null);
});

test("Bilibili v1 overview survives while YouTube v1 overview expires", () => {
  const helpers = loadSidepanelHelpers();
  const transcript = "[0:00] 你好";
  const analysis = {
    schemaVersion: 3,
    baseLanguage: "zh-Hans",
    sourceLanguage: "zh-CN",
    chapters: [
      { timestamp: "0:00", timestampSeconds: 0, titleZh: "标题", summaryZh: "摘要" },
    ],
    keyQuotes: [
      { timestamp: "0:00", timestampSeconds: 0, quoteOriginal: "你好", quoteZh: "你好" },
    ],
  };
  const legacy = {
    schemaVersion: 1,
    mediaKey: "bilibili:BV1x:10",
    transcriptFingerprint: helpers.overviewTranscriptFingerprint(transcript),
    sourceLanguage: "zh-CN",
    analysis,
  };
  assert.equal(
    helpers.validateOverviewCacheRecord(
      legacy,
      "bilibili:BV1x:10",
      transcript,
      "zh-CN",
      "bilibili",
      null,
    ),
    analysis,
  );
  assert.equal(
    helpers.validateOverviewCacheRecord(
      legacy,
      "bilibili:BV1x:10",
      transcript,
      "en",
      "bilibili",
      null,
    ),
    null,
  );
  assert.equal(
    helpers.validateOverviewCacheRecord(
      { ...legacy, mediaKey: "video-1" },
      "video-1",
      transcript,
      "zh-CN",
      "youtube-active",
      { language: "zh-CN", kind: "manual" },
    ),
    null,
  );
});

test("one transcript request carries the current run identity and rejects late results", () => {
  const helpers = loadSidepanelHelpers();
  const request = helpers.buildTranscriptFetchRequest({
    videoId: "video-1",
    mediaRef: { platform: "youtube", videoId: "video-1" },
    preferredLanguage: "en",
    tabId: 7,
    generation: 12,
    routeKey: "youtube:video-1",
  });
  assert.equal(request.action, "fetchTranscript");
  assert.equal(request.trackKind, "manual-first");
  assert.equal(request.runId, "12");
  assert.equal(request.digestGeneration, 12);
  assert.equal(request.routeKey, "youtube:video-1");
  assert.equal(request.supadataConsent, false);
  assert.equal(request.captionRetry, false);

  const retryRequest = helpers.buildTranscriptFetchRequest({
    videoId: "video-1",
    mediaRef: { platform: "youtube", videoId: "video-1" },
    preferredLanguage: "en",
    tabId: 7,
    generation: 12,
    routeKey: "youtube:video-1",
    captionRetry: true,
  });
  assert.equal(retryRequest.captionRetry, true);
  assert.equal(retryRequest.supadataConsent, false);

  assert.equal(
    helpers.transcriptResponseMatchesRequest(
      { runId: "12", routeKey: "youtube:video-1" },
      request,
    ),
    true,
  );
  assert.equal(
    helpers.transcriptResponseMatchesRequest(
      { runId: "11", routeKey: "youtube:video-1" },
      request,
    ),
    false,
  );
  assert.equal(
    helpers.transcriptResponseMatchesRequest(
      { runId: "12", routeKey: "youtube:video-2" },
      request,
    ),
    false,
  );
  assert.equal(
    helpers.transcriptResponseMatchesRequest(
      { success: true },
      request,
      { platform: "bilibili" },
    ),
    true,
  );
});

test("runtime adapter carries one exact task from first UNKNOWN through free retry to consent choice", () => {
  const helpers = loadSidepanelHelpers();
  const firstTask = helpers.sidepanelMvpBindSession(
    "video-1",
    "youtube:video-1",
  );
  assert.ok(firstTask);
  assert.equal(
    helpers.sidepanelMvpResolveTranscript(
      {
        success: false,
        routeOutcome: "UNKNOWN",
        error: "YOUTUBE_CAPTIONS_REQUIRED",
        requiresCaptionEnable: true,
      },
      firstTask,
    ),
    true,
  );
  assert.equal(
    helpers.getSidepanelMvpState().transcript.status,
    "needs_cc",
  );

  const retryTask = helpers.sidepanelMvpBeginEvent(
    "USER_RETRY_FREE",
    "USER_RETRY_FREE",
  );
  assert.ok(retryTask);
  assert.equal(
    helpers.sidepanelMvpResolveTranscript(
      {
        success: false,
        routeOutcome: "UNKNOWN",
        error: "SUPADATA_CONSENT_REQUIRED",
        hasSupadataKey: true,
      },
      retryTask,
    ),
    true,
  );
  const state = helpers.getSidepanelMvpState();
  assert.equal(state.transcript.status, "needs_supadata_choice");
  assert.equal(state.transcript.retryUsed, true);

  assert.equal(
    helpers.sidepanelMvpResolveTranscript(
      { success: true, routeOutcome: "HAVE_TRANSCRIPT" },
      firstTask,
    ),
    false,
    "the replaced task must stay rejected",
  );
});

test("the extension options tab preserves the current side-panel session", () => {
  const helpers = loadSidepanelHelpers();
  assert.equal(
    helpers.isDigestDockOptionsUrl(
      "chrome-extension://test/options.html?focus=supadata#section-transcript",
    ),
    true,
  );
  assert.equal(
    helpers.isDigestDockOptionsUrl("https://example.com/options.html"),
    false,
  );
});

test("Supadata is offered only for the final UNKNOWN outcome", () => {
  const helpers = loadSidepanelHelpers();
  assert.equal(
    helpers.shouldOfferSupadata({ routeOutcome: "UNKNOWN" }),
    true,
  );
  assert.equal(
    helpers.shouldOfferSupadata({
      routeOutcome: "UNKNOWN",
      error: "RATE_LIMITED",
    }),
    true,
  );
  assert.equal(
    helpers.shouldOfferSupadata({
      routeOutcome: "UNKNOWN",
      error: "YOUTUBE_CAPTIONS_REQUIRED",
      requiresCaptionEnable: true,
      supadataEligible: false,
    }),
    false,
  );
  for (const routeOutcome of [
    "HAVE_TRANSCRIPT",
    "CONFIRMED_UNAVAILABLE",
    "PAGE_CONTEXT_CHANGED",
  ]) {
    assert.equal(helpers.shouldOfferSupadata({ routeOutcome }), false);
  }
});

test("Supadata settings stay hidden unless explicitly requested or configured", () => {
  const options = require("../options.js");
  assert.equal(options.supadataOptionsRequested({}), false);
  assert.equal(
    options.supadataOptionsRequested({
      search: "?focus=supadata",
      hash: "#section-transcript",
    }),
    true,
  );

  const section = { hidden: false, dataset: {} };
  assert.equal(
    options.applySupadataSettingsVisibility(section, {
      hasKey: false,
      requested: false,
    }),
    false,
  );
  assert.equal(section.hidden, true);
  assert.equal(
    options.applySupadataSettingsVisibility(section, {
      hasKey: true,
      requested: false,
    }),
    true,
  );
  assert.equal(section.hidden, false);

  const html = read("options.html");
  assert.match(
    html,
    /id="section-transcript"[\s\S]*?hidden[\s\S]*?aria-labelledby="supadataName"|id="section-transcript"[\s\S]*?aria-labelledby="supadataName"[\s\S]*?hidden/,
  );
  assert.match(
    read("sidepanel.js"),
    /options\.html\?focus=supadata#section-transcript/,
  );
  const defaultLede = html.match(
    /<p class="lede" data-i18n="lede">([\s\S]*?)<\/p>/,
  );
  assert.ok(defaultLede);
  assert.doesNotMatch(defaultLede[1], /Supadata/i);
  assert.doesNotMatch(options.translate("en", "lede"), /Supadata/i);
  assert.doesNotMatch(options.translate("zh-CN", "lede"), /Supadata/i);
  assert.match(options.translate("en", "lede"), /No API key/i);
  assert.match(options.translate("zh-CN", "lede"), /无需 API 密钥/);
});
