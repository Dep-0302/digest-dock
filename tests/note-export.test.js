const test = require("node:test");
const assert = require("node:assert/strict");
const exporter = require("../note-export.js");

// ----------------------------------------------------------------
// Grouping and ordering
// ----------------------------------------------------------------

test("groupNotesBySource groups by stable mediaKey, not by title", () => {
  const notes = [
    { id: "a", mediaKey: "v1", videoTitle: "Same Title", timestampSeconds: 30 },
    { id: "b", mediaKey: "v2", videoTitle: "Same Title", timestampSeconds: 5 },
    { id: "c", mediaKey: "v1", videoTitle: "Same Title", timestampSeconds: 10 },
  ];
  const groups = exporter.groupNotesBySource(notes);
  assert.equal(groups.length, 2, "same title but different mediaKey must not merge");
  const v1 = groups.find((g) => g.mediaKey === "v1");
  assert.deepEqual(
    v1.notes.map((n) => n.id),
    ["c", "a"],
    "notes inside a group are ordered by timecode ascending",
  );
});

test("bilibili parts with different cid do not merge", () => {
  const notes = [
    { id: "p1", mediaKey: "bilibili:BV1abc:100", timestampSeconds: 1 },
    { id: "p2", mediaKey: "bilibili:BV1abc:200", timestampSeconds: 1 },
  ];
  assert.equal(exporter.groupNotesBySource(notes).length, 2);
});

test("legacy YouTube note without mediaKey falls back to videoId", () => {
  const notes = [
    { id: "old", videoId: "abc123", timestampSeconds: 3 },
    { id: "new", mediaKey: "abc123", timestampSeconds: 1 },
  ];
  const groups = exporter.groupNotesBySource(notes);
  assert.equal(groups.length, 1, "videoId and matching mediaKey group together");
  assert.deepEqual(groups[0].notes.map((n) => n.id), ["new", "old"]);
});

test("sortNotesByTimecode ignores createdAt and uses id as tie-breaker", () => {
  const notes = [
    { id: "z", timestampSeconds: 20, createdAt: 1 },
    { id: "a", timestampSeconds: 20, createdAt: 999 },
    { id: "m", timestampSeconds: 4, createdAt: 500 },
  ];
  assert.deepEqual(
    exporter.sortNotesByTimecode(notes).map((n) => n.id),
    ["m", "a", "z"],
  );
});

test("sortNoteGroups orders by supplied visible title then mediaKey", () => {
  const groups = [
    { mediaKey: "v2", representative: { t: "香蕉" } },
    { mediaKey: "v1", representative: { t: "苹果" } },
    { mediaKey: "v3", representative: { t: "苹果" } },
  ];
  const ordered = exporter.sortNoteGroups(groups, (rep) => rep.t);
  assert.deepEqual(
    ordered.map((g) => g.mediaKey),
    ["v1", "v3", "v2"],
    "苹果 before 香蕉; equal titles fall back to mediaKey order",
  );
});

// ----------------------------------------------------------------
// Language assembly (single source of truth)
// ----------------------------------------------------------------

test("localizedSegments: original mode returns the original only", () => {
  assert.deepEqual(exporter.localizedSegments("Hi", "你好", "original"), [
    { lang: "original", text: "Hi" },
  ]);
});

test("localizedSegments: zh mode falls back to original when no translation", () => {
  assert.deepEqual(exporter.localizedSegments("Hi", "", "zh"), [
    { lang: "original", text: "Hi" },
  ]);
  assert.deepEqual(exporter.localizedSegments("Hi", "你好", "zh"), [
    { lang: "zh", text: "你好" },
  ]);
});

test("localizedSegments: bilingual pairs, dedupes identical content", () => {
  assert.deepEqual(exporter.localizedSegments("Hi", "你好", "bilingual"), [
    { lang: "original", text: "Hi" },
    { lang: "zh", text: "你好" },
  ]);
  assert.deepEqual(
    exporter.localizedSegments("你好", "你好", "bilingual"),
    [{ lang: "zh", text: "你好" }],
    "identical original and Chinese collapse to one block",
  );
  assert.deepEqual(exporter.localizedSegments("Hi", "", "bilingual"), [
    { lang: "original", text: "Hi" },
  ]);
});

// ----------------------------------------------------------------
// Filenames
// ----------------------------------------------------------------

test("filenames carry a language suffix and drop illegal path characters", () => {
  assert.equal(
    exporter.transcriptExportFilename("A/B:C?", "bilingual"),
    "A B C-transcript-bilingual.txt",
  );
  assert.equal(
    exporter.currentVideoNotesFilename("标题", "zh", { date: "2026-08-21T00:00:00Z" }),
    "标题-notes-zh-2026-08-21.txt",
  );
  assert.equal(
    exporter.allNotesFilename("original", { date: "2026-08-21T00:00:00Z" }),
    "digestdock-all-notes-original-2026-08-21.txt",
  );
  assert.equal(exporter.safeTitleSlug("   "), "digestdock", "blank title has a fallback");
  assert.equal(
    exporter.currentVideoNotesFilename("A\u0000/B:*?", "original", {
      date: "2026-08-21T00:00:00Z",
    }),
    "A B-notes-original-2026-08-21.txt",
    "control and path characters stay out of TXT filenames",
  );
});

// ----------------------------------------------------------------
// Document assembly
// ----------------------------------------------------------------

const sampleSource = {
  platform: "youtube",
  canonicalUrl: "https://www.youtube.com/watch?v=abc123",
  titleOriginal: "The Future",
  titleZh: "未来",
  channelName: "Some Channel",
  descriptionOriginal: "An english description.",
  descriptionZh: "一段中文简介。",
  transcriptOriginal: [
    { start: 47, text: "second line" },
    { start: 4, text: "first line" },
  ],
  transcriptZh: [
    { start: 4, text: "第一行" },
    { start: 47, text: "第二行" },
  ],
  notes: [
    { timestampSeconds: 154, original: "later note", zh: "较晚的笔记" },
    { timestampSeconds: 4, original: "early note", zh: "较早的笔记" },
  ],
};

test("current-video TXT is Markdown-free and contains metadata plus time-sorted notes", () => {
  const txt = exporter.buildCurrentVideoText(sampleSource, "zh", {
    date: "2026-08-21T00:00:00Z",
  });
  assert.match(txt, /^标题：未来/m);
  assert.match(txt, /^频道：Some Channel/m);
  assert.match(txt, /^网址：https:\/\/www\.youtube\.com\/watch\?v=abc123/m);
  assert.match(txt, /^平台：YouTube/m);
  assert.match(txt, /^语言：中文/m);
  assert.match(txt, /视频简介：\n一段中文简介。/);
  assert.match(txt, /笔记：\n\[00:04\]\n较早的笔记/);
  assert.ok(txt.indexOf("[00:04]") < txt.indexOf("[02:34]"));
  assert.doesNotMatch(txt, /(?:^|\n)#+\s|\*\*/);
  assert.doesNotMatch(txt, /first line|second line|字幕：/);
});

test("bilingual TXT labels original and Chinese adjacently", () => {
  const txt = exporter.buildSourceText(sampleSource, "bilingual");
  assert.match(txt, /标题：\n原文：The Future\n\s*中文：未来/);
  assert.match(
    txt,
    /视频简介：\n原文：An english description\.\n中文：一段中文简介。/,
  );
  assert.match(txt, /\[00:04\]\n原文：early note\n中文：较早的笔记/);
  assert.doesNotMatch(txt, /(?:^|\n)#+\s|\*\*/);
});

test("Chinese and bilingual TXT mark missing requested-language fields without original fallback", () => {
  const incomplete = {
    platform: "youtube",
    titleOriginal: "Original title that must not stand in for Chinese",
    descriptionOriginal: "Original description",
    notes: [{ timestampSeconds: 1, original: "Original note" }],
  };
  const zh = exporter.buildSourceText(incomplete, "zh");
  assert.match(zh, /^标题：（缺失：中文标题）/m);
  assert.match(zh, /^频道：（缺失：频道）/m);
  assert.match(zh, /^网址：（缺失：网址）/m);
  assert.match(zh, /视频简介：\n（缺失：中文视频简介）/);
  assert.match(zh, /\[00:01\]\n（缺失：中文笔记）/);
  assert.doesNotMatch(zh, /Original title|Original description|Original note/);

  const bilingual = exporter.buildSourceText(incomplete, "bilingual");
  assert.match(
    bilingual,
    /原文：Original title that must not stand in for Chinese\n\s*中文：（缺失：中文标题）/,
  );
  assert.match(
    bilingual,
    /原文：Original description\n中文：（缺失：中文视频简介）/,
  );
  assert.match(
    bilingual,
    /原文：Original note\n中文：（缺失：中文笔记）/,
  );
});

test("a confirmed Chinese source reuses original text instead of reporting missing Chinese", () => {
  const txt = exporter.buildCurrentVideoText(
    {
      platform: "bilibili",
      sourceLanguage: "zh-CN",
      titleOriginal: "中文标题",
      channelName: "频道",
      canonicalUrl: "https://www.bilibili.com/video/BV1example/",
      descriptionOriginal: "中文简介",
      descriptionStatus: "present",
      notes: [{ timestampSeconds: 2, original: "中文笔记", zh: "" }],
    },
    "zh",
  );
  assert.match(txt, /标题：中文标题/);
  assert.match(txt, /视频简介：\n中文简介/);
  assert.match(txt, /\[00:02\]\n中文笔记/);
  assert.doesNotMatch(txt, /缺失：中文/);

  const bilingual = exporter.buildCurrentVideoText(
    {
      platform: "bilibili",
      sourceLanguage: "zh-CN",
      titleOriginal: "中文标题",
      channelName: "频道",
      canonicalUrl: "https://www.bilibili.com/video/BV1example/",
      descriptionOriginal: "中文简介",
      descriptionStatus: "present",
      notes: [{ timestampSeconds: 2, original: "中文笔记", zh: "" }],
    },
    "bilingual",
  );
  assert.equal((bilingual.match(/中文标题/g) || []).length, 1);
  assert.equal((bilingual.match(/中文简介/g) || []).length, 1);
  assert.equal((bilingual.match(/中文笔记/g) || []).length, 1);
});

test("TXT distinguishes an unknown description from a confirmed empty one", () => {
  const unknown = exporter.buildCurrentVideoText(
    { ...sampleSource, descriptionOriginal: "", descriptionZh: "", descriptionStatus: "unknown" },
    "original",
  );
  const empty = exporter.buildCurrentVideoText(
    { ...sampleSource, descriptionOriginal: "", descriptionZh: "", descriptionStatus: "confirmed-empty" },
    "original",
  );
  assert.match(unknown, /（缺失：原文视频简介）/);
  assert.match(empty, /视频简介：\n（无简介）/);
  assert.doesNotMatch(empty, /缺失：原文视频简介/);
});

test("TXT marks a truncated description as incomplete", () => {
  const txt = exporter.buildCurrentVideoText(
    { ...sampleSource, descriptionStatus: "present", descriptionTruncated: true },
    "original",
  );
  assert.match(txt, /An english description\.\n〔资料不完整：简介已裁剪〕/);
});

test("TXT preserves long timecodes beyond three hours", () => {
  const txt = exporter.buildSourceText(
    {
      ...sampleSource,
      notes: [
        { timestampSeconds: 3 * 3600 + 7, original: "long video note", zh: "长视频笔记" },
      ],
    },
    "original",
  );
  assert.match(txt, /\[3:00:07\]\nlong video note/);
});

test("all-notes TXT clearly separates sources and serializes only selected sources", () => {
  const selected = {
    ...sampleSource,
    titleOriginal: "Selected source",
    titleZh: "选中的来源",
    notes: [{ timestampSeconds: 5, original: "selected-only-marker", zh: "仅选中" }],
  };
  const excluded = {
    ...sampleSource,
    titleOriginal: "Excluded source",
    titleZh: "未选中的来源",
    notes: [{ timestampSeconds: 6, original: "excluded-marker", zh: "排除" }],
  };
  const txt = exporter.buildAllNotesText([selected], "original", {
    date: "2026-08-21T00:00:00Z",
  });
  assert.match(txt, /^DigestDock 全部笔记/m);
  assert.match(txt, /^视频数量：1/m);
  assert.match(txt, /={20,}\n视频 1 \/ 1\n={20,}/);
  assert.match(txt, /Selected source|selected-only-marker/);
  assert.doesNotMatch(txt, /Excluded source|excluded-marker/);
  assert.doesNotMatch(txt, /(?:^|\n)#+\s|\*\*/);
});

test("transcript TXT keeps the header and full ordered transcript", () => {
  const txt = exporter.buildTranscriptText(sampleSource, "bilingual", {
    date: "2026-08-21T00:00:00Z",
  });
  assert.match(txt, /^The Future \/ 未来/m);
  assert.match(txt, /频道：Some Channel/);
  assert.match(txt, /导出语言：双语/);
  assert.match(txt, /\[00:04\] first line\n {4}第一行/);
  // Full transcript is present regardless of scroll position; 00:47 line exists.
  assert.match(txt, /\[00:47\] second line/);
});

test("a notes export with 395 transcript rows still serializes only saved notes", () => {
  const source = {
    ...sampleSource,
    transcriptOriginal: Array.from({ length: 395 }, (_, index) => ({
      start: index,
      text: `transcript-only-row-${index}`,
    })),
    transcriptZh: [],
    notes: [
      {
        timestampSeconds: 378,
        original: "the one saved note",
        zh: "唯一保存的笔记",
      },
    ],
  };
  const txt = exporter.buildCurrentVideoText(source, "original");
  assert.match(txt, /笔记：/);
  assert.match(txt, /\[06:18\]\nthe one saved note/);
  assert.doesNotMatch(txt, /transcript-only-row|字幕：/);
});
