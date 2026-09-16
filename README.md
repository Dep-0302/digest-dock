# DigestDock

[English](README.md) | [简体中文](README.zh-CN.md)

A Chrome extension that turns video watching into thinking — capture your thoughts at the exact moment they happen, and find your way back to them.

## Why DigestDock

You're watching a talk. One sentence triggers an idea. By the time you find a place to write it down, you've lost the thread.

DigestDock keeps that link alive: **the thought you had, the sentence that triggered it, and the exact moment in the video** — all saved with one keystroke. Days later, searching that thought takes you back to the trigger point, and you remember why you thought it.

**Press N** while watching → quote saved, video keeps playing → press N again within 10 seconds to add your thought → Enter to save → done.

Your thoughts are never rewritten by AI. No tags, no categories, no extra steps.

## What it does

| | |
|---|---|
| **Thought capture** | Save quotes and your own thoughts with one keystroke. Thoughts stay exactly as you wrote them. |
| **Cross-video search** | Search thoughts, quotes, translations, titles, and channels across your entire library. Optional AI-assisted search when exact match finds nothing. |
| **Timestamped transcripts** | Original, Simplified Chinese, and bilingual views. Jump to any moment from transcript, overview, or notes. |
| **AI overviews** | Chapter-based summaries with key quotes. Bring your own API key — DeepSeek, Zhipu, Alibaba Bailian, SiliconFlow, or Fireworks. |
| **YouTube + Bilibili** | Standard YouTube watch pages and Bilibili BV video pages with subtitle tracks. |
| **Local and private** | Notes, settings, keys, and caches stay in Chrome local storage. No accounts, analytics, or telemetry. JSON backup for portability. |

## Install

### Quick start (with a coding agent)

Copy this repository URL and send it to your coding agent:

> Download or clone `https://github.com/Dep-0302/digest-dock` into a permanent folder, walk me through loading it as an unpacked Chrome extension, and verify the transcript works on a YouTube video.

### Manual

1. Download ZIP from this page → **Code** → **Download ZIP**
2. Unzip to a permanent folder (e.g. `~/Documents/digest-dock`)
3. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the folder
4. Pin DigestDock from Chrome's Extensions menu

> Keep the folder in place. Moving or deleting it disables the extension until you reload from the new location. Updates are manual: replace the files, reload the extension, and refresh open video tabs.

## Set up AI features (optional)

Transcripts, timestamp navigation, notes, and backups work without an API key.

For AI overviews, translations, and note polishing, select a provider in **Settings** and paste its key:

| Provider | Model | Get a key |
|---|---|---|
| DeepSeek (default) | DeepSeek V4 Flash | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| Zhipu GLM | GLM-4.7-Flash | [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) |
| Alibaba Bailian | Qwen Flash | [bailian.console.aliyun.com](https://bailian.console.aliyun.com/?apiKey=1) |
| SiliconFlow | Qwen3-8B | [cloud.siliconflow.cn](https://cloud.siliconflow.cn/account/ak) |
| Fireworks | DeepSeek V4 Flash | [app.fireworks.ai](https://app.fireworks.ai/settings/users/api-keys) |

Keys are stored locally per provider. Switching providers keeps previously entered keys. Never paste a key into a chat, file, or screenshot.

## Typical workflow

1. Open a YouTube or Bilibili video with captions
2. Click DigestDock to open the side panel
3. Read the transcript — switch between Original / 中文 / 双语
4. Open **Overview** for chapter summaries with key quotes
5. Press **N** to save a quote; press **N** again to add your thought
6. Find your notes later via search or the time-sorted view in **All notes**

## Back up your notes

**Settings → Notes backup → Export** saves a versioned JSON file. Import merges with existing notes and skips duplicates. Back up before reinstalling or switching devices.

Backup files are unencrypted — store them securely. API keys and settings are not included in the backup.

## Privacy

DigestDock makes network requests only for: YouTube/Bilibili transcript retrieval (credential-free for YouTube), your selected AI provider (only when you use AI features), and optional Supadata fallback (only after explicit confirmation per video). There is no account system, analytics, or telemetry. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

**Digest button missing?** Reload the extension at `chrome://extensions`, then refresh the video tab.

**No transcript?** For YouTube: enable CC on the player, then click "Already enabled captions, read again" in DigestDock. For Bilibili: confirm the video has a subtitle track.

**AI requests failing?** Check that the key matches the selected provider and the account has credit. A `429` means a rate/spending limit was reached.

## For developers

```bash
npm test        # 920 automated tests
npm run check   # lint and type checks
npm run package # build the release zip
```

## Credits

Built on [YouTube Digest](https://github.com/zarazhangrui/youtube-digest) by [Zara Zhang](https://github.com/zarazhangrui) (MIT License). Bilibili integration references: [Bili Clipper](https://github.com/echore/bili-clipper), [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved), [ChatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox), [BiliNote](https://github.com/JefferyHcool/BiliNote), [yt-dlp](https://github.com/yt-dlp/yt-dlp) — used for documentation validation only, not bundled.

## License

MIT. See [LICENSE](LICENSE).
