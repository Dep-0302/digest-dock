const test = require("node:test");
const assert = require("node:assert/strict");

global.TRANSCRIPT_PROVIDER_CONTRACT = require("../../shared/provider-contract.js");
const supadata = require("../adapter.js");

function input() {
  return {
    runId: "supadata-run",
    requestId: "supadata-request",
    videoId: "jNQXAC9IVRw",
    preferredLanguage: "en",
  };
}

test("Supadata sends nothing without explicit attempt consent", async () => {
  let calls = 0;
  const adapter = supadata.createAdapter({
    transport: async () => {
      calls += 1;
    },
  });
  const result = await adapter.fetchTranscript(input());
  assert.equal(result.errorCode, "CONSENT_REQUIRED");
  assert.equal(calls, 0);
});

test("native fixture uses canonical URL and millisecond timestamps", async () => {
  let request = null;
  const adapter = supadata.createAdapter({
    transport: async (value) => {
      request = value;
      return {
        ok: true,
        status: 200,
        body: {
          lang: "en",
          content: [{ text: "Fixture", offset: 1250, duration: 500, lang: "en" }],
        },
      };
    },
  });
  const result = await adapter.fetchTranscript(input(), {
    consent: true,
    apiKey: "fixture",
  });
  assert.equal(result.success, true);
  assert.equal(result.transcript[0].start, 1.25);
  const url = new URL(request.endpoint);
  assert.equal(url.searchParams.get("url"), "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  assert.equal(url.searchParams.get("mode"), "native");
  assert.equal(url.searchParams.get("text"), "false");
});

test("429 does not retry and async jobs stay outside the fixture wrapper", async () => {
  let calls = 0;
  const rateLimited = supadata.createAdapter({
    transport: async () => {
      calls += 1;
      return { ok: false, status: 429, body: {} };
    },
  });
  assert.equal(
    (await rateLimited.fetchTranscript(input(), { consent: true })).errorCode,
    "RATE_LIMITED",
  );
  assert.equal(calls, 1);

  const asynchronous = supadata.createAdapter({
    transport: async () => ({ ok: true, status: 202, body: { jobId: "fixture" } }),
  });
  assert.equal(
    (await asynchronous.fetchTranscript(input(), { consent: true })).errorCode,
    "PROVIDER_BUSY",
  );
});

test("206, transport failure, timeout, and language mismatch stay distinct", async () => {
  const noTranscript = supadata.createAdapter({
    transport: async () => ({ ok: true, status: 206, body: {} }),
  });
  assert.equal(
    (await noTranscript.fetchTranscript(input(), { consent: true })).errorCode,
    "NO_TRANSCRIPT",
  );

  const unavailable = supadata.createAdapter({
    transport: async () => {
      throw new TypeError("network unavailable");
    },
  });
  assert.equal(
    (await unavailable.fetchTranscript(input(), { consent: true })).errorCode,
    "PROVIDER_UNAVAILABLE",
  );

  const timeout = supadata.createAdapter({
    transport: async ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        ),
      ),
  });
  assert.equal(
    (await timeout.fetchTranscript(input(), { consent: true, timeoutMs: 1 })).errorCode,
    "TIMEOUT",
  );

  const wrongLanguage = supadata.createAdapter({
    transport: async () => ({
      ok: true,
      status: 200,
      body: {
        lang: "fr",
        content: [{ text: "Fixture", offset: 0, duration: 1000, lang: "fr" }],
      },
    }),
  });
  assert.equal(
    (await wrongLanguage.fetchTranscript(input(), { consent: true })).errorCode,
    "TRACK_UNAVAILABLE",
  );
});
