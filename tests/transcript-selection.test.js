const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "sidepanel.js"),
  "utf8",
);

test("only the time rail seeks; the transcript body stays selectable text", () => {
  assert.match(
    source,
    /function hasNonCollapsedTextSelection\(\)[\s\S]*?selection\.rangeCount > 0 && !selection\.isCollapsed/,
  );
  assert.match(
    source,
    /function seekFromTranscriptEntryClick\(event, seconds\)[\s\S]*?if \(hasNonCollapsedTextSelection\(\)\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?seekTo\(seconds\);/,
  );

  // The time code is the only seek target and is a keyboard-focusable button.
  assert.match(
    source,
    /function transcriptTimeCellMarkup\(seconds\)[\s\S]*?class="transcript-time" role="button" tabindex="0"/,
  );

  // Seek handlers bind to the .transcript-time rail only, never to the row div
  // or the selectable body text.
  assert.match(
    source,
    /function attachTranscriptTimeSeek\(cardEl, seconds\) \{[\s\S]*?const timeEl = cardEl\.querySelector\("\.transcript-time"\);[\s\S]*?timeEl\.addEventListener\("click", \(event\) =>\s+seekFromTranscriptEntryClick\(event, seconds\),\s+\);[\s\S]*?timeEl\.addEventListener\("keydown", \(event\) =>\s+seekFromTranscriptTimeKey\(event, seconds\),\s+\);/,
  );

  const railWiring = source.match(/attachTranscriptTimeSeek\(div, [^)]+\)/g) || [];
  assert.ok(
    railWiring.includes("attachTranscriptTimeSeek(div, group.start)"),
    "raw transcript rows must wire seek onto the time rail",
  );
  assert.ok(
    railWiring.includes("attachTranscriptTimeSeek(div, segment.start)"),
    "translated-only and bilingual rows must wire seek onto the time rail",
  );

  // The whole-row seek handlers (guarded or not) must be gone: the body text
  // never triggers playback.
  assert.doesNotMatch(
    source,
    /div\.addEventListener\("click", \(event\) =>\s+seekFromTranscriptEntryClick\(event, (?:group|segment)\.start\),/,
  );
  assert.doesNotMatch(
    source,
    /div\.addEventListener\("click", \(\) => seekTo\((?:group|segment)\.start\)\);/,
  );
});

test("the Explain tooltip preserves selection and contains pointer events", () => {
  assert.match(
    source,
    /tooltip\.addEventListener\("mousedown", \(event\) => \{\s+event\.preventDefault\(\);\s+event\.stopPropagation\(\);/,
  );
  assert.match(
    source,
    /tooltip\.addEventListener\("mouseup", \(event\) => \{\s+event\.stopPropagation\(\);/,
  );
  assert.match(
    source,
    /\.addEventListener\("click", async \(event\) => \{\s+event\.preventDefault\(\);\s+event\.stopPropagation\(\);/,
  );
});
