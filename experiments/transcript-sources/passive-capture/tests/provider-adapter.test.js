const test = require("node:test");
const assert = require("node:assert/strict");

global.TRANSCRIPT_PROVIDER_CONTRACT = require("../../shared/provider-contract.js");
global.PASSIVE_TRANSCRIPT_CORE = require("../extension/core.js");
const passive = require("../provider-adapter.js");

function request() {
  return {
    providerId: "youtube-passive",
    providerVariant: null,
    runId: "passive-run",
    requestId: "passive-request",
    videoId: "jNQXAC9IVRw",
  };
}

test("passive adapter maps an observed response without provider requests", async () => {
  const adapter = passive.createAdapter();
  const result = await adapter(request(), {
    capture: {
      videoId: "jNQXAC9IVRw",
      language: "en",
      kind: "manual",
      format: "json3",
      status: 200,
      transport: "xhr",
      body: JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Fixture" }] },
        ],
      }),
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.diagnostics.providerInitiated, {
    youtubePlayer: 0,
    youtubeTimedtext: 0,
    thirdParty: 0,
    loopback: 0,
  });
  assert.equal(result.diagnostics.pageObserved.youtubeTimedtext, 1);
});

test("passive miss returns without starting active or Supadata", async () => {
  const result = await passive.createAdapter()(request(), {});
  assert.equal(result.errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(result.diagnostics.providerInitiated.youtubeTimedtext, 0);
  assert.equal(result.diagnostics.providerInitiated.thirdParty, 0);
});
