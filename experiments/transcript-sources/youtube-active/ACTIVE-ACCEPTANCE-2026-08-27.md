# Active transcript route acceptance

Date: 2026-08-27

Scope: `youtube-active` core plus the unpacked `youtube-verifier` MV3 test
surface. This document does not authorize integration into the production
DigestDock extension, a commit, a merge, a push, or a release.

## Decision

Retain `isolated-tab` as the only viable Active candidate for subtraction-stage
comparison. Reject both popup-origin transports: direct player requests from the
extension popup returned the same HTTP 403 response for every fixed client on
both tested player domains.

The retained route injects the bounded verifier into the active YouTube tab's
`ISOLATED` world. It does not enter MAIN world, read cookies or storage, include
credentials, spoof `User-Agent`/`Origin`, retry 429, or fall through to another
provider.

## Real MV3 evidence

| Case | Expected | Observed | Provider requests | Result |
| --- | --- | --- | --- | --- |
| `jNQXAC9IVRw`, `en`, manual | short manual transcript | IOS, 6 segments | 1 player 200 + 1 timedtext 200 | pass |
| `KLDVxx4TqcE`, `en`, ASR | long auto-generated transcript | IOS, 1,828 segments, 63,109 canonical characters | 1 player 200 + 1 timedtext 200 | pass |
| `4OEG33NfEK0`, `en`, manual-first | no transcript | IOS/ANDROID playable with 0 tracks; other clients login-required/unplayable | 4 player 200 + 0 timedtext | expected `NO_TRANSCRIPT` |
| `jNQXAC9IVRw`, `en`, ASR | requested track absent | only English/German manual tracks | 4 player 200 + 0 timedtext | expected `TRACK_UNAVAILABLE` |

The long-ASR canonical SHA-256 was
`f3ee14455aa55fd66d60cafa780dbbc932d5d9bd5aa7091236d64c7b850e4339`,
matching the earlier Node baseline. No Active player or timedtext request returned
HTTP 429 in the accepted runs.

## Rejected transport evidence

- `youtubei.googleapis.com` from popup origin: IOS, ANDROID_VR, MWEB, and
  ANDROID each returned HTTP 403 with the same bounded response size.
- `www.youtube.com` from popup origin: the same four clients again returned the
  same HTTP 403 response shape.
- Changing domains did not fix the origin boundary. No header spoofing, proxy,
  cookie use, permission broadening, or access-control workaround was attempted.

## Safety and implementation checks

- Popup opening does not auto-run the verifier; one explicit button click starts
  one measured run.
- Manifest permissions are only `activeTab` and `scripting`; there is no
  permanent `host_permissions` entry.
- Requests use `credentials: omit`, `cache: no-store`, a 15-second timeout, and
  an 8 MiB response limit.
- Player or timedtext HTTP 429 throws `RATE_LIMITED` before the response body is
  read and stops all later formats, tracks, and clients, including when the 429
  body is oversized or unreadable.
- The popup returns only five in-memory sample segments plus text-free metrics
  and diagnostics; it stores no transcript, signed URL, key, token, or cookie.
- The current tab and canonical video ID are checked again after the run so a
  navigation cannot accept a stale result.

## Evidence files

- `../manual-results/2026-08-26-youtube-active-googleapis-popup-403.json`
- `../manual-results/2026-08-26-youtube-active-popup-403.json`
- `../manual-results/2026-08-26-youtube-active-isolated-short.json`
- `../manual-results/2026-08-27-youtube-active-isolated-long-asr.json`
- `../manual-results/2026-08-27-youtube-active-isolated-no-transcript.json`
- `../manual-results/2026-08-27-youtube-active-short-asr-unavailable.json`

## Residual limits

- The long-ASR and no-transcript runs recorded matching URL and
  `ytd-watch-flexy` video IDs before the click, and the verifier returned the
  requested video ID. A separate pre-click capture of the page player's
  `videoDetails.videoId` was not persisted; do not claim that third identity as
  independently evidenced.
- These public-video samples demonstrate current behavior, not permanent
  YouTube endpoint stability.
- Production adoption still requires a separate subtraction decision and
  integration review; this experiment must not be copied into the public
  release allowlist automatically.

## Final hardening review

- 429 detection now occurs immediately after `fetch()` resolves and before any
  response body size check, stream read, or `text()` call. Oversized and
  unreadable 429 bodies cannot downgrade the error or advance to another client.
- The unpacked verifier has no permanent host permission; user action grants
  temporary access to the active tab for ISOLATED-world execution.
- The shared Active wrapper omits `captionTracks` unless the caller explicitly
  supplies page evidence. This preserves the distinction between an unknown
  page state and a confirmed empty page track list.

## Offline verification

- `youtube-verifier`: 12/12 tests passed.
- `youtube-active` wrapper/core: 6/6 tests passed with the no-network preload,
  including independent player and timedtext early-429 body guards.
- All six Active manual JSON records passed the fixed schema validator.
- `git diff --check` passed.
