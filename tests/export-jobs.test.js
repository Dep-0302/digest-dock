const test = require("node:test");
const assert = require("node:assert/strict");
const jobs = require("../export-jobs.js");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Clone on both sides of the adapter, like chrome.storage.local. The yield in
// get/set makes an un-serialized read/modify/write reliably lose concurrent
// updates, so these tests exercise the module's per-adapter queue.
function makeStorage(initial = {}, { delayed = false } = {}) {
  const store = clone(initial);
  const stats = { gets: 0, sets: 0, removes: 0 };
  const yieldTurn = () =>
    delayed ? new Promise((resolve) => setImmediate(resolve)) : Promise.resolve();
  return {
    store,
    stats,
    async get(key) {
      stats.gets += 1;
      await yieldTurn();
      if (key === null || key === undefined) return clone(store);
      return Object.hasOwn(store, key) ? { [key]: clone(store[key]) } : {};
    },
    async set(patch) {
      await yieldTurn();
      stats.sets += 1;
      Object.assign(store, clone(patch));
    },
    async remove(key) {
      await yieldTurn();
      stats.removes += 1;
      delete store[key];
    },
  };
}

function makeInput(
  mediaKey = "video-a",
  {
    scope = "current_notes",
    units = [`${mediaKey}:transcript:0`, `${mediaKey}:transcript:1`],
    sourceRevision = 1,
  } = {},
) {
  return {
    state: "planned",
    intent: {
      scope,
      mediaKeys: [mediaKey],
      mode: "bilingual",
      format: "markdown",
      autoExport: true,
    },
    sourceRevisions: { [mediaKey]: sourceRevision },
    notesRevision: "notes-r1",
    orderedUnitKeys: units,
    completedUnitKeys: [],
    currentBatch: null,
    cursor: 0,
    roundBudget: { maxBatches: 20 },
    providerSnapshot: {
      provider: "deepseek",
      model: "deepseek-chat",
      routeKey: "deepseek:deepseek-chat",
    },
    exportClaim: null,
    lastError: null,
  };
}

test("jobIdForIntent is stable for canonical intent and create freezes it", () => {
  const left = {
    scope: "all_notes",
    mediaKeys: ["video-b", "video-a", "video-a"],
    mode: "zh",
    format: "markdown",
    autoExport: true,
  };
  const right = {
    autoExport: true,
    format: "markdown",
    mode: "zh",
    mediaKeys: ["video-a", "video-b"],
    scope: "all_notes",
  };
  assert.equal(jobs.jobIdForIntent(left), jobs.jobIdForIntent(right));
  assert.match(jobs.jobIdForIntent(left), /^export-[0-9a-f]{32}$/);

  const job = jobs.createExportJob(
    {
      ...makeInput("video-a"),
      intent: left,
      sourceRevisions: { "video-a": 3, "video-b": 7 },
    },
    { now: 1000 },
  );
  assert.equal(job.schemaVersion, 1);
  assert.deepEqual(job.intent.mediaKeys, ["video-a", "video-b"]);
  assert.equal(Object.isFrozen(job), true);
  assert.equal(Object.isFrozen(job.intent), true);
  assert.equal(Object.isFrozen(job.intent.mediaKeys), true);
  assert.equal(job.updatedAt, 1000);
});

test("normalization persists only bounded coordination metadata and no secrets", () => {
  const credentialSentinel = "credential-sentinel-private-value";
  const input = makeInput();
  input.sourceText = "full original body must not be stored";
  input.translatedText = "完整译文不能进入任务";
  input.providerSnapshot["api" + "Key"] = credentialSentinel;
  input.providerSnapshot.requestBody = { text: "body" };
  input.lastError = {
    code: "PROVIDER_ERROR",
    message: `request failed: Bearer ${credentialSentinel}`,
    retryable: true,
    responseBody: "translated response body",
  };
  const job = jobs.createExportJob(input, { now: 1000 });
  const serialized = JSON.stringify(job);
  assert.equal(job.providerSnapshot.provider, "deepseek");
  assert.equal(Object.hasOwn(job.providerSnapshot, "apiKey"), false);
  assert.equal(Object.hasOwn(job, "sourceText"), false);
  assert.equal(Object.hasOwn(job, "translatedText"), false);
  assert.equal(Object.hasOwn(job.lastError, "responseBody"), false);
  assert.doesNotMatch(serialized, new RegExp(credentialSentinel));
  assert.match(job.lastError.message, /\[REDACTED\]/);

  assert.throws(
    () =>
      jobs.createExportJob(
        {
          ...makeInput(),
          roundBudget: { maxBatches: jobs.MAX_ROUND_BATCHES + 1 },
        },
        { now: 1 },
      ),
    { code: "INVALID_EXPORT_JOB" },
  );
  assert.throws(
    () =>
      jobs.createExportJob(
        {
          ...makeInput(),
          orderedUnitKeys: ["x".repeat(1100)],
        },
        { now: 1 },
      ),
    { code: "INVALID_EXPORT_JOB" },
  );
});

test("encoded long source unit keys remain valid without relaxing other tokens", () => {
  const encodedSegment = encodeURIComponent("中文段落".repeat(20));
  const unitKey = `transcript:video-a:${encodedSegment}:125:abcdef0123456789`;
  assert.ok(unitKey.length > 256);
  const job = jobs.createExportJob(
    { ...makeInput("video-a"), orderedUnitKeys: [unitKey] },
    { now: 1000 },
  );
  assert.deepEqual(job.orderedUnitKeys, [unitKey]);
  assert.equal(
    jobs.jobIdForIntent({
      scope: "bad scope with spaces",
      mediaKeys: ["video-a"],
      mode: "zh",
      format: "txt",
      autoExport: true,
    }),
    "",
  );
});

test("concurrent upserts for one storage adapter retain every job", async () => {
  const storage = makeStorage({}, { delayed: true });
  const first = jobs.createExportJob(makeInput("video-a"), { now: 1000 });
  const second = jobs.createExportJob(makeInput("video-b"), { now: 1000 });

  await Promise.all([
    jobs.upsertExportJob(storage, first, { now: 1100 }),
    jobs.upsertExportJob(storage, second, { now: 1100 }),
  ]);

  const stored = await jobs.readExportJobs(storage);
  assert.deepEqual(Object.keys(stored).sort(), [first.jobId, second.jobId].sort());
  assert.equal(storage.store[jobs.STORAGE_KEY].schemaVersion, 1);
});

test("concurrent checkpoints union progress and repeated checkpoint is idempotent", async () => {
  const storage = makeStorage({}, { delayed: true });
  const created = jobs.createExportJob(makeInput(), { now: 1000 });
  await jobs.upsertExportJob(storage, created);
  await jobs.checkpointExportJob(
    storage,
    created.jobId,
    { state: "running" },
    { now: 1100 },
  );

  await Promise.all([
    jobs.checkpointExportJob(
      storage,
      created.jobId,
      { completedUnitKeys: [created.orderedUnitKeys[0]], cursor: 1 },
      { now: 1200 },
    ),
    jobs.checkpointExportJob(
      storage,
      created.jobId,
      { completedUnitKeys: [created.orderedUnitKeys[1]], cursor: 2 },
      { now: 1200 },
    ),
  ]);

  const after = await jobs.readExportJob(storage, created.jobId);
  assert.deepEqual(after.completedUnitKeys, created.orderedUnitKeys);
  assert.equal(after.cursor, 2);
  const writesBeforeNoop = storage.stats.sets;
  const noop = await jobs.checkpointExportJob(
    storage,
    created.jobId,
    { completedUnitKeys: [created.orderedUnitKeys[0]], cursor: 1 },
    { now: 9999 },
  );
  assert.equal(noop.changed, false);
  assert.equal(storage.stats.sets, writesBeforeNoop);
  assert.equal(noop.job.updatedAt, after.updatedAt);
});

test("duplicate full-record upsert preserves an active batch lease and claim", async () => {
  const storage = makeStorage();
  const created = jobs.createExportJob(makeInput(), { now: 1000 });
  await jobs.upsertExportJob(storage, created, { now: 1000 });
  const active = await jobs.checkpointExportJob(
    storage,
    created.jobId,
    {
      state: "running",
      currentBatch: {
        batchId: "batch-active",
        unitKeys: [created.orderedUnitKeys[0]],
        leaseUntil: 9000,
      },
      exportClaim: { claimId: "claim-active", ownerId: "panel-a" },
    },
    { now: 1100 },
  );

  const duplicate = jobs.createExportJob(
    { ...makeInput(), state: "running" },
    { now: 2000 },
  );
  const result = await jobs.upsertExportJob(storage, duplicate, { now: 2000 });

  assert.equal(result.changed, false);
  assert.deepEqual(result.job.currentBatch, active.job.currentBatch);
  assert.deepEqual(result.job.exportClaim, active.job.exportClaim);
  assert.equal(result.job.state, "running");
});

test("ready/completed states require full progress and cannot retain leases", async () => {
  const base = makeInput();
  assert.throws(
    () => jobs.createExportJob({ ...base, state: "ready_to_export" }),
    { code: "INVALID_EXPORT_JOB" },
  );
  assert.throws(
    () =>
      jobs.createExportJob({
        ...base,
        state: "completed",
        completedUnitKeys: base.orderedUnitKeys,
        currentBatch: {
          batchId: "late-batch",
          unitKeys: [base.orderedUnitKeys[0]],
          leaseUntil: 9000,
        },
      }),
    { code: "INVALID_EXPORT_JOB" },
  );

  const storage = makeStorage();
  const created = jobs.createExportJob(base, { now: 1000 });
  await jobs.upsertExportJob(storage, created);
  await assert.rejects(
    () =>
      jobs.checkpointExportJob(storage, created.jobId, {
        state: "ready_to_export",
      }),
    { code: "INVALID_EXPORT_JOB_PROGRESS" },
  );

  const ready = await jobs.checkpointExportJob(storage, created.jobId, {
    state: "ready_to_export",
    completedUnitKeys: created.orderedUnitKeys,
    currentBatch: null,
    exportClaim: { claimId: "ready-claim" },
  });
  assert.equal(ready.job.currentBatch, null);
  assert.deepEqual(ready.job.exportClaim, { claimId: "ready-claim" });
  const completed = await jobs.checkpointExportJob(storage, created.jobId, {
    state: "completed",
  });
  assert.equal(completed.job.currentBatch, null);
  assert.equal(completed.job.exportClaim, null);
});

test("cancelled checkpoints clear an active lease and export claim", async () => {
  const storage = makeStorage();
  const created = jobs.createExportJob(makeInput(), { now: 1000 });
  await jobs.upsertExportJob(storage, created);
  await jobs.checkpointExportJob(storage, created.jobId, {
    state: "running",
    currentBatch: {
      batchId: "batch-active",
      unitKeys: [created.orderedUnitKeys[0]],
      leaseUntil: 9000,
    },
    exportClaim: { claimId: "claim-active" },
  });
  const cancelled = await jobs.checkpointExportJob(storage, created.jobId, {
    state: "cancelled",
  });
  assert.equal(cancelled.job.currentBatch, null);
  assert.equal(cancelled.job.exportClaim, null);
});

test("atomic export claim allows one owner and rejects a competing claim", async () => {
  const storage = makeStorage();
  const input = makeInput();
  const created = jobs.createExportJob(input, { now: 1000 });
  await jobs.upsertExportJob(storage, created);
  await jobs.checkpointExportJob(storage, created.jobId, {
    state: "paused",
    completedUnitKeys: created.orderedUnitKeys,
  });
  const first = await jobs.checkpointExportJob(
    storage,
    created.jobId,
    {
      state: "ready_to_export",
      exportClaim: { claimId: "claim-a", ownerId: "panel-a" },
    },
    { requireEmptyExportClaim: true },
  );
  assert.equal(first.job.exportClaim.claimId, "claim-a");
  await assert.rejects(
    () =>
      jobs.checkpointExportJob(
        storage,
        created.jobId,
        {
          state: "ready_to_export",
          exportClaim: { claimId: "claim-b", ownerId: "panel-b" },
        },
        { requireEmptyExportClaim: true },
      ),
    { code: "EXPORT_JOB_ALREADY_CLAIMED" },
  );
  const after = await jobs.readExportJob(storage, created.jobId);
  assert.equal(after.exportClaim.claimId, "claim-a");
});

test("future schema fails closed for reads and every mutation", async () => {
  const storage = makeStorage({
    [jobs.STORAGE_KEY]: { schemaVersion: jobs.SCHEMA_VERSION + 1, jobs: {} },
  });
  const candidate = jobs.createExportJob(makeInput(), { now: 1000 });

  for (const operation of [
    () => jobs.readExportJobs(storage),
    () => jobs.upsertExportJob(storage, candidate),
    () => jobs.removeExportJob(storage, candidate.jobId),
    () => jobs.clearExportJobs(storage),
  ]) {
    await assert.rejects(operation, {
      code: "UNSUPPORTED_EXPORT_JOBS_SCHEMA",
    });
  }
  assert.equal(storage.stats.sets, 0);
  assert.equal(storage.stats.removes, 0);
  assert.equal(
    storage.store[jobs.STORAGE_KEY].schemaVersion,
    jobs.SCHEMA_VERSION + 1,
  );
});

test("paused and cancelled jobs retain progress; late valid batch stays cancelled", async () => {
  const storage = makeStorage();
  const created = jobs.createExportJob(makeInput(), { now: 1000 });
  await jobs.upsertExportJob(storage, created);
  const [firstUnit, secondUnit] = created.orderedUnitKeys;

  await jobs.checkpointExportJob(
    storage,
    created.jobId,
    {
      state: "running",
      currentBatch: {
        batchId: "batch-1",
        unitKeys: [firstUnit],
        leaseUntil: 5000,
      },
    },
    { now: 1100 },
  );
  await jobs.checkpointExportJob(
    storage,
    created.jobId,
    {
      state: "paused",
      completedUnitKeys: [firstUnit],
      currentBatch: null,
      cursor: 1,
    },
    { now: 1200 },
  );
  let stored = await jobs.readExportJob(storage, created.jobId);
  assert.equal(stored.state, "paused");
  assert.deepEqual(stored.completedUnitKeys, [firstUnit]);

  await jobs.checkpointExportJob(
    storage,
    created.jobId,
    {
      state: "running",
      currentBatch: {
        batchId: "batch-2",
        unitKeys: [secondUnit],
        leaseUntil: 6000,
      },
    },
    { now: 1300 },
  );
  await jobs.checkpointExportJob(
    storage,
    created.jobId,
    { state: "cancelled" },
    { now: 1400 },
  );

  // The already-sent batch may still commit reusable progress, but omitting a
  // state in this late checkpoint cannot reactivate or auto-export the job.
  await jobs.checkpointExportJob(
    storage,
    created.jobId,
    {
      completedUnitKeys: [secondUnit],
      currentBatch: null,
      cursor: 2,
      exportClaim: null,
    },
    { now: 1500 },
  );
  stored = await jobs.readExportJob(storage, created.jobId);
  assert.equal(stored.state, "cancelled");
  assert.deepEqual(stored.completedUnitKeys, [firstUnit, secondUnit]);
  assert.equal(stored.cursor, 2);
  assert.equal(stored.exportClaim, null);

  await assert.rejects(
    () =>
      jobs.checkpointExportJob(
        storage,
        created.jobId,
        { state: "running" },
        { now: 1600 },
      ),
    { code: "INVALID_EXPORT_JOB_TRANSITION" },
  );
  const resumed = await jobs.checkpointExportJob(
    storage,
    created.jobId,
    { state: "running" },
    { now: 1700, allowCancelledResume: true },
  );
  assert.equal(resumed.job.state, "running");
  assert.deepEqual(resumed.job.completedUnitKeys, [firstUnit, secondUnit]);
});

test("intent, revisions, unit order, budget and provider snapshot stay frozen", async () => {
  const storage = makeStorage();
  const created = jobs.createExportJob(makeInput(), { now: 1000 });
  await jobs.upsertExportJob(storage, created);

  const changedRevision = jobs.createExportJob(
    makeInput("video-a", { sourceRevision: 2 }),
    { now: 2000 },
  );
  assert.equal(changedRevision.jobId, created.jobId);
  await assert.rejects(
    () => jobs.upsertExportJob(storage, changedRevision),
    { code: "EXPORT_JOB_FROZEN_MISMATCH" },
  );
  await assert.rejects(
    () =>
      jobs.checkpointExportJob(storage, created.jobId, {
        intent: { ...created.intent, mode: "zh" },
      }),
    { code: "EXPORT_JOB_FROZEN_MISMATCH" },
  );
  await assert.rejects(
    () =>
      jobs.checkpointExportJob(storage, created.jobId, {
        roundBudget: { maxBatches: 19 },
      }),
    { code: "EXPORT_JOB_FROZEN_MISMATCH" },
  );

  const stored = await jobs.readExportJob(storage, created.jobId);
  assert.deepEqual(stored.intent, created.intent);
  assert.deepEqual(stored.sourceRevisions, { "video-a": 1 });
  assert.deepEqual(stored.orderedUnitKeys, created.orderedUnitKeys);
  assert.deepEqual(stored.roundBudget, { maxBatches: 20 });
  assert.deepEqual(stored.providerSnapshot, created.providerSnapshot);
});

test("remove and clear are serialized, idempotent storage operations", async () => {
  const storage = makeStorage({}, { delayed: true });
  const first = jobs.createExportJob(makeInput("video-a"), { now: 1000 });
  const second = jobs.createExportJob(makeInput("video-b"), { now: 1000 });
  await Promise.all([
    jobs.upsert(storage, first),
    jobs.upsert(storage, second),
  ]);
  assert.equal((await jobs.remove(storage, first.jobId)).changed, true);
  assert.equal((await jobs.remove(storage, first.jobId)).changed, false);
  assert.deepEqual(Object.keys(await jobs.read(storage)), [second.jobId]);
  assert.equal((await jobs.clear(storage)).changed, true);
  assert.equal((await jobs.clear(storage)).changed, false);
  assert.deepEqual(await jobs.read(storage), {});
});

test("a new job prunes the oldest completed history at capacity", async () => {
  const storage = makeStorage();
  const completed = [];
  for (let index = 0; index < jobs.MAX_JOBS; index += 1) {
    const input = makeInput(`video-${index}`, {
      scope: `scope-${index}`,
      units: [`video-${index}:unit`],
      sourceRevision: index + 1,
    });
    const job = jobs.createExportJob(
      {
        ...input,
        state: "completed",
        completedUnitKeys: input.orderedUnitKeys,
      },
      { now: index + 1 },
    );
    completed.push(job);
    await jobs.upsertExportJob(storage, job, { now: index + 1 });
  }

  const newcomer = jobs.createExportJob(
    makeInput("video-new", {
      scope: "scope-new",
      units: ["video-new:unit"],
      sourceRevision: 99,
    }),
    { now: 10_000 },
  );
  await jobs.upsertExportJob(storage, newcomer, { now: 10_000 });

  const stored = await jobs.readExportJobs(storage);
  assert.equal(Object.keys(stored).length, jobs.MAX_JOBS);
  assert.equal(Object.hasOwn(stored, completed[0].jobId), false);
  assert.equal(Object.hasOwn(stored, completed[1].jobId), true);
  assert.equal(Object.hasOwn(stored, newcomer.jobId), true);
});

test("capacity fails closed when every stored job is still resumable", async () => {
  const storage = makeStorage();
  for (let index = 0; index < jobs.MAX_JOBS; index += 1) {
    const job = jobs.createExportJob(
      makeInput(`active-${index}`, {
        scope: `active-scope-${index}`,
        units: [`active-${index}:unit`],
        sourceRevision: index + 1,
      }),
      { now: index + 1 },
    );
    await jobs.upsertExportJob(storage, job, { now: index + 1 });
  }
  const blocked = jobs.createExportJob(
    makeInput("active-new", {
      scope: "active-scope-new",
      units: ["active-new:unit"],
      sourceRevision: 100,
    }),
  );
  await assert.rejects(() => jobs.upsertExportJob(storage, blocked), {
    code: "EXPORT_JOBS_STORAGE_LIMIT",
  });
  assert.equal(Object.keys(await jobs.readExportJobs(storage)).length, jobs.MAX_JOBS);
});
