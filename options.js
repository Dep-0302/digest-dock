const YTD_OPTIONS = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const PREVIEW_STORAGE_PREFIX = "youtubeDigestPreview:";
  const DEFAULT_LANGUAGE = "zh-CN";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN"]);

  const COPY = {
    en: {
      pageTitle: "DigestDock Settings",
      languageGroupLabel: "Interface language",
      navAriaLabel: "Settings navigation",
      navGroupSettings: "Settings",
      navGroupOther: "Other",
      navServices: "Service connections",
      navTranscript: "Transcript provider",
      navNotes: "Notes & backup",
      navPrivacy: "Privacy",
      deepseekTagline: "Overviews, explanations, translation, and note polishing",
      supadataTagline: "Optional provider for new YouTube transcripts",
      statusConfigured: "Configured",
      statusNotConfigured: "Not configured",
      fieldRequired: "Required",
      fieldOptional: "Optional",
      toggleKeyVisibility: "Show or hide the key",
      privacySummary:
        "DigestDock has no developer server and uses no analytics. API keys, cached digests, translations, and notes stay only in this Chrome profile.",
      noUnsavedChanges: "No unsaved changes.",
      unsavedChanges: "You have unsaved changes.",
      heading: "Bring your own API keys",
      lede:
        "Keys stay in this Chrome profile. DeepSeek powers AI features, and Supadata is the optional provider that fetches native captions for new YouTube videos. This open-source extension has no developer server or analytics.",
      transcriptProvider: "YouTube transcript provider",
      supadataApiKeyLabel: "Supadata API key (optional)",
      supadataPlaceholder: "Paste your Supadata key",
      supadataHelp:
        "New YouTube captions are fetched through Supadata. It stays optional for the extension, but Supadata is called only after you confirm that one third-party request in the side panel, once per video. Bilibili does not use it. ",
      supadataLink: "Create a Supadata account and key",
      supadataHelpSuffix:
        ". Supadata generates the key during onboarding.",
      aiProvider: "AI provider",
      providerSummaryLabel: "Supported AI provider",
      providerBadge: "Supported in this version",
      deepseekApiKeyLabel: "DeepSeek API key",
      deepseekPlaceholder: "Paste your DeepSeek key",
      deepseekHelp:
        "DigestDock uses DeepSeek V4 Flash for overviews, explanations, translation, and note polishing. ",
      deepseekLink: "Create a DeepSeek API key",
      deepseekHelpSuffix: ".",
      privacyNote:
        "When you use AI features, DeepSeek receives the video transcript and relevant video context. Review DeepSeek's terms and pricing before saving.",
      saveSettings: "Save settings",
      localRemix: "Local remix",
      customizationTitle: "Want to use another AI model?",
      customizationPurpose: "Edit and copy a safe prompt for your coding agent",
      agentBadge: "Coding agent ready",
      customizationIntro:
        "You can edit the prompt directly. Complete these three steps before copying:",
      customizationStepFolder:
        "Open the extracted DigestDock project folder in your coding agent.",
      customizationStepReplace:
        "Replace [PROVIDER] and [MODEL] with the service and model you want to use.",
      customizationStepKeys:
        "Never include API keys in the prompt or chat. Enter them yourself after the code is ready.",
      customizationPromptLabel: "Editable customization prompt",
      customizationReminderLabel: "Prompt reminder",
      customizationReminder:
        "Before copying, replace [PROVIDER] and [MODEL] with the provider and model you want to use.",
      customizationPrompt:
        "Customize this local DigestDock workspace to use [PROVIDER] with [MODEL]. Work only in the current workspace. Before editing, verify that it contains manifest.json and that the manifest name is DigestDock. If verification fails, stop and ask me to open the extracted DigestDock project folder in my coding agent. Do not search other folders, edit a guessed copy, assume an installation path, or claim Chrome can reveal the absolute OS source path. Update the provider's API endpoint, request format, and minimum Chrome host permissions. Preserve bring-your-own-key and local Chrome storage. Never put API keys in source code, commits, logs, screenshots, this prompt, or chat; after the code is ready, tell me where to enter the key myself. Keep DeepSeek-only request fields and retry behavior isolated to DeepSeek. Handle provider-specific rules separately so one provider does not affect another. Update README.md, README.zh-CN.md, PRIVACY.md, SECURITY.md, and tests. Run npm test, npm run check, and npm run package. Then explain how to reload the unpacked extension and test it on a real YouTube video.",
      copyCustomizationPrompt: "Copy edited prompt",
      notesBackup: "Notes backup",
      notesBackupHelp:
        "The JSON backup contains saved notes, stored language versions, and validated YouTube or Bilibili media identity and timestamps. It never includes API keys, settings, full transcripts, or digest caches. Import rebuilds safe timestamp links, merges with local notes, and skips duplicates.",
      exportNotes: "Export notes backup",
      importNotes: "Import notes backup",
      localData: "Local data",
      localDataHelp:
        "Digests, translations, and notes are stored only in this Chrome profile. You can remove them at any time.",
      clearCache: "Clear cached digests",
      deleteNotes: "Delete all notes",
      resetData: "Reset extension data",
      footer:
        'Read <a href="PRIVACY.md" target="_blank">PRIVACY.md</a> in the repository for the complete data-flow description.',
      migrationWarning:
        "Custom provider settings were removed safely. Your optional Supadata key was kept, but the AI key was cleared. Enter a DeepSeek API key to continue.",
      saving: "Saving…",
      addSupadataKey:
        "Add a Supadata API key to fetch native captions for new YouTube videos after per-attempt consent.",
      addDeepseekKey: "Add a DeepSeek API key.",
      saved: "Saved. Reopen DigestDock to use these settings.",
      saveFailed: "Could not save settings. Please try again.",
      copying: "Copying…",
      promptCopied: "Edited prompt copied.",
      copyFailed:
        "Could not copy the prompt. Select the prompt text and copy it manually.",
      exportingNotes: "Preparing notes backup…",
      notesExported: ({ count }) =>
        `Exported ${count} saved note${count === 1 ? "" : "s"}.`,
      noNotesToExport: "There are no saved notes to export.",
      notesExportFailed: "Could not export the saved notes. Nothing was downloaded.",
      importingNotes: "Checking and importing the notes backup…",
      notesImported: ({ imported, duplicates, enriched, total }) => {
        const details = [`Restored ${imported} new note${imported === 1 ? "" : "s"}.`];
        if (duplicates) details.push(`Matched ${duplicates} duplicate${duplicates === 1 ? "" : "s"}.`);
        if (enriched) details.push(`Completed ${enriched} existing note${enriched === 1 ? "" : "s"} with missing content.`);
        details.push(`${total} note${total === 1 ? " is" : "s are"} now saved.`);
        return details.join(" ");
      },
      notesImportNoChanges: ({ duplicates, total }) =>
        duplicates
          ? `No new notes were added. ${duplicates} duplicate${duplicates === 1 ? " was" : "s were"} already present. ${total} note${total === 1 ? " is" : "s are"} still saved.`
          : "The backup did not contain any notes. Local notes were not changed.",
      notesBackupTooLarge: "This backup is larger than 5 MiB and was not imported.",
      notesBackupInvalid: "This is not a valid DigestDock notes backup. No notes were changed.",
      notesBackupUnsupported:
        "This backup was created by a newer unsupported format. Update DigestDock before importing it.",
      notesBackupConflict:
        "The backup conflicts with an existing note that has the same ID. No notes were changed.",
      notesBackupCapacity: ({ overBy }) =>
        `Import would exceed the 100-note limit by ${overBy}. Delete unneeded notes and try again. No notes were changed.`,
      notesImportFailed: "Could not import the notes backup. No notes were changed.",
      clearedDigests: ({ count }) =>
        `Cleared ${count} cached digest${count === 1 ? "" : "s"}.`,
      notesDeleted: "Deleted all saved notes.",
      notesDeleteFailed: "Could not delete the saved notes. Please try again.",
      resetConfirm:
        "Delete API keys, cached digests, translations, and saved notes from this Chrome profile?",
      allDataDeleted: "All DigestDock data was deleted.",
      resetFailed: "Could not reset the extension data. Please try again.",
      settingsLoadFailed:
        "Could not load saved settings. You can still preview this page.",
    },
    "zh-CN": {
      pageTitle: "DigestDock 设置",
      languageGroupLabel: "界面语言",
      navAriaLabel: "设置导航",
      navGroupSettings: "设置",
      navGroupOther: "其他",
      navServices: "服务连接",
      navTranscript: "字幕服务",
      navNotes: "笔记与备份",
      navPrivacy: "隐私说明",
      deepseekTagline: "概览、解释、翻译和笔记润色",
      supadataTagline: "新 YouTube 视频的可选字幕服务",
      statusConfigured: "已配置",
      statusNotConfigured: "未配置",
      fieldRequired: "必需",
      fieldOptional: "可选",
      toggleKeyVisibility: "显示或隐藏密钥",
      privacySummary:
        "DigestDock 没有开发者服务器，也不使用分析服务。API 密钥、缓存摘要、翻译和笔记只保存在当前 Chrome 个人资料中。",
      noUnsavedChanges: "设置没有未保存的更改。",
      unsavedChanges: "有未保存的更改。",
      heading: "使用你自己的 API 密钥",
      lede:
        "密钥仅保存在当前 Chrome 个人资料中。DeepSeek 用于 AI 功能，Supadata 是可选服务，用于为新的 YouTube 视频获取原生字幕。本开源扩展没有开发者服务器，也不使用分析服务。",
      transcriptProvider: "YouTube 字幕服务",
      supadataApiKeyLabel: "Supadata API 密钥（可选）",
      supadataPlaceholder: "粘贴 Supadata 密钥",
      supadataHelp:
        "新的 YouTube 字幕由 Supadata 获取。它对整个扩展仍是可选配置，但只有你在侧边栏确认本次使用第三方 Supadata 时才会调用，且逐视频授权；B 站不会使用。",
      supadataLink: "创建 Supadata 账号并获取密钥",
      supadataHelpSuffix: "。Supadata 会在引导流程中生成密钥。",
      aiProvider: "AI 服务",
      providerSummaryLabel: "支持的 AI 服务",
      providerBadge: "当前版本支持",
      deepseekApiKeyLabel: "DeepSeek API 密钥",
      deepseekPlaceholder: "粘贴 DeepSeek 密钥",
      deepseekHelp:
        "DigestDock 使用 DeepSeek V4 Flash 生成概览、解释内容、翻译字幕和润色笔记。",
      deepseekLink: "创建 DeepSeek API 密钥",
      deepseekHelpSuffix: "。",
      privacyNote:
        "使用 AI 功能时，DeepSeek 会收到视频字幕及相关视频上下文。保存前请查看 DeepSeek 的服务条款和价格。",
      saveSettings: "保存设置",
      localRemix: "本地改造",
      customizationTitle: "想使用其他 AI 模型？",
      customizationPurpose: "编辑并复制一段可安全交给编程 Agent 的提示词",
      agentBadge: "可交给编程 Agent",
      customizationIntro: "你可以直接编辑提示词。复制前完成以下三步：",
      customizationStepFolder:
        "在编程 Agent 中打开 DigestDock 解压后的项目文件夹。",
      customizationStepReplace:
        "把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationStepKeys:
        "不要在提示词或聊天中加入 API 密钥。代码准备好后，请自行填写。",
      customizationPromptLabel: "可编辑的自定义提示词",
      customizationReminderLabel: "提示词提醒",
      customizationReminder:
        "复制前，请先把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationPrompt:
        "请把当前本地 DigestDock 工作区改为使用 [PROVIDER] 提供的 [MODEL]。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 DigestDock。如果验证失败，请停止，并让我在编程 Agent 中打开 DigestDock 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。更新该服务的 API endpoint、请求格式和最少的 Chrome host permissions。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。DeepSeek 专用的请求参数和重试逻辑继续只用于 DeepSeek。新服务的专属规则请单独处理，避免相互影响。更新 README.md、README.zh-CN.md、PRIVACY.md、SECURITY.md 和测试。运行 npm test、npm run check 和 npm run package。最后，说明如何重新加载已解压的扩展，并在真实 YouTube 视频上测试。",
      copyCustomizationPrompt: "复制编辑后的提示词",
      notesBackup: "笔记备份",
      notesBackupHelp:
        "JSON 备份只包含已保存笔记、语言版本和经过校验的 YouTube 或 B 站媒体身份与时间戳，不包含 API 密钥、设置、完整字幕或摘要缓存。导入会重建安全时间戳链接，与本机笔记合并，并自动跳过重复项。",
      exportNotes: "导出笔记备份",
      importNotes: "导入笔记备份",
      localData: "本地数据",
      localDataHelp:
        "摘要、翻译和笔记仅保存在当前 Chrome 个人资料中。你可以随时删除。",
      clearCache: "清除缓存的摘要",
      deleteNotes: "删除全部笔记",
      resetData: "重置扩展数据",
      footer:
        '完整数据流说明请参阅仓库中的 <a href="PRIVACY.md" target="_blank">PRIVACY.md</a>。',
      migrationWarning:
        "已安全移除自定义服务设置。可选的 Supadata 密钥已保留，AI 密钥已清除。请输入 DeepSeek API 密钥以继续使用。",
      saving: "正在保存…",
      addSupadataKey:
        "为新的 YouTube 视频获取原生字幕，请添加可选的 Supadata API 密钥（每次逐一授权）。",
      addDeepseekKey: "请添加 DeepSeek API 密钥。",
      saved: "已保存。请重新打开 DigestDock 以使用这些设置。",
      saveFailed: "无法保存设置，请重试。",
      copying: "正在复制…",
      promptCopied: "已复制编辑后的提示词。",
      copyFailed: "无法复制提示词。请选中提示词文本并手动复制。",
      exportingNotes: "正在准备笔记备份…",
      notesExported: ({ count }) => `已导出 ${count} 条笔记。`,
      noNotesToExport: "当前没有可导出的笔记。",
      notesExportFailed: "无法导出笔记，未生成下载文件。",
      importingNotes: "正在校验并导入笔记备份…",
      notesImported: ({ imported, duplicates, enriched, total }) => {
        const details = [`已恢复 ${imported} 条新笔记。`];
        if (duplicates) details.push(`匹配到 ${duplicates} 条重复笔记。`);
        if (enriched) details.push(`补全了 ${enriched} 条已有笔记的缺失内容。`);
        details.push(`当前共保存 ${total} 条笔记。`);
        return details.join("");
      },
      notesImportNoChanges: ({ duplicates, total }) =>
        duplicates
          ? `没有新增笔记；${duplicates} 条均已存在。当前仍保存 ${total} 条笔记。`
          : "备份中没有笔记，本机笔记未改变。",
      notesBackupTooLarge: "备份文件超过 5 MiB，未执行导入。",
      notesBackupInvalid: "这不是有效的 DigestDock 笔记备份，现有笔记未改变。",
      notesBackupUnsupported: "该备份使用了当前版本不支持的新格式，请更新 DigestDock 后再导入。",
      notesBackupConflict: "备份与本机具有相同 ID 的笔记内容冲突，现有笔记未改变。",
      notesBackupCapacity: ({ overBy }) =>
        `导入后将超过 100 条上限，多出 ${overBy} 条。请先删除不需要的笔记后重试，现有笔记未改变。`,
      notesImportFailed: "无法导入笔记备份，现有笔记未改变。",
      clearedDigests: ({ count }) => `已清除 ${count} 条缓存摘要。`,
      notesDeleted: "已删除全部已保存的笔记。",
      notesDeleteFailed: "无法删除已保存的笔记，请重试。",
      resetConfirm:
        "要从当前 Chrome 个人资料中删除 API 密钥、缓存摘要、翻译和已保存的笔记吗？",
      allDataDeleted: "已删除全部 DigestDock 数据。",
      resetFailed: "无法重置扩展数据，请重试。",
      settingsLoadFailed: "无法加载已保存的设置，但你仍可预览此页面。",
    },
  };

  function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : DEFAULT_LANGUAGE;
  }

  function translate(language, key, params = {}) {
    const normalizedLanguage = normalizeLanguage(language);
    const value = COPY[normalizedLanguage][key] ?? COPY.en[key] ?? "";
    return typeof value === "function" ? value(params) : value;
  }

  function createStorageAdapter(chromeApi, fallbackStorage) {
    const chromeStorage = chromeApi?.storage?.local;
    const memoryStorage = new Map();

    function fallbackKeys() {
      const keys = [];
      if (!fallbackStorage) return keys;
      try {
        for (let index = 0; index < fallbackStorage.length; index += 1) {
          const key = fallbackStorage.key(index);
          if (key?.startsWith(PREVIEW_STORAGE_PREFIX)) keys.push(key);
        }
      } catch (_error) {
        return [];
      }
      return keys;
    }

    function readFallbackValue(key) {
      try {
        const rawValue = fallbackStorage?.getItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
        );
        if (rawValue !== null && rawValue !== undefined) {
          return JSON.parse(rawValue);
        }
      } catch (_error) {
        // Fall through to memory when localStorage is unavailable or malformed.
      }
      return memoryStorage.get(key);
    }

    function writeFallbackValue(key, value) {
      memoryStorage.set(key, value);
      try {
        fallbackStorage?.setItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
          JSON.stringify(value),
        );
      } catch (_error) {
        // The in-memory copy keeps a restricted preview functional.
      }
    }

    return {
      async get(keys) {
        if (chromeStorage) return chromeStorage.get(keys);

        const requestedKeys =
          keys === null
            ? [
                ...new Set([
                  ...memoryStorage.keys(),
                  ...fallbackKeys().map((key) =>
                    key.slice(PREVIEW_STORAGE_PREFIX.length),
                  ),
                ]),
              ]
            : Array.isArray(keys)
              ? keys
              : [keys];

        return Object.fromEntries(
          requestedKeys
            .map((key) => [key, readFallbackValue(key)])
            .filter(([, value]) => value !== undefined),
        );
      },

      async set(items) {
        if (chromeStorage) return chromeStorage.set(items);
        for (const [key, value] of Object.entries(items)) {
          writeFallbackValue(key, value);
        }
      },

      async remove(keys) {
        if (chromeStorage) return chromeStorage.remove(keys);
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          memoryStorage.delete(key);
          try {
            fallbackStorage?.removeItem(`${PREVIEW_STORAGE_PREFIX}${key}`);
          } catch (_error) {
            // Memory removal is sufficient for this preview session.
          }
        }
      },

      async clear() {
        if (chromeStorage) return chromeStorage.clear();
        memoryStorage.clear();
        for (const key of fallbackKeys()) {
          try {
            fallbackStorage.removeItem(key);
          } catch (_error) {
            // Continue clearing any remaining preview keys.
          }
        }
      },
    };
  }

  async function readPreferredLanguage(storage) {
    const stored = await storage.get(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored[LANGUAGE_STORAGE_KEY]);
  }

  async function persistPreferredLanguage(storage, language) {
    const normalizedLanguage = normalizeLanguage(language);
    await storage.set({ [LANGUAGE_STORAGE_KEY]: normalizedLanguage });
    return normalizedLanguage;
  }

  function updateLanguageButtonState(buttons, language) {
    const normalizedLanguage = normalizeLanguage(language);
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.language === normalizedLanguage),
      );
    }
  }

  function updateLocalizedPrompt(textarea, prompt) {
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;

    textarea.value = prompt;

    if (
      Number.isInteger(selectionStart) &&
      Number.isInteger(selectionEnd) &&
      typeof textarea.setSelectionRange === "function"
    ) {
      textarea.setSelectionRange(
        Math.min(selectionStart, prompt.length),
        Math.min(selectionEnd, prompt.length),
        selectionDirection || "none",
      );
    }
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  }

  function createPromptDrafts() {
    return {
      en: translate("en", "customizationPrompt"),
      "zh-CN": translate("zh-CN", "customizationPrompt"),
    };
  }

  function switchPromptDraft(
    drafts,
    currentLanguage,
    nextLanguage,
    currentValue,
  ) {
    const normalizedCurrentLanguage = normalizeLanguage(currentLanguage);
    const normalizedNextLanguage = normalizeLanguage(nextLanguage);
    drafts[normalizedCurrentLanguage] = String(currentValue ?? "");
    if (typeof drafts[normalizedNextLanguage] !== "string") {
      drafts[normalizedNextLanguage] = translate(
        normalizedNextLanguage,
        "customizationPrompt",
      );
    }
    return {
      language: normalizedNextLanguage,
      prompt: drafts[normalizedNextLanguage],
    };
  }

  async function copyPromptValue(clipboard, value) {
    await clipboard.writeText(value);
  }

  function triggerNotesBackupDownload(root, backup, date = new Date()) {
    const text = `${JSON.stringify(backup, null, 2)}\n`;
    const blob = new root.Blob([text], { type: "application/json" });
    const url = root.URL.createObjectURL(blob);
    const link = root.document.createElement("a");
    link.href = url;
    link.download = root.YTD_NOTES_BACKUP.notesBackupFilename(date);
    link.hidden = true;
    root.document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      root.URL.revokeObjectURL(url);
    }
    return { filename: link.download, text };
  }

  function notesBackupErrorKey(code) {
    switch (code) {
      case "NOTES_BACKUP_TOO_LARGE":
        return "notesBackupTooLarge";
      case "UNSUPPORTED_NOTES_BACKUP_VERSION":
        return "notesBackupUnsupported";
      case "NOTES_BACKUP_CONFLICT":
        return "notesBackupConflict";
      case "NOTES_CAPACITY_EXCEEDED":
        return "notesBackupCapacity";
      case "INVALID_NOTES_BACKUP":
      case "INVALID_STORED_NOTES":
        return "notesBackupInvalid";
      default:
        return "notesImportFailed";
    }
  }

  function getSafeLocalStorage(root) {
    try {
      return root.localStorage;
    } catch (_error) {
      return null;
    }
  }

  const SETTINGS_NAV_ACTIVE_CLASS = "is-active";
  // aria-current="location" marks the nav item pointing at the section the user
  // is currently viewing within the same document (WAI-ARIA "location" token).
  const SETTINGS_NAV_CURRENT_VALUE = "location";
  // Activation line, in px below the top of the internal scroller, where a
  // section is considered the current one for scroll-spy purposes.
  const SETTINGS_NAV_ACTIVATION_OFFSET = 24;
  // Slack, in px, for treating the internal scroller as scrolled to its end.
  // Sub-pixel rounding means scrollTop + clientHeight rarely equals scrollHeight
  // exactly at the bottom.
  const SETTINGS_NAV_BOTTOM_EPSILON = 2;

  function settingsNavTargetFromHref(href) {
    if (typeof href !== "string") return "";
    const hashIndex = href.indexOf("#");
    return hashIndex === -1 ? "" : href.slice(hashIndex + 1);
  }

  // Deterministic scroll-spy: given the sections in document order with each
  // top measured relative to the scroller's top edge, the active section is the
  // last one whose top has reached or passed the activation line. Above the
  // first section, the first section stays active.
  //
  // options.atBottom marks that the scroller is pinned at its end, where the
  // final sections can never bring their top to the activation line. In that
  // state an explicit click target (options.preferredId) that is still visible
  // wins so navigation lands where the user asked; otherwise the last visible
  // section wins, matching the "scrolled to the very end" convention. Callers
  // that omit options keep the plain line-based behavior. options.viewportHeight
  // bounds visibility (defaults to unbounded for line-only callers and tests).
  function resolveActiveSettingsSection(sections, activationLine = 0, options = {}) {
    if (!sections.length) return "";

    let activeId = sections[0].id;
    for (const section of sections) {
      if (section.top <= activationLine + 1) activeId = section.id;
    }

    if (options.atBottom !== true) return activeId;

    const viewportHeight =
      typeof options.viewportHeight === "number"
        ? options.viewportHeight
        : Infinity;
    // A section is visible when its top is above the viewport's bottom edge and
    // its bottom (approximated by the next section's top) is below the top edge.
    const isVisible = (index) => {
      const top = sections[index].top;
      const bottom =
        index + 1 < sections.length ? sections[index + 1].top : Infinity;
      return top < viewportHeight && bottom > 0;
    };

    if (options.preferredId) {
      const preferredIndex = sections.findIndex(
        (section) => section.id === options.preferredId,
      );
      if (preferredIndex !== -1 && isVisible(preferredIndex)) {
        return options.preferredId;
      }
    }

    let bottomId = activeId;
    for (let index = 0; index < sections.length; index += 1) {
      if (isVisible(index)) bottomId = sections[index].id;
    }
    return bottomId;
  }

  // Sets is-active and aria-current only on the item whose href targets
  // activeId; clears both from every sibling. Never touches text, so it cannot
  // disturb localization, IDs, or anchor behavior.
  function applySettingsNavState(navItems, activeId) {
    for (const item of navItems) {
      const target = settingsNavTargetFromHref(
        typeof item.getAttribute === "function"
          ? item.getAttribute("href")
          : item.href,
      );
      const isActive = Boolean(activeId) && target === activeId;
      item.classList.toggle(SETTINGS_NAV_ACTIVE_CLASS, isActive);
      if (isActive) {
        item.setAttribute("aria-current", SETTINGS_NAV_CURRENT_VALUE);
      } else {
        item.removeAttribute("aria-current");
      }
    }
  }

  function initialize(root = globalThis) {
    const doc = root.document;
    const settingsApi = root.YTD_SETTINGS;
    if (!doc || !settingsApi) return;

    const storage = createStorageAdapter(
      root.chrome,
      getSafeLocalStorage(root),
    );
    const form = doc.getElementById("settingsForm");
    const aiApiKeyInput = doc.getElementById("aiApiKey");
    const supadataApiKeyInput = doc.getElementById("supadataApiKey");
    const customizationPrompt = doc.getElementById("customizationPrompt");
    const copyCustomizationPromptBtn = doc.getElementById(
      "copyCustomizationPromptBtn",
    );
    const copyStatus = doc.getElementById("copyStatus");
    const saveStatus = doc.getElementById("saveStatus");
    const dataStatus = doc.getElementById("dataStatus");
    const backupStatus = doc.getElementById("backupStatus");
    const exportNotesBtn = doc.getElementById("exportNotesBtn");
    const importNotesBtn = doc.getElementById("importNotesBtn");
    const importNotesFile = doc.getElementById("importNotesFile");
    const languageButtons = [...doc.querySelectorAll("[data-language]")];
    const deepseekStatus = doc.getElementById("deepseekStatus");
    const supadataStatus = doc.getElementById("supadataStatus");
    const revealToggles = [...doc.querySelectorAll("[data-reveal]")];
    const settingsScroll = doc.querySelector(".settings-scroll");
    const settingsNavItems = [...doc.querySelectorAll(".settings-nav-item")];
    const settingsNavTargets = settingsNavItems
      .map((item) => {
        const id = settingsNavTargetFromHref(item.getAttribute("href"));
        return id ? { id, element: doc.getElementById(id) } : null;
      })
      .filter((entry) => entry && entry.element);
    const settingsNavTargetIds = new Set(
      settingsNavTargets.map((entry) => entry.id),
    );
    const statusStates = new Map();
    const promptDrafts = createPromptDrafts();
    let currentLanguage = DEFAULT_LANGUAGE;

    function renderStatus(element) {
      const state = statusStates.get(element);
      element.textContent = state
        ? translate(currentLanguage, state.key, state.params)
        : "";
    }

    function setStatus(element, key, params = {}) {
      statusStates.set(element, { key, params });
      renderStatus(element);
    }

    // Presentation-only: reflect whether each key is present. Reads the loaded
    // input values; never sends or logs the key itself.
    function setServiceBadge(badge, hasKey) {
      if (!badge) return;
      badge.textContent = translate(
        currentLanguage,
        hasKey ? "statusConfigured" : "statusNotConfigured",
      );
      badge.dataset.status = hasKey ? "configured" : "empty";
    }

    function updateServiceStatus() {
      setServiceBadge(deepseekStatus, Boolean(aiApiKeyInput.value.trim()));
      setServiceBadge(supadataStatus, Boolean(supadataApiKeyInput.value.trim()));
    }

    // Sticky save bar hint. Guarded so a keystroke does not re-announce the
    // same polite status on every character.
    function markUnsaved() {
      if (statusStates.get(saveStatus)?.key === "unsavedChanges") return;
      setStatus(saveStatus, "unsavedChanges");
    }

    function toggleKeyReveal(button) {
      const input = doc.getElementById(button.dataset.reveal);
      if (!input) return;
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.setAttribute("aria-pressed", String(reveal));
    }

    function applyLanguage(language) {
      const nextDraft = switchPromptDraft(
        promptDrafts,
        currentLanguage,
        language,
        customizationPrompt.value,
      );
      currentLanguage = nextDraft.language;
      doc.documentElement.lang = currentLanguage;
      doc.title = translate(currentLanguage, "pageTitle");

      for (const element of doc.querySelectorAll("[data-i18n]")) {
        element.textContent = translate(
          currentLanguage,
          element.dataset.i18n,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = translate(
          currentLanguage,
          element.dataset.i18nHtml,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute(
          "aria-label",
          translate(currentLanguage, element.dataset.i18nAriaLabel),
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-placeholder]")) {
        element.setAttribute(
          "placeholder",
          translate(currentLanguage, element.dataset.i18nPlaceholder),
        );
      }

      updateLocalizedPrompt(
        customizationPrompt,
        nextDraft.prompt,
      );
      updateLanguageButtonState(languageButtons, currentLanguage);
      for (const element of statusStates.keys()) renderStatus(element);
      // Re-apply the dynamic configured/not-configured badges after the static
      // data-i18n pass has reset them to the default label.
      updateServiceStatus();
    }

    async function loadSettings() {
      try {
        const stored = await storage.get(settingsApi.STORAGE_KEY);
        const migration = settingsApi.migrateLegacyCustom(
          stored[settingsApi.STORAGE_KEY],
        );
        const settings = migration.settings;

        aiApiKeyInput.value = settings.aiApiKey;
        supadataApiKeyInput.value = settings.supadataApiKey;
        updateServiceStatus();
        if (migration.migrated) {
          await storage.set({ [settingsApi.STORAGE_KEY]: settings });
          setStatus(saveStatus, "migrationWarning");
        }
      } catch (_error) {
        setStatus(saveStatus, "settingsLoadFailed");
      }
    }

    async function loadOptions() {
      try {
        applyLanguage(await readPreferredLanguage(storage));
      } catch (_error) {
        applyLanguage(DEFAULT_LANGUAGE);
      }
      await loadSettings();
      if (!statusStates.has(saveStatus)) {
        setStatus(saveStatus, "noUnsavedChanges");
      }
    }

    async function saveSettings(event) {
      event.preventDefault();
      setStatus(saveStatus, "saving");

      const settings = settingsApi.normalize({
        aiApiKey: aiApiKeyInput.value,
        supadataApiKey: supadataApiKeyInput.value,
      });

      if (!settings.aiApiKey) {
        setStatus(saveStatus, "addDeepseekKey");
        return;
      }

      try {
        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
        setStatus(saveStatus, "saved");
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
      }
    }

    async function copyCustomizationPrompt() {
      setStatus(copyStatus, "copying");
      try {
        await copyPromptValue(
          root.navigator.clipboard,
          customizationPrompt.value,
        );
        setStatus(copyStatus, "promptCopied");
      } catch (_error) {
        setStatus(copyStatus, "copyFailed");
      }
    }

    async function exportNotes() {
      setStatus(backupStatus, "exportingNotes");
      exportNotesBtn.disabled = true;
      try {
        const result = await root.chrome.runtime.sendMessage({
          action: "exportNotesBackup",
        });
        if (!result?.success) throw new Error(result?.code || "NOTES_EXPORT_FAILED");
        if (!result.count) {
          setStatus(backupStatus, "noNotesToExport");
          return;
        }
        triggerNotesBackupDownload(root, result.backup);
        setStatus(backupStatus, "notesExported", { count: result.count });
      } catch (_error) {
        setStatus(backupStatus, "notesExportFailed");
      } finally {
        exportNotesBtn.disabled = false;
      }
    }

    function openNotesImportPicker() {
      importNotesFile.value = "";
      importNotesFile.click();
    }

    async function importNotes(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      importNotesBtn.disabled = true;
      setStatus(backupStatus, "importingNotes");
      try {
        if (file.size > root.YTD_NOTES_BACKUP.MAX_BACKUP_BYTES) {
          setStatus(backupStatus, "notesBackupTooLarge");
          return;
        }
        const backupText = await file.text();
        if (
          root.YTD_NOTES_BACKUP.byteLength(backupText) >
          root.YTD_NOTES_BACKUP.MAX_BACKUP_BYTES
        ) {
          setStatus(backupStatus, "notesBackupTooLarge");
          return;
        }
        const result = await root.chrome.runtime.sendMessage({
          action: "importNotesBackup",
          backupText,
        });
        if (!result?.success) {
          setStatus(backupStatus, notesBackupErrorKey(result?.code), {
            overBy: result?.overBy || 0,
          });
          return;
        }
        if (!result.changed) {
          setStatus(backupStatus, "notesImportNoChanges", {
            duplicates: result.duplicateCount,
            total: result.totalCount,
          });
          return;
        }
        setStatus(backupStatus, "notesImported", {
          imported: result.importedCount,
          duplicates: result.duplicateCount,
          enriched: result.enrichedCount,
          total: result.totalCount,
        });
      } catch (_error) {
        setStatus(backupStatus, "notesImportFailed");
      } finally {
        importNotesBtn.disabled = false;
        importNotesFile.value = "";
      }
    }

    async function clearCachedDigests() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith("digest_"));
      if (keys.length) await storage.remove(keys);
      setStatus(dataStatus, "clearedDigests", { count: keys.length });
    }

    async function clearNotes() {
      try {
        const result = await root.chrome.runtime.sendMessage({
          action: "clearAllNotes",
        });
        setStatus(
          dataStatus,
          result?.success ? "notesDeleted" : "notesDeleteFailed",
        );
      } catch (_error) {
        setStatus(dataStatus, "notesDeleteFailed");
      }
    }

    async function resetAllData() {
      const confirmed = root.confirm(
        translate(currentLanguage, "resetConfirm"),
      );
      if (!confirmed) return;

      try {
        const result = await root.chrome.runtime.sendMessage({
          action: "resetAllExtensionData",
          preferredLanguage: currentLanguage,
        });
        if (!result?.success) {
          setStatus(dataStatus, "resetFailed");
          return;
        }
        await loadSettings();
        setStatus(dataStatus, "allDataDeleted");
      } catch (_error) {
        setStatus(dataStatus, "resetFailed");
      }
    }

    // Explicit navigation intent (nav click or hash change). While set, the
    // clicked section stays active through its smooth scroll and, at the bottom
    // where it cannot align to the top, wins over the passive scroll-spy default
    // instead of letting spy retreat to the previous section. Cleared once the
    // user scrolls away, so passive scroll-spy is never permanently suppressed.
    let pendingNavId = null;
    // Becomes true once the click-driven smooth scroll reaches its destination,
    // which lets us tell an in-progress scroll (hold the target) apart from a
    // later user scroll away from the anchored bottom (release the target).
    let pendingNavArrived = false;

    // Live geometry of the internal scroller: each section's top relative to the
    // scroller viewport, the viewport height, and whether the scroller is pinned
    // at its end (where trailing sections can never reach the activation line).
    function measureSettingsSections() {
      const scrollerTop = settingsScroll.getBoundingClientRect().top;
      const sections = settingsNavTargets.map(({ id, element }) => ({
        id,
        top: element.getBoundingClientRect().top - scrollerTop,
      }));
      const atBottom =
        settingsScroll.scrollTop + settingsScroll.clientHeight >=
        settingsScroll.scrollHeight - SETTINGS_NAV_BOTTOM_EPSILON;
      return { sections, atBottom, viewportHeight: settingsScroll.clientHeight };
    }

    function beginPendingNav(id) {
      pendingNavId = id;
      pendingNavArrived = false;
      applySettingsNavState(settingsNavItems, id);
    }

    // Scroll-spy scoped to the internal scroller. Reads live positions relative
    // to the scroller viewport so it stays correct regardless of window height.
    function syncActiveNavFromScroll() {
      if (!settingsScroll || !settingsNavTargets.length) return;
      const { sections, atBottom, viewportHeight } = measureSettingsSections();

      if (pendingNavId !== null) {
        if (!pendingNavArrived) {
          const pendingTop = sections.find(
            (section) => section.id === pendingNavId,
          )?.top;
          if (atBottom) {
            // Reached the end; the target is anchored as high as it can go.
            pendingNavArrived = true;
          } else if (
            typeof pendingTop === "number" &&
            pendingTop <= SETTINGS_NAV_ACTIVATION_OFFSET + 1
          ) {
            // The target aligned to the top on its own, so passive scroll-spy
            // already resolves to it; release the hold.
            pendingNavId = null;
            pendingNavArrived = false;
          } else {
            // Smooth scroll still settling toward the target: keep it active and
            // do not let scroll-spy retreat to an earlier section.
            return;
          }
        }
        if (pendingNavId !== null) {
          if (atBottom) {
            applySettingsNavState(
              settingsNavItems,
              resolveActiveSettingsSection(
                sections,
                SETTINGS_NAV_ACTIVATION_OFFSET,
                { atBottom, viewportHeight, preferredId: pendingNavId },
              ),
            );
            return;
          }
          // Anchored at the bottom, but the user has since scrolled away; hand
          // control back to passive scroll-spy.
          pendingNavId = null;
          pendingNavArrived = false;
        }
      }

      applySettingsNavState(
        settingsNavItems,
        resolveActiveSettingsSection(sections, SETTINGS_NAV_ACTIVATION_OFFSET, {
          atBottom,
          viewportHeight,
        }),
      );
    }

    // Resolve the active item from the URL hash (initial load and browser
    // back/forward hash changes). Returns false when the hash targets no
    // section so the caller can fall back to scroll position.
    function syncActiveNavFromHash() {
      const id = settingsNavTargetFromHref(root.location?.hash || "");
      if (!settingsNavTargetIds.has(id)) return false;
      beginPendingNav(id);
      return true;
    }

    if (settingsScroll && settingsNavTargets.length) {
      const scheduleFrame =
        typeof root.requestAnimationFrame === "function"
          ? root.requestAnimationFrame.bind(root)
          : (callback) => root.setTimeout(callback, 16);
      let scrollFrame = null;
      // Bounded listener: at most one measurement per animation frame.
      settingsScroll.addEventListener(
        "scroll",
        () => {
          if (scrollFrame !== null) return;
          scrollFrame = scheduleFrame(() => {
            scrollFrame = null;
            syncActiveNavFromScroll();
          });
        },
        { passive: true },
      );
      for (const item of settingsNavItems) {
        // Reflect the click immediately and remember it as navigation intent;
        // the anchor still performs its native hash navigation and smooth
        // scroll. The intent keeps the clicked item active through the scroll,
        // including near-bottom sections that cannot align to the top.
        item.addEventListener("click", () => {
          const id = settingsNavTargetFromHref(item.getAttribute("href"));
          if (settingsNavTargetIds.has(id)) {
            beginPendingNav(id);
          }
        });
      }
      root.addEventListener?.("hashchange", () => {
        if (!syncActiveNavFromHash()) syncActiveNavFromScroll();
      });
      if (!syncActiveNavFromHash()) syncActiveNavFromScroll();
    }

    form.addEventListener("submit", saveSettings);
    for (const input of [aiApiKeyInput, supadataApiKeyInput]) {
      input.addEventListener("input", () => {
        updateServiceStatus();
        markUnsaved();
      });
    }
    for (const button of revealToggles) {
      button.addEventListener("click", () => toggleKeyReveal(button));
    }
    copyCustomizationPromptBtn.addEventListener(
      "click",
      copyCustomizationPrompt,
    );
    exportNotesBtn.addEventListener("click", exportNotes);
    importNotesBtn.addEventListener("click", openNotesImportPicker);
    importNotesFile.addEventListener("change", importNotes);
    doc
      .getElementById("clearCacheBtn")
      .addEventListener("click", clearCachedDigests);
    doc.getElementById("clearNotesBtn").addEventListener("click", clearNotes);
    doc.getElementById("resetBtn").addEventListener("click", resetAllData);
    for (const button of languageButtons) {
      button.addEventListener("click", async () => {
        const language = button.dataset.language;
        applyLanguage(language);
        await persistPreferredLanguage(storage, language);
      });
    }

    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", loadOptions, { once: true });
    } else {
      void loadOptions();
    }
  }

  return {
    COPY,
    DEFAULT_LANGUAGE,
    LANGUAGE_STORAGE_KEY,
    copyPromptValue,
    createPromptDrafts,
    createStorageAdapter,
    normalizeLanguage,
    persistPreferredLanguage,
    readPreferredLanguage,
    notesBackupErrorKey,
    triggerNotesBackupDownload,
    translate,
    updateLanguageButtonState,
    updateLocalizedPrompt,
    switchPromptDraft,
    settingsNavTargetFromHref,
    resolveActiveSettingsSection,
    applySettingsNavState,
    initialize,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OPTIONS;
}

if (typeof document !== "undefined") {
  YTD_OPTIONS.initialize();
}
