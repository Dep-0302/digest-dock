var SUPADATA_PROBE_CORE = (() => {
  function normalizeLanguage(value) {
    const language = String(value || "").trim().replace(/_/g, "-");
    return language && language.length <= 35 &&
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)
      ? language
      : null;
  }

  function videoIdFromUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.hostname !== "www.youtube.com" || url.pathname !== "/watch") {
        return null;
      }
      const videoId = url.searchParams.get("v");
      return /^[0-9A-Za-z_-]{11}$/.test(videoId || "") ? videoId : null;
    } catch {
      return null;
    }
  }

  function normalizePayload(payload, expectedLanguage = null) {
    const content = Array.isArray(payload?.content) ? payload.content : [];
    const language = normalizeLanguage(
      payload?.lang || content.find((chunk) => chunk?.lang)?.lang,
    );
    const requestedLanguage = normalizeLanguage(expectedLanguage);
    if (
      requestedLanguage &&
      (!language ||
        language.toLowerCase().split("-")[0] !==
          requestedLanguage.toLowerCase().split("-")[0])
    ) {
      throw new Error("TRACK_UNAVAILABLE");
    }
    let priorStart = -Infinity;
    const transcript = content.map((chunk, index) => {
      const text = String(chunk?.text || "")
        .replace(/>> ?/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const start = Number(chunk?.offset) / 1000;
      const duration = Number(chunk?.duration) / 1000;
      if (
        !text ||
        !Number.isFinite(start) ||
        !Number.isFinite(duration) ||
        start < 0 ||
        duration < 0 ||
        start < priorStart
      ) {
        throw new Error(`INVALID_RESPONSE:${index}`);
      }
      priorStart = start;
      return {
        text,
        start,
        duration,
        language: normalizeLanguage(chunk?.lang) || language,
      };
    });
    if (!transcript.length) throw new Error("EMPTY_TRANSCRIPT");
    return { language, transcript };
  }

  function summarize(normalized, videoId, elapsedMs, requestCount) {
    const first = normalized.transcript[0];
    const last = normalized.transcript.at(-1);
    return {
      providerId: "supadata-native",
      providerVariant: "mode-native",
      videoId,
      language: normalized.language,
      languageEvidence: normalized.language ? "verified" : "unknown",
      segmentCount: normalized.transcript.length,
      characterCount: normalized.transcript.reduce(
        (sum, segment) => sum + segment.text.length,
        0,
      ),
      firstStart: first.start,
      lastStart: last.start,
      elapsedMs,
      providerInitiated: {
        youtubePlayer: 0,
        youtubeTimedtext: 0,
        thirdParty: requestCount,
        loopback: 0,
      },
    };
  }

  return { normalizeLanguage, videoIdFromUrl, normalizePayload, summarize };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = SUPADATA_PROBE_CORE;
}
