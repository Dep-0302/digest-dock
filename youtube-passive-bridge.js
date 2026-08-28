(() => {
  "use strict";

  const GLOBAL_KEY = "__DIGESTDOCK_YOUTUBE_PASSIVE_BRIDGE_V1__";
  const CAPTURE_CHANNEL = "digestdock-youtube-passive-state-v1";
  const CONTROL_CHANNEL = "digestdock-youtube-passive-control-v1";
  const MAX_BODY_BYTES = 8 * 1024 * 1024;
  const existing = globalThis[GLOBAL_KEY];
  if (existing?.destroy) existing.destroy({ disconnect: false });

  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const knownIdentities = new Map();
  const connectTimers = [];
  const navigationTimers = [];
  let destroyed = false;
  let lastVideoId = currentVideoId();

  function utf8ByteLength(value) {
    const text = String(value || "");
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text).byteLength;
    }
    let bytes = 0;
    for (const character of text) {
      const point = character.codePointAt(0);
      if (point <= 0x7f) bytes += 1;
      else if (point <= 0x7ff) bytes += 2;
      else if (point <= 0xffff) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  }

  function normalizeLanguage(value) {
    const language = String(value || "").trim().replace(/_/g, "-");
    return language.length <= 35 &&
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)
      ? language
      : null;
  }

  function validVideoId(value) {
    const videoId = String(value || "");
    return /^[0-9A-Za-z_-]{11}$/.test(videoId) ? videoId : null;
  }

  function currentVideoId() {
    try {
      const url = new URL(String(location.href || ""));
      if (
        url.protocol !== "https:" ||
        url.hostname !== "www.youtube.com" ||
        url.pathname !== "/watch"
      ) {
        return null;
      }
      return validVideoId(url.searchParams.get("v"));
    } catch {
      return null;
    }
  }

  function identityFor(payload) {
    return `${payload.videoId}:${payload.language}:${payload.kind}`;
  }

  function sanitizePayload(raw) {
    if (!raw || typeof raw !== "object") return null;
    const type = String(raw.type || "");
    const videoId = validVideoId(raw.videoId);
    const language = normalizeLanguage(raw.language);
    const kind = raw.kind === "asr" ? "asr" : raw.kind === "manual" ? "manual" : null;
    const status = Number(raw.status);
    if (
      !["inflight", "capture", "clear"].includes(type) ||
      !videoId ||
      !language ||
      !kind ||
      !Number.isInteger(status) ||
      status < 0 ||
      status > 599
    ) {
      return null;
    }
    if (type === "inflight") {
      if (raw.inFlight !== true || status !== 0 || "body" in raw) return null;
      return { type, videoId, language, kind, status, inFlight: true };
    }
    if (type === "clear") {
      if (raw.inFlight !== false || "body" in raw) return null;
      return { type, videoId, language, kind, status, inFlight: false };
    }
    const body = typeof raw.body === "string" ? raw.body : "";
    const bodyBytes = utf8ByteLength(body);
    if (
      raw.inFlight !== true && raw.inFlight !== false ||
      status < 100 ||
      !bodyBytes ||
      bodyBytes > MAX_BODY_BYTES
    ) {
      return null;
    }
    return {
      type,
      videoId,
      language,
      kind,
      status,
      body,
      inFlight: raw.inFlight,
    };
  }

  function sendRuntime(payload) {
    if (destroyed) return;
    try {
      const result = chrome.runtime.sendMessage({
        action: "youtubePassiveState",
        payload,
      });
      if (result?.catch) result.catch(() => {});
    } catch {
      // Extension teardown must not affect the YouTube page.
    }
  }

  function clearKnown() {
    for (const payload of knownIdentities.values()) {
      sendRuntime({
        type: "clear",
        videoId: payload.videoId,
        language: payload.language,
        kind: payload.kind,
        status: 0,
        inFlight: false,
      });
    }
    knownIdentities.clear();
  }

  function synchronizeVideo() {
    if (destroyed) return;
    const nextVideoId = currentVideoId();
    if (nextVideoId === lastVideoId) return;
    clearKnown();
    lastVideoId = nextVideoId;
  }

  function scheduleVideoSync() {
    if (destroyed) return;
    const timer = setTimeout(() => {
      navigationTimers.splice(navigationTimers.indexOf(timer), 1);
      synchronizeVideo();
    }, 0);
    navigationTimers.push(timer);
  }

  function connect() {
    if (destroyed) return;
    window.postMessage(
      { source: CONTROL_CHANNEL, action: "connect", nonce },
      location.origin,
    );
  }

  function onMainMessage(event) {
    if (
      destroyed ||
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== CAPTURE_CHANNEL ||
      event.data?.nonce !== nonce
    ) {
      return;
    }
    synchronizeVideo();
    const payload = sanitizePayload(event.data.payload);
    if (!payload) return;
    const identity = identityFor(payload);
    if (payload.type === "clear") {
      knownIdentities.delete(identity);
      sendRuntime(payload);
      return;
    }
    if (!lastVideoId || payload.videoId !== lastVideoId) {
      if (knownIdentities.has(identity)) {
        knownIdentities.delete(identity);
        sendRuntime({
          type: "clear",
          videoId: payload.videoId,
          language: payload.language,
          kind: payload.kind,
          status: 0,
          inFlight: false,
        });
      }
      return;
    }
    if (payload.type === "capture" && !knownIdentities.has(identity)) return;
    knownIdentities.set(identity, {
      videoId: payload.videoId,
      language: payload.language,
      kind: payload.kind,
    });
    sendRuntime(payload);
  }

  function destroy({ disconnect = true } = {}) {
    if (destroyed) return;
    clearKnown();
    if (disconnect) {
      window.postMessage(
        { source: CONTROL_CHANNEL, action: "disconnect", nonce },
        location.origin,
      );
    }
    destroyed = true;
    for (const timer of [...connectTimers, ...navigationTimers]) {
      clearTimeout(timer);
    }
    connectTimers.length = 0;
    navigationTimers.length = 0;
    window.removeEventListener("message", onMainMessage);
    window.removeEventListener("yt-navigate-finish", scheduleVideoSync);
    window.removeEventListener("popstate", scheduleVideoSync);
    window.removeEventListener("pagehide", destroy);
    if (globalThis[GLOBAL_KEY]?.destroy === destroy) {
      delete globalThis[GLOBAL_KEY];
    }
  }

  window.addEventListener("message", onMainMessage);
  window.addEventListener("yt-navigate-finish", scheduleVideoSync);
  window.addEventListener("popstate", scheduleVideoSync);
  window.addEventListener("pagehide", destroy, { once: true });
  globalThis[GLOBAL_KEY] = { destroy };
  connect();
  for (const delay of [50, 250, 1000]) {
    connectTimers.push(setTimeout(connect, delay));
  }
})();
