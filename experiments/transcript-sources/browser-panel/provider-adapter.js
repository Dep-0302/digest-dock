var YOUTUBE_PANEL_PROVIDER = (() => {
  const CONTRACT =
    typeof TRANSCRIPT_PROVIDER_CONTRACT !== "undefined"
      ? TRANSCRIPT_PROVIDER_CONTRACT
      : typeof require === "function"
        ? require("../shared/provider-contract.js")
        : null;

  function parseTimestamp(value) {
    const text = String(value || "").trim();
    if (!/^\d+:[0-5]\d(?::[0-5]\d)?$/.test(text)) return null;
    const pieces = text.split(":").map(Number);
    return pieces.reduce((total, piece) => total * 60 + piece, 0);
  }

  function rowsToSegments(rows, language) {
    if (!Array.isArray(rows)) throw new TypeError("Panel rows must be an array.");
    return rows.map((row, index) => {
      const start = Number.isFinite(row?.start)
        ? row.start
        : parseTimestamp(row?.timestamp);
      if (start === null) {
        throw new TypeError(`Panel row ${index} has an invalid timestamp.`);
      }
      const next = rows[index + 1];
      const nextStart = next
        ? Number.isFinite(next.start)
          ? next.start
          : parseTimestamp(next.timestamp)
        : null;
      return {
        text: row?.text,
        start,
        duration:
          Number.isFinite(row?.duration) && row.duration >= 0
            ? row.duration
            : Number.isFinite(nextStart) && nextStart >= start
              ? nextStart - start
              : 0,
        language,
      };
    });
  }

  function fromPanelSnapshot(input) {
    const videoId = CONTRACT.assertVideoId(input?.videoId);
    const runId = CONTRACT.normalizeOpaqueId(input?.runId, "Run ID");
    const requestId = CONTRACT.normalizeOpaqueId(input?.requestId, "Request ID");
    if (input?.currentVideoId !== videoId || input?.panelVideoId !== videoId) {
      return CONTRACT.createFailureResult({
        providerId: "youtube-panel",
        providerVariant: "manual-rendered-panel",
        runId,
        requestId,
        videoId,
        errorCode: "PAGE_CONTEXT_CHANGED",
        message: "Rendered transcript panel belongs to another SPA video.",
      });
    }
    if (
      !Number.isInteger(input?.generation) ||
      input.panelGeneration !== input.generation
    ) {
      return CONTRACT.createFailureResult({
        providerId: "youtube-panel",
        providerVariant: "manual-rendered-panel",
        runId,
        requestId,
        videoId,
        errorCode: "PAGE_CONTEXT_CHANGED",
        message: "Rendered transcript panel generation is stale.",
      });
    }
    if (
      input?.complete !== true ||
      input.completenessEvidence !== "manual-top-to-bottom"
    ) {
      return CONTRACT.createFailureResult({
        providerId: "youtube-panel",
        providerVariant: "manual-rendered-panel",
        runId,
        requestId,
        videoId,
        errorCode: "INVALID_RESPONSE",
        message: "Visible panel rows were not proven to be the complete transcript.",
      });
    }
    const language = CONTRACT.normalizeLanguage(input?.language);
    return CONTRACT.createSuccessResult({
      providerId: "youtube-panel",
      providerVariant: "manual-rendered-panel",
      runId,
      requestId,
      videoId,
      language,
      languageEvidence: language ? "inferred" : "unknown",
      transcript: rowsToSegments(input.rows, language),
      elapsedMs: input.elapsedMs,
      diagnostics: {
        pageObserved: { youtubeTimedtext: Number(input.observedTimedtext || 0) },
        providerInitiated: {
          youtubePlayer: 0,
          youtubeTimedtext: 0,
          thirdParty: 0,
          loopback: 0,
        },
      },
    });
  }

  function createAdapter() {
    return async (request, context = {}) =>
      fromPanelSnapshot({
        ...context,
        runId: request.runId,
        requestId: request.requestId,
        videoId: request.videoId,
        language: request.preferredLanguage || context.language,
      });
  }

  return { parseTimestamp, rowsToSegments, fromPanelSnapshot, createAdapter };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YOUTUBE_PANEL_PROVIDER;
}
