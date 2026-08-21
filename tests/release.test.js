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
    [...manifest.host_permissions].sort(),
    [
      "https://*.bilivideo.com/*",
      "https://*.hdslb.com/*",
      "https://api.bilibili.com/*",
      "https://api.deepseek.com/*",
      "https://api.supadata.ai/*",
      "https://subtitle.bilibili.com/*",
      "https://www.bilibili.com/*",
      "https://www.youtube.com/*",
    ].sort(),
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
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);
  assert.equal(manifest.version, "1.4.2");
});

test("cross-platform runtime dependencies match the API-primary release surface", () => {
  const background = read("background.js");
  const optionsPage = read("options.html");
  const optionsStyles = read("options.css");
  const releaseCheck = read("scripts/check-release.sh");
  const brandIcon = read("icons/digestdock-icon-solid.svg");

  assert.doesNotMatch(background, /importScripts\("youtube-transcript\.js"\)/);
  assert.match(background, /importScripts\("notes-backup\.js"\)/);
  assert.ok(
    optionsPage.indexOf('<script src="notes-backup.js"></script>') <
      optionsPage.indexOf('<script src="options.js"></script>'),
    "notes-backup.js must load before options.js",
  );
  assert.ok(
    (releaseCheck.match(/"notes-backup\.js"/g) || []).length >= 2,
    "notes-backup.js must be both allowlisted and required for release",
  );
  for (const file of ["bilibili.js", "content-bilibili.js"]) {
    assert.ok(
      (releaseCheck.match(new RegExp(`"${file.replace(".", "\\.")}"`, "g")) || [])
        .length >= 2,
      `${file} must be both allowlisted and required for release`,
    );
  }
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
  assert.match(optionsPage, /<p class="settings-version">DigestDock 1\.4\.2<\/p>/);
  assert.match(optionsPage, /<p class="eyebrow">DIGESTDOCK<\/p>/);
  assert.match(optionsStyles, /\.brand-letter\s*\{[^}]*font-weight:\s*750/);
  assert.doesNotMatch(optionsPage, /#1F2933|#F26A4F/);
  assert.doesNotMatch(optionsStyles, /#e9654b|rgba\(233,\s*101,\s*75/);
  const publicAllowlist = releaseCheck.match(
    /public_allowlist=\(([\s\S]*?)\n\)/,
  )?.[1];
  assert.ok(publicAllowlist, "public release allowlist must be present");
  assert.doesNotMatch(publicAllowlist, /"(?:poc|tests)\//);
  assert.doesNotMatch(
    [background, read("options.js")].join("\n"),
    /chrome\.downloads\b/,
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
  assert.match(readme, /upstream issues and pull requests are not accepted/i);
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
  assert.match(chineseReadme, /不接受上游 Issue 或 Pull Request/);
  assert.match(chineseReadme, /增加更多翻译语言/);
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
  assert.match(readme, /roughly 100 transcript lookups per month/i);
  assert.match(readme, /supadata\.ai\/pricing/i);
  assert.match(readme, /docs\.supadata\.ai\/get-transcript/i);
  assert.match(readme, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(readme, /saved key is never used automatically/i);
  assert.match(readme, /asks whether to use Supadata for that video attempt/i);
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
  assert.match(chineseReadme, /保存 Key 不等于持续授权/);
  assert.match(chineseReadme, /由你逐视频确认本次请求/);
  assert.match(chineseReadme, /platform\.deepseek\.com\/api_keys/i);
  assert.match(readme, /^### The Digest button is missing on a video$/m);
  assert.match(
    chineseReadme,
    /^### 视频页面没有显示 Digest 按钮$/m,
  );

  const optionsPage = read("options.html");
  const optionsStyles = read("options.css");
  const optionsScript = read("options.js");
  assert.match(optionsScript, /only after you confirm that one third-party request/i);
  assert.match(optionsScript, /确认本次使用第三方 Supadata/);
  assert.match(optionsPage, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(optionsPage, /platform\.deepseek\.com\/api_keys/i);
  assert.doesNotMatch(optionsPage, /<select\b/i);
  assert.doesNotMatch(optionsPage, /id="(?:provider|aiBaseUrl|aiModel)"/);
  const detailsTag = optionsPage.match(
    /<details\b[^>]*class="card customization-card"[^>]*>/,
  );
  assert.ok(detailsTag, "Expected a native Local remix details disclosure");
  assert.doesNotMatch(detailsTag[0], /\sopen(?:\s|=|>)/i);
  assert.match(
    optionsPage,
    /<summary class="customization-summary">[\s\S]*想使用其他 AI 模型？[\s\S]*编辑并复制一段可安全交给编程 Agent 的提示词[\s\S]*<\/summary>/,
  );
  assert.match(
    optionsPage,
    /class="customization-steps"[\s\S]*在编程 Agent 中打开 DigestDock 解压后的项目文件夹[\s\S]*把 \[PROVIDER\] 和 \[MODEL\] 替换成[\s\S]*不要在提示词或聊天中加入 API 密钥[\s\S]*<\/ol>/,
  );
  assert.match(
    optionsPage,
    /class="prompt-reminder"[\s\S]*复制前，请先把 \[PROVIDER\] 和 \[MODEL\] 替换成/,
  );
  assert.doesNotMatch(optionsPage, /~\/Documents\/(?:youtube-digest|digest-dock)/);
  assert.doesNotMatch(optionsPage, /%USERPROFILE%\\Documents\\(?:youtube-digest|digest-dock)/);
  assert.match(optionsPage, /id="copyCustomizationPromptBtn"/);
  assert.match(optionsStyles, /\.customization-summary:hover\s*\{/);
  assert.match(optionsStyles, /\.customization-summary:focus-visible\s*\{/);
  assert.match(optionsStyles, /\.data-card\s*\{[^}]*margin-top:\s*36px;/);
  assert.match(optionsScript, /clipboard\.writeText/);
  assert.match(optionsScript, /Edited prompt copied\./);
  assert.match(optionsScript, /migration\.migrated[\s\S]*storage\.set/);

  const customizationPrompt = options.translate("zh-CN", "customizationPrompt");
  assert.ok(optionsPage.includes(`>${customizationPrompt}</textarea>`));
  assert.doesNotMatch(customizationPrompt, /Documents|USERPROFILE/);

  assert.match(readme, /^## Remix it with your coding agent$/m);
  assert.match(readme, /more translation languages/i);
  assert.match(readme, /customized summary templates/i);
  assert.match(readme, /vocabulary notebook/i);
  assert.match(
    readme,
    /first open the exact DigestDock project folder that Chrome loaded through \*\*Load unpacked\*\* in your coding agent/,
  );
  assert.match(
    chineseReadme,
    /先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 DigestDock 项目文件夹/,
  );

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
  assert.match(readme, /published version supports DeepSeek V4 Flash as its only AI provider/i);
  assert.match(chineseReadme, /发布版本只支持 DeepSeek V4 Flash/);
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
    read("notes-backup.js"),
    /const FORMAT = "youtube-digest-notes-backup"/,
  );
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

test("runtime has no source-file credential dependency or retired model", () => {
  const runtime = [
    "background.js",
    "bilibili.js",
    "content-bilibili.js",
    "content.js",
    "sidepanel.js",
    "options.js",
    "settings.js",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(runtime, /\bCONFIG\./);
  assert.doesNotMatch(runtime, /importScripts\(["']config\.js/);
  assert.doesNotMatch(runtime, /\bdeepseek-chat\b/);
  assert.match(runtime, /deepseek-v4-flash/);
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
