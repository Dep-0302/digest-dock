const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const verifier = require("../poc/bilibili-subtitle-verifier/verifier.js");

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

test("parses a standard Bilibili BV URL and current part", () => {
  assert.deepEqual(
    verifier.parseBilibiliVideoUrl(
      "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2&spm_id_from=example",
    ),
    {
      bvid: "BV1e3411j7ZM",
      page: 2,
      canonicalUrl: "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2",
    },
  );

  assert.throws(
    () => verifier.parseBilibiliVideoUrl("https://www.bilibili.com/bangumi/play/ep1"),
    (error) => error.code === "UNSUPPORTED_URL",
  );
  assert.throws(
    () => verifier.parseBilibiliVideoUrl("https://www.bilibili.com/video/BV1e3411j7ZM?p=0"),
    (error) => error.code === "INVALID_PAGE",
  );
});

test("selects the requested part instead of the top-level P1 cid", () => {
  const part = verifier.selectVideoPart(
    {
      aid: 42,
      cid: 100,
      title: "Course",
      duration: 300,
      pages: [
        { page: 1, cid: 100, part: "P1", duration: 100 },
        { page: 2, cid: 200, part: "P2", duration: 120 },
      ],
    },
    2,
  );

  assert.deepEqual(part, {
    aid: 42,
    cid: 200,
    page: 2,
    partTitle: "P2",
    duration: 120,
  });
});

test("prefers human Chinese, then AI Chinese, then another usable track", () => {
  const tracks = [
    { lan: "en", lan_doc: "English", subtitle_url: "//aisubtitle.hdslb.com/en.json" },
    {
      lan: "ai-zh",
      lan_doc: "中文（自动生成）",
      ai_type: 1,
      subtitle_url: "//aisubtitle.hdslb.com/ai-zh.json",
    },
    {
      lan: "zh-CN",
      lan_doc: "中文（中国）",
      ai_type: 0,
      ai_status: 0,
      subtitle_url: "//aisubtitle.hdslb.com/zh.json",
    },
  ];

  assert.equal(verifier.chooseSubtitleTrack(tracks), tracks[2]);
  assert.equal(verifier.chooseSubtitleTrack(tracks.slice(0, 2)), tracks[1]);
});

test("uses the verified JSON subtitle URL and keeps subtitle_url_v2 as fallback", () => {
  assert.equal(
    verifier.readTrackUrl({
      subtitle_url: "//aisubtitle.hdslb.com/verified.json",
      subtitle_url_v2: "//subtitle.bilibili.com/fallback",
    }),
    "//aisubtitle.hdslb.com/verified.json",
  );
  assert.equal(
    verifier.readTrackUrl({ subtitle_url_v2: "//subtitle.bilibili.com/fallback" }),
    "//subtitle.bilibili.com/fallback",
  );
});

test("accepts trusted subtitle hosts and rejects deceptive hosts", () => {
  assert.equal(
    verifier.normalizeSubtitleUrl("//aisubtitle.hdslb.com/bfs/subtitle/sample.json"),
    "https://aisubtitle.hdslb.com/bfs/subtitle/sample.json",
  );
  assert.equal(
    verifier.normalizeSubtitleUrl("//subtitle.bilibili.com/bfs/subtitle/current.json"),
    "https://subtitle.bilibili.com/bfs/subtitle/current.json",
  );
  assert.throws(
    () => verifier.normalizeSubtitleUrl("https://hdslb.com.example.test/subtitle.json"),
    (error) => error.code === "UNTRUSTED_SUBTITLE_URL",
  );
  assert.throws(
    () => verifier.normalizeSubtitleUrl("http://aisubtitle.hdslb.com/subtitle.json"),
    (error) => error.code === "UNTRUSTED_SUBTITLE_URL",
  );
});

test("normalizes Bilibili body entries into the current transcript contract", () => {
  const normalized = verifier.normalizeSubtitleBody(
    {
      body: [
        { from: 0.25, to: 2.75, content: "  第一 句话  " },
        { from: 2.75, to: 4, content: "第二句话" },
        { from: 4, to: 3, content: "invalid" },
        { from: 5, to: 6, content: "   " },
      ],
    },
    "zh-CN",
  );

  assert.deepEqual(normalized.transcript, [
    { text: "第一 句话", start: 0.25, duration: 2.5, language: "zh-CN" },
    { text: "第二句话", start: 2.75, duration: 1.25, language: "zh-CN" },
  ]);
  assert.equal(normalized.transcriptText, "第一 句话 第二句话");
  assert.equal(
    normalized.transcriptTextTimestamped,
    "[0:00] 第一 句话\n[0:02] 第二句话",
  );
});

test("full verifier flow carries session only to Bilibili API and never returns subtitle URLs", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });

    if (String(url).includes("/x/web-interface/view")) {
      return jsonResponse({
        code: 0,
        data: {
          aid: 42,
          bvid: "BV1e3411j7ZM",
          title: "测试视频",
          owner: { name: "测试作者" },
          pages: [
            { page: 1, cid: 100, part: "第一P", duration: 60 },
            { page: 2, cid: 200, part: "第二P", duration: 80 },
          ],
        },
      });
    }

    if (String(url).includes("/x/player/wbi/v2")) {
      return jsonResponse({
        code: 0,
        data: {
          need_login_subtitle: false,
          subtitle: {
            subtitles: [
              {
                id_str: "human-zh",
                lan: "zh-CN",
                lan_doc: "中文（中国）",
                ai_type: 0,
                subtitle_url: "//subtitle.bilibili.com/bfs/subtitle/sample.json",
              },
            ],
          },
        },
      });
    }

    return jsonResponse({
      body: [
        { from: 0, to: 2, content: "开场" },
        { from: 2, to: 5, content: "核心内容" },
      ],
    });
  };

  const result = await verifier.verifyVideo(
    "https://www.bilibili.com/video/BV1e3411j7ZM/?p=2",
    { fetchImpl, timeoutMs: 0 },
  );

  assert.equal(result.media.cid, 200);
  assert.equal(result.media.mediaKey, "bilibili:BV1e3411j7ZM:200");
  assert.equal(result.selectedTrack.label, "中文（中国）");
  assert.equal(result.transcript.length, 2);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[1].options.credentials, "include");
  assert.equal(calls[2].options.credentials, "omit");
  assert.equal(calls[1].url.includes("cid=200"), true);
  assert.equal(JSON.stringify(result).includes("subtitle_url"), false);
  assert.equal(JSON.stringify(result).includes("sample.json"), false);
});

test("distinguishes login-required subtitles from videos with no subtitle track", async () => {
  const responses = [
    jsonResponse({
      code: 0,
      data: {
        aid: 42,
        title: "测试视频",
        pages: [{ page: 1, cid: 100, part: "P1", duration: 60 }],
      },
    }),
    jsonResponse({
      code: 0,
      data: { need_login_subtitle: true, subtitle: { subtitles: [] } },
    }),
  ];
  const fetchImpl = async () => responses.shift();

  await assert.rejects(
    verifier.verifyVideo("https://www.bilibili.com/video/BV1e3411j7ZM/", {
      fetchImpl,
      timeoutMs: 0,
    }),
    (error) => error.code === "LOGIN_REQUIRED",
  );
});

test("PoC manifest and source keep credentials out of extension storage and cookie APIs", () => {
  const root = path.join(__dirname, "..", "poc", "bilibili-subtitle-verifier");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const source = ["verifier.js", "popup.js"]
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");

  assert.deepEqual(manifest.permissions, ["activeTab"]);
  assert.equal(manifest.host_permissions.includes("*://*/*"), false);
  assert.equal(
    manifest.host_permissions.includes("https://subtitle.bilibili.com/*"),
    true,
  );
  assert.doesNotMatch(source, /chrome\.cookies|chrome\.storage|SESSDATA|BILIBILI_COOKIE/);
  assert.doesNotMatch(source, /headers\s*:\s*\{[^}]*Cookie\s*:/s);
  assert.match(source, /credentials:\s*"include"/);
  assert.match(source, /credentials:\s*"omit"/);
});
