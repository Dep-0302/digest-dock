import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(root, 'extension');
const resultsPath = join(root, 'results', 'latest.json');
const reportPath = join(root, 'results', 'latest.md');
const chromePath = process.env.MV3_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profilePath = await mkdtemp(join(tmpdir(), 'youtube-digest-mv3-probe-'));

const cases = [
  { id: 'manual-english-short', videoId: 'jNQXAC9IVRw', language: 'en', expectation: 'transcript' },
  { id: 'automatic-english-long', videoId: 'KLDVxx4TqcE', language: 'en', expectation: 'transcript' },
  { id: 'spoken-no-caption', videoId: '4OEG33NfEK0', language: 'en', expectation: 'no-caption' }
];
const profiles = ['IOS', 'ANDROID_VR', 'MWEB'];
const startedAt = new Date().toISOString();
let context;
let probe;

function chromeVersion() {
  try {
    return execFileSync(chromePath, ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    return `unavailable: ${String(error?.message || error).slice(0, 160)}`;
  }
}

function safeError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    message: String(error?.message || error)
      .replace(/https?:\/\/[^\s"')]+/gu, '<redacted-url>')
      .replaceAll(profilePath, '<temporary-profile>')
      .slice(0, 600)
  };
}

try {
  context = await chromium.launchPersistentContext(profilePath, {
    executablePath: chromePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-proxy-server',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  let worker = context.serviceWorkers().find((candidate) => candidate.url().endsWith('/service-worker.js'));
  if (!worker) {
    try {
      worker = await context.waitForEvent('serviceworker', {
        predicate: (candidate) => candidate.url().endsWith('/service-worker.js'),
        timeout: 8_000
      });
    } catch {
      // Classified below as a real side-load blocker.
    }
  }

  if (!worker) {
    probe = {
      status: 'blocked',
      blocker: 'extension-service-worker-not-observed',
      detail: 'Branded system Chrome headless did not expose the unpacked MV3 service worker within 8 seconds. No user Chrome profile was used.'
    };
  } else {
    const output = await worker.evaluate(
      (config) => globalThis.runTranscriptProbe(config),
      { cases, profiles, timeoutMs: 12_000 }
    );
    probe = { status: 'completed', ...output };
  }
} catch (error) {
  probe = {
    status: 'blocked',
    blocker: 'browser-launch-or-side-load-failed',
    stage: 'browser-launch-before-cdp',
    attempts: [],
    error: safeError(error)
  };
} finally {
  if (context) await context.close().catch(() => {});
  await rm(profilePath, { recursive: true, force: true });
}

const result = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  environment: {
    chrome: chromeVersion(),
    chromeExecutable: chromePath,
    playwrightCore: '1.62.1',
    mode: 'headless',
    profile: 'fresh-temporary-profile-removed-after-run',
    proxy: 'disabled-with---no-proxy-server',
    cookieInput: 'none; extension fetch uses credentials=omit',
    apiKeyInput: 'none',
    extensionSource: 'unpacked-local-directory'
  },
  cases,
  profiles,
  probe
};

const attempts = probe.attempts || [];
const lines = [
  '# MV3 service worker transcript probe',
  '',
  `- Result: **${probe.status}**${probe.blocker ? ` — ${probe.blocker}` : ''}`,
  `- Browser: ${result.environment.chrome}`,
  '- Isolation: fresh temporary profile, removed after run; no user Chrome profile',
  '- Inputs: no API key, no Cookie, no proxy; all extension fetches use `credentials: omit`',
  '- Privacy: no transcript body, caption URL, query token, request body, or player payload is persisted',
  ''
];
if (probe.detail) lines.push(`Blocker: ${probe.detail}`, '');
if (probe.stage) lines.push(`Reached stage: ${probe.stage}. No MV3 or YouTube request claim can be made.`, '');
if (attempts.length) {
  lines.push('| Case | Client | Outcome | Tracks | Segments | Player ms | Timedtext ms | SHA-256 |', '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const attempt of attempts) {
    lines.push(`| ${attempt.caseId} | ${attempt.profile} | ${attempt.outcome} | ${attempt.trackCount ?? '—'} | ${attempt.segmentCount ?? '—'} | ${attempt.playerRequest?.durationMs ?? '—'} | ${attempt.timedtextRequest?.durationMs ?? '—'} | ${attempt.canonicalContentSha256?.slice(0, 12) || '—'} |`);
  }
  lines.push('');
}
lines.push('This is a browser/MV3 transport observation, not a guarantee about future undocumented YouTube behavior.', '');

await mkdir(dirname(resultsPath), { recursive: true });
await writeFile(resultsPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ status: probe.status, blocker: probe.blocker || null, attempts: attempts.length }, null, 2));
