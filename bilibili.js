/**
 * Bilibili media and native-caption adapter.
 *
 * This module deliberately keeps Bilibili session handling inside fetch:
 * API calls use the browser's existing session, while subtitle CDN requests
 * omit credentials. It never returns the signed subtitle URL.
 */
var BILIBILI_ADAPTER = (() => {
  const API_ORIGIN = "https://api.bilibili.com";
  const DEFAULT_TIMEOUT_MS = 15_000;
  const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const TRUSTED_SUBTITLE_DOMAINS = Object.freeze([
    "bilibili.com",
    "hdslb.com",
    "bilivideo.com",
  ]);

  class BilibiliAdapterError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "BilibiliAdapterError";
      this.code = code;
      if (Number.isInteger(details.status)) this.status = details.status;
      if (Number.isFinite(details.apiCode)) this.apiCode = details.apiCode;
    }
  }

  function fail(code, message, details) {
    throw new BilibiliAdapterError(code, message, details);
  }

  function parseVideoUrl(input) {
    let url;
    try {
      url = new URL(String(input || ""));
    } catch {
      fail("UNSUPPORTED_URL", "当前地址不是有效的 B 站视频链接。");
    }

    if (url.protocol !== "https:" || url.hostname !== "www.bilibili.com") {
      fail(
        "UNSUPPORTED_URL",
        "仅支持标准的 https://www.bilibili.com/video/BV... 页面。",
      );
    }

    const match = url.pathname.match(
      /^\/video\/(BV[0-9A-Za-z]{6,20})\/?$/,
    );
    if (!match) {
      fail("UNSUPPORTED_URL", "当前页面不是标准的 B 站 BV 视频页。");
    }

    const rawPage = url.searchParams.get("p");
    if (rawPage !== null && !/^[1-9]\d*$/.test(rawPage)) {
      fail("INVALID_PAGE", "分P参数 p 必须是正整数。");
    }
    const page = rawPage === null ? 1 : Number(rawPage);
    if (!Number.isSafeInteger(page)) {
      fail("INVALID_PAGE", "分P参数 p 超出支持范围。");
    }

    return {
      bvid: match[1],
      page,
      canonicalUrl: canonicalVideoUrl(match[1], page),
    };
  }

  function canonicalVideoUrl(bvid, page = 1) {
    const normalizedBvid = String(bvid || "").trim();
    const normalizedPage = Number(page);
    if (!/^BV[0-9A-Za-z]{6,20}$/.test(normalizedBvid)) {
      fail("UNSUPPORTED_URL", "BVID 格式无效。");
    }
    if (!Number.isSafeInteger(normalizedPage) || normalizedPage < 1) {
      fail("INVALID_PAGE", "分P参数 p 必须是正整数。");
    }
    return normalizedPage > 1
      ? `https://www.bilibili.com/video/${normalizedBvid}/?p=${normalizedPage}`
      : `https://www.bilibili.com/video/${normalizedBvid}/`;
  }

  function timestampUrl(mediaRef, seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const parsed =
      typeof mediaRef === "string"
        ? parseVideoUrl(mediaRef)
        : {
            bvid: mediaRef?.bvid,
            page: Number(mediaRef?.page) || 1,
          };
    const url = new URL(canonicalVideoUrl(parsed.bvid, parsed.page));
    url.searchParams.set("t", String(safeSeconds));
    return url.href;
  }

  function selectVideoPart(viewData, requestedPage) {
    if (!viewData || typeof viewData !== "object") {
      fail("API", "B 站视频信息响应缺少 data。");
    }

    const page = Number(requestedPage);
    const pages = Array.isArray(viewData.pages) ? viewData.pages : [];
    let part = pages.find((item) => Number(item?.page) === page);
    if (!part && page <= pages.length) part = pages[page - 1];

    if (!part && page === 1 && viewData.cid) {
      part = {
        cid: viewData.cid,
        page: 1,
        part: viewData.title || "P1",
        duration: viewData.duration || 0,
      };
    }

    const aid = Number(viewData.aid);
    const cid = Number(part?.cid);
    if (!Number.isSafeInteger(aid) || aid < 1) {
      fail("API", "B 站视频信息没有返回有效的 AID。");
    }
    if (!Number.isSafeInteger(cid) || cid < 1) {
      fail("API", `B 站视频信息没有返回第 ${page} P 的有效 CID。`);
    }

    return {
      aid,
      cid,
      page,
      partTitle: String(part?.part || viewData.title || "").trim(),
      duration: Math.max(
        0,
        Number(part?.duration || viewData.duration || 0) || 0,
      ),
    };
  }

  function mediaRefFromView(parsedUrl, viewData) {
    const part = selectVideoPart(viewData, parsedUrl.page);
    const title = String(viewData.title || "").trim();
    const channelName = String(viewData.owner?.name || "").trim();
    const description = String(viewData.desc || "").trim();
    const descriptionStatus = Object.hasOwn(viewData, "desc")
      ? description
        ? "present"
        : "confirmed-empty"
      : "unknown";
    const canonicalUrl = canonicalVideoUrl(parsedUrl.bvid, part.page);
    const metadata = {
      title,
      channelName,
      creator: channelName,
      description,
      descriptionStatus,
      duration: part.duration,
      partTitle: part.partTitle,
    };

    return {
      platform: "bilibili",
      bvid: parsedUrl.bvid,
      aid: part.aid,
      cid: part.cid,
      page: part.page,
      mediaKey: `bilibili:${parsedUrl.bvid}:${part.cid}`,
      canonicalUrl,
      metadata,
      ...metadata,
    };
  }

  function readTrackUrl(track) {
    const primary =
      typeof track?.subtitle_url === "string"
        ? track.subtitle_url.trim()
        : "";
    if (primary) return primary;
    return typeof track?.subtitle_url_v2 === "string"
      ? track.subtitle_url_v2.trim()
      : "";
  }

  function languageMarker(value) {
    if (value && typeof value === "object") {
      return `${value.lan || ""} ${value.lan_doc || ""}`.toLowerCase();
    }
    return String(value || "").trim().toLowerCase();
  }

  function isChineseLanguage(value) {
    const marker = languageMarker(value);
    return (
      /(^|[^a-z])zh(?:[-_][a-z]+)?([^a-z]|$)/i.test(marker) ||
      /(^|[^a-z])(?:ai[-_])?zh([^a-z]|$)/i.test(marker) ||
      /中文|简体|繁体|汉语|漢語|chinese/i.test(marker)
    );
  }

  function isAiTrack(track) {
    const marker = languageMarker(track);
    return (
      Number(track?.ai_type || 0) > 0 ||
      Number(track?.ai_status || 0) > 0 ||
      /(^|[^a-z])ai([^a-z]|$)|自动|自動|智能|auto(?:matic)?/i.test(marker)
    );
  }

  function normalizedTrackLanguage(track) {
    const raw = String(track?.lan || "").trim();
    if (!isChineseLanguage(track)) return raw || null;
    const normalizedRaw = raw.replace(/_/g, "-");
    const marker = languageMarker(track);
    if (
      /^zh-(?:hant|tw|hk|mo)(?:-|$)/i.test(normalizedRaw) ||
      /繁体|繁體/.test(marker)
    ) {
      return /^zh-(?:hant|tw|hk|mo)(?:-|$)/i.test(normalizedRaw)
        ? normalizedRaw
        : "zh-Hant";
    }
    if (/^zh-(?:hans|cn|sg)(?:-|$)/i.test(normalizedRaw)) {
      return normalizedRaw;
    }
    // Bilibili's generic `zh` and `ai-zh` tracks are Simplified Chinese.
    // Emit an explicit tag so the shared transcript UI can distinguish them
    // from Traditional tracks instead of treating a bare `zh` as conclusive.
    return "zh-CN";
  }

  function chooseSubtitleTrack(tracks) {
    const usable = (Array.isArray(tracks) ? tracks : []).filter(readTrackUrl);
    if (!usable.length) return null;

    return usable
      .map((track, index) => {
        const chinese = isChineseLanguage(track);
        const score = chinese ? (isAiTrack(track) ? 2 : 3) : 1;
        return { track, index, score };
      })
      .sort((left, right) => right.score - left.score || left.index - right.index)[0]
      .track;
  }

  function isTrustedSubtitleHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return TRUSTED_SUBTITLE_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  }

  function normalizeSubtitleUrl(input) {
    const raw = String(input || "").trim();
    if (!raw) fail("NO_TRANSCRIPT", "字幕轨没有返回字幕地址。");

    let url;
    try {
      if (raw.startsWith("//")) url = new URL(`https:${raw}`);
      else if (raw.startsWith("/")) {
        url = new URL(raw, "https://www.bilibili.com");
      } else url = new URL(raw);
    } catch {
      fail("NO_TRANSCRIPT", "B 站返回的字幕地址无效。");
    }

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !isTrustedSubtitleHost(url.hostname)
    ) {
      fail("NO_TRANSCRIPT", "B 站返回的字幕地址不受信任。");
    }

    return url.href;
  }

  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function normalizeSubtitleBody(input, language = null) {
    const body = Array.isArray(input?.body)
      ? input.body
      : Array.isArray(input?.data?.body)
        ? input.data.body
        : [];

    const transcript = body
      .map((item) => {
        const start = Number(item?.from);
        const end = Number(item?.to);
        const text = String(item?.content || "")
          .replace(/\s+/g, " ")
          .trim();
        if (
          !text ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end < start
        ) {
          return null;
        }
        return {
          text,
          start,
          duration: end - start,
          language,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.start - right.start);

    if (!transcript.length) {
      fail("EMPTY_TRANSCRIPT", "B 站字幕文件没有可用的正文片段。");
    }

    return {
      transcript,
      transcriptText: transcript.map((entry) => entry.text).join(" "),
      transcriptTextTimestamped: transcript
        .map((entry) => `[${formatTimestamp(entry.start)}] ${entry.text}`)
        .join("\n"),
      language,
    };
  }

  function sanitizeTrack(track, index) {
    return {
      index,
      id: track?.id_str || track?.id || null,
      language: normalizedTrackLanguage(track),
      nativeLanguage: String(track?.lan || "").trim() || null,
      label: String(track?.lan_doc || track?.lan || `字幕 ${index + 1}`),
      isAi: isAiTrack(track),
      isChinese: isChineseLanguage(track),
    };
  }

  function utf8ByteLength(text) {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text).byteLength;
    }
    let bytes = 0;
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (codePoint <= 0x7f) bytes += 1;
      else if (codePoint <= 0x7ff) bytes += 2;
      else if (codePoint <= 0xffff) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  }

  async function readBoundedJson(response, maxResponseBytes) {
    const declaredLength = Number(response?.headers?.get?.("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maxResponseBytes
    ) {
      fail("RESPONSE_TOO_LARGE", "B 站响应超过允许的大小。");
    }

    if (typeof response?.text === "function") {
      const text = await response.text();
      if (utf8ByteLength(text) > maxResponseBytes) {
        fail("RESPONSE_TOO_LARGE", "B 站响应超过允许的大小。");
      }
      try {
        return JSON.parse(text);
      } catch {
        fail("API", "B 站接口没有返回有效 JSON。");
      }
    }

    if (typeof response?.json === "function") {
      const data = await response.json();
      let serialized;
      try {
        serialized = JSON.stringify(data);
      } catch {
        fail("API", "B 站接口响应无法解析。");
      }
      if (utf8ByteLength(serialized) > maxResponseBytes) {
        fail("RESPONSE_TOO_LARGE", "B 站响应超过允许的大小。");
      }
      return data;
    }

    fail("API", "B 站接口响应缺少正文。");
  }

  async function fetchJson(
    url,
    {
      credentials,
      fetchImpl,
      timeoutMs,
      maxResponseBytes,
    },
  ) {
    if (typeof fetchImpl !== "function") {
      fail("HTTP", "当前环境没有可用的 fetch。");
    }

    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId =
      controller && timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

    try {
      const response = await fetchImpl(url, {
        method: "GET",
        credentials,
        cache: "no-store",
        headers: { Accept: "application/json, text/plain, */*" },
        ...(controller ? { signal: controller.signal } : {}),
      });

      if (!response?.ok) {
        fail(
          "HTTP",
          `B 站请求失败（HTTP ${Number(response?.status) || "unknown"}）。`,
          { status: Number(response?.status) || undefined },
        );
      }
      return await readBoundedJson(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof BilibiliAdapterError) throw error;
      if (error?.name === "AbortError" || controller?.signal?.aborted) {
        fail("TIMEOUT", "B 站请求超时，请重试。");
      }
      fail("HTTP", "B 站网络请求失败。");
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function unwrapApiData(json, label) {
    const apiCode = Number(json?.code);
    if (apiCode === -101) {
      fail("LOGIN_REQUIRED", `${label}需要当前浏览器登录 B 站。`, {
        apiCode,
      });
    }
    if (apiCode !== 0 || !json?.data || typeof json.data !== "object") {
      fail("API", `${label}失败：B 站接口返回异常。`, {
        apiCode: Number.isFinite(apiCode) ? apiCode : undefined,
      });
    }
    return json.data;
  }

  function validateMediaRef(mediaRef) {
    if (!mediaRef || mediaRef.platform !== "bilibili") {
      fail("API", "B 站媒体引用无效。");
    }
    const bvid = String(mediaRef.bvid || "").trim();
    const aid = Number(mediaRef.aid);
    const cid = Number(mediaRef.cid);
    const page = Number(mediaRef.page || 1);
    if (
      !/^BV[0-9A-Za-z]{6,20}$/.test(bvid) ||
      !Number.isSafeInteger(aid) ||
      aid < 1 ||
      !Number.isSafeInteger(cid) ||
      cid < 1 ||
      !Number.isSafeInteger(page) ||
      page < 1
    ) {
      fail("API", "B 站媒体引用缺少有效的 BVID、AID 或 CID。");
    }
    return { bvid, aid, cid, page };
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
    };

    function requestOptions(callOptions = {}) {
      return {
        fetchImpl:
          callOptions.fetchImpl ||
          baseOptions.fetchImpl ||
          globalThis.fetch,
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

    async function resolveMedia(url, callOptions = {}) {
      const parsed = parseVideoUrl(url);
      const query = new URLSearchParams({ bvid: parsed.bvid });
      const json = await fetchJson(
        `${API_ORIGIN}/x/web-interface/view?${query}`,
        {
          ...requestOptions(callOptions),
          credentials: "include",
        },
      );
      return mediaRefFromView(
        parsed,
        unwrapApiData(json, "获取 B 站视频信息"),
      );
    }

    async function fetchTranscript(mediaRef, callOptions = {}) {
      const media = validateMediaRef(mediaRef);
      const query = new URLSearchParams({
        bvid: media.bvid,
        cid: String(media.cid),
        aid: String(media.aid),
      });
      const playerJson = await fetchJson(
        `${API_ORIGIN}/x/player/wbi/v2?${query}`,
        {
          ...requestOptions(callOptions),
          credentials: "include",
        },
      );
      const playerData = unwrapApiData(playerJson, "获取 B 站字幕信息");
      const rawTracks = Array.isArray(playerData.subtitle?.subtitles)
        ? playerData.subtitle.subtitles
        : [];
      const chosenTrack = chooseSubtitleTrack(rawTracks);

      if (!chosenTrack) {
        if (playerData.need_login_subtitle) {
          fail(
            "LOGIN_REQUIRED",
            "该视频的字幕需要当前浏览器登录 B 站后才能读取。",
          );
        }
        fail("NO_TRANSCRIPT", "该视频没有可用的独立字幕轨。");
      }

      // The signed URL is intentionally scoped to this function. Do not add it
      // to returned tracks, errors, logs, cache entries, or persisted media refs.
      const subtitleUrl = normalizeSubtitleUrl(readTrackUrl(chosenTrack));
      const subtitleJson = await fetchJson(subtitleUrl, {
        ...requestOptions(callOptions),
        credentials: "omit",
      });
      const language = normalizedTrackLanguage(chosenTrack);
      const normalized = normalizeSubtitleBody(subtitleJson, language);
      const usableTracks = rawTracks.filter(readTrackUrl);
      const selectedIndex = usableTracks.indexOf(chosenTrack);

      return {
        ...normalized,
        mediaKey: `bilibili:${media.bvid}:${media.cid}`,
        isChinese: isChineseLanguage(chosenTrack),
        tracks: usableTracks.map(sanitizeTrack),
        selectedTrack: sanitizeTrack(chosenTrack, selectedIndex),
      };
    }

    return { resolveMedia, fetchTranscript };
  }

  const defaultAdapter = createAdapter();

  return {
    BilibiliAdapterError,
    API_ORIGIN,
    TRUSTED_SUBTITLE_DOMAINS,
    parseVideoUrl,
    parseBilibiliVideoUrl: parseVideoUrl,
    canonicalVideoUrl,
    timestampUrl,
    selectVideoPart,
    mediaRefFromView,
    readTrackUrl,
    isChineseLanguage,
    isAiTrack,
    normalizedTrackLanguage,
    chooseSubtitleTrack,
    isTrustedSubtitleHost,
    normalizeSubtitleUrl,
    formatTimestamp,
    normalizeSubtitleBody,
    createAdapter,
    create: createAdapter,
    resolveMedia: defaultAdapter.resolveMedia,
    fetchTranscript: defaultAdapter.fetchTranscript,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILIBILI_ADAPTER;
}
