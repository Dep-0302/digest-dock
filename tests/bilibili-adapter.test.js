const test = require("node:test");
const assert = require("node:assert/strict");

const bilibili = require("../bilibili.js");

function jsonResponse(data, status = 200, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) || null;
      },
    },
    text: async () => JSON.stringify(data),
  };
}

function mediaRef(overrides = {}) {
  return {
    platform: "bilibili",
    bvid: "BV1e3411j7ZM",
    aid: 42,
    cid: 100,
    page: 1,
    mediaKey: "bilibili:BV1e3411j7ZM:100",
    canonicalUrl: "https://www.bilibili.com/video/BV1e3411j7ZM/",
    ...overrides,
  };
}

test("recognizes only standard HTTPS www.bilibili.com BV URLs and their part", () => {
  assert.equal(
    bilibili.parseBilibiliVideoUrl,
    bilibili.parseVideoUrl,
    "the integration-facing parser name must remain stable",
  );
  assert.deepEqual(
    bilibili.parseBilibiliVideoUrl(
      "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2&spm_id_from=test#reply",
    ),
    {
      bvid: "BV1e3411j7ZM",
      page: 2,
      canonicalUrl: "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2",
    },
  );

  for (const invalid of [
    "http://www.bilibili.com/video/BV1e3411j7ZM/",
    "https://bilibili.com/video/BV1e3411j7ZM/",
    "https://www.bilibili.com/bangumi/play/ep1",
    "https://www.bilibili.com/video/BV1e3411j7ZM/extra",
  ]) {
    assert.throws(
      () => bilibili.parseBilibiliVideoUrl(invalid),
      (error) => error.code === "UNSUPPORTED_URL",
    );
  }
  for (const invalidPage of ["0", "-1", "1.5", "two"]) {
    assert.throws(
      () =>
        bilibili.parseBilibiliVideoUrl(
          `https://www.bilibili.com/video/BV1e3411j7ZM/?p=${invalidPage}`,
        ),
      (error) => error.code === "INVALID_PAGE",
    );
  }
});

test("resolveMedia selects the current part and returns a stable media reference", async () => {
  const calls = [];
  const adapter = bilibili.create({
    timeoutMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        code: 0,
        data: {
          aid: 42,
          cid: 100,
          bvid: "BV1e3411j7ZM",
          title: "完整标题",
          desc: "视频简介",
          owner: { name: "创作者" },
          pages: [
            { page: 1, cid: 100, part: "第一P", duration: 60 },
            { page: 2, cid: 200, part: "第二P", duration: 90 },
          ],
        },
      });
    },
  });

  const result = await adapter.resolveMedia(
    "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2&from=search",
  );

  assert.equal(result.aid, 42);
  assert.equal(result.cid, 200);
  assert.equal(result.page, 2);
  assert.equal(result.mediaKey, "bilibili:BV1e3411j7ZM:200");
  assert.equal(
    result.canonicalUrl,
    "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2",
  );
  assert.deepEqual(result.metadata, {
    title: "完整标题",
    channelName: "创作者",
    creator: "创作者",
    description: "视频简介",
    descriptionStatus: "present",
    duration: 90,
    partTitle: "第二P",
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/x\/web-interface\/view\?bvid=BV1e3411j7ZM$/);
  assert.equal(calls[0].options.credentials, "include");
});

test("timestampUrl preserves the selected part and replaces browsing parameters", () => {
  assert.equal(
    bilibili.timestampUrl(mediaRef({ page: 1 }), 65.9),
    "https://www.bilibili.com/video/BV1e3411j7ZM/?t=65",
  );
  assert.equal(
    bilibili.timestampUrl(mediaRef({ page: 3 }), 125),
    "https://www.bilibili.com/video/BV1e3411j7ZM/?p=3&t=125",
  );
  assert.equal(
    bilibili.timestampUrl(
      "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2&spm_id_from=test",
      -10,
    ),
    "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2&t=0",
  );
});

test("track selection prefers human Chinese, then AI Chinese, then another track", () => {
  const english = {
    lan: "en",
    lan_doc: "English",
    subtitle_url: "//aisubtitle.hdslb.com/en.json",
  };
  const aiChinese = {
    lan: "ai-zh",
    lan_doc: "中文（AI）",
    ai_type: 1,
    subtitle_url: "//aisubtitle.hdslb.com/ai-zh.json",
  };
  const humanChinese = {
    lan: "zh-CN",
    lan_doc: "中文（中国）",
    ai_type: 0,
    ai_status: 0,
    subtitle_url: "//aisubtitle.hdslb.com/zh.json",
  };

  assert.equal(
    bilibili.chooseSubtitleTrack([english, aiChinese, humanChinese]),
    humanChinese,
  );
  assert.equal(
    bilibili.chooseSubtitleTrack([english, aiChinese]),
    aiChinese,
  );
  assert.equal(bilibili.chooseSubtitleTrack([english]), english);
  assert.equal(
    bilibili.readTrackUrl({
      subtitle_url: "  ",
      subtitle_url_v2: "//subtitle.bilibili.com/fallback.json",
    }),
    "//subtitle.bilibili.com/fallback.json",
  );
  assert.equal(
    bilibili.readTrackUrl({
      subtitle_url: "//aisubtitle.hdslb.com/verified.json",
      subtitle_url_v2: "//subtitle.bilibili.com/fallback.json",
    }),
    "//aisubtitle.hdslb.com/verified.json",
  );
});

test("Chinese language detection handles native and AI Bilibili language labels", () => {
  assert.equal(bilibili.isChineseLanguage("zh-CN"), true);
  assert.equal(bilibili.isChineseLanguage("ai-zh"), true);
  assert.equal(bilibili.isChineseLanguage({ lan: "zh-Hans" }), true);
  assert.equal(bilibili.isChineseLanguage({ lan_doc: "中文（自动生成）" }), true);
  assert.equal(bilibili.isChineseLanguage("English"), false);
  assert.equal(
    bilibili.normalizedTrackLanguage({ lan: "ai-zh", lan_doc: "中文（AI）" }),
    "zh-CN",
  );
  assert.equal(
    bilibili.normalizedTrackLanguage({ lan: "zh-CN", lan_doc: "中文" }),
    "zh-CN",
  );
  assert.equal(
    bilibili.normalizedTrackLanguage({ lan: "zh-TW", lan_doc: "繁體中文" }),
    "zh-TW",
  );
  assert.equal(
    bilibili.normalizedTrackLanguage({ lan: "zh", lan_doc: "繁體中文" }),
    "zh-Hant",
  );
});

test("subtitle URLs require trusted Bilibili HTTPS hosts", () => {
  for (const trusted of [
    [
      "//aisubtitle.hdslb.com/bfs/subtitle/a.json",
      "https://aisubtitle.hdslb.com/bfs/subtitle/a.json",
    ],
    [
      "https://subtitle.bilibili.com/bfs/subtitle/b.json",
      "https://subtitle.bilibili.com/bfs/subtitle/b.json",
    ],
    [
      "https://upos-sz-mirrorcos.bilivideo.com/subtitle/c.json",
      "https://upos-sz-mirrorcos.bilivideo.com/subtitle/c.json",
    ],
  ]) {
    assert.equal(bilibili.normalizeSubtitleUrl(trusted[0]), trusted[1]);
  }

  for (const untrusted of [
    "http://aisubtitle.hdslb.com/subtitle.json",
    "https://hdslb.com.evil.example/subtitle.json",
    "https://user:pass@subtitle.bilibili.com/subtitle.json",
    "https://subtitle.bilibili.com:444/subtitle.json",
    "javascript:alert(1)",
  ]) {
    assert.throws(
      () => bilibili.normalizeSubtitleUrl(untrusted),
      (error) => error.code === "NO_TRANSCRIPT",
    );
  }
});

test("resolveMedia and fetchTranscript keep credentials scoped and never expose signed URLs", async () => {
  const calls = [];
  const signedSubtitleUrl =
    "//subtitle.bilibili.com/bfs/subtitle/current.json?auth_key=top-secret";
  const adapter = bilibili.create({
    timeoutMs: 0,
    fetchImpl: async (url, options) => {
      const requestUrl = String(url);
      calls.push({ url: requestUrl, options });
      if (requestUrl.includes("/x/web-interface/view")) {
        return jsonResponse({
          code: 0,
          data: {
            aid: 42,
            title: "测试视频",
            desc: "简介",
            owner: { name: "测试作者" },
            pages: [
              { page: 1, cid: 100, part: "第一P", duration: 60 },
              { page: 2, cid: 200, part: "第二P", duration: 80 },
            ],
          },
        });
      }
      if (requestUrl.includes("/x/player/wbi/v2")) {
        return jsonResponse({
          code: 0,
          data: {
            need_login_subtitle: false,
            subtitle: {
              subtitles: [
                {
                  id_str: "ai-zh",
                  lan: "ai-zh",
                  lan_doc: "中文（AI）",
                  ai_type: 1,
                  subtitle_url: "//aisubtitle.hdslb.com/ai.json",
                },
                {
                  id_str: "human-zh",
                  lan: "zh-CN",
                  lan_doc: "中文（中国）",
                  subtitle_url: signedSubtitleUrl,
                },
              ],
            },
          },
        });
      }
      return jsonResponse({
        body: [
          { from: 2.75, to: 4, content: " 第二句话 " },
          { from: 0.25, to: 2.75, content: "第一   句话" },
          { from: 4, to: 3, content: "无效片段" },
        ],
      });
    },
  });

  const resolved = await adapter.resolveMedia(
    "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2",
  );
  const result = await adapter.fetchTranscript(resolved);

  assert.deepEqual(result.transcript, [
    { text: "第一 句话", start: 0.25, duration: 2.5, language: "zh-CN" },
    { text: "第二句话", start: 2.75, duration: 1.25, language: "zh-CN" },
  ]);
  assert.equal(result.transcriptText, "第一 句话 第二句话");
  assert.equal(
    result.transcriptTextTimestamped,
    "[0:00] 第一 句话\n[0:02] 第二句话",
  );
  assert.equal(result.language, "zh-CN");
  assert.equal(result.isChinese, true);
  assert.equal(result.selectedTrack.id, "human-zh");
  assert.equal(result.mediaKey, "bilibili:BV1e3411j7ZM:200");

  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[1].options.credentials, "include");
  assert.equal(calls[2].options.credentials, "omit");
  assert.match(calls[1].url, /cid=200/);
  assert.match(calls[1].url, /aid=42/);
  assert.match(calls[2].url, /auth_key=top-secret/);

  const serialized = JSON.stringify({ resolved, result });
  assert.equal(serialized.includes("subtitle_url"), false);
  assert.equal(serialized.includes("auth_key"), false);
  assert.equal(serialized.includes("top-secret"), false);
  assert.equal(Object.hasOwn(result.selectedTrack, "subtitle_url"), false);
  assert.equal(result.tracks.some((track) => "subtitle_url" in track), false);
});

test("fetchTranscript distinguishes login-required and no-transcript states", async () => {
  const loginAdapter = bilibili.create({
    timeoutMs: 0,
    fetchImpl: async () =>
      jsonResponse({
        code: 0,
        data: { need_login_subtitle: true, subtitle: { subtitles: [] } },
      }),
  });
  await assert.rejects(
    loginAdapter.fetchTranscript(mediaRef()),
    (error) => error.code === "LOGIN_REQUIRED",
  );

  const noTranscriptAdapter = bilibili.create({
    timeoutMs: 0,
    fetchImpl: async () =>
      jsonResponse({
        code: 0,
        data: { need_login_subtitle: false, subtitle: { subtitles: [] } },
      }),
  });
  await assert.rejects(
    noTranscriptAdapter.fetchTranscript(mediaRef()),
    (error) => error.code === "NO_TRANSCRIPT",
  );
});

test("fetchTranscript reports an empty subtitle body separately", async () => {
  let call = 0;
  const adapter = bilibili.create({
    timeoutMs: 0,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                {
                  lan: "zh-CN",
                  subtitle_url: "//subtitle.bilibili.com/empty.json",
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ body: [{ from: 2, to: 1, content: "invalid" }] });
    },
  });

  await assert.rejects(
    adapter.fetchTranscript(mediaRef()),
    (error) => error.code === "EMPTY_TRANSCRIPT",
  );
});

test("API failures and HTTP failures have stable, distinct error codes", async () => {
  const apiAdapter = bilibili.create({
    timeoutMs: 0,
    fetchImpl: async () => jsonResponse({ code: -400, message: "bad request" }),
  });
  await assert.rejects(
    apiAdapter.resolveMedia("https://www.bilibili.com/video/BV1e3411j7ZM/"),
    (error) => error.code === "API" && error.apiCode === -400,
  );

  const httpAdapter = bilibili.create({
    timeoutMs: 0,
    fetchImpl: async () => jsonResponse({}, 502),
  });
  await assert.rejects(
    httpAdapter.resolveMedia("https://www.bilibili.com/video/BV1e3411j7ZM/"),
    (error) => error.code === "HTTP" && error.status === 502,
  );

  const sessionAdapter = bilibili.create({
    timeoutMs: 0,
    fetchImpl: async () => jsonResponse({ code: -101, message: "not logged in" }),
  });
  await assert.rejects(
    sessionAdapter.resolveMedia("https://www.bilibili.com/video/BV1e3411j7ZM/"),
    (error) => error.code === "LOGIN_REQUIRED" && error.apiCode === -101,
  );
});

test("requests enforce timeout and response-size bounds", async () => {
  const timeoutAdapter = bilibili.create({
    timeoutMs: 10,
    fetchImpl: (_url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  await assert.rejects(
    timeoutAdapter.resolveMedia(
      "https://www.bilibili.com/video/BV1e3411j7ZM/",
    ),
    (error) => error.code === "TIMEOUT",
  );

  const largeAdapter = bilibili.create({
    timeoutMs: 0,
    maxResponseBytes: 32,
    fetchImpl: async () =>
      jsonResponse({ code: 0, data: { padding: "x".repeat(100) } }),
  });
  await assert.rejects(
    largeAdapter.resolveMedia(
      "https://www.bilibili.com/video/BV1e3411j7ZM/",
    ),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );
});
