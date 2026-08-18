var BILI_SUBTITLE_POC = (() => {
  const API_BASE = "https://api.bilibili.com";
  const TRUSTED_SUBTITLE_DOMAINS = Object.freeze([
    "bilibili.com",
    "hdslb.com",
    "bilivideo.com",
  ]);
  const DEFAULT_TIMEOUT_MS = 15_000;
  const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

  class VerifierError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "VerifierError";
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new VerifierError(code, message);
  }

  function parseBilibiliVideoUrl(input) {
    let url;
    try {
      url = new URL(String(input || ""));
    } catch {
      fail("INVALID_URL", "当前标签页地址无效。");
    }

    if (url.protocol !== "https:" || url.hostname !== "www.bilibili.com") {
      fail("UNSUPPORTED_URL", "请打开标准的 https://www.bilibili.com/video/BV... 页面。");
    }

    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{6,20})(?:\/|$)/);
    if (!match) {
      fail("UNSUPPORTED_URL", "当前页面不是标准 BV 视频页。");
    }

    const rawPage = url.searchParams.get("p");
    const page = rawPage === null ? 1 : Number(rawPage);
    if (!Number.isInteger(page) || page < 1) {
      fail("INVALID_PAGE", "分P参数 p 必须是正整数。");
    }

    return {
      bvid: match[1],
      page,
      canonicalUrl:
        page > 1
          ? `https://www.bilibili.com/video/${match[1]}/?p=${page}`
          : `https://www.bilibili.com/video/${match[1]}/`,
    };
  }

  function selectVideoPart(viewData, requestedPage) {
    if (!viewData || typeof viewData !== "object") {
      fail("INVALID_VIEW_DATA", "视频信息响应缺少 data。");
    }

    const pages = Array.isArray(viewData.pages) ? viewData.pages : [];
    let part = pages.find((item) => Number(item?.page) === requestedPage);
    if (!part && requestedPage <= pages.length) part = pages[requestedPage - 1];

    if (!part && requestedPage === 1 && viewData.cid) {
      part = {
        cid: viewData.cid,
        page: 1,
        part: viewData.title || "P1",
        duration: viewData.duration || 0,
      };
    }

    if (!part?.cid) {
      fail("PART_NOT_FOUND", `没有找到第 ${requestedPage} P 的 CID。`);
    }

    return {
      aid: Number(viewData.aid) || null,
      cid: Number(part.cid),
      page: Number(part.page) || requestedPage,
      partTitle: String(part.part || viewData.title || "").trim(),
      duration: Number(part.duration || viewData.duration || 0),
    };
  }

  function readTrackUrl(track) {
    if (typeof track?.subtitle_url === "string" && track.subtitle_url) {
      return track.subtitle_url;
    }
    return typeof track?.subtitle_url_v2 === "string" ? track.subtitle_url_v2 : "";
  }

  function isChineseTrack(track) {
    const marker = `${track?.lan || ""} ${track?.lan_doc || ""}`.toLowerCase();
    return /(^|[\s-])zh([\s-]|$)|中文|简体|繁体|chinese/.test(marker);
  }

  function isAiTrack(track) {
    const marker = `${track?.lan || ""} ${track?.lan_doc || ""}`.toLowerCase();
    return (
      marker.includes("ai-") ||
      marker.includes("自动") ||
      marker.includes("智能") ||
      Number(track?.ai_type || 0) > 0 ||
      Number(track?.ai_status || 0) > 0
    );
  }

  function chooseSubtitleTrack(tracks) {
    const usable = (Array.isArray(tracks) ? tracks : []).filter(readTrackUrl);
    if (!usable.length) return null;

    return usable
      .map((track, index) => {
        const chinese = isChineseTrack(track);
        const ai = isAiTrack(track);
        const score = chinese && !ai ? 400 : chinese ? 300 : !ai ? 200 : 100;
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
    if (!raw) fail("EMPTY_SUBTITLE_URL", "字幕轨没有返回字幕地址。");

    let url;
    try {
      if (raw.startsWith("//")) url = new URL(`https:${raw}`);
      else if (raw.startsWith("/")) url = new URL(raw, "https://www.bilibili.com");
      else url = new URL(raw);
    } catch {
      fail("INVALID_SUBTITLE_URL", "字幕地址格式无效。");
    }

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !isTrustedSubtitleHost(url.hostname)
    ) {
      fail("UNTRUSTED_SUBTITLE_URL", "字幕地址不属于受信任的 B 站域名。");
    }

    return url.href;
  }

  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function normalizeSubtitleBody(input, language = "") {
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
          language: language || null,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.start - right.start);

    if (!transcript.length) {
      fail("EMPTY_TRANSCRIPT", "字幕文件没有可用的正文片段。");
    }

    return {
      transcript,
      transcriptText: transcript.map((entry) => entry.text).join(" "),
      transcriptTextTimestamped: transcript
        .map((entry) => `[${formatTimestamp(entry.start)}] ${entry.text}`)
        .join("\n"),
      language: language || null,
    };
  }

  function sanitizeTrack(track, index) {
    return {
      index,
      id: track?.id_str || track?.id || null,
      language: String(track?.lan || ""),
      label: String(track?.lan_doc || track?.lan || `字幕 ${index + 1}`),
      isAi: isAiTrack(track),
    };
  }

  async function fetchJson(
    url,
    {
      credentials = "omit",
      fetchImpl = globalThis.fetch,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    } = {},
  ) {
    if (typeof fetchImpl !== "function") {
      fail("FETCH_UNAVAILABLE", "当前环境没有可用的 fetch。");
    }

    const controller = typeof AbortController === "function" ? new AbortController() : null;
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
        fail("HTTP_ERROR", `请求失败：HTTP ${response?.status || "unknown"}。`);
      }

      const text = await response.text();
      if (text.length > maxResponseBytes) {
        fail("RESPONSE_TOO_LARGE", "接口响应超过验证器允许的大小。");
      }

      try {
        return JSON.parse(text);
      } catch {
        fail("INVALID_JSON", "接口没有返回有效 JSON。");
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        fail("TIMEOUT", "请求超时，请重试。");
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function assertApiSuccess(json, label) {
    if (!json || json.code !== 0 || !json.data) {
      fail("BILIBILI_API_ERROR", `${label}失败：${json?.message || "未知错误"}。`);
    }
    return json.data;
  }

  async function verifyVideo(rawUrl, options = {}) {
    const media = parseBilibiliVideoUrl(rawUrl);
    const fetchOptions = {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
    };

    const viewJson = await fetchJson(
      `${API_BASE}/x/web-interface/view?bvid=${encodeURIComponent(media.bvid)}`,
      { ...fetchOptions, credentials: "include" },
    );
    const viewData = assertApiSuccess(viewJson, "获取视频信息");
    const part = selectVideoPart(viewData, media.page);

    const playerParams = new URLSearchParams({
      bvid: media.bvid,
      cid: String(part.cid),
    });
    if (part.aid) playerParams.set("aid", String(part.aid));

    const playerJson = await fetchJson(
      `${API_BASE}/x/player/wbi/v2?${playerParams}`,
      { ...fetchOptions, credentials: "include" },
    );
    const playerData = assertApiSuccess(playerJson, "获取播放器字幕信息");
    const rawTracks = Array.isArray(playerData.subtitle?.subtitles)
      ? playerData.subtitle.subtitles
      : [];
    const chosenTrack = chooseSubtitleTrack(rawTracks);

    if (!chosenTrack) {
      if (playerData.need_login_subtitle) {
        fail("LOGIN_REQUIRED", "该视频的字幕需要当前 Chrome 登录 B 站后才能读取。");
      }
      fail("NO_SUBTITLE", "该视频没有可用的独立字幕轨。");
    }

    const subtitleUrl = normalizeSubtitleUrl(readTrackUrl(chosenTrack));
    const subtitleJson = await fetchJson(subtitleUrl, {
      ...fetchOptions,
      credentials: "omit",
    });
    const normalized = normalizeSubtitleBody(subtitleJson, chosenTrack.lan || "");
    const tracks = rawTracks.filter(readTrackUrl).map(sanitizeTrack);
    const selectedIndex = rawTracks.indexOf(chosenTrack);

    return {
      media: {
        platform: "bilibili",
        bvid: media.bvid,
        aid: part.aid,
        cid: part.cid,
        page: part.page,
        mediaKey: `bilibili:${media.bvid}:${part.cid}`,
        canonicalUrl: media.canonicalUrl,
        title: String(viewData.title || ""),
        partTitle: part.partTitle,
        creator: String(viewData.owner?.name || ""),
        duration: part.duration,
      },
      tracks,
      selectedTrack: sanitizeTrack(chosenTrack, selectedIndex),
      ...normalized,
    };
  }

  const api = {
    VerifierError,
    parseBilibiliVideoUrl,
    selectVideoPart,
    readTrackUrl,
    isChineseTrack,
    isAiTrack,
    chooseSubtitleTrack,
    isTrustedSubtitleHost,
    normalizeSubtitleUrl,
    formatTimestamp,
    normalizeSubtitleBody,
    verifyVideo,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
