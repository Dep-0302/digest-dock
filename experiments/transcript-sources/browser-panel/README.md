# Browser transcript-panel experiment

This experiment measures YouTube's visible transcript panel as a caption source. It does not reuse a browser profile, saved cookies, credentials, login state, proxy, or anti-automation flags.

For tomorrow's user-driven Chrome check, prefer the standalone unpacked probe
in `manual-probe/`. It never opens or clicks the panel. The user opens the
current video's Transcript panel, collects the top and each virtualized screen,
then finalizes at the bottom. It fails closed unless it observed both bounds and
the MAIN-world player video ID matches the watch URL.

The manual probe also requires a real scroll container found from the segment
ancestor chain. If YouTube renders a short/non-scrollable or unknown virtualized
shape whose completeness cannot be proved, it reports
`PANEL_SCROLL_CONTAINER_UNKNOWN` instead of claiming a complete transcript.
Close the panel before resetting; a visible panel cannot clear the prior SPA
signature.

Completeness also requires continuous scroll coverage. Collecting only the top
and bottom while skipping the middle leaves multiple coverage ranges and returns
`PANEL_INCOMPLETE`.

Run it from this directory:

```bash
bash run.sh
```

The runner uses the bundled Playwright package and system Google Chrome. It tests four public videos chosen to distinguish short manual captions, a multilingual manual/ASR mix, a long ASR-only track, and spoken content with no caption tracks. Every page and browser action has a 20-second timeout. Consent and bot checks are recorded and terminate that case rather than being bypassed.

Results are written to `results/latest.json` and `results/latest.md`. They include player caption metadata, trigger attempts, transcript endpoint response summaries, DOM segment counts before and after scrolling, accessibility boundary checks, language-menu discovery, visible page-side effects, and a real YouTube SPA transition. `findings.md` interprets the observed differences and implementation consequences.

Transcript sentence text is compared only in memory. Result files retain timestamps, character counts, and SHA-256 signatures rather than transcript正文.
