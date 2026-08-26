var LOCAL_TRANSCRIPT_HELPER_CLIENT = (() => {
  const CONTRACT =
    typeof TRANSCRIPT_PROVIDER_CONTRACT !== "undefined"
      ? TRANSCRIPT_PROVIDER_CONTRACT
      : typeof require === "function"
        ? require("../shared/provider-contract.js")
        : null;

  function validateLoopbackOrigin(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      throw new TypeError("Local helper origin is invalid.");
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("Local helper must use an exact 127.0.0.1 HTTP origin.");
    }
    return url.origin;
  }

  function validateToken(value) {
    const token = String(value || "");
    if (token.length < 32 || token.length > 256 || /\s/.test(token)) {
      throw new TypeError("Local helper pairing token must be 32-256 non-space characters.");
    }
    return token;
  }

  function createClient({ origin, token, fetchImpl = globalThis.fetch }) {
    if (!CONTRACT) throw new Error("Transcript provider contract is unavailable.");
    const fixedOrigin = validateLoopbackOrigin(origin);
    const pairingToken = validateToken(token);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }

    async function fetchTranscript(input, options = {}) {
      const providerId = CONTRACT.assertSingleProviderSelection([
        input?.providerId || "local-helper",
      ]);
      if (providerId !== "local-helper") {
        throw new TypeError("Local helper client received another provider ID.");
      }
      const videoId = CONTRACT.assertVideoId(input?.videoId);
      const requestId = CONTRACT.normalizeOpaqueId(
        input?.requestId || "manual-request",
        "Request ID",
      );
      const runId = CONTRACT.normalizeOpaqueId(
        input?.runId || requestId,
        "Run ID",
      );
      const trackKind = input?.trackKind || "manual-first";
      if (!["manual", "asr", "manual-first", "any"].includes(trackKind)) {
        throw new TypeError("Local helper track kind is invalid.");
      }
      const controller = new AbortController();
      const externalSignal = options.signal;
      const abortFromExternal = () => controller.abort(externalSignal?.reason);
      if (externalSignal?.aborted) abortFromExternal();
      else externalSignal?.addEventListener("abort", abortFromExternal, {
        once: true,
      });
      const timeoutMs = Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.min(60_000, options.timeoutMs))
        : 25_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      try {
        const response = await Promise.race([
          fetchImpl(`${fixedOrigin}/v1/transcript`, {
            method: "POST",
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json",
              "X-DigestDock-Helper-Token": pairingToken,
            },
            body: JSON.stringify({
              schemaVersion: 1,
              providerId: "local-helper",
              providerVariant: "youtube-transcript-api",
              runId,
              requestId,
              videoId,
              preferredLanguage:
                CONTRACT.normalizeLanguage(input?.preferredLanguage) || null,
              trackKind,
            }),
            signal: controller.signal,
          }),
          new Promise((_, reject) =>
            controller.signal.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                ),
              { once: true },
            ),
          ),
        ]);
        let payload;
        try {
          payload = await response.json();
        } catch {
          return CONTRACT.createFailureResult({
            providerId: "local-helper",
            providerVariant: "youtube-transcript-api",
            runId,
            requestId,
            videoId,
            errorCode: "INVALID_RESPONSE",
            message: "Local helper returned invalid JSON.",
            elapsedMs: Date.now() - started,
          });
        }
        if (!response.ok || payload?.ok !== true) {
          const reportedCode = CONTRACT.FAILURE_CODES.includes(payload?.errorCode)
            ? payload.errorCode
            : null;
          const code =
            reportedCode ||
            (response.status === 401 || response.status === 403
              ? "HELPER_UNAUTHORIZED"
              : response.status === 429
                ? "PROVIDER_BUSY"
                : "HELPER_UNAVAILABLE");
          return CONTRACT.createFailureResult({
            providerId: "local-helper",
            providerVariant: "youtube-transcript-api",
            runId,
            requestId,
            videoId,
            errorCode: CONTRACT.FAILURE_CODES.includes(code)
              ? code
              : "HELPER_UNAVAILABLE",
            message: payload?.message || "Local helper request failed.",
            elapsedMs: Date.now() - started,
            diagnostics: { httpStatus: response.status },
          });
        }
        if (
          payload.schemaVersion !== 1 ||
          payload.providerId !== "local-helper" ||
          payload.providerVariant !== "youtube-transcript-api" ||
          payload.runId !== runId ||
          payload.requestId !== requestId ||
          payload.videoId !== videoId
        ) {
          return CONTRACT.createFailureResult({
            providerId: "local-helper",
            providerVariant: "youtube-transcript-api",
            runId,
            requestId,
            videoId,
            errorCode: "INVALID_RESPONSE",
            message: "Local helper response identity did not match the request.",
            elapsedMs: Date.now() - started,
          });
        }
        return CONTRACT.createSuccessResult({
          providerId: "local-helper",
          providerVariant: "youtube-transcript-api",
          runId,
          requestId,
          videoId,
          language: payload.language,
          languageEvidence: payload.language ? "verified" : "unknown",
          transcript: payload.segments,
          selectedTrack: payload.selectedTrack,
          elapsedMs: Date.now() - started,
          diagnostics: {
            helperSchemaVersion: payload.schemaVersion,
            endpointClass: "loopback-helper",
            providerInitiated: { loopback: 1 },
          },
        });
      } catch (error) {
        const timedOut = error?.name === "AbortError";
        return CONTRACT.createFailureResult({
          providerId: "local-helper",
          providerVariant: "youtube-transcript-api",
          runId,
          requestId,
          videoId,
          errorCode: timedOut ? "TIMEOUT" : "HELPER_UNAVAILABLE",
          message: timedOut
            ? "Local helper request timed out."
            : "Local helper could not be reached.",
          elapsedMs: Date.now() - started,
        });
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abortFromExternal);
      }
    }

    return { fetchTranscript };
  }

  return { validateLoopbackOrigin, validateToken, createClient };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LOCAL_TRANSCRIPT_HELPER_CLIENT;
}
