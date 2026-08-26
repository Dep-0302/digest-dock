var HOSTED_TRANSCRIPT_API_SLOT = (() => {
  const CONTRACT =
    typeof TRANSCRIPT_PROVIDER_CONTRACT !== "undefined"
      ? TRANSCRIPT_PROVIDER_CONTRACT
      : typeof require === "function"
        ? require("../shared/provider-contract.js")
        : null;
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

  function primaryLanguage(value) {
    return CONTRACT.normalizeLanguage(value)?.toLowerCase().split("-")[0] || "";
  }

  function validateDescriptor(descriptor) {
    if (!descriptor) return null;
    let endpoint;
    try {
      endpoint = new URL(String(descriptor.exactEndpoint || ""));
    } catch {
      throw new TypeError("Hosted provider descriptor requires an exact endpoint.");
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.pathname ||
      endpoint.pathname === "/"
    ) {
      throw new TypeError("Hosted provider endpoint must be one exact HTTPS path.");
    }
    if (
      typeof descriptor.buildRequest !== "function" ||
      typeof descriptor.parseResponse !== "function"
    ) {
      throw new TypeError("Hosted provider descriptor requires request and response adapters.");
    }
    return {
      providerName: CONTRACT.normalizeProviderVariant(
        descriptor.providerName || "unselected",
      ),
      exactEndpoint: endpoint.href,
      buildRequest: descriptor.buildRequest,
      parseResponse: descriptor.parseResponse,
      mapError:
        typeof descriptor.mapError === "function"
          ? descriptor.mapError
          : () => "INVALID_RESPONSE",
    };
  }

  function createAdapter(descriptor, { transport } = {}) {
    if (!CONTRACT) throw new Error("Transcript provider contract is unavailable.");
    const fixed = validateDescriptor(descriptor);

    async function fetchTranscript(input, options = {}) {
      const videoId = CONTRACT.assertVideoId(input?.videoId);
      const requestId = CONTRACT.normalizeOpaqueId(
        input?.requestId || "manual-request",
        "Request ID",
      );
      const runId = CONTRACT.normalizeOpaqueId(
        input?.runId || requestId,
        "Run ID",
      );
      if (!fixed) {
        return CONTRACT.createFailureResult({
          providerId: "hosted-api-slot",
          providerVariant: null,
          runId,
          requestId,
          videoId,
          errorCode: "PROVIDER_UNAVAILABLE",
          message: "No hosted transcript provider has been selected.",
        });
      }
      if (options.consent !== true) {
        return CONTRACT.createFailureResult({
          providerId: "hosted-api-slot",
          providerVariant: fixed.providerName,
          runId,
          requestId,
          videoId,
          errorCode: "CONSENT_REQUIRED",
          message: "This hosted provider requires confirmation for this attempt.",
        });
      }
      if (typeof transport !== "function") {
        return CONTRACT.createFailureResult({
          providerId: "hosted-api-slot",
          providerVariant: fixed.providerName,
          runId,
          requestId,
          videoId,
          errorCode: "PROVIDER_UNAVAILABLE",
          message: "Hosted provider transport is disabled in fixture-only mode.",
        });
      }
      const started = Date.now();
      const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
      let request;
      try {
        request = fixed.buildRequest({
          videoId,
          canonicalUrl,
          preferredLanguage: CONTRACT.normalizeLanguage(input?.preferredLanguage),
        });
      } catch {
        return CONTRACT.createFailureResult({
          providerId: "hosted-api-slot",
          providerVariant: fixed.providerName,
          runId,
          requestId,
          videoId,
          errorCode: "INVALID_RESPONSE",
          message: "Hosted provider request adapter failed.",
        });
      }
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
          transport(fixed.exactEndpoint, { ...request, signal: controller.signal }),
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
          providerId: "hosted-api-slot",
          providerVariant: fixed.providerName,
          runId,
          requestId,
          videoId,
          errorCode: error?.name === "AbortError" ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
          message:
            error?.name === "AbortError"
              ? "Hosted provider request timed out."
              : "Hosted provider transport was unavailable.",
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
          providerId: "hosted-api-slot",
          providerVariant: fixed.providerName,
          runId,
          requestId,
          videoId,
          errorCode: "INVALID_RESPONSE",
          message: "Hosted provider response exceeded the size limit.",
          elapsedMs: Date.now() - started,
        });
      }
      try {
        if (!response?.ok) {
          const mapped = fixed.mapError(response);
          const errorCode = CONTRACT.FAILURE_CODES.includes(mapped)
            ? mapped
            : response?.status === 429
              ? "RATE_LIMITED"
              : "INVALID_RESPONSE";
          return CONTRACT.createFailureResult({
            providerId: "hosted-api-slot",
            providerVariant: fixed.providerName,
            runId,
            requestId,
            videoId,
            errorCode,
            message: "Hosted transcript provider request failed.",
            elapsedMs: Date.now() - started,
            diagnostics: { httpStatus: response?.status || null },
          });
        }
        const parsed = fixed.parseResponse(response.body);
        const requestedLanguage = CONTRACT.normalizeLanguage(input?.preferredLanguage);
        const parsedLanguage = CONTRACT.normalizeLanguage(parsed.language);
        if (
          requestedLanguage &&
          (!parsedLanguage || primaryLanguage(requestedLanguage) !== primaryLanguage(parsedLanguage))
        ) {
          return CONTRACT.createFailureResult({
            providerId: "hosted-api-slot",
            providerVariant: fixed.providerName,
            runId,
            requestId,
            videoId,
            errorCode: "TRACK_UNAVAILABLE",
            message: "Hosted provider returned a different transcript language.",
            elapsedMs: Date.now() - started,
          });
        }
        return CONTRACT.createSuccessResult({
          providerId: "hosted-api-slot",
          providerVariant: fixed.providerName,
          runId,
          requestId,
          videoId,
          language: parsedLanguage,
          languageEvidence:
            parsed.languageEvidence === "verified"
              ? "verified"
              : parsedLanguage
                ? "inferred"
                : "unknown",
          transcript: parsed.segments,
          elapsedMs: Date.now() - started,
          diagnostics: {
            providerName: fixed.providerName,
            endpointClass: "hosted-transcript-api",
            providerInitiated: { thirdParty: 1 },
          },
        });
      } catch {
        return CONTRACT.createFailureResult({
          providerId: "hosted-api-slot",
          providerVariant: fixed.providerName,
          runId,
          requestId,
          videoId,
          errorCode: "INVALID_RESPONSE",
          message: "Hosted provider returned an invalid response.",
          elapsedMs: Date.now() - started,
        });
      }
    }

    return { fetchTranscript };
  }

  return { validateDescriptor, createAdapter };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = HOSTED_TRANSCRIPT_API_SLOT;
}
