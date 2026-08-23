/**
 * Media-deduplicated "note source" library.
 *
 * A note carries only its own timestamped text. The full material a reading
 * export needs — title, channel, canonical URL, video description, and the
 * complete transcript (original + Chinese) — is stored once per stable media
 * identity here, keyed by `mediaKey`, rather than duplicated onto every note.
 *
 * This module is pure logic plus a thin storage adapter. It never touches the
 * network, a provider, Supadata, or the DOM: callers hand it already-loaded
 * material (from the side panel's in-memory state, or from a no-network backfill
 * of the local `digest_<mediaKey>` cache) and it validates, de-duplicates,
 * bounds and persists it. The export precheck it builds is strictly read-only,
 * so a missing translation is reported as missing rather than silently fetched.
 *
 * Storage lives under a single `chrome.storage.local` key (`ytd_note_sources`),
 * mirroring how notes live under `ytd_notes`. Full transcripts are the heavy
 * part, so per-source and total byte caps keep the library from crowding the
 * settings, notes and digest caches out of the default local quota; we do NOT
 * request `unlimitedStorage`. When the cap is reached the least-recently-updated
 * source whose video has no note is evicted first.
 */
var YTD_NOTE_SOURCES = (() => {
  const STORAGE_KEY = "ytd_note_sources";
  const SCHEMA_VERSION = 1;

  const MAX_SOURCES = 200;
  const MAX_TITLE = 500;
  const MAX_CHANNEL = 300;
  const MAX_URL = 2048;
  const MAX_DESCRIPTION = 20_000;
  const MAX_LANGUAGE_TAG = 100;
  const MAX_MEDIA_KEY = 64;
  const MAX_TRANSCRIPT_ENTRIES = 6000;
  const MAX_ENTRY_TEXT = 4000;
  const MAX_START_SECONDS = 24 * 60 * 60; // a day; guards against absurd values
  // Per-source and whole-library ceilings. chrome.storage.local defaults to
  // ~10 MiB; leave headroom for notes, settings and the digest cache.
  const MAX_SOURCE_BYTES = 1_500_000;
  const MAX_TOTAL_BYTES = 8_000_000;

  // A user-confirmed "generate and export" job must stay bounded. These are
  // product safety limits, not provider limits: they prevent one click on a
  // large note library or multi-hour video from turning into an unbounded
  // sequence of paid requests. The UI reports the exact over-limit reason and
  // never starts a partial job.
  const EXPORT_TRANSLATION_MAX_VIDEOS = 20;
  const EXPORT_TRANSLATION_MAX_UNITS = 240;
  const EXPORT_TRANSLATION_MAX_BATCHES = 80;
  const EXPORT_TRANSLATION_MAX_PROVIDER_CALLS = 100;
  const EXPORT_TRANSLATION_BATCH_SIZE = 4;
  const EXPORT_DESCRIPTION_CHUNK_CHARS = 3000;

  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

  // Deliberately conservative: a fallback "already Chinese?" test used only when
  // the caller does not inject the side panel's richer heuristic. Rejects
  // Japanese/Korean scripts and requires Han characters to dominate any Latin.
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

  // ----------------------------------------------------------------
  // Transcript normalization
  // ----------------------------------------------------------------

  function normalizeTranscript(entries) {
    if (!Array.isArray(entries)) return [];
    const cleaned = [];
    for (const entry of entries) {
      const start = Number(entry?.start);
      if (!Number.isFinite(start) || start < 0 || start > MAX_START_SECONDS) {
        continue;
      }
      const text = cleanText(entry?.text, MAX_ENTRY_TEXT);
      if (!text) continue;
      cleaned.push({ start: Math.floor(start), text });
      if (cleaned.length >= MAX_TRANSCRIPT_ENTRIES) break;
    }
    return cleaned.sort((left, right) => left.start - right.start);
  }

  /**
   * Counts original transcript segments that have no non-empty Chinese segment
   * at the same start. Used by the export precheck; strictly read-only.
   */
  function countMissingTranscriptTranslations(transcriptOriginal, transcriptZh) {
    const zhByStart = new Map(
      (Array.isArray(transcriptZh) ? transcriptZh : [])
        .filter((entry) => String(entry?.text || "").trim())
        .map((entry) => [Math.floor(Number(entry?.start) || 0), true]),
    );
    let missing = 0;
    for (const entry of Array.isArray(transcriptOriginal) ? transcriptOriginal : []) {
      if (!zhByStart.has(Math.floor(Number(entry?.start) || 0))) missing += 1;
    }
    return missing;
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

  /**
   * Validates and bounds a source record. Returns null when the record lacks a
   * usable media identity (the only hard requirement). Every other field is
   * optional and simply bounded, because this data comes from our own runtime,
   * not an untrusted import file.
   */
  function normalizeNoteSource(input) {
    if (!input || typeof input !== "object") return null;
    const mediaKey = normalizeMediaKey(input.mediaKey);
    if (!mediaKey) return null;
    const transcriptOriginal = normalizeTranscript(input.transcriptOriginal);
    const transcriptZh = normalizeTranscript(input.transcriptZh);
    const updatedAt =
      Number.isSafeInteger(input.updatedAt) && input.updatedAt > 0
        ? input.updatedAt
        : 0;
    return {
      schemaVersion: SCHEMA_VERSION,
      mediaKey,
      platform: normalizePlatform(input.platform),
      canonicalUrl: cleanText(input.canonicalUrl, MAX_URL),
      titleOriginal: cleanText(input.titleOriginal, MAX_TITLE),
      titleZh: cleanText(input.titleZh, MAX_TITLE),
      channelName: cleanText(input.channelName, MAX_CHANNEL),
      descriptionOriginal: cleanText(input.descriptionOriginal, MAX_DESCRIPTION),
      descriptionZh: cleanText(input.descriptionZh, MAX_DESCRIPTION),
      sourceLanguage: cleanText(input.sourceLanguage, MAX_LANGUAGE_TAG),
      transcriptOriginal,
      transcriptZh,
      transcriptTranslationComplete:
        transcriptOriginal.length > 0 &&
        countMissingTranscriptTranslations(transcriptOriginal, transcriptZh) === 0,
      updatedAt,
    };
  }

  function estimateSourceBytes(source) {
    return byteLength(JSON.stringify(source || {}));
  }

  /**
   * Enforces the per-source byte cap by trimming the heaviest field
   * (transcripts) before the description. Keeps identity + title + URL intact so
   * a very long video still exports its metadata and notes.
   */
  function boundSourceSize(source) {
    let bounded = source;
    while (estimateSourceBytes(bounded) > MAX_SOURCE_BYTES) {
      if (
        bounded.transcriptZh.length > 0 ||
        bounded.transcriptOriginal.length > 0
      ) {
        const nextOriginal = bounded.transcriptOriginal.slice(
          0,
          Math.floor(bounded.transcriptOriginal.length * 0.9),
        );
        const nextZh = bounded.transcriptZh.slice(
          0,
          Math.floor(bounded.transcriptZh.length * 0.9),
        );
        if (
          nextOriginal.length === bounded.transcriptOriginal.length &&
          nextZh.length === bounded.transcriptZh.length
        ) {
          bounded = { ...bounded, transcriptOriginal: [], transcriptZh: [] };
        } else {
          bounded = {
            ...bounded,
            transcriptOriginal: nextOriginal,
            transcriptZh: nextZh,
          };
        }
        bounded.transcriptTranslationComplete =
          bounded.transcriptOriginal.length > 0 &&
          countMissingTranscriptTranslations(
            bounded.transcriptOriginal,
            bounded.transcriptZh,
          ) === 0;
        continue;
      }
      if (bounded.descriptionOriginal || bounded.descriptionZh) {
        bounded = { ...bounded, descriptionOriginal: "", descriptionZh: "" };
        continue;
      }
      break;
    }
    return bounded;
  }

  /**
   * Idempotent merge of an incoming source into an existing one. Fills empty
   * fields, upgrades a translation only from empty (never overwrites an existing
   * non-empty translation with a different one), and replaces a transcript only
   * when the incoming one is at least as complete. Returns { source, changed }.
   */
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

    let changed = false;
    const merged = { ...prev };

    // Identity-ish scalars: fill when empty, refresh when a newer non-empty
    // value differs (title/channel can legitimately update).
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
          changed = true;
        }
      }
    }

    // Description: prefer the longer original (more complete), fill Chinese.
    if (
      next.descriptionOriginal &&
      next.descriptionOriginal.length > merged.descriptionOriginal.length
    ) {
      merged.descriptionOriginal = next.descriptionOriginal;
      changed = true;
    }
    if (next.descriptionZh && !merged.descriptionZh) {
      merged.descriptionZh = next.descriptionZh;
      changed = true;
    }

    // Chinese title fills only from empty; a different validated title is the
    // caller's job to resolve, never silently overwritten here.
    if (next.titleZh && !merged.titleZh) {
      merged.titleZh = next.titleZh;
      changed = true;
    }

    // Transcripts: replace when the incoming copy is at least as long (more
    // complete), so a fully-loaded reload upgrades a partial capture.
    if (
      next.transcriptOriginal.length >= merged.transcriptOriginal.length &&
      next.transcriptOriginal.length > 0 &&
      JSON.stringify(next.transcriptOriginal) !==
        JSON.stringify(merged.transcriptOriginal)
    ) {
      merged.transcriptOriginal = next.transcriptOriginal;
      changed = true;
    }
    if (
      next.transcriptZh.length >= merged.transcriptZh.length &&
      next.transcriptZh.length > 0 &&
      JSON.stringify(next.transcriptZh) !== JSON.stringify(merged.transcriptZh)
    ) {
      merged.transcriptZh = next.transcriptZh;
      changed = true;
    }

    merged.transcriptTranslationComplete =
      merged.transcriptOriginal.length > 0 &&
      countMissingTranscriptTranslations(
        merged.transcriptOriginal,
        merged.transcriptZh,
      ) === 0;

    if (changed) merged.updatedAt = now;
    else
      merged.updatedAt =
        Math.max(prev.updatedAt, next.updatedAt) || prev.updatedAt;

    return { source: boundSourceSize(merged), changed };
  }

  /**
   * Builds a source from a no-network `digest_<mediaKey>` cache entry. The
   * digest cache never stored the video description, so descriptions come only
   * from a live side-panel capture; a backfilled source reports its description
   * as missing rather than inventing one.
   *
   * @param {string} mediaKey
   * @param {object} digest the parsed digest cache value
   * @param {{transcriptZh?: Array}} [extra] optional pre-resolved Chinese
   *   segments (the side panel resolves these from the digest's paragraphCache)
   */
  function sourceFromDigest(mediaKey, digest, { transcriptZh = [] } = {}) {
    if (!digest || typeof digest !== "object") return null;
    const platform = digest.mediaRef?.platform || "youtube";
    return normalizeNoteSource({
      mediaKey,
      platform,
      canonicalUrl: digest.mediaRef?.canonicalUrl || "",
      titleOriginal: digest.videoTitle || "",
      channelName: digest.channelName || "",
      sourceLanguage:
        digest.transcriptLanguage || digest.transcriptRequestedLanguage || "",
      transcriptOriginal: Array.isArray(digest.transcript)
        ? digest.transcript
        : [],
      transcriptZh,
      updatedAt: Number(digest.timestamp) || 0,
    });
  }

  // ----------------------------------------------------------------
  // Export bridge: NoteSource + notes -> note-export.js "source" shape
  // ----------------------------------------------------------------

  /**
   * Converts a stored source plus its notes into the shape note-export.js
   * consumes. `resolveNote(note) => { original, zh }` lets the caller reuse the
   * side panel's validated per-note language logic so on-screen and exported
   * note text never diverge.
   */
  function toExportSource(source, notes, { resolveNote } = {}) {
    const resolved = normalizeNoteSource(source) || {
      platform: "youtube",
      canonicalUrl: "",
      titleOriginal: "",
      titleZh: "",
      channelName: "",
      descriptionOriginal: "",
      descriptionZh: "",
      transcriptOriginal: [],
      transcriptZh: [],
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
      transcriptOriginal: resolved.transcriptOriginal,
      transcriptZh: resolved.transcriptZh,
      notes: (Array.isArray(notes) ? notes : []).map((note) => ({
        timestampSeconds: Number(note?.timestampSeconds) || 0,
        ...resolver(note),
      })),
    };
  }

  // ----------------------------------------------------------------
  // Export precheck — strictly read-only report
  // ----------------------------------------------------------------

  /**
   * Builds a read-only precheck for an export scope.
   *
   * @param {object} params
   * @param {Array<{mediaKey: string, representative: object, notes: object[]}>}
   *   params.groups notes grouped by source (from note-export.groupNotesBySource)
   * @param {Object<string, object>} params.sourcesByKey stored sources by mediaKey
   * @param {"original"|"zh"|"bilingual"} params.mode
   * @param {(group: object) => string} [params.titleOf] visible title resolver
   * @param {(text: string) => boolean} [params.isChineseText] "already Chinese?"
   */
  function buildExportPrecheck({
    groups,
    sourcesByKey = {},
    mode = "original",
    titleOf,
    isChineseText = defaultIsChineseText,
    resolveNote,
  } = {}) {
    const wantsTranslation = mode === "zh" || mode === "bilingual";
    const videos = (Array.isArray(groups) ? groups : []).map((group) => {
      const rep = group.representative || (group.notes && group.notes[0]) || {};
      const source = sourcesByKey[group.mediaKey] || null;
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

      const hasOriginalTranscript = transcriptTotal > 0;
      const hasUrl = !!canonicalUrl;
      const blockingReasons = [];
      if (!hasOriginalTranscript) blockingReasons.push("缺少完整字幕");
      if (!hasUrl) blockingReasons.push("缺少视频网址");

      const needsTitleTranslation =
        wantsTranslation &&
        !originalIsChinese &&
        !!titleOriginal &&
        !isChineseText(titleOriginal) &&
        !source?.titleZh;
      const needsDescriptionTranslation =
        wantsTranslation &&
        !originalIsChinese &&
        !!descriptionOriginal &&
        !isChineseText(descriptionOriginal) &&
        !source?.descriptionZh;
      const transcriptMissingCount =
        wantsTranslation && !originalIsChinese
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
        hasDescription: !!descriptionOriginal,
        hasOriginalTranscript,
        transcriptTotal,
        needsTitleTranslation,
        needsDescriptionTranslation,
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
        transcriptSegments:
          totals.transcriptSegments + video.transcriptMissingCount,
        notes: totals.notes + video.noteTranslationCount,
      }),
      { titles: 0, descriptions: 0, transcriptSegments: 0, notes: 0 },
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
          translationGaps.descriptions +
          translationGaps.transcriptSegments +
          translationGaps.notes >
        0,
    };
  }

  // ----------------------------------------------------------------
  // User-confirmed export translation planning
  // ----------------------------------------------------------------

  function splitTextForTranslation(value, maxChars = EXPORT_DESCRIPTION_CHUNK_CHARS) {
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
      const cut = Number.isInteger(boundary) && boundary >= floor
        ? boundary + 1
        : maxChars;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
  }

  function chunkArray(values, size) {
    const chunks = [];
    for (let index = 0; index < values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }
    return chunks;
  }

  /**
   * Builds a deterministic, bounded plan for a user-confirmed export
   * translation. No network/storage/DOM work happens here. Notes and titles use
   * the existing validated note translation endpoint; descriptions and missing
   * transcript rows use the stable-ID transcript batch endpoint.
   */
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
    let unitSequence = 0;

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
          !source?.titleZh &&
          !isChineseText(titleOriginal) &&
          !seenTitles.has(group.mediaKey)
        ) {
          seenTitles.add(group.mediaKey);
          titles.push({ mediaKey: group.mediaKey, title: titleOriginal });
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
          if (!original || zh || isChineseText(original)) return;
          notes.push({
            id: String(note?.id || ""),
            text: original,
            videoTitle: titleOriginal,
            rawText: String(note?.rawText || ""),
            sourceLanguage: String(note?.sourceLanguage || source?.sourceLanguage || ""),
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
          !source.descriptionZh &&
          !isChineseText(source.descriptionOriginal)
        ) {
          splitTextForTranslation(source.descriptionOriginal).forEach(
            (text, chunkIndex) => {
              const id = `u${unitSequence++}`;
              work.descriptionUnitIds.push(id);
              sourceUnits.push({
                id,
                mediaKey: group.mediaKey,
                kind: "description",
                chunkIndex,
                text,
                videoTitle: titleOriginal,
              });
            },
          );
        }

        const zhByStart = new Map(
          source.transcriptZh
            .filter((entry) => String(entry?.text || "").trim())
            .map((entry) => [Math.floor(Number(entry.start) || 0), true]),
        );
        (includeTranscript ? source.transcriptOriginal : []).forEach((entry, transcriptIndex) => {
          const start = Math.floor(Number(entry.start) || 0);
          if (zhByStart.has(start) || isChineseText(entry.text)) return;
          const id = `u${unitSequence++}`;
          work.transcriptUnits.push({ id, start, transcriptIndex });
          sourceUnits.push({
            id,
            mediaKey: group.mediaKey,
            kind: "transcript",
            start,
            transcriptIndex,
            text: entry.text,
            videoTitle: titleOriginal,
          });
        });
        if (work.descriptionUnitIds.length || work.transcriptUnits.length) {
          sourceWorkByKey[group.mediaKey] = work;
        }
      });
    }

    const noteBatches = chunkArray(notes, 10);
    const titleBatches = chunkArray(titles, 10);
    const sourceBatches = [];
    let pending = [];
    let pendingCharacters = 0;
    sourceUnits.forEach((unit) => {
      const length = unit.text.length;
      if (
        pending.length >= EXPORT_TRANSLATION_BATCH_SIZE ||
        (pending.length && pendingCharacters + length > 12000)
      ) {
        sourceBatches.push(pending);
        pending = [];
        pendingCharacters = 0;
      }
      pending.push(unit);
      pendingCharacters += length;
    });
    if (pending.length) sourceBatches.push(pending);

    const unitCount = notes.length + titles.length + sourceUnits.length;
    const estimatedBatches =
      noteBatches.length + titleBatches.length + sourceBatches.length;
    // Note/title jobs have an internal five-call recovery budget; a transcript
    // batch may retry once only for a provider's empty JSON response. Expose the
    // conservative maximum so the confirmation copy does not understate cost.
    const maxProviderCalls =
      (noteBatches.length + titleBatches.length) * 5 +
      sourceBatches.length * 2;
    const limitReasons = [];
    if (safeGroups.length > EXPORT_TRANSLATION_MAX_VIDEOS) {
      limitReasons.push(`超过 ${EXPORT_TRANSLATION_MAX_VIDEOS} 个视频`);
    }
    if (unitCount > EXPORT_TRANSLATION_MAX_UNITS) {
      limitReasons.push(`超过 ${EXPORT_TRANSLATION_MAX_UNITS} 个待翻译单元`);
    }
    if (estimatedBatches > EXPORT_TRANSLATION_MAX_BATCHES) {
      limitReasons.push(`超过 ${EXPORT_TRANSLATION_MAX_BATCHES} 个请求批次`);
    }
    if (maxProviderCalls > EXPORT_TRANSLATION_MAX_PROVIDER_CALLS) {
      limitReasons.push(
        `错误恢复上限超过 ${EXPORT_TRANSLATION_MAX_PROVIDER_CALLS} 次模型请求`,
      );
    }

    return {
      mode,
      videoCount: safeGroups.length,
      noteBatches,
      titleBatches,
      sourceBatches,
      sourceWorkByKey,
      unitCount,
      estimatedBatches,
      maxProviderCalls,
      overLimit: limitReasons.length > 0,
      limitReasons,
    };
  }

  /** Applies validated stable-ID source translations to cloned source records. */
  function applyExportSourceTranslations(plan, translationsById, sourcesByKey = {}) {
    const translated =
      translationsById instanceof Map
        ? translationsById
        : new Map(Object.entries(translationsById || {}));
    const next = { ...sourcesByKey };
    const missingUnitIds = [];

    for (const [mediaKey, work] of Object.entries(plan?.sourceWorkByKey || {})) {
      const source = normalizeNoteSource(sourcesByKey[mediaKey]);
      if (!source) continue;
      const updated = {
        ...source,
        transcriptOriginal: source.transcriptOriginal.map((entry) => ({ ...entry })),
        transcriptZh: source.transcriptZh.map((entry) => ({ ...entry })),
      };

      if (work.descriptionUnitIds.length) {
        const chunks = work.descriptionUnitIds.map((id) =>
          String(translated.get(id) || "").trim(),
        );
        chunks.forEach((value, index) => {
          if (!value) missingUnitIds.push(work.descriptionUnitIds[index]);
        });
        if (chunks.every(Boolean)) updated.descriptionZh = chunks.join("\n\n");
      }

      const zhByStart = new Map(
        updated.transcriptZh.map((entry) => [Math.floor(entry.start), entry.text]),
      );
      work.transcriptUnits.forEach(({ id, start }) => {
        const value = String(translated.get(id) || "").trim();
        if (value) zhByStart.set(Math.floor(start), value);
        else missingUnitIds.push(id);
      });
      updated.transcriptZh = updated.transcriptOriginal
        .map((entry) => ({
          start: Math.floor(entry.start),
          text: zhByStart.get(Math.floor(entry.start)) || "",
        }))
        .filter((entry) => entry.text);
      next[mediaKey] = normalizeNoteSource(updated);
    }
    return { sourcesByKey: next, missingUnitIds };
  }

  // ----------------------------------------------------------------
  // Storage adapter (chrome.storage.local-shaped: async get/set)
  // ----------------------------------------------------------------

  async function readAllSources(storage) {
    const stored = await storage.get(STORAGE_KEY);
    const raw = stored && stored[STORAGE_KEY];
    const map = {};
    if (raw && typeof raw === "object") {
      for (const value of Object.values(raw)) {
        const source = normalizeNoteSource(value);
        if (source) map[source.mediaKey] = source;
      }
    }
    return map;
  }

  /**
   * Drops the least-recently-updated sources until the library is within the
   * source-count and total-byte caps. Sources whose mediaKey is in
   * `protectedKeys` (still referenced by a note, or just written) are kept.
   */
  function evictToCap(map, protectedKeys = new Set()) {
    const entries = Object.values(map);
    const overCount = entries.length - MAX_SOURCES;
    const overBytes = byteLength(JSON.stringify(map)) - MAX_TOTAL_BYTES;
    if (overCount <= 0 && overBytes <= 0) return map;

    const evictable = entries
      .filter((source) => !protectedKeys.has(source.mediaKey))
      .sort((left, right) => left.updatedAt - right.updatedAt);

    const next = { ...map };
    let remainingCount = entries.length;
    for (const source of evictable) {
      const withinCount = remainingCount <= MAX_SOURCES;
      const withinBytes = byteLength(JSON.stringify(next)) <= MAX_TOTAL_BYTES;
      if (withinCount && withinBytes) break;
      delete next[source.mediaKey];
      remainingCount -= 1;
    }
    return next;
  }

  /**
   * Upserts a source (idempotent merge) and persists the whole map. Returns
   * { changed }. `protectedKeys` keeps referenced sources from being evicted.
   */
  async function writeNoteSource(
    storage,
    incoming,
    { now = Date.now(), protectedKeys } = {},
  ) {
    const candidate = normalizeNoteSource(incoming);
    if (!candidate) return { changed: false };
    const map = await readAllSources(storage);
    const { source, changed } = mergeNoteSource(
      map[candidate.mediaKey],
      candidate,
      { now },
    );
    if (!source) return { changed: false };
    if (!changed && map[candidate.mediaKey]) return { changed: false };
    map[candidate.mediaKey] = source;
    const keep =
      protectedKeys instanceof Set ? new Set(protectedKeys) : new Set();
    keep.add(candidate.mediaKey);
    const bounded = evictToCap(map, keep);
    await storage.set({ [STORAGE_KEY]: bounded });
    return { changed: true };
  }

  async function removeNoteSources(storage, mediaKeys) {
    const keys = new Set(
      (Array.isArray(mediaKeys) ? mediaKeys : [mediaKeys])
        .map(normalizeMediaKey)
        .filter(Boolean),
    );
    if (!keys.size) return { changed: false };
    const map = await readAllSources(storage);
    let changed = false;
    for (const key of keys) {
      if (map[key]) {
        delete map[key];
        changed = true;
      }
    }
    if (changed) await storage.set({ [STORAGE_KEY]: map });
    return { changed };
  }

  return {
    STORAGE_KEY,
    SCHEMA_VERSION,
    MAX_SOURCES,
    MAX_SOURCE_BYTES,
    MAX_TOTAL_BYTES,
    MAX_TRANSCRIPT_ENTRIES,
    EXPORT_TRANSLATION_MAX_VIDEOS,
    EXPORT_TRANSLATION_MAX_UNITS,
    EXPORT_TRANSLATION_MAX_BATCHES,
    EXPORT_TRANSLATION_MAX_PROVIDER_CALLS,
    isChineseLanguageTag,
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
    applyExportSourceTranslations,
    readAllSources,
    writeNoteSource,
    removeNoteSources,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_NOTE_SOURCES;
}
