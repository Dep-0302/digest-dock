const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const verifier = require("../verifier.js");

function response(body, status = 200, headers = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) || null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const customClients = [
  {
    id: "FIRST",
    clientName: "FIRST",
    clientVersion: "1.0",
    clientHeader: "1",
    context: {},
  },
  {
    id: "SECOND",
    clientName: "SECOND",
    clientVersion: "2.0",
    clientHeader: "2",
    context: {},
  },
];

test("parses only standard HTTPS YouTube watch URLs", () => {
  assert.deepEqual(
    verifier.parseVideoUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=2"),
    {
      videoId: "jNQXAC9IVRw",
      canonicalUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    },
  );
  for (const invalid of [
    "http://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://m.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/shorts/jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=too-short",
  ]) {
    assert.throws(() => verifier.parseVideoUrl(invalid), verifier.VerifierError);
  }
});

test("selects exact language and requested manual or ASR kind without cross-language fallback", () => {
  const tracks = [
    { languageCode: "fr", vssId: ".fr", baseUrl: "https://www.youtube.com/api/timedtext?v=x" },
    { languageCode: "en", vssId: "a.en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=x" },
    { languageCode: "en", vssId: ".en", baseUrl: "https://www.youtube.com/api/timedtext?v=x" },
  ];
  assert.equal(verifier.chooseTrack(tracks, "en", "manual"), tracks[2]);
  assert.equal(verifier.chooseTrack(tracks, "en", "asr"), tracks[1]);
  assert.equal(verifier.chooseTrack(tracks, "en", "manual-first"), tracks[2]);
  assert.equal(verifier.chooseTrack(tracks, "ja", "any"), null);
  assert.deepEqual(
    verifier.chooseTracks(tracks, "en", "manual-first"),
    [tracks[2], tracks[1]],
  );
});

test("caption URLs require exact HTTPS YouTube timedtext host and path", () => {
  const normalized = verifier.normalizeCaptionUrl(
    "https://www.youtube.com/api/timedtext?v=abc&signature=secret",
    "json3",
  );
  assert.equal(new URL(normalized).searchParams.get("fmt"), "json3");
  for (const invalid of [
    "http://www.youtube.com/api/timedtext?v=abc",
    "https://youtube.com/api/timedtext?v=abc",
    "https://www.youtube.com.evil.test/api/timedtext?v=abc",
    "https://www.youtube.com/watch?v=abc",
    "https://user:pass@www.youtube.com/api/timedtext?v=abc",
  ]) {
    assert.throws(
      () => verifier.normalizeCaptionUrl(invalid),
      (error) => error.code === "UNTRUSTED_CAPTION_URL",
    );
  }
});

test("JSON3 and XML parsers normalize their distinct timestamp units to seconds", () => {
  const json3 = verifier.parseJson3(
    {
      events: [
        { tStartMs: 1250, dDurationMs: 500, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
      ],
    },
    "en",
  );
  assert.deepEqual(json3, [
    { text: "Hello world", start: 1.25, duration: 0.5, language: "en" },
  ]);

  const srv3 = verifier.parseXml(
    '<transcript><p t="2000" d="750"><s>你好</s><s> 世界</s></p></transcript>',
    "zh-CN",
  );
  assert.deepEqual(srv3, [
    { text: "你好 世界", start: 2, duration: 0.75, language: "zh-CN" },
  ]);

  const classic = verifier.parseXml(
    '<transcript><text start="3.5" dur="1.25">A &amp; B</text></transcript>',
    "en",
  );
  assert.deepEqual(classic, [
    { text: "A & B", start: 3.5, duration: 1.25, language: "en" },
  ]);
});

test("falls through clients until a matching track yields non-empty parseable text", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("youtubei.googleapis.com")) {
      const client = JSON.parse(options.body).context.client.clientName;
      return response({
        playabilityStatus: { status: "OK" },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: "en",
                vssId: ".en",
                baseUrl:
                  `https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&client=${client}&signature=secret`,
              },
            ],
          },
        },
      });
    }
    const parsed = new URL(String(url));
    if (parsed.searchParams.get("client") === "FIRST") return response("");
    return response({
      events: [
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "usable text" }] },
      ],
    });
  };

  const adapter = verifier.create({ fetchImpl, clients: customClients, timeoutMs: 0 });
  const result = await adapter.verifyVideo(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    { language: "en", mode: "manual" },
  );

  assert.equal(result.sourceAttempt, "SECOND");
  assert.equal(result.transcript.length, 1);
  assert.equal(result.diagnostics.attempts[0].outcome, "empty-caption-body");
  assert.equal(result.diagnostics.attempts[1].outcome, "transcript");
  assert.equal(calls.every((call) => call.options.credentials === "omit"), true);
  assert.equal(
    calls.some((call) => Object.keys(call.options.headers).some((key) => /user-agent|origin/i.test(key))),
    false,
  );
  const serialized = JSON.stringify(result.diagnostics);
  assert.equal(serialized.includes("signature"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("usable text"), false);
});

test("manual-first falls back to same-language ASR only after the manual body is empty", async () => {
  const fetchImpl = async (url, options) => {
    if (String(url).includes("youtubei.googleapis.com")) {
      return response({
        playabilityStatus: { status: "OK" },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: "en",
                vssId: ".en",
                baseUrl: "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&track=manual",
              },
              {
                languageCode: "en",
                vssId: "a.en",
                kind: "asr",
                baseUrl: "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&track=asr",
              },
            ],
          },
        },
      });
    }
    const track = new URL(String(url)).searchParams.get("track");
    if (track === "manual") return response("");
    return response({
      events: [
        { tStartMs: 500, dDurationMs: 1000, segs: [{ utf8: "ASR fallback" }] },
      ],
    });
  };
  const adapter = verifier.create({
    fetchImpl,
    clients: [customClients[0]],
    timeoutMs: 0,
  });
  const result = await adapter.verifyVideo(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    { language: "en", mode: "manual-first" },
  );
  assert.equal(result.selectedTrack.kind, "asr");
  assert.equal(result.diagnostics.attempts[0].formats[0].trackKind, "manual");
  assert.equal(
    result.diagnostics.attempts[0].formats.some(
      (item) => item.trackKind === "asr" && item.segmentCount === 1,
    ),
    true,
  );
});

test("distinguishes missing requested language from videos with no tracks", async () => {
  const playerWithFrench = response({
    playabilityStatus: { status: "OK" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            languageCode: "fr",
            vssId: ".fr",
            baseUrl: "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw",
          },
        ],
      },
    },
  });
  const missing = verifier.create({
    fetchImpl: async () => playerWithFrench,
    clients: [customClients[0]],
    timeoutMs: 0,
  });
  await assert.rejects(
    missing.verifyVideo("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
      language: "en",
      mode: "manual-first",
    }),
    (error) => error.code === "TRACK_UNAVAILABLE",
  );

  const noTracks = verifier.create({
    fetchImpl: async () =>
      response({ playabilityStatus: { status: "OK" }, captions: {} }),
    clients: [customClients[0]],
    timeoutMs: 0,
  });
  await assert.rejects(
    noTracks.verifyVideo("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
    (error) => error.code === "NO_TRANSCRIPT",
  );
});

test("does not misclassify transport and non-playable failures as no transcript", async () => {
  const failedProbe = verifier.create({
    fetchImpl: async () => {
      throw new Error("network down");
    },
    clients: [customClients[0]],
    timeoutMs: 0,
  });
  await assert.rejects(
    failedProbe.verifyVideo("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
    (error) => error.code === "PROBE_FAILED",
  );

  const unavailable = verifier.create({
    fetchImpl: async () =>
      response({ playabilityStatus: { status: "UNPLAYABLE" }, captions: {} }),
    clients: [customClients[0]],
    timeoutMs: 0,
  });
  await assert.rejects(
    unavailable.verifyVideo("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
    (error) => error.code === "VIDEO_UNAVAILABLE",
  );
});

test("bounded fetch enforces declared size and timeout while omitting credentials", async () => {
  await assert.rejects(
    verifier.fetchBoundedText("https://youtubei.googleapis.com/youtubei/v1/player", {
      fetchImpl: async () => response("small", 200, { "content-length": "999" }),
      timeoutMs: 0,
      maxResponseBytes: 10,
    }),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );

  const chunks = [new Uint8Array(8), new Uint8Array(8)];
  await assert.rejects(
    verifier.fetchBoundedText("https://youtubei.googleapis.com/youtubei/v1/player", {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () =>
              chunks.length ? { done: false, value: chunks.shift() } : { done: true },
            cancel: async () => {},
            releaseLock: () => {},
          }),
        },
      }),
      timeoutMs: 0,
      maxResponseBytes: 10,
    }),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );

  await assert.rejects(
    verifier.fetchBoundedText("https://youtubei.googleapis.com/youtubei/v1/player", {
      fetchImpl: (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
      timeoutMs: 5,
      maxResponseBytes: 1024,
    }),
    (error) => error.code === "TIMEOUT",
  );
});

test("manifest and popup keep permissions and diagnostic persistence minimal", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const source = ["verifier.js", "popup.js"]
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");

  assert.deepEqual(manifest.permissions, ["activeTab"]);
  assert.equal(manifest.host_permissions.includes("*://*/*"), false);
  assert.doesNotMatch(source, /chrome\.cookies|chrome\.storage|credentials:\s*["']include/);
  assert.doesNotMatch(source, /headers\s*:\s*\{[^}]*["'](?:User-Agent|Origin)["']/s);
  assert.match(source, /credentials:\s*["']omit/);
});
