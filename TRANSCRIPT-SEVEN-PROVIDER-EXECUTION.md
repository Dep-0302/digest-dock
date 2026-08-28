# Seven-provider YouTube transcript experiment

Status date: 2026-08-27 (America/Los_Angeles)

## Goal

Build and compare seven isolated transcript-source experiments in the worktree
`/Users/wangchao/Documents/061-DigestDock/worktrees/transcript-source-comparison-v2`, then
use real, text-free evidence to remove weaker routes. The live comparison is now
complete for the three retained browser routes. This experiment does not
authorize changes to `main`, a merge, a push, or a release.

## Frozen baseline

- Branch: `codex/transcript-source-comparison-v2`
- Historical experiment baseline: `7e15275` (`Snapshot UI and transcript work
  before provider split`).
- Seven-provider checkpoint commits: `f491210` and `bd65972`.
- Mainline synchronized from local `main` commit `b45b42a` (DigestDock 1.4.4)
  on 2026-08-25. At that historical checkpoint the repository root followed
  API-primary `main`. The current experimental root now contains the Phase 2
  native-first candidate implementation; `main` itself has not changed.
- Before Phase 2, the active local extractor existed only under
  `experiments/transcript-sources/youtube-active/`. The current experimental
  root now has one product candidate module; this is not a `main` integration,
  commit, push, or release.
- Historical comparison evidence has been migrated under
  `experiments/transcript-sources` without generated dependency folders in Git.

## Fixed provider IDs

These names are the canonical IDs for code, fixtures, reports, and the
historical manual checks recorded below.

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
- Real YouTube, Supadata, hosted-provider, or translation requests were not run
  during the original implementation stage. The later user-driven single-route
  runs are preserved below; any new live run still requires a new scope.

## Test surfaces

### Browser/extension surface

- `youtube-passive`
- `youtube-active`
- `youtube-panel`
- `supadata-native`

These used public videos in the user's Chrome only during the completed
single-route manual stage. The historical passive experiment was installed
before a fresh video load; the historical panel probe required the current
video's Transcript panel to be open.

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
9. Update this file with the observed completion state and the historical exact
   manual commands.

## Historical manual acceptance contract

This section preserves the original seven-provider runbook for audit history;
it is not the current live-test queue. The current registry and the post-sync
completion record below take precedence. Do not rerun popup-origin, Supadata,
hosted-provider, or any other live route without a new explicit test scope.

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

### Post-sync and live progress on 2026-08-26–27

All observations below were made only in this experimental worktree. No change
was merged to `main`, pushed, published, or released. No Supadata request, API
key, cookie, proxy, or hosted-provider request was used. No transcript-provider
endpoint returned HTTP 429. Later, the signed-in page's independent
`accounts.youtube.com/RotateCookies` request returned 429; all further YouTube
testing stopped immediately under the shared cooldown rule.

- Post-sync root `npm test`: 451/451 passed; `npm run check` also passed, with 39
  allowlisted public files. The worktree was clean before live-result artifacts
  and the fixes below were created.
- Post-sync experiment baseline: 68/68 offline tests passed; Node library tests
  passed; local-helper tests passed.
- `youtube-panel`, exercised through the real signed-in YouTube page UI without
  the collector extension:
  - `jNQXAC9IVRw` succeeded through `youtubei/v1/get_panel` HTTP 200 and rendered
    3 transcript segment view models, from 0:01 through 0:16.
  - `iG9CE55wbtY` and long-ASR `KLDVxx4TqcE` both exposed the Transcript button,
    but `youtubei/v1/get_transcript` returned HTTP 400 and the panel remained on
    an active spinner with 0 segments.
  - no-caption `4OEG33NfEK0` exposed no Transcript button, matching the expected
    negative boundary.
  - The real unpacked Panel Probe was then accepted on scrollable manual-caption
    sample `dQw4w9WgXcQ`: 24 segments, 9 overlapping collections, continuous
    top-to-bottom coverage ratio 1, first start 1, last start 203, and 2,066
    characters. After the user had manually opened the panel, probe collection
    and finalization added 0 player, timedtext, transcript-panel, or third-party
    requests, and no 429 appeared. This does not prove that the product's future
    automatic panel-open action induces zero page requests.
  - Live testing exposed and fixed current YouTube compatibility for the
    `ytd-watch-flexy[video-id]` identity fallback and the new
    `transcript-segment-view-model` row classes. Final diagnostics now preserve
    `sawTop`, `sawBottom`, collection count, and visible/collected row counts.
    The text-free record is stored at
    `manual-results/2026-08-26-youtube-panel-dqw4w9wgxcq.json`.
  - The route-feasibility decision accepted the observed row/coverage evidence,
    but the raw Panel receipt still marks text comparison as pending and the
    tested DOM did not expose a usable language menu. Product-language binding
    and automatic open/restore remain Phase 4 integrated acceptance gates.
- `youtube-passive`, exercised through the real unpacked MV3 probe with the
  production DigestDock extension disabled:
  - extension ID `blepfpfonfdjieohhgnhcoekodhknbio` was loaded from this exact
    worktree and observed the page's JSON3 XHR response.
  - short manual `jNQXAC9IVRw` produced one page `timedtext` HTTP 200 response;
    opening and reading the probe added 0 further `timedtext` requests.
  - a real YouTube SPA transition changed the page to `UixhcccGcdY`. The probe
    returned that new video ID, not the prior one, with 670 `en-US` manual
    segments, first start 0, last start 1503.376, one observed response, and
    `requestsInitiated: 0`.
  - The text-free accepted record is stored at
    `manual-results/2026-08-26-youtube-passive-spa.json`.
- `youtube-active` core adapter, exercised one case per Node process with no
  fallback:
  - short manual `jNQXAC9IVRw`: success, 6 segments, English manual track,
    1,337 ms, IOS, 1 player + 1 timedtext request.
  - long ASR `KLDVxx4TqcE`: success, 1,828 segments, English ASR track,
    1,575 ms, IOS, 1 player + 1 timedtext request.
  - no-caption `4OEG33NfEK0`: correct `NO_TRANSCRIPT`, 2,129 ms,
    4 player + 0 timedtext requests.
  - The unpacked MV3 verifier proved that direct fetches from the popup origin
    are not viable: both `youtubei.googleapis.com` and `www.youtube.com` player
    endpoints returned the same 403 body for IOS, ANDROID_VR, MWEB, and ANDROID.
    No request-header spoofing or permission broadening was attempted.
  - Moving the same bounded algorithm into the current YouTube tab's ISOLATED
    world succeeded on short manual `jNQXAC9IVRw`: IOS returned 2 tracks and 6
    English manual segments through exactly 1 player 200 + 1 timedtext 200.
  - A later ASR-only click was made on the same short video rather than the
    prepared long video. It correctly returned `TRACK_UNAVAILABLE`: IOS and
    ANDROID exposed English/German manual tracks only; the other clients were
    login-required/unplayable. It is not evidence about the long-ASR corpus case.
  - After the shared cooldown, the isolated-tab verifier also succeeded on the
    prepared long-ASR case `KLDVxx4TqcE`: IOS returned 1,828 English ASR
    segments through exactly 1 player 200 + 1 timedtext 200. Its canonical
    transcript SHA-256 matched the earlier Node baseline.
  - The isolated-tab verifier correctly returned `NO_TRANSCRIPT` for
    `4OEG33NfEK0`: four bounded player requests exposed no caption tracks and no
    timedtext request was sent. This is an expected negative, not a transport
    failure.
  - Text-free records preserve both popup-origin 403 rejections, isolated short
    and long-ASR successes, and the expected `NO_TRANSCRIPT` and
    `TRACK_UNAVAILABLE` boundaries under `manual-results/`.
  - The short and long success receipts preserve `manual-review-needed` even
    though sample text was compared without saving it. Route feasibility and
    canonical long-ASR hash matching are accepted; the integrated Phase 4 run
    must still record its own first/last coverage and page/run identity receipt.
  - No Active player or timedtext request returned HTTP 429 in the accepted
    runs. The verifier still requires an explicit click and hard-stops on the
    first player/timedtext 429; 12/12 verifier tests pass.
- `node-libraries`, all runs one case × one candidate × one round:
  - On `iG9CE55wbtY`, `youtube-caption-extractor`, `youtube-transcript-plus`, and
    `youtube-transcript` each retrieved 427 segments. `youtubei.js` failed after
    its `get_transcript` request returned HTTP 400.
  - `youtube-transcript-plus` also retrieved 1,828 long-ASR segments, correctly
    classified the no-caption sample, and returned language-unavailable for the
    missing-French case without silent fallback.
  - `youtube-transcript` still fails the shared contract because its observed
    timestamps are milliseconds on this branch even though it returned text.
  - Sanitized JSON/Markdown evidence is stored as `results/live-*.json` and
    `results/live-*.md` under `node-libraries/`.
  - The runner now aborts transport and skips the remaining matrix after the
    first HTTP 429; 10/10 Node library tests pass.
- `local-helper` initially returned `HELPER_UNAVAILABLE`. Diagnosis proved this
  was an experiment bug, not a YouTube limit: pinned
  `youtube-transcript-api==1.2.4` exposes `to_raw_data()` on the complete fetched
  transcript, not on individual snippets. After the fix and a text-free fixture
  regression test, the one-shot stdio live rerun returned 6 English manual
  segments for `jNQXAC9IVRw`.
  - The real unpacked loopback client initially returned
    `HELPER_UNAUTHORIZED` even with the correct token. Sanitized server logs
    proved every rejection was `origin-mismatch`: this Chrome extension fetch
    omitted the standard HTTP `Origin` header.
  - The client now declares its exact `chrome.runtime` origin in a fixed custom
    header; the helper requires that value plus the pairing token and continues
    to reject a conflicting standard Origin when one is present. The CORS
    preflight also now declares `GET /health`.
  - The real extension ID `adncjncklfgbkjolacnbdjpbaciefahi` then passed
    authenticated `GET /health` with `networkRequests: 0`, `allowLive: false`,
    no standard Origin, and an exact declared-origin match. The helper was
    stopped immediately afterward and the one-time token invalidated.
  - Local-helper tests now pass 11/11; the complete offline experiment suite
    passed 71/71 at that checkpoint. The Phase 1 truth-source rerun now passes
    74/74. The text-free health record is stored at
    `local-helper/results/health-2026-08-27.json`.
- `hosted-api-slot` remains intentionally unavailable with zero transport.
- User subtraction decision: `supadata-native` and `hosted-api-slot` are removed
  from the remaining live-test scope because their key/cost/vendor burden is not
  justified by the current comparison. Do not send Supadata requests, request a
  key, select a hosted vendor, or spend time on live acceptance for either one.
  Keep their isolated code, fixture tests, and history until a later explicit
  cleanup decision; this decision is not deletion authorization.
- The shortlist decision has no remaining single-route candidate gate: Passive,
  Panel, and Active isolated-tab have enough real MV3 evidence to enter the
  experimental integration. The combined serial product chain still requires
  Phase 4 unpacked MV3 acceptance. Further live requests require a new explicit
  scope; popup-origin, Supadata, and hosted-provider live research remain closed.

### Frozen Active product-source contract

The only retained Active implementation source is the bounded algorithm already
accepted through the real `youtube-verifier` isolated-tab surface. Product
integration must preserve `providerVariant=isolated-tab`, normalize navigation
changes as `PAGE_CONTEXT_CHANGED`, stop immediately on the first player or
timedtext 429, retain endpoint-class request counts, and return the complete
shared transcript contract rather than the verifier's five-segment preview.
Both popup-origin variants remain rejected evidence and must not be rerun or
researched. Do not create another intermediate Active core in this experiment.

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
- `supadata-native` and `hosted-api-slot` are retained only as historical and
  contract evidence; both are explicitly out of the current live-test scope.

## Subtraction rules

- `youtube-passive` gets first test priority, not automatic retention priority.
- Retain `youtube-active` only if it materially covers cases the passive route
  misses without unacceptable request amplification.
- Retain a fallback only when it covers a distinct real failure class and its
  privacy, cost, and support burden are acceptable.
- `local-helper` must show a material reliability benefit before the project
  accepts a companion-process installation burden.
- Do not test or retain `supadata-native` or `hosted-api-slot` as live fallbacks
  in this round unless the user explicitly reverses the subtraction decision.
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
- [x] Historical exact runbook and recovery entry written.
- [x] Local main `b45b42a` synchronized into this experimental branch without
      changing, pushing, or releasing main.
- [x] Post-sync root/experiment automated checks rerun.
- [x] No-key YouTube UI, active-core, Node-library, and local-helper smoke runs
      performed with text-free evidence and no observed 429.
- [x] Verifier and Node runner changed to hard-stop after the first 429; verifier
      no longer auto-runs when its popup opens.
- [x] Local-helper pinned-library integration bug fixed and live short sample
      rechecked successfully.
- [x] `local-helper` real MV3 loopback health accepted with exact declared
      extension identity, token pairing, and `networkRequests: 0`; live mode
      remained disabled.
- [x] Shortlist-relevant unpacked Chrome probes loaded one at a time and
      accepted on their real MV3 surfaces.
- [x] `youtube-passive` accepted on its real MV3 surface, including zero added
      request evidence and SPA second-video freshness.
- [x] `youtube-panel` accepted on its real MV3 surface with continuous
      top-to-bottom coverage and 24 collected rows after manual open; collection
      added zero requests, while product automatic-open requests remain a Phase 4 gate.
- [x] `youtube-active` isolated-tab variant accepted on the short manual MV3
      surface; direct popup-origin transport rejected after repeatable 403s.
- [x] `youtube-active` long-ASR and no-caption MV3 cases rerun after the observed
      YouTube account-cookie 429 cooldown; both matched their expected outcomes.
- [x] `supadata-native` and `hosted-api-slot` removed from the remaining live-test
      scope by explicit user decision; no key, paid request, or vendor selection
      will be performed.
- [x] Phase 1 truth sources reconciled into the eight-run report and current
      registry dispositions; experiment offline tests pass 74/74.
- [x] Phase 2 native-first candidate chain implemented in this experimental root.
- [x] Phase 3 offline validation passed: root 554/554, Node comparator 10/10,
      local-helper 11/11, release check 43 allowlisted files, and a temporary
      candidate ZIP boundary check. Nothing was committed, pushed, or released.
- [ ] Phase 4 combined unpacked MV3 acceptance remains pending separate user
      authorization; single-route evidence does not satisfy this gate.

## Recovery entry

Resume in this worktree, read this file first, then inspect `git status` before
editing. Do not switch to `main`. The experimental root allowlist is used only
to validate the candidate ZIP boundary; do not copy or merge it into `main`
without the Phase 4 evidence and a separate Phase 5 decision.
