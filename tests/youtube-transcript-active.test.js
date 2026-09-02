const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const active = require("../youtube-transcript-active.js");

const VIDEO_ID = "jNQXAC9IVRw";
const CAPTION_URL =
  `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}` +
  "&expire=never-persist-this&signature=never-persist-this";

function response(body, status = 200, headers = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) ?? null },
    text: async () => String(body),
  };
}

function playerBody(tracks = [], status = "OK") {
  return JSON.stringify({
    playabilityStatus: { status },
    captions: {
      playerCaptionsTracklistRenderer: { captionTracks: tracks },
    },
  });
}

function json3(...segments) {
  return JSON.stringify({
    events: segments.map((segment) => ({
      tStartMs: segment.start * 1000,
      dDurationMs: segment.duration * 1000,
      segs: [{ utf8: segment.text }],
    })),
  });
}

function manualTrack(language = "en", url = CAPTION_URL) {
  return {
    languageCode: language,
    vssId: `.${language}`,
    name: { simpleText: language },
    baseUrl: url,
  };
}

function asrTrack(language = "en", url = CAPTION_URL) {
  return {
    languageCode: language,
    kind: "asr",
    vssId: `a.${language}`,
    name: { simpleText: `${language} (auto-generated)` },
    baseUrl: url,
  };
}

function assertSafeFetch(init) {
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.equal(init.referrerPolicy, "no-referrer");
  const keys = Object.keys(init.headers || {}).map((key) => key.toLowerCase());
  assert.equal(keys.includes("cookie"), false);
  assert.equal(keys.includes("authorization"), false);
  assert.equal(keys.includes("origin"), false);
  assert.equal(keys.includes("user-agent"), false);
}

test("exports one UMD/CommonJS run surface", () => {
  assert.equal(typeof active.run, "function");
  assert.equal(globalThis.DIGESTDOCK_YOUTUBE_ACTIVE, active);
});

test("repeated product injection reuses the same cancellable Active instance", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "youtube-transcript-active.js"),
    "utf8",
  );
  const sandbox = { URL, TextEncoder, TextDecoder };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  const first = sandbox.DIGESTDOCK_YOUTUBE_ACTIVE;
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.DIGESTDOCK_YOUTUBE_ACTIVE, first);
  assert.equal(first.apiVersion, 1);
});

test("returns the frozen product contract after a typical 1 + 1 manual success", async () => {
  const calls = [];
  const result = await active.run(
    {
      runId: "generation-7",
      videoId: VIDEO_ID,
      language: "en",
      trackKind: "manual-first",
    },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        assertSafeFetch(init);
        if (String(url).includes("/youtubei/v1/player")) {
          assert.equal(init.method, "POST");
          assert.equal(JSON.parse(init.body).videoId, VIDEO_ID);
          return response(playerBody([manualTrack(), asrTrack()]));
        }
        assert.equal(init.method, "GET");
        return response(
          json3(
            { text: "Hello &amp; welcome", start: 0, duration: 1.25 },
            { text: "Second line", start: 65, duration: 2 },
          ),
        );
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(result.providerId, "youtube-active");
  assert.equal(result.providerVariant, "isolated-tab-ios-json3");
  assert.equal(result.runId, "generation-7");
  assert.equal(result.videoId, VIDEO_ID);
  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.errorCode, null);
  assert.equal(result.language, "en");
  assert.equal(result.selectedTrack.kind, "manual");
  assert.equal(result.transcript.length, 2);
  assert.equal(result.text, "Hello & welcome Second line");
  assert.equal(
    result.timestamped,
    "[0:00] Hello & welcome\n[1:05] Second line",
  );
  assert.deepEqual(result.diagnostics.providerInitiated, {
    youtubePlayer: 1,
    youtubeTimedtext: 1,
    thirdParty: 0,
    loopback: 0,
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /never-persist-this|\/api\/timedtext\?/);
});

test("selects an ASR track without silently crossing the requested kind", async () => {
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "asr" },
    {
      fetchImpl: async (url) =>
        String(url).includes("/youtubei/v1/player")
          ? response(playerBody([manualTrack(), asrTrack()]))
          : response(json3({ text: "Generated", start: 4320, duration: 2 })),
    },
  );
  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(result.selectedTrack.kind, "asr");
  assert.equal(result.transcript[0].start, 4320);
  assert.equal(result.timestamped, "[72:00] Generated");
});

test("an empty json3 body stops without trying another format", async () => {
  let timedtextCalls = 0;
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual" },
    {
      fetchImpl: async (url) => {
        if (String(url).includes("/youtubei/v1/player")) {
          return response(playerBody([manualTrack()]));
        }
        timedtextCalls += 1;
        return response("");
      },
    },
  );
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "EMPTY_TRANSCRIPT");
  assert.equal(result.transcript.length, 0);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 1);
  assert.equal(timedtextCalls, 1);
});

test("uses only the first fixed player client and confirms a missing language", async () => {
  const clients = Array.from({ length: 6 }, (_, index) => ({
    id: `CLIENT_${index}`,
    clientName: "IOS",
    clientVersion: "1",
    clientHeader: "5",
    context: {},
  }));
  const result = await active.run(
    { videoId: VIDEO_ID, language: "fr", trackKind: "manual" },
    {
      clients,
      fetchImpl: async () => response(playerBody([manualTrack("en")])),
    },
  );

  assert.equal(result.status, "CONFIRMED_UNAVAILABLE");
  assert.equal(result.errorCode, "TRACK_UNAVAILABLE");
  assert.equal(result.transcript.length, 0);
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 0);
  assert.equal(result.diagnostics.attempts.length, 1);
});

test("confirms no transcript after the one fixed playable client", async () => {
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual-first" },
    { fetchImpl: async () => response(playerBody([])) },
  );
  assert.equal(result.status, "CONFIRMED_UNAVAILABLE");
  assert.equal(result.errorCode, "NO_TRANSCRIPT");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 0);
});

test("does not use caption URLs returned with restricted playability", async () => {
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual" },
    {
      fetchImpl: async (url) => {
        assert.match(String(url), /\/youtubei\/v1\/player/);
        return response(playerBody([manualTrack()], "LOGIN_REQUIRED"));
      },
    },
  );
  assert.equal(result.status, "CONFIRMED_UNAVAILABLE");
  assert.equal(result.errorCode, "LOGIN_REQUIRED");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 0);
});

test("chooses one track and stops after the one json3 timedtext request", async () => {
  const requestedUrls = [];
  const firstUrl = `${CAPTION_URL}&track=first`;
  const secondUrl = `${CAPTION_URL}&track=second`;
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual" },
    {
      fetchImpl: async (url) => {
        if (String(url).includes("/youtubei/v1/player")) {
          return response(
            playerBody([
              manualTrack("en", firstUrl),
              manualTrack("en", secondUrl),
            ]),
          );
        }
        requestedUrls.push(String(url));
        return response("");
      },
    },
  );

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "EMPTY_TRANSCRIPT");
  assert.equal(result.selectedTrack.kind, "manual");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 1);
  assert.equal(requestedUrls.length, 1);
  assert.equal(requestedUrls.every((url) => url.includes("track=first")), true);
  assert.equal(requestedUrls.some((url) => url.includes("track=second")), false);
});

test("never advances to another client when the fixed IOS track is unavailable", async () => {
  let playerCalls = 0;
  const result = await active.run(
    { videoId: VIDEO_ID, language: "fr", trackKind: "manual" },
    {
      fetchImpl: async (url) => {
        if (String(url).includes("/youtubei/v1/player")) {
          playerCalls += 1;
          return response(
            playerBody([manualTrack("en")]),
          );
        }
        return response("");
      },
    },
  );
  assert.equal(result.status, "CONFIRMED_UNAVAILABLE");
  assert.equal(result.errorCode, "TRACK_UNAVAILABLE");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 0);
  assert.equal(playerCalls, 1);
});

test("stops on a player 429 before headers or body are read", async () => {
  let headerReads = 0;
  let bodyReads = 0;
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual" },
    {
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        headers: {
          get() {
            headerReads += 1;
            throw new Error("429 headers must not be read");
          },
        },
        async text() {
          bodyReads += 1;
          throw new Error("429 body must not be read");
        },
      }),
    },
  );

  assert.equal(result.status, "RATE_LIMITED");
  assert.equal(result.errorCode, "RATE_LIMITED");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 0);
  assert.equal(headerReads, 0);
  assert.equal(bodyReads, 0);
});

test("a simultaneous page change cannot hide a returned 429", async () => {
  let currentVideoId = VIDEO_ID;
  let bodyReads = 0;
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual" },
    {
      getCurrentVideoId: () => currentVideoId,
      fetchImpl: async () => {
        currentVideoId = "dQw4w9WgXcQ";
        return {
          ok: false,
          status: 429,
          headers: { get: () => { throw new Error("do not read headers"); } },
          async text() {
            bodyReads += 1;
            throw new Error("do not read body");
          },
        };
      },
    },
  );
  assert.equal(result.status, "RATE_LIMITED");
  assert.equal(result.errorCode, "RATE_LIMITED");
  assert.equal(bodyReads, 0);
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
});

test("stops on a timedtext 429 before its body and all later formats", async () => {
  let bodyReads = 0;
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual" },
    {
      fetchImpl: async (url) => {
        if (String(url).includes("/youtubei/v1/player")) {
          return response(playerBody([manualTrack()]));
        }
        return {
          ok: false,
          status: 429,
          headers: { get: () => { throw new Error("do not read headers"); } },
          async text() {
            bodyReads += 1;
            throw new Error("do not read body");
          },
        };
      },
    },
  );

  assert.equal(result.status, "RATE_LIMITED");
  assert.equal(result.errorCode, "RATE_LIMITED");
  assert.equal(result.selectedTrack.kind, "manual");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 1);
  assert.equal(bodyReads, 0);
});

test("enforces the 8 MiB response ceiling before text()", async () => {
  let bodyReads = 0;
  const tooLarge = {
    ok: true,
    status: 200,
    headers: { get: () => String(8 * 1024 * 1024 + 1) },
    async text() {
      bodyReads += 1;
      return "must not be read";
    },
  };
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual" },
    { fetchImpl: async () => tooLarge },
  );
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PROBE_FAILED");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.equal(bodyReads, 0);
});

test("uses a fixed 15 second abort timer and maps timeouts to a technical failure", async () => {
  const delays = [];
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual" },
    {
      setTimeout(callback, delay) {
        delays.push(delay);
        queueMicrotask(callback);
        return delays.length;
      },
      clearTimeout() {},
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    },
  );

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PROBE_FAILED");
  assert.equal(result.diagnostics.providerInitiated.youtubePlayer, 1);
  assert.deepEqual(delays, [15_000]);
});

test("a mid-run SPA change stops before any later Active request", async () => {
  let currentVideoId = VIDEO_ID;
  let calls = 0;
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual-first" },
    {
      getCurrentVideoId: () => currentVideoId,
      fetchImpl: async () => {
        calls += 1;
        const player = response(playerBody([manualTrack()]));
        return {
          ...player,
          async text() {
            currentVideoId = "dQw4w9WgXcQ";
            return playerBody([manualTrack()]);
          },
        };
      },
    },
  );

  assert.equal(result.status, "PAGE_CONTEXT_CHANGED");
  assert.equal(result.errorCode, "PAGE_CONTEXT_CHANGED");
  assert.equal(calls, 1);
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 0);
});

test("a newer run in the same tab cancels the older in-flight run", async () => {
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const first = active.run(
    { runId: "old", videoId: VIDEO_ID, language: "en" },
    {
      getCurrentVideoId: () => VIDEO_ID,
      fetchImpl: async (_url, init) => {
        firstStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      },
    },
  );
  await started;

  let secondCalls = 0;
  const second = active.run(
    { runId: "new", videoId: VIDEO_ID, language: "en" },
    {
      getCurrentVideoId: () => VIDEO_ID,
      fetchImpl: async (url) => {
        secondCalls += 1;
        return String(url).includes("/youtubei/v1/player")
          ? response(playerBody([manualTrack()]))
          : response(json3({ text: "fresh", start: 0, duration: 1 }));
      },
    },
  );

  const [oldResult, newResult] = await Promise.all([first, second]);
  assert.equal(oldResult.status, "PAGE_CONTEXT_CHANGED");
  assert.equal(oldResult.errorCode, "PAGE_CONTEXT_CHANGED");
  assert.equal(newResult.status, "HAVE_TRANSCRIPT");
  assert.equal(newResult.runId, "new");
  assert.equal(secondCalls, 2);
});

test("product Active is fixed to IOS plus json3 and preserves timer receivers", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "youtube-transcript-active.js"),
    "utf8",
  );
  assert.match(source, /clientName:\s*"IOS"/);
  assert.match(source, /Object\.freeze\(\{ id: "json3", parser: parseJson3 \}\)/);
  assert.doesNotMatch(source, /ANDROID_VR|clientName:\s*"MWEB"|clientName:\s*"ANDROID"/);
  assert.doesNotMatch(source, /id:\s*"srv3"|id:\s*"classic"/);

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
    fetchImpl: async (url) =>
      String(url).includes("/youtubei/v1/player")
        ? response(playerBody([manualTrack()]))
        : response(json3({ text: "fixed route", start: 0, duration: 1 })),
  };
  const result = await active.run(
    { videoId: VIDEO_ID, language: "en", trackKind: "manual" },
    deps,
  );
  assert.equal(result.status, "HAVE_TRANSCRIPT");
  assert.equal(scheduled, 2);
  assert.equal(cleared, 2);
});

test("invalid input performs no network work and source has no credential APIs", async () => {
  let calls = 0;
  const result = await active.run(
    { runId: 12, videoId: "bad", language: "en", trackKind: "manual" },
    { fetchImpl: async () => { calls += 1; } },
  );
  assert.equal(result.runId, 12);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PROBE_FAILED");
  assert.equal(calls, 0);

  const source = fs.readFileSync(
    path.join(__dirname, "..", "youtube-transcript-active.js"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /chrome\.cookies|document\.cookie|localStorage|sessionStorage|Authorization\s*:/,
  );
});
