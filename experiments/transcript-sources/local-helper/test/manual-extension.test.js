const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("manual helper extension has only exact loopback access", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"),
  );
  assert.deepEqual([...manifest.permissions].sort(), ["scripting", "tabs"]);
  assert.deepEqual(manifest.host_permissions, [
    "http://127.0.0.1/*",
    "https://www.youtube.com/*",
  ]);
});

test("manual helper extension keeps token in a header and out of storage and URLs", () => {
  const source = fs.readFileSync(
    path.join(root, "extension", "popup.js"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(root, "extension", "probe.html"),
    "utf8",
  );
  const launcher = fs.readFileSync(
    path.join(root, "extension", "launcher.js"),
    "utf8",
  );
  assert.match(html, /type="password"/);
  assert.doesNotMatch(source, /chrome\.storage/);
  assert.match(source, /"X-DigestDock-Helper-Token": token/);
  assert.doesNotMatch(source, /searchParams\.set\([^,]+,\s*token/);
  assert.match(source, /credentials: "omit"/);
  assert.match(source, /http:\/\/127\.0\.0\.1:8765\/v1\/transcript/);
  assert.match(source, /http:\/\/127\.0\.0\.1:8765\/health/);
  assert.match(html, /0 次 YouTube 请求/);
  assert.match(source, /lastAccessed/);
  assert.doesNotMatch(source, /active: true, currentWindow: true/);
  assert.match(launcher, /chrome\.tabs\.create/);
  assert.match(launcher, /probe\.html/);
});
