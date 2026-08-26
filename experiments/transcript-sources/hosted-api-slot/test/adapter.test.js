const test = require("node:test");
const assert = require("node:assert/strict");

global.TRANSCRIPT_PROVIDER_CONTRACT = require("../../shared/provider-contract.js");
const hosted = require("../adapter.js");

function descriptor() {
  return {
    providerName: "fixture-provider",
    exactEndpoint: "https://api.example.test/v1/transcript",
    buildRequest: ({ canonicalUrl, preferredLanguage }) => ({
      method: "POST",
      body: { url: canonicalUrl, language: preferredLanguage },
    }),
    parseResponse: (body) => ({
      language: body.language,
      languageEvidence: "verified",
      segments: body.content,
    }),
    mapError: (response) => (response.status === 429 ? "RATE_LIMITED" : "INVALID_RESPONSE"),
  };
}

test("an unselected vendor is a stable unavailable slot and sends nothing", async () => {
  let calls = 0;
  const adapter = hosted.createAdapter(null, {
    transport: async () => {
      calls += 1;
    },
  });
  const result = await adapter.fetchTranscript({ videoId: "jNQXAC9IVRw" });
  assert.equal(result.errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(calls, 0);
});

test("explicit per-attempt consent is required before transport", async () => {
  let calls = 0;
  const adapter = hosted.createAdapter(descriptor(), {
    transport: async () => {
      calls += 1;
    },
  });
  const result = await adapter.fetchTranscript({ videoId: "jNQXAC9IVRw" });
  assert.equal(result.errorCode, "CONSENT_REQUIRED");
  assert.equal(calls, 0);
});

test("a fixed descriptor receives only the canonical YouTube URL", async () => {
  let request = null;
  const adapter = hosted.createAdapter(descriptor(), {
    transport: async (endpoint, init) => {
      request = { endpoint, init };
      return {
        ok: true,
        status: 200,
        body: {
          language: "en",
          content: [{ text: "Fixture", start: 0, duration: 1 }],
        },
      };
    },
  });
  const result = await adapter.fetchTranscript(
    {
      videoId: "jNQXAC9IVRw",
      preferredLanguage: "en",
    },
    { consent: true },
  );
  assert.equal(result.success, true);
  assert.equal(request.endpoint, "https://api.example.test/v1/transcript");
  assert.equal(
    request.init.body.url,
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  );
});

test("429 is classified without retrying", async () => {
  let calls = 0;
  const adapter = hosted.createAdapter(descriptor(), {
    transport: async () => {
      calls += 1;
      return { ok: false, status: 429, body: {} };
    },
  });
  const result = await adapter.fetchTranscript(
    { videoId: "jNQXAC9IVRw" },
    { consent: true },
  );
  assert.equal(result.errorCode, "RATE_LIMITED");
  assert.equal(calls, 1);
});

test("hosted slot separates timeout, transport failure, and language mismatch", async () => {
  const timeout = hosted.createAdapter(descriptor(), {
    transport: async (_endpoint, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        ),
      ),
  });
  assert.equal(
    (await timeout.fetchTranscript({ videoId: "jNQXAC9IVRw" }, { consent: true, timeoutMs: 1 })).errorCode,
    "TIMEOUT",
  );

  const unavailable = hosted.createAdapter(descriptor(), {
    transport: async () => {
      throw new TypeError("offline");
    },
  });
  assert.equal(
    (await unavailable.fetchTranscript({ videoId: "jNQXAC9IVRw" }, { consent: true })).errorCode,
    "PROVIDER_UNAVAILABLE",
  );

  const wrongLanguage = hosted.createAdapter(descriptor(), {
    transport: async () => ({
      ok: true,
      status: 200,
      body: {
        language: "fr",
        content: [{ text: "Fixture", start: 0, duration: 1 }],
      },
    }),
  });
  assert.equal(
    (
      await wrongLanguage.fetchTranscript(
        { videoId: "jNQXAC9IVRw", preferredLanguage: "en" },
        { consent: true },
      )
    ).errorCode,
    "TRACK_UNAVAILABLE",
  );
});

test("descriptors reject broad, insecure, or credential-bearing endpoints", () => {
  for (const exactEndpoint of [
    "http://api.example.test/v1/transcript",
    "https://user:pass@api.example.test/v1/transcript",
    "https://api.example.test/",
    "https://api.example.test/v1/transcript?target=dynamic",
  ]) {
    assert.throws(
      () => hosted.validateDescriptor({ ...descriptor(), exactEndpoint }),
      /exact HTTPS path/,
    );
  }
});
