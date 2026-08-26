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
      const keys = Array.isArray(key) ? key : [key];
      keys.forEach((value) => delete store[value]);
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

test("a shorter confirmed description replaces a longer truncated fallback", async () => {
  const storage = makeStorage();
  await sources.writeNoteSource(storage, {
    mediaKey: "description-upgrade",
    titleOriginal: "Video",
    descriptionOriginal:
      "Long DOM fallback with unrelated metadata and repeated visible page content.",
    descriptionStatus: "present",
    descriptionTruncated: true,
  });
  await sources.writeNoteSource(storage, {
    mediaKey: "description-upgrade",
    titleOriginal: "Video",
    descriptionOriginal: "Exact description.",
    descriptionStatus: "present",
    descriptionTruncated: false,
  });
  const merged = await sources.readNoteSource(storage, "description-upgrade");
  assert.equal(merged.descriptionOriginal, "Exact description.");
  assert.equal(merged.descriptionStatus, "present");
  assert.equal(merged.descriptionTruncated, false);
});

test("an exact confirmed-empty result clears a stale truncated fallback", async () => {
  const storage = makeStorage();
  await sources.writeNoteSource(storage, {
    mediaKey: "description-empty-upgrade",
    titleOriginal: "Video",
    descriptionOriginal: "Truncated fallback text...",
    descriptionStatus: "present",
    descriptionTruncated: true,
  });
  await sources.writeNoteSource(storage, {
    mediaKey: "description-empty-upgrade",
    titleOriginal: "Video",
    descriptionOriginal: "",
    descriptionStatus: "confirmed-empty",
    descriptionTruncated: false,
  });
  const merged = await sources.readNoteSource(
    storage,
    "description-empty-upgrade",
  );
  assert.equal(merged.descriptionOriginal, "");
  assert.equal(merged.descriptionStatus, "confirmed-empty");
  assert.equal(merged.descriptionTruncated, false);
});

test("title translations are source-hash bound, invalidated on change, and replanned", () => {
  const before = sources.normalizeNoteSource({
    mediaKey: "title-change",
    canonicalUrl: "https://youtu.be/title-change",
    titleOriginal: "Old title",
    titleZh: "旧标题",
    descriptionStatus: "confirmed-empty",
    sourceLanguage: "en",
    transcriptOriginal: [{ id: "row", start: 0, text: "hello" }],
    transcriptZh: [{ segmentId: "row", start: 0, text: "你好" }],
  });
  assert.equal(before.titleSourceHash, sources.hashSourceText("Old title"));
  const changed = sources.mergeNoteSource(before, {
    mediaKey: "title-change",
    titleOriginal: "New title",
  }).source;
  assert.equal(changed.titleZh, "");
  assert.equal(changed.titleSourceHash, "");
  assert.notEqual(changed.sourceRevision, before.sourceRevision);

  const groups = [
    {
      mediaKey: "title-change",
      representative: { videoTitle: "New title", platform: "youtube" },
      notes: [],
    },
  ];
  const precheck = sources.buildExportPrecheck({
    groups,
    sourcesByKey: { "title-change": changed },
    mode: "zh",
  });
  assert.equal(precheck.videos[0].needsTitleTranslation, true);
  const plan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey: { "title-change": changed },
    mode: "zh",
    includeDescriptions: false,
    includeTranscript: false,
  });
  assert.deepEqual(plan.titleBatches.flat(), [
    { mediaKey: "title-change", title: "New title" },
  ]);

  const translatedTogether = sources.mergeNoteSource(before, {
    mediaKey: "title-change",
    titleOriginal: "New title",
    titleZh: "新标题",
  }).source;
  assert.equal(translatedTogether.titleZh, "新标题");
  assert.equal(
    translatedTogether.titleSourceHash,
    sources.hashSourceText("New title"),
  );
});

test("same title reuses translation and schema-2 records without a hash bind safely", () => {
  const compatible = sources.normalizeNoteSource({
    schemaVersion: 2,
    mediaKey: "title-compatible",
    titleOriginal: "Same title",
    titleZh: "相同标题",
  });
  assert.equal(
    compatible.titleSourceHash,
    sources.hashSourceText("Same title"),
  );
  const merged = sources.mergeNoteSource(compatible, {
    mediaKey: "title-compatible",
    titleOriginal: "Same title",
  }).source;
  assert.equal(merged.titleZh, "相同标题");
  assert.equal(merged.titleSourceHash, compatible.titleSourceHash);

  const mismatched = sources.normalizeNoteSource({
    schemaVersion: 2,
    mediaKey: "title-mismatch",
    titleOriginal: "Current title",
    titleZh: "过期标题",
    titleSourceHash: sources.hashSourceText("Previous title"),
  });
  assert.equal(mismatched.titleZh, "");
  assert.equal(mismatched.titleSourceHash, "");
});

test("adopting a new transcript also adopts its language and suppresses Chinese work", () => {
  const english = sources.normalizeNoteSource({
    mediaKey: "track-switch",
    titleOriginal: "Track switch",
    descriptionStatus: "confirmed-empty",
    sourceLanguage: "en",
    transcriptOriginal: [{ id: "en-row", start: 0, text: "hello" }],
  });
  const chinese = sources.mergeNoteSource(english, {
    mediaKey: "track-switch",
    titleOriginal: "Track switch",
    descriptionStatus: "confirmed-empty",
    sourceLanguage: "zh-CN",
    transcriptOriginal: [{ id: "zh-row", start: 0, text: "你好" }],
  }).source;
  assert.equal(chinese.sourceLanguage, "zh-CN");
  assert.notEqual(chinese.sourceRevision, english.sourceRevision);
  const plan = sources.buildExportTranslationPlan({
    groups: [
      {
        mediaKey: "track-switch",
        representative: { videoTitle: "Track switch", platform: "youtube" },
        notes: [],
      },
    ],
    sourcesByKey: { "track-switch": chinese },
    mode: "zh",
  });
  assert.equal(plan.unitCount, 0);
  assert.equal(plan.sourceBatches.length, 0);
  assert.equal(plan.titleBatches.length, 0);
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

test("export precheck uses representative metadata when the source record is missing", () => {
  const precheck = sources.buildExportPrecheck({
    groups: [
      {
        mediaKey: "representative-only",
        representative: {
          videoTitle: "Representative title",
          channelName: "Representative channel",
          canonicalUrl: "https://youtu.be/representative-only",
          platform: "youtube",
        },
        notes: [{ id: "note", text: "Saved note" }],
      },
    ],
    sourcesByKey: {},
    mode: "original",
    includeTranscript: false,
  });

  const video = precheck.videos[0];
  assert.equal(video.hasSource, false);
  assert.equal(video.hasTitle, true);
  assert.equal(video.hasChannel, true);
  assert.equal(video.hasUrl, true);
  assert.equal(video.blocking, true, "unknown description still blocks");
  assert.deepEqual(video.blockingReasons, ["缺少视频简介状态"]);
});

test("export precheck blocks genuinely missing title and channel", () => {
  const source = sources.normalizeNoteSource({
    mediaKey: "missing-metadata",
    canonicalUrl: "https://youtu.be/missing-metadata",
    descriptionStatus: "confirmed-empty",
  });
  const precheck = sources.buildExportPrecheck({
    groups: [
      {
        mediaKey: "missing-metadata",
        representative: { platform: "youtube" },
        notes: [],
      },
    ],
    sourcesByKey: { "missing-metadata": source },
    mode: "original",
    includeTranscript: false,
  });

  const video = precheck.videos[0];
  assert.equal(video.hasTitle, false);
  assert.equal(video.hasChannel, false);
  assert.ok(video.blockingReasons.includes("缺少视频标题"));
  assert.ok(video.blockingReasons.includes("缺少频道名称"));
  assert.ok(!video.blockingReasons.includes("缺少完整字幕"));
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
      channelName: "中文频道",
      descriptionStatus: "confirmed-empty",
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
      channelName: "Channel",
      descriptionStatus: "confirmed-empty",
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

test("description completeness blocks unknown, allows confirmed-empty, and counts present chunks", () => {
  const groups = [
    {
      mediaKey: "description-state",
      representative: { videoTitle: "Video", platform: "youtube" },
      notes: [],
    },
  ];
  const base = {
    mediaKey: "description-state",
    canonicalUrl: "https://youtu.be/description-state",
    titleOriginal: "Video",
    titleZh: "视频",
    channelName: "Channel",
    sourceLanguage: "en",
    transcriptOriginal: [{ id: "row", start: 0, text: "hello" }],
    transcriptZh: [{ segmentId: "row", start: 0, text: "你好" }],
  };
  const unknown = sources.normalizeNoteSource(base);
  const unknownCheck = sources.buildExportPrecheck({
    groups,
    sourcesByKey: { "description-state": unknown },
    mode: "original",
  });
  assert.equal(unknownCheck.videos[0].blocking, true);
  assert.match(unknownCheck.videos[0].blockingReasons.join("；"), /简介状态/);
  assert.equal(unknownCheck.hasTranslationGaps, false);

  const confirmedEmpty = sources.normalizeNoteSource({
    ...base,
    descriptionStatus: "confirmed-empty",
  });
  const emptyCheck = sources.buildExportPrecheck({
    groups,
    sourcesByKey: { "description-state": confirmedEmpty },
    mode: "bilingual",
  });
  assert.equal(emptyCheck.videos[0].blocking, false);
  assert.equal(emptyCheck.translationGaps.descriptionChunks, 0);

  const truncated = sources.normalizeNoteSource({
    ...base,
    descriptionOriginal: "x".repeat(20_001),
  });
  const truncatedCheck = sources.buildExportPrecheck({
    groups,
    sourcesByKey: { "description-state": truncated },
    mode: "original",
  });
  assert.equal(truncatedCheck.videos[0].blocking, true);
  assert.ok(
    truncatedCheck.videos[0].blockingReasons.includes(
      "视频简介已裁剪，不完整",
    ),
  );

  const present = sources.normalizeNoteSource({
    ...base,
    descriptionOriginal: "a".repeat(6500),
  });
  const zhCheck = sources.buildExportPrecheck({
    groups,
    sourcesByKey: { "description-state": present },
    mode: "zh",
  });
  assert.equal(zhCheck.videos[0].blocking, false);
  assert.equal(zhCheck.videos[0].needsDescriptionTranslation, true);
  assert.equal(zhCheck.translationGaps.descriptions, 1);
  assert.equal(zhCheck.translationGaps.descriptionChunks, 3);
  const originalCheck = sources.buildExportPrecheck({
    groups,
    sourcesByKey: { "description-state": present },
    mode: "original",
  });
  assert.equal(originalCheck.hasTranslationGaps, false);
  assert.equal(originalCheck.translationGaps.descriptionChunks, 0);
});

test("notes export planning ignores full transcript gaps while transcript planning keeps them", () => {
  const source = sources.normalizeNoteSource({
    mediaKey: "notes-scope",
    canonicalUrl: "https://www.youtube.com/watch?v=notes-scope",
    titleOriginal: "Notes scope",
    titleZh: "笔记范围",
    channelName: "Channel",
    descriptionOriginal: "English description",
    descriptionZh: "中文简介",
    descriptionStatus: "present",
    sourceLanguage: "en",
    transcriptOriginal: Array.from({ length: 395 }, (_, index) => ({
      id: `segment-${index}`,
      start: index,
      text: `transcript-only-row-${index}`,
    })),
    transcriptZh: [],
  });
  const groups = [
    {
      mediaKey: "notes-scope",
      representative: { videoTitle: "Notes scope" },
      notes: [
        {
          id: "saved-note",
          text: "Saved English note",
          translatedText: "保存的中文笔记",
        },
      ],
    },
  ];
  const sourcesByKey = { "notes-scope": source };
  const notePrecheck = sources.buildExportPrecheck({
    groups,
    sourcesByKey,
    mode: "bilingual",
    includeTranscript: false,
  });
  const notePlan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey,
    mode: "bilingual",
    includeTranscript: false,
  });
  assert.equal(notePrecheck.translationGaps.transcriptSegments, 0);
  assert.equal(notePrecheck.hasTranslationGaps, false);
  assert.equal(notePlan.sourceBatches.length, 0);
  assert.equal(notePlan.unitCount, 0);

  const transcriptPlan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey,
    mode: "bilingual",
    includeTitles: false,
    includeNotes: false,
    includeDescriptions: false,
    includeTranscript: true,
  });
  assert.equal(transcriptPlan.unitCount, 395);
  assert.equal(transcriptPlan.sourceBatches.length, 99);
});

test("notes export precheck does not require a whole-video transcript", () => {
  const source = sources.normalizeNoteSource({
    mediaKey: "note-without-transcript",
    canonicalUrl: "https://youtu.be/note-without-transcript",
    titleOriginal: "Saved note source",
    channelName: "Channel",
    descriptionStatus: "confirmed-empty",
    sourceLanguage: "en",
    transcriptOriginal: [],
    transcriptTruncated: true,
  });
  const precheck = sources.buildExportPrecheck({
    groups: [
      {
        mediaKey: "note-without-transcript",
        representative: { videoTitle: "Saved note source" },
        notes: [{ id: "saved-note", text: "The saved note itself" }],
      },
    ],
    sourcesByKey: { "note-without-transcript": source },
    mode: "original",
    includeTranscript: false,
  });

  assert.equal(precheck.videos[0].blocking, false);
  assert.equal(precheck.videos[0].hasOriginalTranscript, false);
  assert.ok(!precheck.videos[0].blockingReasons.includes("缺少完整字幕"));
  assert.ok(
    !precheck.videos[0].blockingReasons.includes("字幕资料已裁剪，不完整"),
  );
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
  assert.ok(
    plan.sourceBatches[0].every((unit) =>
      /^[A-Za-z0-9:_-]{1,128}$/.test(unit.id),
    ),
    "stable IDs are accepted by the background batch validator",
  );
  const rebuilt = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey,
    mode: "zh",
  });
  assert.deepEqual(
    rebuilt.sourceBatches.flat().map((unit) => unit.id),
    plan.sourceBatches.flat().map((unit) => unit.id),
    "rebuilding the same plan keeps unit IDs stable",
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
  assert.deepEqual(
    applied.sourcesByKey.video.transcriptZh.map(({ start, text }) => ({
      start,
      text,
    })),
    [
      { start: 0, text: "你好" },
      { start: 5, text: "世界" },
    ],
  );
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

test("large total work is resumable instead of permanently over-limit", () => {
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
  assert.equal(plan.overLimit, false);
  const round = sources.takeExportTranslationRound(plan);
  assert.ok(round.estimatedBatches <= 20);
  assert.ok(round.maxProviderCalls <= 100);
  assert.equal(round.round.hasMore, true);
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
  assert.equal(merged.transcriptTruncated, true);
  assert.equal(merged.transcriptTranslationComplete, false);
});

test("legacy migration ignores corrupt or identity-less schema-1 records", async () => {
  const storage = makeStorage({
    [sources.LEGACY_STORAGE_KEY]: {
      good: { mediaKey: "good", titleOriginal: "ok" },
      bad: { titleOriginal: "no media key" },
      alsoBad: 42,
    },
  });
  const map = await sources.readAllSources(storage);
  assert.deepEqual(Object.keys(map), ["good"]);
});

test("future schema in current storage fails every operation closed with zero writes", async () => {
  const futureMap = {
    future: {
      schemaVersion: 3,
      mediaKey: "future",
      futureField: { mustSurvive: true },
    },
  };
  const operations = [
    (storage) => sources.readAllSources(storage),
    (storage) => sources.readNoteSource(storage, "future"),
    (storage) =>
      sources.writeNoteSource(storage, {
        mediaKey: "new-source",
        transcriptOriginal: [{ start: 0, text: "new" }],
      }),
    (storage) => sources.removeNoteSources(storage, "future"),
    (storage) =>
      sources.commitExportSourceTranslationBatch(storage, {
        mediaKey: "future",
        expectedRevision: "future-revision",
        units: [
          {
            id: "future-unit",
            mediaKey: "future",
            sourceRevision: "future-revision",
          },
        ],
        translationsById: { "future-unit": "未来" },
      }),
  ];
  for (const operation of operations) {
    const storage = makeStorage({ [sources.STORAGE_KEY]: futureMap });
    const before = JSON.stringify(storage.store);
    await assert.rejects(
      operation(storage),
      (error) => error?.code === "UNSUPPORTED_NOTE_SOURCE_SCHEMA",
    );
    assert.equal(JSON.stringify(storage.store), before, "storage remains byte-for-byte unchanged");
  }
});

test("future library envelope is detected before its values can be normalized", async () => {
  const futureLibrary = {
    schemaVersion: 3,
    sources: {
      future: { schemaVersion: 3, mediaKey: "future", privateData: true },
    },
  };
  const storage = makeStorage({ [sources.STORAGE_KEY]: futureLibrary });
  await assert.rejects(
    sources.writeNoteSource(storage, { mediaKey: "replacement" }),
    (error) => error?.code === "UNSUPPORTED_NOTE_SOURCE_SCHEMA",
  );
  assert.strictEqual(storage.store[sources.STORAGE_KEY], futureLibrary);
});

test("lower or missing schema records in current storage are malformed and never overwritten", async () => {
  const malformedMaps = [
    {
      low: { schemaVersion: 1, mediaKey: "low", legacyField: "preserve" },
    },
    {
      missing: { mediaKey: "missing", unknownField: "preserve" },
    },
  ];
  const operations = [
    (storage) => sources.readAllSources(storage),
    (storage) =>
      sources.writeNoteSource(storage, {
        mediaKey: "replacement",
        transcriptOriginal: [{ start: 0, text: "replacement" }],
      }),
    (storage) => sources.removeNoteSources(storage, ["low", "missing"]),
    (storage) =>
      sources.commitExportSourceTranslationBatch(storage, {
        mediaKey: "low",
        expectedRevision: "revision",
        units: [
          {
            id: "unit",
            mediaKey: "low",
            sourceRevision: "revision",
          },
        ],
        translationsById: { unit: "译文" },
      }),
  ];
  for (const malformedMap of malformedMaps) {
    for (const operation of operations) {
      const storage = makeStorage({ [sources.STORAGE_KEY]: malformedMap });
      const before = JSON.stringify(storage.store);
      await assert.rejects(
        operation(storage),
        (error) => error?.code === "INVALID_NOTE_SOURCE_STORAGE",
      );
      assert.equal(JSON.stringify(storage.store), before);
    }
  }
});

test("normalization and writes reject future-schema input before conversion", async () => {
  const future = {
    schemaVersion: 3,
    mediaKey: "future-input",
    futureField: "must not be dropped",
  };
  assert.throws(
    () => sources.normalizeNoteSource(future),
    (error) => error?.code === "UNSUPPORTED_NOTE_SOURCE_SCHEMA",
  );
  const storage = makeStorage();
  await assert.rejects(
    sources.writeNoteSource(storage, future),
    (error) => error?.code === "UNSUPPORTED_NOTE_SOURCE_SCHEMA",
  );
  assert.deepEqual(storage.store, {});
});

test("toExportSource maps notes through the injected language resolver", () => {
  const source = sources.normalizeNoteSource({
    mediaKey: "v",
    titleOriginal: "T",
    sourceLanguage: "en",
    descriptionOriginal: "Partial description",
    descriptionStatus: "present",
    descriptionTruncated: true,
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
  assert.equal(out.sourceLanguage, "en");
  assert.equal(out.descriptionTruncated, true);
  assert.deepEqual(out.notes[0], {
    timestampSeconds: 9,
    original: "RAW",
    zh: "译文",
  });
});

test("schema 2 preserves .1/.9 millisecond identity instead of merging a second", () => {
  const source = sources.normalizeNoteSource({
    mediaKey: "fractional",
    sourceLanguage: "en",
    transcriptOriginal: [
      { id: "early", start: 0.1, text: "early" },
      { id: "late", start: 0.9, text: "late" },
    ],
    transcriptZh: [{ id: "early", start: 0.1, text: "早" }],
  });
  assert.deepEqual(
    source.transcriptOriginal.map(({ start, startMs }) => [start, startMs]),
    [
      [0.1, 100],
      [0.9, 900],
    ],
  );
  assert.equal(
    sources.countMissingTranscriptTranslations(
      source.transcriptOriginal,
      source.transcriptZh,
    ),
    1,
  );
  const plan = sources.buildExportTranslationPlan({
    groups: [
      {
        mediaKey: "fractional",
        representative: { videoTitle: "Fractional" },
        notes: [],
      },
    ],
    sourcesByKey: { fractional: source },
    mode: "zh",
    includeTitles: false,
  });
  assert.equal(plan.sourceBatches.flat().length, 1);
  assert.equal(plan.sourceBatches[0][0].startMs, 900);
});

test("same-start segments require segment identity and never guess a legacy row", () => {
  const ambiguous = sources.normalizeNoteSource({
    schemaVersion: 1,
    mediaKey: "same-start",
    transcriptOriginal: [
      { id: "a", start: 2.25, text: "alpha" },
      { id: "b", start: 2.25, text: "beta" },
    ],
    transcriptZh: [{ start: 2.25, text: "不应猜测" }],
  });
  assert.equal(ambiguous.transcriptZh.length, 0);
  assert.equal(
    sources.countMissingTranscriptTranslations(
      ambiguous.transcriptOriginal,
      ambiguous.transcriptZh,
    ),
    2,
  );

  const identified = sources.normalizeNoteSource({
    mediaKey: "same-start",
    transcriptOriginal: [
      { id: "a", start: 2.25, text: "alpha" },
      { id: "b", start: 2.25, text: "beta" },
    ],
    transcriptZh: [{ segmentId: "b", start: 2.25, text: "乙" }],
  });
  assert.equal(identified.transcriptZh.length, 1);
  assert.equal(identified.transcriptZh[0].segmentId, "b");
  assert.equal(
    sources.countMissingTranscriptTranslations(
      identified.transcriptOriginal,
      identified.transcriptZh,
    ),
    1,
  );
});

test("changed original text invalidates only its old hash-bound translation", () => {
  const before = sources.normalizeNoteSource({
    mediaKey: "edited",
    transcriptOriginal: [
      { id: "a", start: 0, text: "old alpha" },
      { id: "b", start: 1, text: "stable beta" },
    ],
    transcriptZh: [
      { segmentId: "a", start: 0, text: "旧甲" },
      { segmentId: "b", start: 1, text: "稳定乙" },
    ],
  });
  const after = sources.mergeNoteSource(before, {
    mediaKey: "edited",
    transcriptOriginal: [
      { id: "a", start: 0, text: "new alpha" },
      { id: "b", start: 1, text: "stable beta" },
    ],
  }).source;
  assert.notEqual(after.sourceRevision, before.sourceRevision);
  assert.deepEqual(
    after.transcriptZh.map((entry) => entry.segmentId),
    ["b"],
  );
  assert.equal(
    sources.countMissingTranscriptTranslations(
      after.transcriptOriginal,
      after.transcriptZh,
    ),
    1,
  );
});

test("legacy key migrates once to the schema-2 key without modifying legacy data", async () => {
  const legacy = {
    old: {
      schemaVersion: 1,
      mediaKey: "old",
      titleOriginal: "Old",
      transcriptOriginal: [{ start: 1.125, text: "legacy source" }],
      transcriptZh: [{ start: 1.125, text: "旧译文" }],
    },
  };
  const storage = makeStorage({ [sources.LEGACY_STORAGE_KEY]: legacy });
  const map = await sources.readAllSources(storage);
  assert.equal(map.old.schemaVersion, 2);
  assert.equal(map.old.transcriptZh.length, 1);
  assert.equal(
    map.old.transcriptZh[0].segmentId,
    map.old.transcriptOriginal[0].segmentId,
  );
  assert.equal(map.old.transcriptZh[0].sourceHash, map.old.transcriptOriginal[0].sourceHash);
  assert.ok(storage.store[sources.STORAGE_KEY].old);
  assert.strictEqual(
    storage.store[sources.LEGACY_STORAGE_KEY],
    legacy,
    "legacy key remains read-only",
  );
  const upgraded = sources.mergeNoteSource(map.old, {
    mediaKey: "old",
    titleOriginal: "Old",
    transcriptOriginal: [
      { id: "semantic-segment", start: 1.125, text: "legacy source" },
    ],
  }).source;
  assert.equal(upgraded.transcriptZh.length, 1);
  assert.equal(upgraded.transcriptZh[0].segmentId, "semantic-segment");
});

test("oversized legacy reads never evict sources before protected migration", async () => {
  const legacy = Object.fromEntries(
    Array.from({ length: sources.MAX_SOURCES + 1 }, (_, index) => [
      `legacy-${index}`,
      {
        schemaVersion: 1,
        mediaKey: `legacy-${index}`,
        titleOriginal: `Legacy ${index}`,
        updatedAt: index + 1,
      },
    ]),
  );
  const storage = makeStorage({ [sources.LEGACY_STORAGE_KEY]: legacy });
  const read = await sources.readAllSources(storage);
  assert.equal(Object.keys(read).length, sources.MAX_SOURCES + 1);
  assert.equal(Object.hasOwn(storage.store, sources.STORAGE_KEY), false);

  const noop = await sources.writeNoteSource(storage, {
    mediaKey: "legacy-0",
    titleOriginal: "Legacy 0",
  });
  assert.equal(noop.changed, false);
  assert.equal(
    Object.hasOwn(storage.store, sources.STORAGE_KEY),
    false,
    "an oversized no-op must not become an unprotected migration write",
  );
  const missing = await sources.commitExportSourceTranslationBatch(storage, {
    mediaKey: "legacy-missing",
    expectedRevision: "fnv1a-0000000000000000",
    units: [{ id: "missing-unit" }],
    translationsById: {},
  });
  assert.equal(missing.code, "SOURCE_MISSING");
  assert.equal(Object.hasOwn(storage.store, sources.STORAGE_KEY), false);

  await sources.writeNoteSource(
    storage,
    { mediaKey: "new-source", titleOriginal: "New source" },
    { protectedKeys: new Set(["legacy-0"]), now: 10_000 },
  );
  const migrated = storage.store[sources.STORAGE_KEY];
  assert.ok(migrated["legacy-0"], "note-referenced legacy source is retained");
  assert.ok(migrated["new-source"], "the current source is retained");
  assert.ok(Object.keys(migrated).length <= sources.MAX_SOURCES);
  assert.strictEqual(storage.store[sources.LEGACY_STORAGE_KEY], legacy);
});

test("description chunks persist partially and assemble only when all chunks finish", () => {
  const description = `${"a".repeat(3000)}${"b".repeat(3000)}${"c".repeat(500)}`;
  const source = sources.normalizeNoteSource({
    mediaKey: "description",
    titleOriginal: "Description",
    descriptionOriginal: description,
    sourceLanguage: "en",
    transcriptOriginal: [{ id: "t", start: 0, text: "subtitle" }],
    transcriptZh: [{ segmentId: "t", start: 0, text: "字幕" }],
  });
  const groups = [
    {
      mediaKey: "description",
      representative: { videoTitle: "Description" },
      notes: [],
    },
  ];
  const firstPlan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey: { description: source },
    mode: "zh",
    includeTitles: false,
    includeTranscript: false,
  });
  const descriptionUnits = firstPlan.sourceBatches.flat();
  assert.equal(descriptionUnits.length, 3);
  const first = sources.applyExportSourceTranslationBatch(
    [descriptionUnits[0]],
    { [descriptionUnits[0].id]: "第一块" },
    { description: source },
  );
  assert.deepEqual(first.missingUnitIds, []);
  assert.equal(first.sourcesByKey.description.descriptionZh, "");
  assert.equal(first.sourcesByKey.description.descriptionZhChunks.length, 1);

  const resumedPlan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey: first.sourcesByKey,
    mode: "zh",
    includeTitles: false,
    includeTranscript: false,
  });
  assert.equal(resumedPlan.sourceBatches.flat().length, 2);
  assert.deepEqual(
    resumedPlan.sourceBatches.flat().map((unit) => unit.id),
    descriptionUnits.slice(1).map((unit) => unit.id),
  );
  const remaining = resumedPlan.sourceBatches.flat();
  const finished = sources.applyExportSourceTranslationBatch(
    remaining,
    new Map(remaining.map((unit, index) => [unit.id, `后续${index + 2}`])),
    first.sourcesByKey,
  );
  assert.equal(
    finished.sourcesByKey.description.descriptionZh,
    "第一块\n\n后续2\n\n后续3",
  );
});

test("395 transcript rows plan 99 batches and resume in rounds of at most 20", () => {
  const source = sources.normalizeNoteSource({
    mediaKey: "long-video",
    sourceLanguage: "en",
    transcriptOriginal: Array.from({ length: 395 }, (_, index) => ({
      id: `segment-${index}`,
      start: index + 0.123,
      text: `English subtitle ${index}`,
    })),
  });
  const groups = [
    {
      mediaKey: "long-video",
      representative: { videoTitle: "Long" },
      notes: [],
    },
  ];
  const plan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey: { "long-video": source },
    mode: "zh",
    includeTitles: false,
    includeDescriptions: false,
  });
  assert.equal(plan.unitCount, 395);
  assert.equal(plan.estimatedBatches, 99);
  assert.equal(plan.overLimit, false);
  const round = sources.takeExportTranslationRound(plan);
  assert.equal(round.estimatedBatches, 20);
  assert.equal(round.sourceBatches.flat().length, 80);
  assert.equal(round.round.remainingBatches, 79);
  const translated = new Map(
    round.sourceBatches
      .flat()
      .map((unit, index) => [unit.id, `译文${index}`]),
  );
  const applied = sources.applyExportSourceTranslations(
    round,
    translated,
    { "long-video": source },
  );
  assert.deepEqual(applied.missingUnitIds, []);
  const resumed = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey: applied.sourcesByKey,
    mode: "zh",
    includeTitles: false,
    includeDescriptions: false,
  });
  assert.equal(resumed.unitCount, 315);
  assert.equal(resumed.estimatedBatches, 79);
  assert.equal(resumed.progress.completedUnits, 80);
  assert.equal(
    resumed.sourceBatches[0][0].id,
    plan.sourceBatches[20][0].id,
    "resume starts at the first stable unfinished unit",
  );
});

test("concurrent source writes share one queue and never lose another media key", async () => {
  const storage = makeStorage();
  await Promise.all([
    sources.writeNoteSource(storage, {
      mediaKey: "concurrent-a",
      transcriptOriginal: [{ start: 0.1, text: "a" }],
    }),
    sources.writeNoteSource(storage, {
      mediaKey: "concurrent-b",
      transcriptOriginal: [{ start: 0.9, text: "b" }],
    }),
  ]);
  const map = await sources.readAllSources(storage);
  assert.deepEqual(Object.keys(map).sort(), ["concurrent-a", "concurrent-b"]);
});

test("clearNoteSources removes schema-2 and legacy stores through the same queue", async () => {
  const storage = makeStorage({
    [sources.STORAGE_KEY]: {
      current: {
        schemaVersion: 2,
        mediaKey: "current",
        transcriptOriginal: [{ start: 0, text: "current" }],
      },
    },
    [sources.LEGACY_STORAGE_KEY]: {
      legacy: {
        schemaVersion: 1,
        mediaKey: "legacy",
        transcriptOriginal: [{ start: 0, text: "legacy" }],
      },
    },
  });
  assert.deepEqual(await sources.clearNoteSources(storage), { changed: true });
  assert.equal(sources.STORAGE_KEY in storage.store, false);
  assert.equal(sources.LEGACY_STORAGE_KEY in storage.store, false);
  assert.deepEqual(await sources.clearNoteSources(storage), { changed: false });
});

test("clearNoteSources uses empty authoritative stores when remove is unavailable", async () => {
  const storage = makeStorage({
    [sources.STORAGE_KEY]: {
      current: { schemaVersion: 2, mediaKey: "current" },
    },
    [sources.LEGACY_STORAGE_KEY]: {
      legacy: { schemaVersion: 1, mediaKey: "legacy" },
    },
  });
  delete storage.remove;
  assert.deepEqual(await sources.clearNoteSources(storage), { changed: true });
  assert.deepEqual(storage.store[sources.STORAGE_KEY], {});
  assert.deepEqual(storage.store[sources.LEGACY_STORAGE_KEY], {});
  assert.deepEqual(await sources.readAllSources(storage), {});
});

test("clearNoteSources fails closed on a future schema without deleting either key", async () => {
  const future = {
    future: { schemaVersion: 3, mediaKey: "future", futureField: true },
  };
  const legacy = {
    legacy: { schemaVersion: 1, mediaKey: "legacy" },
  };
  const storage = makeStorage({
    [sources.STORAGE_KEY]: future,
    [sources.LEGACY_STORAGE_KEY]: legacy,
  });
  await assert.rejects(
    sources.clearNoteSources(storage),
    (error) => error?.code === "UNSUPPORTED_NOTE_SOURCE_SCHEMA",
  );
  assert.strictEqual(storage.store[sources.STORAGE_KEY], future);
  assert.strictEqual(storage.store[sources.LEGACY_STORAGE_KEY], legacy);
});

test("clearNoteSources serializes with atomic batch commit and cannot be resurrected", async () => {
  const storage = makeStorage();
  const seed = async () => {
    await sources.writeNoteSource(storage, {
      mediaKey: "clear-race",
      sourceLanguage: "en",
      transcriptOriginal: [{ id: "row", start: 0.125, text: "source" }],
    });
    const source = await sources.readNoteSource(storage, "clear-race");
    const plan = sources.buildExportTranslationPlan({
      groups: [
        {
          mediaKey: "clear-race",
          representative: { videoTitle: "Race" },
          notes: [],
        },
      ],
      sourcesByKey: { "clear-race": source },
      mode: "zh",
      includeTitles: false,
    });
    return { source, unit: plan.sourceBatches[0][0] };
  };

  const first = await seed();
  const [commit, cleared] = await Promise.all([
    sources.commitExportSourceTranslationBatch(storage, {
      mediaKey: "clear-race",
      expectedRevision: first.source.sourceRevision,
      units: [first.unit],
      translationsById: { [first.unit.id]: "译文" },
    }),
    sources.clearNoteSources(storage),
  ]);
  assert.equal(commit.code, "OK");
  assert.equal(cleared.changed, true);
  assert.deepEqual(await sources.readAllSources(storage), {});

  const second = await seed();
  const [clearedFirst, lateCommit] = await Promise.all([
    sources.clearNoteSources(storage),
    sources.commitExportSourceTranslationBatch(storage, {
      mediaKey: "clear-race",
      expectedRevision: second.source.sourceRevision,
      units: [second.unit],
      translationsById: { [second.unit.id]: "晚响应" },
    }),
  ]);
  assert.equal(clearedFirst.changed, true);
  assert.equal(lateCommit.changed, false);
  assert.equal(lateCommit.stale, true);
  assert.deepEqual(await sources.readAllSources(storage), {});
});

test("entry cap and byte trimming are explicit incomplete transcript states", () => {
  const capped = sources.normalizeNoteSource({
    mediaKey: "capped",
    canonicalUrl: "https://youtu.be/capped",
    transcriptOriginal: Array.from(
      { length: sources.MAX_TRANSCRIPT_ENTRIES + 1 },
      (_, index) => ({ start: index, text: `row ${index}` }),
    ),
    transcriptZh: Array.from(
      { length: sources.MAX_TRANSCRIPT_ENTRIES + 1 },
      (_, index) => ({ start: index, text: `译文 ${index}` }),
    ),
  });
  assert.equal(capped.transcriptOriginal.length, sources.MAX_TRANSCRIPT_ENTRIES);
  assert.equal(capped.transcriptTruncated, true);
  assert.equal(capped.transcriptTranslationComplete, false);
  const precheck = sources.buildExportPrecheck({
    groups: [
      {
        mediaKey: "capped",
        representative: { videoTitle: "Capped" },
        notes: [],
      },
    ],
    sourcesByKey: { capped },
    mode: "original",
  });
  assert.equal(precheck.hasBlocking, true);
  assert.equal(precheck.videos[0].hasOriginalTranscript, false);
  assert.match(precheck.videos[0].blockingReasons.join("；"), /裁剪/);
});

test("digest helper accepts original rows at the same semantic grouping as zh", () => {
  const source = sources.sourceFromDigest(
    "digest-grain",
    {
      videoTitle: "Digest",
      transcript: [
        { start: 0.1, text: "raw one" },
        { start: 0.2, text: "raw two" },
      ],
    },
    {
      transcriptOriginal: [
        { id: "grouped", start: 0.1, text: "raw one raw two" },
      ],
      transcriptZh: [
        { segmentId: "grouped", start: 0.1, text: "合并译文" },
      ],
    },
  );
  assert.equal(source.transcriptOriginal.length, 1);
  assert.equal(source.transcriptZh.length, 1);
});

test("Bilibili media keys produce stable provider-safe unit IDs", () => {
  const mediaKey = "bilibili:BV1xx411c7mD:2";
  const source = sources.normalizeNoteSource({
    mediaKey,
    platform: "youtube",
    sourceLanguage: "en",
    transcriptOriginal: [
      { id: "中文段落/1", start: 1.234, text: "English source" },
    ],
  });
  const plan = sources.buildExportTranslationPlan({
    groups: [
      {
        mediaKey,
        representative: { videoTitle: "English", platform: "youtube" },
        notes: [],
      },
    ],
    sourcesByKey: { [mediaKey]: source },
    mode: "zh",
    includeTitles: false,
  });
  assert.match(plan.sourceBatches[0][0].id, /^[A-Za-z0-9:_-]{1,128}$/);
});

test("batch validation is canonical and atomic commit rejects stale revisions", async () => {
  const storage = makeStorage();
  await sources.writeNoteSource(storage, {
    mediaKey: "atomic",
    sourceLanguage: "en",
    transcriptOriginal: [
      { id: "a", start: 0.1, text: "alpha" },
      { id: "b", start: 0.9, text: "beta" },
    ],
  });
  const stored = await sources.readNoteSource(storage, "atomic");
  const groups = [
    {
      mediaKey: "atomic",
      representative: { videoTitle: "Atomic" },
      notes: [],
    },
  ];
  const plan = sources.buildExportTranslationPlan({
    groups,
    sourcesByKey: { atomic: stored },
    mode: "zh",
    includeTitles: false,
  });
  const units = plan.sourceBatches[0];
  const valid = sources.validateExportSourceTranslationUnits(stored, {
    mediaKey: "atomic",
    sourceRevision: stored.sourceRevision,
    units,
  });
  assert.equal(valid.valid, true);
  const incomplete = await sources.commitExportSourceTranslationBatch(storage, {
    mediaKey: "atomic",
    expectedRevision: stored.sourceRevision,
    units,
    translationsById: { [units[0].id]: "甲" },
  });
  assert.equal(incomplete.changed, false);
  assert.equal((await sources.readNoteSource(storage, "atomic")).transcriptZh.length, 0);

  const committed = await sources.commitExportSourceTranslationBatch(storage, {
    mediaKey: "atomic",
    expectedRevision: stored.sourceRevision,
    units,
    translationsById: Object.fromEntries(
      units.map((unit, index) => [unit.id, index ? "乙" : "甲"]),
    ),
  });
  assert.equal(committed.changed, true);
  assert.equal(committed.sourceRevision, stored.sourceRevision);
  assert.equal((await sources.readNoteSource(storage, "atomic")).transcriptZh.length, 2);

  const oldUnit = units[0];
  await sources.writeNoteSource(storage, {
    mediaKey: "atomic",
    sourceLanguage: "en",
    transcriptOriginal: [
      { id: "a", start: 0.1, text: "alpha changed" },
      { id: "b", start: 0.9, text: "beta" },
    ],
  });
  const stale = await sources.commitExportSourceTranslationBatch(storage, {
    mediaKey: "atomic",
    expectedRevision: stored.sourceRevision,
    units: [oldUnit],
    translationsById: { [oldUnit.id]: "过期" },
  });
  assert.equal(stale.changed, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.code, "REVISION_MISMATCH");
});

test("description status distinguishes unknown, confirmed empty, and present", () => {
  assert.equal(
    sources.normalizeNoteSource({ mediaKey: "unknown" }).descriptionStatus,
    "unknown",
  );
  assert.equal(
    sources.normalizeNoteSource({
      mediaKey: "empty",
      descriptionStatus: "confirmed-empty",
    }).descriptionStatus,
    "confirmed-empty",
  );
  assert.equal(
    sources.normalizeNoteSource({
      mediaKey: "present",
      descriptionOriginal: "Description",
    }).descriptionStatus,
    "present",
  );
});
