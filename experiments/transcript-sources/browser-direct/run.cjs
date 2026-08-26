#!/usr/bin/env node

/*
 * Browser-direct YouTube caption experiment.
 *
 * Safety properties:
 * - Playwright creates a new temporary browser profile for every run.
 * - No storageState, Chrome profile, cookies, credentials, or extensions are loaded.
 * - Signed caption URLs and PO token values are kept in memory only. Reports contain
 *   parameter names and token lengths, never token/signature values or transcript text.
 */

const fs = require("node:fs");
const path = require("node:path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (error) {
  console.error(
    "Playwright is not resolvable. Set NODE_PATH to a Node modules directory containing playwright."
  );
  throw error;
}

const ROOT = __dirname;
const RESULTS_DIR = path.join(ROOT, "results");
const LOGS_DIR = path.join(ROOT, "logs");
const WATCH_BASE = "https://www.youtube.com/watch?v=";
const WAIT_AFTER_DOM_MS = Number(process.env.YD_WAIT_AFTER_DOM_MS || 6000);
const WAIT_AFTER_CAPTION_ACTION_MS = Number(
  process.env.YD_WAIT_AFTER_CAPTION_ACTION_MS || 3500
);

const CASES = [
  {
    id: "manual-english-short",
    videoId: "jNQXAC9IVRw",
    desiredTrack: { languageCode: "en", kind: "manual" },
    purpose: "Short authored-English happy path",
  },
  {
    id: "duplicate-language-select-asr",
    videoId: "iG9CE55wbtY",
    desiredTrack: { languageCode: "en", kind: "asr" },
    purpose: "Explicitly select ASR when authored English also exists",
  },
  {
    id: "asr-only-long",
    videoId: "KLDVxx4TqcE",
    desiredTrack: { languageCode: "en", kind: "asr" },
    purpose: "Separate track discovery from long ASR transcript retrieval",
  },
  {
    id: "spoken-no-caption-track",
    videoId: "4OEG33NfEK0",
    desiredTrack: null,
    purpose: "Spoken-video negative boundary",
  },
  {
    id: "nonverbal-no-caption-track",
    videoId: "aqz-KE-bpKQ",
    desiredTrack: null,
    purpose: "Stable no-dialogue negative control",
  },
];

const logs = [];

function log(event, details = {}) {
  const entry = { at: new Date().toISOString(), event, ...details };
  logs.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeKind(value) {
  return value === "asr" ? "asr" : "manual";
}

function summarizeTimedtextUrl(rawUrl) {
  const url = new URL(rawUrl);
  const paramNames = [...new Set(url.searchParams.keys())].sort();
  const tokenValue = url.searchParams.get("pot") || "";
  return {
    origin: url.origin,
    pathname: url.pathname,
    videoId: url.searchParams.get("v"),
    languageCode: url.searchParams.get("lang"),
    kind: normalizeKind(url.searchParams.get("kind")),
    format: url.searchParams.get("fmt") || "default",
    client: url.searchParams.get("c"),
    hasPot: url.searchParams.has("pot"),
    potLength: tokenValue.length,
    hasPotc: url.searchParams.has("potc"),
    hasSignature: url.searchParams.has("signature") || url.searchParams.has("sig"),
    paramNames,
  };
}

function isUsableProbe(probe) {
  return Boolean(probe && probe.ok && probe.bodyBytes > 0 && probe.shape?.usable);
}

function compactProbe(probe) {
  if (!probe) return "n/a";
  if (probe.error) return `error: ${probe.error}`;
  const shape = probe.shape?.type || "unknown";
  return `${probe.status}/${probe.bodyBytes}B/${shape}${probe.shape?.usable ? "/usable" : ""}`;
}

function selectTrack(tracks, desiredTrack) {
  if (!desiredTrack) return null;
  return (
    tracks.find(
      (track) =>
        track.languageCode === desiredTrack.languageCode &&
        normalizeKind(track.kind) === desiredTrack.kind
    ) || null
  );
}

function findMatchingTimedtext(entries, videoId, desiredTrack) {
  if (!desiredTrack) return null;
  const matches = entries.filter((entry) => {
    const summary = summarizeTimedtextUrl(entry.rawUrl);
    return (
      summary.videoId === videoId &&
      summary.languageCode === desiredTrack.languageCode &&
      summary.kind === desiredTrack.kind
    );
  });
  return matches.at(-1) || null;
}

async function readPlayerSnapshot(page) {
  return page.evaluate(() => {
    const player = document.querySelector("#movie_player");
    const response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
    const tracks =
      response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return {
      documentMarker: window.__ydExperimentDocumentMarker || null,
      href: location.href,
      title: response?.videoDetails?.title || document.title,
      videoId: response?.videoDetails?.videoId || null,
      playabilityStatus: response?.playabilityStatus?.status || null,
      playabilityReason: response?.playabilityStatus?.reason || null,
      playerPresent: Boolean(player),
      captionTrackCount: tracks.length,
      tracks: tracks.map((track) => ({
        languageCode: track.languageCode || null,
        kind: track.kind === "asr" ? "asr" : "manual",
        vssId: track.vssId || null,
        name:
          track.name?.simpleText ||
          track.name?.runs?.map((run) => run.text).join("") ||
          null,
        baseUrlPresent: Boolean(track.baseUrl),
      })),
    };
  });
}

async function getRawTrack(page, desiredTrack) {
  return page.evaluate((desired) => {
    const player = document.querySelector("#movie_player");
    const response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
    const tracks =
      response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const found = tracks.find((track) => {
      const kind = track.kind === "asr" ? "asr" : "manual";
      return track.languageCode === desired.languageCode && kind === desired.kind;
    });
    if (!found) return null;
    return {
      languageCode: found.languageCode,
      kind: found.kind === "asr" ? "asr" : "manual",
      vssId: found.vssId || null,
      baseUrl: found.baseUrl,
    };
  }, desiredTrack);
}

async function readCcState(page) {
  return page.evaluate(() => {
    const player = document.querySelector("#movie_player");
    const button = document.querySelector(".ytp-subtitles-button");
    const captionContainers = [...document.querySelectorAll(".ytp-caption-window-container")];
    return {
      buttonPresent: Boolean(button),
      ariaPressed: button?.getAttribute("aria-pressed") || null,
      title: button?.getAttribute("title") || button?.getAttribute("aria-label") || null,
      subtitlesOn:
        typeof player?.isSubtitlesOn === "function" ? player.isSubtitlesOn() : null,
      visibleCaptionContainerCount: captionContainers.filter((node) => {
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      }).length,
    };
  });
}

async function selectCaptionTrackWithPlayer(page, desiredTrack) {
  return page.evaluate((desired) => {
    const player = document.querySelector("#movie_player");
    if (!player || typeof player.setOption !== "function") {
      return { attempted: false, reason: "player-setOption-unavailable" };
    }
    const summarize = (track) => {
      if (!track) return null;
      const vssId = track.vss_id || track.vssId || null;
      return {
        languageCode: track.languageCode || null,
        kind:
          track.kind === "asr" || String(vssId || "").startsWith("a.")
            ? "asr"
            : "manual",
        vssId,
        isServable: track.is_servable ?? null,
      };
    };
    try {
      const before = summarize(player.getOption?.("captions", "track"));
      player.loadModule?.("captions");
      const track = { languageCode: desired.languageCode };
      if (desired.kind === "asr") track.kind = "asr";
      if (desired.vssId) {
        track.vssId = desired.vssId;
        track.vss_id = desired.vssId;
      }
      player.setOption("captions", "track", track);
      const after = summarize(player.getOption?.("captions", "track"));
      return {
        attempted: true,
        reason: null,
        before,
        after,
        accepted:
          after?.languageCode === desired.languageCode &&
          after?.kind === desired.kind,
      };
    } catch (error) {
      return { attempted: true, reason: String(error?.message || error) };
    }
  }, desiredTrack);
}

async function clickCcButton(page) {
  const button = page.locator(".ytp-subtitles-button").first();
  if (!(await button.count())) {
    return { attempted: false, clicked: false, reason: "button-not-found" };
  }
  if (!(await button.isVisible().catch(() => false))) {
    return { attempted: false, clicked: false, reason: "button-not-visible" };
  }
  try {
    await button.click({ timeout: 5000 });
    return { attempted: true, clicked: true, reason: null };
  } catch (error) {
    return {
      attempted: true,
      clicked: false,
      reason: String(error?.message || error),
    };
  }
}

async function probeCaptionVariants(page, rawBaseUrl, capturedUrl) {
  return page.evaluate(
    async ({ baseUrl, observedUrl }) => {
      const CLIENT_PARAMS = [
        "c",
        "cver",
        "cplayer",
        "cbrand",
        "cbr",
        "cbrver",
        "cos",
        "cosver",
        "cplatform",
      ];
      const TOKEN_PARAMS = ["pot", "potc"];

      function copyParams(source, target, keys) {
        for (const key of keys) {
          if (source.searchParams.has(key)) {
            target.searchParams.set(key, source.searchParams.get(key));
          }
        }
      }

      function describeBody(text, bytes) {
        if (bytes === 0 || text.length === 0) {
          return { type: "empty", usable: false };
        }
        const trimmed = text.trimStart();
        if (trimmed.startsWith("{")) {
          try {
            const value = JSON.parse(text);
            const events = Array.isArray(value.events) ? value.events : [];
            const textSegmentCount = events.reduce(
              (total, event) =>
                total +
                (Array.isArray(event.segs)
                  ? event.segs.filter((segment) => typeof segment.utf8 === "string").length
                  : 0),
              0
            );
            return {
              type: "json3",
              usable: textSegmentCount > 0,
              eventCount: events.length,
              textSegmentCount,
              topLevelKeys: Object.keys(value).sort(),
            };
          } catch (error) {
            return {
              type: "invalid-json",
              usable: false,
              parseError: String(error?.message || error),
            };
          }
        }
        if (trimmed.startsWith("<")) {
          const textCueCount = (text.match(/<text(?:\s|>)/g) || []).length;
          const paragraphCueCount = (text.match(/<p(?:\s|>)/g) || []).length;
          return {
            type: "xml",
            usable: textCueCount + paragraphCueCount > 0,
            textCueCount,
            paragraphCueCount,
          };
        }
        return { type: "unknown", usable: false };
      }

      async function probe(name, rawUrl) {
        const startedAt = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(rawUrl, {
            cache: "no-store",
            credentials: "omit",
            redirect: "follow",
            signal: controller.signal,
          });
          const buffer = await response.arrayBuffer();
          const text = new TextDecoder().decode(buffer);
          return {
            name,
            ok: response.ok,
            status: response.status,
            redirected: response.redirected,
            contentType: response.headers.get("content-type"),
            contentLengthHeader: response.headers.get("content-length"),
            bodyBytes: buffer.byteLength,
            elapsedMs: Math.round(performance.now() - startedAt),
            shape: describeBody(text, buffer.byteLength),
          };
        } catch (error) {
          return {
            name,
            ok: false,
            status: null,
            bodyBytes: 0,
            elapsedMs: Math.round(performance.now() - startedAt),
            error: String(error?.message || error),
            shape: { type: "error", usable: false },
          };
        } finally {
          clearTimeout(timer);
        }
      }

      const base = new URL(baseUrl);
      const rawJson3 = new URL(base);
      rawJson3.searchParams.set("fmt", "json3");
      const rawSrv3 = new URL(base);
      rawSrv3.searchParams.set("fmt", "srv3");
      const variants = [
        ["raw-baseUrl-default", base],
        ["raw-baseUrl-json3", rawJson3],
        ["raw-baseUrl-srv3", rawSrv3],
      ];

      if (observedUrl) {
        const observed = new URL(observedUrl);
        const observedWithoutPot = new URL(observed);
        for (const key of TOKEN_PARAMS) observedWithoutPot.searchParams.delete(key);

        const basePlusPotOnly = new URL(rawJson3);
        copyParams(observed, basePlusPotOnly, TOKEN_PARAMS);

        const basePlusPotAndClient = new URL(rawJson3);
        copyParams(observed, basePlusPotAndClient, TOKEN_PARAMS);
        copyParams(observed, basePlusPotAndClient, CLIENT_PARAMS);

        const observedWithoutClient = new URL(observed);
        for (const key of CLIENT_PARAMS) observedWithoutClient.searchParams.delete(key);

        variants.push(
          ["captured-exact-pot-and-client", observed],
          ["captured-minus-pot", observedWithoutPot],
          ["raw-plus-pot-only-json3", basePlusPotOnly],
          ["raw-plus-pot-and-client-json3", basePlusPotAndClient],
          ["captured-minus-client-keep-pot", observedWithoutClient]
        );
      }

      return Promise.all(variants.map(([name, url]) => probe(name, url.href)));
    },
    { baseUrl: rawBaseUrl, observedUrl: capturedUrl }
  );
}

function assessPotEffect(probes, baseSummary, capturedSummary) {
  const byName = Object.fromEntries(probes.map((probe) => [probe.name, probe]));
  const raw = byName["raw-baseUrl-json3"];
  const plusPotOnly = byName["raw-plus-pot-only-json3"];
  const plusPotAndClient = byName["raw-plus-pot-and-client-json3"];
  const captured = byName["captured-exact-pot-and-client"];
  const capturedMinusPot = byName["captured-minus-pot"];

  let observedEffect = "not-testable";
  if (captured) {
    if (!isUsableProbe(raw) && isUsableProbe(plusPotOnly)) {
      observedEffect = "pot-restored-raw-url";
    } else if (!isUsableProbe(raw) && isUsableProbe(plusPotAndClient)) {
      observedEffect = "pot-and-client-restored-raw-url";
    } else if (!isUsableProbe(raw) && isUsableProbe(captured)) {
      observedEffect = "captured-request-succeeded-raw-failed";
    } else if (isUsableProbe(raw) && isUsableProbe(captured)) {
      observedEffect = "raw-and-tokenized-both-succeeded";
    } else if (!isUsableProbe(raw) && !isUsableProbe(captured)) {
      observedEffect = "tokenized-request-did-not-recover-body";
    } else {
      observedEffect = "mixed-result";
    }
  }

  return {
    baseUrlAdvertisesPot: Boolean(baseSummary?.hasPot),
    baseUrlAdvertisesClient: Boolean(baseSummary?.client),
    playerRequestInjectedPot: Boolean(capturedSummary?.hasPot && !baseSummary?.hasPot),
    playerRequestInjectedClient: Boolean(capturedSummary?.client && !baseSummary?.client),
    rawJson3Usable: isUsableProbe(raw),
    rawPlusPotOnlyUsable: isUsableProbe(plusPotOnly),
    rawPlusPotAndClientUsable: isUsableProbe(plusPotAndClient),
    capturedExactUsable: isUsableProbe(captured),
    capturedMinusPotUsable: isUsableProbe(capturedMinusPot),
    observedEffect,
  };
}

async function runCaptionCase(browser, testCase) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  const timedtextEntries = [];
  const capturePromises = [];

  await page.addInitScript(() => {
    window.__ydExperimentDocumentMarker = crypto.randomUUID();
    window.__ydExperimentNavigationEvents = [];
    for (const eventName of [
      "yt-navigate-start",
      "yt-navigate-finish",
      "yt-page-data-updated",
    ]) {
      window.addEventListener(eventName, () => {
        window.__ydExperimentNavigationEvents.push({
          eventName,
          at: performance.now(),
          href: location.href,
        });
      });
    }
  });

  page.on("response", (response) => {
    if (!response.url().includes("/api/timedtext")) return;
    const entry = {
      rawUrl: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"] || null,
      bodyBytes: null,
      bodyReadError: null,
    };
    timedtextEntries.push(entry);
    const capture = response
      .body()
      .then((body) => {
        entry.bodyBytes = body.byteLength;
      })
      .catch((error) => {
        entry.bodyReadError = String(error?.message || error);
      });
    capturePromises.push(capture);
  });

  log("case-start", { caseId: testCase.id, videoId: testCase.videoId });
  const startedAt = Date.now();
  try {
    await page.goto(`${WATCH_BASE}${testCase.videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForFunction(
      (expectedVideoId) => {
        const player = document.querySelector("#movie_player");
        const response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
        return response?.videoDetails?.videoId === expectedVideoId;
      },
      testCase.videoId,
      { timeout: 30000 }
    );
    await page.waitForTimeout(WAIT_AFTER_DOM_MS);

    const snapshot = await readPlayerSnapshot(page);
    const selectedTrack = selectTrack(snapshot.tracks, testCase.desiredTrack);
    const rawTrack = testCase.desiredTrack
      ? await getRawTrack(page, testCase.desiredTrack)
      : null;
    const ccBefore = await readCcState(page);
    const actions = [];

    await Promise.allSettled(capturePromises);
    let matching = findMatchingTimedtext(
      timedtextEntries,
      testCase.videoId,
      testCase.desiredTrack
    );
    const matchingNativeRequestPresentBeforeAction = Boolean(matching);

    if (rawTrack && !matching) {
      const playerSelection = await selectCaptionTrackWithPlayer(
        page,
        { ...testCase.desiredTrack, vssId: rawTrack.vssId }
      );
      actions.push({ type: "player-setOption-track", ...playerSelection });
      await page.waitForTimeout(WAIT_AFTER_CAPTION_ACTION_MS);
      await Promise.allSettled(capturePromises);
      matching = findMatchingTimedtext(
        timedtextEntries,
        testCase.videoId,
        testCase.desiredTrack
      );
    }

    if (rawTrack && !matching) {
      const currentCc = await readCcState(page);
      if (currentCc.subtitlesOn || currentCc.ariaPressed === "true") {
        actions.push({
          type: "cc-button-click-skipped",
          attempted: false,
          clicked: false,
          reason: "subtitles-already-on-click-would-disable",
        });
      } else {
        const click = await clickCcButton(page);
        actions.push({ type: "cc-button-click", ...click });
        await page.waitForTimeout(WAIT_AFTER_CAPTION_ACTION_MS);
        await Promise.allSettled(capturePromises);
        matching = findMatchingTimedtext(
          timedtextEntries,
          testCase.videoId,
          testCase.desiredTrack
        );
      }
    }

    const ccAfter = await readCcState(page);
    const nativeTimedtextBeforeProbes = timedtextEntries.map((entry) => ({
      ...summarizeTimedtextUrl(entry.rawUrl),
      status: entry.status,
      contentType: entry.contentType,
      bodyBytes: entry.bodyBytes,
      bodyReadError: entry.bodyReadError,
    }));
    const resourceTimingBeforeProbes = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/api/timedtext"))
        .map((entry) => ({
          name: entry.name,
          initiatorType: entry.initiatorType,
          startTimeMs: Math.round(entry.startTime),
          durationMs: Math.round(entry.duration),
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        }))
    );

    let probes = [];
    let baseUrlSummary = null;
    let capturedUrlSummary = null;
    if (rawTrack?.baseUrl) {
      baseUrlSummary = summarizeTimedtextUrl(rawTrack.baseUrl);
      if (matching) capturedUrlSummary = summarizeTimedtextUrl(matching.rawUrl);
      probes = await probeCaptionVariants(
        page,
        rawTrack.baseUrl,
        matching?.rawUrl || null
      );
    }

    const cookieNames = (await context.cookies("https://www.youtube.com"))
      .map((cookie) => cookie.name)
      .sort();
    const authCookieNames = cookieNames.filter((name) =>
      /^(SID|HSID|SSID|APISID|SAPISID|LOGIN_INFO|__Secure-[123]P?SID)/.test(name)
    );
    const potAssessment = assessPotEffect(
      probes,
      baseUrlSummary,
      capturedUrlSummary
    );

    const result = {
      id: testCase.id,
      purpose: testCase.purpose,
      videoId: testCase.videoId,
      elapsedMs: Date.now() - startedAt,
      page: {
        title: snapshot.title,
        playabilityStatus: snapshot.playabilityStatus,
        playabilityReason: snapshot.playabilityReason,
        playerPresent: snapshot.playerPresent,
      },
      authentication: {
        initialStorageStateWasEmpty: true,
        authCookieNames,
        anonymousCookieNames: cookieNames.filter(
          (name) => !authCookieNames.includes(name)
        ),
      },
      trackDiscovery: {
        captionTrackCount: snapshot.captionTrackCount,
        desiredTrack: testCase.desiredTrack,
        desiredTrackFound: Boolean(selectedTrack),
        selectedTrack,
        tracks: snapshot.tracks,
        baseUrlSummary,
      },
      captionActivation: {
        matchingNativeRequestPresentBeforeAction,
        actions,
        ccBefore,
        ccAfter,
        visibleSideEffect:
          ccBefore.ariaPressed !== ccAfter.ariaPressed ||
          ccBefore.subtitlesOn !== ccAfter.subtitlesOn ||
          ccBefore.visibleCaptionContainerCount !==
            ccAfter.visibleCaptionContainerCount,
      },
      nativeTimedtextBeforeProbes,
      nativeMatchingTimedtext: matching
        ? {
            ...capturedUrlSummary,
            status: matching.status,
            contentType: matching.contentType,
            bodyBytes: matching.bodyBytes,
            bodyReadError: matching.bodyReadError,
          }
        : null,
      resourceTimingBeforeProbes: resourceTimingBeforeProbes.map((entry) => ({
        ...entry,
        name: summarizeTimedtextUrl(entry.name),
      })),
      probes,
      potAssessment,
    };
    log("case-finish", {
      caseId: testCase.id,
      videoId: testCase.videoId,
      trackCount: snapshot.captionTrackCount,
      desiredTrackFound: Boolean(selectedTrack),
      nativeMatchingTimedtext: Boolean(matching),
      rawJson3Usable: potAssessment.rawJson3Usable,
      capturedExactUsable: potAssessment.capturedExactUsable,
      observedPotEffect: potAssessment.observedEffect,
      elapsedMs: result.elapsedMs,
    });
    return result;
  } catch (error) {
    const result = {
      id: testCase.id,
      purpose: testCase.purpose,
      videoId: testCase.videoId,
      elapsedMs: Date.now() - startedAt,
      infrastructureError: String(error?.stack || error),
    };
    log("case-error", {
      caseId: testCase.id,
      videoId: testCase.videoId,
      error: String(error?.message || error),
    });
    return result;
  } finally {
    await context.close();
  }
}

async function runSpaCase(browser) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__ydExperimentDocumentMarker = crypto.randomUUID();
    window.__ydExperimentNavigationEvents = [];
    for (const eventName of ["yt-navigate-start", "yt-navigate-finish"]) {
      window.addEventListener(eventName, () => {
        window.__ydExperimentNavigationEvents.push({
          eventName,
          at: performance.now(),
          href: location.href,
        });
      });
    }
  });

  const startVideoId = "jNQXAC9IVRw";
  log("spa-start", { videoId: startVideoId });
  try {
    await page.goto(`${WATCH_BASE}${startVideoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForFunction(
      (videoId) =>
        document.querySelector("#movie_player")?.getPlayerResponse?.()?.videoDetails
          ?.videoId === videoId,
      startVideoId,
      { timeout: 30000 }
    );
    await page.waitForTimeout(WAIT_AFTER_DOM_MS);
    const before = await readPlayerSnapshot(page);

    const candidate = await page.evaluate((currentVideoId) => {
      const anchors = [...document.querySelectorAll("a[href]")];
      for (const anchor of anchors) {
        const url = new URL(anchor.href, location.href);
        const videoId = url.searchParams.get("v");
        if (url.pathname !== "/watch") continue;
        if (!videoId || videoId === currentVideoId || url.searchParams.has("list")) continue;
        const rect = anchor.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          anchor.setAttribute("data-yd-experiment-spa-target", "true");
          return { href: anchor.href, videoId };
        }
      }
      return null;
    }, startVideoId);

    if (!candidate) {
      throw new Error("No visible related watch link was available for an SPA click");
    }

    const link = page.locator('a[data-yd-experiment-spa-target="true"]').first();
    await link.scrollIntoViewIfNeeded();
    await link.click({ timeout: 10000 });
    await page.waitForFunction(
      (expectedVideoId) => {
        const current = new URL(location.href).searchParams.get("v");
        const playerVideoId = document
          .querySelector("#movie_player")
          ?.getPlayerResponse?.()?.videoDetails?.videoId;
        return current === expectedVideoId && playerVideoId === expectedVideoId;
      },
      candidate.videoId,
      { timeout: 30000 }
    );
    await page.waitForTimeout(2500);
    const after = await readPlayerSnapshot(page);
    const navigationEvents = await page.evaluate(
      () => window.__ydExperimentNavigationEvents || []
    );
    const result = {
      startVideoId,
      destinationVideoId: candidate.videoId,
      documentMarkerBefore: before.documentMarker,
      documentMarkerAfter: after.documentMarker,
      sameDocument: before.documentMarker === after.documentMarker,
      ytNavigateStartObserved: navigationEvents.some(
        (event) => event.eventName === "yt-navigate-start"
      ),
      ytNavigateFinishObserved: navigationEvents.some(
        (event) => event.eventName === "yt-navigate-finish"
      ),
      before: {
        videoId: before.videoId,
        title: before.title,
        captionTrackCount: before.captionTrackCount,
        tracks: before.tracks,
      },
      after: {
        videoId: after.videoId,
        title: after.title,
        captionTrackCount: after.captionTrackCount,
        tracks: after.tracks,
      },
      playerResponseMatchesUrlAfterNavigation:
        after.videoId === candidate.videoId,
      stalePlayerResponseObserved: after.videoId !== candidate.videoId,
      navigationEvents: navigationEvents.map((event) => ({
        eventName: event.eventName,
        atMs: Math.round(event.at),
        videoId: new URL(event.href).searchParams.get("v"),
      })),
    };
    log("spa-finish", {
      startVideoId,
      destinationVideoId: candidate.videoId,
      sameDocument: result.sameDocument,
      playerResponseMatchesUrlAfterNavigation:
        result.playerResponseMatchesUrlAfterNavigation,
    });
    return result;
  } catch (error) {
    log("spa-error", { error: String(error?.message || error) });
    return { infrastructureError: String(error?.stack || error) };
  } finally {
    await context.close();
  }
}

function renderMarkdown(report) {
  const lines = [
    "# Browser-direct transcript source: latest observed results",
    "",
    `- Run at: \`${report.runAt}\``,
    `- Browser: ${report.environment.browser}`,
    `- Authentication: ${report.environment.authentication}`,
    `- Browser profile: ${report.environment.browserProfile}`,
    `- Transcript text and signed token values persisted: no`,
    "",
    "## Caption request matrix",
    "",
    "| Case | Tracks | Desired | Native player request | Raw json3 | Raw + pot | Raw + pot/client | Captured exact refetch | Observed effect |",
    "|---|---:|---|---|---|---|---|---|---|",
  ];

  for (const result of report.cases) {
    if (result.infrastructureError) {
      lines.push(
        `| ${result.id} | n/a | n/a | error | error | error | error | error | infrastructure error |`
      );
      continue;
    }
    const probes = Object.fromEntries(
      result.probes.map((probe) => [probe.name, probe])
    );
    const desired = result.trackDiscovery.desiredTrack
      ? `${result.trackDiscovery.desiredTrack.languageCode}/${result.trackDiscovery.desiredTrack.kind}`
      : "none expected";
    lines.push(
      `| ${result.id} | ${result.trackDiscovery.captionTrackCount} | ${desired} | ${
        result.nativeMatchingTimedtext
          ? `${result.nativeMatchingTimedtext.status}/${result.nativeMatchingTimedtext.bodyBytes ?? "?"}B/${result.nativeMatchingTimedtext.contentType || "unknown"}`
          : "n/a"
      } | ${compactProbe(
        probes["raw-baseUrl-json3"]
      )} | ${compactProbe(probes["raw-plus-pot-only-json3"])} | ${compactProbe(
        probes["raw-plus-pot-and-client-json3"]
      )} | ${compactProbe(
        probes["captured-exact-pot-and-client"]
      )} | ${result.potAssessment.observedEffect} |`
    );
  }

  lines.push("", "## Independent observations", "");
  for (const result of report.cases) {
    if (result.infrastructureError) {
      lines.push(`- **${result.id}:** infrastructure error; see JSON and log.`);
      continue;
    }
    const actionNames = result.captionActivation.actions.length
      ? result.captionActivation.actions.map((action) => action.type).join(", ")
      : "none";
    lines.push(
      `- **${result.id}:** player exposed ${result.trackDiscovery.captionTrackCount} track(s); desired track found = ${result.trackDiscovery.desiredTrackFound}; raw json3 usable = ${result.potAssessment.rawJson3Usable}; native pot/c request found = ${Boolean(
        result.nativeMatchingTimedtext
      )}; captured exact usable = ${result.potAssessment.capturedExactUsable}; activation action = ${actionNames}; visible CC-state side effect = ${result.captionActivation.visibleSideEffect}.`
    );
  }

  lines.push("", "## SPA navigation", "");
  if (report.spa.infrastructureError) {
    lines.push(`SPA check was blocked: ${report.spa.infrastructureError.split("\n")[0]}`);
  } else {
    lines.push(
      `A real click moved \`${report.spa.startVideoId}\` to \`${report.spa.destinationVideoId}\`. Same document = ${report.spa.sameDocument}; yt-navigate-start = ${report.spa.ytNavigateStartObserved}; yt-navigate-finish = ${report.spa.ytNavigateFinishObserved}; playerResponse matched the destination = ${report.spa.playerResponseMatchesUrlAfterNavigation}; stale player response observed = ${report.spa.stalePlayerResponseObserved}.`
    );
  }

  lines.push(
    "",
    "## Interpretation boundary",
    "",
    "These are current, signed-out browser observations, not a permanent YouTube API contract. A discovered `captionTracks` entry is reported separately from a non-empty, parseable transcript body. `pot` and signature values are intentionally omitted from artifacts.",
    ""
  );
  return lines.join("\n");
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  log("run-start", {
    caseCount: CASES.length,
    headless: true,
    browserChannel: "chrome",
  });

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--mute-audio"],
  });

  try {
    const caseResults = [];
    for (const testCase of CASES) {
      caseResults.push(await runCaptionCase(browser, testCase));
    }
    const spa = await runSpaCase(browser);
    const report = {
      schemaVersion: 1,
      runAt: new Date().toISOString(),
      environment: {
        browser: "system Google Chrome via Playwright, headless",
        browserProfile: "Playwright-created temporary profile",
        authentication: "signed out; empty initial storageState; auth cookie names recorded per case",
        locale: "en-US",
        timezone: "America/Los_Angeles",
        fetchCredentials: "omit",
        productionExtensionLoaded: false,
      },
      cases: caseResults,
      spa,
    };
    fs.writeFileSync(
      path.join(RESULTS_DIR, "latest.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
    fs.writeFileSync(
      path.join(RESULTS_DIR, "latest.md"),
      renderMarkdown(report)
    );
    log("run-finish", {
      resultJson: path.relative(ROOT, path.join(RESULTS_DIR, "latest.json")),
      resultMarkdown: path.relative(ROOT, path.join(RESULTS_DIR, "latest.md")),
      log: path.relative(ROOT, path.join(LOGS_DIR, "latest.ndjson")),
    });
    fs.writeFileSync(
      path.join(LOGS_DIR, "latest.ndjson"),
      `${logs.map((entry) => JSON.stringify(entry)).join("\n")}\n`
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  log("run-error", { error: String(error?.stack || error) });
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(LOGS_DIR, "latest.ndjson"),
      `${logs.map((entry) => JSON.stringify(entry)).join("\n")}\n`
    );
  } catch {
    // Preserve the original failure.
  }
  console.error(error);
  process.exitCode = 1;
});
