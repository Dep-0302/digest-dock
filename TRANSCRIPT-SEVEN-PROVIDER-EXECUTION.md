# Seven-provider YouTube transcript experiment

Status date: 2026-08-25 (America/Los_Angeles)

## Goal

Build seven isolated transcript-source experiments in the worktree
`/Users/wangchao/Documents/youtube-digest-transcript-source-comparison-v2`,
then let the user run real-video checks after the next Codex quota reset. The
experiment exists to remove weaker routes with evidence; it does not authorize
changes to `main`, a merge, a push, or a release.

## Frozen baseline

- Branch: `codex/transcript-source-comparison-v2`
- Historical experiment baseline: `7e15275` (`Snapshot UI and transcript work
  before provider split`).
- Seven-provider checkpoint commits: `f491210` and `bd65972`.
- Mainline synchronized from local `main` commit `b45b42a` (DigestDock 1.4.4)
  on 2026-08-25. The repository root now follows API-primary `main`.
- The active local extractor is preserved only at
  `experiments/transcript-sources/youtube-active/youtube-transcript.js`; it is
  not restored to the public/root extension.
- Historical comparison evidence has been migrated under
  `experiments/transcript-sources` without generated dependency folders in Git.

## Fixed provider IDs

These names are the canonical IDs for code, fixtures, reports, and tomorrow's
manual checks.

1. `youtube-passive` — passively consume a YouTube `timedtext` response that
   the page already requested. It must create zero additional `timedtext`
   requests.
2. `youtube-active` — the current `captionTracks` plus bounded `timedtext` and
   non-WEB player-client adapter.
3. `youtube-panel` — read the transcript already rendered in YouTube's
   Transcript panel. It must never silently return segments belonging to the
   previous SPA video.
4. `supadata-native` — the existing `mode=native` provider, used only after an
   explicit per-attempt user action.
5. `node-libraries` — comparison harness for representative Node transcript
   libraries. Third-party packages remain experiment-only and are never added
   to the public extension ZIP.
6. `local-helper` — `youtube-transcript-api` is the primary local-helper
   candidate; `yt-dlp` remains a secondary comparator. The helper is not a
   production dependency unless later evidence justifies its installation and
   support burden.
7. `hosted-api-slot` — a provider-neutral contract and fixture-tested adapter
   slot. No real vendor request is implemented until the user selects a
   vendor and its current API, price, privacy, and key requirements are checked.

The YouTube Data API, Downie, ASR, OCR, proxy rotation, and access-control
bypasses are outside this seven-provider comparison.

## Non-negotiable experiment contract

- Exactly one provider is active in a measured run. Automatic fallback is
  disabled for comparison runs.
- A successful result has the shared fields `transcript`, `transcriptText`,
  `transcriptTextTimestamped`, `language`, `languageEvidence`, `providerId`,
  `providerVariant`, `runId`, `requestId`, and `diagnostics`.
- Failure codes are explicit and never infer `NO_TRANSCRIPT` from a transport
  failure. Shared codes include `NO_TRANSCRIPT`, `TRACK_UNAVAILABLE`,
  `EMPTY_TRANSCRIPT`, `PROBE_FAILED`, `NETWORK_ERROR`,
  `RESPONSE_TOO_LARGE`, `RATE_LIMITED`, `LOGIN_REQUIRED`,
  `VIDEO_UNAVAILABLE`, `PAGE_CONTEXT_CHANGED`, `TIMEOUT`,
  `PROVIDER_UNAVAILABLE`, and `INVALID_RESPONSE`.
- Temporary signed caption URLs, API keys, cookies, authorization headers, and
  raw personal transcript text never enter committed diagnostics.
- Browser results bind to the active `tabId`, canonical 11-character
  `videoId`, source language, and SPA generation. A stale video result fails
  closed.
- Every network-capable route records request counts by endpoint class without
  recording query strings or signed URLs.
- The passive route is disqualified if it needs to initiate a caption request,
  modifies the page's response, captures a different video, or cannot uninstall
  its hooks cleanly for a comparison run.
- Real YouTube, Supadata, hosted-provider, or translation requests are not run
  during implementation. Tomorrow's user-driven run is a separate stage.

## Test surfaces

### Browser/extension surface

- `youtube-passive`
- `youtube-active`
- `youtube-panel`
- `supadata-native`

These use public videos in the user's Chrome only during the later manual
stage. The passive experiment must be installed before a fresh video load;
the panel experiment requires the current video's Transcript panel to be open.

### Local benchmark surface

- `node-libraries`
- `local-helper`
- `hosted-api-slot`

Node and Python dependencies stay inside `experiments/transcript-sources`.
Generated `node_modules`, virtual environments, caches, and credential files
remain ignored and uncommitted.

## Shared comparison dimensions

- public manual captions
- public ASR captions
- multiple languages and requested-language fidelity
- long-form video
- no-caption and unavailable boundaries
- SPA navigation freshness
- normalized text/timestamp fidelity
- elapsed time and segment count
- new player and `timedtext` request counts
- 429, empty-body, timeout, and retry behavior
- cookies, credentials, third-party transfer, and local-service requirements
- install size, runtime requirements, and maintenance exposure

## Implementation sequence

1. Migrate the reusable historical corpus, schemas, runners, and reports into
   this worktree, excluding generated dependencies and caches.
2. Add a canonical provider registry, shared result validator, sanitized
   diagnostics, and fixture-only tests.
3. Add the passive MAIN-world observer and isolated-world bridge as a standalone
   experimental MV3 probe. It must observe XHR/fetch responses without changing
   them and expose no signed URL.
4. Normalize the existing active adapter and Transcript-panel runner into the
   shared result schema.
5. Preserve Supadata as the explicit-consent control; do not make implementation
   tests spend provider quota.
6. Preserve and test the Node/Python harnesses without installing or updating
   third-party packages in this stage.
7. Add a hosted-provider contract template with fake responses only.
8. Run repository tests, release checks, package checks, experiment-unit tests,
   and `git diff --check`. The public package must not include experiment-only
   dependencies or results.
9. Update this file with the observed completion state and tomorrow's exact
   manual commands.

## Tomorrow's manual acceptance contract

Before real runs, record the Chrome extension ID and verify that the unpacked
path is this exact worktree. Disable other DigestDock development copies for
measured runs unless a coexistence case is explicitly being tested.

For each public corpus case:

1. Start from a fresh navigation and record the selected provider ID.
2. Clear only experiment-run state; do not delete user notes or normal settings.
3. Run one provider once. Do not allow automatic fallback.
4. Record success/failure, language, segment count, elapsed time, endpoint-class
   request counts, and sanitized failure diagnostics.
5. Confirm the first and last timestamps and compare a small sample of text.
6. Navigate to a second video and confirm no prior-video transcript is accepted.
7. Stop after the first 429 and observe the cooldown; do not amplify it with
   retries.

Copy `experiments/transcript-sources/manual-run-template.json` for each measured
run, save it under `manual-results/`, and store only text-free metrics and
categorical notes. After testing, run `npm run report:manual` from
`experiments/transcript-sources` to generate the comparison table.

Supadata and any later hosted provider require a separate visible consent action
for every real attempt. Declining a third-party request must send nothing.

### Recommended run order

Use the existing public corpus, but start with one short authored-caption video,
one long ASR video, and one known no-caption boundary. Expand only after those
three discriminate the routes.

1. `youtube-passive` — load unpacked from
   `experiments/transcript-sources/passive-capture/extension`. Disable the
   active DigestDock copy for this measured run, refresh the video after the
   probe is loaded, manually enable CC, and confirm
   `requestsInitiated: 0`.
2. `youtube-panel` — load unpacked from
   `experiments/transcript-sources/browser-panel/manual-probe`. Manually open
   the current video's Transcript panel. Collect once at the top, once per
   visible scroll screen, and once at the bottom. Finalization must report both
   `sawTop` and `sawBottom`.
   The probe also requires continuous scroll coverage. A non-scrollable/unknown
   panel shape returns `PANEL_SCROLL_CONTAINER_UNKNOWN`; this is a valid failure,
   not permission to label visible rows as a complete transcript.
3. `youtube-active` — load unpacked from
   `experiments/transcript-sources/youtube-verifier`. The worktree root follows
   API-primary main and is not the active-local test surface. Treat a verifier
   failure as that provider's result; do not fall through to Supadata.
4. Stop all same-IP YouTube probes immediately after the first 429. Do not use
   repeated retries to manufacture another result.
5. `node-libraries` — from `experiments/transcript-sources/node-libraries`, run
   a small explicit matrix, one round and one candidate variant at a time. For
   example:

   ```bash
   CASES=many-tracks-authored-en CANDIDATES=youtube-transcript-plus \
   ROUNDS=1 TIMEOUT_MS=20000 DELAY_MS=1000 RESULT_NAME=manual-plus npm run probe
   RESULT_NAME=manual-plus npm run report
   ```

6. `local-helper` — load unpacked from
   `experiments/transcript-sources/local-helper/extension`. Copy its exact
   action and open its stable test tab. Copy the displayed extension Origin
   into the helper terminal. Generate a fresh token
   locally, keep it in that shell only, and start the already-installed venv:

   ```bash
   cd experiments/transcript-sources/local-helper
   export DIGESTDOCK_TRANSCRIPT_HELPER_ORIGIN="chrome-extension://<exact-id>"
   export DIGESTDOCK_TRANSCRIPT_HELPER_TOKEN="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))')"
   printf '%s\n' "$DIGESTDOCK_TRANSCRIPT_HELPER_TOKEN"
   .venv/bin/python server.py --port 8765
   ```

   First click **只检查连接**; it must report `networkRequests: 0`. Then stop the
   helper and restart the final command with `--allow-live` before the one
   user-authorized transcript attempt. The one-time terminal value is pasted
   only into the probe password field; never paste it into chat, a file, URL,
   log, screenshot, or commit.
7. `supadata-native` — load unpacked from
   `experiments/transcript-sources/supadata-native/manual-probe`. Its action
   opens a stable test tab so long-job polling is not lost when a popup closes.
   Enter the key yourself and click the explicit per-attempt button. Run it
   separately from the active adapter so its result is not preceded by a local
   probe.
8. `hosted-api-slot` remains non-runnable until a vendor is selected and its
   current contract/privacy/price are reviewed. Its correct current result is
   `PROVIDER_UNAVAILABLE` with zero fetches.

Disable or remove each standalone probe before loading the next measured
provider. Never enable passive and active routes together for evidence capture.

### Installed experiment dependencies

- `node-libraries/node_modules` was installed from the checked-in lockfile with
  `npm ci`; `npm audit --omit=dev --audit-level=high` reported 0 vulnerabilities.
- `local-helper/.venv` contains `youtube-transcript-api==1.2.4` and its isolated
  dependencies.
- `cli-tools/.venv312` contains `youtube-transcript-api==1.2.4` and
  `yt-dlp==2026.7.4` for the historical two-tool comparator.
- All three generated dependency directories are ignored and are not release
  files.

### Pre-sync verification completed on 2026-08-23

The following evidence predates the 2026-08-25 mainline merge. It proves the
seven-provider checkpoint before synchronization, not the merged 1.4.4 state.
Per user instruction, post-merge tests are deliberately deferred to the next
testing stage.

- Root `npm test`: 236/236 passed.
- Root `npm run check`: passed; 29 public allowlisted files.
- Root `npm run package`: passed after granting write access to this worktree;
  local ZIP `dist/digest-dock-v1.4.0.zip` has SHA-256
  `4e5a5f1c52803e38a433f799dac84633d8555c8dee98beba30c8c2c4ecfb9ec9`.
- ZIP entry inspection contains only the 29 public files and no `experiments/`.
- Experiment `npm test`: 68/68 offline tests passed with the expanded
  no-network preload.
- Experiment `npm run check`: registry, syntax, generated-directory ignore, root
  permission, root host-permission, and release-boundary checks passed.
- Node library unit tests: 9/9 passed after isolated `npm ci`.
- Local-helper Python tests: 8/8 passed, including exact-origin/token loopback
  HTTP fixtures.
- `git diff --check`: passed.

No real YouTube, Supadata, hosted-provider, or AI translation request was run in
this implementation stage. No browser-side acceptance has been performed.

### Residual limits to preserve during interpretation

- The passive MAIN/ISOLATED nonce prevents accidental channel collisions but is
  visible to the YouTube page and is not an authentication secret. Treat every
  captured payload as untrusted, compare sample text manually without saving
  it, and use DevTools Network as the final evidence for zero added requests.
- Passive capture keeps a serialized, size-bounded set of recent
  tab/video/language/kind results. Select the requested language and track in
  its popup rather than assuming the newest response is correct.
- The local-helper comparison knows that one loopback call occurred; internal
  YouTube endpoint counts are intentionally `unknown`, not falsely recorded as
  zero.
- `hosted-api-slot` is a contract-only slot. It is not a seventh live vendor
  until the user selects one and authorizes current API/privacy/price research.

## Subtraction rules

- `youtube-passive` gets first test priority, not automatic retention priority.
- Retain `youtube-active` only if it materially covers cases the passive route
  misses without unacceptable request amplification.
- Retain a fallback only when it covers a distinct real failure class and its
  privacy, cost, and support burden are acceptable.
- `local-helper` must show a material reliability benefit before the project
  accepts a companion-process installation burden.
- Remove losing implementations from the public product, but preserve the
  experiment plan, sanitized reports, and Git history.

## Current execution state

- [x] Scope, provider IDs, boundaries, and later manual-test contract frozen.
- [x] Historical experiment assets migrated without generated dependency copies.
- [x] Shared provider registry, strict contract, single-provider router
      primitive, and sanitized report shape implemented. All seven real adapter
      modules pass one fixture dispatch through that router; browser probes
      remain separate runtime surfaces and are recorded with the validated
      manual-result template rather than claiming live router integration.
- [x] Passive-capture MV3 probe implemented and fixture-tested.
- [x] Active, panel, and Supadata routes mapped to the shared schema; separate
      manual probes exist for passive, panel, Supadata, and local helper.
- [x] Node/local-helper harnesses installed in ignored isolated directories and
      checked without live transcript requests.
- [x] Hosted API slot implemented with fake responses and no default transport.
- [x] Project, experiment, dependency, release, package, and diff checks passed.
- [x] Text-free manual-result validator and comparison-report generator added.
- [x] Tomorrow's exact runbook and recovery entry written.
- [x] Local main `b45b42a` synchronized into this experimental branch without
      changing, pushing, or releasing main.
- [ ] Post-sync root/experiment automated checks rerun.
- [ ] Real Chrome/YouTube/Supadata/manual acceptance performed by the user.

## Recovery entry

Resume in this worktree, read this file first, then inspect `git status` before
editing. Do not switch to `main` and do not copy experimental code into the
public release allowlist without a separate decision after manual evidence.
