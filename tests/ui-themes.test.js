const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const themes = require("../ui-themes.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

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
  ]) {
    const count = (css.match(new RegExp(token.replace(/[-:]/g, "\\$&"), "g")) || []).length;
    assert.ok(count >= 2, `${token} must be overridden by both themes`);
  }
});

test("release packaging ships both theme files", () => {
  const check = read("scripts/check-release.sh");
  assert.ok((check.match(/"ui-themes\.css"/g) || []).length >= 2,
    "ui-themes.css must be allowlisted and required for release");
  assert.ok((check.match(/"ui-themes\.js"/g) || []).length >= 2,
    "ui-themes.js must be allowlisted and required for release");
});
