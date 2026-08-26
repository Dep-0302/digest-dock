const contract = require("./provider-contract.js");

const STATUS_VALUES = new Set(["success", "failure"]);
const NOTE_VALUES = new Set([
  "clean-success",
  "expected-negative",
  "unexpected-empty",
  "rate-limited",
  "spa-stale-rejected",
  "manual-review-needed",
  "provider-unavailable",
]);
const CHECK_KEYS = [
  "firstTimestampCompared",
  "lastTimestampCompared",
  "sampleTextComparedWithoutSavingText",
  "spaSecondVideoRejectedOldResult",
];
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "runId",
  "requestId",
  "startedAt",
  "providerId",
  "providerVariant",
  "videoId",
  "category",
  "status",
  "elapsedMs",
  "language",
  "languageEvidence",
  "segmentCount",
  "characterCount",
  "firstStart",
  "lastStart",
  "errorCode",
  "diagnostics",
  "manualChecks",
  "notes",
]);

function finiteOrNull(value, label) {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative number or null.`);
  }
  return number;
}

function validateManualRun(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Manual result must be an object.");
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new TypeError(`Manual result contains unknown field: ${key}`);
    }
  }
  if (input.schemaVersion !== 2) {
    throw new TypeError("Manual result schemaVersion must be 2.");
  }
  const startedAt = String(input.startedAt || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(startedAt)) {
    throw new TypeError("Manual result startedAt must be an ISO UTC timestamp.");
  }
  const status = String(input.status || "");
  if (!STATUS_VALUES.has(status)) throw new TypeError("Manual result status is invalid.");
  const languageEvidence = String(input.languageEvidence || "");
  if (!["verified", "inferred", "unknown"].includes(languageEvidence)) {
    throw new TypeError("Manual language evidence is invalid.");
  }
  const diagnostics = contract.sanitizeDiagnostics(input.diagnostics || {});
  if (JSON.stringify(diagnostics) !== JSON.stringify(input.diagnostics || {})) {
    throw new TypeError("Manual diagnostics contain non-whitelisted fields.");
  }
  if (
    !input.manualChecks ||
    typeof input.manualChecks !== "object" ||
    Array.isArray(input.manualChecks) ||
    Object.keys(input.manualChecks).some((key) => !CHECK_KEYS.includes(key)) ||
    CHECK_KEYS.some((key) => typeof input.manualChecks[key] !== "boolean")
  ) {
    throw new TypeError("Manual checks must contain the four fixed booleans.");
  }
  const notes = Array.isArray(input.notes) ? input.notes : [];
  if (notes.some((note) => !NOTE_VALUES.has(note))) {
    throw new TypeError("Manual notes must use categorical values only.");
  }
  const language = contract.normalizeLanguage(input.language);
  if (!language && languageEvidence !== "unknown") {
    throw new TypeError("Missing manual language can only have unknown evidence.");
  }
  const segmentCount = finiteOrNull(input.segmentCount, "Segment count") || 0;
  if (status === "success" && segmentCount === 0) {
    throw new TypeError("Successful manual result requires at least one segment.");
  }
  return {
    schemaVersion: 2,
    runId: contract.normalizeOpaqueId(input.runId, "Run ID"),
    requestId: contract.normalizeOpaqueId(input.requestId, "Request ID"),
    startedAt,
    providerId: contract.assertProviderId(input.providerId),
    providerVariant: contract.normalizeProviderVariant(input.providerVariant),
    videoId: contract.assertVideoId(input.videoId),
    category: contract.normalizeOpaqueId(input.category, "Category"),
    status,
    elapsedMs: finiteOrNull(input.elapsedMs, "Elapsed time"),
    language,
    languageEvidence,
    segmentCount,
    characterCount: finiteOrNull(input.characterCount, "Character count") || 0,
    firstStart: finiteOrNull(input.firstStart, "First start"),
    lastStart: finiteOrNull(input.lastStart, "Last start"),
    errorCode:
      status === "success"
        ? null
        : contract.FAILURE_CODES.includes(input.errorCode)
          ? input.errorCode
          : "INVALID_RESPONSE",
    diagnostics,
    manualChecks: Object.fromEntries(
      CHECK_KEYS.map((key) => [key, input.manualChecks[key]]),
    ),
    notes: [...notes],
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeManualRuns(inputs) {
  const groups = new Map();
  for (const run of inputs.map(validateManualRun)) {
    const key = `${run.providerId}:${run.providerVariant || "default"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups.entries()]
    .map(([key, runs]) => {
      const [providerId, variant] = key.split(":");
      const initiated = {
        youtubePlayer: null,
        youtubeTimedtext: null,
        thirdParty: null,
        loopback: null,
      };
      for (const run of runs) {
        const counts = run.diagnostics.providerInitiated || {};
        for (const field of Object.keys(initiated)) {
          if (counts[field] === null || counts[field] === undefined) continue;
          if (initiated[field] === null) initiated[field] = 0;
          initiated[field] += Number(counts[field]);
        }
      }
      return {
        providerId,
        providerVariant: variant === "default" ? null : variant,
        runs: runs.length,
        successes: runs.filter((run) => run.status === "success").length,
        failures: runs.filter((run) => run.status === "failure").length,
        medianElapsedMs: median(runs.map((run) => run.elapsedMs)),
        initiated,
        errorCodes: [
          ...new Set(runs.map((run) => run.errorCode).filter(Boolean)),
        ].sort(),
      };
    })
    .sort((left, right) =>
      `${left.providerId}:${left.providerVariant || ""}`.localeCompare(
        `${right.providerId}:${right.providerVariant || ""}`,
      ),
    );
}

module.exports = { validateManualRun, summarizeManualRuns };
