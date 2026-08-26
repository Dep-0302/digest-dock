const test = require("node:test");
const assert = require("node:assert/strict");

const manual = require("../manual-results.js");

function result(overrides = {}) {
  return {
    schemaVersion: 2,
    runId: "run-1",
    requestId: "request-1",
    startedAt: "2026-08-24T12:00:00Z",
    providerId: "youtube-passive",
    providerVariant: null,
    videoId: "jNQXAC9IVRw",
    category: "short-manual",
    status: "success",
    elapsedMs: 100,
    language: "en",
    languageEvidence: "verified",
    segmentCount: 3,
    characterCount: 120,
    firstStart: 0,
    lastStart: 10,
    errorCode: null,
    diagnostics: {
      providerInitiated: {
        youtubePlayer: 0,
        youtubeTimedtext: 0,
        thirdParty: 0,
        loopback: 0,
      },
      pageObserved: { youtubeTimedtext: 1 },
    },
    manualChecks: {
      firstTimestampCompared: true,
      lastTimestampCompared: true,
      sampleTextComparedWithoutSavingText: true,
      spaSecondVideoRejectedOldResult: true,
    },
    notes: ["clean-success"],
    ...overrides,
  };
}

test("manual results validate the text-free fixed schema", () => {
  const validated = manual.validateManualRun(result());
  assert.equal(validated.providerId, "youtube-passive");
  assert.equal(validated.segmentCount, 3);
});

test("manual results reject raw text fields, arbitrary notes, and detail", () => {
  assert.throws(
    () => manual.validateManualRun({ ...result(), transcriptText: "private" }),
    /unknown field/,
  );
  assert.throws(
    () => manual.validateManualRun({ ...result(), notes: ["a real subtitle line"] }),
    /categorical/,
  );
  assert.throws(
    () => manual.validateManualRun({ ...result(), diagnostics: { detail: "private" } }),
    /non-whitelisted/,
  );
  assert.throws(
    () => manual.validateManualRun({ ...result(), language: null }),
    /unknown evidence/,
  );
  assert.throws(
    () => manual.validateManualRun({ ...result(), segmentCount: 0 }),
    /at least one segment/,
  );
});

test("manual summaries group provider variants and aggregate counts", () => {
  const summary = manual.summarizeManualRuns([
    result({ elapsedMs: 100 }),
    result({ runId: "run-2", requestId: "request-2", elapsedMs: 200 }),
    result({
      runId: "run-3",
      requestId: "request-3",
      providerId: "node-libraries",
      providerVariant: "youtube-transcript-plus",
      elapsedMs: 50,
    }),
  ]);
  assert.equal(summary.length, 2);
  const passive = summary.find((row) => row.providerId === "youtube-passive");
  assert.equal(passive.runs, 2);
  assert.equal(passive.medianElapsedMs, 150);
  assert.equal(passive.initiated.youtubeTimedtext, 0);
  assert.equal(passive.initiated.loopback, 0);
});
