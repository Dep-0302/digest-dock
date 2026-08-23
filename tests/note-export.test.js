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
    "标题-notes-zh-2026-08-21.md",
  );
  assert.equal(
    exporter.allNotesFilename("original", { date: "2026-08-21T00:00:00Z" }),
    "digestdock-all-notes-original-2026-08-21.md",
  );
  assert.equal(exporter.safeTitleSlug("   "), "digestdock", "blank title has a fallback");
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

test("current video markdown carries every required field in zh mode", () => {
  const md = exporter.buildCurrentVideoMarkdown(sampleSource, "zh");
  assert.match(md, /^# 未来/m);
  assert.match(md, /- 频道：Some Channel/);
  assert.match(md, /- 网址：https:\/\/www\.youtube\.com\/watch\?v=abc123/);
  assert.match(md, /- 平台：YouTube/);
  assert.match(md, /- 导出语言：中文/);
  assert.match(md, /## 视频简介\n\n一段中文简介。/);
  assert.match(md, /## 字幕/);
  assert.match(md, /- \[00:04\] 第一行/);
  assert.match(md, /- \[00:47\] 第二行/);
  assert.match(md, /### 00:04\n\n较早的笔记/);
  // Notes are ordered by timecode: 00:04 must appear before 02:34.
  assert.ok(md.indexOf("### 00:04") < md.indexOf("### 02:34"));
});

test("bilingual markdown pairs original and Chinese with clear labels", () => {
  const md = exporter.buildCurrentVideoMarkdown(sampleSource, "bilingual");
  assert.match(md, /^# The Future \/ 未来/m);
  assert.match(md, /- \[00:04\] first line\n  - 第一行/);
  assert.match(md, /\*\*原文\*\*：early note/);
  assert.match(md, /\*\*中文\*\*：较早的笔记/);
});

test("original mode never emits Chinese text", () => {
  const md = exporter.buildCurrentVideoMarkdown(sampleSource, "original");
  assert.match(md, /^# The Future/m);
  assert.doesNotMatch(md, /未来|一段中文简介|第一行|较早的笔记/);
});

test("all-notes markdown produces one section per source in group order", () => {
  const second = {
    ...sampleSource,
    titleOriginal: "Another",
    titleZh: "另一个",
    canonicalUrl: "https://www.youtube.com/watch?v=def456",
    notes: [{ timestampSeconds: 1, original: "n", zh: "笔记" }],
  };
  const md = exporter.buildAllNotesMarkdown([sampleSource, second], "zh", {
    date: "2026-08-21T00:00:00Z",
  });
  assert.match(md, /^# DigestDock 全部笔记/m);
  assert.match(md, /- 视频数量：2/);
  assert.match(md, /^## 未来/m);
  assert.match(md, /^## 另一个/m);
  assert.ok(md.indexOf("## 未来") < md.indexOf("## 另一个"));
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

test("missing description and transcript degrade to explicit placeholders", () => {
  const bare = {
    platform: "bilibili",
    titleOriginal: "空",
    notes: [],
    transcriptOriginal: [],
  };
  const md = exporter.buildCurrentVideoMarkdown(bare, "zh");
  assert.match(md, /- 平台：B 站/);
  assert.match(md, /## 视频简介\n\n（无简介）/);
  assert.match(md, /## 字幕\n\n（无字幕）/);
  assert.match(md, /## 笔记\n\n（无笔记）/);
});
