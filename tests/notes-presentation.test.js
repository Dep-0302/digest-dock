const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const noteExport = require("../note-export.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// Loads sidepanel.js in a minimal sandbox and returns the exported pure helpers
// plus an `evaluate` hook to set module-level state such as currentNotesMode.
function loadRuntime() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      // Minimal escaping element so escapeHtml() behaves like the browser.
      createElement: () => {
        let value = "";
        return {
          style: {},
          classList: { toggle() {} },
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: () => Promise.resolve({}) },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
    BILIBILI_ADAPTER: require("../bilibili.js"),
    YTD_NOTE_EXPORT: require("../note-export.js"),
    YTD_NOTE_SOURCES: require("../note-sources.js"),
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read("sidepanel.js"), context);
  return {
    helpers: sandbox.__YTD_TRANSCRIPT_TESTING__,
    evaluate: (code) => vm.runInContext(code, context),
  };
}

const validatedTitle = (extra = {}) => ({
  videoTitle: "The Future of AI",
  videoTitleZh: "人工智能的未来",
  videoTitleZhValidated: true,
  videoTitleZhValidationVersion: 1,
  ...extra,
});

test("note video title renders per mode with validated Chinese", () => {
  const { helpers, evaluate } = loadRuntime();
  const note = validatedTitle();

  evaluate("currentNotesMode = 'original'");
  assert.equal(
    helpers.renderNoteVideoTitle(note),
    '<span class="note-source-title-line note-source-title-line--original" lang="en">The Future of AI</span>',
  );

  evaluate("currentNotesMode = 'zh'");
  assert.match(helpers.renderNoteVideoTitle(note), /人工智能的未来/);
  assert.doesNotMatch(helpers.renderNoteVideoTitle(note), /The Future of AI/);

  evaluate("currentNotesMode = 'bilingual'");
  const bilingual = helpers.renderNoteVideoTitle(note);
  assert.match(bilingual, /note-source-title-line--original[^>]*>The Future of AI</);
  assert.match(bilingual, /note-source-title-line--zh[^>]*>人工智能的未来</);
});

test("unvalidated Chinese title is ignored and falls back to the original", () => {
  const { helpers, evaluate } = loadRuntime();
  evaluate("currentNotesMode = 'zh'");
  const stale = {
    videoTitle: "Some English Title",
    videoTitleZh: "旧的未验证翻译",
    videoTitleZhValidated: false,
  };
  assert.equal(helpers.noteChineseVideoTitle(stale), "");
  assert.match(helpers.renderNoteVideoTitle(stale), /Some English Title/);
  assert.doesNotMatch(helpers.renderNoteVideoTitle(stale), /旧的未验证翻译/);
});

test("a title already in Chinese is reused without a translation field", () => {
  const { helpers, evaluate } = loadRuntime();
  evaluate("currentNotesMode = 'zh'");
  const zhNote = { videoTitle: "中文原始标题" };
  assert.equal(helpers.videoTitleIsChinese(zhNote), true);
  assert.equal(helpers.noteChineseVideoTitle(zhNote), "中文原始标题");
  // Bilingual collapses to a single line when original and Chinese match.
  evaluate("currentNotesMode = 'bilingual'");
  const rendered = helpers.renderNoteVideoTitle(zhNote);
  assert.equal((rendered.match(/title-line--/g) || []).length, 1);
});

test("groupNotesBySource keeps one container per media identity", () => {
  const { helpers } = loadRuntime();
  const notes = [
    { id: "a", mediaKey: "v1", videoTitle: "Same", timestampSeconds: 30 },
    { id: "b", mediaKey: "v1", videoTitle: "Same", timestampSeconds: 5 },
    { id: "c", mediaKey: "v2", videoTitle: "Same", timestampSeconds: 9 },
    {
      id: "p1",
      mediaKey: "bilibili:BV1x:100",
      platform: "bilibili",
      timestampSeconds: 1,
    },
    {
      id: "p2",
      mediaKey: "bilibili:BV1x:200",
      platform: "bilibili",
      timestampSeconds: 1,
    },
  ];
  const groups = helpers.groupNotesBySource(notes);
  assert.equal(groups.length, 4, "same title different mediaKey and B站 parts stay separate");
  const v1 = groups.find((g) => g.mediaKey === "v1");
  assert.deepEqual(v1.notes.map((n) => n.id), ["b", "a"], "timecode ascending");
});

test("timecode order is independent of save order, id breaks ties", () => {
  const { helpers } = loadRuntime();
  const notes = [
    { id: "late", mediaKey: "v", timestampSeconds: 154 },
    { id: "b", mediaKey: "v", timestampSeconds: 4 },
    { id: "a", mediaKey: "v", timestampSeconds: 4 },
    { id: "mid", mediaKey: "v", timestampSeconds: 47 },
  ];
  const [group] = helpers.groupNotesBySource(notes);
  assert.deepEqual(group.notes.map((n) => n.id), ["a", "b", "mid", "late"]);
});

test("sortNoteGroups orders containers by visible title then mediaKey", () => {
  const { helpers, evaluate } = loadRuntime();
  evaluate("currentNotesMode = 'zh'");
  const groups = helpers.groupNotesBySource([
    { id: "1", mediaKey: "v2", videoTitle: "香蕉", timestampSeconds: 0 },
    { id: "2", mediaKey: "v1", videoTitle: "苹果", timestampSeconds: 0 },
  ]);
  const ordered = helpers.sortNoteGroups(groups);
  assert.deepEqual(ordered.map((g) => g.mediaKey), ["v1", "v2"]);
});

test("source metadata shows channel, platform and note count", () => {
  const { helpers } = loadRuntime();
  assert.equal(
    helpers.noteSourceMetaText({ channelName: "MKBHD", platform: "youtube" }, 3),
    "MKBHD · YouTube · 3 条笔记",
  );
  assert.equal(
    helpers.noteSourceMetaText({ platform: "bilibili" }, 1),
    "B 站 · 1 条笔记",
    "missing channel is omitted, not rendered blank",
  );
});

// --- Phase 0: "original" must be the verbatim caption line ------------------

test("original mode returns the verbatim caption line, not the AI cleanup", () => {
  const { helpers } = loadRuntime();

  // `text` is what cleanupNoteText() produced; `rawText` is the caption as it
  // was actually spoken. Recall depends on the verbatim line, so it wins.
  const note = {
    rawText: "we shipped it on a Friday and it broke",
    text: "We shipped the release on a Friday, and it broke.",
  };

  assert.equal(
    helpers.noteOriginalText(note),
    "we shipped it on a Friday and it broke",
  );
});

test("original mode falls back to text for legacy notes without rawText", () => {
  const { helpers } = loadRuntime();

  assert.equal(
    helpers.noteOriginalText({ text: "A note saved before rawText existed." }),
    "A note saved before rawText existed.",
  );
  assert.equal(
    helpers.noteOriginalText({ rawText: "", text: "Empty rawText falls back." }),
    "Empty rawText falls back.",
  );
  assert.equal(
    helpers.noteOriginalText({
      rawText: "   ",
      text: "Blank rawText falls back.",
    }),
    "Blank rawText falls back.",
  );
});

test("English bilingual notes use the polished text while original stays verbatim", () => {
  const { helpers } = loadRuntime();
  const rawText = "second reason I lied is much more";
  const polishedText =
    "And the second reason I lied is much more important, because right now, you could expose my lie.";
  const translatedText =
    "而我撒谎的第二个原因重要得多，因为现在你可以揭穿我的谎言。";
  const note = {
    platform: "youtube",
    sourceLanguage: "en",
    textLanguage: "",
    rawText,
    text: polishedText,
    translatedText,
    translatedValidated: true,
    translatedValidationVersion: 2,
  };

  const original = helpers.renderNoteLanguageContent(note, "original");
  assert.match(original, new RegExp(`>“${rawText}”</span>`));
  assert.doesNotMatch(original, /And the second reason/);
  assert.equal(helpers.noteCopyTextForMode(note, "original"), rawText);

  const bilingual = helpers.renderNoteLanguageContent(note, "bilingual");
  assert.match(bilingual, /And the second reason/);
  assert.match(bilingual, new RegExp(translatedText));
  assert.doesNotMatch(bilingual, new RegExp(`>“${rawText}”</span>`));
  assert.equal(
    helpers.noteCopyTextForMode(note, "bilingual"),
    `${polishedText}\n${translatedText}`,
  );

  const resolved = helpers.resolveNoteExportEntry(note);
  const txt = noteExport.buildAllNotesText(
    [
      {
        platform: "youtube",
        sourceLanguage: "en",
        titleOriginal: "People Have No Idea What’s About To Happen",
        descriptionStatus: "confirmed-empty",
        notes: [{ timestampSeconds: 83, ...resolved }],
      },
    ],
    "original",
    { date: "2026-09-07T00:00:00.000Z" },
  );
  assert.match(txt, new RegExp(rawText));
  assert.doesNotMatch(txt, /And the second reason/);
});

test("unmarked legacy Chinese notes keep the verbatim text in bilingual mode", () => {
  const { helpers } = loadRuntime();
  const note = {
    platform: "youtube",
    sourceLanguage: "",
    textLanguage: "",
    rawText: "这是旧笔记的逐字原文。",
    text: "旧字段里无法证明来源的改写。",
  };

  const bilingual = helpers.renderNoteLanguageContent(note, "bilingual");
  assert.match(bilingual, /这是旧笔记的逐字原文。/);
  assert.doesNotMatch(bilingual, /无法证明来源的改写/);
  assert.equal(
    helpers.noteCopyTextForMode(note, "bilingual"),
    "这是旧笔记的逐字原文。",
  );
});

test("trusted Chinese rawText stays original in display and TXT export", () => {
  const { helpers } = loadRuntime();
  const note = {
    platform: "youtube",
    sourceLanguage: "zh-CN",
    textLanguage: "zh-CN",
    timestampSeconds: 12,
    rawText: "RAW: 这是字幕原话。",
    text: "CLEANED: 这是整理后的中文正文。",
  };

  assert.equal(helpers.noteOriginalText(note), "RAW: 这是字幕原话。");

  const rendered = helpers.renderNoteLanguageContent(note, "original");
  assert.match(rendered, /RAW: 这是字幕原话。/);
  assert.doesNotMatch(rendered, /CLEANED:/);

  const resolved = helpers.resolveNoteExportEntry(note);
  const txt = noteExport.buildAllNotesText(
    [
      {
        platform: "youtube",
        sourceLanguage: "zh-CN",
        titleOriginal: "测试视频",
        descriptionStatus: "confirmed-empty",
        notes: [{ timestampSeconds: note.timestampSeconds, ...resolved }],
      },
    ],
    "original",
    { date: "2026-09-04T00:00:00.000Z" },
  );
  assert.match(txt, /RAW: 这是字幕原话。/);
  assert.doesNotMatch(txt, /CLEANED:/);
});
