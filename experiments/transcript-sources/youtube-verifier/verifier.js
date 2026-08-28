/**
 * Credential-free YouTube subtitle verifier.
 *
 * Combines request-profile, strict-language, parsing, and safety lessons from
 * several open-source transcript implementations. It is intentionally small,
 * does not depend on those packages at runtime, and never returns a caption URL.
 */
var YOUTUBE_SUBTITLE_VERIFIER = (() => {
  const PLAYER_ENDPOINT =
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
  const DEFAULT_TIMEOUT_MS = 15_000;
  const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const TRUSTED_CAPTION_HOSTS = Object.freeze(["www.youtube.com"]);
  const CLIENT_PROFILES = Object.freeze([
    {
      id: "IOS",
      clientName: "IOS",
      clientVersion: "20.10.4",
      clientHeader: "5",
      context: {
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        platform: "MOBILE",
        osName: "iOS",
        osVersion: "18.3.2.22D82",
      },
    },
    {
      id: "ANDROID_VR",
      clientName: "ANDROID_VR",
      clientVersion: "1.62.20",
      clientHeader: "28",
      context: {
        deviceMake: "Oculus",
        deviceModel: "Quest 3",
        platform: "MOBILE",
        osName: "Android",
        osVersion: "12L",
        androidSdkVersion: 32,
      },
    },
    {
      id: "MWEB",
      clientName: "MWEB",
      clientVersion: "2.20251209.01.00",
      clientHeader: "2",
      context: {
        platform: "MOBILE",
        osName: "iOS",
        osVersion: "17.5.1",
      },
    },
    {
      id: "ANDROID",
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      clientHeader: "3",
      context: {
        platform: "MOBILE",
        osName: "Android",
        osVersion: "14",
        androidSdkVersion: 34,
      },
    },
  ]);

  class VerifierError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "VerifierError";
      this.code = code;
      if (Number.isInteger(details.status)) this.status = details.status;
      if (Array.isArray(details.attempts)) this.attempts = details.attempts;
    }
  }

  function fail(code, message, details) {
    throw new VerifierError(code, message, details);
  }

  function parseVideoUrl(input) {
    let url;
    try {
      url = new URL(String(input || ""));
    } catch {
      fail("INVALID_URL", "当前标签页地址无效。");
    }
    const videoId = url.searchParams.get("v") || "";
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.youtube.com" ||
      url.pathname !== "/watch" ||
      !/^[0-9A-Za-z_-]{11}$/.test(videoId)
    ) {
      fail(
        "UNSUPPORTED_URL",
        "请打开标准的 https://www.youtube.com/watch?v=... 视频页。",
      );
    }
    return {
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  function normalizedKind(track) {
    return track?.kind === "asr" ? "asr" : "manual";
  }

  function normalizedLanguage(value) {
    return String(value || "").trim().toLowerCase();
  }

  function readTrackLabel(track) {
    return String(
      track?.name?.simpleText ||
        track?.name?.runs?.map((run) => run?.text || "").join("") ||
        track?.languageCode ||
        "",
    ).trim();
  }

  function sanitizeTrack(track, index = 0) {
    return {
      index,
      language: String(track?.languageCode || "") || null,
      kind: normalizedKind(track),
      isGenerated: normalizedKind(track) === "asr",
      label: readTrackLabel(track) || null,
      vssId: String(track?.vssId || "") || null,
    };
  }

  function chooseTracks(tracks, language, mode = "manual-first") {
    const target = normalizedLanguage(language);
    const matching = (Array.isArray(tracks) ? tracks : []).filter(
      (track) =>
        typeof track?.baseUrl === "string" &&
        track.baseUrl.trim() &&
        normalizedLanguage(track.languageCode) === target,
    );
    if (!matching.length) return [];
    if (mode === "manual") {
      return matching.filter((track) => normalizedKind(track) === "manual");
    }
    if (mode === "asr") {
      return matching.filter((track) => normalizedKind(track) === "asr");
    }
    if (mode === "any") return matching;
    return [
      ...matching.filter((track) => normalizedKind(track) === "manual"),
      ...matching.filter((track) => normalizedKind(track) === "asr"),
    ];
  }

  function chooseTrack(tracks, language, mode = "manual-first") {
    return chooseTracks(tracks, language, mode)[0] || null;
  }

  function normalizeCaptionUrl(input, format = "json3") {
    let url;
    try {
      url = new URL(String(input || ""));
    } catch {
      fail("UNTRUSTED_CAPTION_URL", "YouTube 返回的字幕地址无效。");
    }
    if (
      url.protocol !== "https:" ||
      !TRUSTED_CAPTION_HOSTS.includes(url.hostname) ||
      url.pathname !== "/api/timedtext" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      fail("UNTRUSTED_CAPTION_URL", "YouTube 返回的字幕地址不受信任。");
    }
    if (format) url.searchParams.set("fmt", format);
    else url.searchParams.delete("fmt");
    return url.href;
  }

  function decodeEntities(value) {
    return String(value || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_, decimal) =>
        String.fromCodePoint(Number.parseInt(decimal, 10)),
      );
  }

  function cleanText(value) {
    return decodeEntities(value)
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeSegments(rows, language = null) {
    return (Array.isArray(rows) ? rows : [])
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
  }

  function parseJson3(input, language = null) {
    let payload;
    try {
      payload = typeof input === "string" ? JSON.parse(input) : input;
    } catch {
      fail("INVALID_CAPTION_BODY", "JSON3 字幕无法解析。");
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

  function parseXml(input, language = null) {
    const xml = String(input || "");
    const rows = [];
    const paragraphPattern = /<p\b[^>]*\bt="(\d+)"[^>]*\bd="(\d+)"[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = paragraphPattern.exec(xml))) {
      const inner = match[3];
      const pieces = [...inner.matchAll(/<s\b[^>]*>([\s\S]*?)<\/s>/gi)];
      rows.push({
        text: pieces.length ? pieces.map((piece) => piece[1]).join("") : inner,
        start: Number(match[1]) / 1000,
        duration: Number(match[2]) / 1000,
      });
    }
    if (!rows.length) {
      const classicPattern = /<text\b[^>]*\bstart="([^"]+)"[^>]*\bdur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/gi;
      while ((match = classicPattern.exec(xml))) {
        rows.push({
          text: match[3],
          start: Number(match[1]),
          duration: Number(match[2]),
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

  function buildTranscriptResult(transcript, language, selectedTrack, client) {
    if (!Array.isArray(transcript) || !transcript.length) {
      fail("EMPTY_TRANSCRIPT", "字幕响应没有可用正文。");
    }
    return {
      transcript,
      transcriptText: transcript.map((entry) => entry.text).join(" "),
      transcriptTextTimestamped: transcript
        .map((entry) => `[${formatTimestamp(entry.start)}] ${entry.text}`)
        .join("\n"),
      language,
      selectedTrack,
      sourceAttempt: client,
    };
  }

  function utf8ByteLength(text) {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(String(text || "")).byteLength;
    }
    return Buffer.byteLength(String(text || ""), "utf8");
  }

  function sanitizeMessage(value) {
    return String(value || "")
      .replace(/https?:\/\/[^\s"')]+/g, "<redacted-url>")
      .slice(0, 240);
  }

  async function readResponseText(response, maxResponseBytes) {
    const declared = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      fail("RESPONSE_TOO_LARGE", "YouTube 响应超过允许大小。");
    }

    if (response?.body?.getReader && typeof TextDecoder === "function") {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value?.byteLength || 0;
          if (bytes > maxResponseBytes) {
            await reader.cancel().catch(() => {});
            fail("RESPONSE_TOO_LARGE", "YouTube 响应超过允许大小。");
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return { text, bytes };
      } finally {
        reader.releaseLock?.();
      }
    }

    const text = await response.text();
    const bytes = utf8ByteLength(text);
    if (bytes > maxResponseBytes) {
      fail("RESPONSE_TOO_LARGE", "YouTube 响应超过允许大小。");
    }
    return { text, bytes };
  }

  async function fetchBoundedText(
    url,
    {
      fetchImpl,
      method = "GET",
      headers = {},
      body,
      timeoutMs,
      maxResponseBytes,
    },
  ) {
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId =
      controller && timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    const started = Date.now();
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        ...(controller ? { signal: controller.signal } : {}),
      });
      const status = Number(response?.status) || 0;
      if (status === 429) {
        fail(
          "RATE_LIMITED",
          "YouTube 暂时限制了字幕验证请求，已在读取响应体前停止。",
          { status: 429 },
        );
      }
      const { text, bytes } = await readResponseText(
        response,
        maxResponseBytes,
      );
      return {
        ok: Boolean(response?.ok),
        status,
        text,
        bytes,
        elapsedMs: Date.now() - started,
        contentType: response?.headers?.get?.("content-type") || null,
      };
    } catch (error) {
      if (error instanceof VerifierError) throw error;
      if (error?.name === "AbortError" || controller?.signal?.aborted) {
        fail("TIMEOUT", "YouTube 请求超时。");
      }
      fail("NETWORK", "YouTube 网络请求失败。");
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async function sha256(value) {
    if (!value) return null;
    if (globalThis.crypto?.subtle) {
      const bytes = new TextEncoder().encode(value);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }
    if (typeof require === "function") {
      return require("node:crypto").createHash("sha256").update(value).digest("hex");
    }
    return null;
  }

  function safeAttemptError(error) {
    return {
      code: error?.code || "ERROR",
      message: sanitizeMessage(error?.message || error),
    };
  }

  function create(defaultOptions = {}) {
    const baseOptions = {
      fetchImpl: defaultOptions.fetchImpl || globalThis.fetch,
      timeoutMs: Number.isFinite(defaultOptions.timeoutMs)
        ? Math.max(0, defaultOptions.timeoutMs)
        : DEFAULT_TIMEOUT_MS,
      maxResponseBytes:
        Number.isFinite(defaultOptions.maxResponseBytes) &&
        defaultOptions.maxResponseBytes > 0
          ? defaultOptions.maxResponseBytes
          : DEFAULT_MAX_RESPONSE_BYTES,
      clients: Array.isArray(defaultOptions.clients)
        ? defaultOptions.clients
        : CLIENT_PROFILES,
    };

    async function verifyVideo(url, callOptions = {}) {
      const media = parseVideoUrl(url);
      const language = String(callOptions.language || "en").trim();
      const mode = ["manual-first", "manual", "asr", "any"].includes(
        callOptions.mode,
      )
        ? callOptions.mode
        : "manual-first";
      const options = {
        fetchImpl: callOptions.fetchImpl || baseOptions.fetchImpl,
        timeoutMs: Number.isFinite(callOptions.timeoutMs)
          ? Math.max(0, callOptions.timeoutMs)
          : baseOptions.timeoutMs,
        maxResponseBytes:
          Number.isFinite(callOptions.maxResponseBytes) &&
          callOptions.maxResponseBytes > 0
            ? callOptions.maxResponseBytes
            : baseOptions.maxResponseBytes,
        clients: Array.isArray(callOptions.clients)
          ? callOptions.clients
          : baseOptions.clients,
      };
      if (typeof options.fetchImpl !== "function") {
        fail("FETCH_UNAVAILABLE", "当前环境没有可用的 fetch。");
      }

      const attempts = [];
      let parsedPlayerCount = 0;
      let sawTracks = false;
      let sawMatchingTrack = false;
      let sawPlayable = false;
      let sawLoginRequired = false;

      for (const profile of options.clients) {
        const attempt = {
          client: profile.id,
          requestedLanguage: language,
          requestedMode: mode,
          credentials: "omit",
          userAgentOrOriginSpoofed: false,
          trackCount: 0,
          formats: [],
        };
        attempts.push(attempt);
        try {
          const playerResponse = await fetchBoundedText(PLAYER_ENDPOINT, {
            ...options,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/plain, */*",
              "X-YouTube-Client-Name": profile.clientHeader,
              "X-YouTube-Client-Version": profile.clientVersion,
            },
            body: JSON.stringify({
              context: {
                client: {
                  clientName: profile.clientName,
                  clientVersion: profile.clientVersion,
                  hl: "en",
                  gl: "US",
                  ...profile.context,
                },
                user: { lockedSafetyMode: false },
                request: { useSsl: true },
              },
              videoId: media.videoId,
              contentCheckOk: true,
              racyCheckOk: true,
            }),
          });
          attempt.player = {
            status: playerResponse.status,
            bytes: playerResponse.bytes,
            elapsedMs: playerResponse.elapsedMs,
          };
          if (!playerResponse.ok) {
            if (playerResponse.status === 429) {
              attempt.outcome = "rate-limited";
              fail(
                "RATE_LIMITED",
                "YouTube 暂时限制了字幕验证请求，已立即停止后续尝试。",
                { status: 429, attempts },
              );
            }
            attempt.outcome = "player-http-error";
            continue;
          }

          let playerData;
          try {
            playerData = JSON.parse(playerResponse.text);
          } catch {
            attempt.outcome = "invalid-player-json";
            continue;
          }
          parsedPlayerCount += 1;
          attempt.playability = playerData?.playabilityStatus?.status || null;
          if (attempt.playability === "OK") sawPlayable = true;
          if (attempt.playability === "LOGIN_REQUIRED") sawLoginRequired = true;
          const tracks = Array.isArray(
            playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
          )
            ? playerData.captions.playerCaptionsTracklistRenderer.captionTracks
            : [];
          attempt.trackCount = tracks.length;
          attempt.tracks = tracks.map(sanitizeTrack);
          if (tracks.length) sawTracks = true;
          if (attempt.playability && attempt.playability !== "OK" && !tracks.length) {
            attempt.outcome = `player-${attempt.playability.toLowerCase()}`;
            continue;
          }
          const selectedTracks = chooseTracks(tracks, language, mode);
          if (!selectedTracks.length) {
            attempt.outcome = tracks.length
              ? "requested-track-unavailable"
              : "no-caption";
            continue;
          }
          sawMatchingTrack = true;
          for (const selected of selectedTracks) {
            const selectedTrack = sanitizeTrack(selected, tracks.indexOf(selected));
            const formats = [
              { id: "json3", parser: parseJson3 },
              { id: "srv3", parser: parseXml },
              { id: "classic", parser: parseXml, urlFormat: "" },
            ];
            for (const format of formats) {
              try {
                const captionUrl = normalizeCaptionUrl(
                  selected.baseUrl,
                  format.urlFormat === undefined ? format.id : format.urlFormat,
                );
                const captionResponse = await fetchBoundedText(captionUrl, {
                  ...options,
                  method: "GET",
                  headers: { Accept: "application/json, text/xml, */*" },
                });
                const formatAttempt = {
                  format: format.id,
                  trackKind: selectedTrack.kind,
                  status: captionResponse.status,
                  bytes: captionResponse.bytes,
                  elapsedMs: captionResponse.elapsedMs,
                };
                attempt.formats.push(formatAttempt);
                if (captionResponse.status === 429) {
                  attempt.outcome = "rate-limited";
                  fail(
                    "RATE_LIMITED",
                    "YouTube 暂时限制了字幕验证请求，已立即停止后续尝试。",
                    { status: 429, attempts },
                  );
                }
                if (!captionResponse.ok || !captionResponse.text.trim()) continue;
                let transcript;
                try {
                  transcript = format.parser(
                    captionResponse.text,
                    selectedTrack.language,
                  );
                } catch (error) {
                  formatAttempt.parseError = safeAttemptError(error).code;
                  continue;
                }
                formatAttempt.segmentCount = transcript.length;
                if (!transcript.length) continue;
                attempt.selectedTrack = selectedTrack;
                attempt.outcome = "transcript";
                const result = buildTranscriptResult(
                  transcript,
                  selectedTrack.language,
                  selectedTrack,
                  profile.id,
                );
                const canonical = transcript
                  .map((entry) => entry.text)
                  .join(" ")
                  .normalize("NFKC")
                  .replace(/\s+/g, " ")
                  .trim();
                return {
                  success: true,
                  videoId: media.videoId,
                  canonicalUrl: media.canonicalUrl,
                  ...result,
                  diagnostics: {
                    videoId: media.videoId,
                    sourceAttempt: profile.id,
                    selectedTrack,
                    segmentCount: transcript.length,
                    canonicalCharacterCount: canonical.length,
                    canonicalSha256: await sha256(canonical),
                    attempts,
                  },
                };
              } catch (error) {
                if (error?.code === "RATE_LIMITED") {
                  attempt.outcome = "rate-limited";
                  error.attempts = attempts;
                  throw error;
                }
                attempt.formats.push({
                  format: format.id,
                  trackKind: selectedTrack.kind,
                  error: safeAttemptError(error),
                });
              }
            }
          }
          attempt.outcome = "empty-caption-body";
        } catch (error) {
          if (error?.code === "RATE_LIMITED") {
            attempt.outcome = "rate-limited";
            attempt.error = safeAttemptError(error);
            error.attempts = attempts;
            throw error;
          }
          attempt.outcome = "client-error";
          attempt.error = safeAttemptError(error);
        }
      }

      const code = parsedPlayerCount === 0
        ? "PROBE_FAILED"
        : !sawTracks && !sawPlayable
        ? sawLoginRequired
          ? "LOGIN_REQUIRED"
          : "VIDEO_UNAVAILABLE"
        : !sawTracks
          ? "NO_TRANSCRIPT"
        : !sawMatchingTrack
          ? "TRACK_UNAVAILABLE"
          : "EMPTY_TRANSCRIPT";
      const message =
        code === "PROBE_FAILED"
          ? "所有 client 都未完成可解析的 player 请求，不能判定为无字幕。"
          : code === "LOGIN_REQUIRED"
          ? "所有 client 都要求登录或验证，未读取用户 Cookie。"
          : code === "VIDEO_UNAVAILABLE"
            ? "所有 client 都未返回可播放状态。"
            : code === "NO_TRANSCRIPT"
          ? "所有 client 都没有返回字幕轨。"
          : code === "TRACK_UNAVAILABLE"
            ? "所有 client 都没有返回请求的语言或轨道类型。"
            : "所有 client 都未取得非空可解析字幕正文。";
      fail(code, message, { attempts });
    }

    return { verifyVideo };
  }

  function diagnosticsFromError(error) {
    return {
      success: false,
      error: {
        code: error?.code || "ERROR",
        message: sanitizeMessage(error?.message || error),
      },
      attempts: Array.isArray(error?.attempts) ? error.attempts : [],
    };
  }

  const defaultVerifier = create();
  return {
    VerifierError,
    PLAYER_ENDPOINT,
    CLIENT_PROFILES,
    TRUSTED_CAPTION_HOSTS,
    parseVideoUrl,
    normalizedKind,
    sanitizeTrack,
    chooseTracks,
    chooseTrack,
    normalizeCaptionUrl,
    decodeEntities,
    normalizeSegments,
    parseJson3,
    parseXml,
    formatTimestamp,
    buildTranscriptResult,
    readResponseText,
    fetchBoundedText,
    create,
    verifyVideo: defaultVerifier.verifyVideo,
    diagnosticsFromError,
  };
})();

if (typeof chrome !== "undefined" && chrome?.runtime) {
  globalThis.YOUTUBE_SUBTITLE_VERIFIER = YOUTUBE_SUBTITLE_VERIFIER;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = YOUTUBE_SUBTITLE_VERIFIER;
}
