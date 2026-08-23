const test = require("node:test");
const assert = require("node:assert/strict");
const sources = require("../note-sources.js");

// In-memory chrome.storage.local shim: get(key) resolves { [key]: value }.
function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    async get(key) {
      if (key === null || key === undefined) return { ...store };
      return key in store ? { [key]: store[key] } : {};
    },
    async set(patch) {
      Object.assign(store, patch);
    },
    async remove(key) {
      delete store[key];
    },
  };
}

const KEY = sources.STORAGE_KEY;

test("normalizeNoteSource requires a media key and bounds fields", () => {
  assert.equal(sources.normalizeNoteSource({ titleOriginal: "x" }), null);
  assert.equal(sources.normalizeNoteSource({ mediaKey: "has space" }), null);
  const s = sources.normalizeNoteSource({
    mediaKey: "abc123",
    platform: "weird",
    titleOriginal: " Hello ",
    transcriptOriginal: [
      { start: 5, text: "b" },
      { start: 1, text: "a" },
      { start: -3, text: "drop me" },
      { start: 2, text: "  " },
    ],
  });
  assert.equal(s.platform, "youtube", "unknown platform normalizes to youtube");
  assert.equal(s.titleOriginal, "Hello");
  assert.deepEqual(
    s.transcriptOriginal.map((e) => [e.start, e.text]),
    [[1, "a"], [5, "b"]],
    "sorted, blank and negative starts dropped",
  );
  assert.equal(s.schemaVersion, sources.SCHEMA_VERSION);
});

test("writeNoteSource dedupes to one record per media identity and is idempotent", async () => {
  const storage = makeStorage();
  const base = {
    mediaKey: "vid1",
    platform: "youtube",
    canonicalUrl: "https://www.youtube.com/watch?v=vid1",
    titleOriginal: "The Future",
    channelName: "Chan",
    transcriptOriginal: [{ start: 0, text: "hello" }],
  };
  const first = await sources.writeNoteSource(storage, base, { now: 1000 });
  assert.equal(first.changed, true);
  const again = await sources.writeNoteSource(storage, base, { now: 2000 });
  assert.equal(again.changed, false, "identical write is a no-op");

  const map = await sources.readAllSources(storage);
  assert.deepEqual(Object.keys(map), ["vid1"], "only one record for the media");
  assert.equal(map.vid1.updatedAt, 1000, "no-op does not bump updatedAt");
});

test("merge fills empty fields and upgrades transcript completeness without overwriting", async () => {
  const storage = makeStorage();
  await sources.writeNoteSource(
    storage,
    {
      mediaKey: "vid1",
      titleOriginal: "T",
      transcriptOriginal: [{ start: 0, text: "a" }],
    },
    { now: 1000 },
  );
  // A later capture adds the Chinese title and a more complete transcript.
  const res = await sources.writeNoteSource(
    storage,
    {
      mediaKey: "vid1",
      titleOriginal: "T",
      titleZh: "标题",
      transcriptOriginal: [
        { start: 0, text: "a" },
        { start: 5, text: "b" },
      ],
      transcriptZh: [
        { start: 0, text: "甲" },
        { start: 5, text: "乙" },
      ],
    },
    { now: 2000 },
  );
  assert.equal(res.changed, true);
  const map = await sources.readAllSources(storage);
  assert.equal(map.vid1.titleZh, "标题");
  assert.equal(map.vid1.transcriptOriginal.length, 2);
  assert.equal(map.vid1.transcriptTranslationComplete, true);
  assert.equal(map.vid1.updatedAt, 2000);

  // A conflicting non-empty Chinese title is never silently overwritten.
  const merged = sources.mergeNoteSource(
    map.vid1,
    { mediaKey: "vid1", titleZh: "另一个标题" },
    { now: 3000 },
  );
  assert.equal(merged.source.titleZh, "标题", "existing zh title preserved");
});

test("sourceFromDigest backfills from a no-network digest cache, description stays absent", () => {
  const digest = {
    videoTitle: "Cached Title",
    channelName: "Cached Channel",
    transcriptLanguage: "en",
    mediaRef: {
      platform: "youtube",
      canonicalUrl: "https://www.youtube.com/watch?v=vidX",
    },
    transcript: [
      { start: 0, text: "one" },
      { start: 3, text: "two" },
    ],
    timestamp: 555,
  };
  const s = sources.sourceFromDigest("vidX", digest, {
    transcriptZh: [{ start: 0, text: "一" }],
  });
  assert.equal(s.titleOriginal, "Cached Title");
  assert.equal(s.channelName, "Cached Channel");
  assert.equal(s.canonicalUrl, "https://www.youtube.com/watch?v=vidX");
  assert.equal(s.transcriptOriginal.length, 2);
  assert.equal(s.transcriptZh.length, 1);
  assert.equal(s.descriptionOriginal, "", "digest cache never had a description");
  assert.equal(s.updatedAt, 555);
});

test("export precheck lists missing material and never suggests fetching", () => {
  const groups = [
    {
      mediaKey: "complete",
      representative: { videoTitle: "Complete", platform: "youtube" },
      notes: [{ id: "n1", timestampSeconds: 3 }],
    },
    {
      mediaKey: "nosource",
      representative: {
        videoTitle: "Orphan",
        platform: "youtube",
        canonicalUrl: "",
      },
      notes: [{ id: "n2", timestampSeconds: 1 }],
    },
  ];
  const sourcesByKey = {
    complete: sources.normalizeNoteSource({
      mediaKey: "complete",
      canonicalUrl: "https://www.youtube.com/watch?v=complete",
      titleOriginal: "Complete",
      channelName: "Chan",
      descriptionOriginal: "A description.",
      sourceLanguage: "en",
      transcriptOriginal: [
        { start: 0, text: "a" },
        { start: 5, text: "b" },
      ],
      transcriptZh: [{ start: 0, text: "甲" }],
    }),
  };

  const zh = sources.buildExportPrecheck({ groups, sourcesByKey, mode: "zh" });
  assert.equal(zh.videoCount, 2);
  assert.equal(zh.noteCount, 2);

  const orphan = zh.videos.find((v) => v.mediaKey === "nosource");
  assert.equal(orphan.hasSource, false);
  assert.equal(orphan.hasOriginalTranscript, false);
  assert.equal(orphan.blocking, true);
  assert.ok(orphan.blockingReasons.includes("缺少完整字幕"));
  assert.ok(orphan.blockingReasons.includes("缺少视频网址"));
  assert.equal(zh.hasBlocking, true);

  const complete = zh.videos.find((v) => v.mediaKey === "complete");
  assert.equal(complete.blocking, false);
  assert.equal(complete.hasDescription, true);
  assert.equal(complete.transcriptMissingCount, 1, "one segment lacks zh");
  assert.equal(zh.translationGaps.transcriptSegments, 1);
  assert.equal(zh.translationGaps.notes, 0);
  assert.equal(zh.hasTranslationGaps, true);
});

test("export precheck counts missing note-body translations", () => {
  const groups = [
    {
      mediaKey: "video",
      representative: { videoTitle: "Video", platform: "youtube" },
      notes: [
        { id: "n1", text: "An untranslated note", translatedText: "" },
        { id: "n2", text: "Already done", translatedText: "已经完成" },
      ],
    },
  ];
  const sourcesByKey = {
    video: sources.normalizeNoteSource({
      mediaKey: "video",
      canonicalUrl: "https://youtu.be/video",
      titleOriginal: "Video",
      titleZh: "视频",
      sourceLanguage: "en",
      transcriptOriginal: [{ start: 0, text: "hello" }],
      transcriptZh: [{ start: 0, text: "你好" }],
    }),
  };
  const precheck = sources.buildExportPrecheck({
    groups,
    sourcesByKey,
    mode: "bilingual",
  });
  assert.equal(precheck.translationGaps.notes, 1);
  assert.equal(precheck.hasTranslationGaps, true);
});

test("precheck treats a Chinese-source video as needing no translation", () => {
  const groups = [
    {
      mediaKey: "bilibili:BV1xx411c7mD:2",
      representative: { videoTitle: "中文视频", platform: "bilibili" },
      notes: [{ id: "n", timestampSeconds: 0 }],
    },
  ];
  const sourcesByKey = {
    "bilibili:BV1xx411c7mD:2": sources.normalizeNoteSource({
      mediaKey: "bilibili:BV1xx411c7mD:2",
      platform: "bilibili",
      canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD/?p=2",
      titleOriginal: "中文视频",
      transcriptOriginal: [{ start: 0, text: "你好" }],
    }),
  };
  const zh = sources.buildExportPrecheck({ groups, sourcesByKey, mode: "zh" });
  const v = zh.videos[0];
  assert.equal(v.blocking, false);
  assert.equal(v.transcriptMissingCount, 0);
  assert.equal(v.needsTitleTranslation, false);
  assert.equal(zh.hasTranslationGaps, false);
});

test("original mode never reports translation gaps", () => {
  const groups = [
    {
      mediaKey: "v",
      representative: { videoTitle: "English", platform: "youtube" },
      notes: [{ id: "n", timestampSeconds: 0 }],
    },
  ];
  const sourcesByKey = {
    v: sources.normalizeNoteSource({
      mediaKey: "v",
      canonicalUrl: "https://youtu.be/v",
      titleOriginal: "English",
      sourceLanguage: "en",
      transcriptOriginal: [{ start: 0, text: "a" }],
    }),
  };
  const original = sources.buildExportPrecheck({
    groups,
    sourcesByKey,
    mode: "original",
  });
  assert.equal(original.hasTranslationGaps, false);
  assert.equal(original.videos[0].blocking, false);
});

test("export translation plan is deterministic, bounded, and batches stable IDs", () => {
  const groups = [
    {
      mediaKey: "video",
      representative: { videoTitle: "An English Video", platform: "youtube" },
      notes: [
        {
          id: "n1",
          text: "First note",
          translatedText: "",
          sourceLanguage: "en",
          platform: "youtube",
        },
      ],
    },
  ];
  const sourcesByKey = {
    video: sources.normalizeNoteSource({
      mediaKey: "video",
      canonicalUrl: "https://youtu.be/video",
      titleOriginal: "An English Video",
      descriptionOriginal: "A short description.",
      sourceLanguage: "en",
      transcriptOriginal: [
        { start: 0, text: "hello" },
        { start: 5, text: "world" },
      ],
      transcriptZh: [{ start: 0, text: "你好" }],
    }),
  };

  const plan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey,
    mode: "zh",
  });
  assert.equal(plan.overLimit, false);
  assert.equal(plan.noteBatches.length, 1);
  assert.deepEqual(plan.noteBatches[0].map((note) => note.id), ["n1"]);
  assert.equal(plan.titleBatches.length, 1);
  assert.equal(plan.sourceBatches.length, 1);
  assert.equal(plan.sourceBatches[0].length, 2, "description + one subtitle");
  assert.deepEqual(
    plan.sourceBatches[0].map((unit) => unit.id),
    ["u0", "u1"],
  );
  assert.equal(plan.unitCount, 4);
  assert.equal(plan.estimatedBatches, 3);
  assert.equal(plan.maxProviderCalls, 12);
});

test("export translation plan applies only complete validated source results", () => {
  const groups = [
    {
      mediaKey: "video",
      representative: { videoTitle: "Video", platform: "youtube" },
      notes: [],
    },
  ];
  const source = sources.normalizeNoteSource({
    mediaKey: "video",
    canonicalUrl: "https://youtu.be/video",
    titleOriginal: "Video",
    descriptionOriginal: "Description",
    sourceLanguage: "en",
    transcriptOriginal: [
      { start: 0, text: "hello" },
      { start: 5, text: "world" },
    ],
    transcriptZh: [{ start: 0, text: "你好" }],
  });
  const plan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey: { video: source },
    mode: "zh",
  });
  const units = plan.sourceBatches.flat();
  const description = units.find((unit) => unit.kind === "description");
  const transcript = units.find((unit) => unit.kind === "transcript");
  const applied = sources.applyExportSourceTranslations(
    plan,
    new Map([
      [description.id, "简介"],
      [transcript.id, "世界"],
    ]),
    { video: source },
  );
  assert.deepEqual(applied.missingUnitIds, []);
  assert.equal(applied.sourcesByKey.video.descriptionZh, "简介");
  assert.deepEqual(applied.sourcesByKey.video.transcriptZh, [
    { start: 0, text: "你好" },
    { start: 5, text: "世界" },
  ]);
  assert.equal(applied.sourcesByKey.video.transcriptTranslationComplete, true);
});

test("export translation plan fails closed before an over-limit job starts", () => {
  const groups = Array.from(
    { length: sources.EXPORT_TRANSLATION_MAX_VIDEOS + 1 },
    (_, index) => ({
      mediaKey: `video${index}`,
      representative: { videoTitle: `Video ${index}`, platform: "youtube" },
      notes: [],
    }),
  );
  const plan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey: {},
    mode: "zh",
  });
  assert.equal(plan.overLimit, true);
  assert.match(plan.limitReasons.join("；"), /超过 .* 个视频/);
});

test("export translation plan caps conservative provider-call amplification", () => {
  const groups = [];
  const sourcesByKey = {};
  for (let video = 0; video < 20; video += 1) {
    const mediaKey = `v${video}`;
    groups.push({
      mediaKey,
      representative: { videoTitle: `English ${video}`, platform: "youtube" },
      notes: Array.from({ length: 5 }, (_, note) => ({
        id: `n${video}-${note}`,
        text: `English note ${video}-${note}`,
      })),
    });
    sourcesByKey[mediaKey] = sources.normalizeNoteSource({
      mediaKey,
      canonicalUrl: `https://youtu.be/${mediaKey}`,
      titleOriginal: `English ${video}`,
      sourceLanguage: "en",
      transcriptOriginal: Array.from({ length: 6 }, (_, row) => ({
        start: row * 5,
        text: `English subtitle ${video}-${row}`,
      })),
    });
  }
  const plan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey,
    mode: "zh",
  });
  assert.equal(plan.unitCount, 240, "unit limit alone is still satisfied");
  assert.ok(plan.maxProviderCalls > sources.EXPORT_TRANSLATION_MAX_PROVIDER_CALLS);
  assert.equal(plan.overLimit, true);
  assert.match(plan.limitReasons.join("；"), /模型请求/);
});

test("per-source byte cap trims the transcript before metadata", () => {
  const huge = Array.from({ length: 4000 }, (_, i) => ({
    start: i,
    text: "x".repeat(500),
  }));
  const s = sources.normalizeNoteSource({
    mediaKey: "big",
    titleOriginal: "Big",
    channelName: "Chan",
    canonicalUrl: "https://youtu.be/big",
    transcriptOriginal: huge,
  });
  const merged = sources.mergeNoteSource(null, s).source;
  assert.ok(
    sources.estimateSourceBytes(merged) <= sources.MAX_SOURCE_BYTES,
    "bounded under the per-source cap",
  );
  assert.equal(merged.titleOriginal, "Big", "metadata survives the trim");
  assert.equal(merged.canonicalUrl, "https://youtu.be/big");
  assert.ok(
    merged.transcriptOriginal.length < huge.length,
    "transcript was trimmed",
  );
});

test("readAllSources ignores corrupt or identity-less stored records", async () => {
  const storage = makeStorage({
    [KEY]: {
      good: { mediaKey: "good", titleOriginal: "ok" },
      bad: { titleOriginal: "no media key" },
      alsoBad: 42,
    },
  });
  const map = await sources.readAllSources(storage);
  assert.deepEqual(Object.keys(map), ["good"]);
});

test("toExportSource maps notes through the injected language resolver", () => {
  const source = sources.normalizeNoteSource({
    mediaKey: "v",
    titleOriginal: "T",
    transcriptOriginal: [{ start: 0, text: "a" }],
  });
  const out = sources.toExportSource(
    source,
    [
      { timestampSeconds: 9, text: "raw", translatedText: "译文" },
      { timestampSeconds: 1, text: "raw2", translatedText: "" },
    ],
    {
      resolveNote: (note) => ({
        original: note.text.toUpperCase(),
        zh: note.translatedText,
      }),
    },
  );
  assert.equal(out.titleOriginal, "T");
  assert.deepEqual(out.notes[0], {
    timestampSeconds: 9,
    original: "RAW",
    zh: "译文",
  });
});
