const test = require("node:test");
const assert = require("node:assert/strict");
const readback = require("./diagnostics-readback.js");

test("projects successful probe metrics without returning transcript or request secrets", () => {
  const result = readback.project({
    status: "HAVE_TRANSCRIPT",
    videoId: "jNQXAC9IVRw",
    language: "en",
    selectedTrack: {
      language: "en",
      kind: "manual",
      label: "English secret-label",
      baseUrl: "https://www.youtube.com/api/timedtext?signature=never-store",
    },
    transcript: [{ text: "SECRET_TRANSCRIPT_BODY" }],
    diagnostics: {
      providerInitiated: {
        youtubePlayer: 1,
        youtubeTimedtext: 1,
        thirdParty: 0,
        loopback: 0,
      },
      attempts: [{
        client: "IOS",
        outcome: "transcript",
        player: { status: 200, bytes: 1200, elapsedMs: 42.4 },
        playability: "OK",
        trackCount: 2,
        selectedTrack: { language: "en", kind: "manual" },
        formats: [{
          format: "json3",
          status: 200,
          bytes: 700,
          elapsedMs: 18.6,
          segmentCount: 1,
          rawBody: "SECRET_TRANSCRIPT_BODY",
        }],
        requestHeaders: { Authorization: "SECRET_AUTH" },
      }],
    },
  });

  assert.equal(result.attempt.outcome, "transcript");
  assert.deepEqual(result.attempt.player, {
    status: 200,
    bytes: 1200,
    elapsedMs: 42,
  });
  assert.equal(result.attempt.playability, "OK");
  assert.equal(result.attempt.trackCount, 2);
  assert.equal(result.captionBytes, 700);
  assert.equal(result.segmentCount, 1);
  assert.equal(Object.hasOwn(result, "transcript"), false);
  assert.doesNotMatch(
    JSON.stringify(result),
    /SECRET_TRANSCRIPT_BODY|SECRET_AUTH|secret-label|signature=|baseUrl|requestHeaders/,
  );
});

test("preserves text-free player failure diagnostics", () => {
  const result = readback.project({
    status: "UNKNOWN",
    errorCode: "PROBE_FAILED",
    videoId: "LEY9kenjVaA",
    language: "zh",
    diagnostics: {
      providerInitiated: { youtubePlayer: 1 },
      attempts: [{
        client: "IOS",
        outcome: "player-request-failed",
        error: "NETWORK",
        trackCount: 0,
        formats: [],
      }],
    },
  });

  assert.equal(result.errorCode, "PROBE_FAILED");
  assert.equal(result.attempt.outcome, "player-request-failed");
  assert.equal(result.attempt.error, "NETWORK");
  assert.equal(result.attempt.player, null);
  assert.equal(result.attempt.playability, null);
  assert.equal(result.attempt.trackCount, 0);
  assert.equal(result.captionBytes, 0);
  assert.equal(result.segmentCount, 0);
});
