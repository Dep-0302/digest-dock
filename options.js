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
      navNotes: "Notes & backup",
      navPrivacy: "Privacy",
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
        "Keys stay in this Chrome profile. You pick one AI provider and paste its API key to power AI features, and Supadata is the optional provider that fetches native captions for new YouTube videos. This open-source extension has no developer server or analytics.",
      supadataApiKeyLabel: "Supadata API key (optional)",
      supadataPlaceholder: "Paste your Supadata key",
      supadataHelp:
        "New YouTube captions are fetched through Supadata. It stays optional for the extension, but Supadata is called only after you confirm that one third-party request in the side panel, once per video. Bilibili does not use it. ",
      supadataLink: "Create a Supadata account and key",
      supadataHelpSuffix:
        ". Supadata generates the key during onboarding.",
      aiServiceName: "AI provider",
      providerLabel: "AI provider",
      providerListAriaLabel: "Choose an AI provider",
      providerUnavailable: "Unavailable",
      capabilitiesLabel: "Capabilities: ",
      capOverview: "Overview",
      capExplain: "Explanation",
      capTranslate: "Translation",
      capNotes: "Notes",
      aiKeyLabel: "API key",
      aiKeyPlaceholder: "Paste the selected provider's API key",
      aiKeyHelp:
        "The selected AI provider generates overviews, explanations, transcript translation, and note polishing. ",
      createKeyLink: "Create an API key",
      createKeyLinkSuffix: ".",
      providerPrivacyNote:
        "When you use AI features, the selected provider receives the video transcript and relevant video context. Review that provider's terms and pricing before saving.",
      saveSettings: "Save settings",
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
        "Your settings were upgraded to the multi-provider format. Saved keys were kept and mapped to their provider; endpoints and models now come from the built-in presets.",
      saving: "Saving…",
      addSupadataKey:
        "Add a Supadata API key to fetch native captions for new YouTube videos after per-attempt consent.",
      addAiKey: "Add an API key for the selected AI provider.",
      saved: "Saved. Reopen DigestDock to use these settings.",
      saveFailed: "Could not save settings. Please try again.",
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
      navNotes: "笔记与备份",
      navPrivacy: "隐私说明",
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
        "密钥仅保存在当前 Chrome 个人资料中。你选择一个 AI 服务商并填写它的 API 密钥用于 AI 功能，Supadata 是可选服务，用于为新的 YouTube 视频获取原生字幕。本开源扩展没有开发者服务器，也不使用分析服务。",
      supadataApiKeyLabel: "Supadata API 密钥（可选）",
      supadataPlaceholder: "粘贴 Supadata 密钥",
      supadataHelp:
        "新的 YouTube 字幕由 Supadata 获取。它对整个扩展仍是可选配置，但只有你在侧边栏确认本次使用第三方 Supadata 时才会调用，且逐视频授权；B 站不会使用。",
      supadataLink: "创建 Supadata 账号并获取密钥",
      supadataHelpSuffix: "。Supadata 会在引导流程中生成密钥。",
      aiServiceName: "AI 服务商",
      providerLabel: "AI 服务商",
      providerListAriaLabel: "选择 AI 服务商",
      providerUnavailable: "暂不可用",
      capabilitiesLabel: "支持能力：",
      capOverview: "概览",
      capExplain: "讲解",
      capTranslate: "翻译",
      capNotes: "笔记",
      aiKeyLabel: "API 密钥",
      aiKeyPlaceholder: "粘贴当前服务的 API 密钥",
      aiKeyHelp:
        "所选 AI 服务用于生成概览、解释内容、翻译字幕和润色笔记。",
      createKeyLink: "前往创建 API 密钥",
      createKeyLinkSuffix: "。",
      providerPrivacyNote:
        "使用 AI 功能时，所选服务会收到视频字幕及相关视频上下文。保存前请查看该服务的服务条款和价格。",
      saveSettings: "保存设置",
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
        "设置已升级为多服务商格式。已保存的密钥被保留并归入各自服务商；Endpoint 和模型现在由内置预设提供。",
      saving: "正在保存…",
      addSupadataKey:
        "为新的 YouTube 视频获取原生字幕，请添加可选的 Supadata API 密钥（每次逐一授权）。",
      addAiKey: "请为所选 AI 服务商添加 API 密钥。",
      saved: "已保存。请重新打开 DigestDock 以使用这些设置。",
      saveFailed: "无法保存设置，请重试。",
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

  // A short brand monogram used as the neutral icon placeholder until an
  // official brand icon is bundled (see icons/providers/PROVENANCE.md). Prefers
  // the first Latin letter of the display name so mixed CJK names still get a
  // readable, wrong-provider-proof glyph.
  function providerMonogram(displayName) {
    const name = String(displayName || "").trim();
    const latin = name.match(/[A-Za-z]/);
    return (latin ? latin[0] : name.charAt(0) || "?").toUpperCase();
  }

  // Sets a local brand icon on an <img>/monogram pair. The icon is only ever a
  // bundled local path; on load it replaces the monogram, on error (e.g. the
  // official asset is not yet bundled) it stays hidden so the neutral monogram
  // remains — never a remote or wrong-provider image.
  function applyProviderIcon(img, monogramEl, provider) {
    const monogram = providerMonogram(provider.displayName);
    if (monogramEl) monogramEl.textContent = monogram;
    if (!img) return;
    if (!provider.iconPath || /^[a-z]+:|^\/\//i.test(provider.iconPath)) {
      img.hidden = true;
      return;
    }
    img.alt = provider.iconAlt || provider.displayName;
    img.onload = () => {
      img.hidden = false;
      if (monogramEl) monogramEl.hidden = true;
    };
    img.onerror = () => {
      img.hidden = true;
      if (monogramEl) monogramEl.hidden = false;
    };
    img.hidden = true;
    if (monogramEl) monogramEl.hidden = false;
    img.src = provider.iconPath;
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
    const providersApi = root.YTD_AI_PROVIDERS;
    const form = doc.getElementById("settingsForm");
    const aiApiKeyInput = doc.getElementById("aiApiKey");
    const supadataApiKeyInput = doc.getElementById("supadataApiKey");
    const saveStatus = doc.getElementById("saveStatus");
    const dataStatus = doc.getElementById("dataStatus");
    const backupStatus = doc.getElementById("backupStatus");
    const exportNotesBtn = doc.getElementById("exportNotesBtn");
    const importNotesBtn = doc.getElementById("importNotesBtn");
    const importNotesFile = doc.getElementById("importNotesFile");
    const languageButtons = [...doc.querySelectorAll("[data-language]")];
    const aiStatus = doc.getElementById("aiStatus");
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

    // Provider picker DOM (a custom ARIA select-only combobox; the plan forbids
    // a native <select> because option rows carry brand icons).
    const providerSelectButton = doc.getElementById("providerSelectButton");
    const providerSelectList = doc.getElementById("providerSelectList");
    const providerSelectValue = doc.getElementById("providerSelectValue");
    const providerSelectAvatarImg = providerSelectButton
      ? providerSelectButton.querySelector(".provider-select-avatar-img")
      : null;
    const providerSelectMonogram = providerSelectButton
      ? providerSelectButton.querySelector(".provider-monogram")
      : null;
    const providerAvatarImg = doc.getElementById("providerAvatarImg");
    const providerAvatarMonogram = doc.getElementById("providerAvatarMonogram");
    const providerModelLabel = doc.getElementById("providerModelLabel");
    const providerCapabilities = doc.getElementById("providerCapabilities");
    const providerHelpLink = doc.getElementById("providerHelpLink");

    const providerList = providersApi
      ? providersApi.listProviderDescriptions()
      : [];
    const selectableProviderList = providerList.filter(
      (provider) => provider.selectable && provider.configVerified,
    );
    const CAP_LABEL_KEYS = {
      overview: "capOverview",
      explain: "capExplain",
      translate: "capTranslate",
      notes: "capNotes",
    };

    const statusStates = new Map();
    let currentLanguage = DEFAULT_LANGUAGE;
    // Per-provider key drafts so switching providers never loses an unsaved key
    // typed for another provider. Seeded from storage, updated on every input.
    const providerKeyDrafts = {};
    let currentProviderId =
      selectableProviderList[0]?.id || settingsApi.DEFAULT_PROVIDER || "deepseek";
    let providerListOpen = false;

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

    function currentProvider() {
      return (
        providerList.find((provider) => provider.id === currentProviderId) ||
        selectableProviderList[0] ||
        null
      );
    }

    function updateServiceStatus() {
      setServiceBadge(aiStatus, Boolean(aiApiKeyInput.value.trim()));
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

    // Renders the capability pills for the active provider. Text labels (not
    // color) carry the meaning, so the limits read in high-contrast modes.
    function renderProviderCapabilities(provider) {
      if (!providerCapabilities) return;
      providerCapabilities.textContent = "";
      for (const capability of provider?.capabilities || []) {
        const key = CAP_LABEL_KEYS[capability];
        if (!key) continue;
        const pill = doc.createElement("span");
        pill.className = "capability-tag";
        pill.textContent = translate(currentLanguage, key);
        providerCapabilities.appendChild(pill);
      }
    }

    // Reflects the active provider across the service card and the combobox
    // button. Never issues a network request.
    function renderActiveProvider() {
      const provider = currentProvider();
      if (!provider) return;
      if (providerSelectValue) providerSelectValue.textContent = provider.displayName;
      if (providerModelLabel) {
        providerModelLabel.textContent = provider.modelLabel || provider.model || "";
      }
      applyProviderIcon(providerSelectAvatarImg, providerSelectMonogram, provider);
      applyProviderIcon(providerAvatarImg, providerAvatarMonogram, provider);
      renderProviderCapabilities(provider);
      if (providerHelpLink && provider.apiKeyHelpUrl) {
        providerHelpLink.href = provider.apiKeyHelpUrl;
      }
      // Mark the matching listbox option selected.
      if (providerSelectList) {
        for (const option of providerSelectList.querySelectorAll('[role="option"]')) {
          option.setAttribute(
            "aria-selected",
            String(option.dataset.provider === provider.id),
          );
        }
      }
    }

    function buildProviderList() {
      if (!providerSelectList) return;
      providerSelectList.textContent = "";
      for (const provider of providerList) {
        const option = doc.createElement("li");
        option.id = `provider-option-${provider.id}`;
        option.className = "provider-option";
        option.setAttribute("role", "option");
        option.dataset.provider = provider.id;
        option.setAttribute(
          "aria-selected",
          String(provider.id === currentProviderId),
        );
        const selectable = provider.selectable && provider.configVerified;
        if (!selectable) {
          option.classList.add("is-disabled");
          option.setAttribute("aria-disabled", "true");
          option.title = provider.blockedReason || translate(
            currentLanguage,
            "providerUnavailable",
          );
        }

        const avatar = doc.createElement("span");
        avatar.className = "provider-option-avatar";
        avatar.setAttribute("aria-hidden", "true");
        const img = doc.createElement("img");
        img.className = "provider-option-avatar-img";
        img.hidden = true;
        const monogram = doc.createElement("span");
        monogram.className = "provider-monogram";
        avatar.appendChild(img);
        avatar.appendChild(monogram);
        applyProviderIcon(img, monogram, provider);

        const name = doc.createElement("span");
        name.className = "provider-option-name";
        name.textContent = provider.displayName;

        if (!selectable) {
          const state = doc.createElement("span");
          state.className = "provider-option-state";
          state.textContent = translate(currentLanguage, "providerUnavailable");
          name.appendChild(state);
        }

        option.appendChild(avatar);
        option.appendChild(name);
        option.addEventListener("click", () => {
          if (!selectable) return;
          selectProvider(provider.id);
          closeProviderList({ focusButton: true });
        });
        providerSelectList.appendChild(option);
      }
    }

    function selectProvider(id, { markDirty = true } = {}) {
      if (!selectableProviderList.some((provider) => provider.id === id)) return;
      if (id !== currentProviderId) {
        // Preserve whatever the user typed for the outgoing provider.
        providerKeyDrafts[currentProviderId] = aiApiKeyInput.value;
        currentProviderId = id;
        aiApiKeyInput.value = providerKeyDrafts[id] || "";
        if (markDirty) markUnsaved();
      }
      renderActiveProvider();
      updateServiceStatus();
    }

    function providerOptionEls() {
      return providerSelectList
        ? [...providerSelectList.querySelectorAll('[role="option"]')]
        : [];
    }

    function setActiveOption(id) {
      const options = providerOptionEls();
      for (const option of options) {
        option.classList.toggle("is-active", option.dataset.provider === id);
      }
      if (providerSelectButton) {
        providerSelectButton.setAttribute(
          "aria-activedescendant",
          id ? `provider-option-${id}` : "",
        );
      }
    }

    function openProviderList() {
      if (!providerSelectList || providerListOpen || !selectableProviderList.length) return;
      const triggerRect = providerSelectButton.getBoundingClientRect?.();
      const saveBarTop = doc
        .querySelector(".settings-savebar")
        ?.getBoundingClientRect?.().top;
      const topBarBottom = doc
        .querySelector(".settings-topbar")
        ?.getBoundingClientRect?.().bottom;
      const lowerBoundary = Number.isFinite(saveBarTop)
        ? saveBarTop
        : root.innerHeight || 0;
      const below = triggerRect
        ? Math.max(0, lowerBoundary - triggerRect.bottom - 8)
        : 0;
      const upperBoundary = Number.isFinite(topBarBottom) ? topBarBottom : 0;
      const above = triggerRect
        ? Math.max(0, triggerRect.top - upperBoundary - 8)
        : 0;
      const preferredHeight = Math.min(320, providerList.length * 44 + 12);
      const openUp = below < 160 && above > below;
      providerSelectList.classList.toggle("opens-up", openUp);
      const available = openUp ? above : below;
      providerSelectList.style.maxHeight = `${Math.max(
        120,
        Math.min(preferredHeight, available || preferredHeight),
      )}px`;
      providerListOpen = true;
      providerSelectList.hidden = false;
      providerSelectButton.setAttribute("aria-expanded", "true");
      setActiveOption(currentProviderId);
    }

    function closeProviderList({ focusButton = false } = {}) {
      if (!providerSelectList) return;
      providerListOpen = false;
      providerSelectList.hidden = true;
      providerSelectButton.setAttribute("aria-expanded", "false");
      providerSelectButton.setAttribute("aria-activedescendant", "");
      if (focusButton && typeof providerSelectButton.focus === "function") {
        providerSelectButton.focus();
      }
    }

    function activeOptionId() {
      const current = providerOptionEls().find((option) =>
        option.classList.contains("is-active"),
      );
      return current ? current.dataset.provider : currentProviderId;
    }

    function moveActiveOption(delta) {
      const ids = selectableProviderList.map((provider) => provider.id);
      if (!ids.length) return;
      const currentIndex = Math.max(0, ids.indexOf(activeOptionId()));
      const nextIndex = Math.min(
        ids.length - 1,
        Math.max(0, currentIndex + delta),
      );
      setActiveOption(ids[nextIndex]);
    }

    function handleProviderButtonKeydown(event) {
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp":
          event.preventDefault();
          if (!providerListOpen) {
            openProviderList();
          } else {
            moveActiveOption(event.key === "ArrowDown" ? 1 : -1);
          }
          break;
        case "Home":
          if (providerListOpen) {
            event.preventDefault();
            setActiveOption(selectableProviderList[0]?.id);
          }
          break;
        case "End":
          if (providerListOpen) {
            event.preventDefault();
            setActiveOption(
              selectableProviderList[selectableProviderList.length - 1]?.id,
            );
          }
          break;
        case "Enter":
        case " ":
        case "Spacebar":
          event.preventDefault();
          if (!providerListOpen) {
            openProviderList();
          } else {
            selectProvider(activeOptionId());
            closeProviderList({ focusButton: true });
          }
          break;
        case "Escape":
          if (providerListOpen) {
            event.preventDefault();
            closeProviderList({ focusButton: true });
          }
          break;
        default:
          break;
      }
    }

    function applyLanguage(language) {
      currentLanguage = normalizeLanguage(language);
      doc.documentElement.lang = currentLanguage;
      doc.title = translate(currentLanguage, "pageTitle");

      for (const element of doc.querySelectorAll("[data-i18n]")) {
        element.textContent = translate(currentLanguage, element.dataset.i18n);
      }
      for (const element of doc.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = translate(currentLanguage, element.dataset.i18nHtml);
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
      if (providerSelectList) {
        providerSelectList.setAttribute(
          "aria-label",
          translate(currentLanguage, "providerListAriaLabel"),
        );
      }

      updateLanguageButtonState(languageButtons, currentLanguage);
      for (const element of statusStates.keys()) renderStatus(element);
      // Re-render dynamic provider text and badges after the static data-i18n
      // pass reset any shared nodes to their default labels.
      if (providerSelectList) buildProviderList();
      renderActiveProvider();
      updateServiceStatus();
    }

    async function loadSettings() {
      try {
        const stored = await storage.get(settingsApi.STORAGE_KEY);
        const migration = settingsApi.migrateLegacy(
          stored[settingsApi.STORAGE_KEY],
        );
        const settings = migration.settings;

        for (const id of settingsApi.AI_PROVIDER_IDS) {
          providerKeyDrafts[id] = settingsApi.apiKeyFor(settings, id);
        }
        currentProviderId = selectableProviderList.some(
          (provider) => provider.id === settings.provider,
        )
          ? settings.provider
          : selectableProviderList[0]?.id || currentProviderId;
        aiApiKeyInput.value = providerKeyDrafts[currentProviderId] || "";
        supadataApiKeyInput.value = settings.supadataApiKey;
        renderActiveProvider();
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

      // Persist the whole key map in one write: the visible input holds the
      // active provider's key, the drafts hold the others entered this session.
      providerKeyDrafts[currentProviderId] = aiApiKeyInput.value;
      const aiApiKeys = {};
      for (const id of settingsApi.AI_PROVIDER_IDS) {
        aiApiKeys[id] = providerKeyDrafts[id] || "";
      }
      const settings = settingsApi.normalize({
        provider: currentProviderId,
        aiApiKeys,
        supadataApiKey: supadataApiKeyInput.value,
      });

      if (!settingsApi.hasActiveApiKey(settings)) {
        setStatus(saveStatus, "addAiKey");
        return;
      }

      try {
        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
        setStatus(saveStatus, "saved");
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
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

    function scrollSettingsSectionIntoView(id, behavior = "smooth") {
      const target = settingsNavTargets.find((entry) => entry.id === id)?.element;
      if (!settingsScroll || !target) return;
      const scrollerTop = settingsScroll.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      const top = Math.max(
        0,
        settingsScroll.scrollTop + targetTop - scrollerTop - 12,
      );
      if (typeof settingsScroll.scrollTo === "function") {
        settingsScroll.scrollTo({ top, behavior });
      } else {
        settingsScroll.scrollTop = top;
      }
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
    function syncActiveNavFromHash({ scroll = false, behavior = "smooth" } = {}) {
      const id = settingsNavTargetFromHref(root.location?.hash || "");
      if (!settingsNavTargetIds.has(id)) return false;
      beginPendingNav(id);
      if (scroll) scrollSettingsSectionIntoView(id, behavior);
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
        // Drive the internal scroller explicitly. Native fragment navigation
        // does not reliably restore an element inside a nested overflow area on
        // reload, which can otherwise leave the hash/highlight out of sync with
        // the visible section.
        item.addEventListener("click", (event) => {
          const id = settingsNavTargetFromHref(item.getAttribute("href"));
          if (settingsNavTargetIds.has(id)) {
            event.preventDefault();
            beginPendingNav(id);
            if (root.location?.hash !== `#${id}`) {
              root.history?.pushState?.(null, "", `#${id}`);
            }
            scrollSettingsSectionIntoView(id);
          }
        });
      }
      root.addEventListener?.("hashchange", () => {
        if (!syncActiveNavFromHash({ scroll: true })) syncActiveNavFromScroll();
      });
      if (syncActiveNavFromHash()) {
        scheduleFrame(() => {
          const id = settingsNavTargetFromHref(root.location?.hash || "");
          if (settingsNavTargetIds.has(id)) {
            scrollSettingsSectionIntoView(id, "auto");
          }
        });
      } else {
        syncActiveNavFromScroll();
      }
    }

    form.addEventListener("submit", saveSettings);
    aiApiKeyInput.addEventListener("input", () => {
      // Keep the active provider's draft in step so a later switch-and-return
      // shows what the user typed.
      providerKeyDrafts[currentProviderId] = aiApiKeyInput.value;
      updateServiceStatus();
      markUnsaved();
    });
    supadataApiKeyInput.addEventListener("input", () => {
      updateServiceStatus();
      markUnsaved();
    });
    for (const button of revealToggles) {
      button.addEventListener("click", () => toggleKeyReveal(button));
    }

    // Provider combobox wiring. Building the list, opening/closing, keyboard
    // navigation, and outside-click dismissal all stay local: no network call.
    if (providerSelectButton && providerSelectList) {
      buildProviderList();
      providerSelectButton.addEventListener("click", () => {
        if (providerListOpen) closeProviderList({ focusButton: true });
        else openProviderList();
      });
      providerSelectButton.addEventListener(
        "keydown",
        handleProviderButtonKeydown,
      );
      doc.addEventListener("click", (event) => {
        if (!providerListOpen) return;
        const container = doc.getElementById("providerSelect");
        if (container && !container.contains(event.target)) {
          closeProviderList();
        }
      });
    }

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
    createStorageAdapter,
    normalizeLanguage,
    persistPreferredLanguage,
    readPreferredLanguage,
    notesBackupErrorKey,
    triggerNotesBackupDownload,
    translate,
    updateLanguageButtonState,
    providerMonogram,
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
