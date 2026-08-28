import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import he from 'he';
import { getSubtitles } from 'youtube-caption-extractor';
import { fetchTranscript as fetchTranscriptBasic } from 'youtube-transcript';
import { fetchTranscript as fetchTranscriptPlus } from 'youtube-transcript-plus';
import { Innertube } from 'youtubei.js';

export const experimentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function truncate(value, maxLength = 500) {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '<unparseable-url>';
  }
}

export function sanitizeMessage(value) {
  return truncate(String(value ?? '').replace(/https?:\/\/[^\s"')]+/g, (url) => safeUrl(url)));
}

function endpointKind(url) {
  const path = safeUrl(url);
  if (path.includes('/youtubei/v1/get_transcript')) return 'get_transcript';
  if (path.includes('/youtubei/v1/player')) return 'player';
  if (path.includes('/youtubei/v1/next')) return 'next';
  if (path.includes('/youtubei/v1/visitor_id')) return 'visitor_id';
  if (path.includes('/api/timedtext')) return 'timedtext';
  if (path.includes('/watch')) return 'watch_page';
  return 'other';
}

function mergeSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

export function createAttemptContext(timeoutMs, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`attempt timed out after ${timeoutMs} ms`)), timeoutMs);
  const requests = [];

  async function trackedFetch(input, init = {}) {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error('attempt aborted');
    }
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const method = init.method || (typeof input === 'object' && input?.method) || 'GET';
    const requestStarted = performance.now();
    const record = {
      method,
      endpoint: endpointKind(rawUrl),
      url: safeUrl(rawUrl)
    };

    try {
      const response = await fetchImpl(input, {
        ...init,
        signal: mergeSignals(controller.signal, init.signal)
      });
      record.status = response.status;
      record.ok = response.ok;
      record.durationMs = round(performance.now() - requestStarted);
      record.contentType = response.headers.get('content-type');
      const contentLength = finiteNumber(response.headers.get('content-length'));
      record.contentLength = contentLength;
      if (response.status === 429) {
        const error = new Error('HTTP 429 rate limited');
        error.name = 'RateLimitedError';
        error.status = 429;
        controller.abort(error);
        throw error;
      }
      requests.push(record);
      return response;
    } catch (error) {
      record.durationMs = round(performance.now() - requestStarted);
      record.error = {
        name: error?.name || 'Error',
        message: sanitizeMessage(error?.message || error)
      };
      requests.push(record);
      throw error;
    }
  }

  return {
    controller,
    requests,
    trackedFetch,
    dispose() {
      clearTimeout(timeout);
    }
  };
}

function normalizeCaptionExtractor(raw) {
  return raw.map((segment) => ({
    text: String(segment.text ?? ''),
    offsetSeconds: finiteNumber(segment.start),
    durationSeconds: finiteNumber(segment.dur)
  }));
}

function normalizeTranscript(raw) {
  return raw.map((segment) => ({
    text: String(segment.text ?? ''),
    offsetSeconds: finiteNumber(segment.offset),
    durationSeconds: finiteNumber(segment.duration)
  }));
}

function languageDisplayName(languageCode, choices) {
  const normalized = choices.map((choice) => ({ choice, lower: choice.toLowerCase() }));
  const exact = {
    en: ['english'],
    'zh-tw': ['chinese (traditional)', 'traditional chinese', '繁體中文', '中文（繁體）'],
    'zh-cn': ['chinese (simplified)', 'simplified chinese', '简体中文', '中文（简体）'],
    ja: ['japanese', '日本語'],
    es: ['spanish', 'español'],
    fr: ['french', 'français']
  }[languageCode.toLowerCase()] || [];

  for (const target of exact) {
    const match = normalized.find(({ lower }) => lower === target);
    if (match) return match.choice;
  }
  if (languageCode.toLowerCase() === 'en') {
    return normalized.find(({ lower }) => lower.startsWith('english'))?.choice ?? null;
  }
  return null;
}

const adapters = {
  async 'youtube-caption-extractor'(testCase, context) {
    const options = {
      videoID: testCase.videoId,
      fetch: context.trackedFetch
    };
    if (testCase.language) options.lang = testCase.language;
    const raw = await getSubtitles(options);
    return {
      raw,
      segments: normalizeCaptionExtractor(raw),
      selectedLanguage: null,
      selectionEvidence: testCase.language
        ? `not-exposed-by-result; requested=${testCase.language}; library-can-fallback`
        : 'not-exposed-by-result; library-default-en'
    };
  },

  async 'youtube-transcript'(testCase, context) {
    const config = { fetch: context.trackedFetch };
    if (testCase.language) config.lang = testCase.language;
    const raw = await fetchTranscriptBasic(testCase.videoId, config);
    return {
      raw,
      segments: normalizeTranscript(raw),
      selectedLanguage: raw[0]?.lang ?? testCase.language ?? null,
      selectionEvidence: 'result-lang-field'
    };
  },

  async 'youtube-transcript-plus'(testCase, context) {
    const hook = ({ url, method = 'GET', body, headers, signal }) =>
      context.trackedFetch(url, { method, body, headers, signal });
    const config = {
      retries: 0,
      signal: context.controller.signal,
      videoFetch: hook,
      playerFetch: hook,
      transcriptFetch: hook
    };
    if (testCase.language) config.lang = testCase.language;
    const raw = await fetchTranscriptPlus(testCase.videoId, config);
    return {
      raw,
      segments: normalizeTranscript(raw),
      selectedLanguage: raw[0]?.lang ?? testCase.language ?? null,
      selectionEvidence: 'result-lang-field'
    };
  },

  async 'youtubei.js'(testCase, context) {
    const initStarted = performance.now();
    const innertube = await Innertube.create({
      fetch: context.trackedFetch,
      generate_session_locally: true,
      retrieve_player: false,
      lang: 'en',
      location: 'US'
    });
    const initializationMs = round(performance.now() - initStarted);
    const info = await innertube.getInfo(testCase.videoId);
    let transcriptInfo = await info.getTranscript();

    if (testCase.language) {
      const target = languageDisplayName(testCase.language, transcriptInfo.languages);
      if (!target) {
        const error = new Error(
          `Requested language ${testCase.language} was not found in transcript menu: ${transcriptInfo.languages.join(', ')}`
        );
        error.name = 'RequestedLanguageNotFoundError';
        throw error;
      }
      if (transcriptInfo.selectedLanguage !== target) {
        transcriptInfo = await transcriptInfo.selectLanguage(target);
      }
    }

    const raw = (transcriptInfo.transcript?.content?.body?.initial_segments ?? []).filter(
      (item) => item && 'snippet' in item && 'start_ms' in item && 'end_ms' in item
    );
    const segments = raw.map((segment) => {
      const startMs = finiteNumber(segment.start_ms);
      const endMs = finiteNumber(segment.end_ms);
      return {
        text: segment.snippet?.toString() ?? '',
        offsetSeconds: startMs === null ? null : startMs / 1000,
        durationSeconds: startMs === null || endMs === null ? null : (endMs - startMs) / 1000
      };
    });
    return {
      raw,
      segments,
      initializationMs,
      title: info.basic_info?.title ?? null,
      selectedLanguage: transcriptInfo.selectedLanguage || null,
      availableLanguageCount: transcriptInfo.languages.length,
      selectionEvidence: 'transcript-menu-selected-language'
    };
  }
};

export const candidateNames = Object.freeze(Object.keys(adapters));

export async function runCandidate(candidate, testCase, context) {
  const adapter = adapters[candidate];
  if (!adapter) throw new Error(`Unknown candidate: ${candidate}`);
  return adapter(testCase, context);
}

export function classifyError(error) {
  const name = String(error?.name || 'Error');
  const message = sanitizeMessage(error?.message || error);
  const combined = `${name} ${message}`.toLowerCase();
  let category = 'unknown-error';
  if (combined.includes('abort') || combined.includes('timed out')) category = 'timeout';
  else if (combined.includes('too many') || combined.includes('429') || combined.includes('rate')) category = 'rate-limited';
  else if (
    combined.includes('notavailablelanguage') ||
    combined.includes('available languages:') ||
    (combined.includes('language') && (combined.includes('not found') || combined.includes('not available')))
  ) category = 'language-unavailable';
  else if (
    combined.includes('transcriptdisabled') ||
    combined.includes('transcripts are disabled') ||
    combined.includes('transcript is disabled') ||
    combined.includes('no transcripts are available') ||
    combined.includes('no transcript') ||
    combined.includes('transcript panel not found') ||
    combined.includes('engagement panels not found')
  ) category = 'no-caption';
  else if (combined.includes('video unavailable') || combined.includes('not playable')) category = 'video-unavailable';
  else if (combined.includes('failed with status code') || combined.includes('failed precondition')) category = 'upstream-api-error';
  else if (combined.includes('fetch failed') || combined.includes('network')) category = 'network-error';
  return { name, message, category };
}

export function summarizeSegments(raw, segments) {
  const normalized = segments.filter((segment) => segment.text.trim());
  const offsets = normalized.map((segment) => segment.offsetSeconds).filter(Number.isFinite);
  const durations = normalized.map((segment) => segment.durationSeconds).filter(Number.isFinite);
  const text = normalized.map((segment) => segment.text.trim()).join('\n');
  const canonicalText = he
    .decode(normalized.map((segment) => segment.text).join(' '))
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
  let nonMonotonicOffsets = 0;
  for (let index = 1; index < offsets.length; index += 1) {
    if (offsets[index] < offsets[index - 1]) nonMonotonicOffsets += 1;
  }
  const maxEndSeconds = normalized.reduce((max, segment) => {
    if (!Number.isFinite(segment.offsetSeconds) || !Number.isFinite(segment.durationSeconds)) return max;
    return Math.max(max, segment.offsetSeconds + segment.durationSeconds);
  }, 0);

  return {
    segmentCount: normalized.length,
    textCharacterCount: text.length,
    contentSha256: text ? createHash('sha256').update(text).digest('hex') : null,
    canonicalTextCharacterCount: canonicalText.length,
    canonicalContentSha256: canonicalText
      ? createHash('sha256').update(canonicalText).digest('hex')
      : null,
    firstRawItemKeys: raw[0] ? Object.keys(raw[0]).sort() : [],
    normalizedFieldTypes: normalized[0]
      ? Object.fromEntries(Object.entries(normalized[0]).map(([key, value]) => [key, typeof value]))
      : {},
    firstOffsetSeconds: offsets.length ? round(offsets[0], 3) : null,
    maxEndSeconds: round(maxEndSeconds, 3),
    maxDurationSeconds: durations.length ? round(Math.max(...durations), 3) : null,
    nonMonotonicOffsets
  };
}

export function outcomeFromSummary(summary) {
  return summary.segmentCount > 0 ? 'transcript' : 'no-caption';
}

export function expectationMet(testCase, outcome) {
  return testCase.expectedOutcome === outcome;
}

async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

async function packageClosure(packageName, seen = new Set()) {
  if (seen.has(packageName)) return seen;
  seen.add(packageName);
  const packagePath = join(experimentRoot, 'node_modules', ...packageName.split('/'), 'package.json');
  const manifest = await readJson(packagePath);
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    await packageClosure(dependency, seen);
  }
  return seen;
}

export async function collectPackageMetadata(profiles) {
  const results = {};
  for (const candidate of candidateNames) {
    const packageName = profiles[candidate].package;
    const packagePath = join(experimentRoot, 'node_modules', ...packageName.split('/'));
    const manifest = await readJson(join(packagePath, 'package.json'));
    const closure = [...(await packageClosure(packageName))];
    let installedFootprintBytes = 0;
    for (const dependency of closure) {
      installedFootprintBytes += await directorySize(
        join(experimentRoot, 'node_modules', ...dependency.split('/'))
      );
    }
    const metadata = {
      version: manifest.version,
      license: manifest.license || null,
      nodeEngine: manifest.engines?.node || null,
      directRuntimeDependencies: Object.keys(manifest.dependencies || {}),
      transitivePackageCountIncludingSelf: closure.length,
      packageBytes: await directorySize(packagePath),
      installedFootprintBytes
    };
    if (candidate === 'youtubei.js') {
      const browserBundle = await readFile(join(packagePath, 'bundle', 'browser.js'));
      metadata.browserBundleBytes = browserBundle.length;
      metadata.browserBundleGzipBytes = gzipSync(browserBundle).length;
    }
    results[candidate] = metadata;
  }
  return results;
}
