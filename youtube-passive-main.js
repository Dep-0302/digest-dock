(() => {
  "use strict";

  const GLOBAL_KEY = "__DIGESTDOCK_YOUTUBE_PASSIVE_MAIN_V1__";
  const CAPTURE_CHANNEL = "digestdock-youtube-passive-state-v1";
  const CONTROL_CHANNEL = "digestdock-youtube-passive-control-v1";
  const MAX_BODY_BYTES = 8 * 1024 * 1024;
  const MAX_PENDING_MESSAGES = 4;
  const CLONE_READ_TIMEOUT_MS = 15_000;

  if (window[GLOBAL_KEY]?.active) return;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalFetch = window.fetch;
  const xhrRequests = new WeakMap();
  const inFlight = new Map();
  const pendingMessages = [];
  let enabled = false;
  let bridgeNonce = null;
  let destroyed = false;

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

  // Return only the fields the isolated bridge is allowed to receive. In
  // particular, never forward the timedtext URL or any of its signed params.
  function summarizeTimedtextUrl(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl || ""), String(location.href || ""));
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.youtube.com" ||
      url.pathname !== "/api/timedtext" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      return null;
    }
    const videoId = validVideoId(url.searchParams.get("v"));
    const language =
      normalizeLanguage(url.searchParams.get("tlang")) ||
      normalizeLanguage(url.searchParams.get("lang"));
    if (!videoId || !language) return null;
    return {
      videoId,
      language,
      kind: url.searchParams.get("kind") === "asr" ? "asr" : "manual",
    };
  }

  function identityFor(summary) {
    return `${summary.videoId}:${summary.language}:${summary.kind}`;
  }

  function postPayload(payload) {
    if (destroyed) return;
    if (!bridgeNonce) {
      pendingMessages.push(payload);
      while (pendingMessages.length > MAX_PENDING_MESSAGES) {
        pendingMessages.shift();
      }
      return;
    }
    window.postMessage(
      { source: CAPTURE_CHANNEL, nonce: bridgeNonce, payload },
      location.origin,
    );
  }

  function begin(summary) {
    if (!enabled || currentVideoId() !== summary?.videoId) return null;
    const identity = identityFor(summary);
    const active = inFlight.get(identity) || { summary, tokens: new Set() };
    const token = { summary, active: true };
    active.tokens.add(token);
    inFlight.set(identity, active);
    postPayload({
      type: "inflight",
      ...summary,
      status: 0,
      inFlight: true,
    });
    return token;
  }

  function finish(token) {
    if (!token?.active) return null;
    const summary = token.summary;
    const identity = identityFor(summary);
    const active = inFlight.get(identity);
    if (!active?.tokens.has(token)) {
      token.active = false;
      return null;
    }
    active.tokens.delete(token);
    token.active = false;
    if (active.tokens.size > 0) {
      inFlight.set(identity, active);
      return true;
    }
    inFlight.delete(identity);
    return false;
  }

  function clear(token, status = 0) {
    const stillInFlight = finish(token);
    if (stillInFlight === null) return;
    if (stillInFlight) return;
    const summary = token.summary;
    postPayload({
      type: "clear",
      ...summary,
      status: Number.isInteger(Number(status)) ? Number(status) : 0,
      inFlight: false,
    });
  }

  function capture(token, status, body) {
    const stillInFlight = finish(token);
    if (stillInFlight === null) return;
    const summary = token.summary;
    if (currentVideoId() !== summary.videoId) {
      if (!stillInFlight) {
        postPayload({
          type: "clear",
          ...summary,
          status: 0,
          inFlight: false,
        });
      }
      return;
    }
    const normalizedStatus = Number(status);
    const bodyBytes = typeof body === "string" ? utf8ByteLength(body) : 0;
    if (
      !Number.isInteger(normalizedStatus) ||
      normalizedStatus < 100 ||
      normalizedStatus > 599 ||
      !bodyBytes ||
      bodyBytes > MAX_BODY_BYTES
    ) {
      if (!stillInFlight) {
        postPayload({
          type: "clear",
          ...summary,
          status: Number.isInteger(normalizedStatus) ? normalizedStatus : 0,
          inFlight: false,
        });
      }
      return;
    }
    postPayload({
      type: "capture",
      ...summary,
      status: normalizedStatus,
      body,
      inFlight: stillInFlight,
    });
  }

  function sameObservedTrack(left, right) {
    return Boolean(
      left &&
        right &&
        left.videoId === right.videoId &&
        left.language === right.language &&
        left.kind === right.kind,
    );
  }

  async function readBoundedClone(response) {
    const clone = response.clone();
    const declared = Number(clone.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
    const reader = clone.body?.getReader?.();
    let timedOut = false;
    let timeoutId;
    const readTask = (async () => {
      try {
        if (!reader) {
          const text = await clone.text();
          return utf8ByteLength(text) <= MAX_BODY_BYTES ? text : null;
        }
        const decoder = new TextDecoder();
        let text = "";
        let bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value?.byteLength || 0;
          if (bytes > MAX_BODY_BYTES) {
            await reader.cancel().catch(() => {});
            return null;
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
      } catch (error) {
        if (timedOut) return null;
        throw error;
      } finally {
        reader?.releaseLock?.();
      }
    })();
    const timeoutTask = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        if (reader) void reader.cancel().catch(() => {});
        resolve(null);
      }, CLONE_READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([readTask, timeoutTask]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function wrappedOpen(method, url, ...rest) {
    xhrRequests.set(this, summarizeTimedtextUrl(url));
    return originalOpen.call(this, method, url, ...rest);
  }

  function wrappedSend(...args) {
    const summary = xhrRequests.get(this);
    const token = summary ? begin(summary) : null;
    if (!token) return originalSend.apply(this, args);

    let completed = false;
    const completeAsClear = (status = 0) => {
      if (completed) return;
      completed = true;
      clear(token, status);
    };
    this.addEventListener(
      "load",
      () => {
        if (completed) return;
        completed = true;
        try {
          const finalSummary = summarizeTimedtextUrl(this.responseURL);
          const declared = Number(this.getResponseHeader?.("content-length"));
          if (
            !sameObservedTrack(summary, finalSummary) ||
            (this.responseType !== "" && this.responseType !== "text") ||
            (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
          ) {
            clear(token, this.status);
            return;
          }
          capture(token, this.status, this.responseText);
        } catch {
          clear(token, this.status);
        }
      },
      { once: true },
    );
    for (const eventName of ["error", "abort", "timeout"]) {
      this.addEventListener(
        eventName,
        () => completeAsClear(this.status),
        { once: true },
      );
    }
    try {
      return originalSend.apply(this, args);
    } catch (error) {
      completeAsClear(this.status);
      throw error;
    }
  }

  async function wrappedFetch(...args) {
    const input = args[0];
    const rawUrl =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input?.url;
    const summary = summarizeTimedtextUrl(rawUrl);
    const token = summary ? begin(summary) : null;
    let response;
    try {
      response = await originalFetch.apply(this, args);
    } catch (error) {
      if (token) clear(token, 0);
      throw error;
    }
    if (!token) return response;
    const finalSummary = summarizeTimedtextUrl(response?.url);
    if (!sameObservedTrack(summary, finalSummary)) {
      clear(token, response?.status);
      return response;
    }
    readBoundedClone(response)
      .then((body) => {
        if (body === null) clear(token, response.status);
        else capture(token, response.status, body);
      })
      .catch(() => clear(token, response.status));
    return response;
  }

  function enable() {
    if (destroyed || enabled) return;
    enabled = true;
    XMLHttpRequest.prototype.open = wrappedOpen;
    XMLHttpRequest.prototype.send = wrappedSend;
    if (typeof originalFetch === "function") window.fetch = wrappedFetch;
  }

  function clearAllInFlight() {
    for (const { summary, tokens } of inFlight.values()) {
      postPayload({
        type: "clear",
        ...summary,
        status: 0,
        inFlight: false,
      });
      for (const token of tokens) token.active = false;
    }
    inFlight.clear();
  }

  function resetForNavigation() {
    if (!enabled || destroyed) return;
    clearAllInFlight();
  }

  function disable() {
    if (!enabled) return;
    clearAllInFlight();
    enabled = false;
    if (XMLHttpRequest.prototype.open === wrappedOpen) {
      XMLHttpRequest.prototype.open = originalOpen;
    }
    if (XMLHttpRequest.prototype.send === wrappedSend) {
      XMLHttpRequest.prototype.send = originalSend;
    }
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
  }

  function destroy() {
    if (destroyed) return;
    disable();
    destroyed = true;
    pendingMessages.length = 0;
    window.removeEventListener("message", onControlMessage);
    window.removeEventListener("yt-navigate-start", resetForNavigation);
    window.removeEventListener("pagehide", destroy);
    if (window[GLOBAL_KEY]?.destroy === destroy) delete window[GLOBAL_KEY];
  }

  function onControlMessage(event) {
    if (
      destroyed ||
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== CONTROL_CHANNEL
    ) {
      return;
    }
    const nonce = String(event.data.nonce || "");
    if (event.data.action === "connect" && /^[0-9a-f]{32}$/.test(nonce)) {
      bridgeNonce = nonce;
      while (pendingMessages.length) postPayload(pendingMessages.shift());
      return;
    }
    if (!bridgeNonce || nonce !== bridgeNonce) return;
    if (event.data.action === "disable") disable();
    if (event.data.action === "enable") enable();
    if (event.data.action === "disconnect") destroy();
  }

  window.addEventListener("message", onControlMessage);
  window.addEventListener("yt-navigate-start", resetForNavigation);
  window.addEventListener("pagehide", destroy, { once: true });
  window[GLOBAL_KEY] = { active: true, enable, disable, destroy };
  enable();
})();
