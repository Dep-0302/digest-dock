const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const youtube = require("../youtube-transcript.js");

function response(body, status = 200, headers = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalized.get(String(name).toLowerCase()) || null;
      },
    },
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
  };
}

function playerResponse({ status = "OK", tracks = [] } = {}) {
  return response({
    playabilityStatus: { status },
    captions: {
      playerCaptionsTracklistRenderer: { captionTracks: tracks },
    },
  });
}

function track({
  languageCode = "en",
  kind,
  name,
  baseUrl = "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw",
  isDefault = false,
} = {}) {
  return {
    languageCode,
    ...(kind ? { kind } : {}),
    name: { simpleText: name || languageCode },
    baseUrl,
    isDefault,
    vssId: kind === "asr" ? `a.${languageCode}` : `.${languageCode}`,
  };
}

function json3(text = "caption text", start = 1000, duration = 2000) {
  return {
    events: [
      {
        tStartMs: start,
        dDurationMs: duration,
        segs: [{ utf8: text }],
      },
    ],
  };
}

const ONE_CLIENT = [
  {
    id: "TEST",
    clientName: "TEST",
    clientVersion: "1.0",
    clientHeader: "1",
    context: {},
  },
];

test("exports the browser global and CommonJS adapter with the fixed client order", () => {
  assert.deepEqual(
    youtube.CLIENT_PROFILES.map((profile) => profile.id),
    ["IOS", "ANDROID_VR", "MWEB", "ANDROID"],
  );
  assert.equal(
    youtube.PLAYER_ENDPOINT,
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
  );
  assert.equal(youtube.DEFAULT_TIMEOUT_MS, 15_000);
  assert.equal(youtube.DEFAULT_MAX_RESPONSE_BYTES, 8 * 1024 * 1024);

  const source = fs.readFileSync(
    path.join(__dirname, "..", "youtube-transcript.js"),
    "utf8",
  );
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  assert.equal(typeof sandbox.YOUTUBE_TRANSCRIPT_ADAPTER.fetchTranscript, "function");
  assert.equal(typeof youtube.fetchTranscript, "function");
});

test("track selection is manual-first, default-aware, and never crosses primary language", () => {
  const tracks = [
    track({ languageCode: "fr", name: "French" }),
    track({ languageCode: "en", kind: "asr", name: "English ASR" }),
    track({ languageCode: "en-US", name: "English US", isDefault: true }),
    track({ languageCode: "en", name: "English" }),
  ];

  assert.equal(
    youtube.chooseTrack(tracks, "en-GB", "manual-first"),
    tracks[2],
    "same-primary manual default should win when the exact tag is absent",
  );
  assert.equal(
    youtube.chooseTrack(tracks, "en", "manual-first"),
    tracks[3],
    "manual-first outranks an exact-language ASR track",
  );
  assert.equal(youtube.chooseTrack(tracks, "en", "asr"), tracks[1]);
  assert.equal(youtube.chooseTrack(tracks, "ja", "manual-first"), null);

  const noPreference = [
    track({ languageCode: "fr", name: "first manual" }),
    track({ languageCode: "en", kind: "asr", isDefault: true }),
    track({ languageCode: "ja", name: "default manual", isDefault: true }),
  ];
  assert.equal(
    youtube.chooseTrack(noPreference, "", "manual-first"),
    noPreference[2],
    "without a language, the default manual track should be tried first",
  );
});

test("caption URLs require the exact HTTPS YouTube timedtext host and path", () => {
  const normalized = youtube.normalizeCaptionUrl(
    "https://www.youtube.com/api/timedtext?v=abc&signature=top-secret",
    "json3",
  );
  assert.equal(new URL(normalized).searchParams.get("fmt"), "json3");

  for (const invalid of [
    "http://www.youtube.com/api/timedtext?v=abc",
    "https://youtube.com/api/timedtext?v=abc",
    "https://m.youtube.com/api/timedtext?v=abc",
    "https://www.youtube.com.evil.example/api/timedtext?v=abc",
    "https://www.youtube.com/watch?v=abc",
    "https://www.youtube.com/api/timedtext/extra?v=abc",
    "https://user:pass@www.youtube.com/api/timedtext?v=abc",
    "https://www.youtube.com:444/api/timedtext?v=abc",
  ]) {
    assert.throws(
      () => youtube.normalizeCaptionUrl(invalid),
      (error) => error.code === "UNTRUSTED_CAPTION_URL",
      invalid,
    );
  }
});

test("JSON3, srv3, and classic XML normalize their timestamp units to seconds", () => {
  assert.deepEqual(
    youtube.parseJson3(
      {
        events: [
          {
            tStartMs: 1250,
            dDurationMs: 500,
            segs: [{ utf8: ">> Hello" }, { utf8: " world" }],
          },
        ],
      },
      "en",
    ),
    [{ text: "Hello world", start: 1.25, duration: 0.5, language: "en" }],
  );

  assert.deepEqual(
    youtube.parseXml(
      '<transcript><p d="750" t="2000"><s>你好</s><s> 世界</s></p></transcript>',
      "zh-CN",
    ),
    [{ text: "你好 世界", start: 2, duration: 0.75, language: "zh-CN" }],
  );

  assert.deepEqual(
    youtube.parseXml(
      '<transcript><text dur="1.25" start="3.5">A &amp; B</text></transcript>',
      "en",
    ),
    [{ text: "A & B", start: 3.5, duration: 1.25, language: "en" }],
  );
});

test("PAGE captions short-circuit client probes and return only the shared safe contract", async () => {
  const calls = [];
  const signedUrl =
    "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&signature=top-secret&pot=private-token";
  const adapter = youtube.create({
    timeoutMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(json3(">> Hello page"));
    },
  });
  const result = await adapter.fetchTranscript({
    videoId: "jNQXAC9IVRw",
    captionTracks: [track({ baseUrl: signedUrl, isDefault: true })],
    preferredLanguage: "en",
    kind: "manual-first",
  });

  assert.deepEqual(Object.keys(result), [
    "transcript",
    "transcriptText",
    "transcriptTextTimestamped",
    "language",
    "selectedTrack",
    "sourceAttempt",
    "attempts",
  ]);
  assert.equal(result.sourceAttempt, "PAGE");
  assert.equal(result.transcriptText, "Hello page");
  assert.equal(result.transcriptTextTimestamped, "[0:01] Hello page");
  assert.equal(result.selectedTrack.isDefault, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
  assert.equal(
    Object.keys(calls[0].options.headers).some((name) =>
      /user-agent|origin/i.test(name),
    ),
    false,
  );

  const returned = JSON.stringify(result);
  for (const secret of ["signature", "top-secret", "pot", "private-token", "baseUrl"]) {
    assert.equal(returned.includes(secret), false, secret);
  }
});

test("caption formats fall through in JSON3, srv3, classic order until text is non-empty", async () => {
  const formats = [];
  const adapter = youtube.create({
    clients: [],
    timeoutMs: 0,
    fetchImpl: async (url) => {
      const format = new URL(String(url)).searchParams.get("fmt") || "classic";
      formats.push(format);
      if (format === "json3") return response({ events: [] });
      if (format === "srv3") {
        return response('<transcript><p t="2000" d="1000"><s>srv3 text</s></p></transcript>');
      }
      throw new Error("classic should not be reached");
    },
  });

  const result = await adapter.fetchTranscript({
    videoId: "jNQXAC9IVRw",
    captionTracks: [track()],
    preferredLanguage: "en",
  });
  assert.deepEqual(formats, ["json3", "srv3"]);
  assert.equal(result.transcriptText, "srv3 text");
  assert.deepEqual(
    result.attempts[0].formats.map((item) => item.format),
    ["json3", "srv3"],
  );
});

test("manual-first exhausts the matching manual body before same-language ASR", async () => {
  const calls = [];
  const adapter = youtube.create({
    clients: [],
    timeoutMs: 0,
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      calls.push({
        track: parsed.searchParams.get("track"),
        format: parsed.searchParams.get("fmt") || "classic",
      });
      if (parsed.searchParams.get("track") === "manual") return response("");
      return response(json3("ASR fallback"));
    },
  });

  const result = await adapter.fetchTranscript({
    videoId: "jNQXAC9IVRw",
    captionTracks: [
      track({
        baseUrl:
          "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&track=manual",
      }),
      track({
        kind: "asr",
        baseUrl:
          "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&track=asr",
      }),
    ],
    preferredLanguage: "en-US",
    kind: "manual-first",
  });

  assert.deepEqual(calls, [
    { track: "manual", format: "json3" },
    { track: "manual", format: "srv3" },
    { track: "manual", format: "classic" },
    { track: "asr", format: "json3" },
  ]);
  assert.equal(result.selectedTrack.kind, "asr");
  assert.equal(result.transcriptText, "ASR fallback");
});

test("a failed PAGE attempt probes IOS, ANDROID_VR, MWEB, then ANDROID", async () => {
  const playerClients = [];
  const calls = [];
  const adapter = youtube.create({
    timeoutMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url) === youtube.PLAYER_ENDPOINT) {
        const client = JSON.parse(options.body).context.client.clientName;
        playerClients.push(client);
        if (client !== "ANDROID") return playerResponse({ tracks: [] });
        return playerResponse({
          tracks: [
            track({
              baseUrl:
                "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&client=ANDROID",
            }),
          ],
        });
      }
      return response(json3("Android result"));
    },
  });

  const result = await adapter.fetchTranscript({
    videoId: "jNQXAC9IVRw",
    captionTracks: [],
    preferredLanguage: "en",
  });

  assert.deepEqual(playerClients, ["IOS", "ANDROID_VR", "MWEB", "ANDROID"]);
  assert.equal(result.sourceAttempt, "ANDROID");
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.sourceAttempt),
    ["PAGE", "IOS", "ANDROID_VR", "MWEB", "ANDROID"],
  );
  assert.equal(calls.every((call) => call.options.credentials === "omit"), true);
});

test("public failures keep transport, access, availability, language, and empty-body states distinct", async (t) => {
  const cases = [
    {
      name: "probe failed",
      code: "PROBE_FAILED",
      input: { videoId: "jNQXAC9IVRw" },
      adapter: youtube.create({
        clients: ONE_CLIENT,
        timeoutMs: 0,
        fetchImpl: async () => response("bad gateway", 502),
      }),
    },
    {
      name: "login required",
      code: "LOGIN_REQUIRED",
      input: { videoId: "jNQXAC9IVRw" },
      adapter: youtube.create({
        clients: ONE_CLIENT,
        timeoutMs: 0,
        fetchImpl: async () => playerResponse({ status: "LOGIN_REQUIRED" }),
      }),
    },
    {
      name: "video unavailable",
      code: "VIDEO_UNAVAILABLE",
      input: { videoId: "jNQXAC9IVRw" },
      adapter: youtube.create({
        clients: ONE_CLIENT,
        timeoutMs: 0,
        fetchImpl: async () => playerResponse({ status: "UNPLAYABLE" }),
      }),
    },
    {
      name: "no transcript",
      code: "NO_TRANSCRIPT",
      input: { videoId: "jNQXAC9IVRw", captionTracks: [] },
      adapter: youtube.create({ clients: [], timeoutMs: 0, fetchImpl: async () => response("") }),
    },
    {
      name: "requested track unavailable",
      code: "TRACK_UNAVAILABLE",
      input: {
        videoId: "jNQXAC9IVRw",
        captionTracks: [track({ languageCode: "fr" })],
        preferredLanguage: "ja",
      },
      adapter: youtube.create({ clients: [], timeoutMs: 0, fetchImpl: async () => response("") }),
    },
    {
      name: "empty transcript",
      code: "EMPTY_TRANSCRIPT",
      input: {
        videoId: "jNQXAC9IVRw",
        captionTracks: [track({ languageCode: "en" })],
        preferredLanguage: "en",
      },
      adapter: youtube.create({ clients: [], timeoutMs: 0, fetchImpl: async () => response("") }),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await assert.rejects(
        item.adapter.fetchTranscript(item.input),
        (error) => {
          assert.equal(error.code, item.code);
          assert.equal(Array.isArray(error.attempts), true);
          assert.equal(youtube.PUBLIC_ERROR_CODES.has(error.code), true);
          return true;
        },
      );
    });
  }
});

test("untrusted signed URLs are reduced to a safe attempt error", async () => {
  const marker = "do-not-return-this-token";
  const adapter = youtube.create({
    clients: [],
    timeoutMs: 0,
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });
  await assert.rejects(
    adapter.fetchTranscript({
      videoId: "jNQXAC9IVRw",
      captionTracks: [
        track({
          baseUrl: `https://evil.example/api/timedtext?token=${marker}`,
        }),
      ],
      preferredLanguage: "en",
    }),
    (error) => {
      assert.equal(error.code, "EMPTY_TRANSCRIPT");
      const serialized = JSON.stringify(error.attempts);
      assert.equal(serialized.includes(marker), false);
      assert.equal(serialized.includes("evil.example"), false);
      assert.equal(serialized.includes("token"), false);
      assert.match(serialized, /UNTRUSTED_CAPTION_URL/);
      return true;
    },
  );
});

test("bounded requests stream-enforce the byte limit and abort at the timeout", async () => {
  const chunks = [new Uint8Array(8), new Uint8Array(8)];
  await assert.rejects(
    youtube.fetchBoundedText("https://www.youtube.com/api/timedtext", {
      fetchImpl: async (_url, options) => {
        assert.equal(options.credentials, "omit");
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: async () =>
                chunks.length
                  ? { done: false, value: chunks.shift() }
                  : { done: true },
              cancel: async () => {},
              releaseLock: () => {},
            }),
          },
        };
      },
      timeoutMs: 0,
      maxResponseBytes: 10,
    }),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );

  await assert.rejects(
    youtube.fetchBoundedText("https://www.youtube.com/api/timedtext", {
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
