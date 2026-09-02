(function attachDigestDockSidepanelEffects(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DIGESTDOCK_SIDEPANEL_EFFECTS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function normalizeIdentity(value = {}) {
    const videoId = String(value.videoId || "").trim();
    const routeKey = String(value.routeKey || "").trim();
    const generation = nonNegativeInteger(value.generation);
    const epoch = nonNegativeInteger(value.epoch);
    if (!videoId || !routeKey || generation === null || epoch === null) {
      return null;
    }
    return { videoId, routeKey, generation, epoch };
  }

  function identityKey(value) {
    const identity = normalizeIdentity(value);
    return identity
      ? JSON.stringify([
          identity.videoId,
          identity.routeKey,
          identity.generation,
          identity.epoch,
        ])
      : "";
  }

  function sameIdentity(left, right) {
    const key = identityKey(left);
    return Boolean(key) && key === identityKey(right);
  }

  function taskFlightKey(scope, identityValue) {
    const normalizedScope = String(scope || "").trim();
    const key = identityKey(identityValue);
    if (!normalizedScope || !key) {
      throw new TypeError("single-flight scope and identity are required");
    }
    return `${normalizedScope}:${key}`;
  }

  function createSingleFlight() {
    const activeByKey = new Map();

    function run(key, task) {
      const normalizedKey = String(key || "").trim();
      if (!normalizedKey) {
        return Promise.reject(new TypeError("single-flight key is required"));
      }
      if (typeof task !== "function") {
        return Promise.reject(new TypeError("single-flight task is required"));
      }
      if (activeByKey.has(normalizedKey)) {
        return activeByKey.get(normalizedKey);
      }

      let promise;
      promise = Promise.resolve()
        .then(task)
        .finally(() => {
          if (activeByKey.get(normalizedKey) === promise) {
            activeByKey.delete(normalizedKey);
          }
        });
      activeByKey.set(normalizedKey, promise);
      return promise;
    }

    return Object.freeze({
      run,
      has: (key) => activeByKey.has(String(key || "").trim()),
      activeCount: () => activeByKey.size,
    });
  }

  function createIdleFollowController(options = {}) {
    const delayMs = Number.isFinite(Number(options.delayMs))
      ? Math.max(0, Number(options.delayMs))
      : 5000;
    const setTimer = options.setTimer || globalThis.setTimeout;
    const clearTimer = options.clearTimer || globalThis.clearTimeout;
    const readPlayback = options.readPlayback;
    const shouldResume = options.shouldResume;
    const resume = options.resume;
    const onSettled =
      typeof options.onSettled === "function" ? options.onSettled : () => {};
    if (
      typeof setTimer !== "function" ||
      typeof clearTimer !== "function" ||
      typeof readPlayback !== "function" ||
      typeof shouldResume !== "function" ||
      typeof resume !== "function"
    ) {
      throw new TypeError("idle follow controller requires timer and playback callbacks");
    }

    let timer = null;
    let sequence = 0;
    let pendingSnapshot = null;

    function cancel() {
      sequence += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
      pendingSnapshot = null;
      return sequence;
    }

    function schedule(snapshot) {
      cancel();
      const token = sequence;
      pendingSnapshot = snapshot;
      timer = setTimer(() => {
        timer = null;
        const scheduledSnapshot = pendingSnapshot;
        pendingSnapshot = null;
        let playbackResult = null;
        Promise.resolve()
          .then(() => readPlayback(scheduledSnapshot, token))
          .then(async (playback) => {
            playbackResult = playback;
            if (token !== sequence) return false;
            if (!shouldResume(scheduledSnapshot, playback, token)) return false;
            await resume(scheduledSnapshot, playback, token);
            return token === sequence;
          })
          .then((resumed) => {
            if (token === sequence) {
              onSettled(scheduledSnapshot, {
                resumed: resumed === true,
                token,
                playback: playbackResult,
              });
            }
          })
          .catch((error) => {
            if (token === sequence) {
              onSettled(scheduledSnapshot, {
                resumed: false,
                token,
                playback: playbackResult,
                error,
              });
            }
          });
      }, delayMs);
      return token;
    }

    return Object.freeze({
      schedule,
      cancel,
      isPending: () => timer !== null,
      token: () => sequence,
      snapshot: () => pendingSnapshot,
    });
  }

  function createConsentTokenVault(options = {}) {
    const records = new Map();
    let sequence = 0;
    const makeToken =
      typeof options.makeToken === "function"
        ? options.makeToken
        : () => {
            sequence += 1;
            if (globalThis.crypto?.randomUUID) {
              return globalThis.crypto.randomUUID();
            }
            return `digestdock-consent-${Date.now().toString(36)}-${sequence}`;
          };

    function mint(identityValue) {
      const identity = normalizeIdentity(identityValue);
      if (!identity) throw new TypeError("valid consent identity is required");
      const id = String(makeToken(identity) || "").trim();
      if (!id || records.has(id)) {
        throw new Error("consent token factory returned an invalid token");
      }
      const token = Object.freeze({ id, identity: Object.freeze({ ...identity }) });
      records.set(id, { identityKey: identityKey(identity) });
      return token;
    }

    function consume(tokenValue, identityValue) {
      const id = String(tokenValue?.id || tokenValue || "").trim();
      const key = identityKey(identityValue);
      const record = records.get(id);
      if (!id || !key || !record || record.identityKey !== key) return false;
      records.delete(id);
      return true;
    }

    function revoke(tokenValue) {
      const id = String(tokenValue?.id || tokenValue || "").trim();
      return records.delete(id);
    }

    function revokeIdentity(identityValue) {
      const key = identityKey(identityValue);
      if (!key) return 0;
      let revoked = 0;
      for (const [id, record] of records) {
        if (record.identityKey !== key) continue;
        records.delete(id);
        revoked += 1;
      }
      return revoked;
    }

    function clear() {
      const size = records.size;
      records.clear();
      return size;
    }

    return Object.freeze({
      mint,
      consume,
      revoke,
      revokeIdentity,
      clear,
      has: (tokenValue) =>
        records.has(String(tokenValue?.id || tokenValue || "").trim()),
      size: () => records.size,
    });
  }

  function normalizeTask(value = {}) {
    const identity = normalizeIdentity(value.identity || value);
    const id = String(value.taskId || value.id || "").trim();
    const origin = String(value.origin || value.taskOrigin || "").trim();
    const scope = String(value.scope || "transcript").trim();
    if (!identity || !id || !origin || !scope) return null;
    return { id, origin, scope, identity };
  }

  function resultMatchesTask(taskValue, result = {}) {
    const task = normalizeTask(taskValue);
    const identity = normalizeIdentity(result.identity || result);
    if (!task || !identity) return false;
    return (
      task.id === String(result.taskId || result.id || "").trim() &&
      task.scope === String(result.scope || task.scope).trim() &&
      sameIdentity(task.identity, identity)
    );
  }

  function createTaskGate() {
    const activeByScope = new Map();

    function begin(taskValue) {
      const task = normalizeTask(taskValue);
      if (!task) throw new TypeError("valid task identity is required");
      const snapshot = Object.freeze({
        ...task,
        identity: Object.freeze({ ...task.identity }),
      });
      activeByScope.set(task.scope, snapshot);
      return snapshot;
    }

    function isCurrent(result = {}) {
      const scope = String(result.scope || "transcript").trim();
      return resultMatchesTask(activeByScope.get(scope), { ...result, scope });
    }

    function finish(result = {}) {
      const scope = String(result.scope || "transcript").trim();
      if (!isCurrent({ ...result, scope })) return false;
      activeByScope.delete(scope);
      return true;
    }

    function invalidateScope(scope = "transcript") {
      return activeByScope.delete(String(scope || "transcript").trim());
    }

    function invalidateIdentity(identityValue) {
      const identity = normalizeIdentity(identityValue);
      if (!identity) return 0;
      let invalidated = 0;
      for (const [scope, task] of activeByScope) {
        if (!sameIdentity(task.identity, identity)) continue;
        activeByScope.delete(scope);
        invalidated += 1;
      }
      return invalidated;
    }

    function clear() {
      const size = activeByScope.size;
      activeByScope.clear();
      return size;
    }

    return Object.freeze({
      begin,
      isCurrent,
      finish,
      invalidateScope,
      invalidateIdentity,
      clear,
      current: (scope = "transcript") =>
        activeByScope.get(String(scope || "transcript").trim()) || null,
      size: () => activeByScope.size,
    });
  }

  function consentError() {
    const error = new Error("A fresh per-attempt Supadata consent token is required.");
    error.code = "SUPADATA_CONSENT_TOKEN_REQUIRED";
    return error;
  }

  function requestIdentityError() {
    const error = new Error("Supadata request identity no longer matches the task.");
    error.code = "PAGE_CONTEXT_CHANGED";
    return error;
  }

  function requestMatchesIdentity(request, identity) {
    const requestVideoId = String(
      request?.mediaRef?.videoId || request?.videoId || "",
    ).trim();
    const requestRouteKey = String(request?.routeKey || "").trim();
    const requestGeneration =
      request?.digestGeneration ?? request?.generation ?? identity.generation;
    const requestEpoch = request?.epoch ?? identity.epoch;
    return (
      (!requestVideoId || requestVideoId === identity.videoId) &&
      (!requestRouteKey || requestRouteKey === identity.routeKey) &&
      Number(requestGeneration) === identity.generation &&
      Number(requestEpoch) === identity.epoch
    );
  }

  function createSupadataDispatcher({ send, tokenVault } = {}) {
    if (typeof send !== "function") {
      throw new TypeError("Supadata dispatcher requires an injected send function");
    }
    if (!tokenVault || typeof tokenVault.consume !== "function") {
      throw new TypeError("Supadata dispatcher requires a consent token vault");
    }

    async function dispatch({
      identity,
      token,
      request = {},
      onConsumed = null,
    } = {}) {
      const normalizedIdentity = normalizeIdentity(identity);
      if (!normalizedIdentity || !requestMatchesIdentity(request, normalizedIdentity)) {
        throw requestIdentityError();
      }
      if (!tokenVault.consume(token, normalizedIdentity)) {
        throw consentError();
      }
      if (typeof onConsumed === "function") onConsumed();

      const safeRequest = {
        ...request,
        videoId: request.videoId || normalizedIdentity.videoId,
        routeKey: normalizedIdentity.routeKey,
        digestGeneration: normalizedIdentity.generation,
        epoch: normalizedIdentity.epoch,
        supadataConsent: true,
      };
      delete safeRequest.consentToken;
      return send(safeRequest);
    }

    return Object.freeze({ dispatch });
  }

  return Object.freeze({
    normalizeIdentity,
    identityKey,
    sameIdentity,
    taskFlightKey,
    createSingleFlight,
    createIdleFollowController,
    createConsentTokenVault,
    normalizeTask,
    resultMatchesTask,
    createTaskGate,
    createSupadataDispatcher,
  });
});
