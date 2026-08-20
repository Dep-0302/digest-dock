/**
 * Credential-free YouTube caption adapter.
 *
 * The caller may pass caption tracks read from the active page. Those tracks
 * are tried first. If none yields a non-empty transcript, the adapter probes a
 * small, fixed set of YouTube player clients. Supadata fallback belongs to the
 * caller and is deliberately not part of this module.
 *
 * Signed caption URLs are scoped to the request that consumes them. They are
 * never copied into returned results, attempts, errors, or module state.
 */
var YOUTUBE_TRANSCRIPT_ADAPTER = (() => {
  const PLAYER_ENDPOINT =
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
  const DEFAULT_TIMEOUT_MS = 15_000;
  const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const TRUSTED_CAPTION_HOST = "www.youtube.com";
  const TRUSTED_CAPTION_PATH = "/api/timedtext";
  const CLIENT_PROFILES = Object.freeze([
    Object.freeze({
      id: "IOS",
      clientName: "IOS",
      clientVersion: "20.10.4",
      clientHeader: "5",
      context: Object.freeze({
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        platform: "MOBILE",
        osName: "iOS",
        osVersion: "18.3.2.22D82",
      }),
    }),
    Object.freeze({
      id: "ANDROID_VR",
      clientName: "ANDROID_VR",
      clientVersion: "1.62.20",
      clientHeader: "28",
      context: Object.freeze({
        deviceMake: "Oculus",
        deviceModel: "Quest 3",
        platform: "MOBILE",
        osName: "Android",
        osVersion: "12L",
        androidSdkVersion: 32,
      }),
    }),
    Object.freeze({
      id: "MWEB",
      clientName: "MWEB",
      clientVersion: "2.20251209.01.00",
      clientHeader: "2",
      context: Object.freeze({
        platform: "MOBILE",
        osName: "iOS",
        osVersion: "17.5.1",
      }),
    }),
    Object.freeze({
      id: "ANDROID",
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      clientHeader: "3",
      context: Object.freeze({
        platform: "MOBILE",
        osName: "Android",
        osVersion: "14",
        androidSdkVersion: 34,
      }),
    }),
  ]);
  const PUBLIC_ERROR_CODES = new Set([
    "PROBE_FAILED",
    "LOGIN_REQUIRED",
    "VIDEO_UNAVAILABLE",
    "NO_TRANSCRIPT",
    "TRACK_UNAVAILABLE",
    "EMPTY_TRANSCRIPT",
  ]);

  class YouTubeTranscriptError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "YouTubeTranscriptError";
      this.code = code;
      if (Array.isArray(details.attempts)) this.attempts = details.attempts;
    }
  }

  function fail(code, message, details) {
    throw new YouTubeTranscriptError(code, message, details);
  }

  function validateVideoId(value) {
    const videoId = String(value || "").trim();
    if (!/^[0-9A-Za-z_-]{11}$/.test(videoId)) {
      fail("PROBE_FAILED", "YouTube video ID is invalid.", { attempts: [] });
    }
    return videoId;
  }

  function normalizeLanguage(value) {
    return String(value || "").trim().replace(/_/g, "-").toLowerCase();
  }

  function primaryLanguage(value) {
    return normalizeLanguage(value).split("-")[0] || "";
  }

  function safeLanguageTag(value) {
    const language = String(value || "").trim().replace(/_/g, "-");
    return language.length <= 35 &&
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)
      ? language
      : null;
  }

  function trackKind(track) {
    return track?.kind === "asr" || /^a\./i.test(String(track?.vssId || ""))
      ? "asr"
      : "manual";
  }

  function readTrackLabel(track) {
    const value =
      track?.name?.simpleText ||
      track?.name?.runs?.map((run) => run?.text || "").join("") ||
      track?.languageCode ||
      "";
    return (
      String(value)
        .replace(/https?:\/\/\S+/gi, "<redacted>")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160) || null
    );
  }

  function sanitizeTrack(track, index = 0) {
    const kind = trackKind(track);
    return {
      index,
      language: safeLanguageTag(track?.languageCode),
      kind,
      isGenerated: kind === "asr",
      isDefault: track?.isDefault === true,
      label: readTrackLabel(track),
    };
  }

  function normalizeKind(value) {
    return ["manual-first", "manual", "asr", "any"].includes(value)
      ? value
      : "manual-first";
  }

  /**
   * Choose caption tracks without silently crossing the requested language.
   * An exact BCP-47 tag is preferred; a regional variant of the same primary
   * language is allowed. With no preference, source order is preserved within
   * each requested kind group.
   */
  function chooseTracks(tracks, preferredLanguage = "", kind = "manual-first") {
    const requestedLanguage = normalizeLanguage(preferredLanguage);
    const requestedPrimary = primaryLanguage(requestedLanguage);
    const requestedKind = normalizeKind(kind);
    const candidates = (Array.isArray(tracks) ? tracks : [])
      .map((track, index) => ({ track, index }))
      .filter(
        ({ track }) =>
          typeof track?.baseUrl === "string" && track.baseUrl.trim(),
      )
      .filter(({ track }) => {
        if (!requestedLanguage) return true;
        const language = normalizeLanguage(track?.languageCode);
        return Boolean(
          language && primaryLanguage(language) === requestedPrimary,
        );
      });

    const kindRank = ({ track }) => (trackKind(track) === "manual" ? 0 : 1);
    const defaultRank = ({ track }) => (track?.isDefault === true ? 0 : 1);
    const languageRank = ({ track }) => {
      if (!requestedLanguage) return 0;
      return normalizeLanguage(track?.languageCode) === requestedLanguage
        ? 0
        : 1;
    };
    const filterKind = (target) =>
      candidates.filter(({ track }) => trackKind(track) === target);

    let ordered;
    if (requestedKind === "manual") ordered = filterKind("manual");
    else if (requestedKind === "asr") ordered = filterKind("asr");
    else if (requestedKind === "any") {
      ordered = [...candidates].sort(
        (left, right) =>
          languageRank(left) - languageRank(right) ||
          defaultRank(left) - defaultRank(right) ||
          left.index - right.index,
      );
    } else {
      ordered = [...candidates].sort(
        (left, right) =>
          kindRank(left) - kindRank(right) ||
          languageRank(left) - languageRank(right) ||
          defaultRank(left) - defaultRank(right) ||
          left.index - right.index,
      );
    }
    return ordered.map(({ track }) => track);
  }

  function chooseTrack(tracks, preferredLanguage = "", kind = "manual-first") {
    return chooseTracks(tracks, preferredLanguage, kind)[0] || null;
  }

  function normalizeCaptionUrl(input, format = "json3") {
    let url;
    try {
      url = new URL(String(input || ""));
    } catch {
      fail("UNTRUSTED_CAPTION_URL", "YouTube returned an invalid caption URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== TRUSTED_CAPTION_HOST ||
      url.pathname !== TRUSTED_CAPTION_PATH ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      fail("UNTRUSTED_CAPTION_URL", "YouTube returned an untrusted caption URL.");
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
      .replace(/&#x([0-9a-f]+);/gi, (_, value) =>
        String.fromCodePoint(Number.parseInt(value, 16)),
      )
      .replace(/&#(\d+);/g, (_, value) =>
        String.fromCodePoint(Number.parseInt(value, 10)),
      );
  }

  function cleanText(value) {
    return decodeEntities(value)
      .replace(/<[^>]+>/g, "")
      .replace(/>> ?/g, "")
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
      fail("INVALID_CAPTION_BODY", "JSON3 captions could not be parsed.");
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

  function parseXml(input, language = null) {
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

  function buildTranscriptResult(
    transcript,
    language,
    selectedTrack,
    sourceAttempt,
    attempts,
  ) {
    if (!Array.isArray(transcript) || !transcript.length) {
      fail("EMPTY_TRANSCRIPT", "YouTube returned no usable caption text.", {
        attempts,
      });
    }
    return {
      transcript,
      transcriptText: transcript.map((entry) => entry.text).join(" "),
      transcriptTextTimestamped: transcript
        .map((entry) => `[${formatTimestamp(entry.start)}] ${entry.text}`)
        .join("\n"),
      language,
      selectedTrack,
      sourceAttempt,
      attempts,
    };
  }

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

  async function readResponseText(response, maxResponseBytes) {
    const declared = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      fail("RESPONSE_TOO_LARGE", "YouTube response exceeded the size limit.");
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
            fail(
              "RESPONSE_TOO_LARGE",
              "YouTube response exceeded the size limit.",
            );
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return { text, bytes };
      } finally {
        reader.releaseLock?.();
      }
    }

    if (typeof response?.text !== "function") {
      fail("INVALID_RESPONSE", "YouTube response had no readable body.");
    }
    const text = await response.text();
    const bytes = utf8ByteLength(text);
    if (bytes > maxResponseBytes) {
      fail("RESPONSE_TOO_LARGE", "YouTube response exceeded the size limit.");
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
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    },
  ) {
    if (typeof fetchImpl !== "function") {
      fail("FETCH_UNAVAILABLE", "No fetch implementation is available.");
    }
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId =
      controller && timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    const startedAt = Date.now();
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
      const readable = await readResponseText(response, maxResponseBytes);
      return {
        ok: Boolean(response?.ok),
        status: Number(response?.status) || 0,
        text: readable.text,
        bytes: readable.bytes,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof YouTubeTranscriptError) throw error;
      if (error?.name === "AbortError" || controller?.signal?.aborted) {
        fail("TIMEOUT", "YouTube request timed out.");
      }
      fail("NETWORK", "YouTube request failed.");
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function safeErrorCode(error) {
    const code = String(error?.code || "REQUEST_FAILED");
    return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "REQUEST_FAILED";
  }

  function createAttempt(sourceAttempt, preferredLanguage, kind) {
    const safeSource = String(sourceAttempt || "");
    return {
      sourceAttempt: /^[A-Z0-9_]{1,80}$/.test(safeSource)
        ? safeSource
        : "UNKNOWN",
      requestedLanguage: safeLanguageTag(preferredLanguage),
      requestedKind: kind,
      credentials: "omit",
      trackCount: 0,
      tracks: [],
      formats: [],
    };
  }

  const FORMATS = Object.freeze([
    Object.freeze({ id: "json3", parser: parseJson3 }),
    Object.freeze({ id: "srv3", parser: parseXml }),
    Object.freeze({ id: "classic", parser: parseXml, urlFormat: "" }),
  ]);

  async function tryTracks({
    tracks,
    attempt,
    preferredLanguage,
    kind,
    options,
    stats,
  }) {
    const rawTracks = Array.isArray(tracks) ? tracks : [];
    attempt.trackCount = rawTracks.length;
    attempt.tracks = rawTracks.map(sanitizeTrack);
    if (rawTracks.length) stats.sawTracks = true;

    const selectedTracks = chooseTracks(rawTracks, preferredLanguage, kind);
    if (!selectedTracks.length) {
      attempt.outcome = rawTracks.length
        ? "requested-track-unavailable"
        : "no-caption";
      return null;
    }
    stats.sawMatchingTrack = true;

    for (const selected of selectedTracks) {
      const selectedTrack = sanitizeTrack(
        selected,
        rawTracks.indexOf(selected),
      );
      for (const format of FORMATS) {
        const formatAttempt = {
          format: format.id,
          trackKind: selectedTrack.kind,
          trackLanguage: selectedTrack.language,
        };
        attempt.formats.push(formatAttempt);
        try {
          // Keep the signed URL inside this block. Only bounded response
          // metadata is copied to the diagnostic attempt.
          const captionUrl = normalizeCaptionUrl(
            selected.baseUrl,
            format.urlFormat === undefined ? format.id : format.urlFormat,
          );
          const response = await fetchBoundedText(captionUrl, {
            ...options,
            method: "GET",
            headers: { Accept: "application/json, text/xml, */*" },
          });
          formatAttempt.status = response.status;
          formatAttempt.bytes = response.bytes;
          formatAttempt.elapsedMs = response.elapsedMs;
          if (!response.ok || !response.text.trim()) continue;

          let transcript;
          try {
            transcript = format.parser(
              response.text,
              selectedTrack.language,
            );
          } catch (error) {
            formatAttempt.error = safeErrorCode(error);
            continue;
          }
          formatAttempt.segmentCount = transcript.length;
          if (!transcript.length) continue;

          attempt.selectedTrack = selectedTrack;
          attempt.outcome = "transcript";
          return buildTranscriptResult(
            transcript,
            selectedTrack.language,
            selectedTrack,
            attempt.sourceAttempt,
            stats.attempts,
          );
        } catch (error) {
          formatAttempt.error = safeErrorCode(error);
        }
      }
    }
    attempt.outcome = "empty-caption-body";
    return null;
  }

  function requestOptions(baseOptions, callOptions) {
    return {
      fetchImpl:
        callOptions.fetchImpl || baseOptions.fetchImpl || globalThis.fetch,
      timeoutMs: Number.isFinite(callOptions.timeoutMs)
        ? Math.max(0, callOptions.timeoutMs)
        : baseOptions.timeoutMs,
      maxResponseBytes:
        Number.isFinite(callOptions.maxResponseBytes) &&
        callOptions.maxResponseBytes > 0
          ? callOptions.maxResponseBytes
          : baseOptions.maxResponseBytes,
    };
  }

  function normalizeInput(input, callOptions) {
    const objectInput = input && typeof input === "object" ? input : {};
    return {
      videoId: validateVideoId(objectInput.videoId || input),
      hasPageTracks: Object.hasOwn(objectInput, "captionTracks"),
      captionTracks: Array.isArray(objectInput.captionTracks)
        ? objectInput.captionTracks
        : [],
      preferredLanguage:
        objectInput.preferredLanguage ??
        callOptions.preferredLanguage ??
        callOptions.language ??
        "",
      kind: normalizeKind(
        objectInput.kind ??
          objectInput.mode ??
          callOptions.kind ??
          callOptions.mode,
      ),
    };
  }

  function publicFailure(stats) {
    let code;
    if (stats.sawMatchingTrack) code = "EMPTY_TRANSCRIPT";
    else if (stats.sawTracks) code = "TRACK_UNAVAILABLE";
    else if (stats.pageEvidence || stats.sawPlayable) code = "NO_TRANSCRIPT";
    else if (stats.parsedPlayerCount === 0) code = "PROBE_FAILED";
    else if (stats.sawLoginRequired) code = "LOGIN_REQUIRED";
    else code = "VIDEO_UNAVAILABLE";

    const messages = {
      PROBE_FAILED:
        "No player probe returned a parseable response; this is not proof that captions are absent.",
      LOGIN_REQUIRED:
        "YouTube required login or verification; browser credentials were not read.",
      VIDEO_UNAVAILABLE: "YouTube did not return a playable video.",
      NO_TRANSCRIPT: "YouTube returned no caption tracks for this video.",
      TRACK_UNAVAILABLE:
        "YouTube returned captions, but not the requested language or track kind.",
      EMPTY_TRANSCRIPT:
        "Matching caption tracks were found, but every caption body was empty or invalid.",
    };
    fail(code, messages[code], { attempts: stats.attempts });
  }

  function createAdapter(defaultOptions = {}) {
    const baseOptions = {
      fetchImpl: defaultOptions.fetchImpl,
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

    async function fetchTranscript(input, callOptions = {}) {
      const normalized = normalizeInput(input, callOptions);
      const options = requestOptions(baseOptions, callOptions);
      if (typeof options.fetchImpl !== "function") {
        fail("PROBE_FAILED", "No fetch implementation is available.", {
          attempts: [],
        });
      }
      const clients = Array.isArray(callOptions.clients)
        ? callOptions.clients
        : baseOptions.clients;
      const stats = {
        attempts: [],
        pageEvidence: false,
        parsedPlayerCount: 0,
        sawTracks: false,
        sawMatchingTrack: false,
        sawPlayable: false,
        sawLoginRequired: false,
      };

      if (normalized.hasPageTracks) {
        stats.pageEvidence = true;
        const attempt = createAttempt(
          "PAGE",
          normalized.preferredLanguage,
          normalized.kind,
        );
        stats.attempts.push(attempt);
        const result = await tryTracks({
          tracks: normalized.captionTracks,
          attempt,
          preferredLanguage: normalized.preferredLanguage,
          kind: normalized.kind,
          options,
          stats,
        });
        if (result) return result;
      }

      for (const profile of clients) {
        const attempt = createAttempt(
          String(profile?.id || "UNKNOWN").slice(0, 80),
          normalized.preferredLanguage,
          normalized.kind,
        );
        stats.attempts.push(attempt);
        let playerResponse;
        try {
          playerResponse = await fetchBoundedText(PLAYER_ENDPOINT, {
            ...options,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/plain, */*",
              "X-YouTube-Client-Name": String(profile?.clientHeader || ""),
              "X-YouTube-Client-Version": String(
                profile?.clientVersion || "",
              ),
            },
            body: JSON.stringify({
              context: {
                client: {
                  clientName: profile?.clientName,
                  clientVersion: profile?.clientVersion,
                  hl: "en",
                  gl: "US",
                  ...(profile?.context || {}),
                },
                user: { lockedSafetyMode: false },
                request: { useSsl: true },
              },
              videoId: normalized.videoId,
              contentCheckOk: true,
              racyCheckOk: true,
            }),
          });
          attempt.player = {
            status: playerResponse.status,
            bytes: playerResponse.bytes,
            elapsedMs: playerResponse.elapsedMs,
          };
        } catch (error) {
          attempt.error = safeErrorCode(error);
          attempt.outcome = "player-request-failed";
          continue;
        }
        if (!playerResponse.ok) {
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
        stats.parsedPlayerCount += 1;
        const rawPlayability = String(
          playerData?.playabilityStatus?.status || "",
        );
        attempt.playability = [
          "OK",
          "LOGIN_REQUIRED",
          "UNPLAYABLE",
          "ERROR",
          "AGE_CHECK_REQUIRED",
          "CONTENT_CHECK_REQUIRED",
          "LIVE_STREAM_OFFLINE",
        ].includes(rawPlayability)
          ? rawPlayability
          : rawPlayability
            ? "OTHER"
            : null;
        if (attempt.playability === "OK") stats.sawPlayable = true;
        if (attempt.playability === "LOGIN_REQUIRED") {
          stats.sawLoginRequired = true;
        }
        const tracks = Array.isArray(
          playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
        )
          ? playerData.captions.playerCaptionsTracklistRenderer.captionTracks
          : [];
        if (attempt.playability && attempt.playability !== "OK" && !tracks.length) {
          attempt.trackCount = 0;
          attempt.outcome = `player-${attempt.playability.toLowerCase()}`;
          continue;
        }

        const result = await tryTracks({
          tracks,
          attempt,
          preferredLanguage: normalized.preferredLanguage,
          kind: normalized.kind,
          options,
          stats,
        });
        if (result) return result;
      }

      return publicFailure(stats);
    }

    return { fetchTranscript };
  }

  const defaultAdapter = createAdapter();
  return {
    YouTubeTranscriptError,
    PLAYER_ENDPOINT,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESPONSE_BYTES,
    CLIENT_PROFILES,
    PUBLIC_ERROR_CODES,
    normalizeLanguage,
    primaryLanguage,
    trackKind,
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
    createAdapter,
    create: createAdapter,
    fetchTranscript: defaultAdapter.fetchTranscript,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YOUTUBE_TRANSCRIPT_ADAPTER;
}
