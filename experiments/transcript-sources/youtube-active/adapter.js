var YOUTUBE_ACTIVE_PROVIDER = (() => {
  const CONTRACT =
    typeof TRANSCRIPT_PROVIDER_CONTRACT !== "undefined"
      ? TRANSCRIPT_PROVIDER_CONTRACT
      : typeof require === "function"
        ? require("../shared/provider-contract.js")
        : null;
  const ROOT_ADAPTER =
    typeof YOUTUBE_TRANSCRIPT_ADAPTER !== "undefined"
      ? YOUTUBE_TRANSCRIPT_ADAPTER
      : typeof require === "function"
        ? require("./youtube-transcript.js")
        : null;

  function createAdapter({ youtubeAdapter = ROOT_ADAPTER, fetchImpl } = {}) {
    if (!CONTRACT || !youtubeAdapter?.fetchTranscript) {
      throw new Error("YouTube active provider dependencies are unavailable.");
    }

    async function fetchTranscript(input, context = {}) {
      const videoId = CONTRACT.assertVideoId(input?.videoId);
      const runId = CONTRACT.normalizeOpaqueId(input?.runId, "Run ID");
      const requestId = CONTRACT.normalizeOpaqueId(input?.requestId, "Request ID");
      const started = Date.now();
      const providerInitiated = {
        youtubePlayer: 0,
        youtubeTimedtext: 0,
        thirdParty: 0,
        loopback: 0,
      };
      const baseFetch = context.fetchImpl || fetchImpl || globalThis.fetch;
      const countedFetch = async (resource, init) => {
        let url;
        try {
          url = new URL(
            typeof resource === "string" || resource instanceof URL
              ? String(resource)
              : resource?.url,
          );
        } catch {
          url = null;
        }
        if (
          url?.hostname === "www.youtube.com" &&
          url.pathname === "/youtubei/v1/player"
        ) {
          providerInitiated.youtubePlayer += 1;
        } else if (
          url?.hostname === "www.youtube.com" &&
          url.pathname === "/api/timedtext"
        ) {
          providerInitiated.youtubeTimedtext += 1;
        }
        return baseFetch(resource, init);
      };
      try {
        const youtubeInput = {
          videoId,
          pagePlayability: context.pagePlayability || "",
          preferredLanguage: CONTRACT.normalizeLanguage(input?.preferredLanguage),
          kind: input?.trackKind || "manual-first",
        };
        if (Array.isArray(context.captionTracks)) {
          youtubeInput.captionTracks = context.captionTracks;
        }
        const result = await youtubeAdapter.fetchTranscript(
          youtubeInput,
          { fetchImpl: countedFetch },
        );
        return CONTRACT.createSuccessResult({
          providerId: "youtube-active",
          providerVariant: null,
          runId,
          requestId,
          videoId,
          language: result.language,
          languageEvidence: result.selectedTrack?.language ? "verified" : "inferred",
          selectedTrack: result.selectedTrack
            ? {
                language: result.selectedTrack.language,
                kind: result.selectedTrack.kind,
              }
            : null,
          transcript: result.transcript,
          elapsedMs: Date.now() - started,
          diagnostics: {
            sourceAttempt: result.sourceAttempt || "UNKNOWN",
            providerInitiated,
          },
        });
      } catch (error) {
        const code = CONTRACT.FAILURE_CODES.includes(error?.code)
          ? error.code
          : "INVALID_RESPONSE";
        return CONTRACT.createFailureResult({
          providerId: "youtube-active",
          providerVariant: null,
          runId,
          requestId,
          videoId,
          errorCode: code,
          message: "YouTube active provider failed.",
          elapsedMs: Date.now() - started,
          diagnostics: { providerInitiated },
        });
      }
    }

    return { fetchTranscript };
  }

  return { createAdapter };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YOUTUBE_ACTIVE_PROVIDER;
}
