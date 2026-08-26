/**
 * Pure, dependency-free helpers shared by the side panel UI and the reading
 * exports (TXT notes + TXT transcript).
 * Centralizing grouping, timecode
 * formatting and the original/Chinese/bilingual language assembly here keeps the
 * on-screen rendering and the exported files from drifting into two different
 * sets of rules.
 *
 * Nothing in this file touches the DOM, chrome.* APIs, the network, or any
 * secret. Callers resolve each note/title/transcript's original and Chinese
 * strings (using their own validated language heuristics) and pass them in.
 */
var YTD_NOTE_EXPORT = (() => {
  const MODES = ["original", "zh", "bilingual"];
  // ASCII control characters and DEL, stripped from any text that lands in a
  // filename or an exported document header.
  const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g;

  function normalizeMode(mode) {
    return MODES.includes(mode) ? mode : "original";
  }

  // ----------------------------------------------------------------
  // Timecode
  // ----------------------------------------------------------------

  function formatTimecode(totalSeconds) {
    const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ----------------------------------------------------------------
  // Grouping and ordering
  // ----------------------------------------------------------------

  /**
   * Stable grouping key for a note's source video. Prefers the durable
   * `mediaKey`; falls back to a legacy YouTube note's `videoId`. Never uses the
   * mutable, possibly-duplicate video title.
   */
  function noteMediaGroupKey(note) {
    const mediaKey = String(note?.mediaKey || "").trim();
    if (mediaKey) return mediaKey;
    const videoId = String(note?.videoId || "").trim();
    if (videoId) return videoId;
    // Last resort so an id-less legacy note still renders in its own container
    // instead of merging with unrelated notes.
    return `__note__:${String(note?.id || "")}`;
  }

  /**
   * Orders notes strictly by timecode ascending, with the stable note `id` as
   * the final tie-breaker so equal timestamps render consistently. Never uses
   * `createdAt`.
   */
  function sortNotesByTimecode(notes) {
    return [...(notes || [])].sort(
      (left, right) =>
        (Number(left?.timestampSeconds) || 0) -
          (Number(right?.timestampSeconds) || 0) ||
        String(left?.id || "").localeCompare(String(right?.id || "")),
    );
  }

  /**
   * Groups notes into one container per stable media identity. Each group keeps
   * a representative note (first seen) for shared metadata and a
   * timecode-sorted note list. First-appearance order is preserved; callers use
   * sortNoteGroups() to order for display/export.
   */
  function groupNotesBySource(notes) {
    const groups = new Map();
    (notes || []).forEach((note) => {
      const key = noteMediaGroupKey(note);
      let group = groups.get(key);
      if (!group) {
        group = { mediaKey: key, representative: note, notes: [] };
        groups.set(key, group);
      }
      group.notes.push(note);
    });
    return Array.from(groups.values()).map((group) => ({
      mediaKey: group.mediaKey,
      representative: group.representative,
      notes: sortNotesByTimecode(group.notes),
    }));
  }

  /**
   * Sorts source groups by a caller-provided visible title (localeCompare
   * zh-CN), with `mediaKey` as the stable tie-breaker. `titleOf` receives the
   * group's representative note and returns the string to sort by, so the UI
   * and export can supply their own mode-aware visible title without this
   * module knowing about language heuristics.
   */
  function sortNoteGroups(groups, titleOf) {
    const keyFor =
      typeof titleOf === "function" ? titleOf : (group) => group.mediaKey;
    return [...(groups || [])].sort((left, right) => {
      const titleLeft = String(keyFor(left.representative, left) || "");
      const titleRight = String(keyFor(right.representative, right) || "");
      return (
        titleLeft.localeCompare(titleRight, "zh-CN") ||
        String(left.mediaKey).localeCompare(String(right.mediaKey))
      );
    });
  }

  // ----------------------------------------------------------------
  // Language assembly — the single source of truth for original / Chinese /
  // bilingual. Returns ordered blocks; callers render or serialize them.
  // ----------------------------------------------------------------

  /**
   * @param {string} original resolved original-language text
   * @param {string} zh resolved, validated Chinese text ("" when absent)
   * @param {"original"|"zh"|"bilingual"} mode
   * @returns {{lang: "original"|"zh", text: string}[]} ordered, non-empty blocks
   */
  function localizedSegments(original, zh, mode) {
    const o = String(original || "").trim();
    const z = String(zh || "").trim();
    const resolvedMode = normalizeMode(mode);
    if (resolvedMode === "original") {
      return o ? [{ lang: "original", text: o }] : [];
    }
    if (resolvedMode === "zh") {
      if (z) return [{ lang: "zh", text: z }];
      return o ? [{ lang: "original", text: o }] : [];
    }
    // Bilingual: original then Chinese; a single block when they are identical
    // or when only one side exists.
    if (!o) return z ? [{ lang: "zh", text: z }] : [];
    if (!z || z === o) {
      return [{ lang: z && z === o ? "zh" : "original", text: o }];
    }
    return [
      { lang: "original", text: o },
      { lang: "zh", text: z },
    ];
  }

  /** Joins localized blocks into a plain string (used for copy/sort keys). */
  function localizedPlainText(original, zh, mode, separator = "\n") {
    return localizedSegments(original, zh, mode)
      .map((block) => block.text)
      .join(separator);
  }

  // ----------------------------------------------------------------
  // Filenames
  // ----------------------------------------------------------------

  const MODE_FILE_SUFFIX = {
    original: "original",
    zh: "zh",
    bilingual: "bilingual",
  };

  function isoDate(date = new Date()) {
    return new Date(date).toISOString().slice(0, 10);
  }

  /**
   * Produces a filesystem-safe base name from a title: strips control
   * characters and illegal path characters, collapses whitespace, and bounds
   * the length. Never returns an empty string.
   */
  function safeTitleSlug(title, fallback = "digestdock") {
    const cleaned = String(title || "")
      .normalize("NFC")
      .replace(CONTROL_CHARACTERS, " ")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
      .trim();
    return cleaned || fallback;
  }

  function transcriptExportFilename(title, mode) {
    const suffix = MODE_FILE_SUFFIX[normalizeMode(mode)];
    return `${safeTitleSlug(title)}-transcript-${suffix}.txt`;
  }

  function currentVideoNotesFilename(title, mode, { date } = {}) {
    const suffix = MODE_FILE_SUFFIX[normalizeMode(mode)];
    return `${safeTitleSlug(title)}-notes-${suffix}-${isoDate(date)}.txt`;
  }

  function allNotesFilename(mode, { date } = {}) {
    const suffix = MODE_FILE_SUFFIX[normalizeMode(mode)];
    return `digestdock-all-notes-${suffix}-${isoDate(date)}.txt`;
  }

  // ----------------------------------------------------------------
  // Document assembly. Input is a normalized "export source":
  //   {
  //     platform, canonicalUrl,
  //     titleOriginal, titleZh,
  //     channelName,
  //     descriptionOriginal, descriptionZh,
  //     transcriptOriginal: [{ start, text }],
  //     transcriptZh:       [{ start, text }],
  //     notes: [{ timestampSeconds, original, zh }],
  //   }
  // The caller (note-sources / side panel) resolves these from storage using
  // its own validated language logic; the builders below never call a provider.
  // ----------------------------------------------------------------

  const MODE_LABEL = {
    original: "原文",
    zh: "中文",
    bilingual: "双语",
  };

  const PLATFORM_LABEL = {
    youtube: "YouTube",
    bilibili: "B 站",
  };

  const LANG_HEADING = { original: "原文", zh: "中文" };

  function platformLabel(platform) {
    return PLATFORM_LABEL[platform] || "YouTube";
  }

  /** Normalizes inline text: canonical newlines, no control characters. */
  function inlineText(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(CONTROL_CHARACTERS, " ")
      .trim();
  }

  // ----------------------------------------------------------------
  // Plain-text notes documents. These builders intentionally use stricter
  // language semantics than localizedSegments(), whose fallback behavior is
  // retained for the on-screen UI. A Chinese
  // or bilingual export must never silently substitute original-language text
  // for a missing Chinese value.
  // ----------------------------------------------------------------

  function missingText(label) {
    return `（缺失：${label}）`;
  }

  function strictLocalizedValue(
    original,
    zh,
    mode,
    labels,
    { originalIsChinese = false } = {},
  ) {
    const resolvedMode = normalizeMode(mode);
    const originalText = inlineText(original);
    const zhText = inlineText(zh) || (originalIsChinese ? originalText : "");
    const originalLabel = labels?.original || "原文";
    const zhLabel = labels?.zh || "中文";
    if (resolvedMode === "original") {
      return originalText || missingText(originalLabel);
    }
    if (resolvedMode === "zh") {
      return zhText || missingText(zhLabel);
    }
    if (originalText && zhText && originalText === zhText) {
      return `中文：${zhText}`;
    }
    return [
      `原文：${originalText || missingText(originalLabel)}`,
      `中文：${zhText || missingText(zhLabel)}`,
    ].join("\n");
  }

  function strictDescriptionValue(source, mode, originalIsChinese) {
    const status = String(source?.descriptionStatus || "unknown");
    if (status === "confirmed-empty") return "（无简介）";
    let value = strictLocalizedValue(
      source?.descriptionOriginal,
      source?.descriptionZh,
      mode,
      { original: "原文视频简介", zh: "中文视频简介" },
      { originalIsChinese },
    );
    if (source?.descriptionTruncated) {
      value = `${value}\n〔资料不完整：简介已裁剪〕`;
    }
    return value;
  }

  /**
   * Builds one source as Markdown-free UTF-8 text. The caller may pass a
   * filtered source list to buildAllNotesText(); only those sources are ever
   * serialized.
   */
  function buildSourceText(source, mode) {
    const resolvedMode = normalizeMode(mode);
    const sourceLanguage = String(source?.sourceLanguage || "")
      .trim()
      .toLowerCase();
    const originalIsChinese =
      source?.platform === "bilibili" ||
      /^(?:zh|cmn|yue)(?:-|$)/.test(sourceLanguage);
    const lines = [];
    const title = strictLocalizedValue(
      source?.titleOriginal,
      source?.titleZh,
      resolvedMode,
      { original: "原文标题", zh: "中文标题" },
      { originalIsChinese },
    );
    if (resolvedMode === "bilingual") {
      lines.push("标题：");
      lines.push(title);
    } else {
      lines.push(`标题：${title}`);
    }
    lines.push(
      `频道：${inlineText(source?.channelName) || missingText("频道")}`,
      `网址：${inlineText(source?.canonicalUrl) || missingText("网址")}`,
      `平台：${platformLabel(source?.platform)}`,
      `语言：${MODE_LABEL[resolvedMode]}`,
      "",
      "视频简介：",
    );
    lines.push(
      strictDescriptionValue(source, resolvedMode, originalIsChinese),
      "",
      "笔记：",
    );

    const notes = sortNotesByTimecode(source?.notes || []);
    if (!notes.length) {
      lines.push("（无笔记）");
    } else {
      notes.forEach((note, index) => {
        if (index > 0) lines.push("");
        lines.push(`[${formatTimecode(note?.timestampSeconds)}]`);
        lines.push(
          strictLocalizedValue(note?.original, note?.zh, resolvedMode, {
            original: "原文笔记",
            zh: "中文笔记",
          }, { originalIsChinese }),
        );
      });
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  function buildCurrentVideoText(source, mode, { date } = {}) {
    const body = buildSourceText(source, mode).trimEnd();
    const exportedAt = new Date(date || Date.now()).toISOString();
    return `${body}\n导出时间：${exportedAt}\n`;
  }

  function buildAllNotesText(sources, mode, { date } = {}) {
    const resolvedMode = normalizeMode(mode);
    const selectedSources = Array.isArray(sources) ? sources : [];
    const lines = [
      "DigestDock 全部笔记",
      `语言：${MODE_LABEL[resolvedMode]}`,
      `导出时间：${new Date(date || Date.now()).toISOString()}`,
      `视频数量：${selectedSources.length}`,
    ];
    const divider = "=".repeat(60);
    selectedSources.forEach((source, index) => {
      lines.push(
        "",
        divider,
        `视频 ${index + 1} / ${selectedSources.length}`,
        divider,
        buildSourceText(source, resolvedMode).trimEnd(),
      );
    });
    return `${lines.join("\n").trimEnd()}\n`;
  }

  function localizedField(original, zh, mode) {
    const blocks = localizedSegments(original, zh, mode);
    if (mode === "bilingual" && blocks.length === 2) {
      return blocks
        .map((block) => `${LANG_HEADING[block.lang]}：${block.text}`)
        .join("\n\n");
    }
    return blocks.map((block) => block.text).join("\n\n");
  }

  function localizedTranscriptLines(source, mode) {
    const original = (
      Array.isArray(source?.transcriptOriginal)
        ? [...source.transcriptOriginal]
        : []
    ).sort((left, right) => (Number(left?.start) || 0) - (Number(right?.start) || 0));
    const zhByStart = new Map(
      (Array.isArray(source?.transcriptZh) ? source.transcriptZh : []).map(
        (entry) => [Number(entry?.start) || 0, String(entry?.text || "").trim()],
      ),
    );
    return original.map((entry) => {
      const start = Number(entry?.start) || 0;
      const stamp = formatTimecode(start);
      const originalText = String(entry?.text || "").trim();
      const zhText = zhByStart.get(start) || "";
      const blocks = localizedSegments(originalText, zhText, mode);
      if (mode === "bilingual" && blocks.length === 2) {
        return `- [${stamp}] ${blocks[0].text}\n  - ${blocks[1].text}`;
      }
      return `- [${stamp}] ${blocks.map((block) => block.text).join(" / ")}`;
    });
  }

  /**
   * Builds the UTF-8 TXT transcript download. Keeps the existing header block
   * (title / channel / url / description / language / time) followed by the
   * full, timecode-ordered transcript in the requested mode.
   */
  function buildTranscriptText(source, mode, { date } = {}) {
    const resolvedMode = normalizeMode(mode);
    const title =
      localizedPlainText(
        source?.titleOriginal,
        source?.titleZh,
        resolvedMode,
        " / ",
      ) || "Untitled Video";
    const lines = [];
    lines.push(title.replace(/\n/g, " "));
    lines.push("");
    if (String(source?.channelName || "").trim()) {
      lines.push(`频道：${inlineText(source.channelName)}`);
    }
    if (String(source?.canonicalUrl || "").trim()) {
      lines.push(`网址：${inlineText(source.canonicalUrl)}`);
    }
    lines.push(`平台：${platformLabel(source?.platform)}`);
    lines.push(`导出语言：${MODE_LABEL[resolvedMode]}`);
    lines.push(`导出时间：${new Date(date || Date.now()).toISOString()}`);
    const description = localizedField(
      source?.descriptionOriginal,
      source?.descriptionZh,
      resolvedMode,
    );
    if (description) {
      lines.push("");
      lines.push("视频简介：");
      lines.push(description);
    }
    lines.push("");
    lines.push("——— 字幕 ———");
    lines.push("");
    const transcriptLines = localizedTranscriptLines(source, resolvedMode).map(
      (line) => line.replace(/^- /, "").replace(/\n {2}- /, "\n    "),
    );
    lines.push(...(transcriptLines.length ? transcriptLines : ["（无字幕）"]));
    return `${lines.join("\n").trimEnd()}\n`;
  }

  return {
    MODES,
    formatTimecode,
    noteMediaGroupKey,
    sortNotesByTimecode,
    groupNotesBySource,
    sortNoteGroups,
    localizedSegments,
    localizedPlainText,
    safeTitleSlug,
    transcriptExportFilename,
    currentVideoNotesFilename,
    allNotesFilename,
    platformLabel,
    localizedTranscriptLines,
    buildSourceText,
    buildCurrentVideoText,
    buildAllNotesText,
    buildTranscriptText,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_NOTE_EXPORT;
}
