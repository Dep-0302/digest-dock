# Security Policy

## Supported versions

DigestDock is a small GitHub-only project. Security fixes are made on the latest code on `main` and, when releases are published, the latest GitHub release. Older snapshots are not supported.

## Report a vulnerability privately

Do not publish vulnerability details, exposed credentials, private video information, or transcript data through a public issue or pull request. This repository does not accept public security reports.

Use GitHub's private vulnerability reporting flow from this repository's **Security** tab when it is available. If the private reporting link is not visible, contact the repository owner through their GitHub profile and ask for a private reporting channel without including vulnerability details in the public message. Include the following only in the private report:

- the affected version or commit;
- the minimum steps needed to reproduce the problem;
- the expected and observed behavior;
- the security and privacy impact; and
- a suggested fix, if you have one.

Remove real API keys, access tokens, private URLs, transcripts, notes, and personal information. Use redacted values and public test content.

There is no guaranteed response time or bug-bounty program. Please allow a reasonable period for investigation and remediation before public disclosure.

## High-priority issues

Examples include:

- API keys or private content included in source, logs, screenshots, or release ZIPs;
- requests to network origins outside the documented Bilibili, Bilibili subtitle-CDN, Supadata, and DeepSeek hosts;
- script or HTML injection through transcript, metadata, service errors, or model output;
- access to browsing data outside the documented supported YouTube and Bilibili video-page scope;
- unintended transmission of notes, transcripts, or credentials;
- any direct mainline YouTube transcript-body request, or temporary signed Bilibili subtitle URLs written to storage or logs;
- a note backup that unexpectedly includes API keys, settings, complete
  transcripts, or cached overview and summary data;
- note-backup validation bypasses, unsafe handling of imported fields, or a
  backup import that changes existing notes after validation fails;
- a dependency or release-workflow compromise; and
- bypasses of local data deletion or DeepSeek configuration controls.

## User security guidance

- Install only from a GitHub source or release you trust.
- Review changes and the packaged file list before loading an update.
- Use dedicated, scoped API keys where possible and set provider spending limits.
- Do not reuse keys from production systems.
- Revoke keys immediately if a device, browser profile, ZIP, log, or screenshot exposes them.
- Remember that Chrome local extension storage is not an encrypted password vault.

## Transcript retrieval safety

- The mainline must not construct a direct YouTube transcript-body request. A minimal MAIN-world page check may return only the current video identity, limited metadata, source language, and playability evidence; it must never return a signed caption request URL.
- Temporary signed Bilibili subtitle URLs are request-scoped data. Use them only in memory for the immediate subtitle response; never write them to storage, caches, logs, diagnostics, screenshots, or test fixtures.
- Supadata is the mainline provider for new YouTube transcript bodies. It may receive only the canonical watch URL after the user has saved a key and explicitly confirms that video attempt. Consent must not be persisted or inferred from the saved key. Clear login, age, membership, region, or unavailable states must stop before the request. Requests and polling must remain bounded by timeout, response-size, single-flight, navigation, and rate-limit cooldown controls. Saving Settings and using Bilibili must not require a Supadata key.
- Transcript retrieval may read an existing platform-generated automatic caption track, but it must not download audio, perform ASR or other audio transcription, request generated transcription, or use OCR.
- Bilibili keeps its existing session-aware path: it may use normal credentialed fetch behavior for Bilibili requests, but it must not request Chrome's `cookies` permission, read cookie values, export them, or store them.

## Notes backup safety

- Treat every imported JSON backup as untrusted input, even if its filename looks
  like a DigestDock backup. Import only a file whose source you understand,
  and do not assume that changing a filename makes another JSON file safe.
- The current importer accepts the stable versioned
  `youtube-digest-notes-backup` format used before and after the DigestDock
  rename, validates its size, schema, and note fields before writing, and rebuilds
  timestamped YouTube or Bilibili URLs from validated platform, media identity,
  and timestamp fields instead of trusting a URL supplied by the backup.
- Import merges with local notes and skips duplicates. If the same note ID has
  conflicting content, or the merged result would exceed 100 notes, the entire
  import is rejected. Invalid or failed imports leave existing notes unchanged.
- Export and import are local operations and do not upload the backup. The
  downloaded file is nevertheless plain, unencrypted JSON, so anyone who obtains
  it may be able to read the notes it contains.
- Clearing extension data or removing the extension does not delete a downloaded
  backup. Delete all copies separately when they are no longer needed.
- The current JSON file is a recovery backup for DigestDock notes. Markdown,
  CSV, Anki, and other study-tool formats are separate future export ideas, not
  formats accepted by this importer.

The release tooling uses an explicit file allowlist and scans public files for common credential patterns, but automated checks cannot detect every secret.
