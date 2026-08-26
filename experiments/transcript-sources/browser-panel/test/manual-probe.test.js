const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const reader = require("../manual-probe/reader.js");

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
