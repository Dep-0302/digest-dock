var PASSIVE_TRANSCRIPT_CORE = (() => {
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const TRUSTED_HOST = "www.youtube.com";
  const TRUSTED_PATH = "/api/timedtext";

  class PassiveCaptureError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "PassiveCaptureError";
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new PassiveCaptureError(code, message);
  }

  function validateVideoId(value) {
    const videoId = String(value || "").trim();
    if (!/^[0-9A-Za-z_-]{11}$/.test(videoId)) {
      fail("INVALID_RESPONSE", "Passive capture did not include a valid video ID.");
    }
    return videoId;
  }

  function normalizeLanguage(value) {
    const language = String(value || "").trim().replace(/_/g, "-");
    return language && language.length <= 35 &&
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)
      ? language
      : null;
  }

  function utf8ByteLength(value) {
    const text = String(value || "");
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text).byteLength;
    }
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
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

  function decodeEntities(value) {
    return String(value || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, number) =>
        String.fromCodePoint(Number.parseInt(number, 16)),
      )
      .replace(/&#(\d+);/g, (_, number) =>
        String.fromCodePoint(Number.parseInt(number, 10)),
      );
  }

  function cleanText(value) {
    return decodeEntities(value)
      .replace(/<[^>]+>/g, "")
      .replace(/>> ?/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeSegments(rows, language) {
    const segments = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const text = cleanText(row?.text);
        const start = Number(row?.start);
        const duration = Number(row?.duration);
        if (
          !text ||
          !Number.isFinite(start) ||
          !Number.isFinite(duration) ||
          start < 0 ||
          duration < 0
        ) {
          return null;
        }
        return { text, start, duration, language };
      })
      .filter(Boolean)
      .sort((left, right) => left.start - right.start);
    if (!segments.length) {
      fail("EMPTY_TRANSCRIPT", "Observed timedtext response had no usable segments.");
    }
    return segments;
  }

  function parseJson3(input, language) {
    let payload;
    try {
      payload = JSON.parse(String(input || ""));
    } catch {
      fail("INVALID_RESPONSE", "Observed JSON3 timedtext could not be parsed.");
    }
    const rows = [];
    for (const event of Array.isArray(payload?.events) ? payload.events : []) {
      if (!Array.isArray(event?.segs) || event.aAppend === 1) continue;
      rows.push({
        text: event.segs.map((segment) => segment?.utf8 || "").join(""),
        start: Number(event.tStartMs || 0) / 1000,
        duration: Number(event.dDurationMs || 0) / 1000,
      });
    }
    return normalizeSegments(rows, language);
  }

  function readXmlAttribute(source, name) {
    const match = String(source || "").match(
      new RegExp(`\\b${name}=["']([^"']+)["']`, "i"),
    );
    return match ? match[1] : null;
  }

  function parseXml(input, language) {
    const xml = String(input || "");
    const rows = [];
    const paragraphPattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = paragraphPattern.exec(xml))) {
      const start = readXmlAttribute(match[1], "t");
      const duration = readXmlAttribute(match[1], "d");
      if (start === null || duration === null) continue;
      const pieces = [...match[2].matchAll(/<s\b[^>]*>([\s\S]*?)<\/s>/gi)];
      rows.push({
        text: pieces.length
          ? pieces.map((piece) => piece[1]).join("")
          : match[2],
        start: Number(start) / 1000,
        duration: Number(duration) / 1000,
      });
    }
    if (!rows.length) {
      const classicPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
      while ((match = classicPattern.exec(xml))) {
        const start = readXmlAttribute(match[1], "start");
        const duration = readXmlAttribute(match[1], "dur");
        if (start === null || duration === null) continue;
        rows.push({
          text: match[2],
          start: Number(start),
          duration: Number(duration),
        });
      }
    }
    return normalizeSegments(rows, language);
  }

  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }

  function summarizeTimedtextUrl(input) {
    let url;
    try {
      url = new URL(String(input || ""), "https://www.youtube.com/");
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== TRUSTED_HOST ||
      url.pathname !== TRUSTED_PATH ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const videoId = url.searchParams.get("v");
    if (!/^[0-9A-Za-z_-]{11}$/.test(videoId || "")) return null;
    return {
      videoId,
      language:
        normalizeLanguage(url.searchParams.get("tlang")) ||
        normalizeLanguage(url.searchParams.get("lang")),
      sourceLanguage: normalizeLanguage(url.searchParams.get("lang")),
      translatedLanguage: normalizeLanguage(url.searchParams.get("tlang")),
      kind: url.searchParams.get("kind") === "asr" ? "asr" : "manual",
      format: String(url.searchParams.get("fmt") || "classic").slice(0, 20),
    };
  }

  function normalizeCapture(payload, expectedVideoId = null) {
    if (!payload || typeof payload !== "object") {
      fail("INVALID_RESPONSE", "Passive capture payload was missing.");
    }
    const videoId = validateVideoId(payload.videoId);
    if (expectedVideoId && videoId !== validateVideoId(expectedVideoId)) {
      fail("PAGE_CONTEXT_CHANGED", "Observed subtitles belong to another video.");
    }
    const status = Number(payload.status);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      if (status === 429) fail("RATE_LIMITED", "Observed timedtext was rate limited.");
      fail("INVALID_RESPONSE", "Observed timedtext did not return a success status.");
    }
    const transport = String(payload.transport || "");
    if (transport !== "xhr" && transport !== "fetch") {
      fail("INVALID_RESPONSE", "Passive capture transport was not recognized.");
    }
    const body = typeof payload.body === "string" ? payload.body : "";
    const bodyBytes = utf8ByteLength(body);
    if (!bodyBytes) {
      fail("EMPTY_TRANSCRIPT", "Observed timedtext response body was empty.");
    }
    if (bodyBytes > MAX_RESPONSE_BYTES) {
      fail("INVALID_RESPONSE", "Observed timedtext response exceeded the size limit.");
    }
    const language = normalizeLanguage(payload.language);
    const trimmed = body.trimStart();
    const requestedFormat = String(payload.format || "").toLowerCase();
    const parser =
      requestedFormat === "json3" || trimmed.startsWith("{")
        ? parseJson3
        : parseXml;
    const transcript = parser(body, language);
    return {
      success: true,
      providerId: "youtube-passive",
      videoId,
      language,
      transcript,
      transcriptText: transcript.map((segment) => segment.text).join(" "),
      transcriptTextTimestamped: transcript
        .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`)
        .join("\n"),
      diagnostics: {
        requestsInitiated: 0,
        observedResponses: 1,
        transport,
        status,
        format: requestedFormat || (trimmed.startsWith("{") ? "json3" : "xml"),
        bodyBytes,
        trackKind: payload.kind === "asr" ? "asr" : "manual",
      },
    };
  }

  return {
    MAX_RESPONSE_BYTES,
    PassiveCaptureError,
    normalizeLanguage,
    utf8ByteLength,
    summarizeTimedtextUrl,
    parseJson3,
    parseXml,
    normalizeCapture,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = PASSIVE_TRANSCRIPT_CORE;
}
