(function installSelection(root, factory) {
  const api = factory();
  if (root) root.DIGESTDOCK_AUTO_READ_SELECTION = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const CHINESE_PRIMARY_CODES = new Set([
    "zh",
    "zho",
    "chi",
    "cmn",
    "yue",
    "wuu",
    "gan",
    "hak",
    "nan",
    "lzh",
  ]);

  function normalizeLanguage(value) {
    const raw = String(value || "").trim().replace(/_/g, "-");
    if (
      !raw ||
      raw.length > 35 ||
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(raw)
    ) {
      return "";
    }
    try {
      return Intl.getCanonicalLocales(raw)[0] || "";
    } catch (_error) {
      return "";
    }
  }

  function primaryLanguage(value) {
    return normalizeLanguage(value).split("-")[0].toLowerCase();
  }

  function isChineseLanguage(value) {
    return CHINESE_PRIMARY_CODES.has(primaryLanguage(value));
  }

  function normalizeTracks(tracks) {
    return (Array.isArray(tracks) ? tracks : [])
      .slice(0, 100)
      .map((track, index) => {
        const language = normalizeLanguage(
          track?.language || track?.languageCode,
        );
        const kind = track?.kind === "asr" ? "asr" : "manual";
        return language ? { language, kind, index } : null;
      })
      .filter(Boolean);
  }

  function rankTrack(left, right) {
    return (
      Number(left.kind === "asr") - Number(right.kind === "asr") ||
      left.index - right.index
    );
  }

  function chooseAutoReadTrack(tracks) {
    const normalized = normalizeTracks(tracks);
    const chinese = normalized.filter((track) =>
      isChineseLanguage(track.language),
    );
    if (chinese.length) return chinese.sort(rankTrack)[0];

    const languageGroups = new Set(
      normalized.map((track) => primaryLanguage(track.language)).filter(Boolean),
    );
    if (languageGroups.size !== 1) return null;
    return normalized.sort(rankTrack)[0] || null;
  }

  return Object.freeze({
    normalizeLanguage,
    primaryLanguage,
    isChineseLanguage,
    normalizeTracks,
    chooseAutoReadTrack,
  });
});
