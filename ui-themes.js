/**
 * DigestDock UI themes ("skins") — presentation only, no business logic.
 *
 * Three themes ship: "classic" (the untouched default workbench), "ink-night"
 * (墨夜, dark) and "warm-paper" (暖纸, warm reading paper). The choice is a
 * single chrome.storage.local string under STORAGE_KEY, independent from the
 * ytd_settings schema, so settings migrations never see it. A localStorage
 * mirror lets this script apply the theme synchronously in <head> before the
 * first paint (no flash); chrome.storage stays the source of truth and a
 * storage.onChanged listener keeps every open extension page in sync.
 *
 * The file is loaded by sidepanel.html (which also renders the header theme
 * switcher) and options.html (which only follows the stored theme). It is safe
 * to require() from Node tests: every DOM/Chrome access is guarded.
 */
var YTD_UI_THEMES = (() => {
  const STORAGE_KEY = "ytd_ui_theme";
  const MIRROR_KEY = "ddk_ui_theme_mirror";
  const DEFAULT_THEME_ID = "classic";

  const THEMES = Object.freeze(
    [
      { id: "classic", label: "经典工作台" },
      { id: "ink-night", label: "墨夜" },
      { id: "warm-paper", label: "暖纸" },
    ].map((entry) => Object.freeze(entry)),
  );
  const THEME_IDS = Object.freeze(THEMES.map((theme) => theme.id));

  function normalizeThemeId(value) {
    const id = typeof value === "string" ? value.trim() : "";
    return THEME_IDS.includes(id) ? id : DEFAULT_THEME_ID;
  }

  function themeLabel(themeId) {
    const id = normalizeThemeId(themeId);
    const match = THEMES.find((theme) => theme.id === id);
    return match ? match.label : THEMES[0].label;
  }

  function rootElement() {
    return typeof document !== "undefined" ? document.documentElement : null;
  }

  /** Applies the theme to <html data-theme="...">; classic removes the attribute. */
  function applyTheme(themeId) {
    const id = normalizeThemeId(themeId);
    const root = rootElement();
    if (root) {
      if (id === DEFAULT_THEME_ID) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", id);
    }
    return id;
  }

  function currentTheme() {
    const root = rootElement();
    return normalizeThemeId(root ? root.getAttribute("data-theme") : "");
  }

  function readMirror() {
    try {
      if (typeof localStorage !== "undefined") {
        const value = localStorage.getItem(MIRROR_KEY);
        if (value) return normalizeThemeId(value);
      }
    } catch (error) {
      /* The mirror is a paint hint only; ignore access failures. */
    }
    return "";
  }

  function writeMirror(themeId) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(MIRROR_KEY, normalizeThemeId(themeId));
      }
    } catch (error) {
      /* Private contexts may deny localStorage; chrome.storage still wins. */
    }
  }

  function chromeLocalStorage() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        return chrome.storage.local;
      }
    } catch (error) {
      /* Not an extension page. */
    }
    return null;
  }

  function readStoredTheme(callback) {
    const storage = chromeLocalStorage();
    if (storage) {
      try {
        storage.get(STORAGE_KEY, (result) => {
          try {
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
              callback(readMirror() || DEFAULT_THEME_ID);
              return;
            }
          } catch (error) {
            /* fall through to the stored value */
          }
          const stored = result ? result[STORAGE_KEY] : "";
          callback(stored ? normalizeThemeId(stored) : readMirror() || DEFAULT_THEME_ID);
        });
        return;
      } catch (error) {
        /* fall through to the mirror */
      }
    }
    callback(readMirror() || DEFAULT_THEME_ID);
  }

  /** Persists the choice (mirror first so the next paint cannot flash). */
  function persistTheme(themeId) {
    const id = normalizeThemeId(themeId);
    writeMirror(id);
    const storage = chromeLocalStorage();
    if (storage) {
      try {
        storage.set({ [STORAGE_KEY]: id });
      } catch (error) {
        /* Keep the mirror copy only. */
      }
    }
    return id;
  }

  /* ---------------------------------------------------------------
   * Side panel header switcher. Only wired when the markup exists, so the
   * options page (no switcher) and Node tests can load this file safely.
   * ------------------------------------------------------------- */
  let syncSwitcherUI = () => {};

  function initThemeSwitcher(doc) {
    const scope = doc || (typeof document !== "undefined" ? document : null);
    if (!scope || typeof scope.getElementById !== "function") return false;
    const button = scope.getElementById("themeSwitchBtn");
    const menu = scope.getElementById("themeSwitchMenu");
    if (!button || !menu) return false;
    const options = Array.from(menu.querySelectorAll("[data-theme-id]"));

    const syncMenu = () => {
      const current = currentTheme();
      for (const option of options) {
        const isCurrent = option.getAttribute("data-theme-id") === current;
        option.setAttribute("aria-checked", isCurrent ? "true" : "false");
        option.classList.toggle("is-current", isCurrent);
        option.setAttribute("tabindex", isCurrent ? "0" : "-1");
      }
      const label = `界面主题：${themeLabel(current)}`;
      button.setAttribute("title", label);
      button.setAttribute("aria-label", `${label}，点击切换`);
    };

    const openMenu = () => {
      syncMenu();
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      const currentOption = options.find(
        (option) => option.getAttribute("aria-checked") === "true",
      );
      (currentOption || options[0])?.focus();
    };
    const closeMenu = ({ restoreFocus = false } = {}) => {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (restoreFocus) button.focus();
    };

    button.addEventListener("click", () => {
      if (menu.hidden) openMenu();
      else closeMenu({ restoreFocus: true });
    });
    scope.addEventListener("click", (event) => {
      if (menu.hidden) return;
      if (menu.contains(event.target) || button.contains(event.target)) return;
      closeMenu();
    });
    scope.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) {
        event.preventDefault();
        closeMenu({ restoreFocus: true });
        return;
      }
      if (menu.hidden) return;
      if (event.key === "Tab") {
        closeMenu();
        return;
      }
      if (
        !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
        options.length === 0
      ) {
        return;
      }
      event.preventDefault();
      const checkedIndex = Math.max(
        0,
        options.findIndex(
          (option) => option.getAttribute("aria-checked") === "true",
        ),
      );
      const activeIndex = options.indexOf(scope.activeElement);
      const fromIndex = activeIndex >= 0 ? activeIndex : checkedIndex;
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : event.key === "ArrowDown"
              ? (fromIndex + 1) % options.length
              : (fromIndex - 1 + options.length) % options.length;
      options.forEach((option, index) => {
        option.setAttribute("tabindex", index === nextIndex ? "0" : "-1");
      });
      options[nextIndex].focus();
    });
    for (const option of options) {
      option.addEventListener("click", () => {
        applyTheme(persistTheme(option.getAttribute("data-theme-id")));
        syncMenu();
        closeMenu({ restoreFocus: true });
      });
    }

    syncSwitcherUI = syncMenu;
    syncMenu();
    return true;
  }

  /** Applies theme changes made on any other extension page, live. */
  function watchStoredTheme() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName !== "local" || !changes || !changes[STORAGE_KEY]) return;
          const applied = applyTheme(changes[STORAGE_KEY].newValue);
          writeMirror(applied);
          syncSwitcherUI();
        });
        return true;
      }
    } catch (error) {
      /* Not an extension page. */
    }
    return false;
  }

  function boot() {
    readStoredTheme((stored) => {
      const applied = applyTheme(stored);
      writeMirror(applied);
      syncSwitcherUI();
    });
    watchStoredTheme();
  }

  // Synchronous first pass from the mirror: this script runs in <head>, so the
  // correct theme is on <html> before the body is parsed or painted.
  const mirrored = readMirror();
  if (mirrored) applyTheme(mirrored);

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        initThemeSwitcher();
        boot();
      });
    } else {
      initThemeSwitcher();
      boot();
    }
  }

  return {
    STORAGE_KEY,
    MIRROR_KEY,
    DEFAULT_THEME_ID,
    THEMES,
    THEME_IDS,
    normalizeThemeId,
    themeLabel,
    applyTheme,
    currentTheme,
    readMirror,
    persistTheme,
    readStoredTheme,
    initThemeSwitcher,
    watchStoredTheme,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_UI_THEMES;
}
