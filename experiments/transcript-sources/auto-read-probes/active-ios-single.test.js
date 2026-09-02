const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const probe = require("./active-ios-single.js");

const VIDEO_ID = "LEY9kenjVaA";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => String(body),
  };
}

function playerBody() {
  return JSON.stringify({
    playabilityStatus: { status: "OK" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            languageCode: "zh",
            vssId: ".zh",
            baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=zh&signature=never-store`,
          },
        ],
      },
    },
  });
}

test("IOS/json3 probe succeeds with exactly one player and one caption call", async () => {
  const calls = [];
  const result = await probe.run(
    {
      runId: "probe-1",
      videoId: VIDEO_ID,
      language: "zh",
      trackKind: "manual-first",
    },
    {
      getCurrentVideoId: () => VIDEO_ID,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/youtubei/v1/player")) {
          const body = JSON.parse(init.body);
          assert.equal(body.context.client.clientName, "IOS");
          assert.equal(body.context.client.deviceMake, "Apple");
          assert.equal(body.context.client.deviceModel, "iPhone16,2");
          return response(playerBody());
        }
        assert.match(String(url), /fmt=json3/);
        return response(JSON.stringify({
          events: [
            {
              tStartMs: 0,
              dDurationMs: 1000,
              segs: [{ utf8: "probe text" }],
            },
          ],
        }));
      },
    },
  );
  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.language, "zh");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 1);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /never-store|signature=/);
});

test("one IOS 403 is terminal and never switches client or format", async () => {
  let calls = 0;
  const result = await probe.run(
    {
      runId: "probe-403",
      videoId: VIDEO_ID,
      language: "zh",
      trackKind: "manual-first",
    },
    {
      getCurrentVideoId: () => VIDEO_ID,
      fetchImpl: async () => {
        calls += 1;
        return response("", 403);
      },
    },
  );
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 0);
  assert.equal(calls, 1);
  assert.equal(result.diagnostics.attempts[0].outcome, "player-http-error");
  assert.deepEqual(result.diagnostics.attempts[0].player, {
    status: 403,
    bytes: 0,
    elapsedMs: 0,
  });
  assert.equal(result.diagnostics.attempts[0].trackCount, 0);
});

test("one player network failure records a text-free outcome and error", async () => {
  const result = await probe.run(
    {
      runId: "probe-network",
      videoId: VIDEO_ID,
      language: "zh",
      trackKind: "manual-first",
    },
    {
      getCurrentVideoId: () => VIDEO_ID,
      fetchImpl: async () => {
        throw new Error("sensitive network detail");
      },
    },
  );
  const attempt = result.diagnostics.attempts[0];
  assert.equal(result.errorCode, "PROBE_FAILED");
  assert.equal(attempt.outcome, "player-request-failed");
  assert.equal(attempt.error, "NETWORK");
  assert.equal(Object.hasOwn(attempt, "message"), false);
  assert.doesNotMatch(JSON.stringify(result), /sensitive network detail/);
});

test("request setup failures keep a stable text-free error code", async () => {
  class BrokenAbortController {
    constructor() {
      throw new Error("sensitive constructor detail");
    }
  }
  const result = await probe.run(
    {
      runId: "probe-controller",
      videoId: VIDEO_ID,
      language: "zh",
      trackKind: "manual-first",
    },
    {
      getCurrentVideoId: () => VIDEO_ID,
      AbortController: BrokenAbortController,
      fetchImpl: async () => {
        throw new Error("must not run");
      },
    },
  );
  const attempt = result.diagnostics.attempts[0];
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(attempt.outcome, "player-request-failed");
  assert.equal(attempt.error, "ABORT_CONTROLLER_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /sensitive constructor detail/);
});

test("timer adapters preserve their browser-like dependency receiver", async () => {
  let scheduled = 0;
  let cleared = 0;
  const deps = {
    getCurrentVideoId: () => VIDEO_ID,
    setTimeout(callback) {
      assert.equal(this, deps);
      scheduled += 1;
      return setTimeout(callback, 1000);
    },
    clearTimeout(timerId) {
      assert.equal(this, deps);
      cleared += 1;
      clearTimeout(timerId);
    },
    fetchImpl: async (url) => {
      if (String(url).includes("/youtubei/v1/player")) {
        return response(playerBody());
      }
      return response(JSON.stringify({
        events: [{
          tStartMs: 0,
          dDurationMs: 1000,
          segs: [{ utf8: "probe text" }],
        }],
      }));
    },
  };
  const result = await probe.run(
    {
      runId: "probe-timer-receiver",
      videoId: VIDEO_ID,
      language: "zh",
      trackKind: "manual-first",
    },
    deps,
  );
  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(scheduled, 2);
  assert.equal(cleared, 2);
});

test("playable player without tracks reports its status, bytes, playability, and count", async () => {
  const body = JSON.stringify({
    playabilityStatus: { status: "OK" },
  });
  const result = await probe.run(
    {
      runId: "probe-no-tracks",
      videoId: VIDEO_ID,
      language: "zh",
      trackKind: "manual-first",
    },
    {
      getCurrentVideoId: () => VIDEO_ID,
      fetchImpl: async () => response(body),
    },
  );
  const attempt = result.diagnostics.attempts[0];
  assert.equal(result.errorCode, "NO_TRANSCRIPT");
  assert.equal(attempt.outcome, "no-caption");
  assert.equal(attempt.player.status, 200);
  assert.equal(attempt.player.bytes, Buffer.byteLength(body));
  assert.equal(attempt.playability, "OK");
  assert.equal(attempt.trackCount, 0);
});

test("manual MV3 probe has temporary tab access and emits metrics only", () => {
  const root = __dirname;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  const popup = fs.readFileSync(path.join(root, "popup.js"), "utf8");
  const readback = fs.readFileSync(
    path.join(root, "diagnostics-readback.js"),
    "utf8",
  );
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting"]);
  assert.equal(Object.hasOwn(manifest, "host_permissions"), false);
  assert.doesNotMatch(popup, /chrome\.storage|chrome\.cookies/);
  assert.doesNotMatch(popup, /samples|transcriptText|\.transcript\s*[,}]/);
  assert.match(popup, /DIGESTDOCK_AUTO_READ_DIAGNOSTICS/);
  assert.match(popup, /diagnostics\.project/);
  assert.match(readback, /captionBytes/);
  assert.match(readback, /segmentCount/);
  assert.doesNotMatch(readback, /chrome\.storage|chrome\.cookies/);
});
