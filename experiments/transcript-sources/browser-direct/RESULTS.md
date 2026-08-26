# Browser-direct conclusion (2026-08-18)

## Outcome

The signed-out browser can reliably discover the advertised `captionTracks`, but
this run did **not** establish a working transcript-body path. A raw `baseUrl` fetch
failed for every captioned sample, and copying the player's observed `pot`/client
parameters did not recover a body. Therefore, `captionTracks + pot/c` should not be
recommended as a standalone Supadata replacement from this evidence.

## What was observed

The system Google Chrome was launched headlessly by Playwright with a fresh temporary
profile and explicitly empty initial storage. All five contexts had no login-cookie
names. The direct comparison fetches used `credentials: "omit"`.

| Boundary | Sample | Observed result |
|---|---|---|
| Authored English | `jNQXAC9IVRw` | 2 tracks discovered; raw `json3` returned HTTP 200 with 0 bytes. The player's native request added `pot`, `potc`, `c=WEB`, client metadata, signature and `fmt=json3`, but that native response and an exact refetch were also HTTP 200 with 0 bytes. |
| Authored + ASR duplicate | `iG9CE55wbtY` | 65 tracks discovered, including authored and ASR English. Raw ASR returned HTTP 200 with 0 bytes. `player.setOption` did not accept the ASR selection: the active track remained authored `.en` and was marked `isServable: false`. The CC control already reported subtitles on; clicking it would have disabled subtitles, so the corrected run skipped the click. |
| ASR-only long video | `KLDVxx4TqcE` | 1 ASR track discovered; raw `json3` returned HTTP 200 with 0 bytes. The native player again injected `pot/c` but returned 0 bytes, and every reconstructed/exact variant remained empty. |
| Spoken video with no tracks | `4OEG33NfEK0` | 0 tracks; clean negative, with no timedtext request or fabricated text. |
| Non-verbal no-track control | `aqz-KE-bpKQ` | 0 tracks; clean expected negative. |

This makes three results independent rather than conflated:

1. Track discovery worked on 3/5 samples.
2. Raw transcript retrieval worked on 0/3 captioned samples.
3. A matching native `pot/c` request was observed on 2/3 captioned samples, but it
   still returned an empty body on both. In this run, `pot` was not sufficient.

The CC button state was also not a trustworthy success signal: on captioned samples
it could report `aria-pressed=true` / subtitles on while its title said captions were
unavailable and the timedtext response was empty.

## SPA boundary

SPA behavior remains **unverified**, not failed. The anonymous headless page exposed
a dynamically changing watch link, but the real Playwright click was intercepted by
the page root and the link detached before navigation completed. No same-document or
stale-player claim is made from that attempt.

## Recommendation from this lane

Do not implement the direct `baseUrl` path as the primary extractor on the assumption
that capturing `pot/c` solves the problem. At most, keep `getPlayerResponse()` as a
cheap discovery/diagnostic surface and require a non-empty, parseable body before
declaring success. Compare it against the browser transcript-panel and local CLI
lanes before selecting a replacement architecture.

The run used signed-out headless Chrome on one network at one point in time. A real
headed extension session may behave differently, so it would require its own small
PoC before upgrading this result to a product-wide impossibility claim.

## Evidence

- `results/latest.md`: compact request matrix
- `results/latest.json`: full sanitized structured output
- `logs/latest.ndjson`: lifecycle/error log
- `run.cjs`: reproducible experiment runner

No transcript text, signed timedtext URL, signature value, PO token value, login
cookie, or user Chrome profile data was persisted.
