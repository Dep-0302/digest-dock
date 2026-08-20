/**
 * Versioned, notes-only backup helpers shared by the service worker and Options.
 *
 * Backup files deliberately contain no settings, API keys, transcript caches,
 * or digest caches. Imported URLs are rebuilt from validated media identity
 * fields rather than trusted from the file.
 */
var YTD_NOTES_BACKUP = (() => {
  // Stable compatibility identifier. Existing YouTube Digest backups must
  // remain importable after the product rename to DigestDock.
  const FORMAT = "youtube-digest-notes-backup";
  const SCHEMA_VERSION = 2;
  const LEGACY_SCHEMA_VERSION = 1;
  const MAX_NOTES = 100;
  const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
  const MAX_TIMESTAMP_SECONDS = 31_536_000;
  const MAX_LEGACY_NOTE_TEXT_LENGTH = 50_000;
  const MAX_LEGACY_SOURCE_LANGUAGE_LENGTH = 100;
  const MAX_TRANSLATION_VALIDATION_VERSION = 100;
  const NOTE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,20}$/;
  const BVID_PATTERN = /^BV[0-9A-Za-z]{6,20}$/;
  const BILIBILI_MEDIA_KEY_PATTERN = /^bilibili:BV[0-9A-Za-z]{6,20}:[1-9]\d*$/;
  const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/;
  const DISALLOWED_CONTROL_CHARACTERS =
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

  class NotesBackupError extends Error {
    constructor(code, details = {}) {
      super(code);
      this.name = "NotesBackupError";
      this.code = code;
      this.details = details;
    }
  }

  function fail(code, details) {
    throw new NotesBackupError(code, details);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function normalizeString(value, field, { max, required = false } = {}) {
    if (typeof value !== "string") {
      if (!required && (value === undefined || value === null)) return "";
      fail("INVALID_NOTES_BACKUP", { field });
    }

    const normalized = value
      .replace(/\r\n?/g, "\n")
      .normalize("NFC")
      .trim();
    if ((required && !normalized) || normalized.length > max) {
      fail("INVALID_NOTES_BACKUP", { field });
    }
    if (DISALLOWED_CONTROL_CHARACTERS.test(normalized)) {
      fail("INVALID_NOTES_BACKUP", { field });
    }
    return normalized;
  }

  function normalizeBoolean(value, field, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value !== "boolean") {
      fail("INVALID_NOTES_BACKUP", { field });
    }
    return value;
  }

  function normalizeValidationVersion(value) {
    if (value === undefined || value === null) return 0;
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > MAX_TRANSLATION_VALIDATION_VERSION
    ) {
      fail("INVALID_NOTES_BACKUP", { field: "translatedValidationVersion" });
    }
    return value;
  }

  function normalizeTextLanguage(value, index, { required = false } = {}) {
    if (required && typeof value !== "string") {
      fail("INVALID_NOTES_BACKUP", { index, field: "textLanguage" });
    }
    const normalized = normalizeString(value, "textLanguage", {
      max: MAX_LEGACY_SOURCE_LANGUAGE_LENGTH,
    });
    if (normalized && !LANGUAGE_TAG_PATTERN.test(normalized)) {
      fail("INVALID_NOTES_BACKUP", { index, field: "textLanguage" });
    }
    return normalized;
  }

  function normalizeMediaIdentity(
    note,
    index,
    { schemaVersion, strictBackupImport = false } = {},
  ) {
    const isLegacyV1 = schemaVersion === LEGACY_SCHEMA_VERSION;
    let platform = "youtube";

    if (!isLegacyV1) {
      if (strictBackupImport && typeof note.platform !== "string") {
        fail("INVALID_NOTES_BACKUP", { index, field: "platform" });
      }
      if (note.platform !== undefined && note.platform !== null) {
        platform = normalizeString(note.platform, "platform", {
          max: 16,
          required: true,
        });
      }
    }

    if (platform !== "youtube" && platform !== "bilibili") {
      fail("INVALID_NOTES_BACKUP", { index, field: "platform" });
    }

    if (platform === "youtube") {
      const videoId = normalizeString(note.videoId, "videoId", {
        max: 20,
        required: true,
      });
      if (!VIDEO_ID_PATTERN.test(videoId)) {
        fail("INVALID_NOTES_BACKUP", { index, field: "videoId" });
      }

      let mediaKey = videoId;
      if (!isLegacyV1) {
        if (strictBackupImport && typeof note.mediaKey !== "string") {
          fail("INVALID_NOTES_BACKUP", { index, field: "mediaKey" });
        }
        if (note.mediaKey !== undefined && note.mediaKey !== null) {
          mediaKey = normalizeString(note.mediaKey, "mediaKey", {
            max: 64,
            required: true,
          });
        }
        if (mediaKey !== videoId) {
          fail("INVALID_NOTES_BACKUP", { index, field: "mediaKey" });
        }
        if (
          strictBackupImport &&
          (note.bvid !== undefined ||
            note.cid !== undefined ||
            note.page !== undefined)
        ) {
          fail("INVALID_NOTES_BACKUP", { index, field: "platform" });
        }
      }

      return {
        platform,
        videoId,
        mediaKey,
        bvid: "",
        cid: null,
        page: null,
        textLanguage: isLegacyV1
          ? ""
          : normalizeTextLanguage(note.textLanguage, index),
      };
    }

    const bvid = normalizeString(note.bvid, "bvid", {
      max: 22,
      required: true,
    });
    if (!BVID_PATTERN.test(bvid)) {
      fail("INVALID_NOTES_BACKUP", { index, field: "bvid" });
    }

    const cid = note.cid;
    if (!Number.isSafeInteger(cid) || cid < 1) {
      fail("INVALID_NOTES_BACKUP", { index, field: "cid" });
    }

    const page = note.page;
    if (!Number.isSafeInteger(page) || page < 1) {
      fail("INVALID_NOTES_BACKUP", { index, field: "page" });
    }

    const expectedMediaKey = `bilibili:${bvid}:${cid}`;
    const mediaKey = normalizeString(note.mediaKey, "mediaKey", {
      max: 64,
      required: true,
    });
    if (
      !BILIBILI_MEDIA_KEY_PATTERN.test(mediaKey) ||
      mediaKey !== expectedMediaKey
    ) {
      fail("INVALID_NOTES_BACKUP", { index, field: "mediaKey" });
    }

    const videoId = normalizeString(note.videoId, "videoId", {
      max: 64,
      required: true,
    });
    if (videoId !== expectedMediaKey) {
      fail("INVALID_NOTES_BACKUP", { index, field: "videoId" });
    }

    return {
      platform,
      videoId,
      mediaKey,
      bvid,
      cid,
      page,
      textLanguage: normalizeTextLanguage(note.textLanguage, index, {
        required: true,
      }),
    };
  }

  function buildTimestampedUrl(identity, timestampSeconds) {
    if (identity.platform === "bilibili") {
      const url = new URL(
        `https://www.bilibili.com/video/${identity.bvid}/`,
      );
      if (identity.page > 1) url.searchParams.set("p", String(identity.page));
      url.searchParams.set("t", String(timestampSeconds));
      return url.href;
    }
    return `https://www.youtube.com/watch?v=${identity.videoId}&t=${timestampSeconds}s`;
  }

  function normalizeNote(note, index = 0, options = {}) {
    if (!isPlainObject(note)) {
      fail("INVALID_NOTES_BACKUP", { index, field: "note" });
    }

    const id = normalizeString(note.id, "id", { max: 128, required: true });
    if (!NOTE_ID_PATTERN.test(id)) {
      fail("INVALID_NOTES_BACKUP", { index, field: "id" });
    }

    const identity = normalizeMediaIdentity(note, index, options);

    const timestampSeconds = note.timestampSeconds;
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      timestampSeconds < 0 ||
      timestampSeconds > MAX_TIMESTAMP_SECONDS
    ) {
      fail("INVALID_NOTES_BACKUP", { index, field: "timestampSeconds" });
    }

    const createdAt = note.createdAt;
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      fail("INVALID_NOTES_BACKUP", { index, field: "createdAt" });
    }

    const minutes = Math.floor(timestampSeconds / 60);
    const seconds = timestampSeconds % 60;
    const translatedText = normalizeString(note.translatedText, "translatedText", {
      max: MAX_LEGACY_NOTE_TEXT_LENGTH,
    });
    const translatedValidated = normalizeBoolean(
      note.translatedValidated,
      "translatedValidated",
    );
    const translatedValidationVersion = normalizeValidationVersion(
      note.translatedValidationVersion,
    );
    const translatedUnchanged = normalizeBoolean(
      note.translatedUnchanged,
      "translatedUnchanged",
    );
    if (
      (!translatedText &&
        (translatedValidated ||
          translatedValidationVersion !== 0 ||
          translatedUnchanged)) ||
      (translatedValidated && translatedValidationVersion < 1) ||
      (!translatedValidated &&
        (translatedValidationVersion !== 0 || translatedUnchanged))
    ) {
      fail("INVALID_NOTES_BACKUP", { field: "translatedValidation" });
    }

    return {
      id,
      platform: identity.platform,
      mediaKey: identity.mediaKey,
      videoId: identity.videoId,
      bvid: identity.bvid,
      cid: identity.cid,
      page: identity.page,
      textLanguage: identity.textLanguage,
      videoTitle: normalizeString(note.videoTitle, "videoTitle", {
        max: 500,
      }),
      channelName: normalizeString(note.channelName, "channelName", { max: 300 }),
      timestamp: `${minutes}:${String(seconds).padStart(2, "0")}`,
      timestampSeconds,
      timestampedUrl: buildTimestampedUrl(identity, timestampSeconds),
      text: normalizeString(note.text, "text", {
        max: MAX_LEGACY_NOTE_TEXT_LENGTH,
        required: true,
      }),
      translatedText,
      translatedValidated,
      translatedValidationVersion,
      translatedUnchanged,
      rawText: normalizeString(note.rawText, "rawText", {
        max: MAX_LEGACY_NOTE_TEXT_LENGTH,
      }),
      sourceLanguage: normalizeString(note.sourceLanguage, "sourceLanguage", {
        max: MAX_LEGACY_SOURCE_LANGUAGE_LENGTH,
      }),
      createdAt,
    };
  }

  function noteForBackup(note, index) {
    const normalized = normalizeNote(note, index);
    const mediaIdentity =
      normalized.platform === "bilibili"
        ? {
            platform: normalized.platform,
            mediaKey: normalized.mediaKey,
            videoId: normalized.videoId,
            bvid: normalized.bvid,
            cid: normalized.cid,
            page: normalized.page,
            textLanguage: normalized.textLanguage,
          }
        : {
            platform: normalized.platform,
            mediaKey: normalized.mediaKey,
            videoId: normalized.videoId,
            textLanguage: normalized.textLanguage,
          };
    return {
      id: normalized.id,
      ...mediaIdentity,
      videoTitle: normalized.videoTitle,
      channelName: normalized.channelName,
      timestampSeconds: normalized.timestampSeconds,
      text: normalized.text,
      translatedText: normalized.translatedText,
      translatedValidated: normalized.translatedValidated,
      translatedValidationVersion: normalized.translatedValidationVersion,
      translatedUnchanged: normalized.translatedUnchanged,
      rawText: normalized.rawText,
      sourceLanguage: normalized.sourceLanguage,
      createdAt: normalized.createdAt,
    };
  }

  function makeBackupNoteIdsUnique(notes) {
    const usedIds = new Set();
    return notes.map((note, index) => {
      if (!usedIds.has(note.id)) {
        usedIds.add(note.id);
        return note;
      }

      let attempt = 0;
      let replacementId;
      do {
        replacementId = `note_restored_${note.createdAt}_${index}_${attempt}`;
        attempt += 1;
      } while (usedIds.has(replacementId));
      usedIds.add(replacementId);
      return { ...note, id: replacementId };
    });
  }

  function assertUniqueNoteIds(notes) {
    const ids = new Set();
    for (const note of notes) {
      if (ids.has(note.id)) {
        fail("INVALID_NOTES_BACKUP", { field: "id" });
      }
      ids.add(note.id);
    }
  }

  function byteLength(text) {
    return new TextEncoder().encode(text).byteLength;
  }

  function validateExportedAt(value) {
    if (
      typeof value !== "string" ||
      value.length > 64 ||
      !Number.isFinite(Date.parse(value))
    ) {
      fail("INVALID_NOTES_BACKUP", { field: "exportedAt" });
    }
    return value;
  }

  function createBackup(notes, { exportedAt, extensionVersion = "" } = {}) {
    if (!Array.isArray(notes) || notes.length > MAX_NOTES) {
      fail("INVALID_NOTES_BACKUP", { field: "notes" });
    }

    const backup = {
      format: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: validateExportedAt(exportedAt || new Date().toISOString()),
      extensionVersion: normalizeString(extensionVersion, "extensionVersion", {
        max: 32,
      }),
      notes: makeBackupNoteIdsUnique(notes.map(noteForBackup)),
    };

    if (byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) {
      fail("NOTES_BACKUP_TOO_LARGE");
    }
    return backup;
  }

  function parseBackupText(text) {
    if (typeof text !== "string" || byteLength(text) > MAX_BACKUP_BYTES) {
      fail("NOTES_BACKUP_TOO_LARGE");
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      fail("INVALID_NOTES_BACKUP");
    }

    if (!isPlainObject(parsed) || parsed.format !== FORMAT) {
      fail("INVALID_NOTES_BACKUP", { field: "format" });
    }
    if (
      parsed.schemaVersion !== LEGACY_SCHEMA_VERSION &&
      parsed.schemaVersion !== SCHEMA_VERSION
    ) {
      fail("UNSUPPORTED_NOTES_BACKUP_VERSION", {
        schemaVersion: parsed.schemaVersion,
      });
    }
    validateExportedAt(parsed.exportedAt);
    normalizeString(parsed.extensionVersion, "extensionVersion", { max: 32 });
    if (!Array.isArray(parsed.notes) || parsed.notes.length > MAX_NOTES) {
      fail("INVALID_NOTES_BACKUP", { field: "notes" });
    }

    const notes = parsed.notes.map((note, index) =>
      normalizeNote(note, index, {
        schemaVersion: parsed.schemaVersion,
        strictBackupImport: parsed.schemaVersion === SCHEMA_VERSION,
      }),
    );
    assertUniqueNoteIds(notes);
    return notes;
  }

  function sameIdentityContent(left, right) {
    return (
      left.platform === right.platform &&
      left.mediaKey === right.mediaKey &&
      left.videoId === right.videoId &&
      left.bvid === right.bvid &&
      left.cid === right.cid &&
      left.page === right.page &&
      left.timestampSeconds === right.timestampSeconds &&
      left.text === right.text &&
      (!left.textLanguage ||
        !right.textLanguage ||
        left.textLanguage === right.textLanguage) &&
      (!left.rawText || !right.rawText || left.rawText === right.rawText)
    );
  }

  function fillMissingFields(localNote, importedNote) {
    let changed = false;
    const merged = { ...localNote };
    for (const field of [
      "videoTitle",
      "channelName",
      "rawText",
      "sourceLanguage",
      "textLanguage",
    ]) {
      if (!merged[field] && importedNote[field]) {
        merged[field] = importedNote[field];
        changed = true;
      }
    }
    if (!merged.translatedText && importedNote.translatedText) {
      merged.translatedText = importedNote.translatedText;
      merged.translatedValidated = importedNote.translatedValidated;
      merged.translatedValidationVersion =
        importedNote.translatedValidationVersion;
      merged.translatedUnchanged = importedNote.translatedUnchanged;
      changed = true;
    } else if (
      merged.translatedText === importedNote.translatedText &&
      merged.translatedValidated !== true &&
      importedNote.translatedValidated === true
    ) {
      merged.translatedValidated = true;
      merged.translatedValidationVersion =
        importedNote.translatedValidationVersion;
      merged.translatedUnchanged = importedNote.translatedUnchanged;
      changed = true;
    }
    return { note: merged, changed };
  }

  function sortNewestFirst(notes) {
    return [...notes].sort(
      (left, right) =>
        right.createdAt - left.createdAt || left.id.localeCompare(right.id),
    );
  }

  function mergeNotes(existingNotes, importedNotes) {
    if (!Array.isArray(existingNotes) || !Array.isArray(importedNotes)) {
      fail("INVALID_NOTES_BACKUP", { field: "notes" });
    }

    const merged = existingNotes.map(normalizeNote);
    const byId = new Map();
    merged.forEach((note, index) => {
      if (byId.has(note.id)) {
        fail("INVALID_STORED_NOTES", { field: "id" });
      }
      byId.set(note.id, index);
    });

    let importedCount = 0;
    let duplicateCount = 0;
    const enrichedIndexes = new Set();

    importedNotes.map(normalizeNote).forEach((importedNote) => {
      let matchIndex = byId.get(importedNote.id);
      if (matchIndex !== undefined) {
        const localNote = merged[matchIndex];
        if (!sameIdentityContent(localNote, importedNote)) {
          fail("NOTES_BACKUP_CONFLICT");
        }
        const enriched = fillMissingFields(localNote, importedNote);
        if (enriched.changed) {
          merged[matchIndex] = enriched.note;
          enrichedIndexes.add(matchIndex);
        }
        duplicateCount += 1;
        return;
      }

      const nextIndex = merged.length;
      merged.push(importedNote);
      byId.set(importedNote.id, nextIndex);
      importedCount += 1;
    });

    if (merged.length > MAX_NOTES) {
      fail("NOTES_CAPACITY_EXCEEDED", {
        total: merged.length,
        limit: MAX_NOTES,
        overBy: merged.length - MAX_NOTES,
      });
    }

    return {
      notes: sortNewestFirst(merged),
      importedCount,
      duplicateCount,
      enrichedCount: enrichedIndexes.size,
      totalCount: merged.length,
      changed: importedCount > 0 || enrichedIndexes.size > 0,
    };
  }

  function notesBackupFilename(date = new Date()) {
    const isoDate = date.toISOString().slice(0, 10);
    return `digest-dock-notes-${isoDate}.json`;
  }

  return {
    FORMAT,
    SCHEMA_VERSION,
    MAX_NOTES,
    MAX_BACKUP_BYTES,
    NotesBackupError,
    byteLength,
    createBackup,
    mergeNotes,
    normalizeNote,
    notesBackupFilename,
    parseBackupText,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_NOTES_BACKUP;
}
