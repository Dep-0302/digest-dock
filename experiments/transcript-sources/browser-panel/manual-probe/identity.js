var PANEL_VIDEO_IDENTITY = (() => {
  const VIDEO_ID = /^[0-9A-Za-z_-]{11}$/;

  function normalize(value) {
    const videoId = String(value || "");
    return VIDEO_ID.test(videoId) ? videoId : null;
  }

  function matches(expectedVideoId, sources) {
    const expected = normalize(expectedVideoId);
    if (!expected || !sources || typeof sources !== "object") return false;
    const observed = [sources.playerId, sources.flexVideoId]
      .map(normalize)
      .filter(Boolean);
    return observed.length > 0 && observed.every((videoId) => videoId === expected);
  }

  return { normalize, matches };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = PANEL_VIDEO_IDENTITY;
}
