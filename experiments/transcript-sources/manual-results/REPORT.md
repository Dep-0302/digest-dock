# Seven-provider manual transcript report

Runs: 8 (all 8 JSON records currently present in this directory)

| Provider | Variant | Runs | Success | Expected negative | Unexpected failure | Median ms (measured/runs) | Initiated requests | Expected-negative codes | Unexpected errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| youtube-active | googleapis-popup-origin | 1 | 0 | 0 | 1 | 2485 (1/1) | youtubePlayer=4, youtubeTimedtext=0, thirdParty=0, loopback=0 | none | PROBE_FAILED |
| youtube-active | isolated-tab | 4 | 2 | 2 | 0 | 1581.5 (2/4) | youtubePlayer=10, youtubeTimedtext=2, thirdParty=0, loopback=0 | NO_TRANSCRIPT, TRACK_UNAVAILABLE | none |
| youtube-active | popup-origin | 1 | 0 | 0 | 1 | 2239 (1/1) | youtubePlayer=4, youtubeTimedtext=0, thirdParty=0, loopback=0 | none | PROBE_FAILED |
| youtube-panel | manual-rendered-panel | 1 | 1 | 0 | 0 | n/a (0/1) | youtubePlayer=0, youtubeTimedtext=0, thirdParty=0, loopback=0 | none | none |
| youtube-passive | default | 1 | 1 | 0 | 0 | n/a (0/1) | youtubePlayer=0, youtubeTimedtext=0, thirdParty=0, loopback=0 | none | none |

`Expected negative` means the JSON record is marked `expected-negative`; these
are correct boundary results, not provider failures. The two `PROBE_FAILED`
records are kept as unexpected run failures that now serve as rejected-transport
evidence for the two popup-origin variants; neither is pending further research.
`Median ms (measured/runs)` reports the median only over receipts that contain
a numeric elapsed time and always discloses that measured denominator.

## Source coverage

- `2026-08-26-youtube-active-googleapis-popup-403.json`
- `2026-08-26-youtube-active-isolated-short.json`
- `2026-08-26-youtube-active-popup-403.json`
- `2026-08-26-youtube-panel-dqw4w9wgxcq.json`
- `2026-08-26-youtube-passive-spa.json`
- `2026-08-27-youtube-active-isolated-long-asr.json`
- `2026-08-27-youtube-active-isolated-no-transcript.json`
- `2026-08-27-youtube-active-short-asr-unavailable.json`

This report contains no transcript text, signed URL, key, token, header, cookie,
or job ID.
