const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const reader = require("../manual-probe/reader.js");
const identity = require("../manual-probe/identity.js");

test("panel identity accepts the current watch-flexy fallback but rejects disagreement", () => {
  const videoId = "dQw4w9WgXcQ";
  assert.equal(
    identity.matches(videoId, { playerId: videoId, flexVideoId: null }),
    true,
  );
  assert.equal(
    identity.matches(videoId, { playerId: null, flexVideoId: videoId }),
    true,
  );
  assert.equal(
    identity.matches(videoId, { playerId: videoId, flexVideoId: videoId }),
    true,
  );
  assert.equal(
    identity.matches(videoId, {
      playerId: videoId,
      flexVideoId: "jNQXAC9IVRw",
    }),
    false,
  );
  assert.equal(identity.matches(videoId, {}), false);
});

test("manual panel reader parses timestamps and rejects malformed rows", () => {
  assert.equal(reader.parseTimestamp("1:02"), 62);
  assert.equal(reader.parseTimestamp("1:02:03"), 3723);
  assert.equal(reader.parseTimestamp("2:99"), null);
  assert.equal(reader.parseTimestamp("1:"), null);
  assert.equal(reader.parseTimestamp(":01"), null);
  assert.deepEqual(
    reader.normalizeRows([{ timestamp: "0:01", text: " First  line " }]),
    [{ timestamp: "0:01", start: 1, text: "First line" }],
  );
  assert.throws(
    () => reader.normalizeRows([{ timestamp: "bad", text: "invalid" }]),
    /row 0 is invalid/,
  );
});

test("manual panel reader supports the current transcript-segment-view-model shape", () => {
  const elements = new Map([
    [
      ".ytwTranscriptSegmentViewModelTimestamp:not(.ytwTranscriptSegmentViewModelTimestampA11yLabel)",
      { textContent: "0:18" },
    ],
    [
      "span.ytAttributedStringHost[role='text']",
      { textContent: "Current rendered transcript text" },
    ],
  ]);
  const row = {
    querySelector(selector) {
      return elements.get(selector) || null;
    },
  };
  assert.deepEqual(reader.readRow(row), {
    timestamp: "0:18",
    text: "Current rendered transcript text",
  });
  assert.deepEqual(reader.normalizeRows([reader.readRow(row)]), [
    {
      timestamp: "0:18",
      start: 18,
      text: "Current rendered transcript text",
    },
  ]);
});

test("panel row signatures change when a stale panel is replaced", () => {
  const oldRows = [{ timestamp: "0:01", start: 1, text: "Old" }];
  const newRows = [{ timestamp: "0:01", start: 1, text: "New" }];
  assert.notEqual(reader.rowSignature(oldRows), reader.rowSignature(newRows));
  assert.equal(reader.rowSignature(oldRows), reader.rowSignature(oldRows));
});

test("panel coverage rejects a jump from top to bottom with an unseen middle", () => {
  const gap = reader.coverageMetrics(
    [
      [0, 100],
      [900, 1000],
    ],
    1000,
  );
  assert.equal(gap.complete, false);
  assert.equal(gap.ranges.length, 2);

  const continuous = reader.coverageMetrics(
    [
      [0, 400],
      [396, 800],
      [796, 1000],
    ],
    1000,
  );
  assert.equal(continuous.complete, true);
  assert.deepEqual(continuous.ranges, [[0, 1000]]);
});

test("final result source preserves completion evidence in the popup summary", () => {
  const source = fs.readFileSync(
    path.join(root, "manual-probe", "reader.js"),
    "utf8",
  );
  assert.match(source, /visibleRowCount:\s*rows\.length/);
  assert.match(source, /collectedRowCount:\s*rows\.length/);
  assert.match(source, /sawTop:\s*active\.sawTop/);
  assert.match(source, /sawBottom:\s*active\.sawBottom/);
  assert.match(source, /collects:\s*active\.collects/);
});

test("manual panel probe has no code path that clicks or opens YouTube UI", () => {
  const source = ["reader.js", "popup.js"]
    .map((file) => fs.readFileSync(path.join(root, "manual-probe", file), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
  assert.match(source, /sawTop/);
  assert.match(source, /sawBottom/);
  assert.match(source, /CLOSE_PANEL_BEFORE_RESET/);
  assert.match(source, /PANEL_SCROLL_CONTAINER_UNKNOWN/);
  assert.doesNotMatch(source, /\|\|\s*panel\s*;/);
});

test("manual panel probe permissions remain narrow", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manual-probe", "manifest.json"), "utf8"),
  );
  assert.deepEqual([...manifest.permissions].sort(), ["scripting", "tabs"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.youtube.com/*"]);
});
