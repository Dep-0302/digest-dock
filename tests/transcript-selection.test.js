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

function fencedPromptSection(markdown, heading) {
  const headingIndex = markdown.indexOf(`## ${heading}`);
  assert.notEqual(headingIndex, -1, `missing ${heading} heading`);
  const fenceStart = markdown.indexOf("```", headingIndex);
  const contentStart = markdown.indexOf("\n", fenceStart) + 1;
  const fenceEnd = markdown.indexOf("\n```", contentStart);
  assert.ok(fenceStart >= headingIndex && contentStart > fenceStart);
  assert.ok(fenceEnd > contentStart, `missing ${heading} closing fence`);
  return markdown.slice(contentStart, fenceEnd);
}

function markdownSection(markdown, heading, nextHeading) {
  const sectionStart = markdown.indexOf(`## ${heading}`);
  const sectionEnd = markdown.indexOf(`## ${nextHeading}`, sectionStart + 1);
  assert.notEqual(sectionStart, -1, `missing ${heading} heading`);
  assert.ok(sectionEnd > sectionStart, `missing ${nextHeading} heading`);
  return markdown.slice(sectionStart, sectionEnd);
}

function loadTranscriptGrouping() {
  const sectionStart = source.indexOf("const TRANSCRIPT_SEGMENT_LIMITS");
  const sectionEnd = source.indexOf(
    "// INITIALIZATION",
    sectionStart,
  );
  assert.notEqual(sectionStart, -1, "missing transcript grouping section");
  assert.ok(
    sectionEnd > sectionStart,
    "missing transcript grouping section end",
  );
  const groupingSource = source.slice(sectionStart, sectionEnd);
  return Function(
    `${groupingSource}\nreturn { groupTranscriptEntries, transcriptEntrySeekSeconds, preserveTranscriptSourceCueStart };`,
  )();
}

test("English and Chinese cleanup prompts separately allow completion and forbid drift", () => {
  const englishSystemPrompt = fencedPromptSection(
    noteCleanupPrompt,
    "System prompt",
  );
  const chineseSystemPrompt = fencedPromptSection(
    noteCleanupPrompt,
    "Chinese system prompt",
  );
  const userPrompt = fencedPromptSection(noteCleanupPrompt, "User prompt");
  const variables = markdownSection(
    noteCleanupPrompt,
    "Variables",
    "Output format",
  );

  assert.match(
    englishSystemPrompt,
    /TARGET is mandatory and must remain the core of the note\./,
  );
  assert.match(
    englishSystemPrompt,
    /ALLOW COMPLETION:[^\n]*BEFORE, AFTER, and FULL CONTEXT[^\n]*same sentence or single thought[^\n]*regardless of how many transcript lines it spans\./,
  );
  assert.match(
    englishSystemPrompt,
    /FORBID DRIFT:[^\n]*independent neighboring sentence, claim, idea, or topic[^\n]*TARGET-containing sentence or thought\./,
  );
  assert.match(
    englishSystemPrompt,
    /Do NOT summarize, generalize,[\s\S]*?or add anything they did not say\./,
  );
  assert.match(
    chineseSystemPrompt,
    /TARGET 是必须保留的正文核心。[\s\S]*?不得因为邻近观点更完整、更有趣或更重要，就改选邻近观点。/,
  );
  assert.match(
    chineseSystemPrompt,
    /允许补全：[^\n]*BEFORE、AFTER 和 FULL CONTEXT[^\n]*同一句话或同一个完整观点[^\n]*无论[^\n]*跨多少行。/,
  );
  assert.match(
    chineseSystemPrompt,
    /禁止跑偏：[^\n]*独立相邻句子、观点或话题/,
  );
  assert.match(
    chineseSystemPrompt,
    /禁止总结、泛化、缩写观点、改写成“视频作者提到”等第三人称转述/,
  );
  assert.match(
    userPrompt,
    /FULL CONTEXT[^\n]*complete[^\n]*same sentence or thought[^\n]*TARGET/i,
  );
  assert.match(
    userPrompt,
    /never[^\n]*independent[^\n]*(?:nearby|neighboring) (?:idea|sentence|thought|topic)/i,
  );
  assert.doesNotMatch(userPrompt, /reference[ -]only|solely for boundaries/i);
  assert.match(
    variables,
    /\{fullContext\}[^\n]*complete[^\n]*same sentence or thought[^\n]*TARGET/i,
  );
  assert.doesNotMatch(variables, /reference[ -]only|solely for boundaries/i);
});

test("Chinese cleanup names concrete fillers, ASR repairs, and unpunctuated sentence recovery", () => {
  const chineseSystemPrompt = fencedPromptSection(
    noteCleanupPrompt,
    "Chinese system prompt",
  );

  for (const filler of [
    "就是",
    "然后",
    "那么",
    "这个",
    "那个",
    "其实",
    "对吧",
    "啊",
    "呃",
    "嗯",
  ]) {
    assert.match(chineseSystemPrompt, new RegExp(`“${filler}”`));
  }
  assert.match(chineseSystemPrompt, /重复词/);
  assert.match(chineseSystemPrompt, /口误重启/);
  assert.match(chineseSystemPrompt, /ASR[^\n]*同音字错误/);
  assert.match(
    chineseSystemPrompt,
    /为无标点的连续中文文本补出正确的中文标点与断句/,
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
  assert.equal(
    railWiring.filter(
      (wiring) => wiring === "attachTranscriptTimeSeek(div, seekSeconds)",
    ).length,
    2,
    "raw, translated-only, and bilingual rows must use the selected seek time on the time rail",
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

test("a sentence beginning inside an English cue uses its exact JSON3 word start", () => {
  const {
    groupTranscriptEntries,
    transcriptEntrySeekSeconds,
  } = loadTranscriptGrouping();
  const groups = groupTranscriptEntries([
    {
      start: 57.64,
      duration: 4.4,
      text: "First, because I wanted to sort of show",
    },
    {
      start: 60.24,
      duration: 5.04,
      text: "you something that I think we're",
    },
    {
      start: 62.04,
      duration: 6.12,
      text: "beginning to forget. The absence of AI",
      timingPoints: [
        { charIndex: 0, start: 62.04 },
        { charIndex: 10, start: 62.46 },
        { charIndex: 13, start: 62.96 },
        { charIndex: 21, start: 63.52 },
        { charIndex: 25, start: 64.14 },
      ],
    },
    {
      start: 65.28,
      duration: 5.56,
      text: "is not proof that something is genuine.",
    },
  ]);
  const secondSentence = groups.find((group) =>
    group.text.startsWith("The absence of AI"),
  );

  assert.ok(
    secondSentence,
    "the second sentence must remain independently seekable",
  );
  assert.ok(
    Math.abs(secondSentence.start - 65.261) < 0.002,
    `the estimated semantic start remains available, got ${secondSentence.start}`,
  );
  assert.ok(
    Math.abs(secondSentence.seekStart - 62.04) < 0.002,
    `the real source cue start must stay intact, got ${secondSentence.seekStart}`,
  );
  assert.ok(
    Math.abs(secondSentence.preciseSeekStart - 63.52) < 0.002,
    `expected provider timing at 63.52s, got ${secondSentence.preciseSeekStart}`,
  );
  assert.ok(
    Math.abs(transcriptEntrySeekSeconds(secondSentence, false) - 63.52) <
      0.002,
    "YouTube English display/seek must prefer the exact provider word start",
  );
  assert.ok(
    Math.abs(transcriptEntrySeekSeconds(secondSentence, true) - 62.04) <
      0.002,
    "Chinese and Bilibili paths must preserve the real source cue start",
  );
  assert.match(
    source,
    /const preserveSourceCueStart = preserveTranscriptSourceCueStart\([\s\S]*?const seekSeconds = transcriptEntrySeekSeconds\(\s*group,\s*preserveSourceCueStart,\s*\);[\s\S]*?transcriptTimeCellMarkup\(seekSeconds\)[\s\S]*?attachTranscriptTimeSeek\(div, seekSeconds\)/,
    "the visible time label and click handler must share one timestamp",
  );
});

test("only YouTube English uses semantic transcript seek starts", () => {
  const { preserveTranscriptSourceCueStart } = loadTranscriptGrouping();

  assert.equal(preserveTranscriptSourceCueStart("youtube", "en"), false);
  assert.equal(preserveTranscriptSourceCueStart("youtube", "en-US"), false);
  assert.equal(preserveTranscriptSourceCueStart("youtube", "es"), true);
  assert.equal(preserveTranscriptSourceCueStart("youtube", "ja"), true);
  assert.equal(preserveTranscriptSourceCueStart("youtube", "zh-CN"), true);
  assert.equal(preserveTranscriptSourceCueStart("bilibili", "en"), true);
});

test("invalid timing points fail closed to the existing English estimate", () => {
  const { groupTranscriptEntries, transcriptEntrySeekSeconds } =
    loadTranscriptGrouping();
  const groups = groupTranscriptEntries([
    {
      start: 57.64,
      duration: 4.4,
      text: "First, because I wanted to sort of show",
    },
    {
      start: 60.24,
      duration: 5.04,
      text: "you something that I think we're",
    },
    {
      start: 62.04,
      duration: 6.12,
      text: "beginning to forget. The absence of AI",
      timingPoints: [
        { charIndex: 0, start: 62.04 },
        { charIndex: 21, start: 70 },
      ],
    },
    {
      start: 65.28,
      duration: 5.56,
      text: "is not proof that something is genuine.",
    },
  ]);
  const secondSentence = groups.find((group) =>
    group.text.startsWith("The absence of AI"),
  );

  assert.ok(secondSentence);
  assert.equal(secondSentence.preciseSeekStart, undefined);
  assert.ok(
    Math.abs(transcriptEntrySeekSeconds(secondSentence, false) - 65.261) <
      0.002,
    "an invalid provider point must not override the established fallback",
  );
});

test("splitting one unpunctuated long Chinese cue keeps its real source seek start", () => {
  const { groupTranscriptEntries, transcriptEntrySeekSeconds } =
    loadTranscriptGrouping();
  const groups = groupTranscriptEntries([
    {
      start: 10,
      duration: 30,
      language: "zh-CN",
      text: "这".repeat(160),
    },
  ]);

  assert.ok(groups.length > 1, "the long cue must still be split for reading");
  assert.ok(
    groups.some((group) => group.start > 10),
    "visual pieces may retain estimated positions for playback highlighting",
  );
  assert.ok(
    groups.every((group) => group.seekStart === 10),
    "synthetic pieces must all seek to the only real source timestamp",
  );
  assert.ok(
    groups.every((group) => transcriptEntrySeekSeconds(group, true) === 10),
    "Chinese display and click must keep that source timestamp",
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
