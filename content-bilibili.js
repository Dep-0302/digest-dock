/**
 * BILIBILI CONTENT SCRIPT
 *
 * Runs on standard https://www.bilibili.com/video/BV... pages. The
 * BILI_ADAPTER script is loaded before this file and owns URL parsing; this
 * file only reads the page, controls the HTML5 player, and adds small UI
 * affordances for Digest and timestamped notes.
 */

const BILI_VIDEO_SELECTOR =
  "#bilibili-player video, .bpx-player-container video";
const BILI_PLAYER_SELECTOR = "#bilibili-player, .bpx-player-container";
const BILI_DIGEST_HOST_SELECTOR =
  "#arc_toolbar_report .video-toolbar-right";
const DIGESTDOCK_BILIBILI_DOM_PREFIX =
  `digestdock-${chrome.runtime.id}-bilibili`;
const BILI_DIGEST_BUTTON_ID =
  `${DIGESTDOCK_BILIBILI_DOM_PREFIX}-digest-button`;
const BILI_NOTE_BUTTON_ID =
  `${DIGESTDOCK_BILIBILI_DOM_PREFIX}-note-button`;
const BILI_NOTE_TOAST_ID =
  `${DIGESTDOCK_BILIBILI_DOM_PREFIX}-note-toast`;
const LEGACY_BILI_DIGEST_BUTTON_ID = "bili-digest-button";
const LEGACY_BILI_NOTE_BUTTON_ID = "bili-note-button";

// This file must never assign element.innerHTML (see bilibili-content.test.js),
// so page icons are rendered as CSS background images built from self-contained
// inline SVGs. The brand icon matches icons/digestdock-icon-solid.svg; the note
// icon is the same linear bookmark-plus used across the extension.
const DIGESTDOCK_BILIBILI_BRAND_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
      '<defs><linearGradient id="dd-base" x1="12" y1="8" x2="116" y2="120" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="#0A5FE9"/><stop offset="0.46" stop-color="#087FE8"/>' +
      '<stop offset="1" stop-color="#04B7D2"/></linearGradient>' +
      '<radialGradient id="dd-glow" cx="0" cy="0" r="1" gradientTransform="translate(86 88) rotate(-132) scale(72 68)" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#30CFE5" stop-opacity="0.72"/><stop offset="1" stop-color="#0B80E8" stop-opacity="0"/>' +
      '</radialGradient></defs>' +
      '<rect width="128" height="128" rx="32" fill="url(#dd-base)"/>' +
      '<rect width="128" height="128" rx="32" fill="url(#dd-glow)"/>' +
      '<rect x="24" y="32" width="80" height="16" rx="8" fill="#FFFFFF"/>' +
      '<circle cx="32" cy="64" r="8" fill="#D8F7FF"/>' +
      '<rect x="48" y="56" width="56" height="16" rx="8" fill="#FFFFFF"/>' +
      '<rect x="40" y="80" width="56" height="16" rx="8" fill="#FFFFFF"/>' +
      "</svg>",
  );
const DIGESTDOCK_BILIBILI_NOTE_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h6"/>' +
      '<line x1="18" y1="3" x2="18" y2="9"/>' +
      '<line x1="15" y1="6" x2="21" y2="6"/>' +
      "</svg>",
  );
const DIGESTDOCK_BILIBILI_NOTE_ICON_MUTED =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h6"/>' +
      '<line x1="18" y1="3" x2="18" y2="9"/>' +
      '<line x1="15" y1="6" x2="21" y2="6"/>' +
      "</svg>",
  );
const DIGESTDOCK_BILIBILI_CHECK_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="20 6 9 17 4 12"/>' +
      "</svg>",
  );

const DIGESTDOCK_BILIBILI_NOTE_LABEL = "金句速记 (N)";
const DIGESTDOCK_BILIBILI_NOTE_GRADIENT =
  "linear-gradient(135deg, rgba(10, 95, 233, 0.2) 0%, rgba(8, 127, 232, 0.2) 52%, rgba(4, 183, 210, 0.2) 100%)";
const DIGESTDOCK_BILIBILI_NOTE_GRADIENT_HOVER =
  "linear-gradient(135deg, #0a5fe9 0%, #087fe8 52%, #04b7d2 100%)";
const DIGESTDOCK_BILIBILI_NOTE_SUCCESS_BG = "#2c8a65";
const DIGESTDOCK_BILIBILI_NOTE_SHADOW =
  "0 8px 18px rgba(4, 73, 139, 0.24)";

let biliDigestButton = null;
let biliNoteButton = null;
let biliNotePlayer = null;
let biliNotePlayerListeners = null;
let biliNoteHideTimer = null;
let biliNoteRetryTimer = null;
let biliReconcileTimer = null;
let biliNavigationPollTimer = null;
let biliObserver = null;
let biliKeyboardListenerAdded = false;
let biliResizeListenerAdded = false;
let biliLastNavigationKey = "";

function biliGetAdapter() {
  if (typeof BILI_ADAPTER !== "undefined") return BILI_ADAPTER;
  // The production adapter keeps its descriptive BILIBILI_ADAPTER name. The
  // shorter alias is also accepted so this content script stays compatible
  // with the integration contract used by early PoC builds.
  if (typeof BILIBILI_ADAPTER !== "undefined") return BILIBILI_ADAPTER;
  return globalThis.BILI_ADAPTER || globalThis.BILIBILI_ADAPTER || null;
}

function biliParseCurrentVideo() {
  const adapter = biliGetAdapter();
  if (!adapter || typeof adapter.parseBilibiliVideoUrl !== "function") {
    return null;
  }

  try {
    return adapter.parseBilibiliVideoUrl(window.location.href);
  } catch {
    return null;
  }
}

function biliIsVideoPage() {
  return Boolean(biliParseCurrentVideo());
}

function biliGetVideoElement() {
  return document.querySelector(BILI_VIDEO_SELECTOR);
}

function biliExtractVideoInfo() {
  const media = biliParseCurrentVideo();
  const video = biliGetVideoElement();
  const title = document.querySelector("h1.video-title");
  const creator = document.querySelector(".up-info-container .up-name");
  const description = document.querySelector(
    ".basic-desc-info .desc-info-text",
  );

  return {
    platform: "bilibili",
    videoId: media?.bvid || "",
    videoUrl: media?.canonicalUrl || window.location.href,
    title: title?.textContent?.trim() || "",
    channelName: creator?.textContent?.trim() || "",
    description: description?.textContent?.trim() || "",
    descriptionStatus: description
      ? description.textContent?.trim()
        ? "present"
        : "confirmed-empty"
      : "unknown",
    duration: Number.isFinite(Number(video?.duration))
      ? Number(video.duration)
      : 0,
  };
}

function biliSeekToTimestamp(seconds) {
  const video = biliGetVideoElement();
  const target = Number(seconds);
  if (!video || !Number.isFinite(target) || target < 0) return false;

  video.currentTime = target;
  if (video.paused && typeof video.play === "function") {
    Promise.resolve(video.play()).catch(() => {});
  }
  return true;
}

function biliHandleMessage(message, _sender, sendResponse) {
  const action = message?.action;

  if (action === "getVideoInfo") {
    sendResponse(biliExtractVideoInfo());
    return false;
  }

  if (action === "getCurrentTime") {
    const video = biliGetVideoElement();
    sendResponse({
      currentTime: video ? Math.max(0, Math.floor(Number(video.currentTime) || 0)) : 0,
      paused: video ? Boolean(video.paused) : true,
    });
    return false;
  }

  if (action === "seekTo") {
    sendResponse({ success: biliSeekToTimestamp(message.seconds) });
    return false;
  }

  if (action === "highlightMoments") {
    // Chapters are intentionally rendered only in the side panel.
    sendResponse({ success: true });
    return false;
  }

  if (action === "showNoteSavedFeedback") {
    biliShowNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  sendResponse({ success: false, error: "Unknown action" });
  return false;
}

chrome.runtime.onMessage.addListener(biliHandleMessage);

function biliCreateElement(tagName, options = {}) {
  const element = document.createElement(tagName);
  if (options.id) element.id = options.id;
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = String(options.text);
  return element;
}

function biliCreateDigestButton() {
  const button = biliCreateElement("button", {
    id: BILI_DIGEST_BUTTON_ID,
  });
  button.type = "button";
  button.setAttribute("aria-label", "打开 DigestDock");
  button.setAttribute("title", "DigestDock");
  button.textContent = "DDK";
  // Compact brand icon + DDK label — no ambiguous "▶" character.
  button.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    width: auto;
    min-width: 68px;
    height: 34px;
    padding: 0 11px 0 36px;
    margin-right: 10px;
    border: 0;
    border-radius: 10px;
    background-color: transparent;
    background-image: url("${DIGESTDOCK_BILIBILI_BRAND_ICON}");
    background-repeat: no-repeat;
    background-position: 6px center;
    background-size: 26px 26px;
    color: inherit;
    font: 700 12.5px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0.01em;
    white-space: nowrap;
    cursor: pointer;
    flex: 0 0 auto;
  `;

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await chrome.runtime.sendMessage({
        action: "openSidePanel",
        platform: "bilibili",
        videoUrl:
          biliParseCurrentVideo()?.canonicalUrl || window.location.href,
      });
    } catch (error) {
      if (
        String(error?.message || error || "").includes(
          "Extension context invalidated",
        )
      ) {
        // Stay icon-only: disable and update the accessible name/tooltip
        // instead of restoring visible text on the brand button.
        button.disabled = true;
        button.setAttribute("aria-label", "DigestDock 已更新，请刷新页面");
        button.setAttribute("title", "请刷新页面");
      } else {
        console.error("[DigestDock/Bilibili] 无法打开侧边栏", error);
      }
    }
  });

  biliDigestButton = button;
  return button;
}

function biliFindDigestPlacement() {
  const host = document.querySelector(BILI_DIGEST_HOST_SELECTOR);
  const nativeNoteButton = host?.querySelector?.(".video-note") || null;
  if (!host || !nativeNoteButton) return null;

  // insertBefore needs a direct child. Bilibili has used both a direct
  // .video-note button and a small wrapper around it, so walk to the direct
  // toolbar child while preserving the visual position before the native note.
  let insertionReference = nativeNoteButton;
  while (
    insertionReference.parentElement &&
    insertionReference.parentElement !== host
  ) {
    insertionReference = insertionReference.parentElement;
  }
  if (insertionReference.parentElement !== host) return null;
  return { host, nativeNoteButton, insertionReference };
}

function biliInjectDigestButton() {
  const existing = Array.from(
    document.querySelectorAll(`#${BILI_DIGEST_BUTTON_ID}`),
  );

  if (!biliIsVideoPage()) {
    existing.forEach((button) => button.remove());
    biliDigestButton = null;
    return false;
  }

  const placement = biliFindDigestPlacement();
  if (!placement) return false;

  let button = existing.find(
    (candidate) => candidate === biliDigestButton && candidate.isConnected,
  );
  if (!button) {
    existing.forEach((candidate) => candidate.remove());
    button = biliCreateDigestButton();
  }

  existing.forEach((candidate) => {
    if (candidate !== button) candidate.remove();
  });

  if (
    button.parentElement !== placement.host ||
    button.nextSibling !== placement.insertionReference
  ) {
    placement.host.insertBefore(button, placement.insertionReference);
  }

  return true;
}

function biliDetachNotePlayerListeners() {
  if (!biliNotePlayer || !biliNotePlayerListeners) return;
  for (const [type, listener] of Object.entries(biliNotePlayerListeners)) {
    biliNotePlayer.removeEventListener?.(type, listener);
  }
  biliNotePlayerListeners = null;
  biliNotePlayer = null;
}

function biliShowNoteButton() {
  if (!biliNoteButton) return;
  biliNoteButton.style.opacity = "1";
  biliNoteButton.style.pointerEvents = "auto";
}

function biliHideNoteButton() {
  if (!biliNoteButton) return;
  biliNoteButton.style.opacity = "0";
  biliNoteButton.style.pointerEvents = "none";
}

function biliResetNoteHideTimer() {
  if (biliNoteHideTimer) clearTimeout(biliNoteHideTimer);
  biliNoteHideTimer = setTimeout(() => {
    biliNoteHideTimer = null;
    biliHideNoteButton();
  }, 2000);
}

function biliCreateNoteButton() {
  const button = biliCreateElement("button", {
    id: BILI_NOTE_BUTTON_ID,
  });
  button.type = "button";
  // Bookmark-plus + text control — no ambiguous glyph-only action.
  button.setAttribute(
    "aria-label",
    DIGESTDOCK_BILIBILI_NOTE_LABEL,
  );
  button.setAttribute("title", DIGESTDOCK_BILIBILI_NOTE_LABEL);
  button.textContent = DIGESTDOCK_BILIBILI_NOTE_LABEL;
  button.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 10000;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    width: auto;
    min-width: 128px;
    height: 38px;
    padding: 0 14px 0 40px;
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 10px;
    background-color: transparent;
    background-image: url("${DIGESTDOCK_BILIBILI_NOTE_ICON_MUTED}"), ${DIGESTDOCK_BILIBILI_NOTE_GRADIENT};
    background-repeat: no-repeat, no-repeat, no-repeat;
    background-position: 14px center, center, center;
    background-size: 18px 18px, cover, cover;
    color: rgba(255, 255, 255, 0.5);
    font: 600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    white-space: nowrap;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    box-shadow: ${DIGESTDOCK_BILIBILI_NOTE_SHADOW};
    -webkit-backdrop-filter: blur(6px) saturate(1.08);
    backdrop-filter: blur(6px) saturate(1.08);
    transition: opacity 0.18s ease, transform 0.18s ease, background-color 0.18s ease;
  `;
  button.addEventListener("mouseenter", () => {
    if (button.disabled) return;
    button.style.backgroundImage =
      `url("${DIGESTDOCK_BILIBILI_NOTE_ICON}"), ` +
      DIGESTDOCK_BILIBILI_NOTE_GRADIENT_HOVER;
    button.style.color = "#ffffff";
    button.style.transform = "translateY(-1px)";
  });
  button.addEventListener("mouseleave", () => {
    if (button.disabled) return;
    button.style.backgroundImage =
      `url("${DIGESTDOCK_BILIBILI_NOTE_ICON_MUTED}"), ` +
      DIGESTDOCK_BILIBILI_NOTE_GRADIENT;
    button.style.color = "rgba(255, 255, 255, 0.5)";
    button.style.transform = "translateY(0)";
  });
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await biliSaveCurrentNote();
  });
  biliNoteButton = button;
  biliUpdateNoteButtonCoexistencePosition();
  return button;
}

function biliUpdateNoteButtonCoexistencePosition() {
  if (!biliNoteButton) return;
  const legacyButton = document.getElementById(LEGACY_BILI_NOTE_BUTTON_ID);
  biliNoteButton.style.top = legacyButton?.isConnected ? "58px" : "16px";
}

function biliInjectNoteButton() {
  if (!biliIsVideoPage()) return false;

  const video = biliGetVideoElement();
  const player =
    video?.closest?.(BILI_PLAYER_SELECTOR) ||
    document.querySelector(BILI_PLAYER_SELECTOR);
  if (!video || !player) return false;

  const existing = document.getElementById(BILI_NOTE_BUTTON_ID);
  if (
    existing &&
    existing === biliNoteButton &&
    existing.isConnected &&
    existing.parentElement === player
  ) {
    biliUpdateNoteButtonCoexistencePosition();
    return true;
  }

  existing?.remove();
  if (biliNoteButton && biliNoteButton !== existing) biliNoteButton.remove();
  biliDetachNotePlayerListeners();

  const computedPosition = window.getComputedStyle?.(player)?.position;
  if (computedPosition === "static") {
    player.style.position = "relative";
  }

  const button = biliCreateNoteButton();
  const show = () => {
    biliShowNoteButton();
    biliResetNoteHideTimer();
  };
  const hide = () => {
    if (biliNoteHideTimer) clearTimeout(biliNoteHideTimer);
    biliNoteHideTimer = null;
    biliHideNoteButton();
  };
  biliNotePlayer = player;
  biliNotePlayerListeners = {
    mouseenter: show,
    mousemove: show,
    mouseleave: hide,
  };
  for (const [type, listener] of Object.entries(biliNotePlayerListeners)) {
    player.addEventListener(type, listener);
  }
  player.appendChild(button);
  return true;
}

function biliTryInjectNoteButton() {
  if (!biliIsVideoPage()) return false;
  if (biliInjectNoteButton()) return true;

  if (biliNoteRetryTimer) return false;
  let attempts = 0;
  biliNoteRetryTimer = setInterval(() => {
    attempts += 1;
    if (biliInjectNoteButton() || attempts >= 30) {
      clearInterval(biliNoteRetryTimer);
      biliNoteRetryTimer = null;
    }
  }, 100);
  return false;
}

async function biliSaveCurrentNote() {
  const video = biliGetVideoElement();
  if (!video) return { success: false, error: "No video element" };

  const info = biliExtractVideoInfo();
  const timestamp = Math.max(0, Math.floor(Number(video.currentTime) || 0) - 3);
  const setNoteState = (message) => {
    if (!biliNoteButton) return;
    biliNoteButton.setAttribute("title", message);
    biliNoteButton.setAttribute("aria-label", message);
    biliNoteButton.textContent = message;
  };
  if (biliNoteButton) {
    setNoteState("正在保存…");
    biliNoteButton.disabled = true;
  }

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      action: "saveNote",
      platform: "bilibili",
      videoId: info.videoId,
      videoUrl: info.videoUrl,
      timestamp,
      videoTitle: info.title,
      channelName: info.channelName,
    });

    if (result?.success) {
      if (biliNoteButton) {
        biliNoteButton.style.backgroundImage =
          `url("${DIGESTDOCK_BILIBILI_CHECK_ICON}"), ` +
          `linear-gradient(${DIGESTDOCK_BILIBILI_NOTE_SUCCESS_BG}, ${DIGESTDOCK_BILIBILI_NOTE_SUCCESS_BG})`;
        biliNoteButton.style.backgroundColor = DIGESTDOCK_BILIBILI_NOTE_SUCCESS_BG;
        biliNoteButton.style.color = "#ffffff";
        setNoteState("已保存");
      }
      if (result.note) biliShowNoteSavedToast(result.note);
    } else {
      setNoteState("出错了");
    }
  } catch (error) {
    result = { success: false, error: error?.message || String(error) };
    setNoteState("出错了");
    console.error("[DigestDock/Bilibili] 保存笔记失败", error);
  }

  setTimeout(() => {
    if (!biliNoteButton) return;
    biliNoteButton.style.backgroundImage =
      `url("${DIGESTDOCK_BILIBILI_NOTE_ICON_MUTED}"), ` +
      DIGESTDOCK_BILIBILI_NOTE_GRADIENT;
    biliNoteButton.style.backgroundColor = "transparent";
    biliNoteButton.style.color = "rgba(255, 255, 255, 0.5)";
    biliNoteButton.textContent = DIGESTDOCK_BILIBILI_NOTE_LABEL;
    biliNoteButton.setAttribute("title", DIGESTDOCK_BILIBILI_NOTE_LABEL);
    biliNoteButton.setAttribute(
      "aria-label",
      DIGESTDOCK_BILIBILI_NOTE_LABEL,
    );
    biliNoteButton.disabled = false;
  }, 1800);
  return result;
}

function biliIsSafeTimestampUrl(input) {
  try {
    const url = new URL(String(input || ""));
    return (
      url.protocol === "https:" &&
      url.hostname === "www.bilibili.com" &&
      /^\/video\/BV[0-9A-Za-z]{6,20}(?:\/|$)/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function biliShowNoteSavedToast(note = {}) {
  document.getElementById(BILI_NOTE_TOAST_ID)?.remove();

  const toast = biliCreateElement("div", { id: BILI_NOTE_TOAST_ID });
  toast.style.cssText = `
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 999999;
    width: min(350px, calc(100vw - 40px));
    box-sizing: border-box;
    padding: 16px 20px;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    background: #fff;
    color: #2e2a24;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font: 13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  `;

  const heading = biliCreateElement("div", { text: "📝 笔记已保存" });
  heading.style.fontWeight = "700";
  heading.style.color = "#c8674f";

  const meta = biliCreateElement("div", {
    text: `${String(note.timestamp || "")} — ${String(note.videoTitle || "")}`,
  });
  meta.style.marginTop = "6px";
  meta.style.fontSize = "12px";
  meta.style.color = "#6b6258";

  const body = biliCreateElement("div", {
    text: String(note.text || ""),
  });
  body.style.marginTop = "8px";

  toast.appendChild(heading);
  toast.appendChild(meta);
  toast.appendChild(body);

  if (biliIsSafeTimestampUrl(note.timestampedUrl)) {
    const copy = biliCreateElement("button", { text: "🔗 复制链接" });
    copy.type = "button";
    copy.style.cssText = `
      margin: 10px 0 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: #c8674f;
      font: 600 11px/1.4 system-ui, sans-serif;
      cursor: pointer;
    `;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(note.timestampedUrl));
        copy.textContent = "✓ 已复制";
      } catch {
        copy.textContent = "复制失败";
      }
    });
    toast.appendChild(copy);
  }

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
  return toast;
}

function biliHandleNoteKeyboardShortcut(event) {
  if (!biliIsVideoPage()) return;
  if (event.key !== "n" && event.key !== "N") return;
  if (event.repeat) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  // Avoid two note saves when a legacy YouTube Digest installation remains
  // enabled. Its historical N shortcut keeps working; DigestDock is available
  // through the separate, visibly branded overlay button.
  if (
    document.getElementById(LEGACY_BILI_DIGEST_BUTTON_ID) ||
    document.getElementById(LEGACY_BILI_NOTE_BUTTON_ID)
  ) {
    return;
  }

  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  biliShowNoteButton();
  biliResetNoteHideTimer();
  void biliSaveCurrentNote();
}

function biliNavigationKey() {
  let page = "1";
  try {
    page = new URL(window.location.href).searchParams.get("p") || "1";
  } catch {
    // Keep the default P1 marker for an incomplete navigation URL.
  }
  return `${window.location.pathname}?p=${page}`;
}

function biliCleanupPageArtifacts() {
  document
    .querySelectorAll(
      `#${BILI_DIGEST_BUTTON_ID}, #${BILI_NOTE_BUTTON_ID}, #${BILI_NOTE_TOAST_ID}`,
    )
    .forEach((element) => element.remove());
  biliDigestButton = null;
  biliNoteButton = null;
  if (biliNoteHideTimer) clearTimeout(biliNoteHideTimer);
  biliNoteHideTimer = null;
  if (biliNoteRetryTimer) clearInterval(biliNoteRetryTimer);
  biliNoteRetryTimer = null;
  biliDetachNotePlayerListeners();
}

function biliReconcilePage() {
  if (!biliIsVideoPage()) {
    biliCleanupPageArtifacts();
    return;
  }
  biliInjectDigestButton();
  biliTryInjectNoteButton();
}

function biliScheduleReconcile(delay = 80) {
  if (biliReconcileTimer) clearTimeout(biliReconcileTimer);
  biliReconcileTimer = setTimeout(() => {
    biliReconcileTimer = null;
    biliReconcilePage();
  }, delay);
}

function biliPollNavigation() {
  const nextKey = biliNavigationKey();
  if (nextKey === biliLastNavigationKey) {
    if (
      !document.getElementById(BILI_DIGEST_BUTTON_ID)?.isConnected ||
      !document.getElementById(BILI_NOTE_BUTTON_ID)?.isConnected
    ) {
      biliReconcilePage();
    }
    return false;
  }
  biliLastNavigationKey = nextKey;
  biliCleanupPageArtifacts();
  biliScheduleReconcile(150);
  return true;
}

function biliSetupObserver() {
  if (biliObserver || !document.body) return;
  biliObserver = new MutationObserver(() => biliScheduleReconcile());
  biliObserver.observe(document.body, { childList: true, subtree: true });
}

function biliInit() {
  if (!biliKeyboardListenerAdded) {
    document.addEventListener("keydown", biliHandleNoteKeyboardShortcut);
    biliKeyboardListenerAdded = true;
  }
  if (!biliResizeListenerAdded) {
    window.addEventListener("resize", () => biliScheduleReconcile(120));
    biliResizeListenerAdded = true;
  }
  biliSetupObserver();
  biliLastNavigationKey = biliNavigationKey();
  if (!biliNavigationPollTimer) {
    // Bilibili changes both pathname (new BV) and ?p= (new part) without a
    // document reload, so poll the compact navigation key alongside the DOM
    // observer. This avoids relying on undocumented site events.
    biliNavigationPollTimer = setInterval(biliPollNavigation, 500);
  }
  biliReconcilePage();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", biliInit);
} else {
  biliInit();
}
