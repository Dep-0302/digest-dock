/**
 * DigestDock YouTube transcript-panel fallback.
 *
 * This module reads the rendered YouTube transcript UI. It never calls fetch,
 * XMLHttpRequest, or a third-party service. The caller remains responsible for
 * deciding when the Panel route is eligible; this module performs a second,
 * zero-request eligibility check before changing the page.
 */
var DIGESTDOCK_YOUTUBE_PANEL =
  typeof globalThis !== "undefined" &&
  globalThis.DIGESTDOCK_YOUTUBE_PANEL?.moduleVersion === "2026-08-27.2"
    ? globalThis.DIGESTDOCK_YOUTUBE_PANEL
    : (() => {
  const PROVIDER_ID = "youtube-panel";
  const PROVIDER_VARIANT = "auto-rendered-panel";
  const MAX_TIMEOUT_MS = 15_000;
  const DEFAULT_POLL_MS = 50;
  const DEFAULT_SETTLE_MS = 60;
  const STALE_PANEL_CLEAR_MS = 1_200;
  const MAX_RESTORE_MS = 1_200;
  const ROW_SELECTORS = Object.freeze([
    "ytd-transcript-segment-renderer",
    "transcript-segment-view-model",
    ".transcript-segment-view-model",
  ]);
  const TRANSCRIPT_LABEL =
    /(?:show|open|view)\s+transcript|\btranscript\b|显示文字稿|顯示文字稿|文字稿|文字起こし|トランスクリプト/i;
  const CLOSE_LABEL = /close|关闭|關閉|閉じる/i;
  const MORE_ACTIONS_LABEL =
    /more actions|more options|更多操作|更多動作|其他操作|その他の操作/i;
  const ERROR_LABEL =
    /failed[_\s-]*precondition|\b400\b|transcript\s+(?:is\s+)?unavailable|something went wrong|try again|无法.*文字稿|文字稿.*不可用/i;

  class PanelRouteError extends Error {
    constructor(code, status = "UNKNOWN", stopReason = null) {
      super(code);
      this.name = "PanelRouteError";
      this.code = code;
      this.status = status;
      this.stopReason = stopReason || code;
    }
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeLanguage(value) {
    const language = String(value || "").trim().replace(/_/g, "-");
    return language && language.length <= 35 &&
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)
      ? language
      : null;
  }

  function primaryLanguage(value) {
    return normalizeLanguage(value)?.toLowerCase().split("-")[0] || null;
  }

  function normalizeTrackKind(value) {
    const kind = String(value || "").trim().toLowerCase();
    return kind === "asr" || kind === "manual" ? kind : null;
  }

  function normalizeRunId(value) {
    const runId = String(value || "").trim();
    return /^[0-9A-Za-z._:-]{1,80}$/.test(runId) ? runId : null;
  }

  function normalizeVideoId(value) {
    const videoId = String(value || "").trim();
    return /^[0-9A-Za-z_-]{11}$/.test(videoId) ? videoId : null;
  }

  function videoIdFromUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (
        !["www.youtube.com", "youtube.com", "m.youtube.com"].includes(
          url.hostname,
        ) ||
        url.pathname !== "/watch"
      ) {
        return null;
      }
      return normalizeVideoId(url.searchParams.get("v"));
    } catch {
      return null;
    }
  }

  function parseTimestamp(value) {
    const text = normalizeText(value);
    if (!/^\d+:[0-5]\d(?::[0-5]\d)?$/.test(text)) return null;
    return text.split(":").map(Number).reduce(
      (total, piece) => total * 60 + piece,
      0,
    );
  }

  function normalizeRows(rows) {
    if (!Array.isArray(rows)) {
      throw new PanelRouteError("PANEL_DOM_CHANGED");
    }
    return rows.map((row) => {
      const timestamp = normalizeText(row?.timestamp);
      const text = normalizeText(row?.text);
      const start = Number.isFinite(row?.start)
        ? Number(row.start)
        : parseTimestamp(timestamp);
      if (!Number.isFinite(start) || start < 0 || !text) {
        throw new PanelRouteError("PANEL_DOM_CHANGED");
      }
      return { timestamp: timestamp || formatTimestamp(start), start, text };
    });
  }

  function rowSignature(rows) {
    const normalized = normalizeRows(rows);
    let hash = 2166136261;
    for (const row of normalized) {
      const value = `${row.start}:${row.text}|`;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${normalized.length}:${(hash >>> 0).toString(16)}`;
  }

  function mergeCoverageRanges(ranges) {
    const ordered = (Array.isArray(ranges) ? ranges : [])
      .filter(
        (range) =>
          Array.isArray(range) &&
          range.length === 2 &&
          Number.isFinite(range[0]) &&
          Number.isFinite(range[1]) &&
          range[0] >= 0 &&
          range[1] >= range[0],
      )
      .sort((left, right) => left[0] - right[0]);
    const merged = [];
    for (const range of ordered) {
      const previous = merged.at(-1);
      if (!previous || range[0] > previous[1] + 4) {
        merged.push([...range]);
      } else {
        previous[1] = Math.max(previous[1], range[1]);
      }
    }
    return merged;
  }

  function coverageMetrics(ranges, scrollHeight) {
    const merged = mergeCoverageRanges(ranges);
    const height = Number(scrollHeight);
    if (!Number.isFinite(height) || height <= 0) {
      return { complete: false, ratio: 0, ranges: merged };
    }
    const covered = merged.reduce(
      (total, range) => total + Math.max(0, range[1] - range[0]),
      0,
    );
    return {
      complete:
        merged.length === 1 &&
        merged[0][0] <= 4 &&
        merged[0][1] >= height - 4,
      ratio: Math.min(1, covered / height),
      ranges: merged,
    };
  }

  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function rowsToSegments(rows, language) {
    const normalized = normalizeRows(rows).sort(
      (left, right) => left.start - right.start,
    );
    return normalized.map((row, index) => {
      const next = normalized[index + 1];
      return {
        text: row.text,
        start: row.start,
        duration: next ? Math.max(0, next.start - row.start) : 0,
        language,
      };
    });
  }

  function evidenceAllowsPanel(evidence) {
    if (evidence === true) return true;
    if (!evidence || typeof evidence !== "object") return false;
    return Boolean(
      evidence.activeFoundCaptionTrack === true ||
      evidence.sawTracks === true ||
      evidence.hasCaptionTrack === true ||
      evidence.trackAvailable === true ||
      Number(evidence.captionTrackCount) > 0 ||
      (Array.isArray(evidence.captionTracks) && evidence.captionTracks.length) ||
      (evidence.selectedTrack && typeof evidence.selectedTrack === "object"),
    );
  }

  function eligibilityForRequest(request) {
    if (request?.eligibility !== undefined) return request.eligibility;
    if (request?.eligibilityEvidence !== undefined) {
      return request.eligibilityEvidence;
    }
    if (request?.activeEvidence !== undefined) {
      return request.activeEvidence;
    }
    if (
      request?.activeFoundCaptionTrack !== undefined ||
      request?.captionTrackCount !== undefined ||
      request?.selectedTrack !== undefined
    ) {
      return {
        activeFoundCaptionTrack: request.activeFoundCaptionTrack,
        captionTrackCount: request.captionTrackCount,
        selectedTrack: request.selectedTrack,
        selectedTrackEvidence: request.selectedTrackEvidence,
      };
    }
    return null;
  }

  function evidenceHttpStatus(evidence) {
    if (!evidence || typeof evidence !== "object") return null;
    const value = Number(
      evidence.panelHttpStatus ??
      evidence.getTranscriptHttpStatus ??
      evidence.httpStatus,
    );
    return Number.isInteger(value) ? value : null;
  }

  function selectedTrackFromRequest(request) {
    const evidence = eligibilityForRequest(request);
    const selected = evidence?.selectedTrack;
    if (!selected || typeof selected !== "object") return null;
    const language = normalizeLanguage(selected.language);
    const kind = normalizeText(selected.kind).slice(0, 40) || null;
    return language || kind ? { language, kind } : null;
  }

  function selectedTrackEvidenceFromRequest(request) {
    const evidence = eligibilityForRequest(request);
    if (!evidence?.selectedTrack || typeof evidence.selectedTrack !== "object") {
      return null;
    }
    const value = normalizeText(evidence.selectedTrackEvidence);
    return value === "page-default" ? "page-default" : "active";
  }

  function pageInducedRequestEvidence(request) {
    const evidence = eligibilityForRequest(request);
    const observed = Number(
      evidence?.observedGetTranscriptRequests ??
        evidence?.pageInducedRequestsObserved,
    );
    return Number.isFinite(observed) && observed >= 0
      ? { status: "observed", count: observed }
      : { status: "unknown", count: null };
  }

  function baseDiagnostics(request, extra = {}) {
    return {
      providerInitiated: {
        youtubePlayer: 0,
        youtubeTimedtext: 0,
        thirdParty: 0,
        loopback: 0,
      },
      extensionDirectRequests: 0,
      pageInducedRequests: pageInducedRequestEvidence(request),
      ...extra,
    };
  }

  function failureResult(request, code, status = "UNKNOWN", diagnostics = {}) {
    return {
      ok: false,
      status,
      providerId: PROVIDER_ID,
      providerVariant: PROVIDER_VARIANT,
      videoId: normalizeVideoId(request?.videoId),
      runId: normalizeRunId(request?.runId),
      error: code,
      errorCode: code,
      diagnostics: baseDiagnostics(request, diagnostics),
    };
  }

  function successResult(
    request,
    rows,
    evidence,
    diagnostics,
    renderedTrack = null,
    languageEvidence = "unknown",
  ) {
    const activeTrack = selectedTrackFromRequest(request);
    const language = normalizeLanguage(renderedTrack?.language);
    const selectedTrack =
      language && normalizeTrackKind(renderedTrack?.kind) && activeTrack &&
      primaryLanguage(activeTrack.language) === primaryLanguage(language) &&
      normalizeTrackKind(activeTrack.kind) === normalizeTrackKind(renderedTrack.kind)
        ? { language, kind: normalizeTrackKind(renderedTrack.kind) }
        : null;
    const transcript = rowsToSegments(rows, language);
    return {
      ok: true,
      status: "HAVE_TRANSCRIPT",
      providerId: PROVIDER_ID,
      providerVariant: PROVIDER_VARIANT,
      videoId: normalizeVideoId(request.videoId),
      runId: normalizeRunId(request.runId),
      language,
      languageEvidence: language ? languageEvidence : "unknown",
      selectedTrack,
      transcript,
      text: transcript.map((entry) => entry.text).join(" "),
      timestamped: transcript
        .map((entry) => `[${formatTimestamp(entry.start)}] ${entry.text}`)
        .join("\n"),
      transcriptText: transcript.map((entry) => entry.text).join(" "),
      transcriptTextTimestamped: transcript
        .map((entry) => `[${formatTimestamp(entry.start)}] ${entry.text}`)
        .join("\n"),
      complete: true,
      completenessEvidence: "auto-top-middle-bottom",
      diagnostics: baseDiagnostics(request, {
        eligibilityByActiveTrack: evidenceAllowsPanel(evidence),
        requestedLanguage:
          normalizeLanguage(request?.preferredLanguage || request?.language) ||
          null,
        activeTrackLanguage: activeTrack?.language || null,
        renderedLanguage: language,
        ...diagnostics,
      }),
    };
  }

  function createBrowserRuntime(root = globalThis) {
    let navigationEpoch = 0;
    const markNavigation = () => {
      navigationEpoch += 1;
    };
    for (const target of [root, root?.document]) {
      if (typeof target?.addEventListener !== "function") continue;
      target.addEventListener("yt-navigate-start", markNavigation);
      target.addEventListener("yt-navigate-finish", markNavigation);
    }

    const documentForPage = () => root?.document || null;
    const currentPageVideoId = () => {
      const urlVideoId = videoIdFromUrl(root?.location?.href);
      if (!urlVideoId) return null;
      const doc = documentForPage();
      const flexyVideoId = normalizeVideoId(
        doc?.querySelector?.("ytd-watch-flexy")?.getAttribute?.("video-id"),
      );
      let playerVideoId = null;
      try {
        playerVideoId = normalizeVideoId(
          doc?.querySelector?.("#movie_player")?.getPlayerResponse?.()
            ?.videoDetails?.videoId,
        );
      } catch {
        playerVideoId = null;
      }
      const observed = [urlVideoId, flexyVideoId, playerVideoId].filter(Boolean);
      return new Set(observed).size === 1 ? urlVideoId : null;
    };
    const styleFor = (element) => {
      try {
        return typeof root?.getComputedStyle === "function"
          ? root.getComputedStyle(element)
          : { display: "", visibility: "", overflowY: "" };
      } catch {
        return { display: "", visibility: "", overflowY: "" };
      }
    };
    const isConnected = (element) =>
      Boolean(element && element.isConnected !== false);
    const isVisible = (element) => {
      if (!isConnected(element)) return false;
      try {
        const rects = element.getClientRects?.();
        if (rects && rects.length === 0) return false;
      } catch {
        return false;
      }
      const style = styleFor(element);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const queryAll = (selector, parent = documentForPage()) => {
      try {
        return [...(parent?.querySelectorAll?.(selector) || [])];
      } catch {
        return [];
      }
    };
    const semanticLabel = (element) =>
      normalizeText(
        `${element?.getAttribute?.("aria-label") || ""} ` +
        `${element?.getAttribute?.("title") || ""} ` +
        `${element?.textContent || ""}`,
      );
    const panelRows = (panel) =>
      queryAll(ROW_SELECTORS.join(","), panel);
    const isTranscriptPanel = (panel) => {
      const target = normalizeText(
        `${panel?.getAttribute?.("target-id") || ""} ` +
        `${panel?.id || ""}`,
      );
      if (panelRows(panel).length || /transcript/i.test(target)) return true;
      if (target) return false;
      return TRANSCRIPT_LABEL.test(
        normalizeText(panel?.textContent).slice(0, 500),
      );
    };
    const visibleEngagementPanels = () =>
      queryAll("ytd-engagement-panel-section-list-renderer").filter(isVisible);
    const findVisiblePanel = () =>
      visibleEngagementPanels().find(isTranscriptPanel) || null;
    const panelIdentity = (panel) =>
      normalizeText(
        panel?.getAttribute?.("target-id") || panel?.id || "",
      ).slice(0, 160) || null;

    function findPanelRestoreControl(panel) {
      const identity = panelIdentity(panel);
      if (!identity) return null;
      return queryAll(
        "button,[role='button'],[aria-controls],[data-target-id],[target-id]",
      ).find((element) => {
        if (!isVisible(element)) return false;
        if (element.closest?.("ytd-engagement-panel-section-list-renderer")) {
          return false;
        }
        return [
          element.getAttribute?.("aria-controls"),
          element.getAttribute?.("data-target-id"),
          element.getAttribute?.("target-id"),
        ].some((value) => normalizeText(value) === identity);
      }) || null;
    }

    function findTranscriptEntry({ visibleOnly = true } = {}) {
      const doc = documentForPage();
      if (!doc) return null;
      const structural = queryAll(
        "ytd-video-description-transcript-section-renderer button",
        doc,
      );
      const generic = queryAll(
        "button,[role='button'],tp-yt-paper-item,ytd-menu-service-item-renderer",
        doc,
      );
      return [...structural, ...generic].find((element) => {
        if (visibleOnly && !isVisible(element)) return false;
        if (element.closest?.("ytd-engagement-panel-section-list-renderer")) {
          return false;
        }
        if (
          element?.id === "description-inline-expander" ||
          element?.id === "expand" ||
          element?.id === "collapse" ||
          String(element?.tagName || "").toLowerCase() ===
            "ytd-text-inline-expander"
        ) {
          return false;
        }
        const explicitLabel = normalizeText(
          `${element?.getAttribute?.("aria-label") || ""} ` +
          `${element?.getAttribute?.("title") || ""}`,
        );
        const text = normalizeText(element?.textContent);
        return (
          TRANSCRIPT_LABEL.test(explicitLabel) ||
          (text.length <= 160 && TRANSCRIPT_LABEL.test(text))
        );
      }) || null;
    }

    function descriptionExpanded() {
      const doc = documentForPage();
      const expander = doc?.querySelector?.(
        "ytd-watch-metadata #description ytd-text-inline-expander," +
          "ytd-watch-metadata ytd-text-inline-expander#description-inline-expander",
      );
      return Boolean(
        expander?.hasAttribute?.("is-expanded") ||
        doc?.querySelector?.(
          "ytd-watch-metadata #description-inline-expander[is-expanded]",
        ),
      );
    }

    function findDescriptionControl(mode = "expand") {
      const doc = documentForPage();
      if (!doc) return null;
      const selectors = mode === "collapse"
        ? [
            "ytd-watch-metadata tp-yt-paper-button#collapse",
            "ytd-watch-metadata #description button[aria-label*='less' i]",
            "ytd-watch-metadata #description ytd-text-inline-expander " +
              "button[aria-label*='less' i]",
          ]
        : [
            "ytd-watch-metadata #description-inline-expander",
            "ytd-watch-metadata tp-yt-paper-button#expand",
            "ytd-watch-metadata #description button[aria-label*='more' i]",
            "ytd-watch-metadata #description ytd-text-inline-expander " +
              "button[aria-label*='more' i]",
          ];
      for (const selector of selectors) {
        const element = doc.querySelector?.(selector);
        if (element && isVisible(element)) return element;
      }
      const label = mode === "collapse"
        ? /show less|less|收起|較少|閉じる/i
        : /show more|more|展开|展開|もっと見る/i;
      const containers = [
        doc.querySelector?.("ytd-watch-metadata #description"),
        doc.querySelector?.(
          "ytd-watch-metadata #description ytd-text-inline-expander",
        ),
        doc.querySelector?.("ytd-watch-metadata #description-inline-expander"),
      ].filter(Boolean);
      for (const container of containers) {
        const control = queryAll("button,[role='button']", container).find(
          (element) => isVisible(element) && label.test(semanticLabel(element)),
        );
        if (control) return control;
      }
      return null;
    }

    function findScroller(panel) {
      const firstRow = panelRows(panel)[0];
      let ancestor = firstRow?.parentElement || null;
      let fittedScroller = null;
      while (ancestor && panel?.contains?.(ancestor)) {
        const style = styleFor(ancestor);
        if (/^(?:auto|scroll|overlay)$/.test(style.overflowY)) {
          if (
            Number(ancestor.scrollHeight) > Number(ancestor.clientHeight) + 4
          ) {
            return ancestor;
          }
          if (
            !fittedScroller &&
            Number(ancestor.scrollHeight) > 0 &&
            Number(ancestor.clientHeight) > 0
          ) {
            fittedScroller = ancestor;
          }
        }
        if (ancestor === panel) break;
        ancestor = ancestor.parentElement;
      }
      const candidates = [
        panel?.querySelector?.("#content"),
        panel?.querySelector?.("#segments-container"),
        panel?.querySelector?.("ytd-transcript-search-panel-renderer"),
      ].filter(Boolean);
      const overflowScroller = candidates.find((candidate) => {
        const style = styleFor(candidate);
        return (
          Number(candidate.scrollHeight) > Number(candidate.clientHeight) + 4 &&
          /^(?:auto|scroll|overlay)$/.test(style.overflowY)
        );
      });
      if (overflowScroller) return overflowScroller;
      return fittedScroller || candidates.find((candidate) => {
        const style = styleFor(candidate);
        return (
          /^(?:auto|scroll|overlay)$/.test(style.overflowY) &&
          Number(candidate.scrollHeight) > 0 &&
          Number(candidate.clientHeight) > 0
        );
      }) || null;
    }

    function readRow(row) {
      const timestamp =
        row?.querySelector?.(
          ".ytwTranscriptSegmentViewModelTimestamp:not(.ytwTranscriptSegmentViewModelTimestampA11yLabel)",
        )?.textContent ||
        row?.querySelector?.(".segment-timestamp")?.textContent ||
        row?.querySelector?.("[class*='timestamp']")?.textContent ||
        "";
      const text =
        row?.querySelector?.("span.ytAttributedStringHost[role='text']")
          ?.textContent ||
        row?.querySelector?.(".segment-text")?.textContent ||
        row?.querySelector?.("[class*='segment-text']")?.textContent ||
        row?.querySelector?.("yt-formatted-string")?.textContent ||
        "";
      return { timestamp, text };
    }

    function closePanel(panel) {
      if (!panel || !isConnected(panel)) return true;
      const direct = [
        panel.querySelector?.("button[aria-label='Close']"),
        panel.querySelector?.("button[aria-label*='close' i]"),
        panel.querySelector?.("#visibility-button button"),
      ].filter(Boolean);
      const generic = queryAll("button,[role='button']", panel);
      const close = [...direct, ...generic].find(
        (element) => isVisible(element) && CLOSE_LABEL.test(semanticLabel(element)),
      );
      if (!close) return false;
      close.click?.();
      return true;
    }

    function pressEscape() {
      const doc = documentForPage();
      try {
        const KeyboardEventCtor = root?.KeyboardEvent;
        if (typeof KeyboardEventCtor === "function") {
          doc?.dispatchEvent?.(
            new KeyboardEventCtor("keydown", {
              key: "Escape",
              code: "Escape",
              bubbles: true,
            }),
          );
        }
      } catch {
        // Best effort only; the state verifier will still reject a bad restore.
      }
    }

    async function openTranscriptPanel(entry) {
      if (entry && isVisible(entry)) {
        entry.click?.();
        return { opened: true, overflowOpened: false };
      }
      const doc = documentForPage();
      const menuButtons = queryAll(
        "ytd-watch-metadata ytd-menu-renderer button[aria-label]," +
          "ytd-watch-metadata ytd-menu-renderer yt-icon-button[aria-label]",
        doc,
      ).filter(
        (button) =>
          isVisible(button) && MORE_ACTIONS_LABEL.test(semanticLabel(button)),
      );
      for (const button of menuButtons.slice(0, 2)) {
        button.click?.();
        await new Promise((resolve) => root.setTimeout(resolve, 0));
        const item = findTranscriptEntry({ visibleOnly: true });
        if (item) {
          item.click?.();
          return { opened: true, overflowOpened: true };
        }
        pressEscape();
      }
      return { opened: false, overflowOpened: false };
    }

    return {
      now: () => Date.now(),
      wait: (milliseconds) =>
        new Promise((resolve) => root.setTimeout(resolve, milliseconds)),
      navigationEpoch: () => navigationEpoch,
      currentVideoId: currentPageVideoId,
      isConnected,
      isVisible,
      isTranscriptPanel,
      panelIdentity,
      findDescriptionControl,
      findTranscriptEntry,
      findVisiblePanel,
      visibleEngagementPanels,
      findScroller,
      readRows: (panel) => panelRows(panel).map(readRow),
      panelErrorCode(panel) {
        if (!panel) return null;
        const rows = panelRows(panel);
        const errorNodes = queryAll(
          "[role='alert'],#error,.error-message," +
            "ytd-message-renderer,ytd-alert-with-button-renderer",
          panel,
        );
        const text = normalizeText(
          errorNodes.length
            ? errorNodes.map((node) => node.textContent || "").join(" ")
            : rows.length
              ? ""
              : panel.textContent,
        ).slice(0, 2_000);
        if (!ERROR_LABEL.test(text)) return null;
        return /failed[_\s-]*precondition|\b400\b/i.test(text)
          ? "PANEL_HTTP_400"
          : "PANEL_EMPTY";
      },
      panelLanguage(panel) {
        if (!panel) return null;
        const selected =
          panel.querySelector?.(
            "[aria-selected='true'][data-language-code]," +
              "[aria-selected='true'][data-value]",
          ) || null;
        return normalizeLanguage(
          panel.getAttribute?.("data-language-code") ||
            selected?.getAttribute?.("data-language-code") ||
            selected?.getAttribute?.("data-value"),
        );
      },
      panelTrackKind(panel) {
        if (!panel) return null;
        const selected =
          panel.querySelector?.(
            "[aria-selected='true'][data-kind]," +
              "[aria-checked='true'][data-kind]," +
              "[aria-selected='true'][data-language-code]," +
              "[aria-checked='true'][data-language-code]",
          ) || null;
        const explicit = normalizeTrackKind(
          panel.getAttribute?.("data-kind") ||
            selected?.getAttribute?.("data-kind"),
        );
        if (explicit) return explicit;
        const selectedText = normalizeText(selected?.textContent);
        return /auto(?:matically)?[- ]generated|自动生成|自動生成/i.test(
          selectedText,
        )
          ? "asr"
          : null;
      },
      metrics(scroller) {
        return {
          scrollTop: Number(scroller?.scrollTop),
          scrollHeight: Number(scroller?.scrollHeight),
          clientHeight: Number(scroller?.clientHeight),
        };
      },
      setScrollTop(scroller, value) {
        scroller.scrollTop = Math.max(0, Number(value) || 0);
      },
      capture() {
        const panel = findVisiblePanel();
        const engagementPanels = visibleEngagementPanels().map((element) => ({
          element,
          identity: panelIdentity(element),
          transcript: isTranscriptPanel(element),
          restoreControl: isTranscriptPanel(element)
            ? null
            : findPanelRestoreControl(element),
        }));
        return {
          videoId: currentPageVideoId(),
          navigationEpoch,
          scrollX: Number(root?.scrollX) || 0,
          scrollY: Number(root?.scrollY) || 0,
          descriptionExpanded: descriptionExpanded(),
          panel,
          engagementPanels,
        };
      },
      canRestoreEngagementPanels(snapshot) {
        const allPanels = snapshot?.engagementPanels || [];
        const otherPanels = (snapshot?.engagementPanels || []).filter(
          (item) => !item.transcript,
        );
        return (
          allPanels.length <= 1 &&
          otherPanels.length <= 1 &&
          otherPanels.every(
            (item) =>
              item.identity &&
              item.restoreControl &&
              isConnected(item.restoreControl) &&
              isVisible(item.restoreControl),
          )
        );
      },
      expandDescription() {
        if (descriptionExpanded()) return { changed: false, control: null };
        const control = findDescriptionControl("expand");
        if (!control) return { changed: false, control: null };
        control.click?.();
        return { changed: true, control };
      },
      openTranscriptPanel,
      closePanel,
      async restore(context) {
        const errors = [];
        const samePageContext = () =>
          currentPageVideoId() === context.snapshot?.videoId &&
          navigationEpoch === context.snapshot?.navigationEpoch;
        if (!samePageContext()) {
          return {
            ok: true,
            errors: [],
            skippedForNavigation: true,
          };
        }
        const restoreDeadline = Math.min(
          Number(context.deadline) || Date.now() + MAX_RESTORE_MS,
          Date.now() + MAX_RESTORE_MS,
        );
        const restorePollMs = Math.max(
          1,
          Math.min(100, Number(context.pollMs) || DEFAULT_POLL_MS),
        );
        const waitUntil = async (predicate) => {
          while (samePageContext() && Date.now() < restoreDeadline) {
            if (predicate()) return true;
            const remaining = restoreDeadline - Date.now();
            await new Promise((resolve) =>
              root.setTimeout(resolve, Math.min(restorePollMs, remaining)),
            );
          }
          return samePageContext() && predicate();
        };
        const initialPanels = context.snapshot?.engagementPanels || [];
        const initialTranscript = initialPanels.find((item) => item.transcript);
        const initialOtherPanel = initialPanels.find((item) => !item.transcript);
        if (context.overflowOpened) pressEscape();

        if (!initialTranscript) {
          const transcript = findVisiblePanel();
          if (transcript) {
            if (!closePanel(transcript)) {
              errors.push("PANEL_CLOSE_FAILED");
            } else if (!(await waitUntil(() => !findVisiblePanel()))) {
              errors.push("PANEL_CLOSE_FAILED");
            }
          }
        } else if (!findVisiblePanel()) {
          const entry = findTranscriptEntry({ visibleOnly: true });
          const open = await openTranscriptPanel(entry);
          if (
            !open?.opened ||
            !(await waitUntil(() => Boolean(findVisiblePanel())))
          ) {
            errors.push("PANEL_REOPEN_FAILED");
          }
        }

        if (initialOtherPanel && samePageContext()) {
          const otherIsVisible = () =>
            visibleEngagementPanels().some(
              (panel) => panelIdentity(panel) === initialOtherPanel.identity,
            );
          if (!otherIsVisible()) {
            const control = initialOtherPanel.restoreControl;
            if (!control || !isConnected(control) || !isVisible(control)) {
              errors.push("ENGAGEMENT_PANEL_RESTORE_FAILED");
            } else {
              control.click?.();
              if (!(await waitUntil(otherIsVisible))) {
                errors.push("ENGAGEMENT_PANEL_RESTORE_FAILED");
              }
            }
          }
        }

        if (initialTranscript && samePageContext()) {
          const restoredPanel = findVisiblePanel();
          const restoredScroller = restoredPanel
            ? findScroller(restoredPanel)
            : null;
          if (!restoredScroller) {
            errors.push("PANEL_SCROLL_RESTORE_FAILED");
          } else {
            try {
              restoredScroller.scrollTop = context.scrollerScrollTop;
              if (
                !(await waitUntil(
                  () =>
                    Math.abs(
                      Number(restoredScroller.scrollTop) -
                        Number(context.scrollerScrollTop),
                    ) <= 2,
                ))
              ) {
                errors.push("PANEL_SCROLL_RESTORE_FAILED");
              }
            } catch {
              errors.push("PANEL_SCROLL_RESTORE_FAILED");
            }
          }
        }
        if (
          context.descriptionExpandedByModule &&
          !context.snapshot?.descriptionExpanded &&
          descriptionExpanded()
        ) {
          const collapse = findDescriptionControl("collapse");
          const control = collapse || context.descriptionControl;
          if (!control || !isConnected(control)) {
            errors.push("DESCRIPTION_RESTORE_FAILED");
          } else {
            control.click?.();
            if (!(await waitUntil(() => !descriptionExpanded()))) {
              errors.push("DESCRIPTION_RESTORE_FAILED");
            }
          }
        }
        try {
          root?.scrollTo?.(
            context.snapshot?.scrollX || 0,
            context.snapshot?.scrollY || 0,
          );
        } catch {
          errors.push("PAGE_SCROLL_RESTORE_FAILED");
        }
        if (
          !(await waitUntil(
            () =>
              !Number.isFinite(Number(root?.scrollY)) ||
              Math.abs(
                Number(root.scrollY) - Number(context.snapshot?.scrollY || 0),
              ) <= 2,
          ))
        ) {
          errors.push("PAGE_SCROLL_RESTORE_FAILED");
        }
        if (!samePageContext()) {
          return {
            ok: true,
            errors: [],
            skippedForNavigation: true,
          };
        }
        const uniqueErrors = [...new Set(errors)];
        return { ok: uniqueErrors.length === 0, errors: uniqueErrors };
      },
    };
  }

  function create({
    runtime = createBrowserRuntime(),
    timeoutMs = MAX_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    settleMs = DEFAULT_SETTLE_MS,
  } = {}) {
    const boundedTimeout = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, Number(timeoutMs) || MAX_TIMEOUT_MS),
    );
    const boundedPoll = Math.max(0, Number(pollMs) || 0);
    const boundedSettle = Math.max(0, Number(settleMs) || 0);
    let activeRunId = null;
    let cancelRequested = false;

    function cancel(runId) {
      const normalized = normalizeRunId(runId);
      if (!normalized || normalized !== activeRunId) return false;
      cancelRequested = true;
      return true;
    }

    async function run(request = {}) {
      const videoId = normalizeVideoId(request.videoId);
      const runId = normalizeRunId(request.runId);
      if (!videoId || !runId) {
        return failureResult(request, "PANEL_INVALID_REQUEST");
      }
      if (activeRunId) {
        return failureResult(request, "PANEL_BUSY");
      }

      activeRunId = runId;
      cancelRequested = false;
      const startedAt = runtime.now();
      const deadline = startedAt + boundedTimeout;
      const restoreBudgetMs = Math.min(
        MAX_RESTORE_MS,
        Math.max(1, Math.floor(boundedTimeout * 0.2)),
      );
      const operationDeadline = deadline - restoreBudgetMs;
      const startEpoch = runtime.navigationEpoch();
      let snapshot = null;
      let panel = null;
      let scroller = null;
      let scrollerScrollTop = 0;
      let openedPanel = false;
      let overflowOpened = false;
      let descriptionExpandedByModule = false;
      let descriptionControl = null;
      let initialTranscriptWasOpen = false;
      let preOpenSignature = null;
      let postOpenSignature = null;
      let panelDisappearedBeforeOpen = false;
      let freshPanelBound = false;
      let result = null;

      const assertCurrent = () => {
        if (cancelRequested || request?.signal?.aborted) {
          throw new PanelRouteError(
            "PAGE_CONTEXT_CHANGED",
            "PAGE_CONTEXT_CHANGED",
            "cancelled",
          );
        }
        if (
          runtime.currentVideoId() !== videoId ||
          runtime.navigationEpoch() !== startEpoch
        ) {
          throw new PanelRouteError(
            "PAGE_CONTEXT_CHANGED",
            "PAGE_CONTEXT_CHANGED",
            "navigation",
          );
        }
        if (runtime.now() >= operationDeadline) {
          throw new PanelRouteError("PANEL_TIMEOUT", "UNKNOWN", "timeout");
        }
      };

      const pause = async (milliseconds) => {
        assertCurrent();
        const remaining = operationDeadline - runtime.now();
        if (remaining <= 0) {
          throw new PanelRouteError("PANEL_TIMEOUT", "UNKNOWN", "timeout");
        }
        await runtime.wait(Math.min(Math.max(0, milliseconds), remaining));
        assertCurrent();
      };

      const collect = (state) => {
        assertCurrent();
        if (!runtime.isConnected(panel) || !runtime.isConnected(scroller)) {
          throw new PanelRouteError("PANEL_DOM_CHANGED");
        }
        const panelError = runtime.panelErrorCode(panel);
        if (panelError) throw new PanelRouteError(panelError);
        const metrics = runtime.metrics(scroller);
        if (
          !Number.isFinite(metrics.scrollTop) ||
          !Number.isFinite(metrics.scrollHeight) ||
          !Number.isFinite(metrics.clientHeight) ||
          metrics.scrollTop < 0 ||
          metrics.scrollHeight <= 0 ||
          metrics.clientHeight <= 0
        ) {
          throw new PanelRouteError("PANEL_SCROLL_CONTAINER_UNKNOWN");
        }
        const rows = normalizeRows(runtime.readRows(panel));
        if (!rows.length) throw new PanelRouteError("PANEL_EMPTY");
        for (const row of rows) {
          state.rows.set(`${row.start}:${row.text}`, row);
        }
        const maxScrollTop = Math.max(
          0,
          metrics.scrollHeight - metrics.clientHeight,
        );
        const atTop = metrics.scrollTop <= 4;
        const atBottom = metrics.scrollTop >= maxScrollTop - 4;
        state.sawTop ||= atTop;
        state.sawBottom ||= atBottom;
        state.sawMiddle ||=
          maxScrollTop <= 8 ||
          (metrics.scrollTop > 4 && metrics.scrollTop < maxScrollTop - 4);
        state.maxScrollHeight = Math.max(
          state.maxScrollHeight,
          metrics.scrollHeight,
        );
        state.coverageRanges.push([
          Math.max(0, metrics.scrollTop),
          Math.min(
            metrics.scrollHeight,
            metrics.scrollTop + metrics.clientHeight,
          ),
        ]);
        state.collects += 1;
        return { metrics, maxScrollTop, rows };
      };

      try {
        assertCurrent();
        snapshot = runtime.capture();
        snapshot.runId = runId;
        if (
          snapshot?.videoId !== videoId ||
          snapshot?.navigationEpoch !== startEpoch
        ) {
          throw new PanelRouteError(
            "PAGE_CONTEXT_CHANGED",
            "PAGE_CONTEXT_CHANGED",
            "navigation",
          );
        }
        const eligibility = eligibilityForRequest(request);
        if (evidenceHttpStatus(eligibility) === 400) {
          throw new PanelRouteError("PANEL_HTTP_400");
        }

        if (
          typeof runtime.canRestoreEngagementPanels === "function" &&
          runtime.canRestoreEngagementPanels(snapshot) !== true
        ) {
          throw new PanelRouteError("PANEL_EXISTING_UI_UNRESTORABLE");
        }

        panel = runtime.findVisiblePanel();
        initialTranscriptWasOpen = Boolean(panel);
        if (panel) {
          const initialError = runtime.panelErrorCode(panel);
          if (initialError) throw new PanelRouteError(initialError);
          const beforeRows = normalizeRows(runtime.readRows(panel));
          preOpenSignature = beforeRows.length
            ? rowSignature(beforeRows)
            : null;
          const initialScroller = runtime.findScroller(panel);
          if (initialScroller) {
            const initialMetrics = runtime.metrics(initialScroller);
            if (Number.isFinite(initialMetrics.scrollTop)) {
              scrollerScrollTop = initialMetrics.scrollTop;
            }
          }
          if (
            typeof runtime.closePanel !== "function" ||
            runtime.closePanel(panel) !== true
          ) {
            throw new PanelRouteError("PANEL_STALE");
          }
          const clearDeadline = Math.min(
            operationDeadline,
            runtime.now() + STALE_PANEL_CLEAR_MS,
          );
          while (runtime.findVisiblePanel() && runtime.now() < clearDeadline) {
            await pause(
              Math.min(boundedPoll || DEFAULT_POLL_MS, clearDeadline - runtime.now()),
            );
          }
          if (runtime.findVisiblePanel()) {
            throw new PanelRouteError("PANEL_STALE");
          }
          panelDisappearedBeforeOpen = true;
          panel = null;
        }
        const entryEvidence = runtime.findTranscriptEntry({
          visibleOnly: false,
        });
        if (
          !initialTranscriptWasOpen &&
          !entryEvidence &&
          !evidenceAllowsPanel(eligibility)
        ) {
          throw new PanelRouteError("PANEL_INELIGIBLE");
        }

        if (!panel) {
          let entry = runtime.findTranscriptEntry({ visibleOnly: true });
          if (!entry) {
            const expansion = runtime.expandDescription();
            descriptionExpandedByModule = Boolean(expansion?.changed);
            descriptionControl = expansion?.control || null;
            if (descriptionExpandedByModule) await pause(boundedSettle);
            entry = runtime.findTranscriptEntry({ visibleOnly: true });
          }
          const open = await runtime.openTranscriptPanel(entry);
          const openedNow = Boolean(open?.opened);
          openedPanel = openedNow && !initialTranscriptWasOpen;
          overflowOpened = Boolean(open?.overflowOpened);
          if (!openedNow) {
            throw new PanelRouteError("PANEL_NO_ENTRY");
          }

          const panelDeadline = Math.min(
            operationDeadline,
            runtime.now() + 3_500,
          );
          while (!panel && runtime.now() < panelDeadline) {
            assertCurrent();
            panel = runtime.findVisiblePanel();
            if (panel) break;
            await pause(boundedPoll);
          }
          if (!panel) throw new PanelRouteError("PANEL_NOT_OPEN");
          freshPanelBound = true;
        }

        const panelError = runtime.panelErrorCode(panel);
        if (panelError) throw new PanelRouteError(panelError);

        let initialRows = [];
        const rowsDeadline = Math.min(
          operationDeadline,
          runtime.now() + 2_500,
        );
        while (runtime.now() < rowsDeadline) {
          assertCurrent();
          const panelErrorDuringWait = runtime.panelErrorCode(panel);
          if (panelErrorDuringWait) {
            throw new PanelRouteError(panelErrorDuringWait);
          }
          initialRows = normalizeRows(runtime.readRows(panel));
          if (initialRows.length) break;
          await pause(boundedPoll);
        }
        if (!initialRows.length) throw new PanelRouteError("PANEL_EMPTY");
        postOpenSignature = rowSignature(initialRows);
        if (
          initialTranscriptWasOpen &&
          (!panelDisappearedBeforeOpen || !freshPanelBound)
        ) {
          throw new PanelRouteError("PANEL_STALE");
        }
        if (
          preOpenSignature &&
          preOpenSignature === postOpenSignature &&
          !panelDisappearedBeforeOpen
        ) {
          throw new PanelRouteError("PANEL_STALE");
        }

        scroller = runtime.findScroller(panel);
        if (!scroller) {
          throw new PanelRouteError("PANEL_SCROLL_CONTAINER_UNKNOWN");
        }
        if (!initialTranscriptWasOpen) {
          scrollerScrollTop = runtime.metrics(scroller).scrollTop;
        }
        runtime.setScrollTop(scroller, 0);
        await pause(boundedSettle);

        const state = {
          rows: new Map(),
          coverageRanges: [],
          maxScrollHeight: 0,
          sawTop: false,
          sawMiddle: false,
          sawBottom: false,
          collects: 0,
        };
        let sample = collect(state);
        let iterations = 0;
        while (sample.metrics.scrollTop < sample.maxScrollTop - 4) {
          assertCurrent();
          if (iterations >= 500) {
            throw new PanelRouteError("PANEL_INCOMPLETE");
          }
          const step = Math.max(1, Math.floor(sample.metrics.clientHeight * 0.75));
          let next = Math.min(
            sample.maxScrollTop,
            sample.metrics.scrollTop + step,
          );
          if (
            next >= sample.maxScrollTop - 4 &&
            !state.sawMiddle &&
            sample.maxScrollTop > 8
          ) {
            next = Math.max(
              sample.metrics.scrollTop + 1,
              Math.floor(sample.maxScrollTop / 2),
            );
          }
          if (next <= sample.metrics.scrollTop) {
            throw new PanelRouteError("PANEL_INCOMPLETE");
          }
          runtime.setScrollTop(scroller, next);
          await pause(boundedSettle);
          sample = collect(state);
          iterations += 1;
        }
        await pause(boundedSettle);
        collect(state);

        const coverage = coverageMetrics(
          state.coverageRanges,
          state.maxScrollHeight,
        );
        if (
          !state.rows.size ||
          !state.sawTop ||
          !state.sawMiddle ||
          !state.sawBottom ||
          !coverage.complete
        ) {
          throw new PanelRouteError("PANEL_INCOMPLETE");
        }
        const rows = [...state.rows.values()].sort(
          (left, right) => left.start - right.start,
        );
        const panelLanguage = runtime.panelLanguage?.(panel) || null;
        const activeTrack = selectedTrackFromRequest(request);
        const selectedTrackEvidence = selectedTrackEvidenceFromRequest(request);
        const exactActiveTrack =
          activeTrack?.language && normalizeTrackKind(activeTrack.kind)
            ? {
                language: normalizeLanguage(activeTrack.language),
                kind: normalizeTrackKind(activeTrack.kind),
              }
            : null;
        const resolvedLanguage =
          panelLanguage ||
          (freshPanelBound ? exactActiveTrack?.language : null) ||
          null;
        const languageEvidence = panelLanguage
          ? "panel-explicit"
          : resolvedLanguage
            ? selectedTrackEvidence === "page-default"
              ? "page-default-track"
              : "active-exact-selected-track"
            : "unknown";
        const renderedTrack = {
          language: resolvedLanguage,
          kind: runtime.panelTrackKind?.(panel) || null,
        };
        const requestedLanguage = normalizeLanguage(
          request?.preferredLanguage || request?.language,
        );
        if (!renderedTrack.language) {
          throw new PanelRouteError("PANEL_LANGUAGE_UNVERIFIED");
        }
        if (
          requestedLanguage &&
          primaryLanguage(requestedLanguage) !==
            primaryLanguage(renderedTrack.language)
        ) {
          throw new PanelRouteError("PANEL_LANGUAGE_MISMATCH");
        }
        if (
          activeTrack?.language &&
          primaryLanguage(activeTrack.language) !==
            primaryLanguage(renderedTrack.language)
        ) {
          throw new PanelRouteError("PANEL_LANGUAGE_MISMATCH");
        }
        const requestedKind = normalizeTrackKind(request?.trackKind);
        if (
          requestedKind &&
          renderedTrack.kind &&
          requestedKind !== renderedTrack.kind
        ) {
          throw new PanelRouteError("PANEL_TRACK_MISMATCH");
        }
        if (
          normalizeTrackKind(activeTrack?.kind) &&
          renderedTrack.kind &&
          normalizeTrackKind(activeTrack.kind) !== renderedTrack.kind
        ) {
          throw new PanelRouteError("PANEL_TRACK_MISMATCH");
        }
        result = successResult(request, rows, eligibility, {
          elapsedMs: runtime.now() - startedAt,
          collectedRowCount: rows.length,
          collects: state.collects,
          coverageRatio: coverage.ratio,
          sawTop: state.sawTop,
          sawMiddle: state.sawMiddle,
          sawBottom: state.sawBottom,
          preOpenRowSignature: preOpenSignature,
          postOpenRowSignature: postOpenSignature,
          panelDisappearedBeforeOpen,
          panelLanguage: panelLanguage || null,
          languageEvidence,
          selectedTrackEvidence,
        }, renderedTrack, languageEvidence);
      } catch (error) {
        const status = error instanceof PanelRouteError
          ? error.status
          : "UNKNOWN";
        const code = error instanceof PanelRouteError
          ? error.code
          : "PANEL_DOM_CHANGED";
        result = failureResult(request, code, status, {
          elapsedMs: runtime.now() - startedAt,
          stopReason:
            error instanceof PanelRouteError
              ? error.stopReason
              : "unexpected-dom-error",
        });
      } finally {
        let restoration = { ok: true, errors: [] };
        if (snapshot) {
          try {
            restoration = await runtime.restore({
              snapshot,
              panel,
              scroller,
              scrollerScrollTop,
              openedPanel,
              overflowOpened,
              descriptionExpandedByModule,
              descriptionControl,
              deadline,
              pollMs: boundedPoll || DEFAULT_POLL_MS,
            });
          } catch {
            restoration = { ok: false, errors: ["PANEL_RESTORE_FAILED"] };
          }
        }
        if (restoration?.ok === false) {
          if (result?.status === "HAVE_TRANSCRIPT") {
            result = failureResult(request, "PANEL_RESTORE_FAILED", "UNKNOWN", {
              elapsedMs: runtime.now() - startedAt,
              restoreErrorCount: restoration.errors?.length || 1,
            });
          } else if (result?.diagnostics) {
            result.diagnostics.restoreErrorCount =
              restoration.errors?.length || 1;
          }
        } else if (result?.diagnostics) {
          result.diagnostics.pageRestored =
            restoration?.skippedForNavigation !== true;
          if (restoration?.skippedForNavigation) {
            result.diagnostics.restoreSkippedForNavigation = true;
          }
        }
        activeRunId = null;
        cancelRequested = false;
      }
      return result;
    }

    return { run, cancel };
  }

  const defaultInstance = create();
  return {
    moduleVersion: "2026-08-27.2",
    run: defaultInstance.run,
    cancel: defaultInstance.cancel,
    create,
    __testing: Object.freeze({
      MAX_TIMEOUT_MS,
      ROW_SELECTORS,
      MORE_ACTIONS_LABEL,
      normalizeText,
      normalizeLanguage,
      primaryLanguage,
      normalizeTrackKind,
      normalizeRunId,
      normalizeVideoId,
      videoIdFromUrl,
      parseTimestamp,
      normalizeRows,
      rowSignature,
      mergeCoverageRanges,
      coverageMetrics,
      formatTimestamp,
      rowsToSegments,
      evidenceAllowsPanel,
      eligibilityForRequest,
      createBrowserRuntime,
    }),
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.DIGESTDOCK_YOUTUBE_PANEL = DIGESTDOCK_YOUTUBE_PANEL;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = DIGESTDOCK_YOUTUBE_PANEL;
}
