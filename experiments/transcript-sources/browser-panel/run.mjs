import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT_JSON = path.join(HERE, "results", "latest.json");
const OUT_MD = path.join(HERE, "results", "latest.md");
const TIMEOUT = 20_000;

const fixtures = [
  { id: "jNQXAC9IVRw", label: "short_manual", expected: "short video with manual captions" },
  { id: "iG9CE55wbtY", label: "manual_multilingual", expected: "long TED talk with manual, ASR, and many languages" },
  { id: "KLDVxx4TqcE", label: "long_auto_only", expected: "72-minute talk with one en/asr track" },
  { id: "4OEG33NfEK0", label: "spoken_no_captions", expected: "spoken video with zero caption tracks" },
];

const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
const compact = (value) => normalize(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const sha = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex");

function summarizeTranscriptResponse(body) {
  const found = [];
  const errors = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "error" && value && typeof value === "object") {
        errors.push({ code: value.code || null, status: value.status || null, message: normalize(value.message).slice(0, 300) });
      }
      if (/transcriptSegment(Renderer|ViewModel)$/i.test(key) && value && typeof value === "object") {
        found.push({
          key,
          text: normalize(value.snippet?.runs?.map((r) => r.text).join("") || value.cue?.simpleText || value.text?.content),
          startMs: value.startMs || value.startTimeMs || null,
        });
      }
      walk(value);
    }
  };
  walk(body);
  const cueSummary = (cue) => cue ? {
    key: cue.key,
    startMs: cue.startMs,
    textCharacters: cue.text.length,
    textSha256: sha(cue.text),
  } : null;
  return { parsedSegmentObjects: found.length, first: cueSummary(found[0]), last: cueSummary(found.at(-1)), errors };
}

async function pageState(page) {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    const visible = (el) => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
    return {
      url: location.href,
      title: document.title,
      scrollY: Math.round(scrollY),
      paused: video ? video.paused : null,
      currentTime: video ? Number(video.currentTime.toFixed(2)) : null,
      visibleEngagementPanels: [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")]
        .filter(visible)
        .map((el) => el.getAttribute("target-id") || el.id || "unknown"),
      descriptionExpanded: document.querySelector("ytd-text-inline-expander")?.hasAttribute("is-expanded") || false,
    };
  });
}

async function playerMetadata(page) {
  return page.evaluate(() => {
    const response = document.querySelector("#movie_player")?.getPlayerResponse?.() || window.ytInitialPlayerResponse || null;
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const getText = (name) => name?.simpleText || name?.runs?.map((r) => r.text).join("") || "";
    return {
      videoId: response?.videoDetails?.videoId || null,
      durationSeconds: Number(response?.videoDetails?.lengthSeconds || 0),
      captionTrackCount: tracks.length,
      tracks: tracks.map((track) => ({
        languageCode: track.languageCode || null,
        name: getText(track.name),
        kind: track.kind || "manual",
        isTranslatable: Boolean(track.isTranslatable),
      })),
    };
  });
}

async function detectBlock(page) {
  const url = page.url();
  const text = normalize(await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""));
  if (/consent\.youtube\.com/i.test(url) || /before you continue to youtube/i.test(text)) return "consent";
  if (/unusual traffic|confirm you.re not a bot|automated queries/i.test(text)) return "anti_automation";
  if (/not available in your country|video unavailable/i.test(text)) return "video_unavailable";
  return null;
}

async function tryClick(locator, method) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 5); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 5_000 });
      return method;
    }
  }
  return null;
}

async function openTranscriptPanel(page) {
  const attempts = [];
  const direct = [
    ["description-structural", page.locator("ytd-video-description-transcript-section-renderer button")],
    ["aria-label-en", page.locator('button[aria-label*="transcript" i]')],
    ["role-en", page.getByRole("button", { name: /show transcript/i })],
  ];

  for (const [method, locator] of direct) {
    attempts.push(method);
    const clicked = await tryClick(locator, method);
    if (clicked) return { clicked, attempts };
  }

  for (const expander of [
    page.locator("ytd-watch-metadata #description-inline-expander"),
    page.locator("ytd-watch-metadata tp-yt-paper-button#expand"),
    page.getByRole("button", { name: /more/i }),
  ]) {
    if (await tryClick(expander, "expand-description")) break;
  }

  await page.waitForTimeout(400);
  for (const [method, locator] of direct) {
    attempts.push(`after-expand:${method}`);
    const clicked = await tryClick(locator, `after-expand:${method}`);
    if (clicked) return { clicked, attempts };
  }

  const menuButtons = page.locator("ytd-watch-metadata ytd-menu-renderer button");
  const count = await menuButtons.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const button = menuButtons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    attempts.push(`overflow:${index}`);
    await button.click({ timeout: 5_000 }).catch(() => {});
    const item = page.getByText(/show transcript/i, { exact: false });
    const clicked = await tryClick(item, `overflow:${index}:text-en`);
    if (clicked) return { clicked, attempts };
    await page.keyboard.press("Escape").catch(() => {});
  }
  return { clicked: null, attempts };
}

async function readSegments(panel) {
  return panel.locator("ytd-transcript-segment-renderer, transcript-segment-view-model, .transcript-segment-view-model").evaluateAll((nodes) => nodes.map((node) => ({
    timestamp: (node.querySelector(".segment-timestamp, [class*='timestamp']")?.innerText || node.innerText.match(/^\s*\d+:\d{2}/)?.[0] || "").replace(/\s+/g, " ").trim(),
    text: (node.querySelector(".segment-text, yt-formatted-string.segment-text, [class*='segment-text']")?.innerText || node.innerText || "").replace(/\s+/g, " ").trim(),
  })));
}

async function inspectPanel(page) {
  const expandedPanels = page.locator('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]');
  const modernWithSegments = expandedPanels.filter({ has: page.locator("transcript-segment-view-model, ytd-transcript-segment-renderer") }).first();
  const panel = (await modernWithSegments.count()) > 0
    ? modernWithSegments
    : expandedPanels.filter({ hasText: /Transcript/i }).first();
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  const segmentLocator = panel.locator("ytd-transcript-segment-renderer, transcript-segment-view-model, .transcript-segment-view-model");
  await segmentLocator.first().waitFor({ state: "attached", timeout: 8_000 }).catch(() => {});

  const before = await readSegments(panel);
  const rawControls = await panel.locator('button, [role="button"], [aria-haspopup]').evaluateAll((nodes) => nodes.slice(0, 80).map((node) => ({
    tag: node.tagName.toLowerCase(),
    text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
    ariaLabel: node.getAttribute("aria-label"),
    ariaHaspopup: node.getAttribute("aria-haspopup"),
  })));
  const controls = rawControls.map((item) => ({
    ...item,
    text: item.tag === "button" ? item.text : null,
    textCharacters: item.text.length,
    textSha256: sha(item.text),
  }));

  let ariaSnapshot = "";
  try { ariaSnapshot = await panel.ariaSnapshot({ timeout: 8_000 }); } catch {}

  const scroll = await panel.evaluate((root) => {
    const segment = root.querySelector("ytd-transcript-segment-renderer, transcript-segment-view-model, .transcript-segment-view-model");
    let node = segment;
    while (node && node !== root.parentElement) {
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 4 && /(auto|scroll)/.test(style.overflowY)) {
        return { found: true, selectorHint: node.id || node.className || node.tagName, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight };
      }
      node = node.parentElement;
    }
    return { found: false, selectorHint: null, clientHeight: 0, scrollHeight: 0 };
  });

  const scrollSamples = [];
  if (scroll.found) {
    for (let step = 0; step <= 8; step += 1) {
      const sample = await panel.evaluate((root, ratio) => {
        const segment = root.querySelector("ytd-transcript-segment-renderer, transcript-segment-view-model, .transcript-segment-view-model");
        let node = segment;
        while (node && node !== root.parentElement) {
          const style = getComputedStyle(node);
          if (node.scrollHeight > node.clientHeight + 4 && /(auto|scroll)/.test(style.overflowY)) {
            node.scrollTop = (node.scrollHeight - node.clientHeight) * ratio;
            return { scrollTop: Math.round(node.scrollTop), scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
          }
          node = node.parentElement;
        }
        return null;
      }, step / 8);
      await page.waitForTimeout(120);
      scrollSamples.push({ ...sample, domCount: await segmentLocator.count() });
    }
  }
  const after = await readSegments(panel);

  let languageMenu = { attempted: false, opened: false, optionTexts: [] };
  const languageCandidate = panel.locator('[aria-haspopup="menu"], [aria-haspopup="listbox"], button').filter({ hasText: /English|中文|Chinese|日本語|Japanese/i }).first();
  if (await languageCandidate.isVisible().catch(() => false)) {
    languageMenu.attempted = true;
    await languageCandidate.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const options = page.locator('[role="menuitem"], [role="option"], tp-yt-paper-item');
    languageMenu.optionTexts = (await options.allInnerTexts().catch(() => [])).map(normalize).filter(Boolean).slice(0, 100);
    languageMenu.opened = languageMenu.optionTexts.length > 0;
    await page.keyboard.press("Escape").catch(() => {});
  }

  const signature = (segments) => sha(segments.map((s) => `${s.timestamp}|${s.text}`).join("\n"));
  const segmentSummary = (segment) => segment ? {
    timestamp: segment.timestamp,
    textCharacters: segment.text.length,
    textSha256: sha(segment.text),
  } : null;
  const captionProbe = (segment) => normalize(segment?.text).replace(/^\d+:\d{2}\s+(?:\d+\s+seconds?\s+)?/i, "");
  const rawDiagnostics = await panel.evaluate((root) => ({
    transcriptLikeTags: [...new Set([...root.querySelectorAll("*")].map((node) => node.tagName.toLowerCase()).filter((tag) => tag.includes("transcript")))].sort(),
    transcriptLikeClassNames: [...new Set([...root.querySelectorAll('[class*="transcript"], [class*="segment"]')].map((node) => node.className).filter((value) => typeof value === "string" && value))].slice(0, 100),
    visibleText: (root.innerText || "").replace(/\s+/g, " ").trim(),
  }));
  return {
    segmentCountBeforeScroll: before.length,
    segmentCountAfterScroll: after.length,
    segmentSignatureBefore: signature(before),
    segmentSignatureAfter: signature(after),
    countAndOrderStableAfterScroll: before.length === after.length && signature(before) === signature(after),
    firstSegment: segmentSummary(before[0]),
    lastSegment: segmentSummary(before.at(-1)),
    totalTextCharacters: before.reduce((sum, item) => sum + item.text.length, 0),
    controls,
    accessibility: {
      snapshotCharacters: ariaSnapshot.length,
      snapshotSha256: sha(ariaSnapshot),
      containsFirstSegmentText: captionProbe(before[0]) ? compact(ariaSnapshot).includes(compact(captionProbe(before[0])).slice(0, 40)) : false,
      containsLastSegmentText: captionProbe(before.at(-1)) ? compact(ariaSnapshot).includes(compact(captionProbe(before.at(-1))).slice(0, 40)) : false,
    },
    scroll: { ...scroll, samples: scrollSamples },
    languageMenu,
    domDiagnostics: {
      transcriptLikeTags: rawDiagnostics.transcriptLikeTags,
      transcriptLikeClassNames: rawDiagnostics.transcriptLikeClassNames,
      visibleTextCharacters: rawDiagnostics.visibleText.length,
      visibleTextSha256: sha(rawDiagnostics.visibleText),
    },
  };
}

async function globalPanelDiagnostics(page) {
  const items = await page.evaluate(() => [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")].map((root) => ({
    targetId: root.getAttribute("target-id"),
    visibility: root.getAttribute("visibility"),
    renderedVisible: Boolean(root.getClientRects().length && getComputedStyle(root).visibility !== "hidden"),
    transcriptLikeTags: [...new Set([...root.querySelectorAll("*")].map((node) => node.tagName.toLowerCase()).filter((tag) => tag.includes("transcript")))].sort(),
    text: (root.innerText || "").replace(/\s+/g, " ").trim(),
  })));
  return items.map((item) => ({
    targetId: item.targetId,
    visibility: item.visibility,
    renderedVisible: item.renderedVisible,
    transcriptLikeTags: item.transcriptLikeTags,
    textCharacters: item.text.length,
    textSha256: sha(item.text),
  }));
}

async function runFixture(browser, fixture) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.setDefaultNavigationTimeout(TIMEOUT);
  const transcriptResponses = [];
  page.on("response", async (response) => {
    if (!/youtubei\/v1\/get_transcript/i.test(response.url())) return;
    const item = { urlPath: new URL(response.url()).pathname, status: response.status(), contentType: response.headers()["content-type"] || null };
    try {
      const text = await response.text();
      item.bytes = Buffer.byteLength(text);
      item.bodySha256 = sha(text);
      item.summary = summarizeTranscriptResponse(JSON.parse(text));
    } catch (error) { item.readError = String(error.message || error); }
    transcriptResponses.push(item);
  });

  const startedAt = new Date().toISOString();
  const result = { ...fixture, startedAt, status: "unknown", block: null, open: null, panel: null, error: null };
  try {
    await page.goto(`https://www.youtube.com/watch?v=${fixture.id}&hl=en`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.locator("ytd-watch-flexy").waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
    result.block = await detectBlock(page);
    result.actualUrl = page.url();
    if (result.block) { result.status = "blocked"; return result; }

    await page.evaluate(() => { const video = document.querySelector("video"); if (video) { video.muted = true; video.pause(); } });
    result.player = await playerMetadata(page);
    result.before = await pageState(page);
    result.open = await openTranscriptPanel(page);
    if (!result.open.clicked) {
      result.status = result.player.captionTrackCount === 0 ? "expected_no_panel" : "panel_trigger_not_found";
      return result;
    }
    try {
      result.panel = await inspectPanel(page);
      result.status = result.panel.segmentCountBeforeScroll > 0 ? "panel_opened_with_segments" : "panel_opened_empty";
    } catch (error) {
      result.status = "panel_open_failed";
      result.error = String(error.message || error);
      result.panelDiagnostics = await globalPanelDiagnostics(page).catch(() => []);
    }
    result.after = await pageState(page);
    return result;
  } catch (error) {
    result.status = "page_failed";
    result.error = String(error.message || error);
    return result;
  } finally {
    await page.waitForTimeout(250).catch(() => {});
    result.transcriptResponses = transcriptResponses;
    const cookies = await context.cookies().catch(() => []);
    result.anonymousContext = {
      initialStorageStateSupplied: false,
      cookieCountAtEnd: cookies.length,
      cookieDomainsAtEnd: [...new Set(cookies.map((cookie) => cookie.domain))].sort(),
    };
    result.finishedAt = new Date().toISOString();
    await context.close();
  }
}

async function runSpaScenario(browser) {
  const sourceId = "jNQXAC9IVRw";
  const targetId = "iG9CE55wbtY";
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.setDefaultNavigationTimeout(TIMEOUT);
  const responseStatuses = [];
  page.on("response", (response) => {
    if (/youtubei\/v1\/get_transcript/i.test(response.url())) responseStatuses.push(response.status());
  });
  const result = { sourceId, targetId, route: "YouTube search results click", status: "unknown", error: null };
  try {
    await page.goto(`https://www.youtube.com/watch?v=${sourceId}&hl=en`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.locator("ytd-watch-flexy").waitFor({ state: "attached", timeout: 10_000 });
    if (await detectBlock(page)) { result.status = "blocked"; return result; }
    await page.evaluate(() => { window.__youtubeDigestSpaMarker = "source-document"; document.querySelector("video")?.pause(); });
    result.sourceOpen = await openTranscriptPanel(page);
    result.sourcePanel = await inspectPanel(page).catch(() => null);
    const sourceTitle = (await pageState(page)).title;

    const search = page.locator('input[name="search_query"]').first();
    await search.fill(targetId, { timeout: 10_000 });
    await search.press("Enter");
    await page.waitForURL(/\/results\?search_query=/, { timeout: TIMEOUT });
    const link = page.locator(`a[href*="/watch?v=${targetId}"]`).first();
    await link.waitFor({ state: "visible", timeout: TIMEOUT });
    await link.click({ timeout: TIMEOUT });
    await page.waitForURL(new RegExp(`/watch\\?v=${targetId}`), { timeout: TIMEOUT });
    await page.waitForFunction((id) => document.querySelector("#movie_player")?.getPlayerResponse?.()?.videoDetails?.videoId === id, targetId, { timeout: TIMEOUT });
    result.documentMarkerSurvived = await page.evaluate(() => window.__youtubeDigestSpaMarker === "source-document");
    result.targetPlayer = await playerMetadata(page);
    result.targetStateAtPlayerSwitch = await pageState(page);
    result.panelAtPlayerSwitch = await inspectPanel(page).catch(() => null);
    result.stalePanelAtPlayerSwitch = Boolean(
      result.sourcePanel?.segmentSignatureBefore
      && result.sourcePanel.segmentSignatureBefore === result.panelAtPlayerSwitch?.segmentSignatureBefore
    );

    const settleStarted = Date.now();
    await page.waitForFunction(({ id, oldTitle }) => {
      const playerId = document.querySelector("#movie_player")?.getPlayerResponse?.()?.videoDetails?.videoId;
      return playerId === id && document.title !== oldTitle;
    }, { id: targetId, oldTitle: sourceTitle }, { timeout: 10_000 }).catch(() => {});
    result.settleWaitMs = Date.now() - settleStarted;
    result.targetStateSettled = await pageState(page);
    result.panelAtSettledState = await inspectPanel(page).catch(() => null);
    result.stalePanelAtSettledState = Boolean(
      result.sourcePanel?.segmentSignatureBefore
      && result.sourcePanel.segmentSignatureBefore === result.panelAtSettledState?.segmentSignatureBefore
    );

    if (result.stalePanelAtSettledState) {
      const close = page.locator('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] button[aria-label="Close"]').first();
      await close.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    result.targetStateBeforeOpen = await pageState(page);
    result.targetOpen = await openTranscriptPanel(page);
    result.targetPanel = result.targetOpen.clicked ? await inspectPanel(page).catch(() => null) : null;
    result.targetStateAfterOpen = await pageState(page);
    result.getTranscriptResponseStatuses = responseStatuses;
    if (!result.documentMarkerSurvived) result.status = "navigation_completed_but_document_reloaded";
    else if (result.stalePanelAtSettledState) result.status = "spa_stale_panel_persisted_until_forced_close";
    else if (result.stalePanelAtPlayerSwitch) result.status = "spa_transient_stale_panel_then_settled";
    else result.status = "spa_transition_without_stale_panel";
    return result;
  } catch (error) {
    result.status = "spa_scenario_failed";
    result.error = String(error.message || error);
    result.getTranscriptResponseStatuses = responseStatuses;
    return result;
  } finally {
    await context.close();
  }
}

function markdown(report) {
  const rows = report.cases.map((item) => {
    const tracks = item.player?.captionTrackCount ?? "-";
    const segments = item.panel?.segmentCountBeforeScroll ?? "-";
    const stable = item.panel?.countAndOrderStableAfterScroll ?? "-";
    const language = item.panel?.languageMenu?.opened ? `${item.panel.languageMenu.optionTexts.length} options` : "not opened";
    const responses = (item.transcriptResponses || []).map((entry) => entry.status).join(",") || "none";
    const repeat = item.repeatComparison ? `${item.repeatComparison.statusStable && item.repeatComparison.playerTrackCountStable && item.repeatComparison.transcriptResponseStatusesStable}` : "n/a";
    return `| ${item.label} | ${item.id} | ${tracks} | ${item.status} | ${segments} | ${stable} | ${responses} | ${repeat} | ${language} |`;
  });
  const sideEffects = report.cases.map((item) => {
    const before = item.before || {};
    const after = item.after || {};
    return `- **${item.label}**: trigger=${item.open?.clicked || "none"}; page scroll ${before.scrollY ?? "-"} -> ${after.scrollY ?? "-"}; visible engagement panels ${JSON.stringify(before.visibleEngagementPanels || [])} -> ${JSON.stringify(after.visibleEngagementPanels || [])}.`;
  });
  const spa = report.spaScenario || {};
  return `# YouTube transcript panel comparison\n\nGenerated: ${report.generatedAt}\n\nThe run used Playwright with system Chrome, a fresh anonymous browser context per video, no saved state, cookies, credentials, proxy, or anti-automation bypass flags. Each navigation/action had a 20 second hard timeout. Consent or bot checks are recorded as blockers and are not bypassed.\n\n| Case | Video | Player tracks | Panel result | DOM segments | Stable after panel scroll | get_transcript HTTP | Repeat stable | Language menu |\n|---|---|---:|---|---:|---|---|---|---|\n${rows.join("\n")}\n\n## SPA transition\n\n- Route: ${spa.sourceId || "-"} -> YouTube search -> ${spa.targetId || "-"}.\n- Result: ${spa.status || "not run"}; original document marker survived: ${spa.documentMarkerSurvived ?? "-"}; target player ID: ${spa.targetPlayer?.videoId || "-"}.\n- Stale source transcript at player-ID switch: ${spa.stalePanelAtPlayerSwitch ?? "-"}; after waiting up to 10 seconds for page-title settlement: ${spa.stalePanelAtSettledState ?? "-"}.\n- Transcript panel after any required close/reopen: ${spa.targetPanel ? `${spa.targetPanel.segmentCountBeforeScroll} DOM segments` : "not available"}; transcript response statuses across the scenario: ${(spa.getTranscriptResponseStatuses || []).join(",") || "none"}.\n\n## Visible side effects\n\n${sideEffects.join("\n")}\n\n## Interpretation limits\n\n- The transcript-panel method necessarily opens visible YouTube UI and may expand the description, change page scroll, open an engagement panel, and briefly open a language menu.\n- Player track metadata and panel availability are separate observations. A caption track in player metadata does not guarantee that the transcript panel can render it.\n- DOM completeness is judged by segment counts and order before/after a full panel scroll; the accessibility snapshot records whether both boundary segment texts are exposed.\n- The English text trigger is tried only after the locale-independent description component selector, so the JSON records selector/localization dependence.\n`;
}

await fs.mkdir(path.join(HERE, "results"), { recursive: true });
let previousReport = null;
try { previousReport = JSON.parse(await fs.readFile(OUT_JSON, "utf8")); } catch {}
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {
  generatedAt: new Date().toISOString(),
  environment: { playwright: "1.62.1", chromePath: CHROME, headless: true, timeoutMs: TIMEOUT },
  previousRunGeneratedAt: previousReport?.generatedAt || null,
  cases: [],
};
try {
  for (const fixture of fixtures) {
    process.stdout.write(`Running ${fixture.label} (${fixture.id})...\n`);
    report.cases.push(await runFixture(browser, fixture));
  }
  process.stdout.write("Running SPA transition scenario...\n");
  report.spaScenario = await runSpaScenario(browser);
} finally {
  await browser.close();
}
for (const item of report.cases) {
  const previous = previousReport?.cases?.find((candidate) => candidate.label === item.label);
  item.repeatComparison = previous ? {
    previousStatus: previous.status,
    statusStable: previous.status === item.status,
    previousPlayerTrackCount: previous.player?.captionTrackCount ?? null,
    playerTrackCountStable: previous.player?.captionTrackCount === item.player?.captionTrackCount,
    previousSegmentCount: previous.panel?.segmentCountBeforeScroll ?? null,
    currentSegmentCount: item.panel?.segmentCountBeforeScroll ?? null,
    transcriptResponseStatusesStable: JSON.stringify(previous.transcriptResponses?.map((entry) => entry.status) || []) === JSON.stringify(item.transcriptResponses?.map((entry) => entry.status) || []),
  } : null;
}
await fs.writeFile(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(OUT_MD, markdown(report));
console.log(`Wrote ${OUT_JSON}`);
console.log(`Wrote ${OUT_MD}`);
