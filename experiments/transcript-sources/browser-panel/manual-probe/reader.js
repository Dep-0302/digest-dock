var PANEL_TRANSCRIPT_READER = (() => {
  const GLOBAL_KEY = "__DIGESTDOCK_PANEL_PROBE_V1__";
  const ROW_SELECTORS = [
    "ytd-transcript-segment-renderer",
    "transcript-segment-view-model",
    ".transcript-segment-view-model",
  ];

  function videoIdFromUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.hostname !== "www.youtube.com" || url.pathname !== "/watch") {
        return null;
      }
      const videoId = url.searchParams.get("v");
      return /^[0-9A-Za-z_-]{11}$/.test(videoId || "") ? videoId : null;
    } catch {
      return null;
    }
  }

  function parseTimestamp(value) {
    const text = String(value || "").trim();
    if (!/^\d+:[0-5]\d(?::[0-5]\d)?$/.test(text)) return null;
    const pieces = text.split(":").map(Number);
    return pieces.reduce((total, piece) => total * 60 + piece, 0);
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeRows(rows) {
    if (!Array.isArray(rows)) throw new TypeError("Panel rows must be an array.");
    return rows.map((row, index) => {
        const timestamp = normalizeText(row?.timestamp);
        const text = normalizeText(row?.text);
        const start = parseTimestamp(timestamp);
        if (start === null || !text) {
          throw new TypeError(`Panel row ${index} is invalid.`);
        }
        return { timestamp, start, text };
      });
  }

  function visible(element) {
    if (!element || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function findVisiblePanel() {
    const rowSelector = ROW_SELECTORS.join(",");
    return [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")]
      .filter(visible)
      .find((panel) => panel.querySelector(rowSelector)) || null;
  }

  function findScroller(panel) {
    const firstRow = panel.querySelector(ROW_SELECTORS.join(","));
    let ancestor = firstRow?.parentElement || null;
    while (ancestor && panel.contains(ancestor)) {
      const style = getComputedStyle(ancestor);
      if (
        ancestor.scrollHeight > ancestor.clientHeight + 4 &&
        /^(?:auto|scroll|overlay)$/.test(style.overflowY)
      ) {
        return ancestor;
      }
      if (ancestor === panel) break;
      ancestor = ancestor.parentElement;
    }
    const candidates = [
      panel.querySelector("#content"),
      panel.querySelector("#segments-container"),
      panel.querySelector("ytd-transcript-search-panel-renderer"),
    ].filter(Boolean);
    return (
      candidates.find(
        (candidate) => {
          const style = getComputedStyle(candidate);
          return (
            candidate.scrollHeight > candidate.clientHeight + 4 &&
            /^(?:auto|scroll|overlay)$/.test(style.overflowY)
          );
        },
      ) || null
    );
  }

  function readRow(row) {
    const timestamp =
      row.querySelector(
        ".ytwTranscriptSegmentViewModelTimestamp:not(.ytwTranscriptSegmentViewModelTimestampA11yLabel)",
      )?.textContent ||
      row.querySelector(".segment-timestamp")?.textContent ||
      row.querySelector("[class*='timestamp']")?.textContent ||
      row.querySelector("button")?.textContent ||
      "";
    const text =
      row.querySelector("span.ytAttributedStringHost[role='text']")?.textContent ||
      row.querySelector(".segment-text")?.textContent ||
      row.querySelector("[class*='segment-text']")?.textContent ||
      row.querySelector("yt-formatted-string")?.textContent ||
      "";
    return { timestamp, text };
  }

  function blankState({ generation = 0, previousSignature = null, awaitingReplacement = false } = {}) {
    return {
      videoId: null,
      rows: new Map(),
      sawTop: false,
      sawBottom: false,
      wasScrollable: false,
      coverageRanges: [],
      maxScrollHeight: 0,
      collects: 0,
      generation,
      previousSignature,
      lastVisibleSignature: null,
      awaitingReplacement,
      panelDisappeared: false,
    };
  }

  function rowSignature(rows) {
    let hash = 2166136261;
    for (const row of rows) {
      const value = `${row.start}:${row.text}|`;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${rows.length}:${(hash >>> 0).toString(16)}`;
  }

  function mergeCoverageRanges(ranges) {
    const ordered = (Array.isArray(ranges) ? ranges : [])
      .filter(
        (range) =>
          Array.isArray(range) &&
          range.length === 2 &&
          Number.isFinite(range[0]) &&
          Number.isFinite(range[1]) &&
          range[0] >= 0 &&
          range[1] >= range[0],
      )
      .sort((left, right) => left[0] - right[0]);
    const merged = [];
    for (const range of ordered) {
      const previous = merged.at(-1);
      if (!previous || range[0] > previous[1] + 4) {
        merged.push([...range]);
      } else {
        previous[1] = Math.max(previous[1], range[1]);
      }
    }
    return merged;
  }

  function coverageMetrics(ranges, scrollHeight) {
    const merged = mergeCoverageRanges(ranges);
    const height = Number(scrollHeight);
    if (!Number.isFinite(height) || height <= 0) {
      return { complete: false, ratio: 0, ranges: merged };
    }
    const covered = merged.reduce(
      (total, range) => total + Math.max(0, range[1] - range[0]),
      0,
    );
    return {
      complete:
        merged.length === 1 &&
        merged[0][0] <= 4 &&
        merged[0][1] >= height - 4,
      ratio: Math.min(1, covered / height),
      ranges: merged,
    };
  }

  function state() {
    if (!globalThis[GLOBAL_KEY]) {
      globalThis[GLOBAL_KEY] = blankState();
      window.addEventListener("yt-navigate-start", () => {
        const current = state();
        globalThis[GLOBAL_KEY] = blankState({
          generation: current.generation + 1,
          previousSignature:
            current.lastVisibleSignature || current.previousSignature,
          awaitingReplacement: Boolean(
            current.lastVisibleSignature || current.previousSignature,
          ),
        });
      });
    }
    return globalThis[GLOBAL_KEY];
  }

  function reset() {
    if (findVisiblePanel()) {
      return {
        ok: false,
        errorCode: "CLOSE_PANEL_BEFORE_RESET",
      };
    }
    const current = state();
    const previousSignature =
      current.lastVisibleSignature || current.previousSignature;
    globalThis[GLOBAL_KEY] = blankState({
      generation: current.generation + 1,
      previousSignature,
      awaitingReplacement: Boolean(previousSignature),
    });
    return {
      ok: true,
      requiresPanelReplacement: Boolean(previousSignature),
    };
  }

  function collect(expectedVideoId) {
    const currentVideoId = videoIdFromUrl(location.href);
    if (!currentVideoId || currentVideoId !== expectedVideoId) {
      return { ok: false, errorCode: "PAGE_CONTEXT_CHANGED" };
    }
    const panel = findVisiblePanel();
    if (!panel) {
      state().panelDisappeared = true;
      return { ok: false, errorCode: "PANEL_NOT_OPEN" };
    }
    const current = state();
    if (current.videoId && current.videoId !== currentVideoId) {
      globalThis[GLOBAL_KEY] = blankState({
        generation: current.generation + 1,
        previousSignature:
          current.lastVisibleSignature || current.previousSignature,
        awaitingReplacement: Boolean(
          current.lastVisibleSignature || current.previousSignature,
        ),
      });
    }
    const active = state();
    active.videoId = currentVideoId;
    let rows;
    try {
      rows = normalizeRows(
        [...panel.querySelectorAll(ROW_SELECTORS.join(","))].map(readRow),
      );
    } catch {
      return { ok: false, errorCode: "INVALID_RESPONSE" };
    }
    const signature = rowSignature(rows);
    if (
      active.awaitingReplacement &&
      !active.panelDisappeared &&
      signature === active.previousSignature
    ) {
      return {
        ok: false,
        errorCode: "PANEL_STALE",
        generation: active.generation,
      };
    }
    active.awaitingReplacement = false;
    active.lastVisibleSignature = signature;
    for (const row of rows) active.rows.set(`${row.start}:${row.text}`, row);
    const scroller = findScroller(panel);
    if (!scroller) {
      return {
        ok: false,
        errorCode: "PANEL_SCROLL_CONTAINER_UNKNOWN",
        generation: active.generation,
        collectedRowCount: active.rows.size,
      };
    }
    const atTop = scroller.scrollTop <= 4;
    const atBottom =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    const scrollable = scroller.scrollHeight > scroller.clientHeight + 4;
    active.sawTop ||= atTop;
    active.sawBottom ||= atBottom;
    active.wasScrollable ||= scrollable;
    active.maxScrollHeight = Math.max(active.maxScrollHeight, scroller.scrollHeight);
    active.coverageRanges = mergeCoverageRanges([
      ...active.coverageRanges,
      [
        Math.max(0, scroller.scrollTop),
        Math.min(
          scroller.scrollHeight,
          scroller.scrollTop + scroller.clientHeight,
        ),
      ],
    ]);
    active.collects += 1;
    const coverage = coverageMetrics(
      active.coverageRanges,
      active.maxScrollHeight,
    );
    return {
      ok: true,
      providerId: "youtube-panel",
      providerVariant: "manual-rendered-panel",
      videoId: currentVideoId,
      visibleRowCount: rows.length,
      collectedRowCount: active.rows.size,
      sawTop: active.sawTop,
      sawBottom: active.sawBottom,
      collects: active.collects,
      generation: active.generation,
      coverageRatio: coverage.ratio,
      completenessEvidence:
        active.sawTop &&
        active.sawBottom &&
        active.rows.size > 0 &&
        coverage.complete
          ? "manual-top-to-bottom"
          : "incomplete",
      complete:
        active.sawTop &&
        active.sawBottom &&
        active.rows.size > 0 &&
        coverage.complete,
      providerInitiated: {
        youtubePlayer: 0,
        youtubeTimedtext: 0,
        thirdParty: 0,
        loopback: 0,
      },
    };
  }

  function finalize(expectedVideoId) {
    const currentVideoId = videoIdFromUrl(location.href);
    const active = state();
    const coverage = coverageMetrics(
      active.coverageRanges,
      active.maxScrollHeight,
    );
    if (
      !currentVideoId ||
      currentVideoId !== expectedVideoId ||
      active.videoId !== expectedVideoId
    ) {
      return { ok: false, errorCode: "PAGE_CONTEXT_CHANGED" };
    }
    if (
      !(active.sawTop && active.sawBottom) ||
      !active.rows.size ||
      !coverage.complete
    ) {
      return {
        ok: false,
        errorCode: "PANEL_INCOMPLETE",
        providerId: "youtube-panel",
        providerVariant: "manual-rendered-panel",
        videoId: active.videoId,
        collectedRowCount: active.rows.size,
        sawTop: active.sawTop,
        sawBottom: active.sawBottom,
        coverageRatio: coverage.ratio,
        collects: active.collects,
        generation: active.generation,
        complete: false,
        completenessEvidence: "incomplete",
      };
    }
    const rows = [...active.rows.values()].sort((left, right) => left.start - right.start);
    return {
      ok: true,
      providerId: "youtube-panel",
      providerVariant: "manual-rendered-panel",
      videoId: expectedVideoId,
      visibleRowCount: rows.length,
      collectedRowCount: rows.length,
      sawTop: active.sawTop,
      sawBottom: active.sawBottom,
      complete: true,
      generation: active.generation,
      panelGeneration: active.generation,
      completenessEvidence: "manual-top-to-bottom",
      coverageRatio: coverage.ratio,
      rows,
      collects: active.collects,
      providerInitiated: {
        youtubePlayer: 0,
        youtubeTimedtext: 0,
        thirdParty: 0,
        loopback: 0,
      },
    };
  }

  return {
    videoIdFromUrl,
    parseTimestamp,
    normalizeRows,
    readRow,
    rowSignature,
    mergeCoverageRanges,
    coverageMetrics,
    collect,
    finalize,
    reset,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = PANEL_TRANSCRIPT_READER;
}
