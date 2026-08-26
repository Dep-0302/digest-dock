# `youtube-passive` experiment

This standalone Manifest V3 probe observes `www.youtube.com/api/timedtext`
responses that YouTube already requested. It does not click CC, construct a
caption URL, refresh the page, or initiate a transcript request.

## Load tomorrow

1. Open `chrome://extensions` manually.
2. Enable Developer mode.
3. Load unpacked from the exact folder:
   `experiments/transcript-sources/passive-capture/extension`.
4. Open a fresh public YouTube watch page and manually enable CC.
5. Open the probe popup and choose **读取当前结果**.

If YouTube emitted several languages or track kinds, select the requested
language and manual/ASR kind in the popup. The session cache keeps a bounded set
of six recent tab/video/language/kind captures and serializes concurrent writes;
it does not silently replace every capture with the latest response.

The probe must be loaded before the video navigation. If it is enabled after a
caption response already occurred, refresh the page. A missing observation is a
valid failure; the probe must never create its own request to manufacture a
success.

## Security and cleanup

- The MAIN-world wrapper forwards only the response body plus bounded metadata;
  it never forwards the signed request URL.
- The isolated bridge creates a per-document nonce and retries a bounded
  handshake before accepting capture messages. This prevents accidental channel
  collisions; it is not treated as a secret from the YouTube MAIN world, so all
  payload fields are still untrusted and revalidated.
- `tlang` is treated as the actual captured-text language, while `lang` remains
  source-track metadata. A translated response is never mislabeled as source
  language.
- The isolated bridge rejects a video ID that differs from the current watch
  URL.
- The service worker parses the body and stores the normalized result only in
  `chrome.storage.session`.
- **暂停观察** restores the page's original XHR/fetch functions when this probe
  still owns those wrappers. Reloading the page or disabling the probe also
  removes them.
- Do not run this probe alongside `youtube-active` in a measured test. An active
  adapter request would contaminate passive-capture evidence.
