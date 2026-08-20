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
const BILI_DIGEST_BUTTON_ID = "bili-digest-button";
const BILI_NOTE_BUTTON_ID = "bili-note-button";
const BILI_NOTE_TOAST_ID = "bili-note-toast";

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
  button.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 34px;
    padding: 0 16px;
    margin-right: 10px;
    border: 0;
    border-radius: 17px;
    background: #c8674f;
    color: #fff;
    font: 600 14px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    white-space: nowrap;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(200, 103, 79, 0.25);
  `;

  const icon = biliCreateElement("span", { text: "▶" });
  icon.setAttribute("aria-hidden", "true");
  icon.style.marginRight = "7px";
  const label = biliCreateElement("span", { text: "生成摘要" });
  button.appendChild(icon);
  button.appendChild(label);

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
        button.disabled = true;
        button.textContent = "请刷新页面";
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
    text: "✎  笔记",
  });
  button.type = "button";
  button.setAttribute("aria-label", "保存当前时刻的笔记（快捷键 N）");
  button.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 10000;
    display: inline-flex;
    align-items: center;
    padding: 9px 16px;
    border: 0;
    border-radius: 999px;
    background: #c8674f;
    color: #fff;
    font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
    transition: opacity 0.18s ease, transform 0.18s ease;
  `;
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await biliSaveCurrentNote();
  });
  biliNoteButton = button;
  return button;
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
  const originalText = biliNoteButton?.textContent || "✎  笔记";
  if (biliNoteButton) {
    biliNoteButton.textContent = "正在保存…";
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
      if (biliNoteButton) biliNoteButton.textContent = "已保存";
      if (result.note) biliShowNoteSavedToast(result.note);
    } else if (biliNoteButton) {
      biliNoteButton.textContent = "出错了";
    }
  } catch (error) {
    result = { success: false, error: error?.message || String(error) };
    if (biliNoteButton) biliNoteButton.textContent = "出错了";
    console.error("[DigestDock/Bilibili] 保存笔记失败", error);
  }

  setTimeout(() => {
    if (!biliNoteButton) return;
    biliNoteButton.textContent = originalText;
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
