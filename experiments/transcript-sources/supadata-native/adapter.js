var SUPADATA_NATIVE_PROVIDER = (() => {
  const CONTRACT =
    typeof TRANSCRIPT_PROVIDER_CONTRACT !== "undefined"
      ? TRANSCRIPT_PROVIDER_CONTRACT
      : typeof require === "function"
        ? require("../shared/provider-contract.js")
        : null;
  const ENDPOINT = "https://api.supadata.ai/v1/transcript";
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

  function primaryLanguage(value) {
    return CONTRACT.normalizeLanguage(value)?.toLowerCase().split("-")[0] || "";
  }

  function parsePayload(payload) {
    const content = Array.isArray(payload?.content) ? payload.content : [];
    const language = CONTRACT.normalizeLanguage(
      payload?.lang || content.find((chunk) => chunk?.lang)?.lang,
    );
    return {
      language,
      segments: content.map((chunk) => ({
        text: chunk?.text,
        start: Number(chunk?.offset) / 1000,
        duration: Number(chunk?.duration) / 1000,
        language: CONTRACT.normalizeLanguage(chunk?.lang) || language,
      })),
    };
  }

  function createAdapter({ transport } = {}) {
    async function fetchTranscript(input, options = {}) {
      const videoId = CONTRACT.assertVideoId(input?.videoId);
      const runId = CONTRACT.normalizeOpaqueId(input?.runId, "Run ID");
      const requestId = CONTRACT.normalizeOpaqueId(input?.requestId, "Request ID");
      if (options.consent !== true) {
        return CONTRACT.createFailureResult({
          providerId: "supadata-native",
          providerVariant: "mode-native",
          runId,
          requestId,
          videoId,
          errorCode: "CONSENT_REQUIRED",
          message: "Supadata requires confirmation for this attempt.",
        });
      }
      if (typeof transport !== "function") {
        return CONTRACT.createFailureResult({
          providerId: "supadata-native",
          providerVariant: "mode-native",
          runId,
          requestId,
          videoId,
          errorCode: "PROVIDER_UNAVAILABLE",
          message: "Supadata transport is disabled in offline tests.",
        });
      }
      const url = new URL(ENDPOINT);
      url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
      url.searchParams.set("text", "false");
      url.searchParams.set("mode", "native");
      const language = CONTRACT.normalizeLanguage(input?.preferredLanguage);
      if (language) url.searchParams.set("lang", language);
      const started = Date.now();
      const controller = new AbortController();
      const externalSignal = options.signal;
      const abortFromExternal = () => controller.abort(externalSignal?.reason);
      if (externalSignal?.aborted) abortFromExternal();
      else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
      const timeoutMs = Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.min(120_000, options.timeoutMs))
        : 25_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await Promise.race([
          transport({
            endpoint: url.href,
            apiKey: options.apiKey,
            method: "GET",
            signal: controller.signal,
          }),
          new Promise((_, reject) =>
            controller.signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            ),
          ),
        ]);
      } catch (error) {
        return CONTRACT.createFailureResult({
          providerId: "supadata-native",
          providerVariant: "mode-native",
          runId,
          requestId,
          videoId,
          errorCode: error?.name === "AbortError" ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
          message:
            error?.name === "AbortError"
              ? "Supadata request timed out."
              : "Supadata transport was unavailable.",
          elapsedMs: Date.now() - started,
        });
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abortFromExternal);
      }
      if (
        Number.isFinite(response?.bodyBytes) &&
        response.bodyBytes > MAX_RESPONSE_BYTES
      ) {
        return CONTRACT.createFailureResult({
          providerId: "supadata-native",
          providerVariant: "mode-native",
          runId,
          requestId,
          videoId,
          errorCode: "INVALID_RESPONSE",
          message: "Supadata response exceeded the size limit.",
          elapsedMs: Date.now() - started,
        });
      }
      if (response?.status === 202) {
        return CONTRACT.createFailureResult({
          providerId: "supadata-native",
          providerVariant: "mode-native",
          runId,
          requestId,
          videoId,
          errorCode: "PROVIDER_BUSY",
          message: "Supadata returned an asynchronous job; use the production polling path.",
          elapsedMs: Date.now() - started,
        });
      }
      if (response?.status === 206) {
        return CONTRACT.createFailureResult({
          providerId: "supadata-native",
          providerVariant: "mode-native",
          runId,
          requestId,
          videoId,
          errorCode: "NO_TRANSCRIPT",
          message: "Supadata returned no native transcript.",
          elapsedMs: Date.now() - started,
          diagnostics: { httpStatus: 206 },
        });
      }
      if (!response?.ok) {
        const errorCode =
          response?.status === 404
            ? "NO_TRANSCRIPT"
            : response?.status === 429
              ? "RATE_LIMITED"
              : response?.status === 401
                ? "PROVIDER_UNAUTHORIZED"
                : "INVALID_RESPONSE";
        return CONTRACT.createFailureResult({
          providerId: "supadata-native",
          providerVariant: "mode-native",
          runId,
          requestId,
          videoId,
          errorCode,
          message: "Supadata native request failed.",
          elapsedMs: Date.now() - started,
          diagnostics: { httpStatus: response?.status || 0 },
        });
      }
      try {
        const parsed = parsePayload(response.body);
        if (
          language &&
          (!parsed.language || primaryLanguage(language) !== primaryLanguage(parsed.language))
        ) {
          return CONTRACT.createFailureResult({
            providerId: "supadata-native",
            providerVariant: "mode-native",
            runId,
            requestId,
            videoId,
            errorCode: "TRACK_UNAVAILABLE",
            message: "Supadata returned a different transcript language.",
            elapsedMs: Date.now() - started,
          });
        }
        return CONTRACT.createSuccessResult({
          providerId: "supadata-native",
          providerVariant: "mode-native",
          runId,
          requestId,
          videoId,
          language: parsed.language,
          languageEvidence: parsed.language ? "verified" : "unknown",
          transcript: parsed.segments,
          selectedTrack: {
            language: parsed.language,
            kind: "unknown",
          },
          elapsedMs: Date.now() - started,
          diagnostics: {
            providerInitiated: {
              youtubePlayer: 0,
              youtubeTimedtext: 0,
              thirdParty: 1,
              loopback: 0,
            },
            endpointClass: "hosted-transcript-api",
          },
        });
      } catch {
        return CONTRACT.createFailureResult({
          providerId: "supadata-native",
          providerVariant: "mode-native",
          runId,
          requestId,
          videoId,
          errorCode: "INVALID_RESPONSE",
          message: "Supadata returned an invalid native transcript.",
          elapsedMs: Date.now() - started,
        });
      }
    }

    return { fetchTranscript };
  }

  return { ENDPOINT, parsePayload, createAdapter };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = SUPADATA_NATIVE_PROVIDER;
}
