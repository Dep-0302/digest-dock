(function installDiagnosticsReadback(root, factory) {
  const api = factory();
  if (root) root.DIGESTDOCK_AUTO_READ_DIAGNOSTICS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  function safeToken(value, pattern, maxLength) {
    const token = String(value || "").trim().slice(0, maxLength);
    return token && pattern.test(token) ? token : null;
  }

  function safeCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? Math.floor(number)
      : 0;
  }

  function safeElapsed(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? Math.round(number)
      : null;
  }

  function safeStatus(value) {
    return safeToken(value, /^[A-Z0-9_]{1,80}$/, 80);
  }

  function safeOutcome(value) {
    return safeToken(value, /^[a-z0-9-]{1,80}$/, 80);
  }

  function safeLanguage(value) {
    return safeToken(
      value,
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/,
      35,
    );
  }

  function safeTrack(track) {
    if (!track || typeof track !== "object") return null;
    const language = safeLanguage(track.language);
    const kind = track.kind === "asr" ? "asr" : "manual";
    return language
      ? {
          language,
          kind,
          isGenerated: kind === "asr",
          isDefault: track.isDefault === true,
        }
      : null;
  }

  function safeRequests(value) {
    const requests = value && typeof value === "object" ? value : {};
    return {
      youtubePlayer: safeCount(requests.youtubePlayer),
      youtubeTimedtext: safeCount(requests.youtubeTimedtext),
      thirdParty: safeCount(requests.thirdParty),
      loopback: safeCount(requests.loopback),
    };
  }

  function safePlayer(value) {
    if (!value || typeof value !== "object") return null;
    return {
      status: safeCount(value.status),
      bytes: safeCount(value.bytes),
      elapsedMs: safeElapsed(value.elapsedMs),
    };
  }

  function safeFormat(value) {
    if (!value || typeof value !== "object") return null;
    return {
      format: safeToken(value.format, /^[a-z0-9-]{1,20}$/, 20),
      status: safeCount(value.status),
      bytes: safeCount(value.bytes),
      elapsedMs: safeElapsed(value.elapsedMs),
      error: safeStatus(value.error),
      segmentCount: safeCount(value.segmentCount),
    };
  }

  function project(result, fallback = {}) {
    const safeResult = result && typeof result === "object" ? result : {};
    const attempts = Array.isArray(safeResult?.diagnostics?.attempts)
      ? safeResult.diagnostics.attempts
      : [];
    const attempt = attempts[0] && typeof attempts[0] === "object"
      ? attempts[0]
      : null;
    const formats = Array.isArray(attempt?.formats) ? attempt.formats : [];
    const format = formats[0] && typeof formats[0] === "object"
      ? formats[0]
      : null;
    const transcriptCount = Array.isArray(safeResult.transcript)
      ? safeResult.transcript.length
      : 0;
    const safeFormatResult = safeFormat(format);

    return {
      status: safeStatus(safeResult.status) || "UNKNOWN",
      errorCode: safeStatus(safeResult.errorCode),
      videoId: safeToken(
        safeResult.videoId || fallback.videoId,
        /^[0-9A-Za-z_-]{11}$/,
        11,
      ),
      language: safeLanguage(safeResult.language || fallback.language),
      selectedTrack: safeTrack(safeResult.selectedTrack),
      requests: safeRequests(safeResult?.diagnostics?.providerInitiated),
      attempt: attempt
        ? {
            client: safeToken(attempt.client, /^[A-Z0-9_-]{1,80}$/, 80),
            outcome: safeOutcome(attempt.outcome),
            error: safeStatus(attempt.error),
            player: safePlayer(attempt.player),
            playability: safeStatus(attempt.playability),
            trackCount: safeCount(attempt.trackCount),
            selectedTrack: safeTrack(attempt.selectedTrack),
            format: safeFormatResult,
          }
        : null,
      captionBytes: safeFormatResult?.bytes || 0,
      segmentCount: Math.max(
        safeFormatResult?.segmentCount || 0,
        safeCount(transcriptCount),
      ),
    };
  }

  return Object.freeze({ apiVersion: 1, project });
});
