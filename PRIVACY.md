# Privacy

Effective: August 18, 2026

YouTube Digest is a GitHub-only, bring-your-own-key Chrome extension. It has no YouTube Digest account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, YouTube Digest handles:

- the canonical URL and media identity of the active YouTube or Bilibili video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- Supadata and DeepSeek configuration, including API keys; and
- cached transcript, digest, and translation results.

## Where data goes

### Supadata

For YouTube videos, YouTube Digest sends the canonical video URL to `https://api.supadata.ai` with your Supadata API key. Supadata returns the transcript and timestamps. A Supadata key is required for YouTube transcript retrieval, but not for Bilibili-only use.

### Bilibili

For a standard Bilibili BV video, the extension requests public video metadata and the current part's existing subtitle track directly from Bilibili domains. Bilibili API requests use the browser's current Bilibili session through normal credentialed fetch behavior, but the extension does not request the Chrome `cookies` permission, read cookie values, export them, or store them. Signed subtitle URLs are used only in memory for the immediate subtitle response and are not written to cache or logs.

### DeepSeek

The published version sends AI feature content to DeepSeek V4 Flash at `https://api.deepseek.com`:

- transcript plus relevant title, channel, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese
  translation, or requested overview or explanation content;
- nearby transcript context and video metadata when polishing a saved note; and
- the polished English note and its video title when generating the separately stored Simplified Chinese note.
- for a Bilibili Chinese source, the timestamped Chinese transcript context used to generate one Chinese overview or one polished Chinese note directly.

The endpoint and `deepseek-v4-flash` model are fixed in the published Settings page. You provide one DeepSeek API key. To use another provider or model, you must adapt your own local source copy and its permissions. The Settings page provides a coding-agent prompt for that purpose and warns you never to include an API key in the prompt or chat.

Requests go directly from the extension to Bilibili, Supadata, or DeepSeek. Supadata and DeepSeek are authenticated with the keys you supply; Bilibili uses the browser's current Bilibili session. YouTube Digest's developer does not proxy or receive these requests.

Bilibili, Supadata, and DeepSeek process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Local storage and retention

YouTube Digest uses Chrome's local extension storage, not a YouTube Digest cloud service.

- Supadata and DeepSeek settings and API keys remain on the device in Chrome's extension storage.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Recent transcript, digest, and per-segment translation cache entries are stored
  locally. The cache is limited to 20 videos, and entries older than 30 days are
  removed when the side panel opens.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

To remove data:

- delete individual saved notes in YouTube Digest;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries; and
- revoke keys in the Supadata or DeepSeek dashboard to stop their future use.

Clearing local data does not delete information already processed or retained by Bilibili, Supadata, or DeepSeek. Use each service's controls for service-side requests.

## Permissions

YouTube Digest uses Chrome permissions for these purposes:

- `sidePanel`: display the YouTube Digest interface beside a supported video page.
- `storage`: store settings, keys, notes, and cached results locally.
- `tabs`: identify and interact with the active supported video tab.
- `scripting`: coordinate the extension's YouTube and Bilibili page controls.
- YouTube host access: read the active video's URL and metadata and provide timestamp controls.
- Bilibili and Bilibili subtitle-CDN host access: resolve the current part, read an existing subtitle track, and provide timestamp controls without requesting cookie values.
- Supadata host access: retrieve transcripts.
- DeepSeek host access: provide AI overviews, explanations, translation, and note polishing through DeepSeek V4 Flash.

YouTube Digest does not use these permissions to monitor general browsing activity.

## No sale or advertising use

YouTube Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
