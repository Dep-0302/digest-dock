const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const notesBackup = require("../notes-backup.js");
const noteExport = require("../note-export.js");
const noteSources = require("../note-sources.js");
const exportJobs = require("../export-jobs.js");
const bilibiliAdapter = require("../bilibili.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const PHASE1_API_NAMES = [
  "ensureNotesMigrated",
  "readAllNotes",
  "readNotesByMedia",
  "readNoteIndex",
  "appendNote",
  "replaceNotes",
  "deleteNote",
];

// The prose says 21 fields, but its explicit list contains these 22. The list
// is the only deterministic contract, so the migration tests preserve every
// listed value rather than silently choosing one to omit.
const SPEC_RECORD_FIELDS = [
  "id",
  "videoId",
  "mediaKey",
  "platform",
  "canonicalUrl",
  "bvid",
  "cid",
  "page",
  "videoTitle",
  "channelName",
  "timestamp",
  "timestampSeconds",
  "timestampedUrl",
  "text",
  "translatedText",
  "translatedValidated",
  "translatedValidationVersion",
  "translatedUnchanged",
  "rawText",
  "sourceLanguage",
  "textLanguage",
  "createdAt",
];

const INDEX_FIELDS = [
  "id",
  "mediaKey",
  "platform",
  "videoTitle",
  "channelName",
  "timestampSeconds",
  "savedAt",
  "hasThought",
  "searchText",
];

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function makeMigrationNote(index, overrides = {}) {
  const videoId = `video_${String(index % 4).padStart(5, "0")}`;
  const timestampSeconds = index * 7 + 3;
  const minutes = Math.floor(timestampSeconds / 60);
  const seconds = timestampSeconds % 60;
  return {
    id: `note_${String(index).padStart(5, "0")}`,
    videoId,
    mediaKey: videoId,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    bvid: "",
    cid: null,
    page: null,
    videoTitle: `Video ${index}`,
    channelName: `Channel ${index % 9}`,
    timestamp: `${minutes}:${String(seconds).padStart(2, "0")}`,
    timestampSeconds,
    timestampedUrl: `https://www.youtube.com/watch?v=${videoId}&t=${timestampSeconds}s`,
    text: `Cleaned note ${index}`,
    translatedText: `中文笔记 ${index}`,
    translatedValidated: true,
    translatedValidationVersion: 1,
    translatedUnchanged: false,
    rawText: `Raw note ${index}`,
    sourceLanguage: "en",
    textLanguage: "en",
    createdAt: 1_800_000_000_000 - index,
    // These fields are already written by the Phase 0 runtime. They are not
    // new Phase 1 fields and must not disappear merely because the field list
    // in the migration spec is stale.
    videoTitleZh: `视频 ${index}`,
    videoTitleZhSourceHash: `title-hash-${index}`,
    videoTitleZhValidated: true,
    videoTitleZhValidationVersion: 1,
    ...overrides,
  };
}

function makeLibrary(count, mediaCount = 4) {
  return Array.from({ length: count }, (_, index) => {
    const slot = index % mediaCount;
    const videoId = `media_${String(slot).padStart(5, "0")}`;
    return makeMigrationNote(index, {
      videoId,
      mediaKey: videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      timestampedUrl: `https://www.youtube.com/watch?v=${videoId}&t=${index * 7 + 3}s`,
    });
  });
}

function createAsyncGate() {
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const released = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  return {
    entered,
    enter() {
      enteredResolve();
      return released;
    },
    release() {
      releaseResolve();
    },
  };
}

function requestedKeys(keys) {
  if (keys === null || keys === undefined) return null;
  if (Array.isArray(keys)) return keys;
  if (typeof keys === "object") return Object.keys(keys);
  return [keys];
}

function createStorageHarness(initial = {}, { onSet } = {}) {
  let values = clone(initial);
  const operations = [];

  const commitSet = async (items) => {
    const copy = clone(items);
    operations.push({ type: "set", keys: Object.keys(copy), items: copy });
    Object.assign(values, copy);
  };

  const area = {
    setAccessLevel: async () => {},
    async get(keys) {
      operations.push({ type: "get", keys: clone(keys) });
      if (keys === null || keys === undefined) return clone(values);
      if (typeof keys === "object" && !Array.isArray(keys)) {
        const result = clone(keys);
        for (const key of Object.keys(keys)) {
          if (Object.hasOwn(values, key)) result[key] = clone(values[key]);
        }
        return result;
      }
      const selected = requestedKeys(keys);
      return Object.fromEntries(
        selected
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, clone(values[key])]),
      );
    },
    async set(items) {
      if (onSet) return onSet(clone(items), commitSet);
      return commitSet(items);
    },
    async remove(keys) {
      const selected = Array.isArray(keys) ? keys : [keys];
      operations.push({ type: "remove", keys: clone(selected) });
      for (const key of selected) delete values[key];
    },
    async clear() {
      operations.push({ type: "clear", keys: Object.keys(values) });
      values = {};
    },
  };

  return {
    area,
    operations,
    snapshot: () => clone(values),
  };
}

function findBackupValue(value, seen = new Set()) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return findBackupValue(JSON.parse(value), seen);
    } catch (_error) {
      return null;
    }
  }
  if (typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (
    value.format === notesBackup.FORMAT &&
    Array.isArray(value.notes)
  ) {
    return clone(value);
  }
  for (const child of Object.values(value)) {
    const backup = findBackupValue(child, seen);
    if (backup) return backup;
  }
  return null;
}

function backupFromDataUrl(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  try {
    const text = /;base64(?:;|$)/i.test(header)
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
    return findBackupValue(text);
  } catch (_error) {
    return null;
  }
}

function findFilename(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/filename|fileName|download/i.test(key) && typeof child === "string") {
      if (/digest-dock-notes-\d{4}-\d{2}-\d{2}\.json$/.test(child)) {
        return child;
      }
    }
  }
  for (const child of Object.values(value)) {
    const filename = findFilename(child, seen);
    if (filename) return filename;
  }
  return "";
}

function isMigrationBackupMessage(message) {
  const action = String(message?.action || "");
  return (
    /backup/i.test(action) &&
    /download/i.test(action) &&
    !!findBackupValue(message)
  );
}

function bootBackground(
  storage,
  { downloadSucceeds = true, downloadError = "BACKUP_DOWNLOAD_FAILED" } = {},
) {
  const listeners = { addListener() {} };
  const notifications = [];

  const recordDownload = (payload, source) => {
    const backup =
      findBackupValue(payload) || backupFromDataUrl(payload?.url || "");
    const filename = findFilename(payload);
    storage.operations.push({
      type: "download",
      source,
      backup,
      filename,
      payload: clone(payload),
    });
  };

  const sandbox = {
    console,
    URL,
    Blob,
    TextDecoder,
    TextEncoder,
    AbortController,
    fetch,
    setTimeout,
    clearTimeout,
    importScripts() {},
    YTD_NOTES_BACKUP: notesBackup,
    YTD_NOTE_SOURCES: noteSources,
    YTD_EXPORT_JOBS: exportJobs,
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value || {},
      hasActiveApiKey: () => false,
      chatCompletionsUrl: () => "https://api.deepseek.com/chat/completions",
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
    BILIBILI_ADAPTER: bilibiliAdapter,
    chrome: {
      storage: {
        local: storage.area,
        session: createStorageHarness().area,
      },
      downloads: {
        async download(options) {
          recordDownload(options, "chrome.downloads");
          if (!downloadSucceeds) throw new Error(downloadError);
          return 1;
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: async () => {},
        open: async () => {},
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        getManifest: () => ({ version: "2.0.0" }),
        async sendMessage(message) {
          const copied = clone(message);
          notifications.push(copied);
          if (isMigrationBackupMessage(copied)) {
            recordDownload(copied, "runtime-message");
            return downloadSucceeds
              ? { success: true, filename: copied.filename }
              : { success: false, code: downloadError };
          }
          return { success: true };
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
    api: sandbox.__YTD_TRANSLATION_TESTING__,
    notifications,
  };
}

function requirePhase1Api(api, matrix) {
  const missing = PHASE1_API_NAMES.filter(
    (name) => typeof api?.[name] !== "function",
  );
  assert.deepEqual(
    missing,
    [],
    `${matrix}: missing Phase 1 migration/access functions: ${missing.join(", ")}`,
  );
  return api;
}

function structureKeys(snapshot) {
  return Object.keys(snapshot)
    .filter(
      (key) =>
        key === "ytd_notes_schema" ||
        key === "ytd_note_index" ||
        key.startsWith("ytd_notes_"),
    )
    .sort();
}

function shardKeys(snapshot) {
  return Object.keys(snapshot)
    .filter(
      (key) =>
        key.startsWith("ytd_notes_") && key !== "ytd_notes_schema",
    )
    .sort();
}

function mediaKeyFor(note) {
  return String(note?.mediaKey || note?.videoId || "");
}

function expectedSearchText(note) {
  return [note?.thought, note?.rawText, note?.videoTitle, note?.channelName]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function assertIndexEntry(entry, note) {
  assert.deepEqual(Object.keys(entry).sort(), [...INDEX_FIELDS].sort());
  assert.equal(entry.id, note.id);
  assert.equal(entry.mediaKey, mediaKeyFor(note));
  assert.equal(entry.platform, note.platform);
  assert.equal(entry.videoTitle, note.videoTitle);
  assert.equal(entry.channelName, note.channelName);
  assert.equal(entry.timestampSeconds, note.timestampSeconds);
  assert.equal(entry.savedAt, note.createdAt);
  assert.equal(entry.hasThought, false);
  assert.equal(entry.searchText, expectedSearchText(note));
}

async function assertMigratedLibrary(api, storage, originalNotes) {
  const snapshot = storage.snapshot();
  assert.equal(snapshot.ytd_notes_schema, 1);
  assert.deepEqual(snapshot.ytd_notes, originalNotes);
  assert.equal(snapshot.ytd_note_index.length, originalNotes.length);
  assert.deepEqual(
    snapshot.ytd_note_index.map((entry) => entry.id),
    originalNotes.map((note) => note.id),
    "the index must retain the old flat-array order so readAllNotes can reconstruct it",
  );
  snapshot.ytd_note_index.forEach((entry, index) =>
    assertIndexEntry(entry, originalNotes[index]),
  );

  const expectedGroups = new Map();
  for (const note of originalNotes) {
    const key = mediaKeyFor(note);
    if (!expectedGroups.has(key)) expectedGroups.set(key, []);
    expectedGroups.get(key).push(note);
  }
  assert.equal(shardKeys(snapshot).length, expectedGroups.size);
  for (const [mediaKey, notes] of expectedGroups) {
    const expected = [...notes].sort(
      (left, right) => left.timestampSeconds - right.timestampSeconds,
    );
    assert.deepEqual(snapshot[`ytd_notes_${mediaKey}`], expected);
  }

  assert.deepEqual(clone(await api.readAllNotes()), originalNotes);
  assert.deepEqual(clone(await api.readNoteIndex()), snapshot.ytd_note_index);
  for (const [mediaKey, notes] of expectedGroups) {
    const expected = [...notes].sort(
      (left, right) => left.timestampSeconds - right.timestampSeconds,
    );
    assert.deepEqual(clone(await api.readNotesByMedia(mediaKey)), expected);
  }
}

function downloadedBackup(storage) {
  const events = storage.operations.filter((event) => event.type === "download");
  assert.equal(events.length, 1, "one migration attempt must trigger one backup download");
  assert.ok(events[0].backup, "the download must contain a parseable notes backup");
  assert.match(
    events[0].filename,
    /^digest-dock-notes-\d{4}-\d{2}-\d{2}\.json$/,
  );
  return events[0].backup;
}

function assertDownloadBeforeStructureWrites(storage) {
  const downloadIndex = storage.operations.findIndex(
    (event) => event.type === "download",
  );
  const firstWriteIndex = storage.operations.findIndex(
    (event) =>
      (event.type === "set" || event.type === "remove") &&
      event.keys.some(
        (key) =>
          key === "ytd_note_index" ||
          key === "ytd_notes_schema" ||
          (key.startsWith("ytd_notes_") && key !== "ytd_notes_schema"),
      ),
  );
  assert.ok(downloadIndex >= 0, "migration must trigger the backup download");
  assert.ok(firstWriteIndex >= 0, "migration must write the new structure");
  assert.ok(
    downloadIndex < firstWriteIndex,
    "the backup download must succeed before the first new-structure write",
  );
}

function normalizedBackupBytes(backup) {
  const normalized = clone(backup);
  normalized.exportedAt = "2000-01-01T00:00:00.000Z";
  return Buffer.from(notesBackup.serializeBackup(normalized), "utf8");
}

async function exportBackup(api) {
  const result = await api.handleExportNotesBackup();
  assert.equal(result.success, true);
  assert.ok(result.backup);
  return clone(result.backup);
}

function newStructureSnapshot(storage) {
  const snapshot = storage.snapshot();
  return Object.fromEntries(
    structureKeys(snapshot).map((key) => [key, snapshot[key]]),
  );
}

async function assertBackupAndImportIdempotence(
  api,
  storage,
  beforeBackup,
  expectedCount,
) {
  const afterBackup = await exportBackup(api);
  assert.ok(
    normalizedBackupBytes(beforeBackup).equals(
      normalizedBackupBytes(afterBackup),
    ),
    "normalized pre/post migration backup bytes must be identical",
  );

  const beforeImport = newStructureSnapshot(storage);
  const legacyBeforeImport = jsonBytes(storage.snapshot().ytd_notes);
  const result = await api.handleImportNotesBackup(
    notesBackup.serializeBackup(beforeBackup),
  );
  assert.equal(result.success, true);
  assert.equal(result.importedCount, 0);
  assert.equal(result.duplicateCount, expectedCount);
  assert.equal(result.totalCount, expectedCount);
  assert.equal(result.changed, false);
  assert.deepEqual(newStructureSnapshot(storage), beforeImport);
  assert.ok(
    jsonBytes(storage.snapshot().ytd_notes).equals(legacyBeforeImport),
    "an idempotent import must not rewrite the retained legacy key",
  );
}

function createElement(initial = {}) {
  let text = String(initial.textContent || "");
  const classes = new Set();
  return {
    hidden: initial.hidden === true,
    className: initial.className || "",
    style: { display: initial.display || "" },
    children: [],
    attributes: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : !!force;
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] || null;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener() {},
    focus() {},
    click() {},
    remove() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    set textContent(value) {
      text = String(value ?? "");
    },
    get textContent() {
      return text;
    },
    set innerHTML(value) {
      text = String(value ?? "");
    },
    get innerHTML() {
      return text;
    },
  };
}

function bootSidepanel(sendMessage) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  elements.set("notesCapacity", createElement({ hidden: true }));
  elements.set(
    "notesCapacityBackup",
    createElement({ textContent: "导出备份" }),
  );
  elements.set("errorState", createElement({ display: "none" }));
  elements.set("welcomeState", createElement());
  elements.set("loadingState", createElement());
  elements.set("resultsState", createElement({ display: "block" }));
  elements.set("tabsNav", createElement({ display: "flex" }));

  const listeners = { addListener() {} };
  const document = {
    addEventListener() {},
    getElementById: element,
    querySelector: (selector) => element(`selector:${selector}`),
    querySelectorAll: () => [],
    createElement: () => createElement(),
  };
  const sandbox = {
    console,
    URL,
    Blob,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document,
    chrome: {
      storage: {
        local: createStorageHarness().area,
        session: createStorageHarness().area,
      },
      runtime: {
        onMessage: listeners,
        sendMessage,
        getURL: (file) => `chrome-extension://test/${file}`,
      },
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
      },
    },
    YTD_SETTINGS: {},
    BILIBILI_ADAPTER: bilibiliAdapter,
    YTD_NOTE_EXPORT: noteExport,
    YTD_NOTE_SOURCES: noteSources,
    YTD_EXPORT_JOBS: exportJobs,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read("sidepanel.js"), context);
  return {
    api: sandbox.__YTD_TRANSCRIPT_TESTING__,
    element,
    evaluate: (source) => vm.runInContext(source, context),
  };
}

async function emptyStateSnapshot(getNotes) {
  const sidepanel = bootSidepanel(async (message) => {
    if (message.action === "getNotes") return getNotes(message.videoId);
    return {};
  });
  await sidepanel.api.loadNotes(null, { translateMissing: false });
  return {
    introDisplay: sidepanel.element("notesIntro").style.display,
    introText: sidepanel.element("notesIntroText").textContent,
    capacityHidden: sidepanel.element("notesCapacity").hidden,
  };
}

async function capacitySnapshot(responseOrLoader) {
  const sidepanel = bootSidepanel(async (message) => {
    if (message.action !== "getNotes") return {};
    return typeof responseOrLoader === "function"
      ? responseOrLoader(message.videoId)
      : clone(responseOrLoader);
  });
  sidepanel.evaluate("renderNotes = () => renderNotesCapacity()");
  await sidepanel.api.loadNotes(null, { translateMissing: false });
  return {
    hidden: sidepanel.element("notesCapacity").hidden,
    className: sidepanel.element("notesCapacity").className,
    text: sidepanel.element("notesCapacityText").textContent,
  };
}

function presentationSnapshot(note) {
  const sidepanel = bootSidepanel(async () => ({}));
  const api = sidepanel.api;
  const resolved = clone(api.resolveNoteExportEntry(clone(note)));
  const source = {
    platform: note.platform,
    sourceLanguage: note.sourceLanguage,
    canonicalUrl: note.canonicalUrl,
    titleOriginal: note.videoTitle,
    titleZh: note.videoTitleZh,
    channelName: note.channelName,
    descriptionStatus: "confirmed-empty",
    notes: [{ timestampSeconds: note.timestampSeconds, ...resolved }],
  };
  const fixedDate = { date: "2026-09-05T00:00:00.000Z" };
  return {
    originalHtml: api.renderNoteLanguageContent(clone(note), "original"),
    chineseHtml: api.renderNoteLanguageContent(clone(note), "zh"),
    bilingualHtml: api.renderNoteLanguageContent(clone(note), "bilingual"),
    originalTxt: noteExport.buildCurrentVideoText(source, "original", fixedDate),
    chineseTxt: noteExport.buildCurrentVideoText(source, "zh", fixedDate),
    bilingualTxt: noteExport.buildCurrentVideoText(
      source,
      "bilingual",
      fixedDate,
    ),
  };
}

test("[M1] empty library creates only an empty index and schema without a backup", async () => {
  const storage = createStorageHarness({ unrelated_key: { keep: true } });
  const worker = bootBackground(storage);
  const api = requirePhase1Api(worker.api, "M1");

  const first = api.ensureNotesMigrated();
  const second = api.ensureNotesMigrated();
  assert.equal(first, second, "concurrent callers must share one Promise");
  await Promise.all([first, second]);

  assert.deepEqual(storage.snapshot(), {
    unrelated_key: { keep: true },
    ytd_note_index: [],
    ytd_notes_schema: 1,
  });
  assert.equal(
    storage.operations.filter((event) => event.type === "download").length,
    0,
  );

  const writesAfterFirstRun = storage.operations.filter(
    (event) => event.type === "set" || event.type === "remove",
  ).length;
  await api.ensureNotesMigrated();
  assert.equal(
    storage.operations.filter(
      (event) => event.type === "set" || event.type === "remove",
    ).length,
    writesAfterFirstRun,
    "schema=1 must make subsequent calls a no-op",
  );
  assert.deepEqual(clone(await api.readAllNotes()), []);
  assert.deepEqual(clone(await api.readNoteIndex()), []);

  const rollbackStorage = createStorageHarness({}, {
    async onSet(items, commit) {
      if (Object.hasOwn(items, "ytd_notes_schema")) {
        throw new Error("simulated empty-schema write failure");
      }
      return commit(items);
    },
  });
  const rollbackWorker = bootBackground(rollbackStorage);
  await assert.rejects(
    rollbackWorker.api.ensureNotesMigrated(),
    (error) => error?.code === "NOTES_MIGRATION_FAILED",
  );
  assert.deepEqual(
    rollbackStorage.snapshot(),
    {},
    "a failed empty migration must roll back its index",
  );

  assert.deepEqual(
    await emptyStateSnapshot(() => api.handleGetNotes(null)),
    {
      introDisplay: "flex",
      introText: "还没有保存任何笔记。请先打开一个视频，再保存当前播放位置。",
      capacityHidden: true,
    },
  );
});

test("[M2] one note migrates byte-for-byte with unchanged presentation and backup", async () => {
  const probe = bootBackground(createStorageHarness());
  requirePhase1Api(probe.api, "M2");

  const note = makeMigrationNote(1, {
    rawText: "  ＡＩ\tkeeps\n  exact words  ",
    videoTitle: "  Fullwidth　Title  ",
    channelName: "  Test\tChannel  ",
  });

  const failedStorage = createStorageHarness({ ytd_notes: [note] });
  const failedWorker = bootBackground(failedStorage, {
    downloadSucceeds: false,
  });
  const failedOutcome = await failedWorker.api
    .ensureNotesMigrated()
    .then((value) => ({ value }), (error) => ({ error }));
  assert.ok(
    failedOutcome.error || failedOutcome.value?.success === false,
    "a rejected backup download must stop migration",
  );
  assert.deepEqual(failedStorage.snapshot(), { ytd_notes: [note] });

  const storage = createStorageHarness({ ytd_notes: [note] });
  const worker = bootBackground(storage);
  const api = requirePhase1Api(worker.api, "M2");
  const beforePresentation = presentationSnapshot(note);

  await api.ensureNotesMigrated();
  assertDownloadBeforeStructureWrites(storage);
  const beforeBackup = downloadedBackup(storage);
  await assertMigratedLibrary(api, storage, [note]);

  const migrated = storage.snapshot()[`ytd_notes_${note.mediaKey}`][0];
  for (const field of SPEC_RECORD_FIELDS) {
    assert.deepEqual(migrated[field], note[field], field);
  }
  assert.deepEqual(migrated, note, "all existing own fields must survive");
  assert.equal(Object.hasOwn(migrated, "thought"), false);
  assert.equal(Object.hasOwn(migrated, "thoughtAt"), false);
  assert.equal(Object.hasOwn(migrated, "triggerWindow"), false);
  assert.equal(
    storage.snapshot().ytd_note_index[0].searchText,
    "AI keeps exact words Fullwidth Title Test Channel",
  );
  assert.deepEqual(presentationSnapshot(migrated), beforePresentation);
  await assertBackupAndImportIdempotence(api, storage, beforeBackup, 1);

  const aliasNote = makeMigrationNote(2, {
    id: "note_legacy_alias",
    videoId: "legacyvideo01",
    mediaKey: "legacy_media_key",
  });
  const aliasStorage = createStorageHarness({
    ytd_notes_schema: 1,
    ytd_note_index: [
      {
        id: aliasNote.id,
        mediaKey: aliasNote.mediaKey,
        platform: aliasNote.platform,
        videoTitle: aliasNote.videoTitle,
        channelName: aliasNote.channelName,
        timestampSeconds: aliasNote.timestampSeconds,
        savedAt: aliasNote.createdAt,
        hasThought: false,
        searchText: expectedSearchText(aliasNote),
      },
    ],
    [`ytd_notes_${aliasNote.mediaKey}`]: [aliasNote],
  });
  const aliasWorker = bootBackground(aliasStorage);
  const legacyFiltered = await aliasWorker.api.handleGetNotes(aliasNote.videoId);
  assert.equal(legacyFiltered.success, true);
  assert.deepEqual(
    clone(legacyFiltered.notes),
    [aliasNote],
    "legacy videoId filtering remains compatible when mediaKey differs",
  );
});

test("[M3] a 500-note multi-media library preserves every shard without a count ceiling", async () => {
  const probe = bootBackground(createStorageHarness());
  requirePhase1Api(probe.api, "M3");

  const notes = makeLibrary(500, 4);
  // Exercise the specified fallback without asking the migration to invent a
  // mediaKey field on this historical record.
  delete notes[7].mediaKey;
  const storage = createStorageHarness({ ytd_notes: notes });
  const worker = bootBackground(storage);
  const api = requirePhase1Api(worker.api, "M3");
  await api.ensureNotesMigrated();
  assertDownloadBeforeStructureWrites(storage);
  const beforeBackup = downloadedBackup(storage);
  await assertMigratedLibrary(api, storage, notes);

  const response = await api.handleGetNotes(null);
  assert.equal(response.success, true);
  assert.equal(response.totalCount, 500);
  assert.equal(Object.hasOwn(response, "limit"), false);
  const capacity = await capacitySnapshot(() => api.handleGetNotes(null));
  assert.equal(capacity.hidden, true);
  assert.doesNotMatch(capacity.text, /500\s*\/\s*500|已达上限/);
  await assertBackupAndImportIdempotence(api, storage, beforeBackup, 500);
});

test("[M4] a 620-note legacy library is never truncated and accepts a backupable append", async () => {
  const probe = bootBackground(createStorageHarness());
  requirePhase1Api(probe.api, "M4");

  const notes = makeLibrary(620, 4);
  const storage = createStorageHarness({ ytd_notes: notes });
  const worker = bootBackground(storage);
  const api = requirePhase1Api(worker.api, "M4");

  await api.ensureNotesMigrated();
  assertDownloadBeforeStructureWrites(storage);
  const beforeBackup = downloadedBackup(storage);
  assert.equal(notesBackup.parseBackupText(notesBackup.serializeBackup(beforeBackup)).length, 620);
  await assertMigratedLibrary(api, storage, notes);

  const response = await api.handleGetNotes(null);
  assert.equal(response.success, true);
  assert.equal(response.totalCount, 620);
  assert.equal(Object.hasOwn(response, "limit"), false);
  const capacity = await capacitySnapshot(() => api.handleGetNotes(null));
  assert.equal(capacity.hidden, true);
  assert.doesNotMatch(capacity.text, /620\s*\/\s*500|已达上限/);
  await assertBackupAndImportIdempotence(api, storage, beforeBackup, 620);

  const appendedNote = makeMigrationNote(999, {
    thought: "",
    thoughtAt: null,
    triggerWindow: [],
  });
  assert.equal(await api.appendNote(appendedNote), true);

  const afterAppend = await api.handleGetNotes(null);
  assert.equal(afterAppend.success, true);
  assert.equal(afterAppend.totalCount, 621);
  assert.equal(Object.hasOwn(afterAppend, "limit"), false);
  assert.equal(afterAppend.notes[0].id, appendedNote.id);
  assert.ok(
    notes.every((note) =>
      afterAppend.notes.some((candidate) => candidate.id === note.id),
    ),
    "accepting note 621 must preserve every migrated legacy note",
  );

  const afterBackup = await exportBackup(api);
  assert.equal(afterBackup.notes.length, 621);
  assert.ok(
    notesBackup.byteLength(notesBackup.serializeBackup(afterBackup)) <=
      notesBackup.MAX_BACKUP_BYTES,
  );
});

test("[M5] damaged input fails with a reason and rolls back every partial new key", async () => {
  const probe = bootBackground(createStorageHarness());
  requirePhase1Api(probe.api, "M5");

  const damagedCases = [
    {
      label: "non-array ytd_notes",
      value: { not: "an array" },
      reason: /ytd_notes|array|数组/i,
    },
    {
      label: "missing id",
      value: [(() => {
        const note = makeMigrationNote(1);
        delete note.id;
        return note;
      })()],
      reason: /\bid\b/i,
    },
    {
      label: "missing mediaKey and videoId",
      value: [(() => {
        const note = makeMigrationNote(2);
        delete note.mediaKey;
        delete note.videoId;
        return note;
      })()],
      reason: /mediaKey|videoId/i,
    },
    {
      label: "wrong timestampSeconds type",
      value: [makeMigrationNote(3, { timestampSeconds: "24" })],
      reason: /timestampSeconds|field|字段/i,
    },
    {
      label: "mediaKey collides with the schema marker",
      value: [
        makeMigrationNote(4, {
          videoId: "schema",
          mediaKey: "schema",
        }),
      ],
      reason: /mediaKey|保留键|schema/i,
    },
  ];

  for (const damaged of damagedCases) {
    const storage = createStorageHarness({
      ytd_notes: damaged.value,
      unrelated_key: "keep",
    });
    const worker = bootBackground(storage);
    const api = requirePhase1Api(worker.api, `M5 ${damaged.label}`);
    const before = storage.snapshot();
    const result = await api.handleGetNotes(null);
    assert.equal(result.success, false, damaged.label);
    assert.match(JSON.stringify(result), damaged.reason, damaged.label);
    assert.deepEqual(storage.snapshot().ytd_notes, before.ytd_notes);
    assert.equal(storage.snapshot().unrelated_key, "keep");
    assert.deepEqual(structureKeys(storage.snapshot()), []);
    if (damaged.label.includes("schema marker")) {
      const downloadsBeforeRetry = storage.operations.filter(
        (event) => event.type === "download",
      ).length;
      const repeated = await api.handleGetNotes(null);
      assert.equal(repeated.success, false);
      assert.equal(
        storage.operations.filter((event) => event.type === "download").length,
        downloadsBeforeRetry,
        "a deterministic migration failure must not redownload in a loop",
      );
    }
  }

  const uiStorage = createStorageHarness({
    ytd_notes: damagedCases[1].value,
  });
  const uiWorker = bootBackground(uiStorage);
  const sidepanel = bootSidepanel(async (message) => {
    if (message.action === "getNotes") {
      return uiWorker.api.handleGetNotes(message.videoId);
    }
    return {};
  });
  await sidepanel.api.loadNotes(null, { translateMissing: false });
  assert.equal(sidepanel.element("notesCapacity").hidden, false);
  assert.match(sidepanel.element("notesCapacityText").textContent, /迁移/);
  assert.match(sidepanel.element("notesCapacityText").textContent, /\bid\b/i);
  assert.equal(sidepanel.element("notesCapacityBackup").hidden, false);
  assert.equal(sidepanel.element("notesCapacityBackup").textContent, "导出备份");

  const importStorage = createStorageHarness();
  const importWorker = bootBackground(importStorage);
  const importApi = requirePhase1Api(importWorker.api, "M5 reserved import");
  await importApi.ensureNotesMigrated();
  const reservedBackup = notesBackup.createBackup([
    makeMigrationNote(5, { videoId: "schema", mediaKey: "schema" }),
  ]);
  const imported = await importApi.handleImportNotesBackup(
    notesBackup.serializeBackup(reservedBackup),
  );
  assert.equal(imported.success, false);
  assert.equal(imported.code, "INVALID_STORED_NOTES");
  assert.deepEqual(importStorage.snapshot(), {
    ytd_note_index: [],
    ytd_notes_schema: 1,
  });

  const integrityCases = [
    {
      label: "missing referenced shard",
      mutate: async (storage, note) =>
        storage.area.remove(`ytd_notes_${note.mediaKey}`),
    },
    {
      label: "extra unindexed shard record",
      mutate: async (storage, note) =>
        storage.area.set({
          [`ytd_notes_${note.mediaKey}`]: [
            note,
            makeMigrationNote(98, {
              videoId: note.videoId,
              mediaKey: note.mediaKey,
            }),
          ],
        }),
    },
    {
      label: "record stored in the wrong shard",
      mutate: async (storage, note) =>
        storage.area.set({
          [`ytd_notes_${note.mediaKey}`]: [
            { ...note, mediaKey: "wrong_media", videoId: "wrong_media" },
          ],
        }),
    },
    {
      label: "duplicate index id",
      mutate: async (storage) => {
        const [entry] = storage.snapshot().ytd_note_index;
        await storage.area.set({ ytd_note_index: [entry, entry] });
      },
    },
  ];
  for (const damaged of integrityCases) {
    const note = makeMigrationNote(97);
    const storage = createStorageHarness({ ytd_notes: [note] });
    const worker = bootBackground(storage);
    await worker.api.ensureNotesMigrated();
    await damaged.mutate(storage, note);
    const result = await worker.api.handleGetNotes(note.mediaKey);
    assert.equal(result.success, false, damaged.label);
    assert.equal(result.code, "NOTES_MIGRATION_FAILED", damaged.label);
  }

  let structureWriteCount = 0;
  const validNotes = makeLibrary(3, 3);
  const rollbackStorage = createStorageHarness(
    { ytd_notes: validNotes, unrelated_key: "keep" },
    {
      async onSet(items, commit) {
        const keys = structureKeys(items);
        if (keys.length) {
          structureWriteCount += 1;
          if (structureWriteCount === 2) {
            throw new Error("simulated index/schema write failure");
          }
        }
        return commit(items);
      },
    },
  );
  const rollbackWorker = bootBackground(rollbackStorage);
  const rollbackResult = await rollbackWorker.api.handleGetNotes(null);
  assert.equal(rollbackResult.success, false);
  assert.deepEqual(rollbackStorage.snapshot(), {
    ytd_notes: validNotes,
    unrelated_key: "keep",
  });
});

test("[M6] a fresh worker safely completes after interruption during shard writes", async () => {
  const probe = bootBackground(createStorageHarness());
  requirePhase1Api(probe.api, "M6");

  const notes = makeLibrary(500, 4);
  const interruption = createAsyncGate();
  let intercepted = false;
  const firstStorage = createStorageHarness(
    { ytd_notes: notes, unrelated_key: "keep" },
    {
      async onSet(items, commit) {
        const keys = structureKeys(items);
        const writesShard = keys.some(
          (key) =>
            key.startsWith("ytd_notes_") && key !== "ytd_notes_schema",
        );
        if (writesShard && !intercepted) {
          intercepted = true;
          await commit(items);
          return interruption.enter();
        }
        return commit(items);
      },
    },
  );
  const firstWorker = bootBackground(firstStorage);
  const firstApi = requirePhase1Api(firstWorker.api, "M6 first worker");
  void firstApi.ensureNotesMigrated();
  await interruption.entered;

  const interruptedSnapshot = firstStorage.snapshot();
  assert.equal(Object.hasOwn(interruptedSnapshot, "ytd_notes_schema"), false);
  assert.ok(shardKeys(interruptedSnapshot).length >= 1);
  assert.deepEqual(
    interruptedSnapshot.ytd_notes,
    notes,
    "the legacy truth must remain complete while schema=1 is absent",
  );
  assertDownloadBeforeStructureWrites(firstStorage);
  const beforeBackup = downloadedBackup(firstStorage);

  // Dropping the first VM models service-worker termination. A pending Promise
  // has no timer or I/O handle and therefore does not keep Node alive.
  const restartedStorage = createStorageHarness(interruptedSnapshot);
  const restartedWorker = bootBackground(restartedStorage);
  const restartedApi = requirePhase1Api(restartedWorker.api, "M6 restarted worker");
  await restartedApi.ensureNotesMigrated();

  assertDownloadBeforeStructureWrites(restartedStorage);
  await assertMigratedLibrary(restartedApi, restartedStorage, notes);
  assert.deepEqual(restartedStorage.snapshot().unrelated_key, "keep");
  assert.deepEqual(
    clone(await restartedApi.handleGetNotes(null)),
    {
      success: true,
      notes,
      totalCount: 500,
    },
  );
  await assertBackupAndImportIdempotence(
    restartedApi,
    restartedStorage,
    beforeBackup,
    500,
  );
});
