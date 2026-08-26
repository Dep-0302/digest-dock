const test = require("node:test");
const assert = require("node:assert/strict");

global.TRANSCRIPT_PROVIDER_CONTRACT = require("../../shared/provider-contract.js");
const helper = require("../client.js");

const token = "fixture-pairing-token-that-is-long-enough";

test("the client accepts only an exact IPv4 loopback origin", () => {
  assert.equal(
    helper.validateLoopbackOrigin("http://127.0.0.1:8765"),
    "http://127.0.0.1:8765",
  );
  for (const value of [
    "http://localhost:8765",
    "http://0.0.0.0:8765",
    "https://127.0.0.1:8765",
    "http://127.0.0.1:8765/path",
  ]) {
    assert.throws(() => helper.validateLoopbackOrigin(value), /127\.0\.0\.1/);
  }
});

test("invalid track kinds fail before any loopback request", async () => {
  let calls = 0;
  const client = helper.createClient({
    origin: "http://127.0.0.1:8765",
    token,
    fetchImpl: async () => {
      calls += 1;
    },
  });
  await assert.rejects(
    client.fetchTranscript({ videoId: "jNQXAC9IVRw", trackKind: "translated" }),
    /track kind/,
  );
  assert.equal(calls, 0);
});

test("the client uses omit credentials and a header token", async () => {
  let request = null;
  const client = helper.createClient({
    origin: "http://127.0.0.1:8765",
    token,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          schemaVersion: 1,
          providerId: "local-helper",
          providerVariant: "youtube-transcript-api",
          runId: "manual-request",
          requestId: "manual-request",
          videoId: "jNQXAC9IVRw",
          language: "en",
          segments: [{ text: "Fixture", start: 0, duration: 1 }],
        }),
      };
    },
  });
  const result = await client.fetchTranscript({
    providerId: "local-helper",
    videoId: "jNQXAC9IVRw",
    preferredLanguage: "en",
  });

  assert.equal(result.success, true);
  assert.equal(request.url, "http://127.0.0.1:8765/v1/transcript");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.headers["X-DigestDock-Helper-Token"], token);
  assert.equal(request.url.includes(token), false);
});

test("an external signal cannot replace the built-in hard-timeout signal", async () => {
  let receivedSignal = null;
  const external = new AbortController();
  const client = helper.createClient({
    origin: "http://127.0.0.1:8765",
    token,
    fetchImpl: async (_url, init) => {
      receivedSignal = init.signal;
      external.abort();
      assert.equal(receivedSignal.aborted, true);
      return {
        ok: false,
        status: 503,
        json: async () => ({ ok: false, errorCode: "HELPER_UNAVAILABLE" }),
      };
    },
  });
  await client.fetchTranscript(
    { videoId: "jNQXAC9IVRw" },
    { signal: external.signal, timeoutMs: 10 },
  );
  assert.notEqual(receivedSignal, external.signal);
});

test("success responses fail closed when run identity is stale", async () => {
  const client = helper.createClient({
    origin: "http://127.0.0.1:8765",
    token,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        schemaVersion: 1,
        providerId: "local-helper",
        providerVariant: "youtube-transcript-api",
        runId: "other-run",
        requestId: "manual-request",
        videoId: "jNQXAC9IVRw",
        language: "en",
        segments: [{ text: "Fixture", start: 0, duration: 1 }],
      }),
    }),
  });
  const result = await client.fetchTranscript({ videoId: "jNQXAC9IVRw" });
  assert.equal(result.errorCode, "INVALID_RESPONSE");
});

test("hard timeout fires even when a custom transport ignores AbortSignal", async () => {
  const client = helper.createClient({
    origin: "http://127.0.0.1:8765",
    token,
    fetchImpl: async () => new Promise(() => {}),
  });
  const result = await client.fetchTranscript(
    { videoId: "jNQXAC9IVRw" },
    { timeoutMs: 1 },
  );
  assert.equal(result.errorCode, "TIMEOUT");
});

test("unreachable and unauthorized helpers have stable failure codes", async () => {
  const unreachable = helper.createClient({
    origin: "http://127.0.0.1:8765",
    token,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(
    (await unreachable.fetchTranscript({ videoId: "jNQXAC9IVRw" })).errorCode,
    "HELPER_UNAVAILABLE",
  );

  const unauthorized = helper.createClient({
    origin: "http://127.0.0.1:8765",
    token,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false }),
    }),
  });
  assert.equal(
    (await unauthorized.fetchTranscript({ videoId: "jNQXAC9IVRw" })).errorCode,
    "HELPER_UNAUTHORIZED",
  );
});
