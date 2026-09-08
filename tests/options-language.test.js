const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const options = require("../options.js");
const notesBackup = require("../notes-backup.js");

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

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createFakeOptionsElement(id = "") {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    dataset: {},
    style: {},
    disabled: false,
    hidden: false,
    files: [],
    classList: {
      add(name) {
        classes.add(name);
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        const active = force === undefined ? !classes.has(name) : Boolean(force);
        if (active) classes.add(name);
        else classes.delete(name);
        return active;
      },
    },
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener(type, listener) {
      const registered = listeners.get(type) || [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    async dispatch(type, event = {}) {
      const dispatched = {
        preventDefault() {},
        target: this,
        ...event,
      };
      await Promise.all(
        (listeners.get(type) || []).map((listener) => listener(dispatched)),
      );
    },
    appendChild() {},
    contains() {
      return false;
    },
    focus() {},
    click() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

async function flushOptionsRuntime() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function createOptionsResetRuntimeFixture({ initialSettings } = {}) {
  const settingsApi = require("../settings.js");
  const elements = new Map();
  const stored = {
    [options.LANGUAGE_STORAGE_KEY]: "zh-CN",
  };
  if (initialSettings) stored[settingsApi.STORAGE_KEY] = initialSettings;
  let settingsReadCount = 0;
  let dataGeneration = 0;
  const runtimeInstanceId = "runtime-options-reset";
  const messageListeners = [];

  const element = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeOptionsElement(id));
    return elements.get(id);
  };
  const document = {
    readyState: "complete",
    documentElement: { lang: "" },
    title: "",
    body: createFakeOptionsElement("body"),
    getElementById: element,
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return createFakeOptionsElement();
    },
    addEventListener() {},
  };

  const broadcast = (action, generation = dataGeneration) => {
    const message = {
      action,
      runtimeInstanceId,
      dataGeneration: generation,
    };
    for (const listener of messageListeners) listener(message, {}, () => {});
  };

  const storage = {
    async get(keys) {
      if (keys === settingsApi.STORAGE_KEY) settingsReadCount += 1;
      if (keys === null) return { ...stored };
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => Object.hasOwn(stored, key))
          .map((key) => [key, stored[key]]),
      );
    },
    async set(items) {
      Object.assign(stored, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
    },
    async clear() {
      for (const key of Object.keys(stored)) delete stored[key];
    },
  };

  const root = {
    document,
    location: { hash: "", search: "" },
    confirm: () => true,
    YTD_SETTINGS: settingsApi,
    chrome: {
      storage: { local: storage },
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListeners.push(listener);
          },
        },
        async sendMessage(message) {
          if (message.action === "checkConfig") {
            return { runtimeInstanceId, dataGeneration };
          }
          if (message.action === "resetAllExtensionData") {
            dataGeneration += 1;
            broadcast("extensionDataResetStarted");
            await storage.clear();
            await storage.set({
              [options.LANGUAGE_STORAGE_KEY]: message.preferredLanguage,
            });
            dataGeneration += 1;
            broadcast("extensionDataResetCompleted");
            return {
              success: true,
              runtimeInstanceId,
              dataGeneration,
            };
          }
          throw new Error(`Unexpected options message: ${message.action}`);
        },
      },
    },
  };

  options.initialize(root);
  await flushOptionsRuntime();

  return {
    broadcast(action, generation) {
      dataGeneration = generation;
      broadcast(action, generation);
    },
    element,
    get settingsReadCount() {
      return settingsReadCount;
    },
    replaceSettings(nextSettings) {
      stored[settingsApi.STORAGE_KEY] = nextSettings;
    },
    settingsApi,
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
  const maxMiB = options.backupLimitMiB({ YTD_NOTES_BACKUP: notesBackup });
  assert.equal(maxMiB, "32");
  assert.equal(Object.hasOwn(options.COPY.en, "notesBackupCapacity"), false);
  assert.equal(Object.hasOwn(options.COPY["zh-CN"], "notesBackupCapacity"), false);
  assert.match(
    options.translate("en", "notesBackupTooLarge", { maxMiB }),
    /32 MiB/,
  );
  assert.match(
    options.translate("zh-CN", "notesBackupTooLarge", { maxMiB }),
    /32 MiB/,
  );
  assert.match(
    options.translate("en", "notesExportTooLarge", { maxMiB }),
    /32 MiB/,
  );
  assert.match(
    options.translate("zh-CN", "notesExportTooLarge", { maxMiB }),
    /32 MiB/,
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
    /settingsLoaded = true[\s\S]*?syncMutationControls\(\)/,
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

test("options freeze one writable data generation across reset boundaries", () => {
  const fence = options.createExtensionDataFence();
  assert.equal(fence.capture(), null, "unknown background state must fail closed");

  assert.equal(fence.observe("runtime-a", 0), true);
  const beforeReset = fence.capture();
  assert.equal(beforeReset.dataGeneration, 0);

  fence.observe("runtime-a", 1);
  assert.equal(fence.capture(), null, "an odd reset generation is never writable");
  fence.observe("runtime-a", 2);
  assert.equal(fence.capture().dataGeneration, 2);
  assert.equal(
    fence.observeIfUnchanged("runtime-a", 0, beforeReset.revision),
    false,
    "a late pre-reset response cannot roll the page back to its old generation",
  );

  fence.beginLocalReset();
  assert.equal(fence.capture(), null, "the initiating page blocks writes immediately");
  fence.observe("runtime-b", 0);
  assert.equal(fence.capture(), null, "a local reset stays blocked until its request settles");
  fence.endLocalReset();
  assert.equal(fence.capture().runtimeInstanceId, "runtime-b");
  assert.equal(fence.capture().dataGeneration, 0);
});

test("an options-page reset owns one post-reset settings reload without a false failure", async () => {
  const fixture = await createOptionsResetRuntimeFixture({
    initialSettings: require("../settings.js").normalize({
      aiApiKeys: { deepseek: "synthetic-before-reset" },
    }),
  });
  const saveStatus = fixture.element("saveStatus");
  const dataStatus = fixture.element("dataStatus");
  const saveButton = fixture.element("saveSettingsBtn");

  assert.equal(saveStatus.textContent, "设置没有未保存的更改。");
  assert.equal(fixture.settingsReadCount, 1);

  await fixture.element("resetBtn").dispatch("click");
  await flushOptionsRuntime();

  assert.equal(
    fixture.settingsReadCount,
    2,
    "the local reset path, not its completion broadcast, owns the single reload",
  );
  assert.equal(saveStatus.textContent, "设置没有未保存的更改。");
  assert.equal(dataStatus.textContent, "已删除全部 DigestDock 数据。");
  assert.equal(saveButton.disabled, false);
});

test("an externally initiated reset completion still reloads options settings", async () => {
  const fixture = await createOptionsResetRuntimeFixture({
    initialSettings: require("../settings.js").normalize({
      aiApiKeys: { deepseek: "synthetic-before-external-reset" },
    }),
  });
  const aiKeyInput = fixture.element("aiApiKey");
  const saveButton = fixture.element("saveSettingsBtn");
  const refreshedSettings = fixture.settingsApi.normalize({
    aiApiKeys: { deepseek: "synthetic-after-external-reset" },
  });

  assert.equal(aiKeyInput.value, "synthetic-before-external-reset");
  fixture.broadcast("extensionDataResetStarted", 1);
  assert.equal(aiKeyInput.value, "");
  assert.equal(saveButton.disabled, true);

  fixture.replaceSettings(refreshedSettings);
  fixture.broadcast("extensionDataResetCompleted", 2);
  await flushOptionsRuntime();

  assert.equal(fixture.settingsReadCount, 2);
  assert.equal(aiKeyInput.value, "synthetic-after-external-reset");
  assert.equal(saveButton.disabled, false);
});

test("a backup import keeps its pre-read generation when file.text crosses reset", async () => {
  const textGate = deferred();
  const sent = [];
  let currentRuntimeInstanceId = "runtime-a";
  let currentGeneration = 0;
  const runtime = {
    chrome: {
      runtime: {
        async sendMessage(message) {
          sent.push(message);
          return message.runtimeInstanceId === currentRuntimeInstanceId &&
            message.dataGeneration === currentGeneration
            ? {
                success: true,
                changed: true,
                runtimeInstanceId: currentRuntimeInstanceId,
                dataGeneration: currentGeneration,
              }
            : {
                success: false,
                code: "EXTENSION_DATA_RESET",
                runtimeInstanceId: currentRuntimeInstanceId,
                dataGeneration: currentGeneration,
              };
        },
      },
    },
    YTD_NOTES_BACKUP: notesBackup,
  };
  const fence = options.createExtensionDataFence();
  fence.observe("runtime-a", 0);
  const importFence = fence.capture();
  const file = {
    size: 128,
    text: () => textGate.promise,
  };

  const importing = options.importNotesBackupFile(
    runtime,
    file,
    importFence,
  );
  currentRuntimeInstanceId = "runtime-b";
  currentGeneration = 0;
  fence.observe("runtime-b", 0);
  textGate.resolve("{\"format\":\"digest-dock-notes\"}");

  const result = await importing;
  assert.equal(result.success, false);
  assert.equal(result.code, "EXTENSION_DATA_RESET");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "importNotesBackup");
  assert.equal(sent[0].runtimeInstanceId, "runtime-a");
  assert.equal(sent[0].dataGeneration, 0);
});

test("a normal worker restart retries backup import once with the same file text", async () => {
  const sent = [];
  let fileReads = 0;
  const runtime = {
    chrome: {
      runtime: {
        async sendMessage(message) {
          sent.push(message);
          return sent.length === 1
            ? {
                success: false,
                code: "EXTENSION_DATA_RESET",
                runtimeInstanceId: "runtime-b",
                dataGeneration: 0,
              }
            : {
                success: true,
                changed: true,
                runtimeInstanceId: "runtime-b",
                dataGeneration: 0,
              };
        },
      },
    },
    YTD_NOTES_BACKUP: notesBackup,
  };
  const fence = options.createExtensionDataFence();
  fence.observe("runtime-a", 0);
  const result = await options.importNotesBackupFile(
    runtime,
    {
      size: 32,
      async text() {
        fileReads += 1;
        return '{"format":"digest-dock-notes"}';
      },
    },
    fence.capture(),
    fence,
  );

  assert.equal(result.success, true);
  assert.equal(fileReads, 1);
  assert.deepEqual(
    sent.map(({ runtimeInstanceId, dataGeneration }) => ({
      runtimeInstanceId,
      dataGeneration,
    })),
    [
      { runtimeInstanceId: "runtime-a", dataGeneration: 0 },
      { runtimeInstanceId: "runtime-b", dataGeneration: 0 },
    ],
  );
  assert.equal(fence.isCurrent(result.resetFenceToken), true);
});

test("options never retry across reset notification or same-worker generation change", async () => {
  const responseGate = deferred();
  const sent = [];
  const runtime = {
    chrome: {
      runtime: {
        sendMessage(message) {
          sent.push(message);
          return responseGate.promise;
        },
      },
    },
  };
  const fence = options.createExtensionDataFence();
  fence.observe("runtime-a", 0);
  const saving = options.persistResetFencedSettings(
    runtime,
    { provider: "deepseek", aiApiKeys: {}, supadataApiKey: "" },
    fence.capture(),
    fence,
  );
  fence.observe("runtime-a", 1);
  fence.observe("runtime-a", 2);
  responseGate.resolve({
    success: false,
    code: "EXTENSION_DATA_RESET",
    runtimeInstanceId: "runtime-b",
    dataGeneration: 0,
  });
  assert.equal((await saving).success, false);
  assert.equal(sent.length, 1, "a reset notification forbids identity retry");

  const sameWorkerSent = [];
  const sameWorkerFence = options.createExtensionDataFence();
  sameWorkerFence.observe("runtime-a", 0);
  const sameWorkerResult = await options.persistResetFencedSettings(
    {
      chrome: {
        runtime: {
          async sendMessage(message) {
            sameWorkerSent.push(message);
            return {
              success: false,
              code: "EXTENSION_DATA_RESET",
              runtimeInstanceId: "runtime-a",
              dataGeneration: 2,
            };
          },
        },
      },
    },
    { provider: "deepseek", aiApiKeys: {}, supadataApiKey: "" },
    sameWorkerFence.capture(),
    sameWorkerFence,
  );
  assert.equal(sameWorkerResult.success, false);
  assert.equal(sameWorkerSent.length, 1);
});

test("options reject reset-period mutations and allow genuinely post-reset ones", async () => {
  const sent = [];
  const runtime = {
    chrome: {
      runtime: {
        async sendMessage(message) {
          sent.push(message);
          return {
            success: true,
            changed: true,
            runtimeInstanceId: "runtime-a",
            dataGeneration: 2,
          };
        },
      },
    },
    YTD_NOTES_BACKUP: notesBackup,
  };
  const fence = options.createExtensionDataFence();
  fence.observe("runtime-a", 1);

  const blockedSettings = await options.persistResetFencedSettings(
    runtime,
    { provider: "deepseek", aiApiKeys: {}, supadataApiKey: "" },
    fence.capture(),
  );
  let fileRead = false;
  const blockedImport = await options.importNotesBackupFile(
    runtime,
    {
      size: 1,
      async text() {
        fileRead = true;
        return "{}";
      },
    },
    fence.capture(),
  );
  assert.equal(blockedSettings.code, "EXTENSION_DATA_RESET");
  assert.equal(blockedImport.code, "EXTENSION_DATA_RESET");
  assert.equal(fileRead, false, "a reset-period click must not even read the file");
  assert.deepEqual(sent, []);

  fence.observe("runtime-a", 2);
  const fresh = fence.capture();
  const saved = await options.persistResetFencedSettings(
    runtime,
    { provider: "deepseek", aiApiKeys: {}, supadataApiKey: "" },
    fresh,
  );
  const imported = await options.importNotesBackupFile(
    runtime,
    { size: 2, async text() { return "{}"; } },
    fresh,
  );
  assert.equal(saved.success, true);
  assert.equal(imported.success, true);
  assert.deepEqual(
    sent.map(({ action, runtimeInstanceId, dataGeneration }) => ({
      action,
      runtimeInstanceId,
      dataGeneration,
    })),
    [
      {
        action: "persistResetFencedSettings",
        runtimeInstanceId: "runtime-a",
        dataGeneration: 2,
      },
      {
        action: "importNotesBackup",
        runtimeInstanceId: "runtime-a",
        dataGeneration: 2,
      },
    ],
  );
});

test("settings persistence is reset-fenced and an empty post-reset store is not rewritten", () => {
  const source = read("options.js");
  assert.match(source, /action:\s*"persistResetFencedSettings"/);
  assert.doesNotMatch(
    source.match(/async function saveSettings\(event\)[\s\S]*?\n    }/)?.[0] || "",
    /storage\.set\(/,
  );
  assert.match(
    source,
    /hadStoredSettings\s*&&\s*migration\.migrated/,
    "missing settings after reset must remain absent instead of recreating an empty key map",
  );
});

test("reading display persistence carries the complete reset fence token", async () => {
  const sent = [];
  const runtime = {
    chrome: {
      runtime: {
        async sendMessage(message) {
          sent.push(message);
          return {
            success: true,
            runtimeInstanceId: "runtime-reading",
            dataGeneration: 4,
          };
        },
      },
    },
  };
  const token = {
    runtimeInstanceId: "runtime-reading",
    dataGeneration: 4,
    revision: 7,
  };

  const result = await options.persistResetFencedReadingDisplay(
    runtime,
    { size: "xlarge", weight: "bold" },
    token,
  );
  assert.equal(result.success, true);
  assert.deepEqual(sent, [
    {
      action: "persistResetFencedReadingDisplay",
      readingDisplay: { size: "xlarge", weight: "bold" },
      runtimeInstanceId: "runtime-reading",
      dataGeneration: 4,
    },
  ]);

  const blocked = await options.persistResetFencedReadingDisplay(
    runtime,
    { size: "small", weight: "regular" },
    { runtimeInstanceId: "runtime-reading", dataGeneration: 5, revision: 8 },
  );
  assert.equal(blocked.code, "EXTENSION_DATA_RESET");
  assert.equal(sent.length, 1);
});

test("the Options reading-display caller uses the background writer", () => {
  const source = read("options.js");
  const body =
    source.match(
      /async function saveReadingDisplayChoice\(\)[\s\S]*?\n    async function initializeReadingDisplay/,
    )?.[0] || "";
  assert.match(body, /extensionDataFence\.capture\(\)/);
  assert.match(body, /readingApi\.persistReadingDisplay\([\s\S]*?async \(readingDisplay\)/);
  assert.match(body, /persistResetFencedReadingDisplay\(/);
  assert.match(body, /extensionDataFence\.isCurrent\(acceptedFence\)/);
});
