/**
 * Durable, resumable export-translation jobs.
 *
 * Jobs deliberately contain only coordination metadata. Source text and
 * translations remain in the notes / note-source stores, while provider
 * credentials remain in settings. This keeps a resumable job small enough to
 * checkpoint after every batch without creating another content cache.
 */
var YTD_EXPORT_JOBS = (() => {
  const STORAGE_KEY = "ytd_note_export_jobs_v1";
  const SCHEMA_VERSION = 1;

  const STATES = Object.freeze([
    "planned",
    "running",
    "paused",
    "cancelled",
    "failed",
    "ready_to_export",
    "completed",
    "stale",
  ]);
  const STATE_SET = new Set(STATES);

  // Jobs are intentionally lightweight, but a full long-video plan can still
  // contain thousands of stable unit keys. Reject oversized jobs explicitly;
  // never truncate progress or silently evict another resumable job.
  const MAX_JOBS = 32;
  const MAX_MEDIA_KEYS = 200;
  const MAX_UNIT_KEYS = 12_000;
  const MAX_BATCH_UNIT_KEYS = 4;
  const MAX_JOB_ID_LENGTH = 80;
  const MAX_SCOPE_LENGTH = 64;
  const MAX_MEDIA_KEY_LENGTH = 128;
  const MAX_UNIT_KEY_LENGTH = 1024;
  const MAX_REVISION_LENGTH = 128;
  const MAX_PROVIDER_FIELD_LENGTH = 256;
  const MAX_ERROR_CODE_LENGTH = 96;
  const MAX_ERROR_MESSAGE_LENGTH = 1000;
  const MAX_LIBRARY_BYTES = 2 * 1024 * 1024;
  const MAX_ROUND_BATCHES = 20;

  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
  const SAFE_TOKEN = /^[A-Za-z0-9._~:/@#|+\-]+$/;
  // note-sources unit keys contain encodeURIComponent(mediaKey/segmentId), so
  // valid keys can contain percent escapes and encodeURIComponent's unescaped
  // punctuation. Keep this separate from job/provider tokens.
  const SAFE_UNIT_KEY = /^[A-Za-z0-9._~:/@#|+%!'()*=,\-]+$/;
  const mutationQueues = new WeakMap();

  function exportJobsError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function byteLength(value) {
    return new TextEncoder().encode(String(value || "")).byteLength;
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
      return value;
    }
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }

  function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function normalizeToken(value, maxLength) {
    if (typeof value !== "string") return "";
    const normalized = value.normalize("NFC").trim();
    if (
      !normalized ||
      normalized.length > maxLength ||
      CONTROL_CHARACTERS.test(normalized) ||
      !SAFE_TOKEN.test(normalized)
    ) {
      return "";
    }
    return normalized;
  }

  function normalizeMediaKey(value, maxLength = MAX_MEDIA_KEY_LENGTH) {
    const normalized = normalizeToken(value, maxLength);
    return ["__proto__", "prototype", "constructor"].includes(normalized)
      ? ""
      : normalized;
  }

  function normalizeUnitKey(value, maxLength) {
    if (typeof value !== "string") return "";
    const normalized = value.normalize("NFC").trim();
    if (
      !normalized ||
      normalized.length > maxLength ||
      CONTROL_CHARACTERS.test(normalized) ||
      !SAFE_UNIT_KEY.test(normalized) ||
      /%(?![0-9A-Fa-f]{2})/.test(normalized)
    ) {
      return "";
    }
    return normalized;
  }

  function normalizeTokenArray(
    values,
    {
      maxItems,
      maxLength,
      allowEmpty = true,
      sort = false,
      normalizer = normalizeToken,
    } = {},
  ) {
    if (!Array.isArray(values) || values.length > maxItems) return null;
    const seen = new Set();
    const normalized = [];
    for (const value of values) {
      const token = normalizer(value, maxLength);
      if (!token) return null;
      if (seen.has(token)) continue;
      seen.add(token);
      normalized.push(token);
    }
    if (!allowEmpty && normalized.length === 0) return null;
    if (sort) normalized.sort();
    return normalized;
  }

  function normalizeMode(value) {
    return ["original", "zh", "bilingual"].includes(value) ? value : "";
  }

  /**
   * Canonicalizes an export intent. mediaKeys are a set for job identity, so
   * they are de-duplicated and sorted before hashing and persistence.
   */
  function normalizeExportIntent(input) {
    if (!isPlainObject(input)) return null;
    const scope = normalizeToken(input.scope, MAX_SCOPE_LENGTH);
    const mediaKeys = normalizeTokenArray(input.mediaKeys, {
      maxItems: MAX_MEDIA_KEYS,
      maxLength: MAX_MEDIA_KEY_LENGTH,
      allowEmpty: false,
      sort: true,
      normalizer: normalizeMediaKey,
    });
    const mode = normalizeMode(input.mode);
    const format = normalizeToken(input.format, 32);
    if (
      !scope ||
      !mediaKeys ||
      !mode ||
      !format ||
      typeof input.autoExport !== "boolean"
    ) {
      return null;
    }
    return deepFreeze({
      scope,
      mediaKeys,
      mode,
      format,
      autoExport: input.autoExport,
    });
  }

  // FNV-1a 64-bit is deterministic in both Chromium and Node. Two independent
  // seeds make accidental collisions vanishingly unlikely without needing an
  // async crypto API just to address a local job.
  function fnv1a64(text, seed) {
    let hash = seed;
    const bytes = new TextEncoder().encode(text);
    for (const value of bytes) {
      hash ^= BigInt(value);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, "0");
  }

  function jobIdForIntent(input) {
    const intent = normalizeExportIntent(input);
    if (!intent) return "";
    const canonical = JSON.stringify(intent);
    const left = fnv1a64(canonical, 0xcbf29ce484222325n);
    const right = fnv1a64(canonical, 0x84222325cbf29ce4n);
    return `export-${left}${right}`;
  }

  function normalizeRevision(value) {
    if (value === null || value === undefined || value === "") return null;
    if (Number.isSafeInteger(value) && value >= 0) return value;
    const token = normalizeToken(value, MAX_REVISION_LENGTH);
    return token || undefined;
  }

  function normalizeSourceRevisions(input, intent) {
    if (input === undefined || input === null) return {};
    if (!isPlainObject(input)) return null;
    const mediaKeySet = new Set(intent.mediaKeys);
    const entries = Object.entries(input);
    if (entries.length > MAX_MEDIA_KEYS) return null;
    const revisions = {};
    for (const [rawKey, rawRevision] of entries) {
      const mediaKey = normalizeMediaKey(rawKey, MAX_MEDIA_KEY_LENGTH);
      const revision = normalizeRevision(rawRevision);
      if (!mediaKey || !mediaKeySet.has(mediaKey) || revision === undefined) {
        return null;
      }
      if (revision !== null) revisions[mediaKey] = revision;
    }
    const ordered = {};
    intent.mediaKeys.forEach((mediaKey) => {
      if (Object.hasOwn(revisions, mediaKey)) {
        ordered[mediaKey] = revisions[mediaKey];
      }
    });
    return ordered;
  }

  function containsCredential(value) {
    return (
      /\bBearer\s+\S+/i.test(value) ||
      /\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/i.test(value) ||
      /(?:api[_-]?key|authorization|access[_-]?token)\s*[:=]/i.test(value)
    );
  }

  function normalizeProviderText(value, maxLength, tokenOnly = false) {
    if (typeof value !== "string") return "";
    const normalized = value.normalize("NFC").trim();
    if (
      !normalized ||
      normalized.length > maxLength ||
      CONTROL_CHARACTERS.test(normalized) ||
      containsCredential(normalized) ||
      (tokenOnly && !SAFE_TOKEN.test(normalized))
    ) {
      return "";
    }
    return normalized;
  }

  /** Allowlisted provider identity only; credentials/endpoints are discarded. */
  function normalizeProviderSnapshot(input) {
    if (input === undefined || input === null) return null;
    if (!isPlainObject(input)) return null;
    const snapshot = {};
    const tokenFields = [
      "provider",
      "providerId",
      "modelId",
      "routeKey",
      "targetLanguage",
      "translationVersion",
    ];
    tokenFields.forEach((field) => {
      const value = normalizeProviderText(
        input[field],
        MAX_PROVIDER_FIELD_LENGTH,
        true,
      );
      if (value) snapshot[field] = value;
    });
    const model = normalizeProviderText(
      input.model,
      MAX_PROVIDER_FIELD_LENGTH,
      false,
    );
    if (model) snapshot.model = model;
    const settingsRevision = normalizeRevision(input.settingsRevision);
    if (settingsRevision !== undefined && settingsRevision !== null) {
      snapshot.settingsRevision = settingsRevision;
    }
    return Object.keys(snapshot).length ? snapshot : null;
  }

  function normalizeRoundBudget(input) {
    const maxBatches = input?.maxBatches ?? MAX_ROUND_BATCHES;
    if (
      !Number.isSafeInteger(maxBatches) ||
      maxBatches < 1 ||
      maxBatches > MAX_ROUND_BATCHES
    ) {
      return null;
    }
    return { maxBatches };
  }

  function normalizeCurrentBatch(input, orderedUnitKeySet) {
    if (input === undefined || input === null) return null;
    if (!isPlainObject(input)) return undefined;
    const batchId = normalizeToken(input.batchId, 128);
    const unitKeys = normalizeTokenArray(input.unitKeys, {
      maxItems: MAX_BATCH_UNIT_KEYS,
      maxLength: MAX_UNIT_KEY_LENGTH,
      allowEmpty: false,
      normalizer: normalizeUnitKey,
    });
    const leaseUntil = input.leaseUntil ?? 0;
    if (
      !batchId ||
      !unitKeys ||
      unitKeys.some((key) => !orderedUnitKeySet.has(key)) ||
      !Number.isSafeInteger(leaseUntil) ||
      leaseUntil < 0
    ) {
      return undefined;
    }
    return { batchId, unitKeys, leaseUntil };
  }

  function normalizeExportClaim(input) {
    if (input === undefined || input === null) return null;
    if (typeof input === "string") {
      const claimId = normalizeToken(input, 128);
      return claimId ? { claimId } : undefined;
    }
    if (!isPlainObject(input)) return undefined;
    const claimId = normalizeToken(input.claimId, 128);
    if (!claimId) return undefined;
    const claim = { claimId };
    const ownerId = normalizeToken(input.ownerId, 128);
    if (ownerId) claim.ownerId = ownerId;
    for (const field of ["generation", "claimedAt", "expiresAt"]) {
      if (input[field] === undefined) continue;
      if (!Number.isSafeInteger(input[field]) || input[field] < 0) {
        return undefined;
      }
      claim[field] = input[field];
    }
    return claim;
  }

  function redactErrorMessage(value) {
    if (typeof value !== "string") return "";
    return value
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(
        /\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi,
        "[REDACTED]",
      )
      .replace(
        /((?:api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi,
        "$1[REDACTED]",
      )
      .trim()
      .slice(0, MAX_ERROR_MESSAGE_LENGTH);
  }

  function normalizeLastError(input) {
    if (input === undefined || input === null) return null;
    const raw = typeof input === "string" ? { message: input } : input;
    if (!isPlainObject(raw)) return undefined;
    const code = normalizeToken(raw.code, MAX_ERROR_CODE_LENGTH);
    const message = redactErrorMessage(raw.message);
    if (!code && !message) return undefined;
    const error = {};
    if (code) error.code = code;
    if (message) error.message = message;
    if (typeof raw.retryable === "boolean") error.retryable = raw.retryable;
    if (raw.at !== undefined) {
      if (!Number.isSafeInteger(raw.at) || raw.at < 0) return undefined;
      error.at = raw.at;
    }
    return error;
  }

  function normalizeCompletedUnitKeys(input, orderedUnitKeys) {
    const completed = normalizeTokenArray(input || [], {
      maxItems: MAX_UNIT_KEYS,
      maxLength: MAX_UNIT_KEY_LENGTH,
      normalizer: normalizeUnitKey,
    });
    if (!completed) return null;
    const completedSet = new Set(completed);
    const orderedSet = new Set(orderedUnitKeys);
    if (completed.some((key) => !orderedSet.has(key))) return null;
    // Persist progress in frozen plan order, independent of response order.
    return orderedUnitKeys.filter((key) => completedSet.has(key));
  }

  /**
   * Strict job normalization. Unknown fields are intentionally discarded, so
   * callers cannot accidentally persist request bodies, translations or keys.
   */
  function normalizeExportJob(input, { now = 0 } = {}) {
    if (!isPlainObject(input)) return null;
    if (
      input.schemaVersion !== undefined &&
      input.schemaVersion !== SCHEMA_VERSION
    ) {
      return null;
    }
    const intent = normalizeExportIntent(input.intent);
    if (!intent) return null;
    const expectedJobId = jobIdForIntent(intent);
    const suppliedJobId = input.jobId
      ? normalizeToken(input.jobId, MAX_JOB_ID_LENGTH)
      : expectedJobId;
    if (!suppliedJobId || suppliedJobId !== expectedJobId) return null;

    const state = input.state ?? "planned";
    if (!STATE_SET.has(state)) return null;
    const sourceRevisions = normalizeSourceRevisions(
      input.sourceRevisions,
      intent,
    );
    const notesRevision = normalizeRevision(input.notesRevision);
    const orderedUnitKeys = normalizeTokenArray(input.orderedUnitKeys || [], {
      maxItems: MAX_UNIT_KEYS,
      maxLength: MAX_UNIT_KEY_LENGTH,
      normalizer: normalizeUnitKey,
    });
    if (
      !sourceRevisions ||
      notesRevision === undefined ||
      !orderedUnitKeys
    ) {
      return null;
    }
    const completedUnitKeys = normalizeCompletedUnitKeys(
      input.completedUnitKeys,
      orderedUnitKeys,
    );
    if (!completedUnitKeys) return null;
    const orderedUnitKeySet = new Set(orderedUnitKeys);
    const currentBatch = normalizeCurrentBatch(
      input.currentBatch,
      orderedUnitKeySet,
    );
    const roundBudget = normalizeRoundBudget(input.roundBudget);
    const providerSnapshot = normalizeProviderSnapshot(input.providerSnapshot);
    const exportClaim = normalizeExportClaim(input.exportClaim);
    const lastError = normalizeLastError(input.lastError);
    const cursor = input.cursor ?? 0;
    const requestedUpdatedAt = input.updatedAt ?? now;
    if (
      currentBatch === undefined ||
      !roundBudget ||
      exportClaim === undefined ||
      lastError === undefined ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > orderedUnitKeys.length ||
      !Number.isSafeInteger(requestedUpdatedAt) ||
      requestedUpdatedAt < 0
    ) {
      return null;
    }
    const allUnitsComplete = completedUnitKeys.length === orderedUnitKeys.length;
    if (["ready_to_export", "completed"].includes(state) && !allUnitsComplete) {
      return null;
    }
    if (
      (["cancelled", "failed", "stale", "completed"].includes(state) &&
        (currentBatch !== null || exportClaim !== null)) ||
      (state === "ready_to_export" && currentBatch !== null)
    ) {
      return null;
    }
    const normalized = {
      schemaVersion: SCHEMA_VERSION,
      jobId: suppliedJobId,
      state,
      intent,
      sourceRevisions,
      notesRevision,
      orderedUnitKeys,
      completedUnitKeys,
      currentBatch,
      cursor,
      roundBudget,
      providerSnapshot,
      exportClaim,
      lastError,
      updatedAt: requestedUpdatedAt,
    };
    if (byteLength(JSON.stringify(normalized)) > MAX_LIBRARY_BYTES) return null;
    return deepFreeze(normalized);
  }

  function createExportJob(input, { now = Date.now() } = {}) {
    const normalized = normalizeExportJob(
      { ...input, jobId: jobIdForIntent(input?.intent), updatedAt: now },
      { now },
    );
    if (!normalized) {
      throw exportJobsError(
        "INVALID_EXPORT_JOB",
        "Export job is invalid or exceeds a persisted-job boundary.",
      );
    }
    return normalized;
  }

  function emptyLibrary() {
    return { schemaVersion: SCHEMA_VERSION, jobs: {} };
  }

  function validateStorage(storage) {
    if (
      !storage ||
      typeof storage !== "object" ||
      typeof storage.get !== "function" ||
      typeof storage.set !== "function"
    ) {
      throw exportJobsError(
        "INVALID_EXPORT_JOBS_STORAGE",
        "Export jobs require a chrome.storage.local-shaped adapter.",
      );
    }
  }

  function decodeLibrary(raw) {
    if (raw === undefined || raw === null) return emptyLibrary();
    if (!isPlainObject(raw)) {
      throw exportJobsError(
        "INVALID_EXPORT_JOBS_STORAGE",
        "Stored export jobs are malformed.",
      );
    }
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      const code =
        Number.isSafeInteger(raw.schemaVersion) &&
        raw.schemaVersion > SCHEMA_VERSION
          ? "UNSUPPORTED_EXPORT_JOBS_SCHEMA"
          : "INVALID_EXPORT_JOBS_SCHEMA";
      throw exportJobsError(
        code,
        `Unsupported export-jobs schema: ${String(raw.schemaVersion)}.`,
      );
    }
    if (!isPlainObject(raw.jobs)) {
      throw exportJobsError(
        "INVALID_EXPORT_JOBS_STORAGE",
        "Stored export jobs map is malformed.",
      );
    }
    const entries = Object.entries(raw.jobs);
    if (entries.length > MAX_JOBS) {
      throw exportJobsError(
        "EXPORT_JOBS_STORAGE_LIMIT",
        "Stored export jobs exceed the job-count boundary.",
      );
    }
    let serialized;
    try {
      serialized = JSON.stringify(raw);
    } catch {
      serialized = "";
    }
    if (!serialized || byteLength(serialized) > MAX_LIBRARY_BYTES) {
      throw exportJobsError(
        "EXPORT_JOBS_STORAGE_LIMIT",
        "Stored export jobs exceed the storage boundary.",
      );
    }
    const jobs = {};
    for (const [storedJobId, rawJob] of entries) {
      const job = normalizeExportJob(rawJob);
      if (!job || job.jobId !== storedJobId) {
        throw exportJobsError(
          "INVALID_EXPORT_JOB",
          "A stored export job is malformed.",
        );
      }
      jobs[job.jobId] = job;
    }
    return { schemaVersion: SCHEMA_VERSION, jobs };
  }

  async function readLibrary(storage) {
    validateStorage(storage);
    const stored = await storage.get(STORAGE_KEY);
    return decodeLibrary(stored?.[STORAGE_KEY]);
  }

  async function writeLibrary(storage, jobs) {
    const library = { schemaVersion: SCHEMA_VERSION, jobs };
    const serialized = JSON.stringify(library);
    if (
      Object.keys(jobs).length > MAX_JOBS ||
      byteLength(serialized) > MAX_LIBRARY_BYTES
    ) {
      throw exportJobsError(
        "EXPORT_JOBS_STORAGE_LIMIT",
        "Export jobs exceed the storage boundary.",
      );
    }
    await storage.set({ [STORAGE_KEY]: library });
  }

  function makeRoomForNewJob(jobs, candidate) {
    const retained = { ...jobs };
    const evictable = Object.values(retained)
      .filter((job) => ["completed", "stale"].includes(job.state))
      .sort(
        (left, right) =>
          left.updatedAt - right.updatedAt ||
          left.jobId.localeCompare(right.jobId),
      );
    const fits = () => {
      const next = { ...retained, [candidate.jobId]: candidate };
      return (
        Object.keys(next).length <= MAX_JOBS &&
        byteLength(JSON.stringify({ schemaVersion: SCHEMA_VERSION, jobs: next })) <=
          MAX_LIBRARY_BYTES
      );
    };
    while (!fits() && evictable.length) {
      delete retained[evictable.shift().jobId];
    }
    if (!fits()) {
      throw exportJobsError(
        "EXPORT_JOBS_STORAGE_LIMIT",
        "Export jobs are full and contain no completed history that can be pruned safely.",
      );
    }
    return retained;
  }

  function enqueueMutation(storage, operation) {
    validateStorage(storage);
    const previous = mutationQueues.get(storage) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    mutationQueues.set(storage, current);
    return current.finally(() => {
      if (mutationQueues.get(storage) === current) {
        mutationQueues.delete(storage);
      }
    });
  }

  async function waitForMutations(storage) {
    validateStorage(storage);
    const pending = mutationQueues.get(storage);
    if (pending) await pending;
  }

  async function readExportJobs(storage) {
    await waitForMutations(storage);
    const library = await readLibrary(storage);
    return deepFreeze({ ...library.jobs });
  }

  async function readExportJob(storage, jobId) {
    const normalizedJobId = normalizeToken(jobId, MAX_JOB_ID_LENGTH);
    if (!normalizedJobId) return null;
    const jobs = await readExportJobs(storage);
    return jobs[normalizedJobId] || null;
  }

  const FROZEN_FIELDS = [
    "intent",
    "sourceRevisions",
    "notesRevision",
    "orderedUnitKeys",
    "roundBudget",
    "providerSnapshot",
  ];

  function assertFrozenFieldsMatch(existing, candidate) {
    for (const field of FROZEN_FIELDS) {
      if (!sameValue(existing[field], candidate[field])) {
        throw exportJobsError(
          "EXPORT_JOB_FROZEN_MISMATCH",
          `Export job field ${field} is frozen for this intent.`,
        );
      }
    }
  }

  const STATE_TRANSITIONS = {
    planned: new Set([
      "planned",
      "running",
      "paused",
      "cancelled",
      "failed",
      "ready_to_export",
      "stale",
    ]),
    running: new Set([
      "running",
      "paused",
      "cancelled",
      "failed",
      "ready_to_export",
      "stale",
    ]),
    paused: new Set([
      "paused",
      "running",
      "cancelled",
      "failed",
      "ready_to_export",
      "stale",
    ]),
    cancelled: new Set(["cancelled", "stale"]),
    failed: new Set([
      "failed",
      "running",
      "paused",
      "cancelled",
      "ready_to_export",
      "stale",
    ]),
    ready_to_export: new Set([
      "ready_to_export",
      "completed",
      "failed",
      "stale",
    ]),
    completed: new Set(["completed", "stale"]),
    stale: new Set(["stale"]),
  };

  function resolveTimestamp(now, previous) {
    const candidate = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
    if (candidate > previous) return candidate;
    return previous < Number.MAX_SAFE_INTEGER ? previous + 1 : previous;
  }

  function normalizeFrozenPatch(existing, patch) {
    if (Object.hasOwn(patch, "jobId") && patch.jobId !== existing.jobId) {
      throw exportJobsError(
        "EXPORT_JOB_FROZEN_MISMATCH",
        "Export job id is frozen.",
      );
    }
    if (
      Object.hasOwn(patch, "schemaVersion") &&
      patch.schemaVersion !== SCHEMA_VERSION
    ) {
      throw exportJobsError(
        "EXPORT_JOB_FROZEN_MISMATCH",
        "Export job schema is frozen.",
      );
    }
    const normalizers = {
      intent: () => normalizeExportIntent(patch.intent),
      sourceRevisions: () =>
        normalizeSourceRevisions(patch.sourceRevisions, existing.intent),
      notesRevision: () => normalizeRevision(patch.notesRevision),
      orderedUnitKeys: () =>
        normalizeTokenArray(patch.orderedUnitKeys, {
          maxItems: MAX_UNIT_KEYS,
          maxLength: MAX_UNIT_KEY_LENGTH,
          normalizer: normalizeUnitKey,
        }),
      roundBudget: () => normalizeRoundBudget(patch.roundBudget),
      providerSnapshot: () =>
        normalizeProviderSnapshot(patch.providerSnapshot),
    };
    for (const field of FROZEN_FIELDS) {
      if (!Object.hasOwn(patch, field)) continue;
      const value = normalizers[field]();
      if (!sameValue(value, existing[field])) {
        throw exportJobsError(
          "EXPORT_JOB_FROZEN_MISMATCH",
          `Export job field ${field} is frozen.`,
        );
      }
    }
  }

  function mergeCheckpoint(
    existing,
    patch,
    { now = Date.now(), allowCancelledResume = false } = {},
  ) {
    if (!isPlainObject(patch)) {
      throw exportJobsError("INVALID_EXPORT_JOB_PATCH", "Invalid job patch.");
    }
    normalizeFrozenPatch(existing, patch);
    let state = existing.state;
    if (Object.hasOwn(patch, "state")) {
      if (!STATE_SET.has(patch.state)) {
        throw exportJobsError(
          "INVALID_EXPORT_JOB_STATE",
          "Invalid export job state.",
        );
      }
      const resumingCancelled =
        existing.state === "cancelled" &&
        allowCancelledResume &&
        ["planned", "running", "paused"].includes(patch.state);
      if (!resumingCancelled && !STATE_TRANSITIONS[existing.state].has(patch.state)) {
        throw exportJobsError(
          "INVALID_EXPORT_JOB_TRANSITION",
          `Cannot transition export job from ${existing.state} to ${patch.state}.`,
        );
      }
      state = patch.state;
    }

    let completedUnitKeys = existing.completedUnitKeys;
    if (Object.hasOwn(patch, "completedUnitKeys")) {
      const incoming = normalizeCompletedUnitKeys(
        patch.completedUnitKeys,
        existing.orderedUnitKeys,
      );
      if (!incoming) {
        throw exportJobsError(
          "INVALID_EXPORT_JOB_PROGRESS",
          "Completed unit keys do not belong to this export job.",
        );
      }
      const completedSet = new Set([
        ...existing.completedUnitKeys,
        ...incoming,
      ]);
      completedUnitKeys = existing.orderedUnitKeys.filter((key) =>
        completedSet.has(key),
      );
    }

    let cursor = existing.cursor;
    if (Object.hasOwn(patch, "cursor")) {
      if (
        !Number.isSafeInteger(patch.cursor) ||
        patch.cursor < 0 ||
        patch.cursor > existing.orderedUnitKeys.length
      ) {
        throw exportJobsError(
          "INVALID_EXPORT_JOB_PROGRESS",
          "Export job cursor is out of bounds.",
        );
      }
      cursor = Math.max(cursor, patch.cursor);
    }

    let currentBatch = existing.currentBatch;
    if (Object.hasOwn(patch, "currentBatch")) {
      const normalized = normalizeCurrentBatch(
        patch.currentBatch,
        new Set(existing.orderedUnitKeys),
      );
      if (normalized === undefined) {
        throw exportJobsError(
          "INVALID_EXPORT_JOB_BATCH",
          "Current batch is invalid for this export job.",
        );
      }
      if (
        existing.state === "cancelled" &&
        normalized &&
        normalized.batchId !== existing.currentBatch?.batchId
      ) {
        throw exportJobsError(
          "INVALID_EXPORT_JOB_TRANSITION",
          "A cancelled export job cannot start another batch.",
        );
      }
      currentBatch = normalized;
    }

    let exportClaim = existing.exportClaim;
    if (Object.hasOwn(patch, "exportClaim")) {
      const normalized = normalizeExportClaim(patch.exportClaim);
      if (normalized === undefined) {
        throw exportJobsError(
          "INVALID_EXPORT_JOB_CLAIM",
          "Export claim is invalid.",
        );
      }
      if (
        normalized &&
        existing.exportClaim &&
        normalized.claimId !== existing.exportClaim.claimId
      ) {
        throw exportJobsError(
          "EXPORT_JOB_ALREADY_CLAIMED",
          "This export job is already claimed.",
        );
      }
      exportClaim = normalized;
    }

    let lastError = existing.lastError;
    if (Object.hasOwn(patch, "lastError")) {
      const normalized = normalizeLastError(patch.lastError);
      if (normalized === undefined) {
        throw exportJobsError(
          "INVALID_EXPORT_JOB_ERROR",
          "Export job error metadata is invalid.",
        );
      }
      lastError = normalized;
    }

    if (
      ["ready_to_export", "completed"].includes(state) &&
      completedUnitKeys.length !== existing.orderedUnitKeys.length
    ) {
      throw exportJobsError(
        "INVALID_EXPORT_JOB_PROGRESS",
        "An export job cannot become ready before every frozen unit is complete.",
      );
    }

    // Stopped/terminal states cannot retain a batch lease. Completed and
    // failed/cancelled/stale jobs cannot retain an auto-export ownership claim.
    if (["cancelled", "failed", "stale", "completed"].includes(state)) {
      exportClaim = null;
    }
    if (
      ["ready_to_export", "completed", "cancelled", "failed", "stale"].includes(
        state,
      )
    ) {
      currentBatch = null;
    }

    const candidate = {
      ...existing,
      state,
      completedUnitKeys,
      currentBatch,
      cursor,
      exportClaim,
      lastError,
    };
    const comparableExisting = { ...existing, updatedAt: 0 };
    const comparableCandidate = { ...candidate, updatedAt: 0 };
    if (sameValue(comparableExisting, comparableCandidate)) {
      return { changed: false, job: existing };
    }
    const job = normalizeExportJob({
      ...candidate,
      updatedAt: resolveTimestamp(now, existing.updatedAt),
    });
    if (!job) {
      throw exportJobsError(
        "INVALID_EXPORT_JOB_PATCH",
        "Checkpoint would make the export job invalid.",
      );
    }
    return { changed: true, job };
  }

  async function upsertExportJob(storage, input, { now = Date.now() } = {}) {
    const candidate = normalizeExportJob(input, { now });
    if (!candidate) {
      throw exportJobsError("INVALID_EXPORT_JOB", "Invalid export job.");
    }
    return enqueueMutation(storage, async () => {
      const library = await readLibrary(storage);
      const existing = library.jobs[candidate.jobId];
      let result;
      let retainedJobs = library.jobs;
      if (!existing) {
        retainedJobs = makeRoomForNewJob(library.jobs, candidate);
        result = { changed: true, job: candidate };
      } else {
        assertFrozenFieldsMatch(existing, candidate);
        // A full-record upsert is only an idempotent create/progress merge.
        // Runtime ownership fields are mutable exclusively through an explicit
        // checkpoint. Otherwise a duplicate create/resume from another panel
        // can erase an active batch lease simply because its candidate has a
        // newer timestamp.
        result = mergeCheckpoint(
          existing,
          {
            completedUnitKeys: candidate.completedUnitKeys,
            cursor: candidate.cursor,
          },
          { now },
        );
      }
      if (!result.changed) return result;
      const jobs = { ...retainedJobs, [candidate.jobId]: result.job };
      await writeLibrary(storage, jobs);
      return result;
    });
  }

  async function checkpointExportJob(
    storage,
    jobId,
    patch,
    options = {},
  ) {
    const normalizedJobId = normalizeToken(jobId, MAX_JOB_ID_LENGTH);
    if (!normalizedJobId) {
      throw exportJobsError("INVALID_EXPORT_JOB", "Invalid export job id.");
    }
    return enqueueMutation(storage, async () => {
      const library = await readLibrary(storage);
      const existing = library.jobs[normalizedJobId];
      if (!existing) {
        throw exportJobsError("EXPORT_JOB_NOT_FOUND", "Export job not found.");
      }
      if (options.requireEmptyExportClaim === true) {
        const requestedClaim = normalizeExportClaim(patch?.exportClaim);
        if (!requestedClaim) {
          throw exportJobsError(
            "INVALID_EXPORT_JOB_CLAIM",
            "An atomic export claim requires a valid claim.",
          );
        }
        if (
          existing.exportClaim &&
          existing.exportClaim.claimId !== requestedClaim.claimId
        ) {
          throw exportJobsError(
            "EXPORT_JOB_ALREADY_CLAIMED",
            "Another export owner already holds this job claim.",
          );
        }
      }
      const result = mergeCheckpoint(existing, patch, options);
      if (!result.changed) return result;
      const jobs = { ...library.jobs, [normalizedJobId]: result.job };
      await writeLibrary(storage, jobs);
      return result;
    });
  }

  async function removeExportJob(storage, jobId) {
    const normalizedJobId = normalizeToken(jobId, MAX_JOB_ID_LENGTH);
    if (!normalizedJobId) return { changed: false };
    return enqueueMutation(storage, async () => {
      const library = await readLibrary(storage);
      if (!library.jobs[normalizedJobId]) return { changed: false };
      const jobs = { ...library.jobs };
      delete jobs[normalizedJobId];
      await writeLibrary(storage, jobs);
      return { changed: true };
    });
  }

  async function clearExportJobs(storage) {
    return enqueueMutation(storage, async () => {
      validateStorage(storage);
      const stored = await storage.get(STORAGE_KEY);
      if (!Object.hasOwn(stored || {}, STORAGE_KEY)) return { changed: false };
      // Decode first so current code never erases an unknown future schema.
      decodeLibrary(stored[STORAGE_KEY]);
      if (typeof storage.remove === "function") {
        await storage.remove(STORAGE_KEY);
      } else {
        await storage.set({ [STORAGE_KEY]: emptyLibrary() });
      }
      return { changed: true };
    });
  }

  async function preflightExportJobs(storage) {
    return enqueueMutation(storage, async () => {
      await readLibrary(storage);
      return { valid: true };
    });
  }

  async function read(storage, jobId) {
    return jobId === undefined
      ? readExportJobs(storage)
      : readExportJob(storage, jobId);
  }

  return {
    STORAGE_KEY,
    SCHEMA_VERSION,
    STATES,
    MAX_JOBS,
    MAX_MEDIA_KEYS,
    MAX_UNIT_KEYS,
    MAX_LIBRARY_BYTES,
    MAX_ROUND_BATCHES,
    normalizeExportIntent,
    jobIdForIntent,
    normalizeExportJob,
    createExportJob,
    readExportJobs,
    readExportJob,
    preflightExportJobs,
    upsertExportJob,
    checkpointExportJob,
    removeExportJob,
    clearExportJobs,
    read,
    upsert: upsertExportJob,
    checkpoint: checkpointExportJob,
    remove: removeExportJob,
    clear: clearExportJobs,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_EXPORT_JOBS;
}
