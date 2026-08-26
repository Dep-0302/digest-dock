const test = require("node:test");
const assert = require("node:assert/strict");

global.TRANSCRIPT_PROVIDER_CONTRACT = require("../provider-contract.js");
const routerModule = require("../provider-router.js");

function request(providerId = "youtube-passive") {
  return {
    schemaVersion: 1,
    runId: "run-1",
    requestId: "request-1",
    providerId,
    providerVariant: null,
    videoId: "jNQXAC9IVRw",
    preferredLanguage: "en",
    trackKind: "manual-first",
    cacheMode: "bypass",
  };
}

function successFor(input) {
  return TRANSCRIPT_PROVIDER_CONTRACT.createSuccessResult({
    providerId: input.providerId,
    providerVariant: input.providerVariant,
    runId: input.runId,
    requestId: input.requestId,
    videoId: input.videoId,
    language: "en",
    languageEvidence: "verified",
    transcript: [{ text: "Fixture", start: 0, duration: 1 }],
  });
}

test("dispatch invokes exactly the selected provider once", async () => {
  const calls = { passive: 0, active: 0 };
  const router = routerModule.createRouter({
    "youtube-passive": async (input) => {
      calls.passive += 1;
      return successFor(input);
    },
    "youtube-active": async (input) => {
      calls.active += 1;
      return successFor(input);
    },
  });
  const result = await router.dispatch(request("youtube-passive"));
  assert.equal(result.success, true);
  assert.deepEqual(calls, { passive: 1, active: 0 });
});

test("provider failure never falls through to another adapter", async () => {
  const calls = { passive: 0, active: 0 };
  const router = routerModule.createRouter({
    "youtube-passive": async (input) => {
      calls.passive += 1;
      return TRANSCRIPT_PROVIDER_CONTRACT.createFailureResult({
        providerId: input.providerId,
        providerVariant: input.providerVariant,
        runId: input.runId,
        requestId: input.requestId,
        videoId: input.videoId,
        errorCode: "EMPTY_TRANSCRIPT",
      });
    },
    "youtube-active": async (input) => {
      calls.active += 1;
      return successFor(input);
    },
  });
  const result = await router.dispatch(request("youtube-passive"));
  assert.equal(result.errorCode, "EMPTY_TRANSCRIPT");
  assert.deepEqual(calls, { passive: 1, active: 0 });
});

test("mismatched provider, variant, run, request, or video identity fails closed", async () => {
  const mutations = [
    { providerId: "youtube-active" },
    { providerVariant: "unexpected" },
    { runId: "other-run" },
    { requestId: "other-request" },
    { videoId: "dQw4w9WgXcQ" },
  ];
  for (const mutation of mutations) {
    const router = routerModule.createRouter({
      "youtube-passive": async (input) => ({
        ...successFor(input),
        ...mutation,
      }),
    });
    const result = await router.dispatch(request());
    assert.equal(result.errorCode, "INVALID_RESPONSE");
  }
});

test("router revalidates malformed success data and strips non-whitelisted diagnostics", async () => {
  const malformed = routerModule.createRouter({
    "youtube-passive": async (input) => ({
      ...successFor(input),
      transcript: [{ text: "Bad", start: -1 }],
      diagnostics: {
        requestUrl: "https://www.youtube.com/api/timedtext?signature=secret",
      },
    }),
  });
  assert.equal((await malformed.dispatch(request())).errorCode, "INVALID_RESPONSE");

  const sanitizing = routerModule.createRouter({
    "youtube-passive": async (input) => ({
      ...successFor(input),
      diagnostics: {
        detail: "private transcript text",
        providerInitiated: { youtubeTimedtext: 0 },
      },
    }),
  });
  const result = await sanitizing.dispatch(request());
  assert.equal(result.success, true);
  assert.deepEqual(result.diagnostics, {
    providerInitiated: { youtubeTimedtext: 0 },
  });
});

test("provider-specific context reaches only the selected adapter", async () => {
  let seenContext = null;
  const router = routerModule.createRouter({
    "youtube-passive": async (input, context) => {
      seenContext = context;
      return successFor(input);
    },
  });
  const context = {
    tabId: 42,
    generation: 3,
    captionTracks: [{ languageCode: "en" }],
  };
  await router.dispatch(request(), context);
  assert.equal(seenContext, context);
});

test("unregistered providers are unavailable without calling anything", async () => {
  const router = routerModule.createRouter({});
  const result = await router.dispatch(request("hosted-api-slot"));
  assert.equal(result.errorCode, "PROVIDER_UNAVAILABLE");
});

test("measured requests default to cache bypass but reject invalid modes", () => {
  const normalized = routerModule.normalizeRequest({
    ...request(),
    cacheMode: undefined,
  });
  assert.equal(normalized.cacheMode, "bypass");
  assert.throws(
    () => routerModule.normalizeRequest({ ...request(), cacheMode: "shared" }),
    /cache mode/,
  );
});
