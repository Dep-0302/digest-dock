import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptCandidateFailure,
  adaptCandidateResult,
  toCandidateReport,
} from "../src/contract-adapter.mjs";

test("each Node library variant becomes a separate measured provider run", () => {
  const result = adaptCandidateResult({
    runId: "node-run",
    requestId: "node-request",
    candidate: "youtube-transcript-plus",
    videoId: "jNQXAC9IVRw",
    language: "en",
    languageEvidence: "verified",
    timeUnitEvidence: "seconds-verified",
    segments: [{ text: "Fixture", offsetSeconds: 0, durationSeconds: 1 }],
    requestCounts: { player: 1, timedtext: 1 },
  });
  assert.equal(result.providerId, "node-libraries");
  assert.equal(result.providerVariant, "youtube-transcript-plus");
  assert.deepEqual(result.diagnostics.requestCounts, { player: 1, timedtext: 1 });
});

test("real runner reports can persist shape metrics without transcript text", () => {
  const result = adaptCandidateResult({
    runId: "node-run",
    requestId: "node-request",
    candidate: "youtube-transcript-plus",
    videoId: "jNQXAC9IVRw",
    language: "en",
    languageEvidence: "verified",
    timeUnitEvidence: "seconds-verified",
    segments: [{ text: "Do not persist", offsetSeconds: 0, durationSeconds: 1 }],
  });
  const report = toCandidateReport(result, { category: "short-manual" });
  assert.equal(report.segmentCount, 1);
  assert.equal(JSON.stringify(report).includes("Do not persist"), false);
});

test("Node library results cannot enter the contract without verified time units", () => {
  assert.throws(
    () =>
      adaptCandidateResult({
        runId: "node-run",
        requestId: "node-request",
        candidate: "youtube-transcript",
        videoId: "jNQXAC9IVRw",
        language: "en",
        segments: [{ text: "Fixture", offsetSeconds: 1000, durationSeconds: 1000 }],
      }),
    /time units/,
  );
});

test("Node candidate failure categories map without fallback", () => {
  const result = adaptCandidateFailure({
    runId: "node-run",
    requestId: "node-request",
    candidate: "youtubei.js",
    videoId: "jNQXAC9IVRw",
    category: "upstream-api-error",
  });
  assert.equal(result.errorCode, "INVALID_RESPONSE");
  assert.equal(result.providerVariant, "youtubei.js");
});

test("no-caption results map to NO_TRANSCRIPT without time-unit evidence", () => {
  const result = adaptCandidateFailure({
    runId: "node-run",
    requestId: "node-request",
    candidate: "youtube-transcript",
    videoId: "jNQXAC9IVRw",
    category: "no-caption",
  });
  assert.equal(result.errorCode, "NO_TRANSCRIPT");
});
