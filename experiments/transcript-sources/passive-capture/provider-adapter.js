var YOUTUBE_PASSIVE_PROVIDER = (() => {
  const CONTRACT =
    typeof TRANSCRIPT_PROVIDER_CONTRACT !== "undefined"
      ? TRANSCRIPT_PROVIDER_CONTRACT
      : typeof require === "function"
        ? require("../shared/provider-contract.js")
        : null;
  const PASSIVE_CORE =
    typeof PASSIVE_TRANSCRIPT_CORE !== "undefined"
      ? PASSIVE_TRANSCRIPT_CORE
      : typeof require === "function"
        ? require("./extension/core.js")
        : null;

  function createAdapter() {
    return async (request, context = {}) => {
      if (!context.capture) {
        return CONTRACT.createFailureResult({
          providerId: "youtube-passive",
          providerVariant: null,
          runId: request.runId,
          requestId: request.requestId,
          videoId: request.videoId,
          errorCode: "PROVIDER_UNAVAILABLE",
          message: "No passive timedtext response was observed for this run.",
          diagnostics: {
            providerInitiated: {
              youtubePlayer: 0,
              youtubeTimedtext: 0,
              thirdParty: 0,
              loopback: 0,
            },
            pageObserved: { youtubeTimedtext: 0 },
          },
        });
      }
      try {
        const normalized = PASSIVE_CORE.normalizeCapture(
          context.capture,
          request.videoId,
        );
        return CONTRACT.createSuccessResult({
          providerId: "youtube-passive",
          providerVariant: null,
          runId: request.runId,
          requestId: request.requestId,
          videoId: request.videoId,
          language: normalized.language,
          languageEvidence: normalized.language ? "inferred" : "unknown",
          transcript: normalized.transcript,
          selectedTrack: {
            language: normalized.language,
            kind: context.capture.kind === "asr" ? "asr" : "manual",
          },
          elapsedMs: context.elapsedMs,
          diagnostics: {
            ...normalized.diagnostics,
            providerInitiated: {
              youtubePlayer: 0,
              youtubeTimedtext: 0,
              thirdParty: 0,
              loopback: 0,
            },
            pageObserved: { youtubeTimedtext: 1 },
          },
        });
      } catch (error) {
        return CONTRACT.createFailureResult({
          providerId: "youtube-passive",
          providerVariant: null,
          runId: request.runId,
          requestId: request.requestId,
          videoId: request.videoId,
          errorCode: CONTRACT.FAILURE_CODES.includes(error?.code)
            ? error.code
            : "INVALID_RESPONSE",
          message: "Passive timedtext observation was unusable.",
          elapsedMs: context.elapsedMs,
          diagnostics: {
            providerInitiated: {
              youtubePlayer: 0,
              youtubeTimedtext: 0,
              thirdParty: 0,
              loopback: 0,
            },
            pageObserved: { youtubeTimedtext: 1 },
          },
        });
      }
    };
  }

  return { createAdapter };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YOUTUBE_PASSIVE_PROVIDER;
}
