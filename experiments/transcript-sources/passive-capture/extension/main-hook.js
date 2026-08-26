(() => {
  const GLOBAL_KEY = "__DIGESTDOCK_PASSIVE_TIMEDTEXT_HOOK_V1__";
  const CAPTURE_CHANNEL = "digestdock-passive-timedtext-v1";
  const CONTROL_CHANNEL = "digestdock-passive-control-v1";
  const MAX_BODY_BYTES = 8 * 1024 * 1024;
  const existing = window[GLOBAL_KEY];
  if (existing?.enable) {
    existing.enable();
    return;
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalFetch = window.fetch;
  const requests = new WeakMap();
  const pendingCaptures = [];
  let enabled = false;
  let bridgeNonce = null;

  function summarize(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl || ""), location.href);
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
    const videoId = url.searchParams.get("v") || "";
    if (!/^[0-9A-Za-z_-]{11}$/.test(videoId)) return null;
    const sourceLanguage = String(url.searchParams.get("lang") || "").slice(0, 35);
    const translatedLanguage = String(url.searchParams.get("tlang") || "").slice(0, 35);
    return {
      videoId,
      language: translatedLanguage || sourceLanguage,
      sourceLanguage,
      translatedLanguage: translatedLanguage || null,
      kind: url.searchParams.get("kind") === "asr" ? "asr" : "manual",
      format: String(url.searchParams.get("fmt") || "classic").slice(0, 20),
    };
  }

  function postCapture(message) {
    if (!bridgeNonce) {
      pendingCaptures.push(message);
      while (pendingCaptures.length > 2) pendingCaptures.shift();
      return;
    }
    window.postMessage(
      { ...message, nonce: bridgeNonce },
      location.origin,
    );
  }

  function emit(summary, status, body, transport, knownBytes = null) {
    if (!enabled || !summary || typeof body !== "string") return;
    const bodyBytes = Number.isFinite(knownBytes)
      ? knownBytes
      : new TextEncoder().encode(body).byteLength;
    if (!body.length || bodyBytes > MAX_BODY_BYTES) {
      return;
    }
    postCapture({
      source: CAPTURE_CHANNEL,
      payload: {
        ...summary,
        status: Number(status) || 0,
        body,
        bodyBytes,
        transport,
      },
    });
  }

  async function readBoundedClone(response) {
    const clone = response.clone();
    const declared = Number(clone.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
    const reader = clone.body?.getReader?.();
    if (!reader) {
      const text = await clone.text();
      const bytes = new TextEncoder().encode(text).byteLength;
      return bytes <= MAX_BODY_BYTES ? { text, bytes } : null;
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
    return { text, bytes };
  }

  function wrappedOpen(method, url, ...rest) {
    requests.set(this, summarize(url));
    return originalOpen.call(this, method, url, ...rest);
  }

  function wrappedSend(...args) {
    const summary = requests.get(this);
    if (summary) {
      this.addEventListener(
        "load",
        () => {
          try {
            const finalSummary = summarize(this.responseURL);
            if (
              finalSummary?.videoId === summary.videoId &&
              (this.responseType === "" || this.responseType === "text")
            ) {
              const declared = Number(this.getResponseHeader?.("content-length"));
              if (!Number.isFinite(declared) || declared <= MAX_BODY_BYTES) {
                emit(finalSummary, this.status, this.responseText, "xhr");
              }
            }
          } catch {
            // A non-text response is outside this experiment.
          }
        },
        { once: true },
      );
    }
    return originalSend.apply(this, args);
  }

  async function wrappedFetch(...args) {
    const input = args[0];
    const rawUrl =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input?.url;
    const summary = summarize(rawUrl);
    const response = await originalFetch.apply(this, args);
    const finalSummary = summarize(response.url);
    if (enabled && summary && finalSummary?.videoId === summary.videoId) {
      readBoundedClone(response)
        .then((captured) => {
          if (captured) {
            emit(
              finalSummary,
              response.status,
              captured.text,
              "fetch",
              captured.bytes,
            );
          }
        })
        .catch(() => {});
    }
    return response;
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    XMLHttpRequest.prototype.open = wrappedOpen;
    XMLHttpRequest.prototype.send = wrappedSend;
    window.fetch = wrappedFetch;
  }

  function disable() {
    enabled = false;
    if (XMLHttpRequest.prototype.open === wrappedOpen) {
      XMLHttpRequest.prototype.open = originalOpen;
    }
    if (XMLHttpRequest.prototype.send === wrappedSend) {
      XMLHttpRequest.prototype.send = originalSend;
    }
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== CONTROL_CHANNEL
    ) {
      return;
    }
    if (
      event.data.action === "connect" &&
      /^[0-9a-f]{32}$/.test(event.data.nonce || "")
    ) {
      bridgeNonce = event.data.nonce;
      while (pendingCaptures.length) postCapture(pendingCaptures.shift());
      return;
    }
    if (!bridgeNonce || event.data.nonce !== bridgeNonce) return;
    if (event.data.enabled === true) enable();
    if (event.data.enabled === false) disable();
  });

  window[GLOBAL_KEY] = { enable, disable };
  enable();
})();
