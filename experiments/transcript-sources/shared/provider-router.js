var TRANSCRIPT_PROVIDER_ROUTER = (() => {
  const CONTRACT =
    typeof TRANSCRIPT_PROVIDER_CONTRACT !== "undefined"
      ? TRANSCRIPT_PROVIDER_CONTRACT
      : typeof require === "function"
        ? require("./provider-contract.js")
        : null;
  const TRACK_KINDS = new Set(["manual", "asr", "manual-first", "any"]);
  const CACHE_MODES = new Set(["bypass", "read-write"]);

  function normalizeRequest(input) {
    if (!CONTRACT) throw new Error("Transcript provider contract is unavailable.");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Provider request must be an object.");
    }
    if (input.schemaVersion !== 1) {
      throw new TypeError("Provider request schemaVersion must be 1.");
    }
    const providerId = CONTRACT.assertSingleProviderSelection([input.providerId]);
    const providerVariant = CONTRACT.normalizeProviderVariant(input.providerVariant);
    const runId = CONTRACT.normalizeOpaqueId(input.runId, "Run ID");
    const requestId = CONTRACT.normalizeOpaqueId(input.requestId, "Request ID");
    const videoId = CONTRACT.assertVideoId(input.videoId);
    const trackKind = String(input.trackKind || "manual-first");
    if (!TRACK_KINDS.has(trackKind)) {
      throw new TypeError("Provider request track kind is invalid.");
    }
    const cacheMode = String(input.cacheMode || "bypass");
    if (!CACHE_MODES.has(cacheMode)) {
      throw new TypeError("Provider request cache mode is invalid.");
    }
    return {
      schemaVersion: 1,
      providerId,
      providerVariant,
      runId,
      requestId,
      videoId,
      preferredLanguage: CONTRACT.normalizeLanguage(input.preferredLanguage),
      trackKind,
      cacheMode,
    };
  }

  function createRouter(adapters = {}) {
    const fixedAdapters = new Map();
    for (const [providerId, adapter] of Object.entries(adapters)) {
      CONTRACT.assertProviderId(providerId);
      if (typeof adapter !== "function") {
        throw new TypeError(`Adapter ${providerId} must be a function.`);
      }
      fixedAdapters.set(providerId, adapter);
    }

    async function dispatch(input, context = {}) {
      const request = normalizeRequest(input);
      const adapter = fixedAdapters.get(request.providerId);
      if (!adapter) {
        return CONTRACT.createFailureResult({
          providerId: request.providerId,
          providerVariant: request.providerVariant,
          runId: request.runId,
          requestId: request.requestId,
          videoId: request.videoId,
          errorCode: "PROVIDER_UNAVAILABLE",
          message: "Selected provider has no experiment adapter.",
        });
      }

      let result;
      try {
        result = await adapter(request, context);
      } catch {
        return CONTRACT.createFailureResult({
          providerId: request.providerId,
          providerVariant: request.providerVariant,
          runId: request.runId,
          requestId: request.requestId,
          videoId: request.videoId,
          errorCode: "INVALID_RESPONSE",
          message: "Selected provider adapter threw an exception.",
        });
      }

      if (
        !result ||
        result.providerId !== request.providerId ||
        result.providerVariant !== request.providerVariant ||
        result.runId !== request.runId ||
        result.requestId !== request.requestId ||
        result.videoId !== request.videoId
      ) {
        return CONTRACT.createFailureResult({
          providerId: request.providerId,
          providerVariant: request.providerVariant,
          runId: request.runId,
          requestId: request.requestId,
          videoId: request.videoId,
          errorCode: "INVALID_RESPONSE",
          message: "Provider response identity did not match the measured run.",
        });
      }
      try {
        if (result.success === true) {
          return CONTRACT.createSuccessResult({
            providerId: request.providerId,
            providerVariant: request.providerVariant,
            runId: request.runId,
            requestId: request.requestId,
            videoId: request.videoId,
            language: result.language,
            languageEvidence: result.languageEvidence,
            transcript: result.transcript,
            selectedTrack: result.selectedTrack,
            elapsedMs: result.elapsedMs,
            diagnostics: result.diagnostics,
          });
        }
        return CONTRACT.createFailureResult({
          providerId: request.providerId,
          providerVariant: request.providerVariant,
          runId: request.runId,
          requestId: request.requestId,
          videoId: request.videoId,
          errorCode: result.errorCode,
          message: result.message,
          elapsedMs: result.elapsedMs,
          diagnostics: result.diagnostics,
        });
      } catch {
        return CONTRACT.createFailureResult({
          providerId: request.providerId,
          providerVariant: request.providerVariant,
          runId: request.runId,
          requestId: request.requestId,
          videoId: request.videoId,
          errorCode: "INVALID_RESPONSE",
          message: "Provider result failed shared-contract validation.",
        });
      }
    }

    return { dispatch, providerIds: Object.freeze([...fixedAdapters.keys()]) };
  }

  return { normalizeRequest, createRouter };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = TRANSCRIPT_PROVIDER_ROUTER;
}
