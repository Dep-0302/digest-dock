(() => {
if (globalThis.__YTD_CONTENT_SCRIPT_ACTIVE__) return;

/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Injecting "key moment" markers onto YouTube's progress bar
 * 3. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Every unpacked copy has its own chrome.runtime.id. Include that identity in
// page-owned DOM so a stable release and a development worktree can remain
// enabled without deleting each other's controls or routing a click to the
// wrong service worker.
const DIGESTDOCK_YOUTUBE_DOM_PREFIX = `digestdock-${chrome.runtime.id}-youtube`;
const DIGESTDOCK_YOUTUBE_DOM_IDS = Object.freeze({
  digestButton: `${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-digest-button`,
  noteButton: `${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-note-button`,
  noteToast: `${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-note-toast`,
  refreshNotice: `${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-refresh-notice`,
});
const DIGESTDOCK_YOUTUBE_MARKER_CLASS =
  `${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-key-moment-markers`;
const DIGESTDOCK_YOUTUBE_TOAST_ANIMATION =
  `${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-slide-in`;
const LEGACY_YOUTUBE_DIGEST_BUTTON_ID = "ytd-digest-button";
const LEGACY_YOUTUBE_NOTE_BUTTON_ID = "ytd-note-button";

// Self-contained inline brand icon for the page opener. Geometry and colors
// match icons/digestdock-icon-solid.svg (blue-cyan gradient, three white
// chapter lines, one luminous time marker). It renders icon-only; the button
// carries the accessible name via aria-label/title, so the SVG stays decorative
// (aria-hidden) to avoid a duplicated announcement.
const DIGESTDOCK_BRAND_ICON_SVG = `
  <svg class="digestdock-brand-icon" width="26" height="26" viewBox="0 0 128 128" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-brand-base" x1="12" y1="8" x2="116" y2="120" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#0A5FE9"></stop>
        <stop offset="0.46" stop-color="#087FE8"></stop>
        <stop offset="1" stop-color="#04B7D2"></stop>
      </linearGradient>
      <radialGradient id="${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-brand-glow" cx="0" cy="0" r="1" gradientTransform="translate(86 88) rotate(-132) scale(72 68)" gradientUnits="userSpaceOnUse">
        <stop stop-color="#30CFE5" stop-opacity="0.72"></stop>
        <stop offset="1" stop-color="#0B80E8" stop-opacity="0"></stop>
      </radialGradient>
    </defs>
    <rect width="128" height="128" rx="32" fill="url(#${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-brand-base)"></rect>
    <rect width="128" height="128" rx="32" fill="url(#${DIGESTDOCK_YOUTUBE_DOM_PREFIX}-brand-glow)"></rect>
    <rect x="24" y="32" width="80" height="16" rx="8" fill="#FFFFFF"></rect>
    <circle cx="32" cy="64" r="8" fill="#D8F7FF"></circle>
    <rect x="48" y="56" width="56" height="16" rx="8" fill="#FFFFFF"></rect>
    <rect x="40" y="80" width="56" height="16" rx="8" fill="#FFFFFF"></rect>
  </svg>
`;

// Linear bookmark-plus icon for the "save current moment" control. Stroke uses
// currentColor and matches the sidebar UI_ICONS.bookmarkPlus.
const DIGESTDOCK_BOOKMARK_ICON_SVG = `
  <svg class="digestdock-note-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h6"></path>
    <line x1="18" y1="3" x2="18" y2="9"></line>
    <line x1="15" y1="6" x2="21" y2="6"></line>
  </svg>
`;

// Short check icon used only as transient "saved" feedback on the icon button.
const DIGESTDOCK_CHECK_ICON_SVG = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
`;

const DIGESTDOCK_NOTE_BUTTON_LABEL = "金句速记 (N)";
const DIGESTDOCK_NOTE_BG =
  "linear-gradient(135deg, rgba(10, 95, 233, 0.2) 0%, rgba(8, 127, 232, 0.2) 52%, rgba(4, 183, 210, 0.2) 100%)";
const DIGESTDOCK_NOTE_BG_HOVER =
  "linear-gradient(135deg, #0a5fe9 0%, #087fe8 52%, #04b7d2 100%)";
const DIGESTDOCK_NOTE_SUCCESS_BG = "#2c8a65";
const DIGESTDOCK_NOTE_SHADOW = "0 8px 18px rgba(4, 73, 139, 0.24)";
const DIGESTDOCK_NOTE_SHADOW_HOVER = "0 10px 22px rgba(4, 73, 139, 0.3)";

function setNoteButtonContent(button, iconSvg, label) {
  if (!button) return;
  button.innerHTML = iconSvg;
  const labelEl = document.createElement("span");
  labelEl.className = "digestdock-note-label";
  labelEl.textContent = label;
  button.appendChild(labelEl);
}

function isExtensionContextInvalidatedError(error) {
  return String(error?.message || error || "").includes(
    "Extension context invalidated",
  );
}

function showExtensionRefreshNotice() {
  const existing = document.getElementById(
    DIGESTDOCK_YOUTUBE_DOM_IDS.refreshNotice,
  );
  if (existing) existing.remove();
  const notice = document.createElement("div");
  notice.id = DIGESTDOCK_YOUTUBE_DOM_IDS.refreshNotice;
  notice.textContent =
    "DigestDock 已更新。请刷新当前 YouTube 页面后再生成摘要。";
  notice.style.cssText = `
    position: fixed;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999999;
    max-width: min(520px, calc(100vw - 32px));
    padding: 12px 18px;
    border: 1px solid #e7cfc6;
    border-radius: 12px;
    background: #fff8f4;
    color: #7d3527;
    box-shadow: 0 8px 24px rgba(50, 42, 32, 0.2);
    font: 600 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: center;
  `;
  document.body.appendChild(notice);
}

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. YouTube renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!window.location.pathname.includes("/watch")) return;
  if (ytdNoteButton?.isConnected || ytdNoteButtonRetryTimer) return;

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = document.querySelector(
      "#movie_player.html5-video-player, #movie_player, .html5-video-player",
    );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[DigestDock Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[DigestDock Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[DigestDock Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector("video.html5-main-video");
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[DigestDock Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[DigestDock Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the DigestDock side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findDigestButtonHost() {
  const primaryActionRows = Array.from(
    document.querySelectorAll("ytd-watch-metadata #actions-inner"),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const visibleButtonGroup = Array.from(
      actionRow.querySelectorAll("#top-level-buttons-computed"),
    ).find(isVisibleDigestHost);
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackCandidates = Array.from(
    document.querySelectorAll(
      "ytd-watch-metadata #actions #top-level-buttons-computed, " +
        "ytd-watch-metadata #top-level-buttons-computed, " +
        "#primary #actions #top-level-buttons-computed",
    ),
  );

  return (
    fallbackCandidates.find(
      (candidate) =>
        isVisibleDigestHost(candidate) &&
        (candidate.closest("ytd-watch-metadata") ||
          candidate.closest("#primary")),
    ) || null
  );
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = DIGESTDOCK_YOUTUBE_DOM_IDS.digestButton;
  digestButton.type = "button";
  digestButton.setAttribute("aria-label", "打开 DigestDock");
  digestButton.setAttribute("title", "DigestDock");
  // Compact brand icon + DDK label. The full product name stays in the
  // accessible name/title while the short label improves visual recognition.
  digestButton.innerHTML = DIGESTDOCK_BRAND_ICON_SVG;
  const digestLabel = document.createElement("span");
  digestLabel.className = "digestdock-short-label";
  digestLabel.textContent = "DDK";
  digestButton.appendChild(digestLabel);

  // A compact icon + text button sized to sit among YouTube's native controls.
  // width:max-content + flex:0 0 auto keep it from stretching into a full-width
  // second row when YouTube switches #actions-inner to a vertical column.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    gap: 6px;
    padding: 5px 12px 5px 7px;
    height: 36px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: #1f2933;
    font: 700 12.5px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0.01em;
    cursor: pointer;
    margin-right: 8px;
    transition: background 0.18s, transform 0.1s;
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects — subtle neutral wash, no colored glow.
  digestButton.addEventListener("mouseenter", () => {
    digestButton.style.background = "rgba(23, 33, 42, 0.08)";
  });

  digestButton.addEventListener("mouseleave", () => {
    digestButton.style.background = "transparent";
  });

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[DigestDock] Digest button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[DigestDock] openSidePanel response:", result);
    } catch (err) {
      if (isExtensionContextInvalidatedError(err)) {
        // Stay icon-only. The full instruction lives in the fixed refresh
        // notice; the button only needs a disabled state and an updated
        // accessible name, never a restored long brand label.
        digestButton.disabled = true;
        digestButton.setAttribute("aria-label", "DigestDock 已更新，请刷新页面");
        digestButton.setAttribute("title", "请刷新页面");
        showExtensionRefreshNotice();
        return;
      }
      console.error("[DigestDock] Failed to open side panel:", err);
    }
  });

  ytdDigestButton = digestButton;
  return digestButton;
}

/**
 * Reconciles the Digest button with YouTube's currently visible action row.
 * This is intentionally idempotent because YouTube rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  const existingButtons = Array.from(
    document.querySelectorAll(
      `#${DIGESTDOCK_YOUTUBE_DOM_IDS.digestButton}`,
    ),
  );

  if (!window.location.pathname.includes("/watch")) {
    existingButtons.forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[DigestDock Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    // YouTube turns #actions-inner into a vertical flex column at narrow
    // breakpoints. A direct child there stretches into a full-width second
    // row, so keep Digest inside the native horizontal button group and
    // prepend it to preserve visibility when space is limited.
    actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
  }

  debugLog("[DigestDock Content] Digest button reconciled");
  return true;
}

function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
  }

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    injectDigestButton();
  }, delay);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    // The note button already has a bounded retry loop and is retried after
    // yt-navigate-finish. Restarting that loop for every body mutation can
    // starve YouTube's watch-page renderer while it builds the player DOM.
    if (window.location.pathname.includes("/watch")) {
      scheduleDigestButtonReconciliation();
      const playerContainer = document.getElementById("movie_player");
      if (
        playerContainer &&
        !ytdNoteButton?.isConnected &&
        !ytdNoteButtonRetryTimer
      ) {
        injectNoteButton();
      } else if (ytdNoteButton?.isConnected) {
        updateNoteButtonCoexistencePosition();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  digestButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes("/watch")) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById(
    DIGESTDOCK_YOUTUBE_DOM_IDS.noteButton,
  );
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. YouTube rebuilds this dynamically, so
  // we try the most common selectors.
  const playerContainer = document.querySelector(
    "#movie_player.html5-video-player, " +
      "#movie_player, " +
      ".html5-video-player",
  );

  if (!playerContainer) {
    debugLog(
      "[DigestDock Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has relative positioning for absolute children
  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  debugLog("[DigestDock Content] Injecting note button");

  // Create the note button — a compact bookmark-plus + text action that floats
  // over the player. The visible label keeps the N shortcut discoverable.
  const noteButton = document.createElement("button");
  noteButton.id = DIGESTDOCK_YOUTUBE_DOM_IDS.noteButton;
  noteButton.type = "button";
  noteButton.setAttribute(
    "aria-label",
    DIGESTDOCK_NOTE_BUTTON_LABEL,
  );
  noteButton.setAttribute("title", DIGESTDOCK_NOTE_BUTTON_LABEL);
  setNoteButtonContent(
    noteButton,
    DIGESTDOCK_BOOKMARK_ICON_SVG,
    DIGESTDOCK_NOTE_BUTTON_LABEL,
  );

  // Compact blue-cyan action with a restrained shadow. Start hidden; visibility
  // is controlled by mouse activity.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    width: auto;
    min-width: 128px;
    height: 38px;
    padding: 0 14px;
    background: ${DIGESTDOCK_NOTE_BG};
    color: rgba(255, 255, 255, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 10px;
    font: 600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    white-space: nowrap;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: ${DIGESTDOCK_NOTE_SHADOW};
    -webkit-backdrop-filter: blur(6px) saturate(1.08);
    backdrop-filter: blur(6px) saturate(1.08);
  `;

  ytdNoteButton = noteButton;
  updateNoteButtonCoexistencePosition();

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Hover effect — subtle lift with a darker blue-cyan gradient.
  noteButton.addEventListener("mouseenter", () => {
    noteButton.style.background = DIGESTDOCK_NOTE_BG_HOVER;
    noteButton.style.color = "#ffffff";
    noteButton.style.boxShadow = DIGESTDOCK_NOTE_SHADOW_HOVER;
    noteButton.style.transform = "translateY(-1px)";
  });

  noteButton.addEventListener("mouseleave", () => {
    noteButton.style.background = DIGESTDOCK_NOTE_BG;
    noteButton.style.color = "rgba(255, 255, 255, 0.5)";
    noteButton.style.boxShadow = DIGESTDOCK_NOTE_SHADOW;
    noteButton.style.transform = "translateY(0)";
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  playerContainer.appendChild(noteButton);

  debugLog("[DigestDock Content] Note button injected");
}

function updateNoteButtonCoexistencePosition() {
  if (!ytdNoteButton) return;
  const legacyButton = document.getElementById(LEGACY_YOUTUBE_NOTE_BUTTON_ID);
  ytdNoteButton.style.top = legacyButton?.isConnected ? "58px" : "16px";
}

function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on YouTube watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!window.location.pathname.includes("/watch")) return;
  if (e.key !== "n" && e.key !== "N") return;

  // The legacy build owns the historical N shortcut when both versions are
  // enabled. DigestDock remains available through its visibly branded button,
  // while one keypress cannot save the same moment into two extension stores.
  if (
    document.getElementById(LEGACY_YOUTUBE_DIGEST_BUTTON_ID) ||
    document.getElementById(LEGACY_YOUTUBE_NOTE_BUTTON_ID)
  ) {
    return;
  }

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent YouTube's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[DigestDock] Saving note");

  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[DigestDock] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = new URLSearchParams(window.location.search).get("v");

  const noteButton = ytdNoteButton;
  const restoreLabel = DIGESTDOCK_NOTE_BUTTON_LABEL;
  const restoreTitle = DIGESTDOCK_NOTE_BUTTON_LABEL;

  const setNoteButtonState = (
    message,
    iconSvg = DIGESTDOCK_BOOKMARK_ICON_SVG,
  ) => {
    if (!noteButton) return;
    noteButton.setAttribute("title", message);
    noteButton.setAttribute("aria-label", message);
    setNoteButtonContent(noteButton, iconSvg, message);
  };

  if (noteButton) {
    setNoteButtonState("正在保存…");
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      if (noteButton) {
        setNoteButtonState("已保存", DIGESTDOCK_CHECK_ICON_SVG);
        noteButton.style.background = DIGESTDOCK_NOTE_SUCCESS_BG;
        noteButton.style.color = "#ffffff";
      }
      showNoteSavedToast(result.note);
    } else {
      const label =
        result.error === "SUPADATA_CONSENT_REQUIRED"
          ? "请在侧栏授权"
          : result.error === "SUPADATA_NOT_CONFIGURED"
            ? "需在设置配置 Supadata"
            : "出错了";
      setNoteButtonState(label);
      console.error("[DigestDock] Save note error:", result.error);
    }
  } catch (err) {
    setNoteButtonState("出错了");
    console.error("[DigestDock] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      setNoteButtonState(restoreLabel, DIGESTDOCK_BOOKMARK_ICON_SVG);
      noteButton.style.background = DIGESTDOCK_NOTE_BG;
      noteButton.style.color = "rgba(255, 255, 255, 0.5)";
      noteButton.style.pointerEvents = "auto";
      noteButton.setAttribute("title", restoreTitle);
      noteButton.setAttribute("aria-label", restoreLabel);
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById(
    DIGESTDOCK_YOUTUBE_DOM_IDS.noteToast,
  );
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = DIGESTDOCK_YOUTUBE_DOM_IDS.noteToast;
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">📝 笔记已保存</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">🔗 复制链接</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ${DIGESTDOCK_YOUTUBE_TOAST_ANIMATION} 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ${DIGESTDOCK_YOUTUBE_TOAST_ANIMATION} {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = "✓ 已复制";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation =
      `${DIGESTDOCK_YOUTUBE_TOAST_ANIMATION} 0.3s ease reverse`;
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
  );

  // Video duration from the video element
  const videoElement = document.querySelector("video.html5-main-video");

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    "#description-inner, " +
      "ytd-watch-metadata #description yt-attributed-string, " +
      "#description yt-formatted-string, " +
      "ytd-expander#description yt-attributed-string",
  );

  return {
    title: titleElement?.textContent?.trim() || "",
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================

/**
 * Adds colored marker dots to YouTube's video progress bar
 * at the positions of key moments identified by the AI provider.
 *
 * How it works:
 * - YouTube's progress bar is a <div> element with a known class
 * - We calculate each moment's position as a percentage of total duration
 * - We inject small colored <div> elements at those positions
 * - The markers are absolutely positioned on top of the progress bar
 *
 * This is a "bonus feature" — it gives you a visual preview
 * of where the good stuff is in the video.
 */
function highlightKeyMoments(moments, videoDuration) {
  // Disabled: no timeline markers. Chapters live only in the side panel.
  return;
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[DigestDock Content] No video element found for seek");
    return;
  }

  debugLog("[DigestDock Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener("yt-navigate-finish", () => {
  // Clean up old key moment markers when navigating to a new video
  const existingMarkers = document.querySelectorAll(
    `.${DIGESTDOCK_YOUTUBE_MARKER_CLASS}`,
  );
  existingMarkers.forEach((m) => m.remove());

  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll(`#${DIGESTDOCK_YOUTUBE_DOM_IDS.digestButton}`)
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById(
    DIGESTDOCK_YOUTUBE_DOM_IDS.noteButton,
  );
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  const existingToast = document.getElementById(
    DIGESTDOCK_YOUTUBE_DOM_IDS.noteToast,
  );
  if (existingToast) existingToast.remove();

  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
});

// Keep the runtime implementation scoped so an accidental duplicate injection
// cannot redeclare top-level const/let bindings. These selected helpers stay
// visible only for the repository's Node regression tests.
Object.assign(globalThis, {
  findDigestButtonHost,
  injectDigestButton,
  isExtensionContextInvalidatedError,
  setupButtonObserver,
  setupDigestButtonResizeListener,
});
globalThis.__YTD_CONTENT_SCRIPT_ACTIVE__ = true;
})();
