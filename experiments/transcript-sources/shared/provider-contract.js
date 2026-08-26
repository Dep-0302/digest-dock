var TRANSCRIPT_PROVIDER_CONTRACT = (() => {
  const PROVIDER_IDS = Object.freeze([
    "youtube-passive",
    "youtube-active",
    "youtube-panel",
    "supadata-native",
    "node-libraries",
    "local-helper",
    "hosted-api-slot",
  ]);
  const PROVIDER_ID_SET = new Set(PROVIDER_IDS);
  const FAILURE_CODES = Object.freeze([
    "NO_TRANSCRIPT",
    "PROBE_FAILED",
    "NETWORK_ERROR",
    "RESPONSE_TOO_LARGE",
    "TRACK_UNAVAILABLE",
    "EMPTY_TRANSCRIPT",
    "RATE_LIMITED",
    "LOGIN_REQUIRED",
    "VIDEO_UNAVAILABLE",
    "PAGE_CONTEXT_CHANGED",
    "TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "CONSENT_REQUIRED",
    "DEPENDENCY_MISSING",
    "HELPER_UNAVAILABLE",
    "HELPER_UNAUTHORIZED",
    "HELPER_VERSION_MISMATCH",
    "PROVIDER_BUSY",
    "PROVIDER_UNAUTHORIZED",
    "INVALID_RESPONSE",
  ]);
  const FAILURE_CODE_SET = new Set(FAILURE_CODES);
  const MAX_SEGMENTS = 100_000;
  const MAX_TEXT_BYTES = 8 * 1024 * 1024;
  const ID_PATTERN = /^[0-9A-Za-z._:-]{1,80}$/;
  const LANGUAGE_EVIDENCE = new Set(["verified", "inferred", "unknown"]);
  const DIAGNOSTIC_NUMBER_KEYS = new Set([
    "requestsInitiated",
    "observedResponses",
    "httpStatus",
    "bodyBytes",
    "helperSchemaVersion",
    "segmentCount",
    "characterCount",
    "firstStart",
    "lastStart",
    "elapsedMs",
  ]);
  const DIAGNOSTIC_TOKEN_KEYS = new Set([
    "transport",
    "format",
    "trackKind",
    "endpointClass",
    "providerName",
    "sourceAttempt",
    "playability",
    "outcome",
    "errorCode",
  ]);
  const DIAGNOSTIC_COUNT_MAP_KEYS = new Set([
    "providerInitiated",
    "pageObserved",
    "networkCounts",
    "requestCounts",
  ]);
  const COUNT_MAP_KEYS = new Set([
    "youtubePlayer",
    "youtubeTimedtext",
    "thirdParty",
    "loopback",
    "player",
    "timedtext",
    "watchPage",
    "next",
    "getTranscript",
    "other",
  ]);
  const REPORT_CONTEXT_KEYS = new Set([
    "category",
    "caseId",
    "expectedOutcome",
    "runIndex",
  ]);

  function assertProviderId(value) {
    const providerId = String(value || "");
    if (!PROVIDER_ID_SET.has(providerId)) {
      throw new TypeError(`Unknown transcript provider: ${providerId || "<empty>"}`);
    }
    return providerId;
  }

  function assertVideoId(value) {
    const videoId = String(value || "").trim();
    if (!/^[0-9A-Za-z_-]{11}$/.test(videoId)) {
      throw new TypeError("A canonical 11-character YouTube video ID is required.");
    }
    return videoId;
  }

  function normalizeLanguage(value) {
    const language = String(value || "").trim().replace(/_/g, "-");
    return language && language.length <= 35 &&
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)
      ? language
      : null;
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeOpaqueId(value, label) {
    const normalized = String(value || "").trim();
    if (!ID_PATTERN.test(normalized)) {
      throw new TypeError(`${label} must be a bounded opaque ID.`);
    }
    return normalized;
  }

  function normalizeProviderVariant(value) {
    if (value === null || value === undefined || value === "") return null;
    return normalizeOpaqueId(value, "Provider variant");
  }

  function normalizeSegments(rows, language = null) {
    if (!Array.isArray(rows) || rows.length > MAX_SEGMENTS) {
      throw new TypeError("Transcript segments must be a bounded array.");
    }
    let bytes = 0;
    let previousStart = -Infinity;
    const normalized = rows.map((row, index) => {
        const text = normalizeText(row?.text);
        const start = Number(row?.start ?? row?.offsetSeconds ?? row?.offset);
        const duration = Number(
          row?.duration ?? row?.durationSeconds ?? row?.dur,
        );
        if (
          !text ||
          !Number.isFinite(start) ||
          !Number.isFinite(duration) ||
          start < 0 ||
          duration < 0
        ) {
          throw new TypeError(`Transcript segment ${index} is invalid.`);
        }
        if (start < previousStart) {
          throw new TypeError(`Transcript segment ${index} is out of order.`);
        }
        previousStart = start;
        bytes += utf8ByteLength(text);
        if (bytes > MAX_TEXT_BYTES) {
          throw new TypeError("Transcript text exceeded the experiment limit.");
        }
        return {
          text,
          start,
          duration,
          language: normalizeLanguage(row?.language) || language,
        };
      });
    return normalized;
  }

  function utf8ByteLength(value) {
    const text = String(value || "");
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text).byteLength;
    }
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
    return unescape(encodeURIComponent(text)).length;
  }

  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }

  function sanitizeMessage(value) {
    return String(value || "")
      .replace(/https?:\/\/[^\s"')]+/gi, "[redacted-url]")
      .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
      .slice(0, 500);
  }

  function sanitizeCountMap(value) {
    const output = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return output;
    for (const [key, item] of Object.entries(value)) {
      if (!COUNT_MAP_KEYS.has(key)) continue;
      if (item === null) {
        output[key] = null;
        continue;
      }
      const number = Number(item);
      if (Number.isFinite(number) && number >= 0) output[key] = number;
    }
    return output;
  }

  function sanitizeDiagnostics(value) {
    const output = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return output;
    for (const [key, item] of Object.entries(value)) {
      if (DIAGNOSTIC_NUMBER_KEYS.has(key)) {
        const number = Number(item);
        if (Number.isFinite(number) && number >= 0) output[key] = number;
        continue;
      }
      if (DIAGNOSTIC_TOKEN_KEYS.has(key)) {
        const token = String(item || "");
        if (/^[A-Za-z0-9._:-]{1,80}$/.test(token)) output[key] = token;
        continue;
      }
      if (DIAGNOSTIC_COUNT_MAP_KEYS.has(key)) {
        output[key] = sanitizeCountMap(item);
      }
    }
    return output;
  }

  function sanitizeReportContext(value) {
    const output = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return output;
    for (const [key, item] of Object.entries(value)) {
      if (!REPORT_CONTEXT_KEYS.has(key)) continue;
      if (key === "runIndex") {
        const number = Number(item);
        if (Number.isInteger(number) && number >= 0) output[key] = number;
      } else {
        const token = String(item || "");
        if (/^[A-Za-z0-9._:-]{1,80}$/.test(token)) output[key] = token;
      }
    }
    return output;
  }

  function normalizeElapsedMs(value) {
    const elapsedMs = Number(value);
    return Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.round(elapsedMs * 100) / 100
      : null;
  }

  function createSuccessResult({
    providerId,
    providerVariant = null,
    runId,
    requestId,
    videoId,
    language,
    languageEvidence,
    transcript,
    selectedTrack = null,
    elapsedMs,
    diagnostics = {},
  }) {
    const normalizedProviderId = assertProviderId(providerId);
    const normalizedProviderVariant = normalizeProviderVariant(providerVariant);
    const normalizedRunId = normalizeOpaqueId(runId, "Run ID");
    const normalizedRequestId = normalizeOpaqueId(requestId, "Request ID");
    const normalizedVideoId = assertVideoId(videoId);
    const normalizedLanguage = normalizeLanguage(language);
    const normalizedLanguageEvidence = String(languageEvidence || "");
    if (!LANGUAGE_EVIDENCE.has(normalizedLanguageEvidence)) {
      throw new TypeError("Language evidence must be verified, inferred, or unknown.");
    }
    if (!normalizedLanguage && normalizedLanguageEvidence !== "unknown") {
      throw new TypeError("Missing language can only have unknown evidence.");
    }
    const segments = normalizeSegments(transcript, normalizedLanguage);
    if (!segments.length) {
      throw new TypeError("A successful provider result requires usable segments.");
    }
    return {
      success: true,
      status: "success",
      providerId: normalizedProviderId,
      providerVariant: normalizedProviderVariant,
      runId: normalizedRunId,
      requestId: normalizedRequestId,
      videoId: normalizedVideoId,
      language: normalizedLanguage,
      languageEvidence: normalizedLanguageEvidence,
      selectedTrack:
        selectedTrack && typeof selectedTrack === "object"
          ? {
              language: normalizeLanguage(selectedTrack.language),
              kind: ["manual", "asr", "unknown"].includes(selectedTrack.kind)
                ? selectedTrack.kind
                : "unknown",
            }
          : null,
      transcript: segments,
      transcriptText: segments.map((segment) => segment.text).join(" "),
      transcriptTextTimestamped: segments
        .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`)
        .join("\n"),
      elapsedMs: normalizeElapsedMs(elapsedMs),
      diagnostics: sanitizeDiagnostics(diagnostics),
    };
  }

  function createFailureResult({
    providerId,
    providerVariant = null,
    runId,
    requestId,
    videoId,
    errorCode,
    message = "",
    elapsedMs,
    diagnostics = {},
  }) {
    const normalizedProviderId = assertProviderId(providerId);
    const normalizedProviderVariant = normalizeProviderVariant(providerVariant);
    const normalizedRunId = normalizeOpaqueId(runId, "Run ID");
    const normalizedRequestId = normalizeOpaqueId(requestId, "Request ID");
    const normalizedVideoId = assertVideoId(videoId);
    const normalizedErrorCode = String(errorCode || "INVALID_RESPONSE");
    if (!FAILURE_CODE_SET.has(normalizedErrorCode)) {
      throw new TypeError(`Unknown transcript failure code: ${normalizedErrorCode}`);
    }
    return {
      success: false,
      status: "failure",
      providerId: normalizedProviderId,
      providerVariant: normalizedProviderVariant,
      runId: normalizedRunId,
      requestId: normalizedRequestId,
      videoId: normalizedVideoId,
      errorCode: normalizedErrorCode,
      message: sanitizeMessage(message),
      elapsedMs: normalizeElapsedMs(elapsedMs),
      diagnostics: sanitizeDiagnostics(diagnostics),
    };
  }

  function assertSingleProviderSelection(selected) {
    const values = Array.isArray(selected) ? selected : [selected];
    const unique = [...new Set(values.filter(Boolean).map(assertProviderId))];
    if (unique.length !== 1) {
      throw new TypeError("A measured run must select exactly one provider.");
    }
    return unique[0];
  }

  function toSanitizedReport(result, context = {}) {
    const report = {
      schemaVersion: 2,
      providerId: assertProviderId(result?.providerId),
      providerVariant: normalizeProviderVariant(result?.providerVariant),
      runId: normalizeOpaqueId(result?.runId, "Run ID"),
      requestId: normalizeOpaqueId(result?.requestId, "Request ID"),
      videoId: assertVideoId(result?.videoId),
      status: result?.success === true ? "success" : "failure",
      elapsedMs: normalizeElapsedMs(result?.elapsedMs),
      language: normalizeLanguage(result?.language),
      languageEvidence: LANGUAGE_EVIDENCE.has(result?.languageEvidence)
        ? result.languageEvidence
        : "unknown",
      segmentCount: Array.isArray(result?.transcript)
        ? result.transcript.length
        : 0,
      errorCode:
        result?.success === true
          ? null
          : FAILURE_CODE_SET.has(result?.errorCode)
            ? result.errorCode
            : "INVALID_RESPONSE",
      diagnostics: sanitizeDiagnostics(result?.diagnostics || {}),
      context: sanitizeReportContext(context),
    };
    if (result?.success === true && result.transcript.length) {
      report.firstStart = result.transcript[0].start;
      report.lastStart = result.transcript.at(-1).start;
      report.characterCount = result.transcript.reduce(
        (sum, segment) => sum + String(segment.text || "").length,
        0,
      );
    }
    return report;
  }

  return {
    PROVIDER_IDS,
    FAILURE_CODES,
    MAX_SEGMENTS,
    MAX_TEXT_BYTES,
    assertProviderId,
    assertVideoId,
    normalizeLanguage,
    normalizeOpaqueId,
    normalizeProviderVariant,
    normalizeSegments,
    sanitizeDiagnostics,
    createSuccessResult,
    createFailureResult,
    assertSingleProviderSelection,
    toSanitizedReport,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = TRANSCRIPT_PROVIDER_CONTRACT;
}
