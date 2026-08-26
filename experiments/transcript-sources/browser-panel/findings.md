# Transcript-panel practical findings

## Outcome

The visible YouTube transcript panel is usable as a fallback, but this run does not support making it the only or primary transcript source.

Under a fresh anonymous Playwright context, one of three caption-bearing discriminator videos rendered transcript segments. The other two exposed a transcript trigger and opened a panel, but YouTube's own `youtubei/v1/get_transcript` request returned `400 FAILED_PRECONDITION` and the panel remained empty. The same statuses, track counts, segment counts, and response-status patterns repeated in the next run.

## Observed differences

| Case | Player metadata | Panel behavior | Practical meaning |
|---|---|---|---|
| Short manual captions | 2 manual tracks | Opened; 3 DOM segments; first/last content appeared in the accessibility snapshot | Panel extraction can work without an API key or login |
| Multilingual manual/ASR mix | 65 tracks | Opened empty; transcript request returned 400 | Many available tracks do not imply panel availability; language choice was unreachable |
| Long ASR-only talk | 1 `en/asr` track | Opened empty; transcript request returned 400 | An ASR track in player metadata does not imply the transcript panel can render it |
| Spoken video, no captions | 0 tracks | No transcript trigger | No-caption detection was clean |

The successful short panel used the newer `transcript-segment-view-model` element. Its expanded engagement panel had no `target-id`, so an implementation limited to `ytd-transcript-segment-renderer` or `target-id="engagement-panel-searchable-transcript"` would produce a false empty result. Segment count and order stayed stable before and after the available panel-scroll pass; the panel was not virtualized in this short case. The two long cases never produced segments, so this run could not establish long-transcript virtualization behavior.

## SPA behavior

A real in-page route was exercised by opening the short video's transcript, searching YouTube for the multilingual TED video, and clicking that search result. The original document marker survived, confirming an SPA transition.

At the moment `movie_player` had already switched to the new video ID, the old video's transcript panel and segment signature were still present. After the page title and watch metadata settled about 0.9 seconds later, the stale panel disappeared. Reopening the current video's panel then produced the same empty/400 result as a fresh navigation.

This creates a real stale-data window. A fallback extractor must not accept an already-visible transcript panel merely because the URL or player ID changed. It needs to wait for the full YouTube navigation settlement, clear prior panel state, and bind any extracted segment signature to the current video ID.

## Visible and localization effects

- Opening the panel required expanding YouTube's description first in all three caption-bearing cases.
- The short case moved the page scroll position by about 180 px and left a visible engagement panel open.
- The structural description selector worked before the English text fallbacks, reducing but not eliminating localization dependence.
- No tested panel exposed a usable language menu. In the 65-track case the transcript failed before language selection became available.
- No consent page or anti-automation challenge appeared. No saved profile, login state, credentials, proxy, or bypass flags were used.

## Recommendation

Use the transcript panel only as a bounded second fallback after a less invasive current-video caption source. Treat these as required guards:

1. Wait for YouTube SPA navigation to settle beyond the earliest player-ID change.
2. Validate the panel against the current video and reject an unchanged prior segment signature.
3. Support both legacy `ytd-transcript-segment-renderer` and current `transcript-segment-view-model` markup; do not require a stable engagement-panel `target-id`.
4. Treat an open-but-empty panel, `get_transcript` 400, missing trigger, and unavailable language selection as distinct failure reasons.
5. Restore or explicitly document the visible UI changes when feasible: description expansion, page scroll, and open engagement panel.

Given the observed 1-of-3 success rate for caption-bearing discriminator videos, the panel route is not a sufficient replacement for Supadata by itself. It becomes useful as one independent failure surface in a layered extractor.
