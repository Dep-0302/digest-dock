import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyError,
  createAttemptContext,
  expectationMet,
  outcomeFromSummary,
  safeUrl,
  summarizeSegments
} from '../src/core.mjs';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => String(body)
  };
}

test('safeUrl drops API keys and timedtext tokens', () => {
  assert.equal(
    safeUrl('https://www.youtube.com/youtubei/v1/player?key=secret&prettyPrint=false'),
    'https://www.youtube.com/youtubei/v1/player'
  );
  assert.equal(
    safeUrl('https://www.youtube.com/api/timedtext?v=abc&expire=123&signature=secret'),
    'https://www.youtube.com/api/timedtext'
  );
});

test('summarizeSegments stores raw and canonical hashes but no transcript body', () => {
  const raw = [{ text: 'Hello&nbsp;  world', start: '1.5', dur: '2.25' }];
  const normalized = [{ text: 'Hello&nbsp;  world', offsetSeconds: 1.5, durationSeconds: 2.25 }];
  const summary = summarizeSegments(raw, normalized);
  assert.equal(summary.segmentCount, 1);
  assert.equal(summary.textCharacterCount, 18);
  assert.equal(summary.canonicalTextCharacterCount, 11);
  assert.equal(summary.firstOffsetSeconds, 1.5);
  assert.equal(summary.maxEndSeconds, 3.75);
  assert.equal(summary.contentSha256.length, 64);
  assert.equal(summary.canonicalContentSha256.length, 64);
  assert.equal(JSON.stringify(summary).includes('Hello'), false);
});

test('classifyError separates clean no-caption and upstream API failures', () => {
  assert.equal(
    classifyError(new Error('Transcript panel not found. Video likely has no transcript.')).category,
    'no-caption'
  );
  assert.equal(
    classifyError(new Error('[YoutubeTranscript] 🚨 Transcript is disabled on this video (abc)')).category,
    'no-caption'
  );
  assert.equal(
    classifyError(new Error('No transcripts are available in fr. Available languages: en, de')).category,
    'language-unavailable'
  );
  assert.equal(
    classifyError(new Error('Request to https://www.youtube.com/youtubei/v1/get_transcript?key=x failed with status code 400')).category,
    'upstream-api-error'
  );
});

test('attempt context aborts all later transport after the first HTTP 429', async () => {
  let calls = 0;
  const context = createAttemptContext(1_000, async () => {
    calls += 1;
    return response('rate limited', 429);
  });

  await assert.rejects(
    context.trackedFetch('https://www.youtube.com/youtubei/v1/player'),
    (error) => error.name === 'RateLimitedError' && error.status === 429
  );
  await assert.rejects(
    context.trackedFetch('https://www.youtube.com/api/timedtext'),
    (error) => error.name === 'RateLimitedError' && error.status === 429
  );
  assert.equal(calls, 1);
  assert.equal(context.requests.length, 1);
  assert.equal(context.requests[0].status, 429);
  assert.equal(classifyError(context.requests[0].error).category, 'rate-limited');
  context.dispose();
});

test('outcome and expectation comparison keep errors distinct from negatives', () => {
  assert.equal(outcomeFromSummary({ segmentCount: 3 }), 'transcript');
  assert.equal(outcomeFromSummary({ segmentCount: 0 }), 'no-caption');
  assert.equal(expectationMet({ expectedOutcome: 'no-caption' }, 'no-caption'), true);
  assert.equal(expectationMet({ expectedOutcome: 'no-caption' }, 'error'), false);
});
