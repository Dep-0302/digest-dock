# Privacy

Effective: August 19, 2026

DigestDock is a GitHub-only, bring-your-own-key Chrome extension. It has no DigestDock account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, DigestDock handles:

- the canonical URL and media identity of the active YouTube or Bilibili video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- note backup JSON files you select for import and backup files the extension
  prepares for download;
- optional Supadata fallback and DeepSeek configuration, including API keys; and
- cached transcript, digest, and translation results.

## Where data goes

### YouTube

For a standard YouTube watch page, the extension first reads caption-track data exposed by the active page and requests the selected `timedtext` response directly from YouTube. If that does not return a usable transcript, it may send the video identity to YouTube's player endpoint with additional non-WEB client profiles and try the resulting caption tracks.

All network requests initiated by the extension for this YouTube transcript path use `credentials: "omit"`; the extension does not attach the browser's YouTube cookies or authorization credentials. Temporary signed caption URLs are kept only in memory for the immediate request and are not stored in Chrome storage, transcript caches, or logs. Parsed transcript content may still enter the local transcript cache described below.

This path reads only caption tracks that YouTube already exposes. It does not download the video's audio, perform ASR or other audio transcription, request generated transcription, or use OCR, and it does not guarantee coverage of every captioned video.

### Supadata

Supadata is an optional failure fallback for YouTube. Local failure and a saved key are not sufficient to call it: the side panel explains the third-party request and requires you to confirm that attempt. Only after that click may DigestDock send the canonical video URL to `https://api.supadata.ai` with your key. Consent is not stored as a standing preference. The fallback requests a native transcript and timestamps; it does not request generated transcription. A Supadata key is not required to save Settings, try local YouTube retrieval, or use Bilibili.

### Bilibili

For a standard Bilibili BV video, the extension requests public video metadata and the current part's existing subtitle track directly from Bilibili domains. Bilibili API requests use the browser's current Bilibili session through normal credentialed fetch behavior, but the extension does not request the Chrome `cookies` permission, read cookie values, export them, or store them. Signed subtitle URLs are used only in memory for the immediate subtitle response and are not written to cache or logs.

### DeepSeek

The published version sends AI feature content to DeepSeek V4 Flash at `https://api.deepseek.com`:

- transcript plus relevant title, channel, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese
  translation, or requested source-language overview or explanation content;
- nearby transcript context and video metadata when polishing a saved note; and
- the polished English note and its video title when generating the separately stored Simplified Chinese note; and
- for a Bilibili Chinese source, the timestamped Chinese transcript context used to generate one Chinese overview or one polished Chinese note directly.

The endpoint and `deepseek-v4-flash` model are fixed in the published Settings page. You provide one DeepSeek API key. To use another provider or model, you must adapt your own local source copy and its permissions. The Settings page provides a coding-agent prompt for that purpose and warns you never to include an API key in the prompt or chat.

Requests go directly from the extension to YouTube, Bilibili, optional Supadata, or DeepSeek. Supadata and DeepSeek are authenticated with the keys you supply; extension-initiated YouTube transcript requests omit credentials, while Bilibili uses the browser's current Bilibili session. DigestDock's developer does not proxy or receive these requests.

YouTube, Bilibili, Supadata, and DeepSeek process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Local storage and retention

DigestDock uses Chrome's local extension storage, not a DigestDock cloud service.

- The optional Supadata fallback key and DeepSeek settings and key remain on the device in Chrome's extension storage.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Recent transcript, digest, and per-segment translation cache entries are stored
  locally. The cache is limited to 20 videos, and entries older than 30 days are
  removed when the side panel opens.
- The Settings page can export saved notes to a versioned JSON recovery file and
  import that file later. The file contains backup-format metadata and saved
  note records only, including their stored original/English and Simplified
  Chinese content and the validated YouTube or Bilibili media identity and
  timestamp details needed to restore them. It
  does not contain API keys, extension settings, complete transcripts or
  transcript caches, or overview and summary caches. Source text already saved
  inside an individual note remains part of that note record.
- Note backup export and import use the downloaded file and Chrome's local
  extension storage only. They do not send the backup to Supadata, DeepSeek, the
  developer, or another network service.
- Import validates and merges the file with existing notes, skips duplicates,
  and may fill content missing from an existing matching note. A conflicting
  note ID or a merged total above 100 rejects the entire import. A failed import
  does not change the notes already stored by the extension.
- Imported timestamp URLs are rebuilt from validated YouTube or Bilibili media
  fields. A URL supplied by the backup file is not trusted as the source of
  media identity.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

Downloaded note backups are plain, unencrypted JSON files outside the extension's storage. Anyone with access to a backup file may be able to read its notes. Removing the extension, deleting all notes, resetting extension data, or clearing the Chrome profile does not delete a backup that was already downloaded. Store it securely and delete the file separately when you no longer need it.

To remove data:

- delete individual saved notes in DigestDock;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries;
- manually delete any downloaded note backup files from the device and other locations where you copied them; and
- revoke keys in the Supadata or DeepSeek dashboard to stop their future use.

Clearing local data does not delete information already processed or retained by YouTube, Bilibili, Supadata, or DeepSeek. Use each service's controls for service-side requests.

## Permissions

DigestDock uses Chrome permissions for these purposes:

- `sidePanel`: display the DigestDock interface beside a supported video page.
- `storage`: store settings, keys, notes, and cached results locally.
- `tabs`: identify and interact with the active supported video tab.
- `scripting`: coordinate the extension's YouTube and Bilibili page controls.
- YouTube host access: read the active video's URL, metadata, and existing caption tracks; request player and `timedtext` responses with credentials omitted; and provide timestamp controls.
- Bilibili and Bilibili subtitle-CDN host access: resolve the current part, read an existing subtitle track, and provide timestamp controls without requesting cookie values.
- Supadata host access: retrieve a native transcript only after local YouTube retrieval fails and the user explicitly confirms that third-party attempt.
- DeepSeek host access: provide AI overviews, explanations, translation, and note polishing through DeepSeek V4 Flash.

DigestDock does not use these permissions to monitor general browsing activity.

## No sale or advertising use

DigestDock does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
