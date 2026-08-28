import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  candidateNames,
  classifyError,
  collectPackageMetadata,
  createAttemptContext,
  expectationMet,
  experimentRoot,
  outcomeFromSummary,
  readJson,
  runCandidate,
  summarizeSegments
} from './core.mjs';
import {
  adaptCandidateFailure,
  adaptCandidateResult,
  toCandidateReport
} from './contract-adapter.mjs';

const VERIFIED_SECONDS_CANDIDATES = new Set([
  'youtube-caption-extractor',
  'youtube-transcript-plus',
  'youtubei.js'
]);

function integerEnv(name, fallback, minimum = 0) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function selectedValues(name, available) {
  const raw = process.env[name];
  if (!raw) return available;
  const requested = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const unknown = requested.filter((value) => !available.includes(value));
  if (unknown.length) throw new Error(`${name} contains unknown values: ${unknown.join(', ')}`);
  return requested;
}

function rotate(values, offset) {
  if (!values.length) return [];
  const normalized = offset % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function requestSummary(requests) {
  const endpointCounts = {};
  const statusCounts = {};
  for (const request of requests) {
    endpointCounts[request.endpoint] = (endpointCounts[request.endpoint] || 0) + 1;
    const status = request.status === undefined ? 'network-error' : String(request.status);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  return {
    requestCount: requests.length,
    endpointCounts,
    statusCounts,
    failedRequestCount: requests.filter((request) => request.error || request.ok === false).length
  };
}

function buildSummary(attempts, candidates) {
  return Object.fromEntries(candidates.map((candidate) => {
    const own = attempts.filter((attempt) => attempt.candidate === candidate);
    const positives = own.filter((attempt) => attempt.expectedOutcome === 'transcript');
    const negatives = own.filter((attempt) => attempt.expectedOutcome === 'no-caption');
    const languageBoundaries = own.filter((attempt) => attempt.expectedOutcome === 'language-unavailable');
    const successes = positives.filter((attempt) => attempt.outcome === 'transcript');
    const correctNegatives = negatives.filter((attempt) => attempt.outcome === 'no-caption');
    return [candidate, {
      attemptCount: own.length,
      expectedTranscriptCount: positives.length,
      transcriptSuccessCount: successes.length,
      transcriptSuccessRate: positives.length ? successes.length / positives.length : null,
      expectedNoCaptionCount: negatives.length,
      correctNoCaptionCount: correctNegatives.length,
      noCaptionAccuracy: negatives.length ? correctNegatives.length / negatives.length : null,
      expectedLanguageUnavailableCount: languageBoundaries.length,
      correctLanguageUnavailableCount: languageBoundaries.filter((attempt) => attempt.outcome === 'language-unavailable').length,
      languageUnavailableAccuracy: languageBoundaries.length
        ? languageBoundaries.filter((attempt) => attempt.outcome === 'language-unavailable').length / languageBoundaries.length
        : null,
      expectationMetCount: own.filter((attempt) => attempt.expectationMet).length,
      errorCount: own.filter((attempt) => attempt.outcome === 'error').length,
      medianDurationMs: median(own.map((attempt) => attempt.durationMs)),
      medianSuccessfulDurationMs: median(successes.map((attempt) => attempt.durationMs)),
      totalRequestCount: own.reduce((total, attempt) => total + attempt.requestSummary.requestCount, 0),
      errorCategories: own.reduce((counts, attempt) => {
        if (attempt.error?.category) counts[attempt.error.category] = (counts[attempt.error.category] || 0) + 1;
        return counts;
      }, {})
    }];
  }));
}

const caseConfig = await readJson(join(experimentRoot, 'cases.json'));
const profiles = await readJson(join(experimentRoot, 'profiles.json'));
const allCaseIds = caseConfig.cases.map((testCase) => testCase.id);
const caseIds = selectedValues('CASES', allCaseIds);
const candidates = selectedValues('CANDIDATES', candidateNames);
const cases = caseConfig.cases.filter((testCase) => caseIds.includes(testCase.id));
const rounds = integerEnv('ROUNDS', 1, 1);
const timeoutMs = integerEnv('TIMEOUT_MS', 20_000, 1_000);
const delayMs = integerEnv('DELAY_MS', 250, 0);
const attempts = [];
const startedAt = new Date().toISOString();
let stoppedForRateLimit = false;

console.log(`Running ${cases.length} cases × ${candidates.length} candidates × ${rounds} round(s)`);

matrix:
for (let round = 1; round <= rounds; round += 1) {
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const testCase = cases[caseIndex];
    const order = rotate(candidates, round + caseIndex - 1);
    for (const candidate of order) {
      const context = createAttemptContext(timeoutMs);
      const attemptStarted = performance.now();
      const attempt = {
        round,
        caseId: testCase.id,
        videoId: testCase.videoId,
        language: testCase.language,
        expectedOutcome: testCase.expectedOutcome,
        candidate
      };
      const contractIdentity = {
        runId: `node-r${round}-${caseIndex}-${candidate}`,
        requestId: `node-request-${attempts.length + 1}`,
        candidate,
        videoId: testCase.videoId
      };
      try {
        const result = await runCandidate(candidate, testCase, context);
        attempt.durationMs = Math.round(performance.now() - attemptStarted);
        attempt.segmentSummary = summarizeSegments(result.raw, result.segments);
        attempt.outcome = outcomeFromSummary(attempt.segmentSummary);
        attempt.selectedLanguage = result.selectedLanguage;
        attempt.selectionEvidence = result.selectionEvidence;
        if (result.initializationMs !== undefined) attempt.initializationMs = result.initializationMs;
        if (result.availableLanguageCount !== undefined) attempt.availableLanguageCount = result.availableLanguageCount;
        if (result.title !== undefined) attempt.returnedTitle = result.title;
        const contractResult =
          attempt.outcome !== 'transcript'
            ? adaptCandidateFailure({
                ...contractIdentity,
                category: attempt.outcome,
                elapsedMs: attempt.durationMs
              })
            : VERIFIED_SECONDS_CANDIDATES.has(candidate)
              ? adaptCandidateResult({
                  ...contractIdentity,
                  language: result.selectedLanguage || testCase.language || null,
                  languageEvidence: result.selectedLanguage ? 'verified' : 'unknown',
                  timeUnitEvidence: 'seconds-verified',
                  segments: result.segments,
                  elapsedMs: attempt.durationMs,
                  requestCounts: requestSummary(context.requests).endpointCounts
                })
              : adaptCandidateFailure({
                  ...contractIdentity,
                  category: 'time-unit-unverified',
                  elapsedMs: attempt.durationMs
                });
        attempt.contractReport = toCandidateReport(contractResult, {
          category: testCase.category,
          caseId: testCase.id,
          expectedOutcome: testCase.expectedOutcome,
          runIndex: round
        });
      } catch (error) {
        attempt.durationMs = Math.round(performance.now() - attemptStarted);
        attempt.error = classifyError(error);
        attempt.outcome = ['no-caption', 'language-unavailable'].includes(attempt.error.category)
          ? attempt.error.category
          : 'error';
        attempt.segmentSummary = null;
        attempt.contractReport = toCandidateReport(
          adaptCandidateFailure({
            ...contractIdentity,
            category: attempt.error.category,
            elapsedMs: attempt.durationMs
          }),
          {
            category: testCase.category,
            caseId: testCase.id,
            expectedOutcome: testCase.expectedOutcome,
            runIndex: round
          }
        );
      } finally {
        context.dispose();
      }
      attempt.requests = context.requests;
      attempt.requestSummary = requestSummary(context.requests);
      const hitRateLimit =
        attempt.error?.category === 'rate-limited' ||
        Object.hasOwn(attempt.requestSummary.statusCounts, '429');
      if (hitRateLimit && attempt.error?.category !== 'rate-limited') {
        attempt.error = {
          name: 'RateLimitedError',
          message: 'HTTP 429 rate limited',
          category: 'rate-limited'
        };
        attempt.outcome = 'error';
        attempt.segmentSummary = null;
        attempt.contractReport = toCandidateReport(
          adaptCandidateFailure({
            ...contractIdentity,
            category: 'rate-limited',
            elapsedMs: attempt.durationMs
          }),
          {
            category: testCase.category,
            caseId: testCase.id,
            expectedOutcome: testCase.expectedOutcome,
            runIndex: round
          }
        );
      }
      attempt.expectationMet = expectationMet(testCase, attempt.outcome);
      attempts.push(attempt);
      const marker = attempt.expectationMet ? 'PASS' : 'MISS';
      console.log(
        `${marker} r${round} ${testCase.id} ${candidate}: ${attempt.outcome} ` +
        `${attempt.segmentSummary?.segmentCount ?? 0} segments, ${attempt.durationMs} ms, ` +
        `${attempt.requestSummary.requestCount} requests` +
        (attempt.error ? `, ${attempt.error.category}` : '')
      );
      if (hitRateLimit) {
        stoppedForRateLimit = true;
        console.warn('STOP rate-limited: skipped the remaining matrix after the first HTTP 429.');
        break matrix;
      }
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const resultName = process.env.RESULT_NAME || 'latest';
if (!/^[a-z0-9][a-z0-9-]*$/.test(resultName)) {
  throw new Error('RESULT_NAME must contain only lowercase letters, numbers, and hyphens');
}

const output = {
  schemaVersion: 1,
  startedAt,
  completedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    authentication: 'signed-out',
    apiKeys: false,
    cookies: false,
    proxy: false,
    timeoutMs,
    delayMs,
    rounds,
    candidateOrderPolicy: 'rotated per case and round',
    stoppedEarly: stoppedForRateLimit,
    stopReason: stoppedForRateLimit ? 'rate-limited' : null
  },
  caseSource: caseConfig.sourceCorpus,
  cases,
  profiles,
  packageMetadata: await collectPackageMetadata(profiles),
  summary: buildSummary(attempts, candidates),
  attempts
};

const resultsDirectory = join(experimentRoot, 'results');
await mkdir(resultsDirectory, { recursive: true });
const resultPath = join(resultsDirectory, `${resultName}.json`);
await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${resultPath}`);
