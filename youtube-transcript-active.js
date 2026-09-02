/**
 * DigestDock's credential-free YouTube Active transcript route.
 *
 * This file is intentionally self-contained so Chrome can inject it into the
 * current tab's ISOLATED world. The caller owns page identity checks and route
 * fallback. This module only performs one bounded YouTube-native attempt.
 */
(function installYouTubeActive(root, factory) {
  const existing = root?.DIGESTDOCK_YOUTUBE_ACTIVE;
  const api = existing?.apiVersion === 1 ? existing : factory();
  if (root) root.DIGESTDOCK_YOUTUBE_ACTIVE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const PROVIDER_ID = "youtube-active";
  const PROVIDER_VARIANT = "isolated-tab-ios-json3";
  const PLAYER_ENDPOINT =
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
  const TIMEOUT_MS = 15_000;
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const MAX_PLAYER_REQUESTS = 1;
  const MAX_TIMEDTEXT_REQUESTS = 1;
  const TRUSTED_CAPTION_HOST = "www.youtube.com";
  const TRUSTED_CAPTION_PATH = "/api/timedtext";
  let activeRunState = null;

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
  ]);

  const FORMATS = Object.freeze([
    Object.freeze({ id: "json3", parser: parseJson3 }),
  ]);
  const KNOWN_PLAYABILITY = new Set([
    "OK",
    "LOGIN_REQUIRED",
    "UNPLAYABLE",
    "ERROR",
    "AGE_CHECK_REQUIRED",
    "CONTENT_CHECK_REQUIRED",
    "LIVE_STREAM_OFFLINE",
  ]);
  const RESTRICTED_PLAYABILITY = new Set([
    "LOGIN_REQUIRED",
    "AGE_CHECK_REQUIRED",
    "CONTENT_CHECK_REQUIRED",
  ]);
  const UNAVAILABLE_CODES = new Set([
    "NO_TRANSCRIPT",
    "TRACK_UNAVAILABLE",
    "LOGIN_REQUIRED",
    "VIDEO_UNAVAILABLE",
  ]);

  class ActiveError extends Error {
    constructor(code, details = {}) {
      super(code);
      this.name = "ActiveError";
      this.code = code;
      if (Number.isInteger(details.status)) this.status = details.status;
    }
  }

  function fail(code, details) {
    throw new ActiveError(code, details);
  }

  function validateVideoId(value) {
    const videoId = String(value || "").trim();
    if (!/^[0-9A-Za-z_-]{11}$/.test(videoId)) fail("PROBE_FAILED");
    return videoId;
  }

  function pageVideoId() {
    if (!globalThis.location) return null;
    try {
      const url = new URL(String(globalThis.location.href || ""));
      if (
        url.protocol !== "https:" ||
        url.hostname !== "www.youtube.com" ||
        url.pathname !== "/watch"
      ) {
        return "";
      }
      return /^[0-9A-Za-z_-]{11}$/.test(url.searchParams.get("v") || "")
        ? url.searchParams.get("v")
        : "";
    } catch {
      return "";
    }
  }

  function cancelRun(state) {
    if (!state || state.cancelled) return;
    state.cancelled = true;
    for (const controller of state.controllers) controller.abort();
  }

  function assertCurrentPage(runtime) {
    if (runtime.runState.cancelled) fail("PAGE_CONTEXT_CHANGED");
    const current = runtime.getCurrentVideoId();
    // Unit hosts without a Location object return null. The injected browser
    // runtime always has Location and therefore fails closed on any mismatch.
    if (current !== null && current !== runtime.expectedVideoId) {
      cancelRun(runtime.runState);
      fail("PAGE_CONTEXT_CHANGED");
    }
  }

  function normalizeLanguage(value) {
    return String(value || "").trim().replace(/_/g, "-").toLowerCase();
  }

  function safeLanguageTag(value) {
    const language = String(value || "").trim().replace(/_/g, "-");
    return language.length <= 35 &&
        /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)
      ? language
      : null;
  }

  function primaryLanguage(value) {
    return normalizeLanguage(value).split("-")[0] || "";
  }

  function normalizeKind(value) {
    return ["manual-first", "manual", "asr", "any"].includes(value)
      ? value
      : "manual-first";
  }

  function normalizePlayability(value) {
    const status = String(value || "").trim().toUpperCase();
    if (!status) return null;
    return KNOWN_PLAYABILITY.has(status) ? status : "OTHER";
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

  function sanitizeTrack(track) {
    const kind = trackKind(track);
    return {
      language: safeLanguageTag(track?.languageCode),
      kind,
      isGenerated: kind === "asr",
      isDefault: track?.isDefault === true,
      label: readTrackLabel(track),
    };
  }

  function chooseTrack(tracks, requestedLanguage, requestedKind) {
    const language = normalizeLanguage(requestedLanguage);
    const primary = primaryLanguage(language);
    const kind = normalizeKind(requestedKind);
    const candidates = (Array.isArray(tracks) ? tracks : [])
      .map((track, index) => ({ track, index }))
      .filter(
        ({ track }) =>
          typeof track?.baseUrl === "string" && track.baseUrl.trim(),
      )
      .filter(({ track }) => {
        if (!language) return true;
        const candidate = normalizeLanguage(track?.languageCode);
        return Boolean(candidate && primaryLanguage(candidate) === primary);
      })
      .filter(({ track }) => {
        if (kind === "manual" || kind === "asr") {
          return trackKind(track) === kind;
        }
        return true;
      });

    candidates.sort((left, right) => {
      const leftKind = trackKind(left.track);
      const rightKind = trackKind(right.track);
      const leftKindRank = kind === "manual-first" && leftKind === "manual" ? 0 : 1;
      const rightKindRank = kind === "manual-first" && rightKind === "manual" ? 0 : 1;
      const leftLanguageRank =
        language && normalizeLanguage(left.track?.languageCode) !== language ? 1 : 0;
      const rightLanguageRank =
        language && normalizeLanguage(right.track?.languageCode) !== language ? 1 : 0;
      const leftDefaultRank = left.track?.isDefault === true ? 0 : 1;
      const rightDefaultRank = right.track?.isDefault === true ? 0 : 1;
      return (
        leftKindRank - rightKindRank ||
        leftLanguageRank - rightLanguageRank ||
        leftDefaultRank - rightDefaultRank ||
        left.index - right.index
      );
    });
    return candidates[0]?.track || null;
  }

  function normalizeCaptionUrl(input, format) {
    let url;
    try {
      url = new URL(String(input || ""));
    } catch {
      fail("UNTRUSTED_CAPTION_URL");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== TRUSTED_CAPTION_HOST ||
      url.pathname !== TRUSTED_CAPTION_PATH ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      fail("UNTRUSTED_CAPTION_URL");
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
      .replace(/>> ?/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeSegments(rows, language) {
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

  function parseJson3(input, language) {
    let payload;
    try {
      payload = JSON.parse(String(input || ""));
    } catch {
      fail("INVALID_CAPTION_BODY");
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
        text: pieces.length ? pieces.map((piece) => piece[1]).join("") : match[2],
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
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
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

  async function readResponseText(response) {
    const declared = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      fail("RESPONSE_TOO_LARGE");
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
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {});
            fail("RESPONSE_TOO_LARGE");
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return { text, bytes };
      } finally {
        reader.releaseLock?.();
      }
    }

    if (typeof response?.text !== "function") fail("INVALID_RESPONSE");
    const text = await response.text();
    const bytes = utf8ByteLength(text);
    if (bytes > MAX_RESPONSE_BYTES) fail("RESPONSE_TOO_LARGE");
    return { text, bytes };
  }

  function createDiagnostics() {
    return {
      providerInitiated: {
        youtubePlayer: 0,
        youtubeTimedtext: 0,
        thirdParty: 0,
        loopback: 0,
      },
      attempts: [],
      sawCaptionTracks: false,
      sawRequestedTrack: false,
    };
  }

  function requestCountKey(requestClass) {
    return requestClass === "player" ? "youtubePlayer" : "youtubeTimedtext";
  }

  function requestLimit(requestClass) {
    return requestClass === "player"
      ? MAX_PLAYER_REQUESTS
      : MAX_TIMEDTEXT_REQUESTS;
  }

  async function fetchBoundedText(
    url,
    init,
    requestClass,
    runtime,
    diagnostics,
  ) {
    let controller = null;
    let timeoutId = null;
    let startedAt = 0;
    try {
      assertCurrentPage(runtime);
      const countKey = requestCountKey(requestClass);
      if (diagnostics.providerInitiated[countKey] >= requestLimit(requestClass)) {
        fail("REQUEST_LIMIT_REACHED");
      }
      diagnostics.providerInitiated[countKey] += 1;

      try {
        controller = new runtime.AbortController();
      } catch {
        fail("ABORT_CONTROLLER_FAILED");
      }
      runtime.runState.controllers.add(controller);
      try {
        timeoutId = runtime.setTimeout(() => controller.abort(), TIMEOUT_MS);
      } catch {
        fail("TIMER_SETUP_FAILED");
      }
      startedAt = runtime.now();
      const response = await runtime.fetchImpl(url, {
        ...init,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      const status = Number(response?.status) || 0;
      // This guard must remain before headers, stream, text(), or any body read.
      if (status === 429) fail("RATE_LIMITED", { status: 429 });
      assertCurrentPage(runtime);
      const readable = await readResponseText(response);
      assertCurrentPage(runtime);
      return {
        ok: Boolean(response?.ok),
        status,
        text: readable.text,
        bytes: readable.bytes,
        elapsedMs: Math.max(0, runtime.now() - startedAt),
      };
    } catch (error) {
      if (error instanceof ActiveError) throw error;
      if (runtime.runState.cancelled) fail("PAGE_CONTEXT_CHANGED");
      if (error?.name === "AbortError" || controller.signal.aborted) {
        fail("TIMEOUT");
      }
      fail("NETWORK");
    } finally {
      if (timeoutId !== null) runtime.clearTimeout(timeoutId);
      if (controller) runtime.runState.controllers.delete(controller);
    }
  }

  function runtimeFrom(deps) {
    const runtime = {
      fetchImpl:
        deps?.fetchImpl ||
        (typeof globalThis.fetch === "function"
          ? globalThis.fetch.bind(globalThis)
          : null),
      AbortController: deps?.AbortController || globalThis.AbortController,
      setTimeout:
        typeof deps?.setTimeout === "function"
          ? (...args) => deps.setTimeout(...args)
          : (...args) => globalThis.setTimeout(...args),
      clearTimeout:
        typeof deps?.clearTimeout === "function"
          ? (...args) => deps.clearTimeout(...args)
          : (...args) => globalThis.clearTimeout(...args),
      now:
        typeof deps?.now === "function"
          ? () => deps.now()
          : () => Date.now(),
      getCurrentVideoId:
        typeof deps?.getCurrentVideoId === "function"
          ? deps.getCurrentVideoId
          : pageVideoId,
      clients: Array.isArray(deps?.clients)
        ? deps.clients.slice(0, MAX_PLAYER_REQUESTS)
        : CLIENT_PROFILES,
    };
    if (
      typeof runtime.fetchImpl !== "function" ||
      typeof runtime.AbortController !== "function" ||
      typeof runtime.setTimeout !== "function" ||
      typeof runtime.clearTimeout !== "function"
    ) {
      fail("PROBE_FAILED");
    }
    return runtime;
  }

  function safeAttemptError(error) {
    const code = String(error?.code || "REQUEST_FAILED");
    return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "REQUEST_FAILED";
  }

  function makeBaseResult(request, videoId, language, selectedTrack) {
    return {
      providerId: PROVIDER_ID,
      providerVariant: PROVIDER_VARIANT,
      runId: request?.runId ?? null,
      videoId,
      transcript: [],
      text: "",
      timestamped: "",
      language: selectedTrack?.language || language || null,
      selectedTrack: selectedTrack || null,
      errorCode: null,
    };
  }

  function successResult(
    request,
    videoId,
    language,
    selectedTrack,
    transcript,
    diagnostics,
  ) {
    return {
      ...makeBaseResult(request, videoId, language, selectedTrack),
      status: "HAVE_TRANSCRIPT",
      transcript,
      text: transcript.map((segment) => segment.text).join(" "),
      timestamped: transcript
        .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`)
        .join("\n"),
      diagnostics,
    };
  }

  function failureResult(
    request,
    videoId,
    language,
    selectedTrack,
    error,
    diagnostics,
  ) {
    const errorCode = safeAttemptError(error);
    const status =
      errorCode === "RATE_LIMITED"
        ? "RATE_LIMITED"
        : errorCode === "PAGE_CONTEXT_CHANGED"
          ? "PAGE_CONTEXT_CHANGED"
        : UNAVAILABLE_CODES.has(errorCode)
          ? "CONFIRMED_UNAVAILABLE"
          : "UNKNOWN";
    return {
      ...makeBaseResult(request, videoId, language, selectedTrack),
      status,
      errorCode,
      diagnostics,
    };
  }

  function finalFailure(stats) {
    if (stats.parsedPlayerCount === 0) return "PROBE_FAILED";
    if (stats.sawCaptionTracks) return "TRACK_UNAVAILABLE";
    if (stats.sawPlayable) return "NO_TRANSCRIPT";
    if (stats.sawRestricted) return "LOGIN_REQUIRED";
    return "VIDEO_UNAVAILABLE";
  }

  async function run(request = {}, deps = {}) {
    const diagnostics = createDiagnostics();
    let videoId = String(request?.videoId || "").trim();
    const requestedLanguage = normalizeLanguage(request?.language);
    const requestedKind = normalizeKind(request?.trackKind);
    let selectedTrack = null;
    let runtime = null;
    let runState = null;
    let navigationTarget = null;
    let cancelForNavigation = null;

    try {
      videoId = validateVideoId(videoId);
      runtime = runtimeFrom(deps);
      runState = { cancelled: false, controllers: new Set() };
      cancelRun(activeRunState);
      activeRunState = runState;
      runtime.runState = runState;
      runtime.expectedVideoId = videoId;
      assertCurrentPage(runtime);
      navigationTarget =
        deps?.navigationTarget || globalThis.window || globalThis;
      cancelForNavigation = () => cancelRun(runState);
      navigationTarget?.addEventListener?.(
        "yt-navigate-start",
        cancelForNavigation,
      );
      navigationTarget?.addEventListener?.("pagehide", cancelForNavigation);
      const stats = {
        parsedPlayerCount: 0,
        sawCaptionTracks: false,
        sawPlayable: false,
        sawRestricted: false,
      };

      for (const profile of runtime.clients) {
        const attempt = {
          client: String(profile?.id || "UNKNOWN").slice(0, 80),
          credentials: "omit",
          requestedLanguage: requestedLanguage || null,
          requestedKind,
          trackCount: 0,
          formats: [],
        };
        diagnostics.attempts.push(attempt);

        let playerResponse;
        try {
          playerResponse = await fetchBoundedText(
            PLAYER_ENDPOINT,
            {
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
                videoId,
                contentCheckOk: true,
                racyCheckOk: true,
              }),
            },
            "player",
            runtime,
            diagnostics,
          );
          attempt.player = {
            status: playerResponse.status,
            bytes: playerResponse.bytes,
            elapsedMs: playerResponse.elapsedMs,
          };
        } catch (error) {
          attempt.error = safeAttemptError(error);
          attempt.outcome =
            error?.code === "RATE_LIMITED"
              ? "rate-limited"
              : "player-request-failed";
          if (
            error?.code === "RATE_LIMITED" ||
            error?.code === "PAGE_CONTEXT_CHANGED"
          ) {
            throw error;
          }
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

        const playability = normalizePlayability(
          playerData?.playabilityStatus?.status,
        );
        attempt.playability = playability;
        if (playability === "OK") stats.sawPlayable = true;
        if (RESTRICTED_PLAYABILITY.has(playability)) stats.sawRestricted = true;

        const tracks = Array.isArray(
          playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
        )
          ? playerData.captions.playerCaptionsTracklistRenderer.captionTracks
          : [];
        attempt.trackCount = tracks.length;
        // A restricted/unavailable player response is not permission to use a
        // caption URL that happens to be present in the same response.
        if (playability && playability !== "OK") {
          attempt.outcome = `player-${playability.toLowerCase()}`;
          continue;
        }
        if (tracks.length) {
          stats.sawCaptionTracks = true;
          diagnostics.sawCaptionTracks = true;
        }

        const rawTrack = chooseTrack(tracks, requestedLanguage, requestedKind);
        if (!rawTrack) {
          attempt.outcome = tracks.length
            ? "requested-track-unavailable"
            : "no-caption";
          continue;
        }

        selectedTrack = sanitizeTrack(rawTrack);
        diagnostics.sawRequestedTrack = true;
        attempt.selectedTrack = selectedTrack;

        for (const format of FORMATS) {
          const formatAttempt = {
            format: format.id,
            trackKind: selectedTrack.kind,
            trackLanguage: selectedTrack.language,
          };
          attempt.formats.push(formatAttempt);
          try {
            const captionUrl = normalizeCaptionUrl(
              rawTrack.baseUrl,
              format.urlFormat === undefined ? format.id : format.urlFormat,
            );
            const response = await fetchBoundedText(
              captionUrl,
              {
                method: "GET",
                headers: { Accept: "application/json, text/xml, */*" },
              },
              "timedtext",
              runtime,
              diagnostics,
            );
            formatAttempt.status = response.status;
            formatAttempt.bytes = response.bytes;
            formatAttempt.elapsedMs = response.elapsedMs;
            if (!response.ok || !response.text.trim()) continue;

            let transcript;
            try {
              transcript = format.parser(response.text, selectedTrack.language);
            } catch (error) {
              formatAttempt.error = safeAttemptError(error);
              continue;
            }
            formatAttempt.segmentCount = transcript.length;
            if (!transcript.length) continue;

            attempt.outcome = "transcript";
            return successResult(
              request,
              videoId,
              requestedLanguage,
              selectedTrack,
              transcript,
              diagnostics,
            );
          } catch (error) {
            formatAttempt.error = safeAttemptError(error);
            if (Number.isInteger(error?.status)) {
              formatAttempt.status = error.status;
            }
            if (
              error?.code === "RATE_LIMITED" ||
              error?.code === "PAGE_CONTEXT_CHANGED"
            ) {
              attempt.outcome =
                error?.code === "RATE_LIMITED"
                  ? "rate-limited"
                  : "page-context-changed";
              throw error;
            }
          }
        }

        // A selected track belongs to the one fixed IOS/json3 attempt. Do not
        // move to another client, track, or format after it fails.
        attempt.outcome = "empty-caption-body";
        fail("EMPTY_TRANSCRIPT");
      }

      fail(finalFailure(stats));
    } catch (error) {
      return failureResult(
        request,
        videoId,
        requestedLanguage,
        selectedTrack,
        error,
        diagnostics,
      );
    } finally {
      navigationTarget?.removeEventListener?.(
        "yt-navigate-start",
        cancelForNavigation,
      );
      navigationTarget?.removeEventListener?.("pagehide", cancelForNavigation);
      if (activeRunState === runState) activeRunState = null;
    }
  }

  return Object.freeze({ apiVersion: 1, run });
});
