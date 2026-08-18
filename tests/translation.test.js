const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const bilibiliAdapter = require("../bilibili.js");

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
    BILIBILI_ADAPTER: bilibiliAdapter,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  storageGetImpl,
  storageSetImpl = async () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get:
            storageGetImpl ||
            (async () => ({ ytd_settings: settings })),
          set: storageSetImpl,
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
    },
    BILIBILI_ADAPTER: bilibiliAdapter,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fireActive(delay) {
      const match = [...timers.entries()].find(
        ([, timer]) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match[1].active = false;
      match[1].callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && timer.delay === delay,
      ).length;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
  };
}

function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

const encode = (value) => new TextEncoder().encode(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("Header exposes tab-specific transcript, overview, and notes language modes", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");
  const headerStart = html.indexOf('<div class="header-top">');
  const tabsStart = html.indexOf('<div class="tabs"');
  const controlStart = html.indexOf('id="transcriptModeControl"');
  const overviewControlStart = html.indexOf('id="overviewModeControl"');
  const notesControlStart = html.indexOf('id="notesModeControl"');
  const settingsStart = html.indexOf('id="settingsBtn"');
  const resultsStart = html.indexOf('id="resultsState"');

  assert.ok(headerStart >= 0);
  assert.ok(controlStart > headerStart && controlStart < tabsStart);
  assert.ok(overviewControlStart > controlStart && overviewControlStart < tabsStart);
  assert.ok(notesControlStart > overviewControlStart && notesControlStart < tabsStart);
  assert.ok(settingsStart > notesControlStart && settingsStart < tabsStart);
  assert.ok(controlStart < resultsStart, "mode control must live outside scrolling results");
  assert.match(html, /id="transcriptModeControl"[\s\S]*?hidden/);
  assert.match(html, /id="overviewModeControl"[\s\S]*?hidden/);
  assert.match(html, /id="notesModeControl"[\s\S]*?hidden/);
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>原文</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(html, /data-overview-mode="en"[\s\S]*?aria-pressed="false"[\s\S]*?>英文</);
  assert.match(html, /data-overview-mode="zh"[\s\S]*?aria-pressed="false"[\s\S]*?>中文</);
  assert.match(html, /data-overview-mode="bilingual"[\s\S]*?aria-pressed="true"[\s\S]*?>双语</);
  assert.match(html, /data-notes-mode="original"[\s\S]*?>原文</);
  assert.match(html, /data-notes-mode="zh"[\s\S]*?>中文</);
  assert.match(html, /data-notes-mode="bilingual"[\s\S]*?aria-pressed="true"[\s\S]*?>双语</);
  assert.match(css, /\.header-actions\s*\{[\s\S]*?display:\s*flex/);
  assert.match(css, /\.language-mode-control\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(
    js,
    /function updateHeaderLanguageControlsVisibility\(\)[\s\S]*?transcriptControl\.hidden = !\(showingResults && activeTab === "transcript"\)[\s\S]*?overviewControl\.hidden = !\(showingResults && activeTab === "overview"\)[\s\S]*?notesControl\.hidden = !\(showingResults && activeTab === "notes"\)/,
  );
  assert.match(js, /function showState\(state\)[\s\S]*?updateHeaderLanguageControlsVisibility\(\)/);
  assert.match(js, /function switchTab\(tabName\)[\s\S]*?updateHeaderLanguageControlsVisibility\(\)/);
  assert.match(js, /handleTranscriptModeChange\(button\.dataset\.transcriptMode\)/);
  assert.match(js, /handleOverviewModeChange\(button\.dataset\.overviewMode\)/);
  assert.match(js, /handleNotesModeChange\(button\.dataset\.notesMode\)/);
  assert.match(js, /let currentOverviewMode = "bilingual"/);
  assert.match(js, /let currentNotesMode = "bilingual"/);
  assert.match(js, /currentAnalysis = hasUsableEnglishAnalysis\(cached\.analysis\)/);
  assert.match(js, /action: "translateOverview"/);
  assert.match(js, /function ensureOverviewChinese\(\)/);
  assert.match(js, /action: "translateNotes"/);
  assert.match(js, /function ensureNotesChinese\(\)/);
  assert.match(js, /const REQUIRED_RUNTIME_PROTOCOL_VERSION = 4/);
  assert.match(
    js,
    /runtimeProtocolVersion\s*!==\s*REQUIRED_RUNTIME_PROTOCOL_VERSION[\s\S]*?showRuntimeVersionError\(\)/,
  );
  assert.match(js, /扩展后台未响应中文翻译请求，请重新加载扩展/);
  const backgroundSource = read("background.js");
  assert.match(backgroundSource, /const RUNTIME_PROTOCOL_VERSION = 4/);
  assert.match(
    backgroundSource,
    /runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION/,
  );
  assert.match(js, /contentType: "transcriptBatch"/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.match(js, /原文（\$\{language\}）/);
  assert.match(js, /await startDigest\([\s\S]*?currentMediaRef/);
  assert.match(js, /runDigestSingleFlight\(videoId/);
  assert.match(js, /tabCheckGeneration \+= 1/);
  assert.match(js, /generation !== tabCheckGeneration/);
});

test("duplicate digest starts for the same video share one in-flight task", async () => {
  const { createSingleFlight } = loadSidepanelHelpers();
  const run = createSingleFlight();
  let callCount = 0;
  let finish;
  const task = () => {
    callCount += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };

  const first = run("video-1", task);
  const second = run("video-1", task);
  await nextTurn();
  assert.equal(callCount, 1);
  finish("done");
  assert.equal(await first, "done");
  assert.equal(await second, "done");

  const third = run("video-1", async () => {
    callCount += 1;
    return "again";
  });
  assert.equal(await third, "again");
  assert.equal(callCount, 2);
});

test("media locators separate Bilibili route identity from resolved CID identity", () => {
  const { extractMediaLocator } = loadSidepanelHelpers();
  const youtube = extractMediaLocator(
    "https://www.youtube.com/watch?v=ydTeb_I0b94&list=example",
  );
  const bilibili = extractMediaLocator(
    "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=2&trackid=example",
  );

  assert.equal(youtube.mediaKey, "ydTeb_I0b94");
  assert.equal(youtube.routeKey, "youtube:ydTeb_I0b94");
  assert.equal(bilibili.routeKey, "bilibili:BV1zfg36ZEXi:p2");
  assert.equal(bilibili.mediaKey, undefined);
  assert.equal(
    bilibili.canonicalUrl,
    "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=2",
  );
});

test("background recognizes only supported YouTube and standard Bilibili video URLs", () => {
  const background = loadBackgroundHelpers();
  assert.equal(
    background.isSupportedVideoUrl(
      "https://www.youtube.com/watch?v=ydTeb_I0b94",
    ),
    true,
  );
  assert.equal(
    background.isSupportedVideoUrl(
      "https://www.bilibili.com/video/BV1zfg36ZEXi/?p=1",
    ),
    true,
  );
  assert.equal(
    background.isSupportedVideoUrl(
      "https://www.bilibili.com/bangumi/play/ep123",
    ),
    false,
  );
});

test("analysis and notes reject responses from stale videos or parts", () => {
  const source = read("sidepanel.js");
  assert.match(
    source,
    /async function triggerAnalysis\(\)[\s\S]*?requestMediaKey = currentVideoId[\s\S]*?requestRouteKey = currentRouteKey[\s\S]*?requestTranscript = currentTranscriptTimestamped[\s\S]*?if \(isStale\(\)\) return;[\s\S]*?currentAnalysis = analysisResult\.analysis/,
  );
  assert.match(
    source,
    /async function loadNotes\(videoId\)[\s\S]*?const generation = notesTranslationGeneration[\s\S]*?generation !== notesTranslationGeneration[\s\S]*?videoId !== currentVideoId[\s\S]*?currentNotes =/,
  );
});

test("overview content renders English, Chinese, and aligned bilingual variants", () => {
  const helpers = loadSidepanelHelpers();
  const chapter = {
    title: "English title",
    titleZh: "中文标题",
    summary: "English summary.",
    summaryZh: "中文摘要。",
  };
  const quote = {
    quote: "English quote.",
    quoteZh: "中文引语。",
  };

  const englishChapter = helpers.renderChapterLanguageContent(chapter, "en");
  const chineseChapter = helpers.renderChapterLanguageContent(chapter, "zh");
  const bilingualChapter = helpers.renderChapterLanguageContent(chapter, "bilingual");
  assert.match(englishChapter, /English title/);
  assert.doesNotMatch(englishChapter, /中文标题/);
  assert.match(chineseChapter, /中文标题/);
  assert.doesNotMatch(chineseChapter, /English title/);
  assert.match(bilingualChapter, /English title[\s\S]*中文标题/);

  assert.match(helpers.renderQuoteLanguageContent(quote, "en"), /English quote/);
  assert.match(helpers.renderQuoteLanguageContent(quote, "zh"), /中文引语/);
  assert.match(
    helpers.renderQuoteLanguageContent(quote, "bilingual"),
    /English quote[\s\S]*中文引语/,
  );
  assert.equal(
    helpers.overviewQuoteCopyText(quote, "bilingual"),
    "English quote.\n中文引语。",
  );
  const englishOnlyAnalysis = {
    chapters: [
      {
        title: "English title",
        summary: "English summary.",
      },
    ],
    keyQuotes: [{ quote: "English quote." }],
  };
  assert.equal(helpers.hasUsableEnglishAnalysis(englishOnlyAnalysis), true);
  assert.equal(helpers.hasCompleteChineseAnalysis(englishOnlyAnalysis), false);
  assert.equal(
    helpers.hasCompleteChineseAnalysis({
      ...englishOnlyAnalysis,
      chapters: [chapter],
      keyQuotes: [quote],
    }),
    true,
  );
  assert.match(
    helpers.renderChapterLanguageContent(englishOnlyAnalysis.chapters[0], "bilingual"),
    /English title/,
  );
  assert.doesNotMatch(
    helpers.renderChapterLanguageContent(englishOnlyAnalysis.chapters[0], "bilingual"),
    /overview-language-block--zh/,
  );
  assert.equal(
    helpers.overviewQuoteCopyText(englishOnlyAnalysis.keyQuotes[0], "zh"),
    "English quote.",
  );
});

test("notes render and copy original, Chinese, and bilingual variants", () => {
  const helpers = loadSidepanelHelpers();
  const note = {
    text: "Polished English note.",
    translatedText: "润色后的中文笔记。",
  };
  assert.match(
    helpers.renderNoteLanguageContent(note, "original"),
    /Polished English note/,
  );
  assert.doesNotMatch(
    helpers.renderNoteLanguageContent(note, "original"),
    /中文笔记/,
  );
  assert.match(
    helpers.renderNoteLanguageContent(note, "zh"),
    /润色后的中文笔记/,
  );
  assert.match(
    helpers.renderNoteLanguageContent(note, "bilingual"),
    /Polished English note[\s\S]*润色后的中文笔记/,
  );
  assert.equal(
    helpers.noteCopyTextForMode(note, "bilingual"),
    "Polished English note.\n润色后的中文笔记。",
  );
  const englishOnly = { text: "English only." };
  assert.match(
    helpers.renderNoteLanguageContent(englishOnly, "zh"),
    /English only/,
  );
  assert.equal(
    helpers.noteCopyTextForMode(englishOnly, "zh"),
    "English only.",
  );
  const chineseSource = {
    text: "AI-polished fallback",
    rawText: "原字幕本身就是中文。",
    sourceLanguage: "zh-CN",
  };
  assert.equal(helpers.noteHasChineseSource(chineseSource), true);
  const chineseSourceBilingual = helpers.renderNoteLanguageContent(
    chineseSource,
    "bilingual",
  );
  assert.match(chineseSourceBilingual, /原字幕本身就是中文/);
  assert.equal(
    (chineseSourceBilingual.match(/<span\b/g) || []).length,
    1,
    "Chinese source text must not be duplicated in bilingual mode",
  );
  assert.equal(
    helpers.noteCopyTextForMode(chineseSource, "bilingual"),
    "原字幕本身就是中文。",
  );
  assert.match(
    helpers.renderNoteLanguageContent(chineseSource, "original"),
    /lang="zh-CN"/,
  );
  assert.equal(
    helpers.noteHasChineseSource({
      rawText: "東京で漢字を使います。",
      sourceLanguage: "ja",
    }),
    false,
  );
});

test("overview analysis validation preserves usable English when Chinese is incomplete", () => {
  const background = loadBackgroundHelpers();
  const normalized = background.validateAndFixTimestamps(
    {
      chapters: [
        {
          title: "English title",
          titleZh: "中文标题",
          summary: "English summary.",
          summaryZh: "中文摘要。",
          timestampSeconds: 5,
        },
        {
          title: "Incomplete",
          summary: "Missing Chinese fields.",
          timestampSeconds: 9,
        },
      ],
      keyQuotes: [
        {
          quote: "English quote.",
          quoteZh: "中文引语。",
          timestampSeconds: 12,
        },
        {
          quote: "English-only quote.",
          timestampSeconds: 15,
        },
      ],
      keyMoments: [5, 12, 999],
    },
    100,
  );

  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.chapters.length, 2);
  assert.equal(normalized.chapters[0].titleZh, "中文标题");
  assert.equal(normalized.chapters[0].summaryZh, "中文摘要。");
  assert.equal(normalized.chapters[1].title, "Incomplete");
  assert.equal(normalized.chapters[1].titleZh, "");
  assert.equal(normalized.keyQuotes[0].quoteZh, "中文引语。");
  assert.equal(normalized.keyQuotes[1].quote, "English-only quote.");
  assert.equal(normalized.keyQuotes[1].quoteZh, "");
  assert.deepEqual(normalized.keyMoments, [5, 12]);
});

test("overview generates English once and Chinese once; bilingual is display-only", async () => {
  const requests = [];
  const background = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        const file = url.endsWith("translation.md")
          ? "prompts/translation.md"
          : "prompts/analysis.md";
        return { ok: true, text: async () => read(file) };
      }
      requests.push(JSON.parse(options.body));
      const content =
        requests.length === 1
          ? {
              chapters: [
                {
                  title: "Opening",
                  summary: "The opening section.",
                  timestampSeconds: 0,
                },
              ],
              keyQuotes: [
                {
                  quote: "Hello world.",
                  timestampSeconds: 0,
                },
              ],
              keyMoments: [0],
            }
          : {
              chapters: [
                {
                  id: "chapter-0",
                  titleZh: "开场",
                  summaryZh: "开场部分。",
                },
              ],
              keyQuotes: [
                {
                  id: "quote-0",
                  quoteZh: "你好，世界。",
                },
              ],
            };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(content),
              },
            },
          ],
        }),
      };
    },
  });

  const englishResult = await background.handleAnalyzeTranscript(
    "[0:00] Hello world.",
    "Example video",
    "Example channel",
    "Example description",
    60,
  );
  const chineseResult = await background.handleTranslateOverview(
    englishResult.analysis,
    "Example video",
  );

  assert.equal(englishResult.success, true);
  assert.equal(englishResult.analysis.chapters[0].title, "Opening");
  assert.equal(englishResult.analysis.chapters[0].titleZh, "");
  assert.equal(chineseResult.success, true);
  assert.equal(chineseResult.translatedOverview.chapters[0].titleZh, "开场");
  assert.equal(chineseResult.translatedOverview.keyQuotes[0].quoteZh, "你好，世界。");
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /English structural overview/);
  assert.doesNotMatch(requests[0].messages[0].content, /titleZh/);
  assert.match(requests[1].messages[0].content, /Translate this English YouTube overview/);
});

test("Bilibili Chinese overview is generated once and mirrored for Chinese display", async () => {
  const requests = [];
  const background = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/analysis.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  chapters: [
                    {
                      title: "开场",
                      summary: "介绍本期主题。",
                      timestampSeconds: 0,
                    },
                  ],
                  keyQuotes: [
                    { quote: "先把问题想清楚。", timestampSeconds: 0 },
                  ],
                  keyMoments: [0],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const result = await background.handleAnalyzeTranscript(
    "[0:00] 先把问题想清楚。",
    "示例视频",
    "示例作者",
    "示例简介",
    60,
    "bilibili",
    "ai-zh",
  );

  assert.equal(result.success, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content, /生成简洁、结构清晰的中文概览/);
  assert.doesNotMatch(requests[0].messages[0].content, /English structural overview/);
  assert.equal(result.analysis.analysisLanguage, "zh-CN");
  assert.equal(result.analysis.chapters[0].title, "开场");
  assert.equal(result.analysis.chapters[0].titleZh, "开场");
  assert.equal(result.analysis.keyQuotes[0].quoteZh, "先把问题想清楚。");
});

test("Bilibili Chinese note cleanup keeps the polished Chinese text", async () => {
  const requests = [];
  const background = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/note-cleanup.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  quote: "先把问题想清楚，再开始动手。",
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const cleaned = await background.cleanupNoteText(
    "先把问题想清楚",
    "嗯，我们应该",
    "再开始动手",
    "嗯，我们应该先把问题想清楚，再开始动手。",
    "示例视频",
    "bilibili",
    "zh-CN",
  );

  assert.equal(cleaned, "先把问题想清楚，再开始动手。");
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content, /整理成通顺、完整、可独立阅读的中文笔记/);
});

test("Bilibili timestamp note saves polished Chinese once without translation", async () => {
  const requests = [];
  let storedNotes = [];
  const mediaRef = {
    platform: "bilibili",
    bvid: "BV1zfg36ZEXi",
    aid: 123,
    cid: 40830435549,
    page: 1,
    mediaKey: "bilibili:BV1zfg36ZEXi:40830435549",
    canonicalUrl: "https://www.bilibili.com/video/BV1zfg36ZEXi/",
    title: "示例视频",
    channelName: "示例作者",
  };
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: {
            provider: "deepseek",
            aiApiKey: "test-key",
            aiBaseUrl: "https://api.deepseek.com",
            aiModel: "deepseek-v4-flash",
          },
        };
      }
      if (key === `digest_${mediaRef.mediaKey}`) {
        return {
          [`digest_${mediaRef.mediaKey}`]: {
            transcript: [
              { start: 0, text: "我们先把问题想清楚", language: "zh-CN" },
              { start: 8, text: "然后再开始动手", language: "zh-CN" },
            ],
          },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (Array.isArray(items.ytd_notes)) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/note-cleanup.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  quote: "我们先把问题想清楚，然后再开始动手。",
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const result = await background.handleSaveNote(
    mediaRef,
    5,
    "示例视频",
    "示例作者",
  );

  assert.equal(result.success, true);
  assert.equal(requests.length, 1);
  assert.equal(result.note.text, "我们先把问题想清楚，然后再开始动手。");
  assert.equal(result.note.textLanguage, "zh-CN");
  assert.equal(result.note.translatedText, "");
  assert.equal(result.note.videoId, mediaRef.mediaKey);
  assert.match(result.note.timestampedUrl, /BV1zfg36ZEXi\/\?t=5$/);
  assert.equal(storedNotes[0].text, result.note.text);
});

test("new polished Chinese notes display cleaned text while legacy notes keep raw text", () => {
  const sidepanel = loadSidepanelHelpers();
  const polished = {
    text: "整理后的完整中文笔记。",
    rawText: "原始字幕碎片",
    sourceLanguage: "zh-CN",
    textLanguage: "zh-CN",
  };
  const legacy = {
    text: "旧清理字段",
    rawText: "旧版原始中文字幕",
    sourceLanguage: "zh-CN",
  };

  assert.equal(sidepanel.noteOriginalText(polished), "整理后的完整中文笔记。");
  assert.equal(sidepanel.noteChineseText(polished), "整理后的完整中文笔记。");
  assert.equal(sidepanel.noteOriginalText(legacy), "旧版原始中文字幕");
  assert.doesNotMatch(
    sidepanel.renderNoteLanguageContent(polished, "zh"),
    /原始字幕碎片/,
  );
});

test("notes generate Chinese once from polished English and persist it", async () => {
  const backgroundSource = read("background.js");
  assert.match(
    backgroundSource,
    /async function handleSaveNote\([\s\S]*?cleanupNoteText\([\s\S]*?saveNoteToStorage\(note\)[\s\S]*?handleTranslateNotes\(\[note\]\)/,
  );
  assert.match(
    backgroundSource,
    /sourceLanguage:[\s\S]*?matchedLine\.language/,
  );
  const requests = [];
  let storedNotes = [
    {
      id: "note_1",
      text: "A polished English note.",
      rawText: "東京で漢字を使います。",
      sourceLanguage: "ja",
      videoTitle: "Example video",
      translatedText: "",
    },
  ];
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return {
          ytd_settings: {
            provider: "deepseek",
            aiApiKey: "test-key",
            aiBaseUrl: "https://api.deepseek.com",
            aiModel: "deepseek-v4-flash",
          },
        };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id: "note_1", textZh: "一条润色后的中文笔记。" }],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(result.translations[0].textZh, "一条润色后的中文笔记。");
  assert.equal(storedNotes[0].translatedText, "一条润色后的中文笔记。");
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content, /Translate these polished English video notes/);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content), {
    notes: [
      {
        id: "note_1",
        text: "A polished English note.",
        videoTitle: "Example video",
      },
    ],
  });
});

test("Chinese source notes reuse their raw subtitle without an API call", async () => {
  let storedNotes = [
    {
      id: "note_zh",
      text: "Polished fallback text.",
      rawText: "这条原字幕已经是中文。",
      sourceLanguage: "zh-CN",
      videoTitle: "示例视频",
    },
  ];
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) =>
      key === "ytd_notes" ? { ytd_notes: storedNotes } : {},
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async () => {
      apiCalls += 1;
      throw new Error("Chinese source notes must not call the API");
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(apiCalls, 0);
  assert.equal(result.translations[0].textZh, "这条原字幕已经是中文。");
  assert.equal(storedNotes[0].translatedText, "这条原字幕已经是中文。");
  assert.equal(background.noteHasChineseSource(storedNotes[0]), true);
});

test("missing note translations retry individually instead of discarding the batch", async () => {
  const requests = [];
  let storedNotes = [
    { id: "note_1", text: "First English note.", videoTitle: "Video" },
    { id: "note_2", text: "Second English note.", videoTitle: "Video" },
  ];
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      const notes =
        requests.length === 1
          ? [{ id: "note_1", textZh: "第一条中文笔记。" }]
          : [{ id: "note_2", textZh: "第二条中文笔记。" }];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ notes }) } }],
        }),
      };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.missingIds, []);
  assert.equal(storedNotes[0].translatedText, "第一条中文笔记。");
  assert.equal(storedNotes[1].translatedText, "第二条中文笔记。");
});

test("valid note translations persist even when another item still fails", async () => {
  let storedNotes = [
    { id: "note_1", text: "First English note.", videoTitle: "Video" },
    { id: "note_2", text: "Second English note.", videoTitle: "Video" },
  ];
  let apiCall = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCall += 1;
      if (apiCall === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    notes: [{ id: "note_1", textZh: "第一条中文笔记。" }],
                  }),
                },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 429, json: async () => ({}) };
    },
  });

  const result = await background.handleTranslateNotes(storedNotes);
  assert.equal(result.success, true);
  assert.deepEqual(result.missingIds, ["note_2"]);
  assert.equal(storedNotes[0].translatedText, "第一条中文笔记。");
  assert.equal(storedNotes[1].translatedText, undefined);
});

test("concurrent requests for the same note serialize and call the API once", async () => {
  let storedNotes = [
    { id: "note_1", text: "English note.", videoTitle: "Video" },
  ];
  let apiCalls = 0;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") return { ytd_notes: storedNotes };
      return {};
    },
    storageSetImpl: async (items) => {
      if (items.ytd_notes) storedNotes = items.ytd_notes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      apiCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id: "note_1", textZh: "中文笔记。" }],
                }),
              },
            },
          ],
        }),
      };
    },
  });
  const request = [
    { id: "note_1", text: "English note.", videoTitle: "Video" },
  ];

  const [first, second] = await Promise.all([
    background.handleTranslateNotes(request),
    background.handleTranslateNotes(request),
  ]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(apiCalls, 1);
  assert.equal(storedNotes[0].translatedText, "中文笔记。");
});

test("note translation, save, and delete share one storage write queue", async () => {
  let storedNotes = [
    { id: "note_1", text: "English note.", videoTitle: "Video" },
  ];
  let signalTranslationWrite;
  const translationWriteStarted = new Promise((resolve) => {
    signalTranslationWrite = resolve;
  });
  let releaseTranslationWrite;
  const translationWriteGate = new Promise((resolve) => {
    releaseTranslationWrite = resolve;
  });
  let blockedTranslationWrite = false;
  const background = loadBackgroundHelpers({
    storageGetImpl: async (key) => {
      if (key === "ytd_settings") {
        return { ytd_settings: { aiApiKey: "test-key" } };
      }
      if (key === "ytd_notes") {
        return { ytd_notes: storedNotes.map((note) => ({ ...note })) };
      }
      return {};
    },
    storageSetImpl: async (items) => {
      if (!Array.isArray(items.ytd_notes)) return;
      const nextNotes = items.ytd_notes.map((note) => ({ ...note }));
      if (
        !blockedTranslationWrite &&
        nextNotes.some((note) => note.translatedText === "中文笔记。")
      ) {
        blockedTranslationWrite = true;
        signalTranslationWrite();
        await translationWriteGate;
      }
      storedNotes = nextNotes;
    },
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [{ id: "note_1", textZh: "中文笔记。" }],
                }),
              },
            },
          ],
        }),
      };
    },
  });

  const translation = background.handleTranslateNotes(storedNotes);
  await translationWriteStarted;
  const save = background.saveNoteToStorage({
    id: "note_new",
    text: "New note.",
    videoTitle: "Video",
  });
  const deletion = background.handleDeleteNote("note_1");
  releaseTranslationWrite();

  const [translationResult, deletionResult] = await Promise.all([
    translation,
    deletion,
    save,
  ]);
  assert.equal(translationResult.success, true);
  assert.equal(deletionResult.success, true);
  assert.deepEqual(
    storedNotes.map((note) => note.id),
    ["note_new"],
  );
});

test("relay recovery reinjects the content script once after extension reload", async () => {
  const background = loadBackgroundHelpers();
  const sendCalls = [];
  const injectionCalls = [];
  const result = await background.sendMessageToContentWithRecovery(
    17,
    { action: "getVideoInfo" },
    {
      async sendMessage(tabId, message) {
        sendCalls.push({ tabId, message });
        if (sendCalls.length === 1) {
          throw new Error(
            "Could not establish connection. Receiving end does not exist.",
          );
        }
        return { title: "Recovered video" };
      },
      async executeScript(details) {
        injectionCalls.push(details);
      },
    },
  );

  assert.deepEqual(result, { title: "Recovered video" });
  assert.equal(sendCalls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(injectionCalls)), [
    { target: { tabId: 17 }, files: ["content.js"] },
  ]);
});

test("relay recovery injects the Bilibili adapter and content script on Bilibili", async () => {
  const background = loadBackgroundHelpers();
  const injectionCalls = [];
  let attempts = 0;
  await background.sendMessageToContentWithRecovery(
    21,
    { action: "getVideoInfo" },
    {
      async sendMessage() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error(
            "Could not establish connection. Receiving end does not exist.",
          );
        }
        return { title: "Bilibili video" };
      },
      async executeScript(details) {
        injectionCalls.push(details);
      },
    },
    "https://www.bilibili.com/video/BV1zfg36ZEXi/",
  );

  assert.deepEqual(JSON.parse(JSON.stringify(injectionCalls)), [
    {
      target: { tabId: 21 },
      files: ["bilibili.js", "content-bilibili.js"],
    },
  ]);
});

test("relay recovery does not hide unrelated messaging failures", async () => {
  const background = loadBackgroundHelpers();
  assert.equal(
    background.isTransientTabContextError(
      new Error("Frame with ID 0 was removed."),
    ),
    true,
  );
  assert.equal(
    background.isTransientTabContextError(
      new Error("No tab with id: 1079106118"),
    ),
    true,
  );
  assert.equal(
    background.isTransientTabContextError(new Error("Tab was closed")),
    false,
  );
  let injectionCount = 0;
  await assert.rejects(
    background.sendMessageToContentWithRecovery(
      17,
      { action: "getVideoInfo" },
      {
        async sendMessage() {
          throw new Error("Tab was closed");
        },
        async executeScript() {
          injectionCount += 1;
        },
      },
    ),
    /Tab was closed/,
  );
  assert.equal(injectionCount, 0);
});

test("semantic segmentation rebuilds sentences across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "The next thought also" },
      { start: 7, text: "stays together!" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(
    segments[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].text, "The next thought also stays together!");
  assert.equal(segments[1].start, 5);
});

test("a huge raw Supadata entry is split into seekable bounded segments", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);
  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.text.length <= 384));
  assert.equal(segments[0].start, 12);
  assert.ok(segments.at(-1).start > segments[0].start);
  assert.ok(segments.every((segment) => /^segment-\d+-\d+$/.test(segment.id)));
});

test("Chinese sentence and clause punctuation creates semantic guardrails", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "这是一个被字幕切开的" },
      { start: 2, text: "完整句子。这是第二个想法，" },
      { start: 5, text: "也应该保持语义完整！" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "这是一个被字幕切开的完整句子。");
  assert.equal(segments[1].text, "这是第二个想法，也应该保持语义完整！");
});

test("structured translation batches align by stable ID and expose missing fallback", () => {
  const sidepanel = loadSidepanelHelpers();
  const background = loadBackgroundHelpers();
  const source = [
    { id: "segment-0-0", text: "A complete first sentence." },
    { id: "segment-1-5000", text: "A complete second sentence." },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.validateTranscriptBatchRequest({ segments: source }))),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "unknown", text: "\u5ffd\u7565" },
        { id: "segment-1-5000", text: "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002" },
      ],
    },
    source,
  );
  const aligned = sidepanel.alignTranslatedSegmentBatch(
    source,
    normalized.segments,
  );
  assert.equal(aligned[0].id, source[0].id);
  assert.equal(aligned[0].text, "");
  assert.match(aligned[0].error, /暂时无法获得翻译/);
  assert.equal(aligned[1].text, "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002");
});

test("translated-only omits English while bilingual renders aligned English and Chinese", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const segment = { id: "segment-0-0", text: "Original English sentence." };
  const translatedOnly = renderTranscriptSegmentContent(
    segment,
    "zh",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  const bilingual = renderTranscriptSegmentContent(
    segment,
    "bilingual",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  assert.doesNotMatch(translatedOnly, /Original English sentence/);
  assert.match(translatedOnly, /\u4e2d\u6587\u8bd1\u6587/);
  assert.match(bilingual, /transcript-original/);
  assert.match(bilingual, /Original English sentence/);
  assert.match(bilingual, /\u4e2d\u6587\u8bd1\u6587/);
});

test("subtitle formatting tags render in original and translated segment text", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const html = renderTranscriptSegmentContent(
    {
      id: "segment-0-0",
      text: "Think <i>deeply</i>, <b>carefully</b>, and <u>clearly</u>.<br>Next line.",
    },
    "bilingual",
    "\u5b57\u5730<i>\u601d\u8003</i>\u7684\u3002<strong>\u91cd\u70b9</strong>",
    "",
  );

  assert.match(html, /Think <i>deeply<\/i>/);
  assert.match(html, /<b>carefully<\/b>/);
  assert.match(html, /<u>clearly<\/u>\.<br>Next line/);
  assert.match(html, /\u5b57\u5730<i>\u601d\u8003<\/i>\u7684\u3002<strong>\u91cd\u70b9<\/strong>/);
});

test("subtitle markup renderer keeps attributed and arbitrary HTML escaped", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><i onclick="alert(2)">unsafe</i><script>alert(3)</script>',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;i onclick=&quot;alert\(2\)&quot;&gt;unsafe<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|<i\s+onclick|<script\b/);
});

test("background rejects unsupported language fallthrough and malformed batches", () => {
  const source = read("background.js");
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.match(source, /targetLanguage !== "zh"/);
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 4 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );
});

test("all AI product requests use DeepSeek non-thinking and JSON behavior", async () => {
  const deepSeekRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const deepSeek = loadBackgroundHelpers({
    fetchImpl: successfulFetch(deepSeekRequests),
  });
  const deepSeekResult = await deepSeek.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(deepSeekResult.text, "translated");
  assert.deepEqual(deepSeekRequests[0].thinking, { type: "disabled" });
  assert.deepEqual(deepSeekRequests[0].response_format, {
    type: "json_object",
  });

  const backgroundSource = read("background.js");
  assert.equal(
    (backgroundSource.match(/await requestAiCompletion\(\{/g) || []).length,
    4,
  );
  assert.doesNotMatch(backgroundSource, /disableThinking/);
  for (const callPath of [
    "handleAnalyzeTranscript",
    "cleanupNoteText",
    "handleExplainSelection",
    "callAiTranslation",
  ]) {
    assert.match(
      backgroundSource,
      new RegExp(`async function ${callPath}\\([\\s\\S]*?requestAiCompletion\\(\\{`),
    );
  }
});

test("blank-line chunks reset provider idle timeout and valid JSON succeeds", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async () =>
      streamingResponse([
        encode("\n"),
        encode("\n"),
        encode('{"choices":[{"message":{"content":"translated"}}]}'),
      ]),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "translated");
  assert.equal(timers.createdCount(50_000), 5);
  assert.equal(timers.activeCount(50_000), 0);
  assert.equal(timers.activeCount(120_000), 0);
});

test("provider idle silence aborts with a distinct Retry-able error", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }),
      },
    }),
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  timers.fireActive(50_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_IDLE_TIMEOUT");
  assert.match(result.error, /连续 50 秒没有响应.*重试/);
  assert.equal(timers.activeCount(120_000), 0);
});

test("blank-line keepalives cannot evade the provider hard cap", async () => {
  const timers = createFakeTimers();
  let releaseRead;
  let signal;
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                releaseRead = () => resolve({ done: false, value: encode("\n") });
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                }, { once: true });
              }),
          }),
        },
      };
    },
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  releaseRead();
  await nextTurn();
  releaseRead();
  await nextTurn();
  assert.equal(timers.activeCount(50_000), 1);
  timers.fireActive(120_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_HARD_TIMEOUT");
  assert.match(result.error, /超过 120 秒.*重试/);
  assert.equal(timers.activeCount(50_000), 0);
});

test("provider response reader accepts leading whitespace before JSON", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([
        encode('  \n\t{"choices":[{"message":{"content":"ok"}}]}'),
      ]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
});

test("provider response reader rejects bodies over 2 MiB", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([new Uint8Array(2 * 1024 * 1024 + 1)]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
  assert.match(result.error, /2 MiB limit/);
});

test("DeepSeek retries one empty transcript JSON response without response_format", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: requests.length === 1
                ? ""
                : '{"segments":[{"id":"segment-0-0","text":"\u4e2d\u6587\u8bd1\u6587\u3002"}]}',
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  assert.equal(requests[0].max_tokens, 1536);
});

test("translation message watchdog rejects, clears its timer, and ignores late replies", async () => {
  let timeoutCallback;
  let timeoutDelay;
  let resolveMessage;
  let clearCount = 0;
  const helpers = loadSidepanelHelpers({
    sendMessage: () =>
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    setTimeoutImpl(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 73;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 73);
      clearCount += 1;
    },
  });

  const request = helpers.sendTranslationMessage({
    action: "translateContent",
  });
  assert.equal(timeoutDelay, 130_000);
  timeoutCallback();
  await assert.rejects(request, /130 秒后超时.*重试/);
  assert.equal(clearCount, 1);

  resolveMessage({ success: true });
  await Promise.resolve();
  assert.equal(clearCount, 1);

  let successTimeoutCallback;
  let successClearCount = 0;
  const successfulHelpers = loadSidepanelHelpers({
    sendMessage: () => Promise.resolve({ success: true }),
    setTimeoutImpl(callback) {
      successTimeoutCallback = callback;
      return 91;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 91);
      successClearCount += 1;
    },
  });
  assert.deepEqual(
    await successfulHelpers.sendTranslationMessage({
      action: "translateContent",
    }),
    { success: true },
  );
  assert.equal(successClearCount, 1);
  successTimeoutCallback();
  assert.equal(successClearCount, 1);
});

test("Chinese prompt preserves natural bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(prompt, /spaces between Chinese and adjacent English words or digits/);
  assert.match(prompt, /source-language `text`/);
});

test("overview and notes keep English generation separate from Chinese translation", () => {
  const analysisPrompt = read("prompts/analysis.md");
  const translationPrompt = read("prompts/translation.md");
  assert.match(analysisPrompt, /English structural overview/);
  assert.match(analysisPrompt, /^## Chinese system prompt$/m);
  assert.match(analysisPrompt, /生成简洁、结构清晰的中文概览/);
  assert.doesNotMatch(analysisPrompt, /titleZh|summaryZh|quoteZh/);
  assert.match(translationPrompt, /^## Overview translation$/m);
  assert.match(translationPrompt, /"titleZh":"中文标题"/);
  assert.match(translationPrompt, /"summaryZh":"中文摘要"/);
  assert.match(translationPrompt, /"quoteZh":"中文引语"/);
  assert.match(translationPrompt, /^## Notes translation$/m);
  assert.match(translationPrompt, /Translate these polished English video notes/);
  assert.match(translationPrompt, /"textZh":"中文笔记"/);
  assert.match(read("prompts/note-cleanup.md"), /^## Chinese system prompt$/m);
});
