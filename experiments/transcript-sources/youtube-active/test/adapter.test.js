const test = require("node:test");
const assert = require("node:assert/strict");

global.TRANSCRIPT_PROVIDER_CONTRACT = require("../../shared/provider-contract.js");
const active = require("../adapter.js");

function request() {
  return {
    runId: "active-run",
    requestId: "active-request",
    videoId: "jNQXAC9IVRw",
    preferredLanguage: "en",
    trackKind: "manual-first",
    captionTracks: [],
  };
}

test("active provider preserves identity and reports request classes", async () => {
  const adapter = active.createAdapter({
    youtubeAdapter: {
      async fetchTranscript(input, options) {
        assert.equal(input.videoId, "jNQXAC9IVRw");
        assert.equal(Object.hasOwn(input, "captionTracks"), false);
        assert.equal(typeof options.fetchImpl, "function");
        await options.fetchImpl(
          "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw",
          { method: "GET" },
        );
        await options.fetchImpl(
          "https://www.youtube.com/youtubei/v1/player",
          { method: "POST" },
        );
        return {
          language: "en",
          transcript: [{ text: "Fixture", start: 0, duration: 1 }],
          selectedTrack: { language: "en", kind: "manual" },
          sourceAttempt: "PAGE",
          attempts: [
            { sourceAttempt: "PAGE", formats: [{ format: "json3" }] },
            { sourceAttempt: "IOS", player: { status: 200 }, formats: [] },
          ],
        };
      },
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  const result = await adapter.fetchTranscript(request());
  assert.equal(result.success, true);
  assert.equal(result.providerId, "youtube-active");
  assert.deepEqual(result.diagnostics.providerInitiated, {
    youtubePlayer: 1,
    youtubeTimedtext: 1,
    thirdParty: 0,
    loopback: 0,
  });
});

test("active provider forwards explicit page track evidence only when supplied", async () => {
  let received = null;
  const adapter = active.createAdapter({
    youtubeAdapter: {
      async fetchTranscript(input) {
        received = input;
        return {
          language: "en",
          transcript: [{ text: "Fixture", start: 0, duration: 1 }],
          selectedTrack: { language: "en", kind: "manual" },
          sourceAttempt: "PAGE",
        };
      },
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  await adapter.fetchTranscript(request(), { captionTracks: [] });
  assert.equal(Object.hasOwn(received, "captionTracks"), true);
  assert.deepEqual(received.captionTracks, []);
});

test("active provider does not invoke Supadata or another provider after failure", async () => {
  let calls = 0;
  const adapter = active.createAdapter({
    youtubeAdapter: {
      async fetchTranscript() {
        calls += 1;
        const error = new Error("empty");
        error.code = "EMPTY_TRANSCRIPT";
        throw error;
      },
    },
    fetchImpl: async () => {},
  });
  const result = await adapter.fetchTranscript(request());
  assert.equal(result.errorCode, "EMPTY_TRANSCRIPT");
  assert.equal(calls, 1);
});

test("active request counts come from actual fetch calls even when they fail", async () => {
  const adapter = active.createAdapter({
    youtubeAdapter: {
      async fetchTranscript(_input, options) {
        await assert.rejects(
          options.fetchImpl("https://www.youtube.com/youtubei/v1/player", {
            method: "POST",
          }),
          /offline/,
        );
        const error = new Error("probe failed");
        error.code = "PROBE_FAILED";
        throw error;
      },
    },
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const result = await adapter.fetchTranscript(request());
  assert.equal(result.errorCode, "PROBE_FAILED");
  assert.deepEqual(result.diagnostics.providerInitiated, {
    youtubePlayer: 1,
    youtubeTimedtext: 0,
    thirdParty: 0,
    loopback: 0,
  });
});
