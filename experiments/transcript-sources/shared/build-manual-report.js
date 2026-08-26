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
  `Runs: ${inputs.length}`,
  "",
  "| Provider | Variant | Runs | Success | Failure | Median ms | Initiated requests | Errors |",
  "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
];
for (const row of summary) {
  const counts = Object.entries(row.initiated)
    .map(([key, value]) => `${key}=${value ?? "unknown"}`)
    .join(", ");
  lines.push(
    `| ${row.providerId} | ${row.providerVariant || "default"} | ${row.runs} | ${row.successes} | ${row.failures} | ${row.medianElapsedMs ?? "n/a"} | ${counts} | ${row.errorCodes.join(", ") || "none"} |`,
  );
}
lines.push(
  "",
  "This report contains no transcript text, signed URL, key, token, header, cookie, or job ID.",
  "",
);
const output = path.join(resultsDirectory, "REPORT.md");
fs.writeFileSync(output, lines.join("\n"));
console.log(`Wrote ${output}`);
