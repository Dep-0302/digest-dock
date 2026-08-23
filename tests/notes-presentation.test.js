const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
