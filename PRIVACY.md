# Privacy

Effective: August 31, 2026

DigestDock is a GitHub-only, bring-your-own-key Chrome extension. It has no DigestDock account, developer-operated backend, analytics, advertising, or telemetry.

DigestDock handles user data only when it is necessary to provide its disclosed single purpose: turning the current supported video into a transcript, translation, overview, and timestamped notes. It does not use this data for unrelated purposes, advertising, credit decisions, or sale. API keys are persisted only in the current Chrome profile. When an AI feature runs, the required key and content are sent directly to the selected provider as described below; Supadata still requires a new confirmation for every call.

## Data the extension handles

Depending on the feature you use, DigestDock handles:

- the canonical URL and media identity of the active YouTube or Bilibili video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- per-video reading-export source records containing the title, channel, canonical
  URL, description, complete transcript, source fingerprints, and any verified
  Chinese translations already produced for those fields;
- lightweight reading-export job metadata such as export scope, language mode,
  stable unit identifiers, completed-unit identifiers, source revisions, round
  position, and the selected provider/model snapshot;
- note backup JSON files you select for import and backup files the extension
  prepares for download;
- Supadata and AI provider configuration, including API keys; and
- cached transcript, digest, and translation results.

## Where data goes

### YouTube

For a standard YouTube watch page, DigestDock first reuses a validated local transcript cache or passively observes a bounded `/api/timedtext` response that the page already requested. The Passive observer never constructs a request and never records or forwards the signed caption URL. If no zero-request result is available, DigestDock may make one credential-free request to YouTube's player endpoint and one request to the selected existing json3 timedtext track. The fixed request body declares an IOS client with Apple/iPhone device metadata; it sends `credentials: omit`, no Cookie or authorization header, and no user-agent or origin override. The returned signed caption URL is used only in memory for that immediate timedtext request and is never returned to the background, stored, or logged. DigestDock does not open or scroll YouTube's Transcript panel, download audio, perform ASR or OCR, or bypass access restrictions.

The Passive bridge keeps only bounded current-tab/video/language/track state in Chrome session storage. Successful Passive or fixed-Active transcripts are stored in the existing local positive cache for up to 30 days; failed or no-caption results are not cached. DigestDock does not automatically switch client or format after a failed Active request.

### Supadata

Supadata is a hidden, optional fallback. It is not shown on the first cache/Passive miss; it may appear only after the user enables YouTube CC and the explicit free retry still misses. A saved key is not sufficient to call it: the side panel explains the third-party request and requires confirmation for that video attempt. Only after that click may DigestDock send the canonical watch URL to `https://api.supadata.ai` with the key. Consent is not stored as a standing preference. Clear no-caption, login, age, membership, region, unavailable, or changed-page states stop before the provider request. DigestDock forces `mode=native`, requesting an existing transcript and timestamps rather than generated audio transcription. A Supadata key is not required to save Settings, use the free YouTube route, or use Bilibili.

### Bilibili

For a standard Bilibili BV video, the extension requests public video metadata and the current part's existing subtitle track directly from Bilibili domains. Bilibili API requests use the browser's current Bilibili session through normal credentialed fetch behavior, but the extension does not request the Chrome `cookies` permission, read cookie values, export them, or store them. Signed subtitle URLs are used only in memory for the immediate subtitle response and are not written to cache or logs.

### AI provider

DigestDock sends AI feature content to the AI provider you select in Settings. DeepSeek is the default (DeepSeek V4 Flash at `https://api.deepseek.com`):

- transcript plus relevant title, channel, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese
  translation, or requested source-language overview or explanation content;
- nearby transcript context and video metadata when polishing a saved note;
- the polished English note and its video title when generating the separately stored Simplified Chinese note;
- only the still-missing title, note, description-chunk, or transcript-segment
  units after you explicitly start or continue a Chinese/bilingual reading
  export round; and
- for a Bilibili Chinese source, the timestamped Chinese transcript context used to generate one Chinese overview or one polished Chinese note directly.

You select one provider from a preset list and provide that provider's API key; the endpoint, model, request format, and capability limits are fixed per provider, and there is no Base URL or model field. The selectable providers and their fixed endpoints are DeepSeek (`https://api.deepseek.com`), Zhipu GLM (`https://open.bigmodel.cn`), Alibaba Bailian Qwen (`https://dashscope.aliyuncs.com`), SiliconFlow (`https://api.siliconflow.cn`), and Fireworks (`https://api.fireworks.ai`). Each provider's key is stored separately, and DigestDock never sends your content to a provider other than the one you selected, nor does it silently fall back to another provider.

The picker also shows a disabled Tencent Hunyuan Translation entry with its bundled official icon. It has no host permission and cannot receive or use a key because the official documentation does not yet verify `hunyuan-translation-lite` on the extension's single-key OpenAI-compatible route. DigestDock does not guess that configuration.

Requests go directly from the extension to YouTube, Bilibili, explicitly authorized Supadata, or your selected AI provider. On YouTube, the free route may passively observe a page-issued caption response or make the bounded credential-free IOS/json3 request described above. Supadata and the AI provider are authenticated with the keys you supply; Bilibili uses the browser's current Bilibili session. DigestDock's developer does not proxy or receive these requests.

YouTube, Bilibili, Supadata, and your selected AI provider process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Local storage and retention

DigestDock uses Chrome's local extension storage, not a DigestDock cloud service.

- The Supadata key and each AI provider's settings and key remain on the device in Chrome's extension storage.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Recent transcript, digest, and per-segment translation cache entries are stored
  locally. The cache is limited to 20 videos, and entries older than 30 days are
  removed when the side panel opens.
- Bounded Passive observation state is stored only in Chrome session storage and is removed with the browser session or explicit cleanup.
- Compact overview records are stored separately from the much larger transcript
  cache and are limited to 100 videos. Each record contains the media identity,
  transcript fingerprint, language, generated overview, and local timestamp; it
  does not contain an API key.
- Reading-export source records are stored separately in
  `ytd_note_sources_v2`. They may include the complete local transcript,
  description, source fingerprints, and verified Chinese translations needed
  to resume an export without translating unchanged material again. The older
  `ytd_note_sources` format is read only when needed and lazily migrated; it is
  not treated as a second writable source of truth.
- Resumable export progress is stored in `ytd_note_export_jobs_v1`. Job records
  contain frozen intent and progress metadata only. They do not contain an API
  key, transcript or note bodies, description text, or translated text.
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
- Separately from JSON recovery backup, the side panel can export one video's
  notes, a selected set of source videos, all notes, or one source group as TXT,
  and can download the current transcript as TXT. Note TXT contains saved notes plus title, channel,
  canonical URL, and description; it does not append the full transcript. The
  separate transcript TXT contains the complete transcript.
- Original-language reading exports never call a network service. If Chinese or
  bilingual content is incomplete, note export shows missing metadata, titles, description
  chunks, and saved notes, while transcript export separately shows missing
  transcript segments. DigestDock does not substitute original text as Chinese.
  "Export now" stays local and writes explicit missing markers. Only an explicit
  "Complete and export" or "Continue" click may send still-missing translation units to the currently selected
  AI provider. Each user-started round runs at most 20 task batches and a
  conservative maximum of 100 provider calls, saves every valid completed batch
  locally before continuing, and stops for another click instead of automatically
  starting a new round. Cancelling stops later batches.
  A response already in flight may still be cached if it matches the frozen video
  and source revision, but it cannot start another batch, update a different
  video, or trigger an automatic download. This path never calls Supadata and
  never silently switches provider. Metadata completion reads only a video page
  the user explicitly opens; it does not open pages in the background or call Supadata.
- Reading exports are plain, unencrypted TXT outside extension
  storage. Clearing or removing DigestDock does not delete files already
  downloaded by Chrome.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

Downloaded note backups are plain, unencrypted JSON files outside the extension's storage. Anyone with access to a backup file may be able to read its notes. Removing the extension, deleting all notes, resetting extension data, or clearing the Chrome profile does not delete a backup that was already downloaded. Store it securely and delete the file separately when you no longer need it.

To remove data:

- delete individual saved notes in DigestDock;
- use the Options page to clear cached digests, delete all notes, or reset all extension data; deleting all notes and resetting extension data also remove the reading-export source library and resumable export jobs;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries;
- manually delete any downloaded note backup files from the device and other locations where you copied them; and
- revoke keys in the Supadata or your AI provider's dashboard to stop their future use.

Clearing local data does not delete information already processed or retained by YouTube, Bilibili, Supadata, or your selected AI provider. Use each service's controls for service-side requests.

## Permissions

DigestDock uses Chrome permissions for these purposes:

- `sidePanel`: display the DigestDock interface beside a supported video page.
- `storage`: store settings, keys, notes, and cached results locally.
- `unlimitedStorage`: let long-video transcripts, reusable translations, and
  already-paid-for overview results remain in Chrome's local extension storage
  without the default 10 MB ceiling. It does not grant access to local files,
  browsing history, or additional network origins; DigestDock still applies its
  own entry and record-size limits.
- `tabs`: identify and interact with the active supported video tab.
- `scripting`: coordinate the extension's YouTube and Bilibili page controls.
- YouTube host access: read the active video's URL, limited metadata, source language, access status, and sanitized track summaries; observe a page-issued timedtext body without its signed URL; or make the fixed credential-free IOS/json3 player-plus-timedtext attempt described above; show CC retry guidance; and provide timestamp controls. Panel remains outside the product route and release allowlist.
- Bilibili and Bilibili subtitle-CDN host access: resolve the current part, read an existing subtitle track, and provide timestamp controls without requesting cookie values.
- Supadata host access: retrieve a native YouTube transcript only after the user explicitly confirms that video attempt; clear access restrictions and unavailable videos stop before the request.
- AI provider host access: provide AI overviews, explanations, translation, and note polishing through the provider you select. One fixed origin is granted per selectable provider: DeepSeek (`api.deepseek.com`), Zhipu GLM (`open.bigmodel.cn`), Alibaba Bailian Qwen (`dashscope.aliyuncs.com`), SiliconFlow (`api.siliconflow.cn`), and Fireworks (`api.fireworks.ai`).

DigestDock does not use these permissions to monitor general browsing activity.

## No sale or advertising use

DigestDock does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
