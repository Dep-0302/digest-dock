import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const contract = require("../../shared/provider-contract.js");

export function adaptCandidateResult({
  runId,
  requestId,
  candidate,
  videoId,
  language,
  languageEvidence = "unknown",
  timeUnitEvidence,
  segments,
  elapsedMs,
  requestCounts = {},
}) {
  if (timeUnitEvidence !== "seconds-verified") {
    throw new TypeError("Node candidate time units must be verified as seconds.");
  }
  if (candidate === "youtube-transcript" && timeUnitEvidence !== "seconds-verified") {
    throw new TypeError("youtube-transcript has branch-dependent time units.");
  }
  return contract.createSuccessResult({
    providerId: "node-libraries",
    providerVariant: candidate,
    runId,
    requestId,
    videoId,
    language,
    languageEvidence,
    transcript: segments.map((segment) => ({
      text: segment.text,
      start: segment.start ?? segment.offsetSeconds,
      duration: segment.duration ?? segment.durationSeconds,
      language,
    })),
    elapsedMs,
    diagnostics: { requestCounts },
  });
}

export function adaptCandidateFailure({
  runId,
  requestId,
  candidate,
  videoId,
  category,
  elapsedMs,
}) {
  const mapping = {
    timeout: "TIMEOUT",
    "rate-limited": "RATE_LIMITED",
    "language-unavailable": "TRACK_UNAVAILABLE",
    "no-caption": "NO_TRANSCRIPT",
    "video-unavailable": "VIDEO_UNAVAILABLE",
    "network-error": "PROVIDER_UNAVAILABLE",
  };
  return contract.createFailureResult({
    providerId: "node-libraries",
    providerVariant: candidate,
    runId,
    requestId,
    videoId,
    errorCode: mapping[category] || "INVALID_RESPONSE",
    message: "Node transcript candidate failed.",
    elapsedMs,
  });
}

export function toCandidateReport(result, context = {}) {
  return contract.toSanitizedReport(result, context);
}
