const test = require("node:test");
const assert = require("node:assert/strict");

global.TRANSCRIPT_PROVIDER_CONTRACT = require("../../shared/provider-contract.js");
const panel = require("../provider-adapter.js");

function snapshot(overrides = {}) {
  return {
    runId: "panel-run",
    requestId: "panel-request",
    videoId: "jNQXAC9IVRw",
    currentVideoId: "jNQXAC9IVRw",
    panelVideoId: "jNQXAC9IVRw",
    language: "en",
    generation: 3,
    panelGeneration: 3,
    complete: true,
    completenessEvidence: "manual-top-to-bottom",
    rows: [
      { timestamp: "0:01", text: "First" },
      { timestamp: "1:02", text: "Second" },
    ],
    ...overrides,
  };
}

test("panel timestamps support MM:SS and HH:MM:SS", () => {
  assert.equal(panel.parseTimestamp("1:02"), 62);
  assert.equal(panel.parseTimestamp("1:02:03"), 3723);
  assert.equal(panel.parseTimestamp("1:99"), null);
  assert.equal(panel.parseTimestamp("1:"), null);
  assert.equal(panel.parseTimestamp(":01"), null);
});

test("a complete current-video snapshot maps to the shared contract", () => {
  const result = panel.fromPanelSnapshot(snapshot());
  assert.equal(result.success, true);
  assert.equal(result.providerId, "youtube-panel");
  assert.equal(result.providerVariant, "manual-rendered-panel");
  assert.equal(result.transcript[0].duration, 61);
});

test("stale SPA identity and partial virtualization fail closed", () => {
  assert.equal(
    panel.fromPanelSnapshot(snapshot({ panelVideoId: "dQw4w9WgXcQ" })).errorCode,
    "PAGE_CONTEXT_CHANGED",
  );
  assert.equal(
    panel.fromPanelSnapshot(snapshot({ complete: false })).errorCode,
    "INVALID_RESPONSE",
  );
  assert.equal(
    panel.fromPanelSnapshot(snapshot({ panelGeneration: 2 })).errorCode,
    "PAGE_CONTEXT_CHANGED",
  );
});
