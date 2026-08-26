const fs = require("node:fs");
const path = require("node:path");

const verifier = require("./verifier.js");

const cases = [
  {
    id: "manual-english-short",
    url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    language: "en",
    mode: "manual",
    expected: "transcript",
  },
  {
    id: "automatic-english-long",
    url: "https://www.youtube.com/watch?v=KLDVxx4TqcE",
    language: "en",
    mode: "asr",
    expected: "transcript",
  },
  {
    id: "spoken-no-caption",
    url: "https://www.youtube.com/watch?v=4OEG33NfEK0",
    language: "en",
    mode: "manual-first",
    expected: "NO_TRANSCRIPT",
  },
];

async function runCase(testCase) {
  const started = Date.now();
  try {
    const result = await verifier.verifyVideo(testCase.url, {
      language: testCase.language,
      mode: testCase.mode,
    });
    return {
      id: testCase.id,
      expected: testCase.expected,
      elapsedMs: Date.now() - started,
      observed: "transcript",
      expectationMet: testCase.expected === "transcript",
      diagnostics: result.diagnostics,
    };
  } catch (error) {
    const diagnostics = verifier.diagnosticsFromError(error);
    return {
      id: testCase.id,
      expected: testCase.expected,
      elapsedMs: Date.now() - started,
      observed: diagnostics.error.code,
      expectationMet: testCase.expected === diagnostics.error.code,
      diagnostics,
    };
  }
}

(async () => {
  const results = [];
  for (const testCase of cases) {
    process.stdout.write(`Running ${testCase.id}...\n`);
    results.push(await runCase(testCase));
  }
  const payload = {
    schemaVersion: 1,
    runAt: new Date().toISOString(),
    environment: {
      runtime: process.version,
      surface: "Node baseline only; not an MV3/browser result",
      apiKey: false,
      cookies: false,
      proxyConfiguredByHarness: false,
    },
    cases: results,
  };
  const outputDir = path.join(__dirname, "results");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "node-baseline.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      Object.fromEntries(results.map((item) => [item.id, item.observed])),
      null,
      2,
    ),
  );
})();
