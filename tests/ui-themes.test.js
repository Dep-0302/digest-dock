const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const themes = require("../ui-themes.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function themeToken(css, themeId, token) {
  const block = css.match(
    new RegExp(`html\\[data-theme="${themeId}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  assert.ok(block, `missing ${themeId} theme block`);
  const value = block.match(
    new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, "i"),
  )?.[1];
  assert.ok(value, `missing solid --${token} in ${themeId}`);
  return value;
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) =>
      value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4),
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function createThemeMenuHarness() {
  const documentListeners = new Map();
  const doc = {
    activeElement: null,
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
  };

  class Control {
    constructor(themeId = "") {
      this.attributes = new Map();
      this.listeners = new Map();
      this.hidden = false;
      this.classList = { toggle() {} };
      if (themeId) this.setAttribute("data-theme-id", themeId);
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) || null;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    dispatch(type, event = {}) {
      return this.listeners.get(type)?.({ target: this, ...event });
    }

    focus() {
      doc.activeElement = this;
    }

    contains(target) {
      return target === this;
    }
  }

  const button = new Control();
  const menu = new Control();
  const options = themes.THEME_IDS.map((id) => new Control(id));
  menu.hidden = true;
  menu.querySelectorAll = () => options;
  menu.contains = (target) => target === menu || options.includes(target);
  doc.getElementById = (id) =>
    id === "themeSwitchBtn" ? button : id === "themeSwitchMenu" ? menu : null;

  themes.initThemeSwitcher(doc);
  return {
    button,
    menu,
    options,
    keydown(key) {
      let prevented = false;
      documentListeners.get("keydown")?.({
        key,
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    },
    activeElement: () => doc.activeElement,
  };
}

test("theme registry keeps the classic default plus exactly two new skins", () => {
  assert.deepEqual(themes.THEME_IDS, ["classic", "ink-night", "warm-paper"]);
  assert.equal(themes.DEFAULT_THEME_ID, "classic");
  for (const id of themes.THEME_IDS) {
    assert.equal(themes.normalizeThemeId(id), id);
  }
  assert.equal(themes.normalizeThemeId(""), "classic");
  assert.equal(themes.normalizeThemeId("dark-mode"), "classic");
  assert.equal(themes.normalizeThemeId(null), "classic");
  assert.equal(themes.normalizeThemeId(undefined), "classic");
  assert.equal(themes.normalizeThemeId(" INK-NIGHT "), "classic");
  assert.equal(themes.normalizeThemeId("  warm-paper  "), "warm-paper");
  assert.equal(themes.themeLabel("classic"), "经典工作台");
  assert.equal(themes.themeLabel("ink-night"), "墨夜");
  assert.equal(themes.themeLabel("warm-paper"), "暖纸");
  assert.equal(themes.themeLabel("unknown"), "经典工作台");
  assert.equal(themes.STORAGE_KEY, "ytd_ui_theme");
});

test("sidepanel wires the theme stylesheet, the head boot script, and the header switcher", () => {
  const html = read("sidepanel.html");
  const baseCss = html.indexOf('<link rel="stylesheet" href="sidepanel.css" />');
  const themeCss = html.indexOf('<link rel="stylesheet" href="ui-themes.css" />');
  const themeJs = html.indexOf('<script src="ui-themes.js"></script>');
  const headEnd = html.indexOf("</head>");

  assert.ok(baseCss >= 0, "base stylesheet must stay in place");
  assert.ok(themeCss > baseCss && themeCss < headEnd,
    "ui-themes.css must load after sidepanel.css inside <head>");
  assert.ok(themeJs > themeCss && themeJs < headEnd,
    "ui-themes.js must boot synchronously in <head> to avoid a theme flash");

  // The switcher sits between the notes language control and the settings
  // button, inside the header (before the tab bar), like the other controls.
  const notesControl = html.indexOf('id="notesModeControl"');
  const switcher = html.indexOf('id="themeSwitchBtn"');
  const settings = html.indexOf('id="settingsBtn"');
  const tabs = html.indexOf('<div class="tabs"');
  assert.ok(notesControl >= 0 && switcher > notesControl,
    "theme switcher must follow the language controls");
  assert.ok(settings > switcher && settings < tabs,
    "settings button must stay between the switcher and the tab bar");

  assert.match(html, /id="themeSwitchMenu"[\s\S]*?role="menu"[\s\S]*?hidden/);
  assert.match(html, /id="themeSwitchBtn"[\s\S]*?aria-haspopup="menu"[\s\S]*?aria-expanded="false"/);
  for (const id of themes.THEME_IDS) {
    assert.match(html, new RegExp(`data-theme-id="${id}"`),
      `sidepanel switcher must expose the ${id} theme`);
  }
});

test("options page follows the stored theme without adding a second switcher", () => {
  const html = read("options.html");
  const themeCss = html.indexOf('<link rel="stylesheet" href="ui-themes.css" />');
  const themeJs = html.indexOf('<script src="ui-themes.js"></script>');
  const headEnd = html.indexOf("</head>");

  assert.ok(themeCss > 0 && themeCss < headEnd);
  assert.ok(themeJs > 0 && themeJs < headEnd);
  assert.ok(!html.includes('id="themeSwitchBtn"'),
    "the settings page follows the theme; switching stays in the side panel");

  // Existing script order contracts must survive the new head script.
  const aiIndex = html.indexOf('<script src="ai-providers.js"></script>');
  const settingsIndex = html.indexOf('<script src="settings.js"></script>');
  assert.ok(aiIndex >= 0 && settingsIndex > aiIndex);
});

test("theme stylesheet only overrides tokens under data-theme scopes", () => {
  const css = read("ui-themes.css");
  assert.doesNotMatch(css, /^:root\s*\{/m,
    "themes must not redefine the default :root tokens; classic stays untouched");

  for (const scope of ['html[data-theme="ink-night"]', 'html[data-theme="warm-paper"]']) {
    assert.ok(css.includes(scope), `missing ${scope} block`);
  }

  // Every core token of both pages must be overridden by both themes.
  for (const token of [
    "--bg:", "--canvas:", "--surface:", "--surface-raised:", "--border:",
    "--text:", "--text-secondary:", "--text-muted:",
    "--accent:", "--accent-hover:", "--accent-gradient:", "--active-surface:",
    "--success:", "--danger:", "--state-shadow:",
    "--panel:", "--surface-soft:", "--ink:", "--ink-secondary:", "--ink-muted:", "--line:",
    "--control-border:",
  ]) {
    const count = (css.match(new RegExp(token.replace(/[-:]/g, "\\$&"), "g")) || []).length;
    assert.ok(count >= 2, `${token} must be overridden by both themes`);
  }
});

test("optional themes keep muted text, control edges, and focus rings visible", () => {
  const css = read("ui-themes.css");
  const optionsCss = read("options.css");
  const cases = [
    {
      id: "ink-night",
      mutedBackground: "surface-raised",
      controlBackground: "surface-raised",
      focusBackground: "surface-raised",
    },
    {
      id: "warm-paper",
      mutedBackground: "canvas",
      controlBackground: "canvas",
      focusBackground: "surface",
    },
  ];

  for (const item of cases) {
    assert.ok(
      contrastRatio(
        themeToken(css, item.id, "text-muted"),
        themeToken(css, item.id, item.mutedBackground),
      ) >= 4.5,
      `${item.id} muted text must meet 4.5:1`,
    );
    assert.ok(
      contrastRatio(
        themeToken(css, item.id, "control-border"),
        themeToken(css, item.id, item.controlBackground),
      ) >= 3,
      `${item.id} control borders must meet 3:1`,
    );
    assert.ok(
      contrastRatio(
        themeToken(css, item.id, "accent-focus"),
        themeToken(css, item.id, item.focusBackground),
      ) >= 3,
      `${item.id} focus rings must meet 3:1`,
    );
  }

  assert.match(optionsCss, /input[\s\S]*?var\(--control-border, var\(--line\)\)/);
  assert.match(optionsCss, /\.provider-select-button[\s\S]*?var\(--control-border, var\(--line\)\)/);
});

test("reading-display status remains readable in the dark theme", () => {
  const themeCss = read("ui-themes.css");
  const optionsCss = read("options.css");
  const foreground = themeToken(themeCss, "ink-night", "ink-secondary");
  const background = themeToken(themeCss, "ink-night", "active-surface");

  assert.ok(
    contrastRatio(foreground, background) >= 4.5,
    "the immediate-apply label must meet AA contrast in ink-night",
  );
  assert.match(
    optionsCss,
    /\.reading-display-live\s*\{[^}]*color:\s*var\(--ink-secondary\)/,
  );
});

test("theme menu restores focus and supports standard directional keys", () => {
  const source = read("ui-themes.js");
  assert.match(source, /closeMenu\({ restoreFocus: true }\)/);
  assert.match(source, /option\.setAttribute\("tabindex"/);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    assert.ok(source.includes(`"${key}"`), `missing ${key} keyboard support`);
  }

  const harness = createThemeMenuHarness();
  harness.button.dispatch("click");
  assert.equal(harness.activeElement(), harness.options[0]);
  assert.deepEqual(
    harness.options.map((option) => option.getAttribute("tabindex")),
    ["0", "-1", "-1"],
  );

  assert.equal(harness.keydown("ArrowDown"), true);
  assert.equal(harness.activeElement(), harness.options[1]);
  assert.deepEqual(
    harness.options.map((option) => option.getAttribute("tabindex")),
    ["-1", "0", "-1"],
  );

  assert.equal(harness.keydown("End"), true);
  assert.equal(harness.activeElement(), harness.options[2]);
  assert.deepEqual(
    harness.options.map((option) => option.getAttribute("tabindex")),
    ["-1", "-1", "0"],
  );

  harness.options[2].dispatch("click");
  assert.equal(harness.menu.hidden, true);
  assert.equal(harness.activeElement(), harness.button);
});

test("release packaging ships both theme files", () => {
  const check = read("scripts/check-release.sh");
  assert.ok((check.match(/"ui-themes\.css"/g) || []).length >= 2,
    "ui-themes.css must be allowlisted and required for release");
  assert.ok((check.match(/"ui-themes\.js"/g) || []).length >= 2,
    "ui-themes.js must be allowlisted and required for release");
});
