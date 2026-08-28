const fs = require("node:fs");
const path = require("node:path");

const { summarizeManualRuns } = require("./manual-results.js");

const root = path.resolve(__dirname, "..");
const resultsDirectory = path.join(root, "manual-results");
const files = fs.existsSync(resultsDirectory)
  ? fs
      .readdirSync(resultsDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort()
  : [];
if (!files.length) {
  console.log("No manual result JSON files found in manual-results/.");
  process.exit(0);
}
const inputs = files.map((name) =>
  JSON.parse(fs.readFileSync(path.join(resultsDirectory, name), "utf8")),
);
const summary = summarizeManualRuns(inputs);
const lines = [
  "# Seven-provider manual transcript report",
  "",
  `Runs: ${inputs.length} (all ${inputs.length} JSON records currently present in this directory)`,
  "",
  "| Provider | Variant | Runs | Success | Expected negative | Unexpected failure | Median ms (measured/runs) | Initiated requests | Expected-negative codes | Unexpected errors |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
];
for (const row of summary) {
  const matching = inputs.filter(
    (input) =>
      input.providerId === row.providerId &&
      (input.providerVariant || null) === (row.providerVariant || null),
  );
  const expectedNegativeRuns = matching.filter(
    (input) =>
      input.status === "failure" &&
      Array.isArray(input.notes) &&
      input.notes.includes("expected-negative"),
  );
  const unexpectedFailureRuns = matching.filter(
    (input) => input.status === "failure" && !expectedNegativeRuns.includes(input),
  );
  const measuredElapsedCount = matching.filter(
    (input) => Number.isFinite(input.elapsedMs),
  ).length;
  const medianElapsed =
    row.medianElapsedMs === null || row.medianElapsedMs === undefined
      ? "n/a"
      : row.medianElapsedMs;
  const counts = Object.entries(row.initiated)
    .map(([key, value]) => `${key}=${value ?? "unknown"}`)
    .join(", ");
  lines.push(
    `| ${row.providerId} | ${row.providerVariant || "default"} | ${row.runs} | ${row.successes} | ${expectedNegativeRuns.length} | ${unexpectedFailureRuns.length} | ${medianElapsed} (${measuredElapsedCount}/${row.runs}) | ${counts} | ${[...new Set(expectedNegativeRuns.map((input) => input.errorCode).filter(Boolean))].join(", ") || "none"} | ${[...new Set(unexpectedFailureRuns.map((input) => input.errorCode).filter(Boolean))].join(", ") || "none"} |`,
  );
}
lines.push(
  "",
  "`Expected negative` means the JSON record is marked `expected-negative`; these",
  "are correct boundary results, not provider failures. The two `PROBE_FAILED`",
  "records are kept as unexpected run failures that now serve as rejected-transport",
  "evidence for the two popup-origin variants; neither is pending further research.",
  "`Median ms (measured/runs)` reports the median only over receipts that contain",
  "a numeric elapsed time and always discloses that measured denominator.",
  "",
  "## Source coverage",
  "",
  ...files.map((name) => `- \`${name}\``),
  "",
  "This report contains no transcript text, signed URL, key, token, header, cookie,",
  "or job ID.",
  "",
);
const output = path.join(resultsDirectory, "REPORT.md");
fs.writeFileSync(output, lines.join("\n"));
console.log(`Wrote ${output}`);
