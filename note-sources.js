/**
 * Media-deduplicated note-source library.
 *
 * Schema 2 keeps exact millisecond transcript identity and resumable
 * description/transcript translations. The current store has its own key so a
 * downgraded build cannot overwrite schema-2 data. The schema-1 key is read
 * only and lazily copied on first access.
 */
var YTD_NOTE_SOURCES = (() => {
  const STORAGE_KEY = "ytd_note_sources_v2";
  const LEGACY_STORAGE_KEY = "ytd_note_sources";
  const SCHEMA_VERSION = 2;

  const MAX_SOURCES = 200;
  const MAX_TITLE = 500;
  const MAX_CHANNEL = 300;
  const MAX_URL = 2048;
  const MAX_DESCRIPTION = 20_000;
  const MAX_LANGUAGE_TAG = 100;
  const MAX_MEDIA_KEY = 64;
  const MAX_SEGMENT_ID = 300;
  const MAX_SOURCE_HASH = 100;
  const MAX_TRANSLATION_VERSION = 100;
  const MAX_TRANSCRIPT_ENTRIES = 6000;
  const MAX_ENTRY_TEXT = 4000;
  const MAX_START_SECONDS = 24 * 60 * 60;
  const MAX_SOURCE_BYTES = 1_500_000;
  const MAX_TOTAL_BYTES = 8_000_000;

  // Total-work constants remain exported for compatibility and reporting, but
  // only the per-round limits gate execution. A 395-row video is therefore a
  // resumable job rather than a permanently disabled one.
  const EXPORT_TRANSLATION_MAX_VIDEOS = 20;
  const EXPORT_TRANSLATION_MAX_UNITS = 240;
  const EXPORT_TRANSLATION_MAX_BATCHES = 80;
  const EXPORT_TRANSLATION_MAX_PROVIDER_CALLS = 100;
  const EXPORT_TRANSLATION_ROUND_MAX_BATCHES = 20;
  const EXPORT_TRANSLATION_ROUND_MAX_PROVIDER_CALLS = 100;
  const EXPORT_TRANSLATION_BATCH_SIZE = 4;
  const EXPORT_DESCRIPTION_CHUNK_CHARS = 3000;
  const DEFAULT_TRANSLATION_VERSION = "export-v2";

  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
  const storageQueues = new WeakMap();

  function noteSourceSchemaError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function assertNoFutureSourceSchema(input, context = "note source") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    if (
      Number.isSafeInteger(input.schemaVersion) &&
      input.schemaVersion > SCHEMA_VERSION
    ) {
      throw noteSourceSchemaError(
        "UNSUPPORTED_NOTE_SOURCE_SCHEMA",
        `${context} uses unsupported schema ${input.schemaVersion}.`,
      );
    }
  }

  function defaultIsChineseText(value) {
    const text = String(value || "");
    if (/[\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
    const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return han >= 1 && (latin === 0 || han * 2 >= latin);
  }

  function isChineseLanguageTag(value) {
    return /^(?:zh|chi|zho)(?:[-_]|$)/i.test(String(value || "").trim());
  }

  function cleanText(value, max) {
    if (typeof value !== "string") return "";
    return value
      .replace(/\r\n?/g, "\n")
      .replace(CONTROL_CHARACTERS, " ")
      .normalize("NFC")
      .trim()
      .slice(0, max);
  }

  function byteLength(text) {
    return new TextEncoder().encode(text).byteLength;
  }

  /** Small deterministic browser-safe hash; this is identity, not security. */
  function hashSourceText(value) {
    const text = cleanText(String(value || ""), Number.MAX_SAFE_INTEGER);
    // Two independently-seeded 32-bit FNV streams give a compact 64-bit token;
    // a single 32-bit stream has an avoidable collision rate on 6000-row media.
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      left ^= code;
      left = Math.imul(left, 0x01000193) >>> 0;
      right ^= code;
      right = Math.imul(right, 0x85ebca6b) >>> 0;
    }
    return `fnv1a-${left.toString(16).padStart(8, "0")}${right
      .toString(16)
      .padStart(8, "0")}`;
  }

  function normalizeStart(value) {
    const start = Number(value);
    if (!Number.isFinite(start) || start < 0 || start > MAX_START_SECONDS) {
      return null;
    }
    const startMs = Math.round(start * 1000);
    return { start: startMs / 1000, startMs };
  }

  function transcriptIdentity(entry) {
    return `${entry.segmentId}\u0000${entry.startMs}\u0000${entry.sourceHash}`;
  }

  // ----------------------------------------------------------------
  // Transcript normalization and schema-1 migration
  // ----------------------------------------------------------------

  function normalizeOriginalTranscript(entries) {
    if (!Array.isArray(entries)) return { entries: [], truncated: false };
    const valid = [];
    for (let inputIndex = 0; inputIndex < entries.length; inputIndex += 1) {
      const entry = entries[inputIndex];
      const timing = normalizeStart(
        entry?.startMs !== undefined ? Number(entry.startMs) / 1000 : entry?.start,
      );
      if (!timing) continue;
      const text = cleanText(entry?.text, MAX_ENTRY_TEXT);
      if (!text) continue;
      const sourceHash = hashSourceText(text);
      const providedId = cleanText(
        String(entry?.segmentId ?? entry?.id ?? ""),
        MAX_SEGMENT_ID,
      );
      valid.push({
        ...timing,
        text,
        sourceHash,
        providedId,
        inputIndex,
      });
    }

    valid.sort(
      (left, right) =>
        left.startMs - right.startMs || left.inputIndex - right.inputIndex,
    );
    const truncated = valid.length > MAX_TRANSCRIPT_ENTRIES;
    const bounded = valid.slice(0, MAX_TRANSCRIPT_ENTRIES);
    const occurrenceByFallback = new Map();
    const usedIdentities = new Map();
    return {
      truncated,
      entries: bounded.map((entry) => {
        const fallbackKey = `${entry.startMs}\u0000${entry.sourceHash}`;
        const occurrence = occurrenceByFallback.get(fallbackKey) || 0;
        occurrenceByFallback.set(fallbackKey, occurrence + 1);
        let segmentId =
          entry.providedId ||
          `legacy-${entry.startMs}-${entry.sourceHash}-${occurrence}`;
        const baseIdentity = `${segmentId}\u0000${entry.startMs}\u0000${entry.sourceHash}`;
        const duplicate = usedIdentities.get(baseIdentity) || 0;
        usedIdentities.set(baseIdentity, duplicate + 1);
        if (duplicate) segmentId = `${segmentId}~${duplicate}`;
        return {
          segmentId,
          start: entry.start,
          startMs: entry.startMs,
          text: entry.text,
          sourceHash: entry.sourceHash,
        };
      }),
    };
  }

  /**
   * Binds Chinese rows to the current originals. Schema-2 rows require their
   * exact identity. Legacy rows without identity migrate only when exact start
   * (including milliseconds) identifies one and only one original row.
   */
  function normalizeTranscriptTranslations(entries, originals) {
    if (!Array.isArray(entries) || !originals.length) return [];
    const byIdentity = new Map();
    const bySegmentStart = new Map();
    const byStartHash = new Map();
    const byStart = new Map();
    const add = (map, key, value) => {
      const values = map.get(key) || [];
      values.push(value);
      map.set(key, values);
    };
    originals.forEach((entry) => {
      byIdentity.set(transcriptIdentity(entry), entry);
      add(bySegmentStart, `${entry.segmentId}\u0000${entry.startMs}`, entry);
      add(byStartHash, `${entry.startMs}\u0000${entry.sourceHash}`, entry);
      add(byStart, String(entry.startMs), entry);
    });

    const translatedByIdentity = new Map();
    for (const raw of entries) {
      const text = cleanText(raw?.text ?? raw?.textZh, MAX_ENTRY_TEXT);
      if (!text) continue;
      const timing = normalizeStart(
        raw?.startMs !== undefined ? Number(raw.startMs) / 1000 : raw?.start,
      );
      if (!timing) continue;
      const segmentId = cleanText(
        String(raw?.segmentId ?? raw?.id ?? ""),
        MAX_SEGMENT_ID,
      );
      const suppliedHash = cleanText(
        String(raw?.sourceHash || ""),
        MAX_SOURCE_HASH,
      );
      let original = null;

      if (segmentId && suppliedHash) {
        original = byIdentity.get(
          `${segmentId}\u0000${timing.startMs}\u0000${suppliedHash}`,
        );
        // A lazily migrated schema-1 row receives a deterministic legacy id.
        // When a later live capture supplies the real semantic id, reuse the
        // translation only if exact millisecond + source hash is unambiguous.
        if (!original && segmentId.startsWith("legacy-")) {
          const candidates =
            byStartHash.get(`${timing.startMs}\u0000${suppliedHash}`) || [];
          if (candidates.length === 1) original = candidates[0];
        }
      } else if (segmentId) {
        const candidates =
          bySegmentStart.get(`${segmentId}\u0000${timing.startMs}`) || [];
        if (candidates.length === 1) original = candidates[0];
      } else if (suppliedHash) {
        const candidates =
          byStartHash.get(`${timing.startMs}\u0000${suppliedHash}`) || [];
        if (candidates.length === 1) original = candidates[0];
      } else {
        const candidates = byStart.get(String(timing.startMs)) || [];
        if (candidates.length === 1) original = candidates[0];
      }

      if (!original || (suppliedHash && suppliedHash !== original.sourceHash)) {
        continue;
      }
      const identity = transcriptIdentity(original);
      if (translatedByIdentity.has(identity)) continue;
      translatedByIdentity.set(identity, {
        segmentId: original.segmentId,
        start: original.start,
        startMs: original.startMs,
        sourceHash: original.sourceHash,
        text,
        translationVersion:
          cleanText(
            String(raw?.translationVersion || ""),
            MAX_TRANSLATION_VERSION,
          ) || DEFAULT_TRANSLATION_VERSION,
      });
    }
    return originals
      .map((entry) => translatedByIdentity.get(transcriptIdentity(entry)))
      .filter(Boolean);
  }

  function normalizeTranscript(entries) {
    return normalizeOriginalTranscript(entries).entries;
  }

  function countMissingTranscriptTranslations(transcriptOriginal, transcriptZh) {
    const originals = normalizeOriginalTranscript(transcriptOriginal).entries;
    const translations = normalizeTranscriptTranslations(
      transcriptZh,
      originals,
    );
    const translated = new Set(translations.map(transcriptIdentity));
    return originals.reduce(
      (count, entry) => count + (translated.has(transcriptIdentity(entry)) ? 0 : 1),
      0,
    );
  }

  // ----------------------------------------------------------------
  // Description chunks
  // ----------------------------------------------------------------

  function splitTextForTranslation(
    value,
    maxChars = EXPORT_DESCRIPTION_CHUNK_CHARS,
  ) {
    const text = cleanText(value, MAX_DESCRIPTION);
    if (!text) return [];
    const chunks = [];
    let rest = text;
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars + 1);
      const floor = Math.floor(maxChars * 0.55);
      const candidates = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        Math.max(
          window.lastIndexOf("。"),
          window.lastIndexOf("！"),
          window.lastIndexOf("？"),
          window.lastIndexOf(". "),
          window.lastIndexOf("! "),
          window.lastIndexOf("? "),
        ),
        window.lastIndexOf(" "),
      ];
      const boundary = candidates.find((index) => index >= floor);
      const cut =
        Number.isInteger(boundary) && boundary >= floor
          ? boundary + 1
          : maxChars;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
  }

  function descriptionSourceChunks(descriptionOriginal) {
    return splitTextForTranslation(descriptionOriginal).map((text, index) => ({
      index,
      text,
      sourceHash: hashSourceText(text),
    }));
  }

  function normalizeDescriptionChunkTranslations(rawChunks, sourceChunks) {
    if (!Array.isArray(rawChunks) || !sourceChunks.length) return [];
    const availableByHash = new Map();
    sourceChunks.forEach((chunk) => {
      const list = availableByHash.get(chunk.sourceHash) || [];
      list.push(chunk);
      availableByHash.set(chunk.sourceHash, list);
    });
    const usedIndexes = new Set();
    const translated = [];
    rawChunks.forEach((raw) => {
      const sourceHash = cleanText(
        String(raw?.sourceHash || ""),
        MAX_SOURCE_HASH,
      );
      const textZh = cleanText(raw?.textZh ?? raw?.text, MAX_DESCRIPTION);
      if (!sourceHash || !textZh) return;
      const candidates = availableByHash.get(sourceHash) || [];
      let source = candidates.find(
        (candidate) =>
          candidate.index === Number(raw?.index) &&
          !usedIndexes.has(candidate.index),
      );
      if (!source) {
        source = candidates.find((candidate) => !usedIndexes.has(candidate.index));
      }
      if (!source) return;
      usedIndexes.add(source.index);
      translated.push({
        index: source.index,
        sourceHash: source.sourceHash,
        textZh,
        translationVersion:
          cleanText(
            String(raw?.translationVersion || ""),
            MAX_TRANSLATION_VERSION,
          ) || DEFAULT_TRANSLATION_VERSION,
      });
    });
    return translated.sort((left, right) => left.index - right.index);
  }

  function normalizeDescriptionFields(input) {
    const uncappedDescription = cleanText(
      input?.descriptionOriginal,
      Number.MAX_SAFE_INTEGER,
    );
    const descriptionOriginal = uncappedDescription.slice(0, MAX_DESCRIPTION);
    const explicitStatus = String(input?.descriptionStatus || "");
    const descriptionStatus = descriptionOriginal
      ? "present"
      : explicitStatus === "confirmed-empty"
        ? "confirmed-empty"
        : "unknown";
    const sourceChunks = descriptionSourceChunks(descriptionOriginal);
    const descriptionSourceHash = descriptionOriginal
      ? hashSourceText(descriptionOriginal)
      : "";
    const descriptionZhChunks = normalizeDescriptionChunkTranslations(
      input?.descriptionZhChunks,
      sourceChunks,
    );
    const suppliedFullHash = cleanText(
      String(input?.descriptionSourceHash || ""),
      MAX_SOURCE_HASH,
    );
    let descriptionZh = cleanText(input?.descriptionZh, MAX_DESCRIPTION);
    if (
      descriptionZh &&
      suppliedFullHash &&
      suppliedFullHash !== descriptionSourceHash
    ) {
      descriptionZh = "";
    }
    if (!descriptionOriginal) descriptionZh = "";
    if (!descriptionZh && sourceChunks.length) {
      const byIndex = new Map(
        descriptionZhChunks.map((chunk) => [chunk.index, chunk]),
      );
      if (sourceChunks.every((chunk) => byIndex.has(chunk.index))) {
        descriptionZh = sourceChunks
          .map((chunk) => byIndex.get(chunk.index).textZh)
          .join("\n\n");
      }
    }
    return {
      descriptionOriginal,
      descriptionStatus,
      descriptionZh,
      descriptionSourceHash: descriptionZh ? descriptionSourceHash : "",
      descriptionZhChunks,
      descriptionTruncated:
        !!input?.descriptionTruncated ||
        uncappedDescription.length > descriptionOriginal.length,
    };
  }

  // ----------------------------------------------------------------
  // Source record construction / normalization
  // ----------------------------------------------------------------

  function normalizeMediaKey(value) {
    const key = cleanText(value, MAX_MEDIA_KEY);
    return key && !/\s/.test(key) ? key : "";
  }

  function normalizePlatform(value) {
    return value === "bilibili" ? "bilibili" : "youtube";
  }

  function normalizeNoteSource(input) {
    if (!input || typeof input !== "object") return null;
    assertNoFutureSourceSchema(input);
    const mediaKey = normalizeMediaKey(input.mediaKey);
    if (!mediaKey) return null;
    const normalizedOriginal = normalizeOriginalTranscript(
      input.transcriptOriginal,
    );
    const transcriptOriginal = normalizedOriginal.entries;
    const transcriptZh = normalizeTranscriptTranslations(
      input.transcriptZh,
      transcriptOriginal,
    );
    const transcriptTruncated =
      !!input.transcriptTruncated || normalizedOriginal.truncated;
    const updatedAt =
      Number.isSafeInteger(input.updatedAt) && input.updatedAt > 0
        ? input.updatedAt
        : 0;
    const description = normalizeDescriptionFields(input);
    const titleOriginal = cleanText(input.titleOriginal, MAX_TITLE);
    let titleZh = cleanText(input.titleZh, MAX_TITLE);
    const currentTitleHash = titleOriginal
      ? hashSourceText(titleOriginal)
      : "";
    const suppliedTitleHash = cleanText(
      String(input.titleSourceHash || ""),
      MAX_SOURCE_HASH,
    );
    if (
      !titleOriginal ||
      (suppliedTitleHash && suppliedTitleHash !== currentTitleHash)
    ) {
      titleZh = "";
    }
    const titleSourceHash = titleZh ? currentTitleHash : "";
    const sourceRevision = hashSourceText(
      JSON.stringify({
        mediaKey,
        platform: normalizePlatform(input.platform),
        canonicalUrl: cleanText(input.canonicalUrl, MAX_URL),
        titleOriginal,
        channelName: cleanText(input.channelName, MAX_CHANNEL),
        sourceLanguage: cleanText(input.sourceLanguage, MAX_LANGUAGE_TAG),
        descriptionStatus: description.descriptionStatus,
        descriptionTruncated: description.descriptionTruncated,
        descriptionOriginalHash: description.descriptionOriginal
          ? hashSourceText(description.descriptionOriginal)
          : "",
        transcriptTruncated,
        transcript: transcriptOriginal.map((entry) => [
          entry.segmentId,
          entry.startMs,
          entry.sourceHash,
        ]),
      }),
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      sourceRevision,
      mediaKey,
      platform: normalizePlatform(input.platform),
      canonicalUrl: cleanText(input.canonicalUrl, MAX_URL),
      titleOriginal,
      titleZh,
      titleSourceHash,
      channelName: cleanText(input.channelName, MAX_CHANNEL),
      ...description,
      sourceLanguage: cleanText(input.sourceLanguage, MAX_LANGUAGE_TAG),
      transcriptOriginal,
      transcriptZh,
      transcriptTruncated,
      transcriptTranslationComplete:
        !transcriptTruncated &&
        transcriptOriginal.length > 0 &&
        countMissingTranscriptTranslations(transcriptOriginal, transcriptZh) === 0,
      updatedAt,
    };
  }

  function estimateSourceBytes(source) {
    return byteLength(JSON.stringify(source || {}));
  }

  function boundSourceSize(source) {
    let bounded = normalizeNoteSource(source);
    if (!bounded) return null;
    while (estimateSourceBytes(bounded) > MAX_SOURCE_BYTES) {
      if (bounded.transcriptOriginal.length > 0) {
        const nextLength = Math.floor(bounded.transcriptOriginal.length * 0.9);
        bounded = normalizeNoteSource({
          ...bounded,
          transcriptOriginal: bounded.transcriptOriginal.slice(0, nextLength),
          transcriptZh: bounded.transcriptZh,
          transcriptTruncated: true,
        });
        continue;
      }
      if (
        bounded.descriptionOriginal ||
        bounded.descriptionZh ||
        bounded.descriptionZhChunks.length
      ) {
        bounded = normalizeNoteSource({
          ...bounded,
          descriptionOriginal: "",
          descriptionZh: "",
          descriptionZhChunks: [],
          descriptionStatus: "unknown",
          descriptionTruncated: true,
        });
        continue;
      }
      break;
    }
    return bounded;
  }

  function recordsEqual(left, right) {
    return JSON.stringify({ ...left, updatedAt: 0 }) ===
      JSON.stringify({ ...right, updatedAt: 0 });
  }

  function mergeDescription(prev, next, merged) {
    let chosenOriginal = prev.descriptionOriginal;
    let chosenStatus = prev.descriptionStatus;
    let chosenTruncated = prev.descriptionTruncated === true;
    const incomingIsConfirmedComplete =
      next.descriptionTruncated !== true &&
      (next.descriptionStatus === "present" ||
        next.descriptionStatus === "confirmed-empty");
    if (prev.descriptionTruncated && incomingIsConfirmedComplete) {
      // A verified page/player result outranks a longer DOM/meta fallback.
      // This also lets an exact confirmed-empty result clear stale snippets.
      chosenOriginal = next.descriptionOriginal;
      chosenStatus = next.descriptionStatus;
      chosenTruncated = false;
    } else if (
      next.descriptionOriginal &&
      (!chosenOriginal || next.descriptionOriginal.length >= chosenOriginal.length)
    ) {
      chosenOriginal = next.descriptionOriginal;
      chosenStatus = "present";
      chosenTruncated = next.descriptionTruncated === true;
    } else if (
      !chosenOriginal &&
      chosenStatus === "unknown" &&
      next.descriptionStatus === "confirmed-empty"
    ) {
      chosenStatus = "confirmed-empty";
      chosenTruncated = false;
    }

    const currentHash = chosenOriginal ? hashSourceText(chosenOriginal) : "";
    const fullCandidate = [prev, next].find(
      (source) =>
        source.descriptionZh &&
        source.descriptionSourceHash === currentHash,
    );
    Object.assign(
      merged,
      normalizeDescriptionFields({
        descriptionOriginal: chosenOriginal,
        descriptionStatus: chosenStatus,
        descriptionZh: fullCandidate?.descriptionZh || "",
        descriptionSourceHash: fullCandidate?.descriptionSourceHash || "",
        descriptionZhChunks: [
          ...(prev.descriptionZhChunks || []),
          ...(next.descriptionZhChunks || []),
        ],
        descriptionTruncated: chosenTruncated,
      }),
    );
  }

  function mergeNoteSource(existing, incoming, { now = Date.now() } = {}) {
    const next = normalizeNoteSource(incoming);
    if (!next) return { source: normalizeNoteSource(existing), changed: false };
    const prev = normalizeNoteSource(existing);
    if (!prev) {
      const created = boundSourceSize({
        ...next,
        updatedAt: next.updatedAt || now,
      });
      return { source: created, changed: true };
    }
    if (prev.mediaKey !== next.mediaKey) {
      return { source: prev, changed: false };
    }

    const merged = { ...prev };
    for (const field of [
      "platform",
      "canonicalUrl",
      "titleOriginal",
      "channelName",
      "sourceLanguage",
    ]) {
      if (next[field] && next[field] !== merged[field]) {
        if (!merged[field] || field === "titleOriginal" || field === "channelName") {
          merged[field] = next[field];
        }
      }
    }
    const mergedTitleHash = merged.titleOriginal
      ? hashSourceText(merged.titleOriginal)
      : "";
    const titleCandidate = [prev, next].find(
      (source) =>
        source.titleZh && source.titleSourceHash === mergedTitleHash,
    );
    merged.titleZh = titleCandidate?.titleZh || "";
    merged.titleSourceHash = titleCandidate?.titleSourceHash || "";
    mergeDescription(prev, next, merged);

    let transcriptOriginal = prev.transcriptOriginal;
    let transcriptTruncated = prev.transcriptTruncated;
    const originalsDiffer =
      JSON.stringify(next.transcriptOriginal) !==
      JSON.stringify(prev.transcriptOriginal);
    const shouldUseNextOriginal =
      next.transcriptOriginal.length > 0 &&
      (!prev.transcriptOriginal.length ||
        next.transcriptOriginal.length > prev.transcriptOriginal.length ||
        (next.transcriptOriginal.length === prev.transcriptOriginal.length &&
          originalsDiffer) ||
        (prev.transcriptTruncated && !next.transcriptTruncated));
    if (shouldUseNextOriginal) {
      transcriptOriginal = next.transcriptOriginal;
      transcriptTruncated = next.transcriptTruncated;
      if (next.sourceLanguage) merged.sourceLanguage = next.sourceLanguage;
    }
    merged.transcriptOriginal = transcriptOriginal;
    merged.transcriptZh = normalizeTranscriptTranslations(
      [...prev.transcriptZh, ...next.transcriptZh],
      transcriptOriginal,
    );
    merged.transcriptTruncated = transcriptTruncated;
    merged.transcriptTranslationComplete =
      !transcriptTruncated &&
      transcriptOriginal.length > 0 &&
      countMissingTranscriptTranslations(
        transcriptOriginal,
        merged.transcriptZh,
      ) === 0;

    let bounded = boundSourceSize(merged);
    const changed = !recordsEqual(prev, bounded);
    bounded = {
      ...bounded,
      updatedAt: changed
        ? now
        : Math.max(prev.updatedAt, next.updatedAt) || prev.updatedAt,
    };
    return { source: bounded, changed };
  }

  /**
   * Builds a source from a no-network digest. `transcriptOriginal` lets callers
   * pass the exact semantic grouping used for `transcriptZh`.
   */
  function sourceFromDigest(
    mediaKey,
    digest,
    { transcriptOriginal, transcriptZh = [] } = {},
  ) {
    if (!digest || typeof digest !== "object") return null;
    return normalizeNoteSource({
      mediaKey,
      platform: digest.mediaRef?.platform || "youtube",
      canonicalUrl: digest.mediaRef?.canonicalUrl || "",
      titleOriginal: digest.videoTitle || "",
      channelName: digest.channelName || "",
      descriptionStatus: "unknown",
      sourceLanguage:
        digest.transcriptLanguage || digest.transcriptRequestedLanguage || "",
      transcriptOriginal: Array.isArray(transcriptOriginal)
        ? transcriptOriginal
        : Array.isArray(digest.transcript)
          ? digest.transcript
          : [],
      transcriptZh,
      updatedAt: Number(digest.timestamp) || 0,
    });
  }

  // ----------------------------------------------------------------
  // Export bridge and precheck
  // ----------------------------------------------------------------

  function toExportSource(source, notes, { resolveNote } = {}) {
    const resolved = normalizeNoteSource(source) || {
      platform: "youtube",
      canonicalUrl: "",
      titleOriginal: "",
      titleZh: "",
      channelName: "",
      descriptionOriginal: "",
      descriptionZh: "",
      descriptionStatus: "unknown",
      transcriptOriginal: [],
      transcriptZh: [],
      transcriptTruncated: false,
    };
    const resolver =
      typeof resolveNote === "function"
        ? resolveNote
        : (note) => ({
            original: String(note?.text || ""),
            zh: String(note?.translatedText || ""),
          });
    return {
      platform: resolved.platform,
      canonicalUrl: resolved.canonicalUrl,
      titleOriginal: resolved.titleOriginal,
      titleZh: resolved.titleZh,
      channelName: resolved.channelName,
      descriptionOriginal: resolved.descriptionOriginal,
      descriptionZh: resolved.descriptionZh,
      descriptionStatus: resolved.descriptionStatus,
      descriptionTruncated: resolved.descriptionTruncated === true,
      sourceLanguage: resolved.sourceLanguage,
      transcriptOriginal: resolved.transcriptOriginal,
      transcriptZh: resolved.transcriptZh,
      transcriptTruncated: resolved.transcriptTruncated,
      notes: (Array.isArray(notes) ? notes : []).map((note) => ({
        timestampSeconds: Number(note?.timestampSeconds) || 0,
        ...resolver(note),
      })),
    };
  }

  function buildExportPrecheck({
    groups,
    sourcesByKey = {},
    mode = "original",
    titleOf,
    isChineseText = defaultIsChineseText,
    resolveNote,
    includeTranscript = true,
  } = {}) {
    const wantsTranslation = mode === "zh" || mode === "bilingual";
    const videos = (Array.isArray(groups) ? groups : []).map((group) => {
      const rep = group.representative || (group.notes && group.notes[0]) || {};
      const source = normalizeNoteSource(sourcesByKey[group.mediaKey]);
      const platform = normalizePlatform(source?.platform || rep.platform);
      const titleOriginal = source?.titleOriginal || rep.videoTitle || "";
      const title =
        (typeof titleOf === "function" ? titleOf(group) : "") ||
        titleOriginal ||
        "Untitled Video";
      const channelName = source?.channelName || rep.channelName || "";
      const canonicalUrl = source?.canonicalUrl || rep.canonicalUrl || "";
      const descriptionOriginal = source?.descriptionOriginal || "";
      const transcriptOriginal = source?.transcriptOriginal || [];
      const transcriptZh = source?.transcriptZh || [];
      const transcriptTotal = transcriptOriginal.length;
      const originalIsChinese =
        platform === "bilibili" || isChineseLanguageTag(source?.sourceLanguage);
      const transcriptTruncated = !!source?.transcriptTruncated;
      const hasOriginalTranscript = transcriptTotal > 0 && !transcriptTruncated;
      const hasUrl = !!canonicalUrl;
      const descriptionStatus = source?.descriptionStatus || "unknown";
      const blockingReasons = [];
      if (includeTranscript && !transcriptTotal) {
        blockingReasons.push("缺少完整字幕");
      } else if (includeTranscript && transcriptTruncated) {
        blockingReasons.push("字幕资料已裁剪，不完整");
      }
      if (!titleOriginal) blockingReasons.push("缺少视频标题");
      if (!channelName) blockingReasons.push("缺少频道名称");
      if (!hasUrl) blockingReasons.push("缺少视频网址");
      if (descriptionStatus === "unknown") {
        blockingReasons.push("缺少视频简介状态");
      }
      if (source?.descriptionTruncated) {
        blockingReasons.push("视频简介已裁剪，不完整");
      }

      const needsTitleTranslation =
        wantsTranslation &&
        !originalIsChinese &&
        !!titleOriginal &&
        !isChineseText(titleOriginal) &&
        !source?.titleZh;
      const descriptionChunks = descriptionSourceChunks(descriptionOriginal);
      const completedDescriptionChunks = new Set(
        (source?.descriptionZhChunks || []).map((chunk) =>
          `${chunk.index}\u0000${chunk.sourceHash}`,
        ),
      );
      const descriptionMissingChunkCount =
        wantsTranslation &&
        !originalIsChinese &&
        !!descriptionOriginal &&
        !isChineseText(descriptionOriginal) &&
        !source?.descriptionZh
          ? descriptionChunks.filter(
              (chunk) =>
                !completedDescriptionChunks.has(
                  `${chunk.index}\u0000${chunk.sourceHash}`,
                ),
            ).length
          : 0;
      const needsDescriptionTranslation =
        wantsTranslation &&
        !originalIsChinese &&
        !!descriptionOriginal &&
        !isChineseText(descriptionOriginal) &&
        descriptionMissingChunkCount > 0;
      const transcriptMissingCount =
        includeTranscript && wantsTranslation && !originalIsChinese
          ? countMissingTranscriptTranslations(transcriptOriginal, transcriptZh)
          : 0;
      const noteTranslationCount =
        wantsTranslation && !originalIsChinese
          ? (group.notes || []).filter((note) => {
              const pair =
                typeof resolveNote === "function"
                  ? resolveNote(note)
                  : {
                      original: String(note?.text || note?.rawText || ""),
                      zh: String(note?.translatedText || ""),
                    };
              const original = String(pair?.original || "").trim();
              const zh = String(pair?.zh || "").trim();
              return !!original && !zh && !isChineseText(original);
            }).length
          : 0;

      return {
        mediaKey: group.mediaKey,
        title,
        platform,
        noteCount: (group.notes || []).length,
        hasSource: !!source,
        hasTitle: !!titleOriginal,
        hasChannel: !!channelName,
        hasUrl,
        hasDescription: descriptionStatus === "present",
        descriptionStatus,
        descriptionTruncated: !!source?.descriptionTruncated,
        hasOriginalTranscript,
        transcriptTruncated,
        transcriptTotal,
        needsTitleTranslation,
        needsDescriptionTranslation,
        descriptionMissingChunkCount,
        transcriptMissingCount,
        noteTranslationCount,
        blocking: blockingReasons.length > 0,
        blockingReasons,
      };
    });

    const blockingVideos = videos.filter((video) => video.blocking);
    const translationGaps = videos.reduce(
      (totals, video) => ({
        titles: totals.titles + (video.needsTitleTranslation ? 1 : 0),
        descriptions:
          totals.descriptions + (video.needsDescriptionTranslation ? 1 : 0),
        descriptionChunks:
          totals.descriptionChunks + video.descriptionMissingChunkCount,
        transcriptSegments:
          totals.transcriptSegments + video.transcriptMissingCount,
        notes: totals.notes + video.noteTranslationCount,
      }),
      {
        titles: 0,
        descriptions: 0,
        descriptionChunks: 0,
        transcriptSegments: 0,
        notes: 0,
      },
    );
    return {
      mode,
      videoCount: videos.length,
      noteCount: videos.reduce((sum, video) => sum + video.noteCount, 0),
      videos,
      blockingVideos,
      hasBlocking: blockingVideos.length > 0,
      translationGaps,
      hasTranslationGaps:
        translationGaps.titles +
          translationGaps.descriptionChunks +
          translationGaps.transcriptSegments +
          translationGaps.notes >
        0,
    };
  }

  // ----------------------------------------------------------------
  // Resumable export translation planning
  // ----------------------------------------------------------------

  function chunkArray(values, size) {
    const chunks = [];
    for (let index = 0; index < values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }
    return chunks;
  }

  function sourceUnitId(mediaKey, kind, identity) {
    const prefix = kind === "description" ? "d" : "t";
    return `${prefix}:${hashSourceText(mediaKey)}:${identity}`;
  }

  function buildSourceBatches(sourceUnits) {
    const batches = [];
    const byMedia = new Map();
    sourceUnits.forEach((unit) => {
      const list = byMedia.get(unit.mediaKey) || [];
      list.push(unit);
      byMedia.set(unit.mediaKey, list);
    });
    for (const mediaUnits of byMedia.values()) {
      let pending = [];
      let pendingCharacters = 0;
      mediaUnits.forEach((unit) => {
        const length = unit.text.length;
        if (
          pending.length >= EXPORT_TRANSLATION_BATCH_SIZE ||
          (pending.length && pendingCharacters + length > 12000)
        ) {
          batches.push(pending);
          pending = [];
          pendingCharacters = 0;
        }
        pending.push(unit);
        pendingCharacters += length;
      });
      if (pending.length) batches.push(pending);
    }
    return batches;
  }

  function buildExportTranslationPlan({
    groups,
    sourcesByKey = {},
    mode = "original",
    resolveNote,
    isChineseText = defaultIsChineseText,
    includeTitles = true,
    includeNotes = true,
    includeDescriptions = true,
    includeTranscript = true,
  } = {}) {
    const wantsTranslation = mode === "zh" || mode === "bilingual";
    const safeGroups = Array.isArray(groups) ? groups : [];
    const notes = [];
    const titles = [];
    const sourceUnits = [];
    const sourceWorkByKey = {};
    const seenTitles = new Set();
    let totalUnitCount = 0;
    let completedUnitCount = 0;

    if (wantsTranslation) {
      safeGroups.forEach((group) => {
        const rep = group.representative || (group.notes && group.notes[0]) || {};
        const source = normalizeNoteSource(sourcesByKey[group.mediaKey]);
        const platform = normalizePlatform(source?.platform || rep.platform);
        const originalIsChinese =
          platform === "bilibili" || isChineseLanguageTag(source?.sourceLanguage);
        if (originalIsChinese) return;
        const titleOriginal = String(
          source?.titleOriginal || rep.videoTitle || "",
        ).trim();

        if (
          includeTitles &&
          titleOriginal &&
          !isChineseText(titleOriginal) &&
          !seenTitles.has(group.mediaKey)
        ) {
          seenTitles.add(group.mediaKey);
          totalUnitCount += 1;
          if (source?.titleZh) completedUnitCount += 1;
          else titles.push({ mediaKey: group.mediaKey, title: titleOriginal });
        }

        (includeNotes ? group.notes || [] : []).forEach((note) => {
          const pair =
            typeof resolveNote === "function"
              ? resolveNote(note)
              : {
                  original: String(note?.text || note?.rawText || ""),
                  zh: String(note?.translatedText || ""),
                };
          const original = String(pair?.original || "").trim();
          const zh = String(pair?.zh || "").trim();
          if (!original || isChineseText(original)) return;
          totalUnitCount += 1;
          if (zh) {
            completedUnitCount += 1;
            return;
          }
          notes.push({
            id: String(note?.id || ""),
            text: original,
            videoTitle: titleOriginal,
            rawText: String(note?.rawText || ""),
            sourceLanguage: String(
              note?.sourceLanguage || source?.sourceLanguage || "",
            ),
            platform,
            textLanguage: String(note?.textLanguage || ""),
          });
        });

        if (!source) return;
        const work = {
          mediaKey: group.mediaKey,
          descriptionUnitIds: [],
          transcriptUnits: [],
        };
        if (
          includeDescriptions &&
          source.descriptionOriginal &&
          !isChineseText(source.descriptionOriginal)
        ) {
          const chunks = descriptionSourceChunks(source.descriptionOriginal);
          const translatedChunks = new Set(
            source.descriptionZhChunks.map(
              (chunk) => `${chunk.index}\u0000${chunk.sourceHash}`,
            ),
          );
          chunks.forEach((chunk) => {
            totalUnitCount += 1;
            if (
              source.descriptionZh ||
              translatedChunks.has(`${chunk.index}\u0000${chunk.sourceHash}`)
            ) {
              completedUnitCount += 1;
              return;
            }
            const id = sourceUnitId(
              group.mediaKey,
              "description",
              `${chunk.index}:${chunk.sourceHash}`,
            );
            work.descriptionUnitIds.push(id);
            sourceUnits.push({
              id,
              mediaKey: group.mediaKey,
              sourceRevision: source.sourceRevision,
              kind: "description",
              chunkIndex: chunk.index,
              sourceHash: chunk.sourceHash,
              text: chunk.text,
              videoTitle: titleOriginal,
            });
          });
        }

        const translatedTranscript = new Set(
          source.transcriptZh.map(transcriptIdentity),
        );
        (includeTranscript ? source.transcriptOriginal : []).forEach(
          (entry, transcriptIndex) => {
            if (isChineseText(entry.text)) return;
            totalUnitCount += 1;
            if (translatedTranscript.has(transcriptIdentity(entry))) {
              completedUnitCount += 1;
              return;
            }
            const id = sourceUnitId(
              group.mediaKey,
              "transcript",
              `${hashSourceText(entry.segmentId)}:${entry.startMs}:${entry.sourceHash}`,
            );
            const unit = {
              id,
              mediaKey: group.mediaKey,
              sourceRevision: source.sourceRevision,
              kind: "transcript",
              segmentId: entry.segmentId,
              start: entry.start,
              startMs: entry.startMs,
              sourceHash: entry.sourceHash,
              transcriptIndex,
              text: entry.text,
              videoTitle: titleOriginal,
            };
            work.transcriptUnits.push({ ...unit });
            sourceUnits.push(unit);
          },
        );
        if (work.descriptionUnitIds.length || work.transcriptUnits.length) {
          sourceWorkByKey[group.mediaKey] = work;
        }
      });
    }

    const noteBatches = chunkArray(notes, 10);
    const titleBatches = chunkArray(titles, 10);
    const sourceBatches = buildSourceBatches(sourceUnits);
    const unitCount = notes.length + titles.length + sourceUnits.length;
    const estimatedBatches =
      noteBatches.length + titleBatches.length + sourceBatches.length;
    const maxProviderCalls =
      (noteBatches.length + titleBatches.length) * 5 +
      sourceBatches.length * 2;
    const limitReasons = [];
    if (safeGroups.length > EXPORT_TRANSLATION_MAX_VIDEOS) {
      limitReasons.push(`超过 ${EXPORT_TRANSLATION_MAX_VIDEOS} 个视频`);
    }
    const progress = {
      totalUnits: totalUnitCount,
      completedUnits: completedUnitCount,
      remainingUnits: unitCount,
      percent:
        totalUnitCount > 0
          ? Math.round((completedUnitCount / totalUnitCount) * 100)
          : 100,
      remainingBatches: estimatedBatches,
      roundMaxBatches: EXPORT_TRANSLATION_ROUND_MAX_BATCHES,
    };
    return {
      mode,
      videoCount: safeGroups.length,
      noteBatches,
      titleBatches,
      sourceBatches,
      sourceWorkByKey,
      unitCount,
      totalUnitCount,
      completedUnitCount,
      estimatedBatches,
      maxProviderCalls,
      overLimit: limitReasons.length > 0,
      limitReasons,
      progress,
    };
  }

  /** Selects a deterministic user-authorized round without mutating the plan. */
  function takeExportTranslationRound(
    plan,
    {
      maxBatches = EXPORT_TRANSLATION_ROUND_MAX_BATCHES,
      maxProviderCalls = EXPORT_TRANSLATION_ROUND_MAX_PROVIDER_CALLS,
    } = {},
  ) {
    const safeMaxBatches = Math.max(0, Math.floor(Number(maxBatches) || 0));
    const safeMaxCalls = Math.max(
      0,
      Math.floor(Number(maxProviderCalls) || 0),
    );
    const queue = [
      ...(plan?.noteBatches || []).map((batch) => ({
        kind: "note",
        batch,
        calls: 5,
      })),
      ...(plan?.titleBatches || []).map((batch) => ({
        kind: "title",
        batch,
        calls: 5,
      })),
      ...(plan?.sourceBatches || []).map((batch) => ({
        kind: "source",
        batch,
        calls: 2,
      })),
    ];
    const selected = [];
    let providerCalls = 0;
    for (const item of queue) {
      if (selected.length >= safeMaxBatches) break;
      if (providerCalls + item.calls > safeMaxCalls) break;
      selected.push(item);
      providerCalls += item.calls;
    }
    const noteBatches = selected
      .filter((item) => item.kind === "note")
      .map((item) => item.batch);
    const titleBatches = selected
      .filter((item) => item.kind === "title")
      .map((item) => item.batch);
    const sourceBatches = selected
      .filter((item) => item.kind === "source")
      .map((item) => item.batch);
    const selectedSourceIds = new Set(
      sourceBatches.flat().map((unit) => unit.id),
    );
    const sourceWorkByKey = {};
    for (const [mediaKey, work] of Object.entries(
      plan?.sourceWorkByKey || {},
    )) {
      const descriptionUnitIds = work.descriptionUnitIds.filter((id) =>
        selectedSourceIds.has(id),
      );
      const transcriptUnits = work.transcriptUnits.filter((unit) =>
        selectedSourceIds.has(unit.id),
      );
      if (descriptionUnitIds.length || transcriptUnits.length) {
        sourceWorkByKey[mediaKey] = {
          mediaKey,
          descriptionUnitIds,
          transcriptUnits,
        };
      }
    }
    const selectedUnitCount =
      noteBatches.flat().length +
      titleBatches.flat().length +
      sourceBatches.flat().length;
    const totalBatches = Number(plan?.estimatedBatches) || queue.length;
    return {
      ...(plan || {}),
      noteBatches,
      titleBatches,
      sourceBatches,
      sourceWorkByKey,
      estimatedBatches: selected.length,
      maxProviderCalls: providerCalls,
      totalEstimatedBatches: totalBatches,
      totalMaxProviderCalls: Number(plan?.maxProviderCalls) || 0,
      round: {
        batchCount: selected.length,
        unitCount: selectedUnitCount,
        maxProviderCalls: providerCalls,
        remainingBatches: Math.max(0, totalBatches - selected.length),
        remainingUnits: Math.max(
          0,
          (Number(plan?.unitCount) || 0) - selectedUnitCount,
        ),
        hasMore: selected.length < totalBatches,
      },
      progress: {
        ...(plan?.progress || {}),
        selectedBatches: selected.length,
        selectedUnits: selectedUnitCount,
        remainingAfterRound: Math.max(
          0,
          (Number(plan?.unitCount) || 0) - selectedUnitCount,
        ),
      },
    };
  }

  function translationsMap(value) {
    return value instanceof Map
      ? value
      : new Map(Object.entries(value || {}));
  }

  /**
   * Resolves untrusted planned units back to the current source. The returned
   * units are canonical copies built from stored source text, so callers never
   * send caller-forged text to a paid provider.
   */
  function validateExportSourceTranslationUnits(
    sourceInput,
    { mediaKey, sourceRevision, units } = {},
  ) {
    const source = normalizeNoteSource(sourceInput);
    const safeUnits = Array.isArray(units) ? units : [];
    if (!source) return { valid: false, code: "SOURCE_MISSING", units: [] };
    if (!mediaKey || source.mediaKey !== mediaKey) {
      return { valid: false, code: "MEDIA_MISMATCH", units: [] };
    }
    if (!sourceRevision || source.sourceRevision !== sourceRevision) {
      return { valid: false, code: "REVISION_MISMATCH", units: [] };
    }
    if (!safeUnits.length) {
      return { valid: false, code: "EMPTY_BATCH", units: [] };
    }
    const canonical = [];
    const seenUnitIds = new Set();
    for (const unit of safeUnits) {
      if (
        unit?.mediaKey !== mediaKey ||
        unit?.sourceRevision !== sourceRevision
      ) {
        return { valid: false, code: "UNIT_SCOPE_MISMATCH", units: [] };
      }
      if (unit.kind === "description") {
        const chunk = descriptionSourceChunks(source.descriptionOriginal).find(
          (candidate) =>
            candidate.index === Number(unit.chunkIndex) &&
            candidate.sourceHash === unit.sourceHash,
        );
        const expectedId = chunk
          ? sourceUnitId(
              mediaKey,
              "description",
              `${chunk.index}:${chunk.sourceHash}`,
            )
          : "";
        if (
          !chunk ||
          unit.id !== expectedId ||
          cleanText(unit.text, MAX_DESCRIPTION) !== chunk.text ||
          seenUnitIds.has(expectedId)
        ) {
          return { valid: false, code: "INVALID_UNIT", units: [] };
        }
        seenUnitIds.add(expectedId);
        canonical.push({
          id: expectedId,
          mediaKey,
          sourceRevision,
          kind: "description",
          chunkIndex: chunk.index,
          sourceHash: chunk.sourceHash,
          text: chunk.text,
          videoTitle: source.titleOriginal,
        });
        continue;
      }
      if (unit.kind === "transcript") {
        const original = source.transcriptOriginal.find(
          (entry) =>
            entry.segmentId === unit.segmentId &&
            entry.startMs === Number(unit.startMs) &&
            entry.sourceHash === unit.sourceHash,
        );
        const expectedId = original
          ? sourceUnitId(
              mediaKey,
              "transcript",
              `${hashSourceText(original.segmentId)}:${original.startMs}:${original.sourceHash}`,
            )
          : "";
        if (
          !original ||
          unit.id !== expectedId ||
          cleanText(unit.text, MAX_ENTRY_TEXT) !== original.text ||
          seenUnitIds.has(expectedId)
        ) {
          return { valid: false, code: "INVALID_UNIT", units: [] };
        }
        seenUnitIds.add(expectedId);
        canonical.push({
          id: expectedId,
          mediaKey,
          sourceRevision,
          kind: "transcript",
          segmentId: original.segmentId,
          start: original.start,
          startMs: original.startMs,
          sourceHash: original.sourceHash,
          text: original.text,
          videoTitle: source.titleOriginal,
        });
        continue;
      }
      return { valid: false, code: "INVALID_UNIT", units: [] };
    }
    return { valid: true, code: "OK", units: canonical, source };
  }

  /**
   * Applies one validated source batch. Callers can persist each changed source
   * immediately, so a later cancellation/failure never loses completed work.
   */
  function applyExportSourceTranslationBatch(
    units,
    translationsById,
    sourcesByKey = {},
  ) {
    const translated = translationsMap(translationsById);
    const next = { ...sourcesByKey };
    const safeUnits = Array.isArray(units) ? units : [];
    const mediaKeys = new Set(safeUnits.map((unit) => unit?.mediaKey));
    const revisions = new Set(safeUnits.map((unit) => unit?.sourceRevision));
    if (mediaKeys.size !== 1 || revisions.size !== 1) {
      return {
        sourcesByKey: next,
        missingUnitIds: safeUnits.map((unit) => unit?.id).filter(Boolean),
        appliedUnitIds: [],
        changedMediaKeys: [],
        stale: false,
        code: "UNIT_SCOPE_MISMATCH",
      };
    }
    const mediaKey = [...mediaKeys][0];
    const sourceRevision = [...revisions][0];
    const validation = validateExportSourceTranslationUnits(next[mediaKey], {
      mediaKey,
      sourceRevision,
      units: safeUnits,
    });
    if (!validation.valid) {
      return {
        sourcesByKey: next,
        missingUnitIds: safeUnits.map((unit) => unit?.id).filter(Boolean),
        appliedUnitIds: [],
        changedMediaKeys: [],
        stale: validation.code === "REVISION_MISMATCH",
        code: validation.code,
      };
    }
    const missingUnitIds = validation.units
      .filter((unit) => !cleanText(String(translated.get(unit.id) || ""),
        unit.kind === "description" ? MAX_DESCRIPTION : MAX_ENTRY_TEXT))
      .map((unit) => unit.id);
    // A provider response is one atomic source batch. Partial or malformed
    // results are rejected in full; the caller may retry without guessing.
    if (missingUnitIds.length) {
      return {
        sourcesByKey: next,
        missingUnitIds,
        appliedUnitIds: [],
        changedMediaKeys: [],
        stale: false,
        code: "MISSING_TRANSLATIONS",
      };
    }
    const appliedUnitIds = [];
    const changedMediaKeys = new Set();
    {
      const source = validation.source;
      const mediaUnits = validation.units;
      const updated = {
        ...source,
        descriptionZhChunks: source.descriptionZhChunks.map((chunk) => ({
          ...chunk,
        })),
        transcriptOriginal: source.transcriptOriginal.map((entry) => ({
          ...entry,
        })),
        transcriptZh: source.transcriptZh.map((entry) => ({ ...entry })),
      };
      for (const unit of mediaUnits) {
        const value = cleanText(
          String(translated.get(unit.id) || ""),
          unit.kind === "description" ? MAX_DESCRIPTION : MAX_ENTRY_TEXT,
        );
        if (unit.kind === "description") {
          const chunks = descriptionSourceChunks(updated.descriptionOriginal);
          const chunk = chunks.find(
            (candidate) =>
              candidate.index === Number(unit.chunkIndex) &&
              candidate.sourceHash === unit.sourceHash,
          );
          if (!chunk) {
            return {
              sourcesByKey: next,
              missingUnitIds: safeUnits.map((candidate) => candidate.id),
              appliedUnitIds: [],
              changedMediaKeys: [],
              stale: true,
              code: "REVISION_MISMATCH",
            };
          }
          const already = updated.descriptionZhChunks.some(
            (candidate) =>
              candidate.index === chunk.index &&
              candidate.sourceHash === chunk.sourceHash,
          );
          if (!already) {
            updated.descriptionZhChunks.push({
              index: chunk.index,
              sourceHash: chunk.sourceHash,
              textZh: value,
              translationVersion: DEFAULT_TRANSLATION_VERSION,
            });
            changedMediaKeys.add(mediaKey);
          }
          appliedUnitIds.push(unit.id);
          continue;
        }
        if (unit.kind === "transcript") {
          const original = updated.transcriptOriginal.find(
            (entry) =>
              entry.segmentId === unit.segmentId &&
              entry.startMs === Number(unit.startMs) &&
              entry.sourceHash === unit.sourceHash,
          );
          if (!original) {
            return {
              sourcesByKey: next,
              missingUnitIds: safeUnits.map((candidate) => candidate.id),
              appliedUnitIds: [],
              changedMediaKeys: [],
              stale: true,
              code: "REVISION_MISMATCH",
            };
          }
          const identity = transcriptIdentity(original);
          const already = updated.transcriptZh.some(
            (entry) => transcriptIdentity(entry) === identity,
          );
          if (!already) {
            updated.transcriptZh.push({
              segmentId: original.segmentId,
              start: original.start,
              startMs: original.startMs,
              sourceHash: original.sourceHash,
              text: value,
              translationVersion: DEFAULT_TRANSLATION_VERSION,
            });
            changedMediaKeys.add(mediaKey);
          }
          appliedUnitIds.push(unit.id);
          continue;
        }
      }
      next[mediaKey] = normalizeNoteSource(updated);
    }
    return {
      sourcesByKey: next,
      missingUnitIds,
      appliedUnitIds,
      changedMediaKeys: [...changedMediaKeys],
      stale: false,
      code: "OK",
    };
  }

  /** Backward-compatible whole-plan helper, implemented batch-by-batch. */
  function applyExportSourceTranslations(plan, translationsById, sourcesByKey = {}) {
    let next = { ...sourcesByKey };
    const missingUnitIds = [];
    const appliedUnitIds = [];
    const changed = new Set();
    for (const batch of plan?.sourceBatches || []) {
      const result = applyExportSourceTranslationBatch(
        batch,
        translationsById,
        next,
      );
      next = result.sourcesByKey;
      missingUnitIds.push(...result.missingUnitIds);
      appliedUnitIds.push(...result.appliedUnitIds);
      result.changedMediaKeys.forEach((key) => changed.add(key));
    }
    return {
      sourcesByKey: next,
      missingUnitIds,
      appliedUnitIds,
      changedMediaKeys: [...changed],
    };
  }

  // ----------------------------------------------------------------
  // Storage adapter — all migration/write/remove work shares one queue
  // ----------------------------------------------------------------

  function enqueueStorageOperation(storage, operation) {
    if (!storage || typeof storage !== "object") {
      return Promise.reject(new TypeError("A storage adapter is required."));
    }
    const previous = storageQueues.get(storage) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    storageQueues.set(storage, current.catch(() => {}));
    return current;
  }

  function normalizeLegacyStoredMap(raw) {
    const map = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const value of Object.values(raw)) {
        assertNoFutureSourceSchema(value, "legacy note-source record");
        const source = normalizeNoteSource(value);
        if (source) map[source.mediaKey] = boundSourceSize(source);
      }
    }
    return map;
  }

  function decodeCurrentStoredMap(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw noteSourceSchemaError(
        "INVALID_NOTE_SOURCE_STORAGE",
        "The schema-2 note-source store is malformed.",
      );
    }
    // A future build may replace the current map with a versioned library
    // envelope. Detect its root version before interpreting any values as
    // records; an older build must never normalize and overwrite it.
    assertNoFutureSourceSchema(raw, "note-source library");
    const map = {};
    for (const [storedKey, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw noteSourceSchemaError(
          "INVALID_NOTE_SOURCE_STORAGE",
          `Stored note source ${storedKey} is malformed.`,
        );
      }
      assertNoFutureSourceSchema(value, `stored note source ${storedKey}`);
      if (value.schemaVersion !== SCHEMA_VERSION) {
        throw noteSourceSchemaError(
          "INVALID_NOTE_SOURCE_STORAGE",
          `Stored note source ${storedKey} is not schema ${SCHEMA_VERSION}.`,
        );
      }
      const source = normalizeNoteSource(value);
      if (!source || source.mediaKey !== storedKey) {
        throw noteSourceSchemaError(
          "INVALID_NOTE_SOURCE_STORAGE",
          `Stored note source ${storedKey} has an invalid identity.`,
        );
      }
      map[source.mediaKey] = boundSourceSize(source);
    }
    return map;
  }

  async function readStorageSnapshot(storage) {
    const currentStored = await storage.get(STORAGE_KEY);
    if (
      currentStored &&
      Object.prototype.hasOwnProperty.call(currentStored, STORAGE_KEY)
    ) {
      return {
        map: decodeCurrentStoredMap(currentStored[STORAGE_KEY]),
        needsMigration: false,
      };
    }
    const legacyStored = await storage.get(LEGACY_STORAGE_KEY);
    const hasLegacy =
      legacyStored &&
      Object.prototype.hasOwnProperty.call(legacyStored, LEGACY_STORAGE_KEY) &&
      legacyStored[LEGACY_STORAGE_KEY] &&
      typeof legacyStored[LEGACY_STORAGE_KEY] === "object";
    return {
      map: normalizeLegacyStoredMap(
        hasLegacy ? legacyStored[LEGACY_STORAGE_KEY] : {},
      ),
      needsMigration: !!hasLegacy,
    };
  }

  async function preflightNoteSourceStorage(storage) {
    return enqueueStorageOperation(storage, async () => {
      await readStorageSnapshot(storage);
      return { valid: true };
    });
  }

  function evictToCap(map, protectedKeys = new Set()) {
    const entries = Object.values(map);
    if (
      entries.length <= MAX_SOURCES &&
      byteLength(JSON.stringify(map)) <= MAX_TOTAL_BYTES
    ) {
      return map;
    }
    const evictable = entries
      .filter((source) => !protectedKeys.has(source.mediaKey))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    const next = { ...map };
    for (const source of evictable) {
      if (
        Object.keys(next).length <= MAX_SOURCES &&
        byteLength(JSON.stringify(next)) <= MAX_TOTAL_BYTES
      ) {
        break;
      }
      delete next[source.mediaKey];
    }
    return next;
  }

  function mapFitsStorageCap(map) {
    return (
      Object.keys(map).length <= MAX_SOURCES &&
      byteLength(JSON.stringify(map)) <= MAX_TOTAL_BYTES
    );
  }

  async function readAllSources(storage) {
    return enqueueStorageOperation(storage, async () => {
      const snapshot = await readStorageSnapshot(storage);
      if (snapshot.needsMigration && mapFitsStorageCap(snapshot.map)) {
        await storage.set({ [STORAGE_KEY]: snapshot.map });
      }
      return snapshot.map;
    });
  }

  async function readNoteSource(storage, mediaKey) {
    const key = normalizeMediaKey(mediaKey);
    if (!key) return null;
    return enqueueStorageOperation(storage, async () => {
      const snapshot = await readStorageSnapshot(storage);
      if (snapshot.needsMigration && mapFitsStorageCap(snapshot.map)) {
        await storage.set({ [STORAGE_KEY]: snapshot.map });
      }
      return snapshot.map[key] || null;
    });
  }

  async function writeNoteSource(
    storage,
    incoming,
    { now = Date.now(), protectedKeys } = {},
  ) {
    const candidate = normalizeNoteSource(incoming);
    if (!candidate) return { changed: false };
    return enqueueStorageOperation(storage, async () => {
      const snapshot = await readStorageSnapshot(storage);
      const map = snapshot.map;
      const { source, changed } = mergeNoteSource(
        map[candidate.mediaKey],
        candidate,
        { now },
      );
      if (!source) return { changed: false };
      if (!changed && map[candidate.mediaKey]) {
        if (snapshot.needsMigration && mapFitsStorageCap(map)) {
          await storage.set({ [STORAGE_KEY]: map });
        }
        return { changed: false };
      }
      map[candidate.mediaKey] = source;
      const keep =
        protectedKeys instanceof Set ? new Set(protectedKeys) : new Set();
      keep.add(candidate.mediaKey);
      await storage.set({ [STORAGE_KEY]: evictToCap(map, keep) });
      return { changed: true };
    });
  }

  async function removeNoteSources(storage, mediaKeys) {
    const keys = new Set(
      (Array.isArray(mediaKeys) ? mediaKeys : [mediaKeys])
        .map(normalizeMediaKey)
        .filter(Boolean),
    );
    if (!keys.size) return { changed: false };
    return enqueueStorageOperation(storage, async () => {
      const snapshot = await readStorageSnapshot(storage);
      const map = snapshot.map;
      let changed = false;
      for (const key of keys) {
        if (map[key]) {
          delete map[key];
          changed = true;
        }
      }
      if (changed || snapshot.needsMigration) {
        await storage.set({ [STORAGE_KEY]: map });
      }
      return { changed };
    });
  }

  function assertClearableStoredSchema(raw, storageKey) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const versions = [];
    if (Number.isSafeInteger(raw.schemaVersion)) {
      versions.push(raw.schemaVersion);
    }
    for (const value of Object.values(raw)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (Number.isSafeInteger(value.schemaVersion)) {
          versions.push(value.schemaVersion);
        }
      }
    }
    if (versions.some((version) => version > SCHEMA_VERSION)) {
      const error = new Error(
        `Stored note sources at ${storageKey} use a future schema.`,
      );
      error.code = "UNSUPPORTED_NOTE_SOURCE_SCHEMA";
      throw error;
    }
  }

  /**
   * Clears both schema-2 and legacy source stores in the mutation queue. A
   * future schema is never deleted by an older build. Background callers use
   * this same queue as source-batch commits, so a queued commit cannot restore
   * the whole-map store after clear has completed.
   */
  async function clearNoteSources(storage) {
    return enqueueStorageOperation(storage, async () => {
      const currentStored = await storage.get(STORAGE_KEY);
      const legacyStored = await storage.get(LEGACY_STORAGE_KEY);
      const hasCurrent =
        !!currentStored &&
        Object.prototype.hasOwnProperty.call(currentStored, STORAGE_KEY);
      const hasLegacy =
        !!legacyStored &&
        Object.prototype.hasOwnProperty.call(legacyStored, LEGACY_STORAGE_KEY);
      if (hasCurrent) decodeCurrentStoredMap(currentStored[STORAGE_KEY]);
      assertClearableStoredSchema(
        hasLegacy ? legacyStored[LEGACY_STORAGE_KEY] : undefined,
        LEGACY_STORAGE_KEY,
      );
      if (!hasCurrent && !hasLegacy) return { changed: false };
      if (typeof storage.remove === "function") {
        await storage.remove([STORAGE_KEY, LEGACY_STORAGE_KEY]);
      } else {
        await storage.set({
          [STORAGE_KEY]: {},
          [LEGACY_STORAGE_KEY]: {},
        });
      }
      return { changed: true };
    });
  }

  /**
   * Atomically re-reads, revision-checks, applies and persists one source batch.
   * `sourceRevision` is content-derived from original material; adding Chinese
   * translations does not change it, so subsequent batches from the same
   * frozen plan remain valid. Any original-source change creates a new token.
   */
  async function commitExportSourceTranslationBatch(
    storage,
    {
      mediaKey,
      expectedRevision,
      sourceRevision,
      units,
      translationsById,
    } = {},
    { now = Date.now(), protectedKeys } = {},
  ) {
    const key = normalizeMediaKey(mediaKey);
    const revision = String(expectedRevision || sourceRevision || "");
    const safeUnits = Array.isArray(units) ? units : [];
    if (!key || !revision || !safeUnits.length) {
      return {
        changed: false,
        stale: false,
        code: "INVALID_BATCH",
        sourceRevision: "",
        appliedUnitIds: [],
        missingUnitIds: safeUnits.map((unit) => unit?.id).filter(Boolean),
        source: null,
      };
    }
    return enqueueStorageOperation(storage, async () => {
      const snapshot = await readStorageSnapshot(storage);
      const current = snapshot.map[key] || null;
      if (!current) {
        if (snapshot.needsMigration && mapFitsStorageCap(snapshot.map)) {
          await storage.set({ [STORAGE_KEY]: snapshot.map });
        }
        return {
          changed: false,
          stale: true,
          code: "SOURCE_MISSING",
          sourceRevision: "",
          appliedUnitIds: [],
          missingUnitIds: safeUnits.map((unit) => unit?.id).filter(Boolean),
          source: null,
        };
      }
      if (current.sourceRevision !== revision) {
        return {
          changed: false,
          stale: true,
          code: "REVISION_MISMATCH",
          sourceRevision: current.sourceRevision,
          appliedUnitIds: [],
          missingUnitIds: safeUnits.map((unit) => unit?.id).filter(Boolean),
          source: current,
        };
      }
      const result = applyExportSourceTranslationBatch(
        safeUnits,
        translationsById,
        { [key]: current },
      );
      if (result.code !== "OK" || result.missingUnitIds.length) {
        return {
          changed: false,
          stale: !!result.stale,
          code: result.code,
          sourceRevision: current.sourceRevision,
          appliedUnitIds: [],
          missingUnitIds: result.missingUnitIds,
          source: current,
        };
      }
      const applied = result.sourcesByKey[key];
      const changed = result.changedMediaKeys.includes(key);
      if (changed) {
        const map = snapshot.map;
        map[key] = { ...applied, updatedAt: now };
        const keep =
          protectedKeys instanceof Set ? new Set(protectedKeys) : new Set();
        keep.add(key);
        await storage.set({ [STORAGE_KEY]: evictToCap(map, keep) });
      } else if (
        snapshot.needsMigration &&
        mapFitsStorageCap(snapshot.map)
      ) {
        await storage.set({ [STORAGE_KEY]: snapshot.map });
      }
      return {
        changed,
        stale: false,
        code: "OK",
        sourceRevision: applied.sourceRevision,
        appliedUnitIds: result.appliedUnitIds,
        missingUnitIds: [],
        source: changed ? { ...applied, updatedAt: now } : applied,
      };
    });
  }

  return {
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    SCHEMA_VERSION,
    MAX_SOURCES,
    MAX_SOURCE_BYTES,
    MAX_TOTAL_BYTES,
    MAX_TRANSCRIPT_ENTRIES,
    EXPORT_TRANSLATION_MAX_VIDEOS,
    EXPORT_TRANSLATION_MAX_UNITS,
    EXPORT_TRANSLATION_MAX_BATCHES,
    EXPORT_TRANSLATION_MAX_PROVIDER_CALLS,
    EXPORT_TRANSLATION_ROUND_MAX_BATCHES,
    EXPORT_TRANSLATION_ROUND_MAX_PROVIDER_CALLS,
    isChineseLanguageTag,
    hashSourceText,
    normalizeTranscript,
    normalizeNoteSource,
    countMissingTranscriptTranslations,
    estimateSourceBytes,
    mergeNoteSource,
    sourceFromDigest,
    toExportSource,
    buildExportPrecheck,
    splitTextForTranslation,
    buildExportTranslationPlan,
    takeExportTranslationRound,
    validateExportSourceTranslationUnits,
    applyExportSourceTranslationBatch,
    applyExportSourceBatchTranslations: applyExportSourceTranslationBatch,
    applyExportSourceTranslations,
    readAllSources,
    readNoteSource,
    preflightNoteSourceStorage,
    writeNoteSource,
    removeNoteSources,
    clearNoteSources,
    commitExportSourceTranslationBatch,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_NOTE_SOURCES;
}
