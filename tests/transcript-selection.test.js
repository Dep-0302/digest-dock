const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "sidepanel.js"),
  "utf8",
);
const contentSource = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);
const noteCleanupPrompt = fs.readFileSync(
  path.resolve(__dirname, "..", "prompts", "note-cleanup.md"),
  "utf8",
);

test("note cleanup keeps TARGET central and treats wider context as reference only", () => {
  assert.match(
    noteCleanupPrompt,
    /TARGET is mandatory and must remain the core of the note\./,
  );
  assert.match(
    noteCleanupPrompt,
    /Use BEFORE and AFTER only when needed to finish that same sentence or thought\./,
  );
  assert.match(
    noteCleanupPrompt,
    /FULL CONTEXT is reference-only\.[\s\S]*?Never copy an independent claim from FULL CONTEXT into the note\./,
  );
  assert.match(
    noteCleanupPrompt,
    /Do NOT summarize, generalize,[\s\S]*?or add anything they did not say\./,
  );
  assert.match(
    noteCleanupPrompt,
    /TARGET 是必须保留的正文核心。[\s\S]*?不得因为邻近观点更完整、更有趣或更重要，就改选邻近观点。/,
  );
  assert.match(
    noteCleanupPrompt,
    /FULL CONTEXT 只供判断句界、消解指代和校正人名、机构名等专有名词；不得从中抽取独立观点写入笔记。/,
  );
  assert.match(
    noteCleanupPrompt,
    /禁止总结、泛化、缩写观点、改写成“视频作者提到”等第三人称转述/,
  );
});

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
    railWiring.includes(
      "attachTranscriptTimeSeek(div, group.seekStart ?? group.start)",
    ),
    "raw transcript rows must wire seek onto the time rail",
  );
  assert.ok(
    railWiring.includes(
      "attachTranscriptTimeSeek(div, segment.seekStart ?? segment.start)",
    ),
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

test("timestamp seeks use the exact route and require a real player success", () => {
  assert.match(
    source,
    /async function seekTo\(seconds\)[\s\S]*?action: "relayToContent"[\s\S]*?expectedRouteKey: currentRouteKey/,
  );
  assert.match(
    source,
    /async function seekTo\(seconds\)[\s\S]*?result\?\.success === true && result\.response\?\.success === true/,
  );
  assert.doesNotMatch(
    source,
    /async function seekTo\(seconds\)[\s\S]*?chrome\.tabs\.sendMessage/,
  );
  assert.match(
    contentSource,
    /message\.action === "seekTo"[\s\S]*?sendResponse\(\{ success: seekToTimestamp\(message\.seconds\) \}\)/,
  );
  assert.match(
    contentSource,
    /function seekToTimestamp\(seconds\)[\s\S]*?if \(!video\)[\s\S]*?return false[\s\S]*?video\.currentTime = seconds[\s\S]*?return true/,
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
