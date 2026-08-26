const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const core = require("../manual-probe/core.js");

test("manual probe normalizes a native fixture without rounding timestamps", () => {
  const normalized = core.normalizePayload(
    {
      lang: "en",
      content: [{ text: "Fixture", offset: 1250, duration: 500, lang: "en" }],
    },
    "en-US",
  );
  assert.equal(normalized.transcript[0].start, 1.25);
  assert.equal(normalized.transcript[0].duration, 0.5);
});

test("manual probe rejects language mismatch, empty, and malformed order", () => {
  assert.throws(
    () => core.normalizePayload({ lang: "fr", content: [{ text: "x", offset: 0, duration: 1 }] }, "en"),
    /TRACK_UNAVAILABLE/,
  );
  assert.throws(() => core.normalizePayload({ lang: "en", content: [] }), /EMPTY_TRANSCRIPT/);
  assert.throws(
    () =>
      core.normalizePayload({
        lang: "en",
        content: [
          { text: "later", offset: 2000, duration: 1000 },
          { text: "earlier", offset: 1000, duration: 1000 },
        ],
      }),
    /INVALID_RESPONSE/,
  );
});

test("manual probe never stores or puts the key in the request URL", () => {
  const popup = fs.readFileSync(path.join(root, "manual-probe", "popup.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "manual-probe", "probe.html"), "utf8");
  const launcher = fs.readFileSync(
    path.join(root, "manual-probe", "launcher.js"),
    "utf8",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manual-probe", "manifest.json"), "utf8"),
  );
  assert.match(html, /type="password"/);
  assert.match(html, /本次使用 Supadata/);
  assert.doesNotMatch(popup, /chrome\.storage/);
  assert.match(popup, /headers: \{ "x-api-key": apiKey \}/);
  assert.doesNotMatch(popup, /searchParams\.set\([^,]+,\s*apiKey/);
  assert.match(popup, /response\.status === 429[^]*RATE_LIMITED/);
  assert.deepEqual([...manifest.permissions].sort(), ["scripting", "tabs"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://api.supadata.ai/*",
    "https://www.youtube.com/*",
  ]);
  assert.match(launcher, /chrome\.tabs\.create/);
  assert.match(launcher, /probe\.html/);
  assert.match(popup, /lastAccessed/);
  assert.doesNotMatch(popup, /active: true, currentWindow: true/);
});
