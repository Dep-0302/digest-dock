const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function createLocalStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("Settings copy covers English and Simplified Chinese", () => {
  assert.equal(options.translate("en", "pageTitle"), "DigestDock Settings");
  assert.equal(options.translate("zh-CN", "pageTitle"), "DigestDock 设置");
  assert.equal(options.translate("en", "saveSettings"), "Save settings");
  assert.equal(options.translate("zh-CN", "saveSettings"), "保存设置");
  assert.equal(options.translate("en", "navServices"), "Optional services");
  assert.equal(options.translate("zh-CN", "navServices"), "扩展服务");
  assert.equal(
    options.translate("zh-CN", "clearedDigests", { count: 2 }),
    "已清除 2 条缓存摘要。",
  );

  assert.deepEqual(
    Object.keys(options.COPY.en).sort(),
    Object.keys(options.COPY["zh-CN"]).sort(),
  );

  const html = read("options.html");
  const referencedKeys = [
    ...html.matchAll(/data-i18n(?:-html|-aria-label|-placeholder)?="([^"]+)"/g),
  ].map((match) => match[1]);
  for (const key of referencedKeys) {
    assert.ok(options.COPY.en[key], `Missing English copy for ${key}`);
    assert.ok(options.COPY["zh-CN"][key], `Missing Chinese copy for ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(options.COPY), /—/);
  assert.doesNotMatch(html, /—/);
});

test("language preference persists through extension-compatible storage", async () => {
  const storedValues = {};
  const chromeApi = {
    storage: {
      local: {
        async get(key) {
          return Object.hasOwn(storedValues, key)
            ? { [key]: storedValues[key] }
            : {};
        },
        async set(items) {
          Object.assign(storedValues, items);
        },
        async remove() {},
        async clear() {},
      },
    },
  };
  const storage = options.createStorageAdapter(chromeApi);

  await options.persistPreferredLanguage(storage, "zh-CN");

  assert.equal(storedValues[options.LANGUAGE_STORAGE_KEY], "zh-CN");
  assert.equal(await options.readPreferredLanguage(storage), "zh-CN");
});

test("non-extension preview safely persists language in localStorage", async () => {
  const localStorage = createLocalStorage();
  const firstSession = options.createStorageAdapter(null, localStorage);

  await options.persistPreferredLanguage(firstSession, "zh-CN");

  const reopenedSession = options.createStorageAdapter(null, localStorage);
  assert.equal(await options.readPreferredLanguage(reopenedSession), "zh-CN");
  assert.equal(options.DEFAULT_LANGUAGE, "zh-CN");
  assert.equal(options.normalizeLanguage("unsupported"), "zh-CN");
});

test("language controls expose a labelled group and one pressed button", () => {
  const html = read("options.html");
  assert.match(
    html,
    /class="language-switch"[\s\S]*role="group"[\s\S]*aria-label="界面语言"/,
  );
  assert.match(
    html,
    /data-language="en"[\s\S]*aria-pressed="false"[\s\S]*English/,
  );
  assert.match(
    html,
    /data-language="zh-CN"[\s\S]*aria-pressed="true"[\s\S]*中文/,
  );

  const buttons = ["en", "zh-CN"].map((language) => ({
    dataset: { language },
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  }));
  options.updateLanguageButtonState(buttons, "zh-CN");

  assert.equal(buttons[0].attributes["aria-pressed"], "false");
  assert.equal(buttons[1].attributes["aria-pressed"], "true");
});

test("notes backup controls are accessible and explain the notes-only JSON scope", () => {
  const html = read("options.html");
  const backupCard = html.match(
    /<section class="card" id="notesBackupCard">([\s\S]*?)<\/section>/,
  );

  assert.ok(backupCard, "Expected a dedicated notes backup card");
  assert.match(backupCard[1], /id="notesBackupHelp"/);
  assert.match(
    backupCard[1],
    /id="exportNotesBtn"[\s\S]*?type="button"[\s\S]*?aria-describedby="notesBackupHelp"/,
  );
  assert.match(
    backupCard[1],
    /id="importNotesBtn"[\s\S]*?type="button"[\s\S]*?aria-describedby="notesBackupHelp"/,
  );
  assert.match(
    backupCard[1],
    /id="importNotesFile"[\s\S]*?type="file"[\s\S]*?accept="\.json,application\/json"[\s\S]*?hidden/,
  );
  assert.match(
    backupCard[1],
    /id="backupStatus"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/,
  );

  for (const language of ["en", "zh-CN"]) {
    const help = options.translate(language, "notesBackupHelp");
    assert.match(help, /JSON/i);
    assert.match(
      help,
      language === "en" ? /contains saved notes/i : /只包含已保存笔记/,
    );
    assert.match(help, language === "en" ? /API keys/i : /API 密钥/);
  }
});

test("the AI service card exposes an accessible provider combobox, not a native select", () => {
  const html = read("options.html");
  const script = read("options.js");

  // The provider picker is an ARIA combobox/listbox (a native <select> cannot
  // reliably render the per-option official brand icons), with a labelled
  // trigger and a hidden, labelled listbox.
  assert.doesNotMatch(html, /<select\b/i);
  assert.match(
    html,
    /id="providerSelectButton"[\s\S]*?role="combobox"[\s\S]*?aria-haspopup="listbox"[\s\S]*?aria-expanded="false"[\s\S]*?aria-controls="providerSelectList"/,
  );
  assert.match(
    html,
    /id="providerSelectButton"[\s\S]*?aria-labelledby="providerSelectLabel providerSelectButton"/,
  );
  assert.match(
    html,
    /id="providerSelectList"[\s\S]*?role="listbox"[\s\S]*?aria-labelledby="providerSelectLabel"[\s\S]*?tabindex="-1"[\s\S]*?hidden/,
  );
  // The presentation list carries all six official icons. Unverified entries
  // remain visible but disabled and can never become the active provider.
  assert.match(script, /listProviderDescriptions\(\)/);
  assert.match(script, /aria-disabled/);
  assert.match(script, /providerUnavailable/);
  assert.match(script, /if \(!selectable\) return;/);
  assert.match(script, /providerSelectList\.classList\.toggle\([\s\S]*?"opens-up"/);

  // The service avatar and the trigger both keep an <img>/monogram pair so a
  // missing official asset falls back to a neutral glyph, never a wrong icon.
  assert.match(
    html,
    /id="providerAvatarImg"[^>]*src="icons\/providers\/deepseek\.png"[^>]*alt="DeepSeek"/,
  );
  assert.match(html, /id="providerAvatarMonogram"[^>]*hidden/);
  assert.match(
    html,
    /class="provider-select-avatar-img"[^>]*src="icons\/providers\/deepseek\.png"[^>]*alt="DeepSeek"/,
  );
  assert.match(html, /class="provider-monogram"[^>]*hidden/);

  // Capabilities are shown as text next to the model label, not colour alone.
  assert.match(html, /data-i18n="capabilitiesLabel"/);
  assert.match(html, /id="providerCapabilities"/);
  assert.match(html, /id="providerModelLabel"/);
});

test("the key field is provider-neutral with a runtime create-key link", () => {
  const html = read("options.html");

  // No provider name is baked into the key input; the placeholder, help text,
  // and create-key link are all driven by the selected provider at runtime.
  const keyInput = html.match(/<input[\s\S]*?id="aiApiKey"[\s\S]*?>/)?.[0];
  assert.ok(keyInput, "Expected the AI key input");
  assert.match(keyInput, /data-i18n-placeholder="aiKeyPlaceholder"/);
  assert.doesNotMatch(keyInput, /DeepSeek/);
  assert.match(html, /id="providerHelpLink"[\s\S]*?data-i18n="createKeyLink"/);
  assert.match(html, /id="providerHelpText"[\s\S]*?data-i18n="aiKeyHelp"/);
  // No free-form endpoint, model, or legacy provider text inputs are exposed.
  assert.doesNotMatch(html, /id="(?:provider|aiBaseUrl|aiModel)"/);

  for (const language of ["en", "zh-CN"]) {
    assert.doesNotMatch(options.translate(language, "aiKeyPlaceholder"), /DeepSeek/);
  }
});

test("the provider monogram stays a readable, wrong-provider-proof glyph", () => {
  assert.equal(options.providerMonogram("DeepSeek"), "D");
  assert.equal(options.providerMonogram("智谱 GLM"), "G");
  assert.equal(options.providerMonogram("阿里云百炼 Qwen"), "Q");
  assert.equal(options.providerMonogram("Fireworks"), "F");
  assert.equal(options.providerMonogram(""), "?");
});

test("free mode and Supadata-only settings save without an AI key", () => {
  const html = read("options.html");
  const optionsScript = read("options.js");

  const supadataInput = html.match(
    /<input[\s\S]*?id="supadataApiKey"[\s\S]*?>/,
  )?.[0];
  assert.ok(supadataInput, "Expected the optional Supadata input");
  assert.doesNotMatch(supadataInput, /\srequired(?:\s|=|>)/i);
  assert.match(options.translate("en", "supadataApiKeyLabel"), /optional/i);
  assert.match(options.translate("zh-CN", "supadataApiKeyLabel"), /可选/);
  assert.match(
    options.translate("en", "supadataHelp"),
    /every Supadata request[\s\S]*new confirmation/i,
  );
  assert.match(
    options.translate("zh-CN", "supadataHelp"),
    /每次使用 Supadata[\s\S]*重新确认/,
  );

  const saveSettings = optionsScript.match(
    /async function saveSettings\(event\)[\s\S]*?\n    }/,
  )?.[0];
  assert.ok(saveSettings, "Expected the Settings save handler");
  // Saving is allowed with no AI key so the free core, Supadata-only setup,
  // and clearing the final stored key all remain possible.
  assert.match(saveSettings, /buildSettingsDraft\(settingsApi/);
  assert.match(saveSettings, /if \(!settingsLoaded\)/);
  assert.ok(
    saveSettings.indexOf("if (!settingsLoaded)") <
      saveSettings.indexOf("buildSettingsDraft(settingsApi"),
    "failed settings reads must stop before a replacement key map is built",
  );
  assert.doesNotMatch(saveSettings, /hasActiveApiKey\(settings\)/);
  assert.doesNotMatch(saveSettings, /settings\.aiApiKey\b/);
  assert.match(
    html,
    /id="saveSettingsBtn"[\s\S]*?type="submit"[\s\S]*?disabled/,
  );
  assert.match(
    optionsScript,
    /settingsLoaded = true[\s\S]*?saveSettingsBtn\.disabled = false/,
  );

  const settingsApi = require("../settings.js");
  const supadataOnly = options.buildSettingsDraft(settingsApi, {
    providerId: "deepseek",
    providerKeyDrafts: {},
    activeApiKey: "",
    supadataApiKey: "  supadata-only  ",
  });
  assert.equal(settingsApi.hasActiveApiKey(supadataOnly), false);
  assert.equal(supadataOnly.supadataApiKey, "supadata-only");

  const allEmpty = options.buildSettingsDraft(settingsApi, {
    providerId: "zhipu",
    providerKeyDrafts: { deepseek: "keep-deepseek" },
    activeApiKey: "",
    supadataApiKey: "",
  });
  assert.equal(allEmpty.provider, "zhipu");
  assert.equal(allEmpty.aiApiKeys.zhipu, "");
  assert.equal(allEmpty.aiApiKeys.deepseek, "keep-deepseek");
  assert.equal(allEmpty.supadataApiKey, "");
  assert.match(options.translate("en", "fieldRequired"), /AI/i);
  assert.match(options.translate("zh-CN", "fieldRequired"), /AI 功能/);
  assert.match(options.translate("en", "lede"), /No API key/i);
  assert.match(options.translate("zh-CN", "lede"), /无需 API 密钥/);
});
