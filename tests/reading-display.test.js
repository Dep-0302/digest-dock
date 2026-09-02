const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const readingModule = require("../reading-display.js");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness({ stored, failSet = false } = {}) {
  const attributes = new Map();
  const mirror = new Map();
  const listeners = [];
  const values = {};
  if (stored !== undefined) values.ytd_reading_display = stored;
  const documentElement = {
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) || null;
    },
  };
  const runtime = {
    document: { documentElement },
    localStorage: {
      getItem(key) {
        return mirror.has(key) ? mirror.get(key) : null;
      },
      setItem(key, value) {
        mirror.set(key, String(value));
      },
    },
    chrome: {
      storage: {
        local: {
          async get(key) {
            return Object.hasOwn(values, key) ? { [key]: values[key] } : {};
          },
          async set(next) {
            if (failSet) throw new Error("storage failed");
            Object.assign(values, JSON.parse(JSON.stringify(next)));
          },
        },
        onChanged: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
      },
    },
  };
  const api = readingModule.createReadingDisplayApi(runtime);
  return {
    api,
    attributes,
    values,
    mirror,
    emit(newValue) {
      for (const listener of listeners) {
        listener(
          { ytd_reading_display: { oldValue: values.ytd_reading_display, newValue } },
          "local",
        );
      }
    },
  };
}

test("reading display normalizes every size and weight with safe defaults", () => {
  assert.deepEqual(readingModule.SIZE_IDS, [
    "small",
    "standard",
    "large",
    "xlarge",
  ]);
  assert.deepEqual(readingModule.WEIGHT_IDS, ["regular", "bold"]);
  assert.deepEqual(readingModule.normalizeReadingDisplay(), {
    size: "standard",
    weight: "regular",
  });
  assert.deepEqual(
    readingModule.normalizeReadingDisplay({ size: "xlarge", weight: "bold" }),
    { size: "xlarge", weight: "bold" },
  );
  assert.deepEqual(
    readingModule.normalizeReadingDisplay({ size: "huge", weight: "heavy" }),
    { size: "standard", weight: "regular" },
  );
});

test("stored preferences apply as root attributes and persist independently", async () => {
  const harness = createHarness({
    stored: { size: "large", weight: "bold" },
  });
  const stored = await harness.api.readStoredReadingDisplay();
  assert.deepEqual(stored, { size: "large", weight: "bold" });
  harness.api.applyReadingDisplay(stored);
  assert.equal(harness.attributes.get("data-reading-size"), "large");
  assert.equal(harness.attributes.get("data-reading-weight"), "bold");

  await harness.api.persistReadingDisplay({ size: "small", weight: "regular" });
  assert.deepEqual(harness.values.ytd_reading_display, {
    size: "small",
    weight: "regular",
  });
  assert.deepEqual(harness.api.currentReadingDisplay(), {
    size: "small",
    weight: "regular",
  });
});

test("a failed write restores the previous reading display", async () => {
  const harness = createHarness({ failSet: true });
  await harness.api.boot();
  harness.api.applyReadingDisplay({ size: "large", weight: "regular" });
  await assert.rejects(
    harness.api.persistReadingDisplay({ size: "xlarge", weight: "bold" }),
    /storage failed/,
  );
  assert.deepEqual(harness.api.currentReadingDisplay(), {
    size: "large",
    weight: "regular",
  });
});

test("storage changes sync live and deletion restores the default", () => {
  const harness = createHarness();
  const applied = [];
  assert.equal(
    harness.api.watchStoredReadingDisplay((value) => applied.push(value)),
    true,
  );
  harness.emit({ size: "xlarge", weight: "bold" });
  harness.emit(undefined);
  assert.deepEqual(applied, [
    { size: "xlarge", weight: "bold" },
    { size: "standard", weight: "regular" },
  ]);
  assert.deepEqual(harness.api.currentReadingDisplay(), {
    size: "standard",
    weight: "regular",
  });
});

test("a late initial read cannot overwrite a newer user choice", async () => {
  const pendingGet = deferred();
  const attributes = new Map();
  const runtime = {
    document: {
      documentElement: {
        setAttribute: (name, value) => attributes.set(name, String(value)),
        getAttribute: (name) => attributes.get(name) || null,
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
    chrome: {
      storage: {
        local: {
          get: () => pendingGet.promise,
          set: async () => {},
        },
        onChanged: { addListener() {} },
      },
    },
  };
  const api = readingModule.createReadingDisplayApi(runtime);
  const boot = api.boot();
  await api.persistReadingDisplay({ size: "xlarge", weight: "bold" });
  pendingGet.resolve({
    ytd_reading_display: { size: "small", weight: "regular" },
  });
  await boot;

  assert.deepEqual(api.currentReadingDisplay(), {
    size: "xlarge",
    weight: "bold",
  });
});

test("serialized writes keep a newer choice when an older write fails", async () => {
  const firstWrite = deferred();
  const attributes = new Map();
  const storedWrites = [];
  let setCalls = 0;
  const runtime = {
    document: {
      documentElement: {
        setAttribute: (name, value) => attributes.set(name, String(value)),
        getAttribute: (name) => attributes.get(name) || null,
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
    chrome: {
      storage: {
        local: {
          async get() {
            return {};
          },
          set(record) {
            setCalls += 1;
            if (setCalls === 1) return firstWrite.promise;
            storedWrites.push(record.ytd_reading_display);
            return Promise.resolve();
          },
        },
        onChanged: { addListener() {} },
      },
    },
  };
  const api = readingModule.createReadingDisplayApi(runtime);
  await api.boot();
  const older = api
    .persistReadingDisplay({ size: "large", weight: "regular" })
    .catch((error) => error);
  const newer = api.persistReadingDisplay({ size: "large", weight: "bold" });
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  assert.equal(setCalls, 1, "the newer write waits behind the older write");
  firstWrite.reject(new Error("older write failed"));
  assert.match(String(await older), /older write failed/);
  await newer;

  assert.equal(setCalls, 2);
  assert.deepEqual(storedWrites, [{ size: "large", weight: "bold" }]);
  assert.deepEqual(api.currentReadingDisplay(), {
    size: "large",
    weight: "bold",
  });
});

test("reading controls are accessible and scale body copy plus timecodes", () => {
  const optionsHtml = read("options.html");
  const sidepanelHtml = read("sidepanel.html");
  const css = read("sidepanel.css");
  const optionsCss = read("options.css");

  assert.match(optionsHtml, /id="section-reading"/);
  assert.match(optionsHtml, /<fieldset class="reading-choice-fieldset">/);
  assert.match(optionsHtml, /name="readingSize"[\s\S]*?value="xlarge"/);
  assert.match(optionsHtml, /name="readingWeight"[\s\S]*?value="bold"/);
  assert.match(optionsHtml, /id="readingDisplayStatus"[\s\S]*?aria-live="polite"/);
  assert.match(optionsHtml, /<script src="reading-display\.js"><\/script>/);
  assert.match(sidepanelHtml, /<script src="reading-display\.js"><\/script>/);
  assert.match(
    optionsCss,
    /\.reading-display-live\s*\{[^}]*color:\s*var\(--ink-secondary\)/,
  );

  assert.match(css, /--reading-body-size:\s*13\.5px/);
  assert.match(css, /--reading-time-size:\s*12\.5px/);
  assert.match(css, /html\[data-reading-size="small"\][\s\S]*?--reading-time-size:\s*11\.5px/);
  assert.match(css, /html\[data-reading-size="large"\][\s\S]*?--reading-time-size:\s*14px[\s\S]*?--time-rail:\s*68px/);
  assert.match(css, /html\[data-reading-size="xlarge"\][\s\S]*?--reading-body-size:\s*17\.5px/);
  assert.match(css, /html\[data-reading-size="xlarge"\][\s\S]*?--reading-time-size:\s*15\.5px[\s\S]*?--time-rail:\s*72px/);
  assert.match(
    css,
    /@media \(max-width: 380px\)[\s\S]*?html\[data-reading-size="xlarge"\][\s\S]*?--time-rail:\s*68px/,
  );
  assert.match(css, /html\[data-reading-weight="bold"\][\s\S]*?--reading-body-weight:\s*600/);
  assert.match(
    css,
    /\.transcript-text,[\s\S]*?\.transcript-copy,[\s\S]*?\.quote-text,[\s\S]*?\.note-text\s*\{[\s\S]*?font-size:\s*var\(--reading-body-size\)[\s\S]*?font-weight:\s*var\(--reading-body-weight\)/,
  );
  assert.match(
    css,
    /\.chapter-summary\s*\{[\s\S]*?font-size:\s*var\(--reading-summary-size\)[\s\S]*?font-weight:\s*var\(--reading-body-weight\)/,
  );
  for (const selector of [
    ".transcript-time",
    ".chapter-timestamp",
    ".quote-timestamp",
    ".note-timestamp",
  ]) {
    const block = css.match(
      new RegExp(`${selector.replace(/[.-]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    assert.ok(block, `missing ${selector} block`);
    assert.match(block, /font-size:\s*var\(--reading-time-size\)/);
    assert.doesNotMatch(block, /--reading-body-weight/);
  }
  const chapterTitleBlock = css.match(/\.chapter-title\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(chapterTitleBlock, "missing .chapter-title block");
  assert.doesNotMatch(chapterTitleBlock, /--reading-(?:body|summary|time)/);
  assert.match(
    optionsHtml,
    /调整字幕、概览摘要、笔记正文和对应时间码的大小。粗体只作用于正文/,
  );
});
