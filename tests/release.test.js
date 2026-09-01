const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("manifest uses minimized install-time permissions", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.options_ui.page, "options.html");
  assert.ok(!manifest.permissions.includes("activeTab"));
  assert.ok(!manifest.permissions.includes("cookies"));
  assert.ok(!manifest.permissions.includes("downloads"));
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["sidePanel", "storage", "unlimitedStorage", "tabs", "scripting"].sort(),
  );
  // Install-time host access is the fixed platform surface plus exactly one
  // origin per selectable AI provider, derived from the registry so the two can
  // never silently drift. The fail-closed Tencent provider ships no
  // hostPermission and must never widen install-time access.
  const providers = require("../ai-providers.js");
  const baseHosts = [
    "https://*.bilivideo.com/*",
    "https://*.hdslb.com/*",
    "https://api.bilibili.com/*",
    "https://api.supadata.ai/*",
    "https://subtitle.bilibili.com/*",
    "https://www.bilibili.com/*",
    "https://www.youtube.com/*",
  ];
  const providerHosts = providers
    .listSelectableProviders()
    .map((provider) => provider.hostPermission);
  assert.deepEqual(
    [...manifest.host_permissions].sort(),
    [...baseHosts, ...providerHosts].sort(),
  );
  assert.ok(
    !manifest.host_permissions.some((host) => /tencentcloudapi\.com/.test(host)),
    "the fail-closed Tencent provider must not appear in host_permissions",
  );
  const bilibiliContentScript = manifest.content_scripts.find((entry) =>
    entry.matches?.includes("https://www.bilibili.com/video/BV*"),
  );
  assert.deepEqual(bilibiliContentScript?.js, [
    "bilibili.js",
    "content-bilibili.js",
  ]);
  assert.deepEqual(bilibiliContentScript?.matches, [
    "https://www.bilibili.com/video/BV*",
  ]);
  const passiveMain = manifest.content_scripts.find((entry) =>
    entry.js?.includes("youtube-passive-main.js"),
  );
  const passiveBridge = manifest.content_scripts.find((entry) =>
    entry.js?.includes("youtube-passive-bridge.js"),
  );
  assert.equal(passiveMain?.run_at, "document_start");
  assert.equal(passiveMain?.world, "MAIN");
  assert.deepEqual(passiveMain?.matches, ["https://www.youtube.com/*"]);
  assert.equal(passiveBridge?.run_at, "document_start");
  assert.equal(passiveBridge?.world, "ISOLATED");
  assert.deepEqual(passiveBridge?.matches, ["https://www.youtube.com/*"]);
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);
  assert.equal(manifest.version, "1.4.6");
});

test("large local caches use explicit permission and remain user-clearable", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const optionsSource = read("options.js");
  const sidepanelSource = read("sidepanel.js");
  const privacy = read("PRIVACY.md");
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");

  assert.ok(manifest.permissions.includes("unlimitedStorage"));
  assert.match(
    optionsSource,
    /key\.startsWith\("digest_"\) \|\| key\.startsWith\("overview_"\)/,
  );
  assert.match(sidepanelSource, /const OVERVIEW_CACHE_MAX_ENTRIES = 100/);
  assert.match(sidepanelSource, /transcriptFingerprint/);
  assert.match(sidepanelSource, /await saveOverviewToCache\(/);
  assert.match(privacy, /`unlimitedStorage`/);
  assert.match(readme, /`unlimitedStorage`/);
  assert.match(chineseReadme, /`unlimitedStorage`/);
});

test("cross-platform runtime dependencies match the Passive-first release surface", () => {
  const background = read("background.js");
  const sidepanelPage = read("sidepanel.html");
  const optionsPage = read("options.html");
  const optionsStyles = read("options.css");
  const releaseCheck = read("scripts/check-release.sh");
  const brandIcon = read("icons/digestdock-icon-solid.svg");
  const backgroundNoteSourcesIndex = background.indexOf(
    'importScripts("note-sources.js")',
  );
  const backgroundExportJobsIndex = background.indexOf(
    'importScripts("export-jobs.js")',
  );
  const panelNoteSourcesIndex = sidepanelPage.indexOf(
    '<script src="note-sources.js"></script>',
  );
  const panelExportJobsIndex = sidepanelPage.indexOf(
    '<script src="export-jobs.js"></script>',
  );
  const panelRuntimeIndex = sidepanelPage.indexOf(
    '<script src="sidepanel.js"></script>',
  );
  const panelStateIndex = sidepanelPage.indexOf(
    '<script src="sidepanel-state.js"></script>',
  );
  const panelEffectsIndex = sidepanelPage.indexOf(
    '<script src="sidepanel-effects.js"></script>',
  );

  assert.doesNotMatch(background, /importScripts\("youtube-transcript\.js"\)/);
  assert.match(background, /importScripts\("notes-backup\.js"\)/);
  assert.ok(
    backgroundNoteSourcesIndex >= 0 &&
      backgroundExportJobsIndex >= 0 &&
      backgroundNoteSourcesIndex < backgroundExportJobsIndex,
    "background.js must load note-sources.js before export-jobs.js",
  );
  assert.ok(
    panelNoteSourcesIndex >= 0 &&
      panelExportJobsIndex >= 0 &&
      panelStateIndex >= 0 &&
      panelEffectsIndex >= 0 &&
      panelRuntimeIndex >= 0 &&
      panelNoteSourcesIndex < panelExportJobsIndex &&
      panelExportJobsIndex < panelStateIndex &&
      panelStateIndex < panelEffectsIndex &&
      panelEffectsIndex < panelRuntimeIndex,
    "sidepanel.html must load note/export dependencies, then state/effects, then sidepanel.js",
  );
  assert.ok(
    (releaseCheck.match(/"sidepanel-state\.js"/g) || []).length >= 2 &&
      (releaseCheck.match(/"sidepanel-effects\.js"/g) || []).length >= 2,
    "sidepanel state/effects must be allowlisted and required for release",
  );
  assert.ok(
    optionsPage.indexOf('<script src="notes-backup.js"></script>') <
      optionsPage.indexOf('<script src="options.js"></script>'),
    "notes-backup.js must load before options.js",
  );
  assert.ok(
    (releaseCheck.match(/"notes-backup\.js"/g) || []).length >= 2,
    "notes-backup.js must be both allowlisted and required for release",
  );
  assert.ok(
    (releaseCheck.match(/"export-jobs\.js"/g) || []).length >= 2,
    "export-jobs.js must be both allowlisted and required for release",
  );
  for (const file of ["bilibili.js", "content-bilibili.js"]) {
    assert.ok(
      (releaseCheck.match(new RegExp(`"${file.replace(".", "\\.")}"`, "g")) || [])
        .length >= 2,
      `${file} must be both allowlisted and required for release`,
    );
  }
  for (const file of [
    "youtube-passive-main.js",
    "youtube-passive-bridge.js",
  ]) {
    assert.ok(
      (releaseCheck.match(new RegExp(`"${file.replace(".", "\\.")}"`, "g")) || [])
        .length >= 2,
      `${file} must be both allowlisted and required for release`,
    );
  }
  assert.doesNotMatch(releaseCheck, /"youtube-transcript-active\.js"/);
  assert.doesNotMatch(releaseCheck, /"youtube-transcript-panel\.js"/);
  assert.doesNotMatch(releaseCheck, /"youtube-transcript\.js"/);
  assert.match(brandIcon, /#0A5FE9/);
  assert.match(brandIcon, /#04B7D2/);
  assert.match(brandIcon, /#D8F7FF|#BCEFFF/);
  assert.doesNotMatch(brandIcon, /#1F2933|#F26A4F/);
  assert.match(optionsPage, /#0A5FE9/);
  assert.match(optionsPage, /#04B7D2/);
  assert.match(optionsPage, /#D8F7FF/);
  assert.match(optionsStyles, /--accent:\s*#076dd1/);
  assert.match(optionsStyles, /--accent-gradient:[\s\S]*?#0a5fe9[\s\S]*?#04b7d2/);
  assert.equal(
    (optionsPage.match(/<strong class="brand-letter">[DDK]<\/strong>/g) || [])
      .length,
    3,
    "only the icon-adjacent DigestDock brand word must emphasize D, D, and K",
  );
  assert.match(optionsPage, /<p class="settings-version">DigestDock 1\.4\.6<\/p>/);
  assert.match(optionsPage, /<p class="eyebrow">DIGESTDOCK<\/p>/);
  assert.match(optionsStyles, /\.brand-letter\s*\{[^}]*font-weight:\s*750/);
  assert.doesNotMatch(optionsPage, /#1F2933|#F26A4F/);
  assert.doesNotMatch(optionsStyles, /#e9654b|rgba\(233,\s*101,\s*75/);
  const publicAllowlist = releaseCheck.match(
    /public_allowlist=\(([\s\S]*?)\n\)/,
  )?.[1];
  assert.ok(publicAllowlist, "public release allowlist must be present");
  assert.doesNotMatch(publicAllowlist, /"(?:poc|tests|experiments)\//);
  assert.doesNotMatch(
    publicAllowlist,
    /(?:local-helper|hosted-api-slot|passive-capture|node-libraries)/,
  );
  assert.match(releaseCheck, /mjs\|cjs\|py/);
  assert.doesNotMatch(
    [background, read("options.js")].join("\n"),
    /chrome\.downloads\b/,
  );
});

test("side panel MVP keeps identity and navigation persistent while transcript state stays local", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const panel = read("sidepanel.js");
  const tabDetection = panel.slice(
    panel.indexOf("async function runCheckCurrentTab"),
    panel.indexOf("// DIGEST PIPELINE"),
  );

  assert.match(html, /id="tabsNav"[\s\S]*?role="tablist"/);
  assert.match(
    html,
    /id="transcriptStateRegion"[\s\S]*?aria-live="polite"[\s\S]*?aria-busy="false"/,
  );
  assert.match(html, /id="transcriptReadyRegion"/);
  assert.match(css, /\.workspace-state-region\.kind-consent/);
  assert.match(css, /\.workspace-state-region\.kind-terminal/);
  assert.match(css, /\.workspace-state-region\.kind-error/);
  assert.match(css, /\.workspace-skeleton-list/);
  assert.match(panel, /function renderSidepanelMvpTranscriptState\(/);
  assert.match(panel, /sidepanelMvpSupadataDispatcher\.dispatch\(/);
  assert.match(panel, /SUPADATA_REQUEST_DISPATCHED/);
  assert.doesNotMatch(
    tabDetection,
    /!currentConfigStatus\?\.hasAiKey/,
    "subtitle reading must not require an AI Provider key",
  );
});

test("release copy documents current scope without em dashes", () => {
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.doesNotMatch(readme, /—/);
  assert.doesNotMatch(chineseReadme, /—/);
  assert.doesNotMatch(manifest.description, /—/);
  assert.doesNotMatch(packageJson.description, /—/);

  assert.equal(manifest.name, "DigestDock");
  assert.equal(packageJson.name, "digest-dock");
  assert.match(read("scripts/package-extension.sh"), /digest-dock-v\$version\.zip/);
  assert.doesNotMatch(
    [readme, chineseReadme, read("PRIVACY.md"), read("SECURITY.md")].join("\n"),
    /\bYT Digest\b/,
  );
  assert.match(readme, /^# DigestDock$/m);
  assert.match(
    readme,
    /DigestDock is a Manifest V3 Chrome extension/,
  );
  assert.match(readme, /standard `www\.bilibili\.com\/video\/BV\.\.\.` pages/);
  assert.doesNotMatch(readme, /before deciding how much of it to watch/i);
  assert.match(readme, /^## Install with your coding agent$/m);
  assert.doesNotMatch(
    [readme, chineseReadme].join("\n"),
    /uncommitted branch candidate|candidate scope on this experimental branch|未提交实验分支候选|当前实验分支的候选范围/,
  );
  assert.match(
    readme,
    /No API key is required to read source transcripts, jump by timestamp, save original-language notes/,
  );
  assert.match(
    chineseReadme,
    /阅读原字幕、跳转时间点、保存原文笔记.*不需要 API Key/,
  );
  assert.match(
    read("PRIVACY.md"),
    /only when it is necessary to provide its disclosed single purpose/,
  );
  assert.match(
    readme,
    /permanent folder I choose[\s\S]*tell me its exact full path[\s\S]*If I need a suggestion during this first installation[\s\S]*`~\/Documents\/digest-dock`[\s\S]*`%USERPROFILE%\\Documents\\digest-dock`[\s\S]*do not assume either path/,
  );
  assert.match(
    readme,
    /Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location\./,
  );
  assert.match(
    readme,
    /selecting the exact project folder you chose in Chrome with \*\*Load unpacked\*\*/,
  );
  assert.match(
    readme,
    /Select the exact project folder you chose, which must contain `manifest\.json`/,
  );
  assert.doesNotMatch(readme, /^## Remix it with your coding agent$/m);
  assert.doesNotMatch(readme, /^## Contributing$/m);
  assert.match(chineseReadme, /^# DigestDock$/m);
  assert.match(chineseReadme, /DigestDock 是一个基于 Manifest V3 的 Chrome 扩展/);
  assert.match(chineseReadme, /标准 `www\.bilibili\.com\/video\/BV\.\.\.` 页面/);
  assert.match(chineseReadme, /^## 让你的编程 Agent 帮你安装$/m);
  assert.match(
    chineseReadme,
    /我选择的长期保留文件夹[\s\S]*告诉我准确的完整路径[\s\S]*第一次安装时需要位置建议[\s\S]*`~\/Documents\/digest-dock`[\s\S]*`%USERPROFILE%\\Documents\\digest-dock`[\s\S]*不要假设我一定使用这些路径/,
  );
  assert.match(
    chineseReadme,
    /如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。/,
  );
  assert.match(
    chineseReadme,
    /“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹/,
  );
  assert.match(
    chineseReadme,
    /选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest\.json`/,
  );
  assert.doesNotMatch(chineseReadme, /^## 用编程 Agent 改造成自己的版本$/m);
  assert.match(readme, /choose \*\*Original\*\*, \*\*中文\*\*, or \*\*双语\*\*/);
  assert.match(chineseReadme, /可选择 \*\*原文\*\*、\*\*中文\*\*或\*\*双语\*\*/);
  assert.match(
    readme,
    /Chinese subtitle tracks stay in Original[\s\S]*never trigger a Chinese-translation request/,
  );
  assert.match(
    chineseReadme,
    /中文字幕直接保留原文[\s\S]*禁用无需使用的中文／双语翻译控件[\s\S]*不发送字幕翻译请求/,
  );
  assert.match(readme, /generated directly in Simplified Chinese/);
  assert.match(chineseReadme, /直接生成简体中文底稿/);
  assert.match(readme, /only when \*\*Original\*\* or \*\*Bilingual\*\* is requested/);
  assert.match(chineseReadme, /请求\*\*原文\*\*或\*\*双语\*\*时/);
  assert.match(readme, /Chinese-source overviews reuse Chinese[\s\S]*without an extra translation call/);
  assert.match(chineseReadme, /中文字幕的三种模式复用同一份中文内容[\s\S]*不发起额外翻译/);
  assert.match(readme, /Notes are polished in English once and translated into Simplified Chinese once/);
  assert.match(chineseReadme, /笔记先生成一次润色后的英文，再单独生成一次简体中文/);
  assert.match(readme, /source subtitle is already Chinese[\s\S]*no Chinese-translation request/);
  assert.match(chineseReadme, /原字幕已经是中文[\s\S]*不再发送中文翻译请求/);
  assert.match(
    read("PRIVACY.md"),
    /polished English note and its video title when generating the separately stored Simplified Chinese note/,
  );

  assert.match(readme, /100 credits per month/i);
  assert.match(readme, /native transcript request uses \*\*1 credit\*\*/i);
  assert.match(readme, /generated transcript costs \*\*2 credits per video minute\*\*/i);
  assert.match(readme, /HTTP `206` still uses \*\*1 credit\*\*/i);
  assert.match(readme, /forces `mode=native`/i);
  assert.match(readme, /roughly 100 lookups per month/i);
  assert.match(readme, /supadata\.ai\/pricing/i);
  assert.match(readme, /docs\.supadata\.ai\/get-transcript/i);
  assert.match(readme, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(readme, /saved key is never used automatically/i);
  assert.match(readme, /every Supadata request needs a new confirmation/i);
  assert.match(readme, /platform\.deepseek\.com\/api_keys/i);
  assert.match(readme, /api-docs\.deepseek\.com/i);
  assert.match(readme, /api-docs\.deepseek\.com\/quick_start\/pricing/i);
  assert.match(readme, /api-docs\.deepseek\.com\/quick_start\/token_usage/i);
  assert.match(readme, /api-docs\.deepseek\.com\/guides\/kv_cache/i);
  assert.match(readme, /\$0\.0028[\s\S]*\$0\.14[\s\S]*\$0\.28/);
  assert.match(readme, /2,935 spoken English words/i);
  assert.match(readme, /about 32,600 input tokens/i);
  assert.match(readme, /\$0\.002[^\n]*\$0\.006 USD/i);
  assert.match(chineseReadme, /api-docs\.deepseek\.com\/quick_start\/pricing/i);
  assert.match(chineseReadme, /api-docs\.deepseek\.com\/quick_start\/token_usage/i);
  assert.match(chineseReadme, /api-docs\.deepseek\.com\/guides\/kv_cache/i);
  assert.match(chineseReadme, /\u00a50\.02[\s\S]*\u00a51[\s\S]*\u00a52/);
  assert.match(chineseReadme, /2,935 \u4e2a\u82f1\u6587\u53e3\u8bed\u8bcd/);
  assert.match(chineseReadme, /\u7ea6 32,600 \u4e2a\u8f93\u5165 token/);
  assert.match(chineseReadme, /\$0\.002[^\n]*\$0\.006 USD/);
  assert.match(chineseReadme, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(chineseReadme, /保存 Key 也不构成持续授权/);
  assert.match(chineseReadme, /每次请求都要重新确认/);
  assert.match(chineseReadme, /platform\.deepseek\.com\/api_keys/i);
  assert.match(readme, /^### The Digest button is missing on a video$/m);
  assert.match(
    chineseReadme,
    /^### 视频页面没有显示 Digest 按钮$/m,
  );

  const optionsPage = read("options.html");
  const optionsStyles = read("options.css");
  const optionsScript = read("options.js");
  assert.match(optionsScript, /every Supadata request requires a new confirmation/i);
  assert.match(optionsScript, /每次使用 Supadata.*重新确认/);
  assert.match(optionsPage, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(optionsPage, /platform\.deepseek\.com\/api_keys/i);
  // The provider picker is a custom ARIA combobox, not a native <select>, and
  // no free-form endpoint/model/legacy-provider text inputs are exposed. The
  // retired "本地改造" remix disclosure and its customization prompt are gone
  // from the page, styles, and script.
  assert.doesNotMatch(optionsPage, /<select\b/i);
  assert.doesNotMatch(optionsPage, /id="(?:provider|aiBaseUrl|aiModel)"/);
  assert.doesNotMatch(
    optionsPage,
    /customization-card|customization-summary|customization-steps|prompt-reminder|copyCustomizationPromptBtn/,
  );
  assert.doesNotMatch(optionsStyles, /customization-summary|customization-card/);
  assert.doesNotMatch(
    optionsScript,
    /clipboard\.writeText|Edited prompt copied\.|customizationPrompt/,
  );
  assert.match(optionsPage, /id="providerSelectButton"[\s\S]*?role="combobox"/);
  assert.match(optionsPage, /id="providerSelectList"[\s\S]*?role="listbox"/);
  assert.doesNotMatch(optionsStyles, /\.data-card\s*\{[^}]*margin-top/);
  // A one-time legacy-shape migration is still persisted exactly once.
  assert.match(optionsScript, /migration\.migrated[\s\S]*storage\.set/);
  assert.doesNotMatch(optionsPage, /~\/Documents\/(?:youtube-digest|digest-dock)/);
  assert.doesNotMatch(optionsPage, /%USERPROFILE%\\Documents\\(?:youtube-digest|digest-dock)/);

  assert.doesNotMatch(chineseReadme, /^## 用编程 Agent 改造成自己的版本$/m);
  assert.match(readme, /exports the current video, selected source videos, all notes, or one source group as UTF-8 TXT/i);
  assert.match(chineseReadme, /当前视频、所选视频、全部笔记和单个视频来源的 UTF-8 TXT 导出/);
  assert.match(readme, /Tencent Hunyuan Translation[\s\S]*unavailable/i);
  assert.match(chineseReadme, /腾讯混元翻译[\s\S]*暂不可用/);

  const publishedDocs = [
    readme,
    chineseReadme,
    read("PRIVACY.md"),
    read("SECURITY.md"),
  ].join("\n");
  assert.doesNotMatch(publishedDocs, /custom OpenAI-compatible/i);
  assert.doesNotMatch(publishedDocs, /optional custom-origin/i);
  assert.doesNotMatch(publishedDocs, /chosen AI provider/i);
  assert.doesNotMatch(publishedDocs, /configure a different OpenAI-compatible/i);
  assert.doesNotMatch(publishedDocs, /Markdown note exports|note Markdown|笔记 Markdown|可导出 Markdown/i);
  // The retired remix mechanism and the DeepSeek-only claim are gone; the
  // published build now ships a preset provider picker with DeepSeek as default.
  assert.doesNotMatch(publishedDocs, /only AI provider/i);
  assert.doesNotMatch(publishedDocs, /Copy customization prompt/i);
  assert.match(readme, /select an AI provider from a preset picker/i);
  assert.match(chineseReadme, /从预设选择器中挑选/);
  assert.match(readme, /DeepSeek is the default provider/i);
  assert.match(chineseReadme, /DeepSeek 是默认服务商/);
  for (const modelLabel of ["GLM-4.7-Flash", "Qwen3-8B", "Fireworks"]) {
    assert.ok(readme.includes(modelLabel), `README should list ${modelLabel}`);
    assert.ok(
      chineseReadme.includes(modelLabel),
      `zh-CN README should list ${modelLabel}`,
    );
  }
  assert.match(readme, /github\.com\/zarazhangrui\/youtube-digest/);
  assert.match(chineseReadme, /github\.com\/zarazhangrui\/youtube-digest/);
  assert.match(read("LICENSE"), /Copyright \(c\) 2026 Zara Zhang/);
  for (const repository of [
    "echore/bili-clipper",
    "the1812/Bilibili-Evolved",
    "ChatGPTBox-dev/chatGPTBox",
    "JefferyHcool/BiliNote",
    "yt-dlp/yt-dlp",
  ]) {
    assert.ok(readme.includes(`github.com/${repository}`));
    assert.ok(chineseReadme.includes(`github.com/${repository}`));
  }

  // Product copy can change, but these persisted identifiers are compatibility
  // contracts for existing settings, notes, caches, and exported backups.
  assert.match(read("settings.js"), /const STORAGE_KEY = "ytd_settings"/);
  assert.match(read("options.js"), /LANGUAGE_STORAGE_KEY = "ytd_options_language"/);
  assert.match(read("options.js"), /PREVIEW_STORAGE_PREFIX = "youtubeDigestPreview:"/);
  assert.match(read("background.js"), /["']ytd_notes["']/);
  assert.match(
    read("note-sources.js"),
    /const STORAGE_KEY = "ytd_note_sources_v2"/,
  );
  assert.match(
    read("note-sources.js"),
    /const LEGACY_STORAGE_KEY = "ytd_note_sources"/,
  );
  assert.match(
    read("export-jobs.js"),
    /const STORAGE_KEY = "ytd_note_export_jobs_v1"/,
  );
  assert.match(
    read("notes-backup.js"),
    /const FORMAT = "youtube-digest-notes-backup"/,
  );
});

test("export jobs persist coordination metadata without credentials or content", () => {
  const jobs = require("../export-jobs.js");
  const sentinel = "private-credential-sentinel";
  const job = jobs.createExportJob(
    {
      state: "planned",
      intent: {
        scope: "current_video",
        mediaKeys: ["youtube:video-a"],
        mode: "bilingual",
        format: "markdown",
        autoExport: true,
      },
      sourceRevisions: { "youtube:video-a": 2 },
      notesRevision: "notes-r1",
      orderedUnitKeys: ["transcript:youtube:video-a:segment-1"],
      completedUnitKeys: [],
      currentBatch: null,
      cursor: 0,
      roundBudget: { maxBatches: 20 },
      providerSnapshot: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        routeKey: "deepseek:deepseek-v4-flash",
        apiKey: sentinel,
        requestBody: { text: "must not persist" },
      },
      sourceText: "full transcript must not persist",
      translatedText: "完整译文不得写入任务",
      exportClaim: null,
      lastError: null,
    },
    { now: 1 },
  );
  const persisted = JSON.stringify(job);

  assert.equal(jobs.STORAGE_KEY, "ytd_note_export_jobs_v1");
  assert.equal(Object.hasOwn(job, "sourceText"), false);
  assert.equal(Object.hasOwn(job, "translatedText"), false);
  assert.equal(Object.hasOwn(job.providerSnapshot, "apiKey"), false);
  assert.equal(Object.hasOwn(job.providerSnapshot, "requestBody"), false);
  assert.doesNotMatch(persisted, new RegExp(sentinel));
  assert.doesNotMatch(persisted, /full transcript|完整译文|must not persist/);
});

test("notes filters preserve selected contrast and expose pressed state", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");

  assert.match(
    html,
    /id="notesFilterThis"[\s\S]*?aria-pressed="true"[\s\S]*?>[\s\S]*?当前视频/,
  );
  assert.match(
    html,
    /id="notesFilterAll"[\s\S]*?aria-pressed="false"[\s\S]*?>[\s\S]*?全部笔记/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn\.active:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent-icon-gradient\);[^}]*color:\s*white;/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn\.active\s*\{[^}]*background:\s*var\(--accent-icon-gradient\);[^}]*color:\s*white;/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn:hover:not\(:disabled\)\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text-secondary\);/,
  );
  assert.match(css, /\.notes-filter \.enhance-btn:focus-visible\s*\{[^}]*outline:/);
  assert.match(js, /setNotesFilter\(false\)/);
  assert.match(js, /setNotesFilter\(true\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(!showAll\)\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(showAll\)\)/);
});

test("all-notes export exposes an accessible multi-video scope picker", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");
  assert.match(html, /id="selectNotesForExport"[\s\S]*?选择视频导出/);
  assert.match(html, /id="notesExportPicker"[\s\S]*?<fieldset>/);
  assert.match(html, /id="notesExportSelectAll"[^>]*type="checkbox"/);
  assert.match(html, /id="confirmNotesExportSelection"[\s\S]*?disabled/);
  assert.match(html, /id="directNotesExportSelection"[\s\S]*?disabled/);
  assert.match(html, /完整导出（0）/);
  assert.match(html, /直接导出（0）/);
  assert.match(css, /\.notes-export-picker-list\s*\{[^}]*max-height:\s*240px;[^}]*overflow-y:\s*auto/);
  assert.match(js, /let selectedNoteExportMediaKeys = new Set\(\)/);
  assert.match(js, /confirm\.disabled = selected === 0/);
  assert.match(js, /selectAll\.indeterminate = selected > 0 && selected < total/);
  assert.match(js, /event\.key !== "Escape"/);
  assert.doesNotMatch(
    js,
    /showNoteExportSupplementGuide|noteExportSupplementIsReady|补充导出|打开补充|重新检查并导出|放弃导出/,
  );
});

test("notes TXT and completion jobs stay scoped away from full transcripts", () => {
  const exporter = read("note-export.js");
  const sources = read("note-sources.js");
  const panel = read("sidepanel.js");
  assert.doesNotMatch(
    exporter,
    /lines\.push\(`\$\{sub\} 字幕`\)/,
    "notes reading exports must not append the full transcript section",
  );
  assert.match(sources, /function buildExportPrecheck\([\s\S]*?includeTranscript = true/);
  assert.match(panel, /const EXPORT_CONTENT_CONTRACT_VERSION = 4/);
  assert.match(panel, /buildCurrentVideoText/);
  assert.match(panel, /buildAllNotesText/);
  assert.doesNotMatch(panel, /buildCurrentVideoMarkdown|buildAllNotesMarkdown|text\/markdown/);
  assert.match(
    panel,
    /function buildNotesExportPrecheck[\s\S]*?includeTranscript: false/,
    "the shared note precheck must exclude full transcripts",
  );
  assert.match(
    panel,
    /function buildNotesExportTranslationPlan[\s\S]*?includeTranscript: false/,
    "the shared note completion plan must exclude full transcripts",
  );
  assert.match(
    panel,
    /async function exportCurrentVideoNotes\(\) \{[\s\S]*?await exportAllNotes\(\[selectedMediaKey\]\);[\s\S]*?\n\}/,
    "the current-video shortcut must delegate to the shared notes export flow",
  );
  assert.match(
    panel,
    /if \(!outcome\.complete\) \{[\s\S]*?await exportAllNotes\(frozenMediaKeys,\s*\{/,
  );
  assert.match(
    panel,
    /async function exportSingleSourceGroup\(group\) \{[\s\S]*?await exportAllNotes\(\[selectedMediaKey\]\);[\s\S]*?\n\}/,
    "the per-source shortcut must delegate to the shared notes export flow",
  );
  assert.match(
    panel,
    /if \(!outcome\.complete\) \{[\s\S]*?await exportTranscript\(\)/,
  );
});

test("YouTube metadata capture binds page info to the exact video identity", () => {
  const content = read("content.js");
  assert.match(
    content,
    /function extractVideoInfo\(\)[\s\S]*?new URLSearchParams\(window\.location\.search\)\.get\("v"\)[\s\S]*?return \{[\s\S]*?videoId,/,
  );
  assert.match(content, /descriptionStatus:[\s\S]*?"confirmed-empty"/);
  assert.match(
    content,
    /descriptionTruncated:\s*!embeddedDescription\.found && !!description/,
  );
  assert.match(
    content,
    /function extractEmbeddedVideoDescription\(videoId\)[\s\S]*?250_000[\s\S]*?"shortDescription"/,
  );
});

test("runtime has no source-file credential dependency or retired model", () => {
  const runtime = [
    "background.js",
    "bilibili.js",
    "content-bilibili.js",
    "content.js",
    "sidepanel.js",
    "options.js",
    "settings.js",
    "ai-providers.js",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(runtime, /\bCONFIG\./);
  assert.doesNotMatch(runtime, /importScripts\(["']config\.js/);
  assert.doesNotMatch(runtime, /\bdeepseek-chat\b/);
  // The current DeepSeek model id now lives once in the provider registry.
  assert.match(read("ai-providers.js"), /deepseek-v4-flash/);
});

test("retired Remix and reader files are absent", () => {
  for (const file of [
    "reader.html",
    "reader.js",
    "remix-prompts.js",
    "config.example.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test("published prompt files contain runtime sections", () => {
  const expectedSections = {
    "prompts/analysis.md": ["System prompt", "User prompt"],
    "prompts/explain.md": ["System prompt", "User prompt"],
    "prompts/note-cleanup.md": [
      "System prompt",
      "Chinese system prompt",
      "User prompt",
    ],
    "prompts/translation.md": [
      "Shared base rules",
      "Chinese rules",
      "Transcript batch translation",
      "Overview original translation",
      "Notes translation",
    ],
  };

  for (const [file, sections] of Object.entries(expectedSections)) {
    const markdown = read(file);
    for (const section of sections) {
      assert.match(markdown, new RegExp(`^## ${section}$`, "m"));
    }
  }

  const analysisPrompt = read("prompts/analysis.md");
  assert.doesNotMatch(analysisPrompt, /^## Chinese system prompt$/m);
  assert.match(read("background.js"), /ANALYSIS_SCHEMA_VERSION\s*=\s*3/);
  for (const field of [
    "detectedSourceLanguage",
    "titleZh",
    "summaryZh",
    "quoteOriginal",
    "quoteZh",
  ]) {
    assert.match(analysisPrompt, new RegExp(`\\b${field}\\b`));
  }
});
