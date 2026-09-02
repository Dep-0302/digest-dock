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
- requests to network origins outside the documented YouTube, Bilibili, Bilibili subtitle-CDN, Supadata, and selectable AI provider hosts (DeepSeek, Zhipu GLM, Alibaba Bailian Qwen, SiliconFlow, and Fireworks);
- script or HTML injection through transcript, metadata, service errors, or model output;
- access to browsing data outside the documented supported YouTube and Bilibili video-page scope;
- unintended transmission of notes, transcripts, or credentials;
- any unbounded, credential-bearing, off-task, or unauthorized YouTube transcript-body request, or temporary signed YouTube/Bilibili subtitle URLs written to storage or logs;
- a note backup that unexpectedly includes API keys, settings, complete
  transcripts, or cached overview and summary data;
- a resumable export-job record that includes an API key, transcript or note
  body, description text, translated text, or another credential;
- reuse of a stored translation after its video identity, exact segment identity,
  source fingerprint, or frozen source revision no longer matches;
- note-backup validation bypasses, unsafe handling of imported fields, or a
  backup import that changes existing notes after validation fails;
- a dependency or release-workflow compromise; and
- bypasses of local data deletion or AI provider configuration controls, or a silent fallback from the selected provider to another.

## User security guidance

- Install only from a GitHub source or release you trust.
- Review changes and the packaged file list before loading an update.
- Use dedicated, scoped API keys where possible and set provider spending limits.
- Do not reuse keys from production systems.
- Revoke keys immediately if a device, browser profile, ZIP, log, or screenshot exposes them.
- Remember that Chrome local extension storage is not an encrypted password vault.

## Transcript retrieval safety

- YouTube transcript retrieval is user-task-scoped: reuse a validated positive cache or bounded Passive capture first. A miss may start one fixed IOS player request plus one json3 timedtext request with `credentials: omit`; it must not switch client or format. Ordinary browsing still starts no request, and Panel or Supadata must not start on the first miss.
- The Passive MAIN-world observer may forward only a bounded body from a successful page-issued `/api/timedtext` response plus sanitized video/language/track metadata. It must never construct a request, forward or persist the signed caption URL, alter the response, or accept a different SPA video. Every payload remains untrusted and is revalidated in the isolated bridge and background.
- The fixed IOS/json3 Active module may run only after cache and Passive miss for the exact `videoId + routeKey + generation + epoch`. It may return only validated transcript content plus sanitized language, track, request-count, status, and byte diagnostics. It must never return or persist the signed URL, request headers, Cookie, token, or player body. Panel remains evidence-only and outside the release allowlist.
- Temporary signed Bilibili subtitle URLs are request-scoped data. Use them only in memory for the immediate subtitle response; never write them to storage, caches, logs, diagnostics, screenshots, or test fixtures.
- Supadata is a hidden, optional third-party fallback shown only after the user enables YouTube CC and the explicit free retry still ends unknown. It may receive only the canonical watch URL after the user has saved a key and explicitly confirms that video attempt. Consent must not be persisted or inferred from the saved key. Clear no-caption, login, age, membership, region, unavailable, or changed-page states must stop before the request. Requests and polling remain bounded by timeout, response-size, single-flight, navigation, and rate-limit cooldown controls. Saving Settings and using Bilibili must not require a Supadata key.
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
- The JSON file remains the only recovery format accepted by the importer.
  TXT note exports and TXT transcript downloads are one-way reading
  exports and are never accepted as restore input.
- Original-language TXT export is local-only. Chinese and bilingual
  completion fails closed when its scoped content is incomplete: note TXT
  checks only title, description, and saved notes; transcript TXT checks complete
  transcript segments. Only an explicit
  "Complete and export" or "Continue" action may call the selected AI
  provider. A saved key is not standing consent: each action starts at most 20
  task batches and a conservative maximum of 100 provider calls, saves each
  valid batch before continuing, and never starts the next round automatically.
  Cancelling prevents later batches; a response
  already in flight may enter the reusable cache only while the frozen media and
  source revision still match, and it must not trigger another batch or download.
  This path never calls Supadata and never falls back to another provider.
- Persistent reading-export source data must validate exact segment identity and
  source fingerprints before reusing translations. Export progress records are
  metadata-only and must not duplicate keys or content. Deleting all notes or
  resetting extension data must also clear source records and export jobs so
  they do not become unmanaged residual data.
- `unlimitedStorage` removes Chrome's default local-extension quota but grants no
  file or network access. Runtime caches must remain bounded, keep compact
  overviews separate from transcript payloads, validate media identity and source
  fingerprints before reuse, and surface persistence failure instead of silently
  spending another provider request.

The release tooling uses an explicit file allowlist and scans public files for common credential patterns, but automated checks cannot detect every secret.
