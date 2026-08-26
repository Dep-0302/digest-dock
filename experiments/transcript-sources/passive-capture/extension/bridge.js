(() => {
  const CAPTURE_CHANNEL = "digestdock-passive-timedtext-v1";
  const CONTROL_CHANNEL = "digestdock-passive-control-v1";
  const MAX_BODY_BYTES = 8 * 1024 * 1024;
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

  function connect() {
    window.postMessage(
      { source: CONTROL_CHANNEL, action: "connect", nonce },
      location.origin,
    );
  }

  for (const delay of [0, 50, 250, 1000]) setTimeout(connect, delay);

  function currentVideoId() {
    if (location.pathname !== "/watch") return null;
    const videoId = new URL(location.href).searchParams.get("v");
    return /^[0-9A-Za-z_-]{11}$/.test(videoId || "") ? videoId : null;
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== CAPTURE_CHANNEL ||
      event.data?.nonce !== nonce
    ) {
      return;
    }
    const payload = event.data.payload;
    const videoId = currentVideoId();
    if (
      !payload ||
      !videoId ||
      payload.videoId !== videoId ||
      typeof payload.body !== "string" ||
      !payload.body.length ||
      new TextEncoder().encode(payload.body).byteLength > MAX_BODY_BYTES ||
      !["xhr", "fetch"].includes(payload.transport)
    ) {
      return;
    }
    chrome.runtime
      .sendMessage({ action: "recordPassiveTimedtextCapture", capture: payload })
      .catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "setPassiveCaptureEnabled") return false;
    window.postMessage(
      {
        source: CONTROL_CHANNEL,
        nonce,
        enabled: message.enabled === true,
      },
      location.origin,
    );
    sendResponse({ ok: true, enabled: message.enabled === true });
    return false;
  });
})();
