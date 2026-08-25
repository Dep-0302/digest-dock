# DigestDock

[English](README.md) | [简体中文](README.zh-CN.md)

DigestDock is a Manifest V3 Chrome extension for working with captioned media as structured study material. It keeps the transcript, bilingual translation, AI overview, explanations, and timestamped notes beside the source instead of splitting the workflow across several tools.

This version also supports standard `www.bilibili.com/video/BV...` pages with an existing human or AI subtitle track. It reads only the current part, reuses the active Bilibili browser session without reading or storing cookie values, and generates Chinese overviews and polished Chinese notes directly from Chinese subtitles.

The main workflow is intentionally small:

- Read and search the timestamped source transcript.
- Switch between the original transcript, Simplified Chinese, and an aligned bilingual view.
- Generate a chapter-based overview, inspect key quotes, and explain selected text.
- Jump back to the video from transcript rows, overview chapters, or saved notes.
- Save polished timestamped notes and move them between devices with a versioned JSON backup.
- Keep credentials and project data under your control with bring-your-own API keys, local Chrome storage, and no analytics or telemetry.

DigestDock is a personal derivative of [Zara Zhang's original YouTube Digest](https://github.com/zarazhangrui/youtube-digest). It keeps the existing YouTube workflow intact while adding Bilibili subtitle support and cross-platform note backup and restore. The original project and the public implementations used for Bilibili integration research are credited in [Acknowledgements and references](#acknowledgements-and-references).

The extension is installed locally from GitHub. It is not distributed through the Chrome Web Store, does not include API credits, and does not use a developer-operated backend.

## Install with your coding agent

Copy the URL of the repository page you are reading, then send this message to your coding agent:

> Download or clone the repository at `[PASTE THIS REPOSITORY URL HERE]` into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/digest-dock` on macOS or Linux, or `%USERPROFILE%\Documents\digest-dock` on Windows, but do not assume either path. Walk me through installation and setup in simple terms.

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/digest-dock` on macOS or Linux, or `%USERPROFILE%\Documents\digest-dock` on Windows.
2. Open the official page for the AI provider you choose and, if you want new YouTube transcripts, the Supadata page, then help you create your own accounts.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Show you where to select an AI provider and enter its key, plus the Supadata key used for new YouTube transcripts, in the extension's **Settings** page.
5. Open a YouTube video with captions and confirm the transcript and translation work.

Keep this folder in the same place after installation. If you move or delete it, Chrome's unpacked extension stops working until you load the extension again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the DigestDock Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

For a manual installation:

1. On the repository page you are reading, choose **Code**, then **Download ZIP**.
2. Choose a permanent folder and unzip the project there. Optional suggestions are `~/Documents/digest-dock` on macOS or Linux, or `%USERPROFILE%\Documents\digest-dock` on Windows. You may use a different folder.
3. In Chrome, open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the exact project folder you chose, which must contain `manifest.json`.
7. Pin DigestDock from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the DigestDock card at `chrome://extensions`, then refresh open YouTube or Bilibili video tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

If you move an existing installation from an older `youtube-digest` folder into a new `digest-dock` folder, export a notes backup first. Chrome can treat a different unpacked path as a separate extension, so local settings and notes may not carry over automatically; load the new folder, configure its settings, and import the backup there.

DigestDock namespaces its injected page controls by extension ID, so an older YouTube Digest installation no longer deletes or takes over the current buttons when both remain enabled. The current page entry uses its own DigestDock icon and accessible label. Each extension still has separate settings and notes. While a legacy page control is present, the historical `N` shortcut is left to that version and the current build remains available through its own accessible note button. For release acceptance, keep only the version under test enabled.

## Set up your API keys

Provider access uses your own accounts. In **Settings** you select one AI provider from a preset list and paste that provider's API key; it powers overviews, explanations, translation, and automatic note polishing on both supported platforms. DeepSeek is the default provider. A Supadata key is optional for the extension as a whole because Bilibili does not use it, but it is required when you choose to fetch a new YouTube transcript.

For a new or expired YouTube cache entry, Supadata is the only transcript-body provider on the mainline. A saved key is never used automatically: the side panel explains that it will send the canonical watch URL and asks whether to use Supadata for that video attempt. Clear login, age, membership, region, or unavailable states stop before any Supadata request. DigestDock requests `mode=native`, so it asks only for an existing YouTube caption track and never for generated audio transcription. Bilibili continues to retrieve its existing subtitle track directly and does not use Supadata.

### Get a Supadata API key for YouTube transcripts

Skip this section if you use only Bilibili or do not need new YouTube transcripts. Saving Settings and using Bilibili do not require a Supadata key.

1. Open the official [Supadata sign-up page](https://dash.supadata.ai/auth/sign-up).
2. Create an account and complete the short onboarding flow.
3. Supadata generates an API key automatically during onboarding.
4. Open the [Supadata dashboard](https://dash.supadata.ai/) whenever you need to find or manage the key.
5. Copy the key and paste it into **Supadata API key** in DigestDock Settings.

See the [official Supadata documentation](https://docs.supadata.ai/) if the dashboard flow changes.

### Get an AI provider API key

DeepSeek is the default. To create a DeepSeek key:

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys).
2. Sign in or create a DeepSeek Platform account when prompted.
3. Choose **Create new API key**, give it a recognizable name such as `DigestDock`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Paste it into the **API key** field in DigestDock Settings while DeepSeek is selected.
6. If DeepSeek reports insufficient balance, add credit in your DeepSeek Platform account and try again.

See the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for current account and API details.

Open **Settings** from the side panel. You can also open the DigestDock **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste keys only into these Settings fields. Never paste a key into an AI chat, repository file, screenshot, or public message.

You select an AI provider from a preset picker in Settings; you never enter a Base URL or model name. Each provider's endpoint, model, request format, and capability limits are supplied by the extension:

| Provider | Model | Create a key |
| --- | --- | --- |
| DeepSeek (default) | DeepSeek V4 Flash | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) |
| Zhipu GLM | GLM-4.7-Flash | [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) |
| Alibaba Bailian Qwen | Qwen Flash (Qwen3) | [bailian.console.aliyun.com](https://bailian.console.aliyun.com/?apiKey=1) |
| SiliconFlow | Qwen3-8B | [cloud.siliconflow.cn](https://cloud.siliconflow.cn/account/ak) |
| Fireworks | DeepSeek V4 Flash | [app.fireworks.ai](https://app.fireworks.ai/settings/users/api-keys) |
| Tencent Hunyuan Translation | hunyuan-translation-lite | Official icon shown as unavailable; it cannot be selected until the single-key compatible route is verified |

Each provider's key is stored separately, so switching providers and switching back keeps the key you already entered. Selecting or saving a provider never sends a network request, and DigestDock never silently falls back from one provider to another: if a provider fails or lacks a capability, it says so instead of quietly using a different service. DeepSeek requests are sent in non-thinking mode for responsive, predictable interactions.

Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Use DigestDock

A normal YouTube session follows this path:

1. Open a standard YouTube watch page that exposes a native caption track.
2. Click the DigestDock extension icon to open the side panel.
3. Read the timestamped transcript, or choose **Original**, **中文**, or **双语**.
4. Open **Overview** for the Chinese-first chapter summary, then choose **Original**, **中文**, or **双语**.
5. Select a transcript range when you need a focused AI explanation.
6. Save a note from the player or a key quote, then review it from **Notes** in **Original**, **中文**, or **双语** mode.

On Bilibili, open a standard BV video with subtitles. Each part is treated as an independent learning resource. Open the extension or use the injected **生成摘要** button, then use the player overlay when you want to save a timestamped note.

## Back up and restore notes

The **Notes backup** card in Settings provides a versioned JSON recovery format. Export a copy before reinstalling the extension, clearing a Chrome profile, or moving notes to another device.

To create a backup:

1. Open DigestDock **Settings**.
2. Under **Notes backup**, choose **Export notes backup**.
3. Keep the downloaded `digest-dock-notes-YYYY-MM-DD.json` file somewhere secure and available to the new device.

To restore on another device or Chrome profile:

1. Install or reload DigestDock, then open **Settings**.
2. Under **Notes backup**, choose **Import notes backup** and select the JSON file.
3. Wait for the result shown in Settings. Configure API keys and other settings separately; they are not restored from this file.

The JSON file contains backup-format metadata and saved note records only, including their stored original/English and Simplified Chinese content and the validated YouTube or Bilibili media identity and timestamp details needed to restore them. It does not contain API keys, extension settings, complete transcripts or transcript caches, or overview and summary caches. Source text already saved inside an individual note remains part of that note record. Exporting and importing use only the downloaded file and Chrome's local extension storage; these actions do not send the backup to Bilibili, Supadata, DeepSeek, or any other network service.

Import merges the backup with notes already on the device and skips duplicates. If a matching note is missing stored content, the import may fill that content from the backup. If the same note ID has conflicting content, or the merged result would exceed the 100-note limit, the entire import is rejected. Invalid, unsupported, oversized, or otherwise failed imports do not change the notes already stored on the device.

Backup files are plain, unencrypted JSON and may contain personal notes. Store and share them accordingly. Removing the extension or clearing its local data does not delete a previously downloaded backup file; delete that file separately when you no longer need it.

Treat every imported JSON file as untrusted input, even when its filename looks correct. Import only a backup whose source you understand. DigestDock rebuilds timestamp URLs from validated media fields instead of trusting URLs supplied by the backup.

Backups exported before the rename, including files named `youtube-digest-notes-YYYY-MM-DD.json`, remain importable. DigestDock validates the JSON content rather than trusting the filename.

JSON is the recovery backup format for DigestDock notes and remains separate from reading exports. The Notes tab exports the current video, selected source videos, all notes, or one source group as UTF-8 TXT. Each video section includes title, channel, URL, description, and timecode-sorted saved notes; it does not append the full video transcript. The Transcript tab separately downloads the complete UTF-8 TXT transcript in the current original, Chinese, or bilingual mode.

Original-language reading exports use local material only and make no AI or Supadata request. Note TXT preflight lists only missing metadata, titles, description chunks, and saved-note translations; it never requires translation of the full transcript. When material is incomplete the four explicit choices are **Complete and export**, **Export now**, **Export original**, and **Abandon export**. Export now writes visible missing markers and never passes original text off as Chinese. Complete and export may read metadata only from a video page the user explicitly opens and may translate the selected scope only after that click; it never opens videos in the background or calls Supadata. Transcript TXT completion separately lists missing transcript segments. Long completion work remains bounded and resumable.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages.
- Standard `www.bilibili.com/video/BV...` pages, one current part at a time.
- Human or AI subtitle tracks exposed by the current Bilibili browser session. Bilibili transcript retrieval does not use Supadata credits.
- For YouTube, a read-only page check binds the current tab and video and blocks clear access restrictions before any provider request. After per-video confirmation, Supadata retrieves the existing native caption track.
- A saved Supadata key is not standing consent. New or expired YouTube transcript cache entries require an explicit side-panel confirmation; cached Supadata results are reused without another provider call.
- Original, Simplified Chinese, and aligned bilingual transcript views for non-Chinese subtitle tracks. Chinese subtitle tracks stay in Original and never trigger a Chinese-translation request.
- AI overviews are generated directly in Simplified Chinese. For non-Chinese subtitle tracks, source-language chapter titles and summaries are translated only when **Original** or **Bilingual** is requested; key quotes preserve the source wording. Chinese-source overviews reuse Chinese in every mode without an extra translation call.
- Notes are polished in English once and translated into Simplified Chinese once; bilingual note mode only combines the two stored versions.
- When a note's source subtitle is already Chinese, the original subtitle is reused as the Chinese note and no Chinese-translation request is sent.
- For Bilibili Chinese subtitles, the overview and polished note are generated directly in Chinese with one AI request each; no English round-trip is made.
- Local notes, versioned JSON note backup and restore, and a local cache for recent transcript and digest results.
- All notes grouped by source video and ordered within each source strictly by timecode, plus selectable per-video TXT note exports and language-aware TXT transcript downloads.
- Resumable Chinese and bilingual exports. Note TXT completes only metadata, title, description, and saved-note content in the frozen selected scope; transcript TXT independently completes transcript segments. Verified translations are reused from local storage and every valid batch is persisted before continuing.
- A preset AI provider you select in Settings powers all AI features: DeepSeek V4 Flash (default), Zhipu GLM-4.7-Flash, Alibaba Bailian Qwen Flash, SiliconFlow Qwen3-8B, or Fireworks DeepSeek V4 Flash. Each provider's endpoint and model are fixed, keys are stored per provider, and there is no custom-endpoint field.
- The provider picker also shows the official Tencent Hunyuan Translation icon as unavailable. Tencent documents `hunyuan-translation-lite`, but does not document that model on the extension's current single-key OpenAI-compatible route, so DigestDock does not guess the endpoint, model routing, or authentication.

YouTube coverage depends on Supadata returning an existing native transcript. Shorts, live streams, Bilibili bangumi pages, private or access-restricted videos, hardcoded image subtitles, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

For YouTube, DigestDock forces Supadata `mode=native`. On both platforms it uses only subtitle tracks that already exist. It may read an existing automatic caption track, but it does not download audio, perform ASR or other audio transcription, request generated transcription, or use OCR.

## Supadata YouTube transcript costs

Current as of August 9, 2026, the [Supadata pricing page](https://supadata.ai/pricing) lists a free tier with **100 credits per month**, no credit card required. Unused credits do not roll over. Supadata pricing can change, so check the current page before relying on these numbers.

The [Supadata transcript documentation](https://docs.supadata.ai/get-transcript) describes the transcript request modes and credit behavior:

- A native transcript request uses **1 credit**, regardless of video duration.
- A generated transcript costs **2 credits per video minute**. DigestDock does not use this path because it forces `mode=native`.
- An unavailable native lookup returned as HTTP `206` still uses **1 credit**.

When the user confirms a new YouTube transcript request, the current native-only behavior means the free tier can cover roughly 100 transcript lookups per month when each request succeeds once. Retries and provider-side no-native-transcript results may also consume credits, so actual successful-video coverage can be lower. Cached results do not make another Supadata request until they expire or are cleared.

DeepSeek usage is separate from Supadata. DeepSeek may apply its own free quota, rate limits, or charges. DigestDock does not collect payments or resell access. Set spending limits and monitor each provider account you configure. The estimate below explains the current DeepSeek translation cost.

## DeepSeek V4 Flash translation cost estimate

Current as of August 10, 2026, DeepSeek lists the following prices per 1 million tokens on its official [pricing page](https://api-docs.deepseek.com/quick_start/pricing/):

- Cache-hit input: **$0.0028 USD**.
- Cache-miss input: **$0.14 USD**.
- Output: **$0.28 USD**.

DeepSeek says these prices may increase soon, so check the current pricing page before relying on this estimate. Its official [token usage guide](https://api-docs.deepseek.com/quick_start/token_usage/) estimates about 0.3 token per English character and about 0.6 token per Chinese character. Its [context caching guide](https://api-docs.deepseek.com/guides/kv_cache/) explains the automatic best-effort disk cache used for repeated prefixes.

A measured 20-minute English talk contained **2,935 spoken English words** and 15,433 transcript characters. With DigestDock's current grouping, it became 128 semantic segments and 43 requests of three segments each. Repeated prompts and JSON brought the rendered input to about 108,528 English characters, or **about 32,600 input tokens** using DeepSeek's 0.3 token per English character heuristic. The translated Chinese JSON output is estimated at about 3,500 to 4,500 tokens using the 0.6 token per Chinese character heuristic, plus JSON and ID overhead.

If all input is billed as cache miss, input costs about $0.0046 and output costs about $0.0010 to $0.0013, for a total of about $0.0056 to $0.0059. When much of the repeated system prompt hits DeepSeek's automatic best-effort cache, a realistic lower end is about $0.002 to $0.003. A practical estimate for fully translating this talk is therefore **$0.002 to $0.006 USD, about ¥0.02 to ¥0.04**.

Interactive translation is lazy and progressive. Cached segments are reused, and only rows you request by scrolling into them incur calls. Only an explicit **Complete and export** or **Continue** action may complete missing off-screen rows after confirmation. Long exports are divided into user-started rounds of at most 20 task batches; valid batches are saved immediately and later rounds plan only the remaining source-version-matched units. No round continues automatically. Retries, provider behavior, and pricing changes can increase the final cost.

## Privacy and data flow

DigestDock makes network requests directly from the extension:

1. For YouTube, it reads only the current tab's video identity, metadata, source language, and access status. It does not request a YouTube transcript body directly.
2. On a new or expired YouTube cache entry, the side panel asks for one-time authorization. Only after you click the Supadata action may DigestDock send the canonical watch URL and your key to Supadata for a `mode=native` transcript request. Clear login, age, membership, region, and unavailable states stop before that request.
3. For Bilibili, it requests the current video's metadata and existing subtitle track directly from Bilibili while reusing the browser's current session; it does not read or store cookie values.
4. It sends the transcript and relevant video metadata to the AI provider you selected in Settings when you request AI features. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
5. It stores keys, settings, notes, recent caches, reusable per-video export translations, and lightweight export-progress metadata locally in Chrome. Export jobs do not store API keys, transcript or note bodies, or translated text; those texts remain in their existing note or per-video source records. Temporary signed Bilibili subtitle URLs are used only for the immediate request and are not stored or logged.

Deleting all notes or resetting extension data also clears the per-video reading-export source library and pending export jobs. It does not delete TXT or JSON files that Chrome already downloaded.

There is no DigestDock account system, advertising, analytics, or telemetry. YouTube, Bilibili, optional Supadata, and your selected AI provider still process requests under their own terms and privacy policies. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

### The Digest button is missing on a video

- At `chrome://extensions`, find DigestDock and click **Reload**, then refresh the video tab.
- Confirm that you are on a standard `https://www.youtube.com/watch?...` or `https://www.bilibili.com/video/BV...` page, not a Short, embed, live stream, or Bilibili bangumi page.
- The current version automatically follows YouTube when its responsive action bar changes. Wait a moment after the page finishes loading.
- If you have an older downloaded copy, resizing the YouTube window horizontally once may reveal the button. Then download the latest version so resizing is no longer required.
- If it is still missing, ask your coding agent to inspect the content script on that exact video page.

### The side panel does not open

- Confirm that you are on a standard `https://www.youtube.com/watch?...` or `https://www.bilibili.com/video/BV...` page.
- At `chrome://extensions`, confirm DigestDock is enabled and click **Reload**.
- Refresh the video tab after reloading the extension.
- Ask your coding agent to inspect the extension if the problem continues.

### DigestDock asks for setup

- Select an AI provider in Settings and save its API key for AI features. Add a Supadata key if you want new YouTube transcripts; Bilibili can still be used without it.
- Each provider's endpoint and model are preset, so there are no Base URL or Model fields to configure. Switching providers keeps each provider's key.
- If Settings says a legacy custom provider was removed, select a provider and enter its key. The old custom-endpoint key was cleared so it could not be reused with the wrong service.

### No transcript is found

- Confirm the video is public and has native captions.
- For YouTube, check the Supadata key, remaining credits, rate limit, and account status, then confirm the request once in the side panel. Lookups and retries may consume credits.
- For Bilibili, confirm that the current part exposes an independent subtitle track and that you are signed in to Bilibili when the track requires a session. Hardcoded subtitles in the video image cannot be read.

DigestDock will not fall back to generated transcription or perform audio ASR.

### AI requests fail

- A `401` or `403` usually means the selected provider's key or account access is invalid.
- A `429` usually means the selected provider's rate or spending limit was reached.
- Confirm the key was created in that provider's account and that the account has available credit.
- If one provider keeps failing, select a different provider in Settings and save its key. DigestDock never switches providers on its own.

Never share API keys, private transcripts, or personal notes in chats, screenshots, or logs.

## Checks for coding agents

Ask your coding agent to run these commands after changing the project:

```bash
npm test
npm run check
npm run package
```

The agent should also reload the unpacked extension in Chrome and test real videos on every supported platform it changed. Automated checks do not prove that live provider requests or page interactions work.

## Acknowledgements and references

DigestDock builds on [YouTube Digest](https://github.com/zarazhangrui/youtube-digest), originally created by [Zara Zhang](https://github.com/zarazhangrui) and released under the MIT License. Thank you to Zara for publishing the original side-panel workflow and making it practical to study, modify, and extend.

The Bilibili data path is implemented in this repository. The following public projects were used as engineering references for understanding and cross-checking page metadata, current-part identity, session-visible subtitle tracks, and subtitle normalization. They are not runtime dependencies, and their inclusion here does not mean their source code is bundled into this extension:

- [Bili Clipper](https://github.com/echore/bili-clipper)
- [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved)
- [ChatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox)
- [BiliNote](https://github.com/JefferyHcool/BiliNote)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)

Thanks to the authors and maintainers of these projects for documenting behavior that is otherwise difficult to validate from a browser integration alone. Each project remains governed by its own license and copyright notices. Bilibili's internal web interfaces may also change over time.

## License

MIT. See [LICENSE](LICENSE). The original copyright notice is retained.
