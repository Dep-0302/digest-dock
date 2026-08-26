# YouTube transcript panel comparison

Generated: 2026-08-18T08:44:39.029Z

The run used Playwright with system Chrome, a fresh anonymous browser context per video, no saved state, cookies, credentials, proxy, or anti-automation bypass flags. Each navigation/action had a 20 second hard timeout. Consent or bot checks are recorded as blockers and are not bypassed.

| Case | Video | Player tracks | Panel result | DOM segments | Stable after panel scroll | get_transcript HTTP | Repeat stable | Language menu |
|---|---|---:|---|---:|---|---|---|---|
| short_manual | jNQXAC9IVRw | 2 | panel_opened_with_segments | 3 | true | none | true | not opened |
| manual_multilingual | iG9CE55wbtY | 65 | panel_opened_empty | 0 | true | 400 | true | not opened |
| long_auto_only | KLDVxx4TqcE | 1 | panel_opened_empty | 0 | true | 400 | true | not opened |
| spoken_no_captions | 4OEG33NfEK0 | 0 | expected_no_panel | - | - | none | true | not opened |

## SPA transition

- Route: jNQXAC9IVRw -> YouTube search -> iG9CE55wbtY.
- Result: spa_transient_stale_panel_then_settled; original document marker survived: true; target player ID: iG9CE55wbtY.
- Stale source transcript at player-ID switch: true; after waiting up to 10 seconds for page-title settlement: false.
- Transcript panel after any required close/reopen: 0 DOM segments; transcript response statuses across the scenario: 400.

## Visible side effects

- **short_manual**: trigger=after-expand:description-structural; page scroll 0 -> 180; visible engagement panels [] -> ["unknown"].
- **manual_multilingual**: trigger=after-expand:description-structural; page scroll 0 -> 0; visible engagement panels [] -> ["engagement-panel-searchable-transcript"].
- **long_auto_only**: trigger=after-expand:description-structural; page scroll 0 -> 0; visible engagement panels [] -> ["engagement-panel-searchable-transcript"].
- **spoken_no_captions**: trigger=none; page scroll 0 -> -; visible engagement panels [] -> [].

## Interpretation limits

- The transcript-panel method necessarily opens visible YouTube UI and may expand the description, change page scroll, open an engagement panel, and briefly open a language menu.
- Player track metadata and panel availability are separate observations. A caption track in player metadata does not guarantee that the transcript panel can render it.
- DOM completeness is judged by segment counts and order before/after a full panel scroll; the accessibility snapshot records whether both boundary segment texts are exposed.
- The English text trigger is tried only after the locale-independent description component selector, so the JSON records selector/localization dependence.
