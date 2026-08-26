const test = require("node:test");
const assert = require("node:assert/strict");

const contract = require("../provider-contract.js");

test("the registry contract freezes exactly seven provider IDs", () => {
  assert.deepEqual(contract.PROVIDER_IDS, [
    "youtube-passive",
    "youtube-active",
    "youtube-panel",
    "supadata-native",
    "node-libraries",
    "local-helper",
    "hosted-api-slot",
  ]);
  assert.equal(new Set(contract.PROVIDER_IDS).size, 7);
});

test("success results normalize the shared transcript shape", () => {
  const result = contract.createSuccessResult({
    providerId: "youtube-passive",
    runId: "run-1",
    requestId: "request-1",
    videoId: "jNQXAC9IVRw",
    language: "en_US",
    languageEvidence: "verified",
    elapsedMs: 12.345,
    transcript: [
      { text: " First   line ", start: 0, duration: 1.5 },
      { text: "Second line", start: 2, duration: 1 },
    ],
    diagnostics: { observedResponses: 1, requestsInitiated: 0 },
  });

  assert.equal(result.success, true);
  assert.equal(result.language, "en-US");
  assert.equal(result.transcriptText, "First line Second line");
  assert.equal(
    result.transcriptTextTimestamped,
    "[0:00] First line\n[0:02] Second line",
  );
  assert.equal(result.diagnostics.requestsInitiated, 0);
});

test("diagnostics remove signed URLs, tokens, bodies, and transcript text", () => {
  const failure = contract.createFailureResult({
    providerId: "youtube-active",
    runId: "run-2",
    requestId: "request-2",
    videoId: "jNQXAC9IVRw",
    errorCode: "EMPTY_TRANSCRIPT",
    message:
      "failed at https://www.youtube.com/api/timedtext?signature=secret-value",
    diagnostics: {
      requestUrl:
        "https://www.youtube.com/api/timedtext?signature=secret-value",
      authorization: "Bearer definitely-not-for-a-report",
      responseBody: "private transcript",
      nested: { signature: "secret", endpointClass: "timedtext" },
    },
  });

  assert.match(failure.message, /\[redacted-url\]/);
  assert.deepEqual(failure.diagnostics, {
  });
});

test("diagnostics use a strict whitelist even when a harmless-looking key contains text", () => {
  const failure = contract.createFailureResult({
    providerId: "youtube-active",
    runId: "run-3",
    requestId: "request-3",
    videoId: "jNQXAC9IVRw",
    errorCode: "INVALID_RESPONSE",
    diagnostics: {
      detail: "this could be real transcript text",
      endpointClass: "timedtext",
      providerInitiated: { youtubeTimedtext: 1 },
    },
  });
  assert.deepEqual(failure.diagnostics, {
    endpointClass: "timedtext",
    providerInitiated: { youtubeTimedtext: 1 },
  });
});

test("measured runs reject zero or multiple provider selections", () => {
  assert.equal(
    contract.assertSingleProviderSelection(["youtube-panel"]),
    "youtube-panel",
  );
  assert.throws(
    () => contract.assertSingleProviderSelection([]),
    /exactly one provider/,
  );
  assert.throws(
    () =>
      contract.assertSingleProviderSelection([
        "youtube-panel",
        "youtube-active",
      ]),
    /exactly one provider/,
  );
});

test("sanitized reports contain metrics but never raw transcript text", () => {
  const result = contract.createSuccessResult({
    providerId: "local-helper",
    providerVariant: "youtube-transcript-api",
    runId: "run-4",
    requestId: "request-4",
    videoId: "jNQXAC9IVRw",
    language: "en",
    languageEvidence: "verified",
    transcript: [{ text: "Do not persist me", start: 4, duration: 2 }],
  });
  const report = contract.toSanitizedReport(result, {
    category: "short-manual",
  });

  assert.equal(report.segmentCount, 1);
  assert.equal(report.characterCount, "Do not persist me".length);
  assert.equal(report.firstStart, 4);
  assert.deepEqual(report.context, { category: "short-manual" });
  assert.equal(JSON.stringify(report).includes("Do not persist me"), false);
});

test("success results fail closed on invalid or non-monotonic segments", () => {
  const base = {
    providerId: "youtube-panel",
    runId: "run-5",
    requestId: "request-5",
    videoId: "jNQXAC9IVRw",
    language: "en",
    languageEvidence: "inferred",
  };
  assert.throws(
    () =>
      contract.createSuccessResult({
        ...base,
        transcript: [
          { text: "Later", start: 4, duration: 1 },
          { text: "Earlier", start: 2, duration: 1 },
        ],
      }),
    /out of order/,
  );
  assert.throws(
    () =>
      contract.createSuccessResult({
        ...base,
        transcript: [{ text: "Missing duration", start: 0 }],
      }),
    /segment 0 is invalid/,
  );
});
