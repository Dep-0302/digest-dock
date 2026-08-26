const test = require("node:test");
const assert = require("node:assert/strict");

global.TRANSCRIPT_PROVIDER_CONTRACT = require("../provider-contract.js");
global.PASSIVE_TRANSCRIPT_CORE = require("../../passive-capture/extension/core.js");

const routerModule = require("../provider-router.js");
const passiveModule = require("../../passive-capture/provider-adapter.js");
const activeModule = require("../../youtube-active/adapter.js");
const panelModule = require("../../browser-panel/provider-adapter.js");
const supadataModule = require("../../supadata-native/adapter.js");
const localModule = require("../../local-helper/client.js");
const hostedModule = require("../../hosted-api-slot/adapter.js");

function baseRequest(providerId, providerVariant = null, index = 1) {
  return {
    schemaVersion: 1,
    runId: `fixture-run-${index}`,
    requestId: `fixture-request-${index}`,
    providerId,
    providerVariant,
    videoId: "jNQXAC9IVRw",
    preferredLanguage: "en",
    trackKind: "manual-first",
    cacheMode: "bypass",
  };
}

test("all seven registered provider adapters dispatch through the strict router", async () => {
  const nodeModule = await import(
    "../../node-libraries/src/contract-adapter.mjs"
  );
  const active = activeModule.createAdapter({
    youtubeAdapter: {
      async fetchTranscript() {
        return {
          language: "en",
          transcript: [{ text: "Fixture", start: 0, duration: 1 }],
          selectedTrack: { language: "en", kind: "manual" },
          sourceAttempt: "PAGE",
          attempts: [],
        };
      },
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  const supadata = supadataModule.createAdapter({
    transport: async () => ({
      ok: true,
      status: 200,
      body: {
        lang: "en",
        content: [{ text: "Fixture", offset: 0, duration: 1000, lang: "en" }],
      },
    }),
  });
  const local = localModule.createClient({
    origin: "http://127.0.0.1:8765",
    token: "fixture-pairing-token-that-is-long-enough",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          schemaVersion: 1,
          providerId: "local-helper",
          providerVariant: "youtube-transcript-api",
          runId: request.runId,
          requestId: request.requestId,
          videoId: request.videoId,
          language: "en",
          selectedTrack: { language: "en", kind: "manual" },
          segments: [{ text: "Fixture", start: 0, duration: 1 }],
        }),
      };
    },
  });
  const hosted = hostedModule.createAdapter(null, {});
  const router = routerModule.createRouter({
    "youtube-passive": passiveModule.createAdapter(),
    "youtube-active": active.fetchTranscript,
    "youtube-panel": panelModule.createAdapter(),
    "supadata-native": (request, context) =>
      supadata.fetchTranscript(request, context),
    "node-libraries": async (request, context) =>
      nodeModule.adaptCandidateResult({
        runId: request.runId,
        requestId: request.requestId,
        candidate: request.providerVariant,
        videoId: request.videoId,
        language: "en",
        languageEvidence: "verified",
        timeUnitEvidence: "seconds-verified",
        segments: context.segments,
      }),
    "local-helper": (request, context) =>
      local.fetchTranscript(request, context),
    "hosted-api-slot": (request, context) =>
      hosted.fetchTranscript(request, context),
  });

  const cases = [
    [
      baseRequest("youtube-passive", null, 1),
      {
        capture: {
          videoId: "jNQXAC9IVRw",
          language: "en",
          kind: "manual",
          format: "json3",
          status: 200,
          transport: "xhr",
          body: JSON.stringify({
            events: [
              { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Fixture" }] },
            ],
          }),
        },
      },
      true,
    ],
    [baseRequest("youtube-active", null, 2), { captionTracks: [] }, true],
    [
      baseRequest("youtube-panel", "manual-rendered-panel", 3),
      {
        currentVideoId: "jNQXAC9IVRw",
        panelVideoId: "jNQXAC9IVRw",
        generation: 1,
        panelGeneration: 1,
        complete: true,
        completenessEvidence: "manual-top-to-bottom",
        rows: [{ timestamp: "0:00", text: "Fixture" }],
      },
      true,
    ],
    [baseRequest("supadata-native", "mode-native", 4), { consent: true }, true],
    [
      baseRequest("node-libraries", "youtube-transcript-plus", 5),
      { segments: [{ text: "Fixture", offsetSeconds: 0, durationSeconds: 1 }] },
      true,
    ],
    [
      baseRequest("local-helper", "youtube-transcript-api", 6),
      {},
      true,
    ],
    [baseRequest("hosted-api-slot", null, 7), {}, false],
  ];

  for (const [request, context, expectedSuccess] of cases) {
    const result = await router.dispatch(request, context);
    assert.equal(result.success, expectedSuccess, request.providerId);
    assert.equal(result.providerId, request.providerId);
    assert.equal(result.providerVariant, request.providerVariant);
    assert.equal(result.runId, request.runId);
    assert.equal(result.requestId, request.requestId);
  }
});
