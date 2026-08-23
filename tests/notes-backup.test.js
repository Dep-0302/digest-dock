const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const notesBackup = require("../notes-backup.js");
const noteSources = require("../note-sources.js");
const exportJobs = require("../export-jobs.js");
const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function makeNote(index, overrides = {}) {
  const timestampSeconds = index * 10 + 5;
  return {
    id: `note-${index}`,
    videoId: `video_${String(index).padStart(3, "0")}`,
    videoTitle: `Video ${index}`,
    channelName: `Channel ${index}`,
    timestamp: `${Math.floor(timestampSeconds / 60)}:${String(
      timestampSeconds % 60,
    ).padStart(2, "0")}`,
    timestampSeconds,
    timestampedUrl: `https://www.youtube.com/watch?v=video_${String(index).padStart(3, "0")}&t=${timestampSeconds}s`,
    text: `Note ${index}`,
    translatedText: `笔记 ${index}`,
    translatedValidated: true,
    translatedValidationVersion: 1,
    translatedUnchanged: false,
    rawText: `Raw note ${index}`,
    sourceLanguage: "en",
    createdAt: 1_700_000_000_000 + index,
    ...overrides,
  };
}

function makeBilibiliNote(index, overrides = {}) {
  const bvid = "BV1zfg36ZEXi";
  const cid = 40_830_435_549 + index;
  const page = 2;
  const mediaKey = `bilibili:${bvid}:${cid}`;
  return makeNote(index, {
    videoId: mediaKey,
    platform: "bilibili",
    mediaKey,
    bvid,
    cid,
    page,
    textLanguage: "zh-CN",
    timestampedUrl: `https://www.bilibili.com/video/${bvid}/?p=${page}&t=${index * 10 + 5}`,
    sourceLanguage: "zh-CN",
    ...overrides,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validBackupObject(notes = [makeNote(1)]) {
  return notesBackup.createBackup(notes, {
    exportedAt: "2026-08-18T12:34:56.000Z",
    extensionVersion: "1.2.1",
  });
}

function validV1BackupObject(notes = [makeNote(1)]) {
  const backup = validBackupObject(notes);
  backup.schemaVersion = 1;
  backup.notes.forEach((note) => {
    delete note.platform;
    delete note.mediaKey;
    delete note.textLanguage;
  });
  return backup;
}

function assertBackupError(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error?.name, "NotesBackupError");
    assert.equal(error?.code, code);
    return true;
  });
}

function loadBackgroundBackupHelpers({
  initialNotes = [],
  initialStorage = {},
  getImpl,
  setImpl,
  removeImpl,
  clearImpl,
  fetchImpl = fetch,
} = {}) {
  let storedValues = clone(initialStorage);
  if (initialNotes.length || !Object.hasOwn(storedValues, "ytd_notes")) {
    storedValues.ytd_notes = clone(initialNotes);
  }
  const writes = [];
  const removals = [];
  let clearCount = 0;
  const notifications = [];
  const listeners = { addListener() {} };

  const storageGet =
    getImpl ||
    (async (key) => {
      if (key === null) return clone(storedValues);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(
        keys
          .filter((storageKey) => Object.hasOwn(storedValues, storageKey))
          .map((storageKey) => [storageKey, clone(storedValues[storageKey])]),
      );
    });
  const storageSet =
    setImpl ||
    (async (items) => {
      writes.push(clone(items));
      for (const [key, value] of Object.entries(items)) {
        storedValues[key] = clone(value);
      }
    });
  const storageRemove =
    removeImpl ||
    (async (keys) => {
      const normalizedKeys = Array.isArray(keys) ? keys : [keys];
      removals.push(...normalizedKeys);
      for (const key of normalizedKeys) delete storedValues[key];
    });
  const storageClear =
    clearImpl ||
    (async () => {
      clearCount += 1;
      storedValues = {};
    });

  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    importScripts() {},
    YTD_NOTES_BACKUP: notesBackup,
    YTD_NOTE_SOURCES: noteSources,
    YTD_EXPORT_JOBS: exportJobs,
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value || {},
      chatCompletionsUrl: () => "https://api.deepseek.com/chat/completions",
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: storageGet,
          set: storageSet,
          remove: storageRemove,
          clear: storageClear,
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
        open: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        getManifest: () => ({ version: "1.2.1" }),
        sendMessage(message) {
          notifications.push(clone(message));
          return Promise.resolve();
        },
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        get: async () => ({ url: "https://www.youtube.com/" }),
      },
      scripting: { executeScript: async () => [] },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);

  return {
    helpers: sandbox.__YTD_TRANSLATION_TESTING__,
    notifications,
    readStorage: () => clone(storedValues),
    readStoredNotes: () => clone(storedValues.ytd_notes || []),
    removals,
    get clearCount() {
      return clearCount;
    },
    writes,
  };
}

test("notes backups round-trip only the allowed fields and rebuild derived values", () => {
  const source = makeNote(7, {
    timestamp: "99:99",
    timestampedUrl: "https://attacker.invalid/redirect",
    apiKey: "fake-ai",
    supadataApiKey: "fake-sub",
    settings: { provider: "private-provider" },
    transcriptCache: "private transcript cache",
    digestCache: "private digest cache",
  });
  const backup = validBackupObject([source]);
  const serialized = JSON.stringify(backup);

  assert.deepEqual(Object.keys(backup), [
    "format",
    "schemaVersion",
    "exportedAt",
    "extensionVersion",
    "notes",
  ]);
  assert.deepEqual(Object.keys(backup.notes[0]), [
    "id",
    "platform",
    "mediaKey",
    "videoId",
    "textLanguage",
    "videoTitle",
    "videoTitleZh",
    "videoTitleZhValidated",
    "videoTitleZhValidationVersion",
    "channelName",
    "timestampSeconds",
    "text",
    "translatedText",
    "translatedValidated",
    "translatedValidationVersion",
    "translatedUnchanged",
    "rawText",
    "sourceLanguage",
    "createdAt",
  ]);
  for (const privateValue of [
    "fake-ai",
    "fake-sub",
    "private-provider",
    "private transcript cache",
    "private digest cache",
    "attacker.invalid",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue));
  }
  assert.doesNotMatch(serialized, /apiKey|settings|transcriptCache|digestCache/);
  assert.equal(backup.schemaVersion, 3);
  assert.equal(backup.notes[0].platform, "youtube");
  assert.equal(backup.notes[0].mediaKey, source.videoId);

  // Even if a hand-edited file adds forged derived values, import ignores them.
  backup.notes[0].timestamp = "99:99";
  backup.notes[0].timestampedUrl = "javascript:alert(1)";
  const [restored] = notesBackup.parseBackupText(JSON.stringify(backup));

  assert.equal(restored.timestamp, "1:15");
  assert.equal(
    restored.timestampedUrl,
    "https://www.youtube.com/watch?v=video_007&t=75s",
  );
  assert.equal(restored.text, source.text);
  assert.equal(restored.translatedText, source.translatedText);
  assert.equal(restored.translatedValidated, true);
  assert.equal(restored.translatedValidationVersion, 1);
  assert.equal(restored.translatedUnchanged, false);
  assert.equal(restored.rawText, source.rawText);
});

test("schema v1 YouTube backups remain importable and rebuild safe YouTube URLs", () => {
  const source = makeNote(6);
  const backup = validV1BackupObject([source]);
  backup.notes[0].timestampedUrl = "javascript:alert(1)";
  backup.notes[0].platform = "bilibili";
  backup.notes[0].mediaKey = "bilibili:BV1zfg36ZEXi:40830435549";

  const [restored] = notesBackup.parseBackupText(JSON.stringify(backup));

  assert.equal(restored.platform, "youtube");
  assert.equal(restored.videoId, source.videoId);
  assert.equal(restored.mediaKey, source.videoId);
  assert.equal(restored.textLanguage, "");
  assert.equal(
    restored.timestampedUrl,
    `https://www.youtube.com/watch?v=${source.videoId}&t=${source.timestampSeconds}s`,
  );
});

test("DigestDock keeps accepting the literal legacy backup format for schema v1 and v2", () => {
  const backups = [validV1BackupObject([makeNote(8)]), validBackupObject([makeNote(9)])];

  for (const backup of backups) {
    backup.format = "youtube-digest-notes-backup";
    const [restored] = notesBackup.parseBackupText(JSON.stringify(backup));
    assert.equal(restored.platform, "youtube");
    assert.ok(restored.videoId);
  }
});

test("schema v2 Bilibili notes round-trip strict media identity and rebuild timestamp URLs", () => {
  const source = makeBilibiliNote(4, {
    timestamp: "99:99",
    timestampedUrl: "https://attacker.invalid/redirect",
    canonicalUrl: "javascript:alert(1)",
  });
  const backup = validBackupObject([source]);
  const serialized = JSON.stringify(backup);

  assert.equal(backup.schemaVersion, 3);
  assert.deepEqual(Object.keys(backup.notes[0]), [
    "id",
    "platform",
    "mediaKey",
    "videoId",
    "bvid",
    "cid",
    "page",
    "textLanguage",
    "videoTitle",
    "videoTitleZh",
    "videoTitleZhValidated",
    "videoTitleZhValidationVersion",
    "channelName",
    "timestampSeconds",
    "text",
    "translatedText",
    "translatedValidated",
    "translatedValidationVersion",
    "translatedUnchanged",
    "rawText",
    "sourceLanguage",
    "createdAt",
  ]);
  assert.doesNotMatch(serialized, /attacker\.invalid|javascript|canonicalUrl/);

  // Derived URL fields in a hand-edited backup are never trusted.
  backup.notes[0].timestampedUrl = "https://attacker.invalid/redirect";
  backup.notes[0].canonicalUrl = "javascript:alert(1)";
  const [restored] = notesBackup.parseBackupText(JSON.stringify(backup));

  assert.equal(restored.platform, "bilibili");
  assert.equal(restored.mediaKey, source.mediaKey);
  assert.equal(restored.videoId, source.mediaKey);
  assert.equal(restored.bvid, source.bvid);
  assert.equal(restored.cid, source.cid);
  assert.equal(restored.page, source.page);
  assert.equal(restored.textLanguage, "zh-CN");
  assert.equal(restored.timestamp, "0:45");
  assert.equal(
    restored.timestampedUrl,
    `https://www.bilibili.com/video/${source.bvid}/?p=2&t=45`,
  );
});

test("schema v2 rejects inconsistent or malformed cross-platform media identity", () => {
  const invalidBilibiliCases = [
    ["platform", "youtube"],
    ["platform", "Bilibili"],
    ["mediaKey", "bilibili:BV1zfg36ZEXi:999"],
    ["videoId", "bilibili:BV1zfg36ZEXi:999"],
    ["bvid", "av123"],
    ["cid", 0],
    ["cid", 1.5],
    ["page", 0],
    ["page", 1.5],
    ["textLanguage", "zh CN"],
    ["textLanguage", "zh-CN\u0000"],
  ];

  for (const [field, value] of invalidBilibiliCases) {
    const invalid = validBackupObject([makeBilibiliNote(5)]);
    invalid.notes[0][field] = value;
    assertBackupError(
      () => notesBackup.parseBackupText(JSON.stringify(invalid)),
      "INVALID_NOTES_BACKUP",
    );
  }

  for (const field of [
    "platform",
    "mediaKey",
    "videoId",
    "bvid",
    "cid",
    "page",
    "textLanguage",
  ]) {
    const missing = validBackupObject([makeBilibiliNote(5)]);
    delete missing.notes[0][field];
    assertBackupError(
      () => notesBackup.parseBackupText(JSON.stringify(missing)),
      "INVALID_NOTES_BACKUP",
    );
  }

  const youtubeMediaKeyMismatch = validBackupObject([makeNote(5)]);
  youtubeMediaKeyMismatch.notes[0].mediaKey = "different-video";
  assertBackupError(
    () => notesBackup.parseBackupText(JSON.stringify(youtubeMediaKeyMismatch)),
    "INVALID_NOTES_BACKUP",
  );

  const youtubeMissingPlatform = validBackupObject([makeNote(5)]);
  delete youtubeMissingPlatform.notes[0].platform;
  assertBackupError(
    () => notesBackup.parseBackupText(JSON.stringify(youtubeMissingPlatform)),
    "INVALID_NOTES_BACKUP",
  );
});

test("legacy backups without translation validation metadata remain importable", () => {
  const legacyBackup = validBackupObject([makeNote(8)]);
  delete legacyBackup.notes[0].translatedValidated;
  delete legacyBackup.notes[0].translatedValidationVersion;
  delete legacyBackup.notes[0].translatedUnchanged;

  const [restored] = notesBackup.parseBackupText(JSON.stringify(legacyBackup));

  assert.equal(restored.translatedValidated, false);
  assert.equal(restored.translatedValidationVersion, 0);
  assert.equal(restored.translatedUnchanged, false);
});

test("backup parsing rejects damaged JSON, newer versions, oversized input, and invalid note fields", () => {
  assertBackupError(
    () => notesBackup.parseBackupText('{"format":'),
    "INVALID_NOTES_BACKUP",
  );

  const newer = validBackupObject();
  newer.schemaVersion = notesBackup.SCHEMA_VERSION + 1;
  assertBackupError(
    () => notesBackup.parseBackupText(JSON.stringify(newer)),
    "UNSUPPORTED_NOTES_BACKUP_VERSION",
  );

  assertBackupError(
    () => notesBackup.parseBackupText("x".repeat(notesBackup.MAX_BACKUP_BYTES + 1)),
    "NOTES_BACKUP_TOO_LARGE",
  );

  const invalidCases = [
    ["id", "invalid id with spaces"],
    ["videoId", "https://youtube.com/watch?v=abc"],
    ["timestampSeconds", 1.5],
    ["timestampSeconds", -1],
    ["text", "unsafe\u0000text"],
    ["createdAt", -1],
    ["translatedValidated", "yes"],
    ["translatedValidationVersion", -1],
    ["translatedUnchanged", "yes"],
    ["videoTitleZhValidated", "yes"],
    ["videoTitleZhValidationVersion", 5],
    ["videoTitleZh", "z".repeat(501)],
  ];
  for (const [field, value] of invalidCases) {
    const invalid = validBackupObject();
    invalid.notes[0][field] = value;
    assertBackupError(
      () => notesBackup.parseBackupText(JSON.stringify(invalid)),
      "INVALID_NOTES_BACKUP",
    );
  }
});

test("schema v3 round-trips validated Chinese video titles", () => {
  const source = makeNote(30, {
    videoTitle: "The Future of AI",
    videoTitleZh: "人工智能的未来",
    videoTitleZhValidated: true,
    videoTitleZhValidationVersion: 1,
  });
  const backup = validBackupObject([source]);
  assert.equal(backup.schemaVersion, 3);
  assert.equal(backup.notes[0].videoTitleZh, "人工智能的未来");

  const [restored] = notesBackup.parseBackupText(JSON.stringify(backup));
  assert.equal(restored.videoTitle, "The Future of AI");
  assert.equal(restored.videoTitleZh, "人工智能的未来");
  assert.equal(restored.videoTitleZhValidated, true);
  assert.equal(restored.videoTitleZhValidationVersion, 1);
});

test("schema v1 and v2 backups import with empty title translation fields", () => {
  const v1 = validV1BackupObject([makeNote(31)]);
  const v2 = validBackupObject([makeNote(32)]);
  v2.schemaVersion = 2;
  v2.notes.forEach((note) => {
    delete note.videoTitleZh;
    delete note.videoTitleZhValidated;
    delete note.videoTitleZhValidationVersion;
  });

  for (const backup of [v1, v2]) {
    const [restored] = notesBackup.parseBackupText(JSON.stringify(backup));
    assert.equal(restored.videoTitleZh, "");
    assert.equal(restored.videoTitleZhValidated, false);
    assert.equal(restored.videoTitleZhValidationVersion, 0);
  }
});

test("merging fills an empty title but never overwrites a different validated title", () => {
  const local = makeNote(33, {
    videoTitleZh: "",
    videoTitleZhValidated: false,
    videoTitleZhValidationVersion: 0,
  });
  const imported = makeNote(33, {
    videoTitleZh: "已验证的中文标题",
    videoTitleZhValidated: true,
    videoTitleZhValidationVersion: 1,
  });
  const filled = notesBackup.mergeNotes([local], [imported]);
  assert.equal(filled.enrichedCount, 1);
  assert.equal(filled.notes[0].videoTitleZh, "已验证的中文标题");
  assert.equal(filled.notes[0].videoTitleZhValidated, true);

  // A different, already-validated local title is kept; the import cannot clobber it.
  const localValidated = makeNote(34, {
    videoTitleZh: "本地已验证标题",
    videoTitleZhValidated: true,
    videoTitleZhValidationVersion: 1,
  });
  const importedOther = makeNote(34, {
    videoTitleZh: "导入的不同标题",
    videoTitleZhValidated: true,
    videoTitleZhValidationVersion: 1,
  });
  const kept = notesBackup.mergeNotes([localValidated], [importedOther]);
  assert.equal(kept.enrichedCount, 0);
  assert.equal(kept.notes[0].videoTitleZh, "本地已验证标题");
});

test("backups preserve legacy notes that exceed current save-time field limits", () => {
  const legacy = makeNote(9, {
    videoTitle: "",
    text: "t".repeat(3_501),
    translatedText: "译".repeat(3_201),
    rawText: "r".repeat(4_001),
    sourceLanguage: "legacy-language-tag-over-20",
  });

  const [restored] = notesBackup.parseBackupText(
    JSON.stringify(validBackupObject([legacy])),
  );

  assert.equal(restored.videoTitle, "");
  assert.equal(restored.text.length, 3_501);
  assert.equal(restored.translatedText.length, 3_201);
  assert.equal(restored.rawText.length, 4_001);
  assert.equal(restored.sourceLanguage, "legacy-language-tag-over-20");
});

test("export repairs duplicate legacy IDs deterministically and restores both notes", () => {
  const duplicateId = "legacy-duplicate-id";
  const legacyNotes = [
    makeNote(70, { id: duplicateId, text: "First legacy note" }),
    makeNote(71, { id: duplicateId, text: "Second legacy note" }),
  ];

  const firstBackup = validBackupObject(legacyNotes);
  const secondBackup = validBackupObject(legacyNotes);
  const ids = firstBackup.notes.map((note) => note.id);

  assert.equal(firstBackup.notes.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids[0], duplicateId);
  assert.match(
    ids[1],
    new RegExp(`^note_restored_${legacyNotes[1].createdAt}_1_0$`),
  );
  assert.deepEqual(
    secondBackup.notes.map((note) => note.id),
    ids,
  );

  const restored = notesBackup.parseBackupText(JSON.stringify(firstBackup));
  assert.equal(restored.length, 2);
  assert.deepEqual(
    restored.map((note) => note.text),
    ["First legacy note", "Second legacy note"],
  );
});

test("manually supplied backups with duplicate IDs are rejected", () => {
  const backup = validBackupObject([makeNote(72), makeNote(73)]);
  backup.notes[1].id = backup.notes[0].id;

  assertBackupError(
    () => notesBackup.parseBackupText(JSON.stringify(backup)),
    "INVALID_NOTES_BACKUP",
  );
});

test("duplicate imports are idempotent and can fill missing optional note fields", () => {
  const local = makeNote(10, {
    channelName: "",
    translatedText: "",
    translatedValidated: false,
    translatedValidationVersion: 0,
    translatedUnchanged: false,
    rawText: "",
    sourceLanguage: "",
  });
  const imported = makeNote(10, {
    channelName: "Restored channel",
    translatedText: "补全的翻译",
    rawText: "Restored raw text",
    sourceLanguage: "en",
  });

  const first = notesBackup.mergeNotes([local], [imported]);
  assert.equal(first.importedCount, 0);
  assert.equal(first.duplicateCount, 1);
  assert.equal(first.enrichedCount, 1);
  assert.equal(first.totalCount, 1);
  assert.equal(first.changed, true);
  assert.equal(first.notes[0].id, local.id);
  assert.equal(first.notes[0].channelName, "Restored channel");
  assert.equal(first.notes[0].translatedText, "补全的翻译");
  assert.equal(first.notes[0].translatedValidated, true);
  assert.equal(first.notes[0].translatedValidationVersion, 1);
  assert.equal(first.notes[0].rawText, "Restored raw text");

  const second = notesBackup.mergeNotes(first.notes, [imported]);
  assert.equal(second.importedCount, 0);
  assert.equal(second.duplicateCount, 1);
  assert.equal(second.enrichedCount, 0);
  assert.equal(second.totalCount, 1);
  assert.equal(second.changed, false);
  assert.deepEqual(second.notes, first.notes);
});

test("Bilibili duplicate merges preserve strict media identity and enrich text language", () => {
  const local = makeBilibiliNote(14, {
    textLanguage: "",
    sourceLanguage: "",
  });
  const imported = makeBilibiliNote(14);

  const merged = notesBackup.mergeNotes([local], [imported]);

  assert.equal(merged.importedCount, 0);
  assert.equal(merged.duplicateCount, 1);
  assert.equal(merged.enrichedCount, 1);
  assert.equal(merged.notes[0].platform, "bilibili");
  assert.equal(merged.notes[0].mediaKey, imported.mediaKey);
  assert.equal(merged.notes[0].textLanguage, "zh-CN");
  assert.equal(
    merged.notes[0].timestampedUrl,
    `https://www.bilibili.com/video/${imported.bvid}/?p=2&t=${imported.timestampSeconds}`,
  );

  const conflictingPage = makeBilibiliNote(14, { page: 3 });
  assertBackupError(
    () => notesBackup.mergeNotes([local], [conflictingPage]),
    "NOTES_BACKUP_CONFLICT",
  );
});

test("validated unchanged translations survive backup restore without a provider call", async () => {
  const source = makeNote(12, {
    text: "OpenAI",
    translatedText: "OpenAI",
    translatedValidated: true,
    translatedValidationVersion: 1,
    translatedUnchanged: true,
  });
  const backupText = JSON.stringify(validBackupObject([source]));
  let apiCalls = 0;
  const state = loadBackgroundBackupHelpers({
    fetchImpl: async () => {
      apiCalls += 1;
      throw new Error("A restored validated note must not call the provider");
    },
  });

  const importResult = await state.helpers.handleImportNotesBackup(backupText);
  assert.equal(importResult.success, true);
  const [restored] = state.readStoredNotes();
  assert.equal(restored.translatedText, "OpenAI");
  assert.equal(restored.translatedValidated, true);
  assert.equal(restored.translatedValidationVersion, 1);
  assert.equal(restored.translatedUnchanged, true);

  const translationResult = await state.helpers.handleTranslateNotes([restored]);
  assert.equal(translationResult.success, true);
  assert.equal(apiCalls, 0);
  assert.equal(translationResult.translations[0].textZh, "OpenAI");
  assert.equal(translationResult.translations[0].unchanged, true);
});

test("notes with the same semantic content but different IDs are both preserved", () => {
  const existing = makeNote(11);
  const imported = makeNote(11, {
    id: "independent-note-id",
    createdAt: existing.createdAt + 1,
  });

  const result = notesBackup.mergeNotes([existing], [imported]);

  assert.equal(result.importedCount, 1);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.enrichedCount, 0);
  assert.equal(result.totalCount, 2);
  assert.equal(result.changed, true);
  assert.deepEqual(
    result.notes.map((note) => note.id),
    [imported.id, existing.id],
  );
});

test("a reused note ID with different identity content fails without mutating inputs", () => {
  const existing = [makeNote(20)];
  const imported = [makeNote(20, { text: "Conflicting note text" })];
  const existingBefore = clone(existing);
  const importedBefore = clone(imported);

  assertBackupError(
    () => notesBackup.mergeNotes(existing, imported),
    "NOTES_BACKUP_CONFLICT",
  );
  assert.deepEqual(existing, existingBefore);
  assert.deepEqual(imported, importedBefore);
});

test("the 100-note capacity check rejects the whole merge atomically", () => {
  const existing = Array.from({ length: notesBackup.MAX_NOTES }, (_, index) =>
    makeNote(index),
  );
  const existingBefore = clone(existing);

  assertBackupError(
    () => notesBackup.mergeNotes(existing, [makeNote(1_000)]),
    "NOTES_CAPACITY_EXCEEDED",
  );
  assert.deepEqual(existing, existingBefore);
});

test("background imports share the note write queue with normal note saves", async () => {
  const state = loadBackgroundBackupHelpers();
  const savedDuringImport = makeNote(30, { createdAt: 30 });
  const imported = makeNote(31, { createdAt: 31 });
  const backupText = JSON.stringify(validBackupObject([imported]));

  const savePromise = state.helpers.saveNoteToStorage(savedDuringImport);
  const importPromise = state.helpers.handleImportNotesBackup(backupText);
  const [, result] = await Promise.all([savePromise, importPromise]);

  assert.equal(result.success, true);
  assert.equal(result.importedCount, 1);
  assert.equal(result.totalCount, 2);
  assert.deepEqual(
    state.readStoredNotes().map((note) => note.id),
    [imported.id, savedDuringImport.id],
  );
  assert.equal(state.writes.length, 2);
  assert.deepEqual(state.notifications, [{ action: "notesChanged" }]);
});

test("background import and clear operations serialize through one write queue", async () => {
  const state = loadBackgroundBackupHelpers({ initialNotes: [makeNote(50)] });
  const importPromise = state.helpers.handleImportNotesBackup(
    JSON.stringify(validBackupObject([makeNote(51)])),
  );
  const clearPromise = state.helpers.handleClearAllNotes();

  const [importResult, clearResult] = await Promise.all([
    importPromise,
    clearPromise,
  ]);

  assert.equal(importResult.success, true);
  assert.equal(importResult.totalCount, 2);
  assert.equal(clearResult.success, true);
  assert.deepEqual(state.readStoredNotes(), []);
  assert.deepEqual(state.removals, ["ytd_notes"]);
  assert.deepEqual(state.notifications, [
    { action: "notesChanged" },
    { action: "notesChanged" },
  ]);
});

test("background reset clears extension data and restores the selected UI language", async () => {
  const state = loadBackgroundBackupHelpers({
    initialStorage: {
      ytd_notes: [makeNote(60)],
      ytd_settings: { aiApiKey: "fake" },
      digest_video_060: { cached: true },
      ytd_options_language: "zh-CN",
    },
  });

  const result = await state.helpers.handleResetAllExtensionData("en");

  assert.equal(result.success, true);
  assert.equal(state.clearCount, 1);
  assert.deepEqual(state.readStorage(), { ytd_options_language: "en" });
  assert.deepEqual(state.notifications, [{ action: "notesChanged" }]);
});

test("clear and reset reject slow saves captured under an older generation", async () => {
  const clearState = loadBackgroundBackupHelpers();
  const clearGeneration = clearState.helpers.getNoteStorageGeneration();
  await clearState.helpers.handleClearAllNotes();

  assert.equal(
    clearState.helpers.getNoteStorageGeneration(),
    clearGeneration + 1,
  );
  assert.equal(
    await clearState.helpers.saveNoteToStorage(makeNote(80), clearGeneration),
    false,
  );
  assert.deepEqual(clearState.readStoredNotes(), []);
  assert.equal(clearState.writes.length, 0);

  const resetState = loadBackgroundBackupHelpers({
    initialStorage: { ytd_options_language: "zh-CN" },
  });
  const resetGeneration = resetState.helpers.getNoteStorageGeneration();
  await resetState.helpers.handleResetAllExtensionData("zh-CN");

  assert.equal(
    resetState.helpers.getNoteStorageGeneration(),
    resetGeneration + 1,
  );
  assert.equal(
    await resetState.helpers.saveNoteToStorage(makeNote(81), resetGeneration),
    false,
  );
  assert.deepEqual(resetState.readStoredNotes(), []);
  assert.deepEqual(resetState.readStorage(), {
    ytd_options_language: "zh-CN",
  });
  assert.equal(
    resetState.writes.filter((items) => Object.hasOwn(items, "ytd_notes")).length,
    0,
  );
});

test("note IDs use UUIDs when available and unique timestamp-random fallbacks otherwise", () => {
  const state = loadBackgroundBackupHelpers();
  const uuidValues = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const uuidIds = uuidValues.map((uuid) =>
    state.helpers.createNoteId({ randomUUID: () => uuid }),
  );

  assert.deepEqual(uuidIds, uuidValues.map((uuid) => `note_${uuid}`));
  assert.equal(new Set(uuidIds).size, uuidIds.length);
  uuidIds.forEach((id) =>
    assert.match(
      id,
      /^note_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  );

  const randomValues = [0.123456789, 0.987654321];
  const fallbackIds = randomValues.map((randomValue) =>
    state.helpers.createNoteId({
      now: () => 1_700_000_000_000,
      randomUUID: null,
      random: () => randomValue,
    }),
  );

  assert.equal(new Set(fallbackIds).size, fallbackIds.length);
  fallbackIds.forEach((id) =>
    assert.match(id, /^note_1700000000000_[a-z0-9]{1,10}$/),
  );
});

test("background import failures perform zero storage writes", async () => {
  const existing = Array.from({ length: notesBackup.MAX_NOTES }, (_, index) =>
    makeNote(index),
  );
  const existingBefore = clone(existing);
  const state = loadBackgroundBackupHelpers({ initialNotes: existing });

  const damaged = await state.helpers.handleImportNotesBackup("not json");
  assert.equal(damaged.success, false);
  assert.equal(damaged.code, "INVALID_NOTES_BACKUP");

  const overCapacity = await state.helpers.handleImportNotesBackup(
    JSON.stringify(validBackupObject([makeNote(2_000)])),
  );
  assert.equal(overCapacity.success, false);
  assert.equal(overCapacity.code, "NOTES_CAPACITY_EXCEEDED");
  assert.equal(overCapacity.overBy, 1);
  assert.equal(state.writes.length, 0);
  assert.deepEqual(state.readStoredNotes(), existingBefore);
  assert.deepEqual(state.notifications, []);
});

test("the JSON download helper uses an object URL and cleans it up", () => {
  const actions = [];
  let createdBlob;
  const link = {
    href: "",
    download: "",
    hidden: false,
    click() {
      actions.push("click");
    },
    remove() {
      actions.push("remove");
    },
  };
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options.type;
    }
  }
  const fakeRoot = {
    Blob: FakeBlob,
    URL: {
      createObjectURL(blob) {
        createdBlob = blob;
        actions.push("create-url");
        return "blob:notes-backup";
      },
      revokeObjectURL(url) {
        actions.push(`revoke:${url}`);
      },
    },
    document: {
      createElement(tag) {
        assert.equal(tag, "a");
        return link;
      },
      body: {
        appendChild(element) {
          assert.equal(element, link);
          actions.push("append");
        },
      },
    },
    YTD_NOTES_BACKUP: notesBackup,
  };
  const backup = validBackupObject([makeNote(40)]);

  const result = options.triggerNotesBackupDownload(
    fakeRoot,
    backup,
    new Date("2026-08-18T23:59:59.000Z"),
  );

  assert.equal(result.filename, "digest-dock-notes-2026-08-18.json");
  assert.equal(link.download, result.filename);
  assert.equal(link.href, "blob:notes-backup");
  assert.equal(link.hidden, true);
  assert.equal(createdBlob.type, "application/json");
  assert.deepEqual(createdBlob.parts, [result.text]);
  assert.equal(result.text.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(result.text), backup);
  assert.deepEqual(actions, [
    "create-url",
    "append",
    "click",
    "remove",
    "revoke:blob:notes-backup",
  ]);
});

test("new note saves retain the current 3000-character and 20-character limits", () => {
  const background = read("background.js");

  assert.match(
    background,
    /const normalizedNoteText =[\s\S]*?\.slice\(0, 3000\);/,
  );
  assert.match(
    background,
    /rawText: String\(matchedLine\.text \|\| ""\)\.trim\(\)\.slice\(0, 3000\)/,
  );
  assert.match(
    background,
    /const storedSourceLanguage =[\s\S]*?matchedLanguage\.length <= 20[\s\S]*?sourceLanguage: storedSourceLanguage/,
  );
});
