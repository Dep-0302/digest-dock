const test = require("node:test");
const assert = require("node:assert/strict");
const probe = require("./player-activation.js");
const selection = require("./selection.js");

const VIDEO_ID = "LEY9kenjVaA";

function fixture({ navigateDuringWait = false, failRestore = false } = {}) {
  let videoId = VIDEO_ID;
  let pressed = false;
  let track = {};
  let setCalls = 0;
  let waitCalls = 0;
  const tracks = [
    { languageCode: "en", vssId: ".en" },
    { languageCode: "zh", vssId: ".zh" },
  ];
  const player = {
    getPlayerResponse: () => ({
      videoDetails: { videoId },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
    }),
    getOptions: () => ["track", "tracklist"],
    getOption: (_module, option) => (option === "tracklist" ? tracks : track),
    loadModule() {},
    unloadModule() {
      if (failRestore) return;
      pressed = false;
      track = {};
    },
    setOption(_module, _option, value) {
      setCalls += 1;
      if (failRestore && setCalls > 1) return;
      track = value;
      pressed = Boolean(value?.languageCode);
    },
  };
  return {
    player,
    cc: { getAttribute: () => String(pressed) },
    wait: async () => {
      waitCalls += 1;
      if (navigateDuringWait && waitCalls === 1) videoId = "bSorYHuY0V8";
    },
    snapshot: () => ({ videoId, pressed, track, setCalls }),
  };
}

test("activates Chinese once and confirms the original off state", async () => {
  const state = fixture();
  const result = await probe.run(
    { videoId: VIDEO_ID, waitMs: 1 },
    {
      selection,
      getPlayer: () => state.player,
      getCcButton: () => state.cc,
      wait: state.wait,
    },
  );
  assert.equal(result.status, "DONE");
  assert.equal(result.target.language, "zh");
  assert.equal(result.restoration, "confirmed");
  assert.equal(state.snapshot().pressed, false);
  assert.equal(state.snapshot().setCalls, 2);
});

test("navigation makes restoration a no-op for the new video", async () => {
  const state = fixture({ navigateDuringWait: true });
  const result = await probe.run(
    { videoId: VIDEO_ID, waitMs: 1 },
    {
      selection,
      getPlayer: () => state.player,
      getCcButton: () => state.cc,
      wait: state.wait,
    },
  );
  assert.equal(result.restoration, "identity-changed-noop");
  assert.equal(result.restoreAttempted, false);
  assert.equal(state.snapshot().setCalls, 1);
});

test("one failed restoration disqualifies the probe", async () => {
  const state = fixture({ failRestore: true });
  const result = await probe.run(
    { videoId: VIDEO_ID, waitMs: 1 },
    {
      selection,
      getPlayer: () => state.player,
      getCcButton: () => state.cc,
      wait: state.wait,
    },
  );
  assert.equal(result.status, "RESTORE_FAILED");
  assert.equal(result.restoration, "failed");
});
