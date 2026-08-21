const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// A minimal nav-item stand-in that records class and attribute state the same
// way applySettingsNavState touches a real anchor.
function createNavItem(id, { active = false } = {}) {
  const classes = new Set(active ? ["is-active"] : []);
  const attrs = active ? { "aria-current": "location" } : {};
  return {
    id,
    classes,
    attrs,
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    getAttribute(name) {
      if (name === "href") return `#${id}`;
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete attrs[name];
    },
  };
}

test("nav href parsing extracts the section target id", () => {
  assert.equal(
    options.settingsNavTargetFromHref("#section-services"),
    "section-services",
  );
  assert.equal(
    options.settingsNavTargetFromHref("#notesBackupCard"),
    "notesBackupCard",
  );
  assert.equal(options.settingsNavTargetFromHref("no-hash-here"), "");
  assert.equal(options.settingsNavTargetFromHref(""), "");
  assert.equal(options.settingsNavTargetFromHref(null), "");
  assert.equal(options.settingsNavTargetFromHref(undefined), "");
});

test("scroll spy activates the last section whose top has crossed the activation line", () => {
  // Sections in document order, top measured from the scroller's top edge.
  const sections = [
    { id: "section-services", top: -220 },
    { id: "section-transcript", top: -120 },
    { id: "notesBackupCard", top: 40 },
    { id: "section-data", top: 400 },
    { id: "section-remix", top: 760 },
    { id: "section-privacy", top: 1120 },
  ];
  // With a 24px activation line, the last section at/above it is transcript.
  assert.equal(
    options.resolveActiveSettingsSection(sections, 24),
    "section-transcript",
  );

  // Scrolled to the very top: only the first section has reached the line.
  const nearTop = [
    { id: "section-services", top: 8 },
    { id: "section-transcript", top: 120 },
    { id: "notesBackupCard", top: 320 },
  ];
  assert.equal(
    options.resolveActiveSettingsSection(nearTop, 24),
    "section-services",
  );

  // Scrolled to the bottom: the final section wins.
  const nearBottom = sections.map((section) => ({
    id: section.id,
    top: section.top - 1200,
  }));
  assert.equal(
    options.resolveActiveSettingsSection(nearBottom, 24),
    "section-privacy",
  );

  assert.equal(options.resolveActiveSettingsSection([], 24), "");
});

test("at the bottom a clicked near-bottom section wins over the scroll-spy retreat", () => {
  // Geometry captured when the scroller is pinned at its end (max scrollTop):
  // "本地数据" (#section-data) was clicked but cannot align to the top, so its
  // top stays below the 24px activation line. The trailing sections are all in
  // the final viewport (height 600) and can never cross the line.
  const sections = [
    { id: "section-services", top: -980 },
    { id: "section-transcript", top: -640 },
    { id: "notesBackupCard", top: -300 },
    { id: "section-data", top: 60 },
    { id: "section-remix", top: 300 },
    { id: "section-privacy", top: 520 },
  ];

  // Plain line-based spy retreats to the previous section — the reported bug:
  // the click selects "本地数据" but spy overrides it with "笔记与备份".
  assert.equal(
    options.resolveActiveSettingsSection(sections, 24),
    "notesBackupCard",
  );

  // With an explicit click target, the clicked section stays selected at the
  // bottom even though it cannot reach the activation line.
  assert.equal(
    options.resolveActiveSettingsSection(sections, 24, {
      atBottom: true,
      viewportHeight: 600,
      preferredId: "section-data",
    }),
    "section-data",
  );

  // The truly last section is honored the same way when it is the click target.
  assert.equal(
    options.resolveActiveSettingsSection(sections, 24, {
      atBottom: true,
      viewportHeight: 600,
      preferredId: "section-privacy",
    }),
    "section-privacy",
  );

  // Passive scrolling to the very end (no click target) settles on the last
  // visible section rather than retreating, and spy is not suppressed.
  assert.equal(
    options.resolveActiveSettingsSection(sections, 24, {
      atBottom: true,
      viewportHeight: 600,
    }),
    "section-privacy",
  );

  // A stale click target that has scrolled off the top is not honored; the
  // bottom falls back to the last visible section.
  assert.equal(
    options.resolveActiveSettingsSection(sections, 24, {
      atBottom: true,
      viewportHeight: 600,
      preferredId: "section-services",
    }),
    "section-privacy",
  );
});

test("applying nav state sets is-active and aria-current only on the match", () => {
  const items = [
    createNavItem("section-services", { active: true }),
    createNavItem("section-transcript"),
    createNavItem("notesBackupCard"),
    createNavItem("section-privacy"),
  ];

  options.applySettingsNavState(items, "notesBackupCard");

  // Previous active item is fully cleared.
  assert.equal(items[0].classes.has("is-active"), false);
  assert.equal(Object.hasOwn(items[0].attrs, "aria-current"), false);
  // New target is the only active item.
  assert.equal(items[2].classes.has("is-active"), true);
  assert.equal(items[2].attrs["aria-current"], "location");
  assert.equal(
    items.filter((item) => item.classes.has("is-active")).length,
    1,
  );
  assert.equal(
    items.filter((item) => Object.hasOwn(item.attrs, "aria-current")).length,
    1,
  );
});

test("an initial or changed hash resolves the matching nav item", () => {
  const items = [
    createNavItem("section-services", { active: true }),
    createNavItem("section-transcript"),
    createNavItem("notesBackupCard"),
    createNavItem("section-privacy"),
  ];
  const targetIds = new Set(items.map((item) => item.id));

  const hashId = options.settingsNavTargetFromHref("#section-privacy");
  assert.equal(targetIds.has(hashId), true);
  options.applySettingsNavState(items, hashId);

  assert.equal(items[3].classes.has("is-active"), true);
  assert.equal(items[3].attrs["aria-current"], "location");
  assert.equal(items[0].classes.has("is-active"), false);

  // A hash that targets no section leaves the set untouched by the resolver.
  const strayId = options.settingsNavTargetFromHref("#not-a-section");
  assert.equal(targetIds.has(strayId), false);
});

test("every settings nav item points at a section that exists in the markup", () => {
  const html = read("options.html");
  const navHrefs = [
    ...html.matchAll(/class="settings-nav-item[^"]*"[^>]*href="(#[^"]+)"/g),
  ].map((match) => match[1]);
  assert.ok(navHrefs.length >= 6, "expected the full settings nav");

  for (const href of navHrefs) {
    const id = options.settingsNavTargetFromHref(href);
    assert.match(html, new RegExp(`id="${id}"`), `missing target #${id}`);
  }

  // Exactly one item ships pre-selected with both markers for the first paint.
  const activeItems = [
    ...html.matchAll(/class="settings-nav-item is-active"[^>]*>/g),
  ];
  assert.equal(activeItems.length, 1);
  assert.match(
    html,
    /class="settings-nav-item is-active"[^>]*aria-current="location"/,
  );
});

test("settings page locks to the viewport with a single internal scroller", () => {
  const css = read("options.css");

  // The document/body is pinned to the viewport and does not scroll.
  assert.match(css, /body\s*\{[^}]*height:\s*100vh/);
  assert.match(css, /body\s*\{[^}]*overflow:\s*hidden/);

  // The app shell is a fixed-height flex frame.
  assert.match(css, /\.settings-app\s*\{[^}]*height:\s*100vh/);
  assert.doesNotMatch(css, /\.settings-app\s*\{[^}]*min-height:\s*100vh/);

  // The content column can shrink so its child becomes the scroller.
  assert.match(css, /\.settings-content\s*\{[^}]*min-height:\s*0/);

  // .settings-scroll is the only vertical scroller for settings content.
  assert.match(css, /\.settings-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.settings-scroll\s*\{[^}]*min-height:\s*0/);

  // The sticky save bar stays a flex sibling (continuously visible), not a
  // scrolled-away block.
  assert.match(css, /\.settings-savebar\s*\{[^}]*border-top:\s*1px/);

  // The narrow layout keeps a top nav region and stacks services to one column.
  assert.match(
    css,
    /@media \(max-width: 900px\)[\s\S]*\.service-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
  );
});
