const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const effects = require("../sidepanel-effects.js");

const {
  identityKey,
  sameIdentity,
  taskFlightKey,
  createSingleFlight,
  createIdleFollowController,
  createConsentTokenVault,
  resultMatchesTask,
  createTaskGate,
  createSupadataDispatcher,
} = effects;

function createFakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      sequence += 1;
      timers.set(sequence, { callback, at: now + Number(delay || 0) });
      return sequence;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
        // The controller intentionally chains an async playback read, an async
        // resume, and a final settled callback. Drain that bounded chain.
        for (let index = 0; index < 8; index += 1) {
          await Promise.resolve();
        }
      }
    },
    pending: () => timers.size,
  };
}

const root = path.resolve(__dirname, "..");
const IDENTITY = Object.freeze({
  videoId: "video-a",
  routeKey: "youtube:video-a",
  generation: 3,
  epoch: 7,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("phase-one effects contract is dependency-injected and has no browser API calls", () => {
  const source = fs.readFileSync(path.join(root, "sidepanel-effects.js"), "utf8");
  assert.doesNotMatch(source, /chrome\s*\./);
  assert.doesNotMatch(source, /youtube-active|youtube-panel/i);
});

test("identity includes video, route, generation, and epoch", () => {
  assert.ok(identityKey(IDENTITY));
  assert.equal(sameIdentity(IDENTITY, { ...IDENTITY }), true);
  assert.equal(
    sameIdentity(IDENTITY, { ...IDENTITY, videoId: "video-b" }),
    false,
  );
  assert.equal(
    sameIdentity(IDENTITY, { ...IDENTITY, generation: 4 }),
    false,
  );
  assert.equal(sameIdentity(IDENTITY, { ...IDENTITY, epoch: 8 }), false);
  assert.equal(
    taskFlightKey("transcript", IDENTITY),
    `transcript:${identityKey(IDENTITY)}`,
  );
});

test("single-flight shares one in-flight promise per exact key", async () => {
  const flight = createSingleFlight();
  const pending = deferred();
  let calls = 0;
  const task = async () => {
    calls += 1;
    return pending.promise;
  };

  const first = flight.run("transcript:video-a", task);
  const second = flight.run("transcript:video-a", task);
  assert.strictEqual(second, first);
  assert.equal(flight.activeCount(), 1);
  assert.equal(flight.has("transcript:video-a"), true);

  pending.resolve("ready");
  assert.equal(await first, "ready");
  assert.equal(await second, "ready");
  assert.equal(calls, 1);
  assert.equal(flight.activeCount(), 0);
});

test("single-flight keeps different keys independent and clears rejected work", async () => {
  const flight = createSingleFlight();
  const first = flight.run("a", async () => "a");
  const second = flight.run("b", async () => "b");
  assert.equal(flight.activeCount(), 2);
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.equal(flight.activeCount(), 0);

  await assert.rejects(
    flight.run("broken", async () => {
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.equal(flight.has("broken"), false);
  assert.equal(await flight.run("broken", async () => "recovered"), "recovered");
});

test("idle follow waits five seconds and resumes one current playback", async () => {
  const clock = createFakeClock();
  const resumes = [];
  const controller = createIdleFollowController({
    delayMs: 5000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    readPlayback: async () => ({ currentTime: 42, paused: false }),
    shouldResume: (_snapshot, playback) => playback.paused === false,
    resume: async (snapshot, playback) => resumes.push({ snapshot, playback }),
  });

  controller.schedule({ videoId: "video-a" });
  await clock.advance(4999);
  assert.deepEqual(resumes, []);
  await clock.advance(1);
  assert.deepEqual(resumes, [
    {
      snapshot: { videoId: "video-a" },
      playback: { currentTime: 42, paused: false },
    },
  ]);
  assert.equal(controller.isPending(), false);
});

test("new activity replaces the old idle deadline and cancel prevents resume", async () => {
  const clock = createFakeClock();
  const resumes = [];
  const controller = createIdleFollowController({
    delayMs: 5000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    readPlayback: async (snapshot) => ({ currentTime: snapshot.time, paused: false }),
    shouldResume: () => true,
    resume: async (snapshot) => resumes.push(snapshot),
  });

  controller.schedule({ time: 1 });
  await clock.advance(3000);
  controller.schedule({ time: 2 });
  assert.equal(clock.pending(), 1);
  await clock.advance(4999);
  assert.deepEqual(resumes, []);
  controller.cancel();
  await clock.advance(1);
  assert.deepEqual(resumes, []);
});

test("paused playback and stale async results never resume idle follow", async () => {
  const clock = createFakeClock();
  const pending = deferred();
  const resumes = [];
  const settled = [];
  const controller = createIdleFollowController({
    delayMs: 5000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    readPlayback: () => pending.promise,
    shouldResume: (_snapshot, playback) => playback?.paused === false,
    resume: async (snapshot) => resumes.push(snapshot),
    onSettled: (_snapshot, result) => settled.push(result),
  });

  controller.schedule({ videoId: "video-a" });
  await clock.advance(5000);
  controller.schedule({ videoId: "video-b" });
  pending.resolve({ currentTime: 9, paused: false });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(resumes, []);
  assert.deepEqual(settled, []);
  controller.cancel();

  const pausedController = createIdleFollowController({
    delayMs: 5000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    readPlayback: async () => ({ currentTime: 9, paused: true }),
    shouldResume: (_snapshot, playback) => playback.paused === false,
    resume: async (snapshot) => resumes.push(snapshot),
    onSettled: (_snapshot, result) => settled.push(result),
  });
  pausedController.schedule({ videoId: "paused" });
  await clock.advance(5000);
  assert.deepEqual(resumes, []);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].resumed, false);
  assert.deepEqual(settled[0].playback, { currentTime: 9, paused: true });
});

test("sidepanel idle follow is exact-route, cancellable, and retries safe blockers", () => {
  const source = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
  assert.match(source, /const FOLLOW_IDLE_RESUME_DELAY_MS = 5000/);
  assert.match(source, /const FOLLOW_PLAYBACK_READ_TIMEOUT_MS = 900/);
  assert.match(
    source,
    /function readFollowPlayback\([\s\S]*?expectedRouteKey:\s*snapshot\.routeKey[\s\S]*?action:\s*"getCurrentTime"/,
  );
  assert.match(
    source,
    /function shouldAutoResumeFollow\(snapshot, playback\)[\s\S]*?followPlaybackSnapshotIsCurrent\(snapshot\)[\s\S]*?playback\?\.paused === false/,
  );
  assert.match(
    source,
    /onSettled:\s*\(snapshot,[\s\S]*?playback\?\.paused === true[\s\S]*?followIdleController\?\.schedule\(snapshot\)/,
  );
  assert.match(
    source,
    /function followContextIsDeparted\(\)[\s\S]*?currentWorkspaceTab\(\) === "transcript"[\s\S]*?autoScrollEnabled === false/,
  );
  assert.match(
    source,
    /function resumeFollowPlaybackFromIdle\(snapshot, playback\)[\s\S]*?shouldAutoResumeFollow\(snapshot, playback\)/,
  );
  assert.match(
    source,
    /function restoreFollowAtTime\([\s\S]*?currentWorkspaceTab\(\) !== "transcript"\) return false/,
  );
  assert.doesNotMatch(
    source,
    /function restoreFollowAtTime\([\s\S]*?switchTab\("transcript"/,
  );
});

test("consent token is exact-identity, one-time, and a wrong identity cannot consume it", () => {
  let tokenNumber = 0;
  const vault = createConsentTokenVault({
    makeToken: () => `consent-${++tokenNumber}`,
  });
  const token = vault.mint(IDENTITY);
  assert.equal(token.id, "consent-1");
  assert.equal(vault.has(token), true);
  assert.equal(vault.size(), 1);

  assert.equal(
    vault.consume(token, { ...IDENTITY, videoId: "video-b" }),
    false,
  );
  assert.equal(vault.has(token), true);
  assert.equal(vault.consume(token, IDENTITY), true);
  assert.equal(vault.has(token), false);
  assert.equal(vault.consume(token, IDENTITY), false);
});

test("video or epoch invalidation revokes consent without persistence", () => {
  let tokenNumber = 0;
  const vault = createConsentTokenVault({
    makeToken: () => `consent-${++tokenNumber}`,
  });
  const current = vault.mint(IDENTITY);
  const otherEpochIdentity = { ...IDENTITY, epoch: IDENTITY.epoch + 1 };
  const otherEpoch = vault.mint(otherEpochIdentity);
  assert.equal(vault.size(), 2);

  assert.equal(vault.revokeIdentity(IDENTITY), 1);
  assert.equal(vault.has(current), false);
  assert.equal(vault.has(otherEpoch), true);
  assert.equal(vault.clear(), 1);
  assert.equal(vault.size(), 0);
});

test("task gate rejects replaced task ids, generations, and epochs", () => {
  const gate = createTaskGate();
  gate.begin({
    scope: "transcript",
    taskId: "task-1",
    taskOrigin: "INITIAL_LOAD",
    identity: IDENTITY,
  });
  assert.equal(
    gate.isCurrent({ scope: "transcript", taskId: "task-1", ...IDENTITY }),
    true,
  );
  assert.equal(
    gate.isCurrent({
      scope: "transcript",
      taskId: "task-1",
      ...IDENTITY,
      epoch: IDENTITY.epoch + 1,
    }),
    false,
  );

  gate.begin({
    scope: "transcript",
    taskId: "task-2",
    taskOrigin: "USER_RETRY_FREE",
    identity: IDENTITY,
  });
  assert.equal(
    gate.isCurrent({ scope: "transcript", taskId: "task-1", ...IDENTITY }),
    false,
  );
  assert.equal(
    gate.isCurrent({ scope: "transcript", taskId: "task-2", ...IDENTITY }),
    true,
  );
  assert.equal(
    gate.isCurrent({
      scope: "transcript",
      taskId: "task-2",
      ...IDENTITY,
      generation: IDENTITY.generation + 1,
    }),
    false,
  );
});

test("task gate finishes only the current result and keeps scopes independent", () => {
  const gate = createTaskGate();
  const transcriptTask = gate.begin({
    scope: "transcript",
    taskId: "transcript-1",
    taskOrigin: "INITIAL_LOAD",
    identity: IDENTITY,
  });
  gate.begin({
    scope: "overview",
    taskId: "overview-1",
    taskOrigin: "USER_GENERATE",
    identity: IDENTITY,
  });
  assert.equal(gate.size(), 2);
  assert.equal(
    resultMatchesTask(transcriptTask, {
      scope: "transcript",
      taskId: "transcript-1",
      ...IDENTITY,
    }),
    true,
  );
  assert.equal(
    gate.finish({
      scope: "transcript",
      taskId: "late-task",
      ...IDENTITY,
    }),
    false,
  );
  assert.equal(gate.size(), 2);
  assert.equal(
    gate.finish({
      scope: "transcript",
      taskId: "transcript-1",
      ...IDENTITY,
    }),
    true,
  );
  assert.equal(gate.current("transcript"), null);
  assert.equal(gate.current("overview").id, "overview-1");
});

test("task invalidation is identity-specific", () => {
  const gate = createTaskGate();
  gate.begin({
    scope: "transcript",
    taskId: "transcript-1",
    taskOrigin: "INITIAL_LOAD",
    identity: IDENTITY,
  });
  gate.begin({
    scope: "overview",
    taskId: "overview-1",
    taskOrigin: "USER_GENERATE",
    identity: { ...IDENTITY, epoch: IDENTITY.epoch + 1 },
  });
  assert.equal(gate.invalidateIdentity(IDENTITY), 1);
  assert.equal(gate.current("transcript"), null);
  assert.equal(gate.current("overview").id, "overview-1");
});

test("Supadata dispatcher consumes consent immediately before one injected send", async () => {
  const order = [];
  const vault = createConsentTokenVault({ makeToken: () => "consent-send" });
  const token = vault.mint(IDENTITY);
  const dispatcher = createSupadataDispatcher({
    tokenVault: vault,
    send: async (request) => {
      order.push("send");
      assert.equal(vault.has(token), false);
      assert.equal(request.supadataConsent, true);
      assert.equal(Object.hasOwn(request, "consentToken"), false);
      assert.equal(request.videoId, IDENTITY.videoId);
      assert.equal(request.routeKey, IDENTITY.routeKey);
      assert.equal(request.digestGeneration, IDENTITY.generation);
      assert.equal(request.epoch, IDENTITY.epoch);
      return { success: true };
    },
  });

  order.push("before");
  const result = await dispatcher.dispatch({
    identity: IDENTITY,
    token,
    request: {
      action: "fetchTranscript",
      consentToken: "must-not-cross-message-boundary",
    },
    onConsumed: () => order.push("consumed"),
  });
  order.push("after");
  assert.deepEqual(order, ["before", "consumed", "send", "after"]);
  assert.deepEqual(result, { success: true });

  await assert.rejects(
    dispatcher.dispatch({ identity: IDENTITY, token, request: {} }),
    (error) => error.code === "SUPADATA_CONSENT_TOKEN_REQUIRED",
  );
});

test("Supadata dispatcher rejects request identity drift before consuming consent", async () => {
  let sends = 0;
  const vault = createConsentTokenVault({ makeToken: () => "consent-drift" });
  const token = vault.mint(IDENTITY);
  const dispatcher = createSupadataDispatcher({
    tokenVault: vault,
    send: async () => {
      sends += 1;
    },
  });

  await assert.rejects(
    dispatcher.dispatch({
      identity: IDENTITY,
      token,
      request: {
        videoId: "video-b",
        routeKey: "youtube:video-b",
        digestGeneration: IDENTITY.generation,
        epoch: IDENTITY.epoch,
      },
    }),
    (error) => error.code === "PAGE_CONTEXT_CHANGED",
  );
  assert.equal(sends, 0);
  assert.equal(vault.has(token), true);
});

test("a failed provider send still burns the one-time token", async () => {
  let sends = 0;
  const vault = createConsentTokenVault({ makeToken: () => "consent-fail" });
  const token = vault.mint(IDENTITY);
  const dispatcher = createSupadataDispatcher({
    tokenVault: vault,
    send: async () => {
      sends += 1;
      throw new Error("provider unavailable");
    },
  });

  await assert.rejects(
    dispatcher.dispatch({ identity: IDENTITY, token, request: {} }),
    /provider unavailable/,
  );
  assert.equal(vault.has(token), false);
  await assert.rejects(
    dispatcher.dispatch({ identity: IDENTITY, token, request: {} }),
    (error) => error.code === "SUPADATA_CONSENT_TOKEN_REQUIRED",
  );
  assert.equal(sends, 1);
});
