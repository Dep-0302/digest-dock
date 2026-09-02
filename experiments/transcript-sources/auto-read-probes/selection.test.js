const test = require("node:test");
const assert = require("node:assert/strict");
const selection = require("./selection.js");

test("Chinese varieties are equal while human tracks beat ASR", () => {
  assert.deepEqual(selection.chooseAutoReadTrack([
    { language: "zh-Hans", kind: "asr" },
    { language: "zh-Hant", kind: "manual" },
    { language: "yue-HK", kind: "manual" },
    { language: "en", kind: "manual" },
  ]), {
    language: "zh-Hant",
    kind: "manual",
    index: 1,
  });
});

test("one visible language group chooses its human track", () => {
  assert.deepEqual(selection.chooseAutoReadTrack([
    { language: "en", kind: "asr" },
    { language: "en-US", kind: "manual" },
  ]), {
    language: "en-US",
    kind: "manual",
    index: 1,
  });
});

test("multiple non-Chinese languages remain ambiguous", () => {
  assert.equal(selection.chooseAutoReadTrack([
    { language: "en", kind: "manual" },
    { language: "de", kind: "manual" },
  ]), null);
});

test("invalid and empty track lists fail closed", () => {
  assert.equal(selection.chooseAutoReadTrack([]), null);
  assert.equal(selection.chooseAutoReadTrack([
    { language: "not a tag", kind: "manual" },
  ]), null);
});
