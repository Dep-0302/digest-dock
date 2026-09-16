// Synthetic nine-hour JSON3 fixture with per-word timing and ASR metadata.
// It exceeds the old 8 MiB limit without padding or one implausibly huge cue.
module.exports = function longYoutubeTranscript() {
  const cueCount = 16_200;
  const events = Array.from({ length: cueCount }, (_, index) => ({
    tStartMs: index * 2000,
    dDurationMs: 2000,
    wWinId: 1,
    segs: Array.from({ length: 10 }, (_, word) => ({
      utf8: `${index === 0 ? "FIRST" : index === cueCount - 1 ? "LAST" : "caption"}-${index}-${word} `,
      tOffsetMs: word * 190,
      acAsrConf: 0.95,
    })),
  }));
  return { body: JSON.stringify({ wireMagic: "pb3", events }), cueCount, lastStart: (cueCount - 1) * 2 };
};
