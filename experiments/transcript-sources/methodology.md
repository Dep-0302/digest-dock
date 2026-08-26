# Methodology

## 2026-08-23 seven-provider extension

The current matrix adds `youtube-passive`, strict single-provider routing,
per-variant identities, a token-paired local helper, and a disabled hosted API
slot. Historical results below remain evidence snapshots; they are not new
acceptance for the added code.

Every measured request now carries `runId`, `requestId`, `providerId`, optional
`providerVariant`, exact `videoId`, language preference, track kind, and cache
mode. Failure stops at the selected provider. Cache bypass is the default, and
no comparison run may trigger an automatic fallback.

## Test groups

### Group A: extraction coverage

Use overlapping discriminator slices from the same public-video corpus. Compare
successful segment extraction, language identification, segment count,
timestamp shape, and failure classification only where the slices overlap. A
non-empty title or caption-track list does not count as transcript success.

The completed runs are not a full 7-video cross product:

- browser-direct: 5 corpus videos
- browser-panel: 4 corpus videos
- Node libraries: 4 core videos plus a separate 2-case language-policy probe
- Python/CLI tools: 6 cases derived from 4 transcript-bearing/negative corpus videos
- MV3 service-worker probe: blocked before the browser service worker started

The Japanese corpus sample was verified for tracks but was not included in an
extractor matrix. Supadata was not called because doing so would consume a stored
credential and quota. Results therefore establish practical differences on
shared discriminator cases, not corpus-wide equivalence with Supadata.

### Group B: browser-only behavior

Compare direct page/player extraction with transcript-panel extraction. Record
SPA freshness, PO-token evidence, empty HTTP 200 responses, visible page changes,
selector dependence, virtualized scrolling, and repeat-run consistency.

### Group C: installation and operation

Compare a zero-dependency MV3 implementation, bundled Node libraries, Python
packages, and `yt-dlp`. Record installed bytes, startup/process requirements,
browser compatibility, and whether a localhost/native-messaging bridge would be
required.

### Group D: maintenance and failure ownership

Identify what must be updated when YouTube changes: page selectors, private API
client versions, PO-token acquisition, Python/CLI packages, or a hosted provider.
Distinguish failures the extension can explain locally from failures hidden
behind a third-party API.

## Decision rules

1. The recommended default must work without credentials, cookies, proxies, or
   a separately launched process for the supported public-watch-page scope.
2. A fallback is valuable only when its failure mode is meaningfully independent
   from the primary path.
3. A candidate that succeeds only in Node does not prove it will run in Chrome
   MV3; browser execution is evaluated separately.
4. No-caption videos must produce a clear no-transcript result rather than a
   misleading success with zero segments.
5. Live observations are snapshots, not guarantees. Undocumented YouTube
   behavior remains an explicit maintenance risk even when every sample passes.
6. A mature external product gives a route first-test priority, not automatic
   retention priority in DigestDock.
7. A result is invalid if its provider/run/video identity differs from the
   request or if malformed/unsorted segments were silently repaired.
8. Committed reports contain only counts, timing, language evidence, endpoint
   classes, and text-free shape metrics.
