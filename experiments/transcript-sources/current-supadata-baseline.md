# Current Supadata integration baseline

This baseline is structural only. The experiment deliberately does not read a
stored Supadata key or spend external quota.

## Runtime shape

- The side panel requires both a Supadata key and an AI key before loading a
  video (`sidepanel.js`, initialization path).
- `background.js` sends the canonical YouTube URL to
  `https://api.supadata.ai/v1/transcript`, requests timestamped native captions,
  and polls asynchronous jobs for long videos.
- The response is normalized to the internal contract:
  `{ transcript, transcriptText, transcriptTextTimestamped, language }`.
- Rendering, translation, overview generation, notes, and cache consumers depend
  on that internal contract rather than on the Supadata response directly.

## Operational properties

- Requires a user-managed third-party API key and quota.
- Sends the canonical watch URL to a third party.
- Adds a Supadata host permission to the extension.
- Does not require a local helper, browser-page scraping, or YouTube private
  endpoint maintenance in this repository.
- Current code has explicit handling for invalid key, rate limit, no transcript,
  and asynchronous processing, but the transcript request has no hard timeout.

## Fair-comparison note

Successful no-key candidates must normalize to the existing internal contract.
This prevents a candidate from appearing simpler merely because it omits
timestamps, language metadata, failure classification, or long-video handling.
