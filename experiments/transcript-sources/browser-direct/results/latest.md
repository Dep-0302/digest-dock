# Browser-direct transcript source: latest observed results

- Run at: `2026-08-18T08:41:05.339Z`
- Browser: system Google Chrome via Playwright, headless
- Authentication: signed out; empty initial storageState; auth cookie names recorded per case
- Browser profile: Playwright-created temporary profile
- Transcript text and signed token values persisted: no

## Caption request matrix

| Case | Tracks | Desired | Native player request | Raw json3 | Raw + pot | Raw + pot/client | Captured exact refetch | Observed effect |
|---|---:|---|---|---|---|---|---|---|
| manual-english-short | 2 | en/manual | 200/0B/text/html; charset=UTF-8 | 200/0B/empty | 200/0B/empty | 200/0B/empty | 200/0B/empty | tokenized-request-did-not-recover-body |
| duplicate-language-select-asr | 65 | en/asr | n/a | 200/0B/empty | n/a | n/a | n/a | not-testable |
| asr-only-long | 1 | en/asr | 200/0B/text/html; charset=UTF-8 | 200/0B/empty | 200/0B/empty | 200/0B/empty | 200/0B/empty | tokenized-request-did-not-recover-body |
| spoken-no-caption-track | 0 | none expected | n/a | n/a | n/a | n/a | n/a | not-testable |
| nonverbal-no-caption-track | 0 | none expected | n/a | n/a | n/a | n/a | n/a | not-testable |

## Independent observations

- **manual-english-short:** player exposed 2 track(s); desired track found = true; raw json3 usable = false; native pot/c request found = true; captured exact usable = false; activation action = none; visible CC-state side effect = false.
- **duplicate-language-select-asr:** player exposed 65 track(s); desired track found = true; raw json3 usable = false; native pot/c request found = false; captured exact usable = false; activation action = player-setOption-track, cc-button-click-skipped; visible CC-state side effect = false.
- **asr-only-long:** player exposed 1 track(s); desired track found = true; raw json3 usable = false; native pot/c request found = true; captured exact usable = false; activation action = none; visible CC-state side effect = false.
- **spoken-no-caption-track:** player exposed 0 track(s); desired track found = false; raw json3 usable = false; native pot/c request found = false; captured exact usable = false; activation action = none; visible CC-state side effect = false.
- **nonverbal-no-caption-track:** player exposed 0 track(s); desired track found = false; raw json3 usable = false; native pot/c request found = false; captured exact usable = false; activation action = none; visible CC-state side effect = false.

## SPA navigation

SPA check was blocked: locator.click: Timeout 10000ms exceeded.

## Interpretation boundary

These are current, signed-out browser observations, not a permanent YouTube API contract. A discovered `captionTracks` entry is reported separately from a non-empty, parseable transcript body. `pot` and signature values are intentionally omitted from artifacts.
