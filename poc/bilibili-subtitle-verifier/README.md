# Bilibili Subtitle Verifier

这是一个与正式扩展隔离的只读验证器，用来回答一个问题：当前 Chrome 已打开的标准 B 站视频，能否提供可供总结和时间戳笔记使用的独立字幕正文。

## 验证边界

- 只支持 `https://www.bilibili.com/video/BV...` 标准视频页。
- 只验证当前分P，不合并整套视频。
- 只读取视频已经存在的人工或 AI 字幕，不下载视频、不做 OCR 或音频转录。
- 不申请 `cookies` 权限，不读取、导出、保存或打印 B 站 Cookie。
- 不调用 DeepSeek、Supadata 或其他第三方服务，不写入浏览器存储。
- 字幕地址可能包含临时签名；验证器只保留解析后的字幕正文，不返回或缓存字幕地址。

## 2026-08-18 只读验证记录

- 匿名 Node 请求样例 `BV1e3411j7ZM` 时，验证器准确返回 `LOGIN_REQUIRED`。
- 当前 Chrome 登录态下，同一视频的 `/x/player/wbi/v2` 返回 `code=0`、`need_login_subtitle=false`。
- 接口返回 2 条可用轨道：人工 `zh-CN` 和 AI `ai-zh`，两条轨道均包含字幕地址。
- 播放器实际加载的旧版字幕地址来自 `aisubtitle.hdslb.com`，响应为标准 JSON `body[]`，样例正文可转换为 `{ text, start, duration, language }`。
- 接口同时返回 `subtitle_url_v2`，当前主机为 `subtitle.bilibili.com`；其正文格式尚未在扩展上下文实测，因此验证器使用已验证的 `subtitle_url`，仅把 `subtitle_url_v2` 作为回退。
- 验证过程没有读取或保存 Cookie 值，也没有记录含临时签名的字幕 URL。
- PoC 随后以“加载已解压的扩展程序”在真实 Chrome 中完成弹窗验证：视频 `BV1zfg36ZEXi` 的 P1 成功读取 1 条 AI 中文字幕轨并归一化为 167 个有效片段，内容键为 `bilibili:BV1zfg36ZEXi:40830435549`；弹窗正确显示前 8 条带时间戳样本。

以上证明字幕数据链路和 PoC 弹窗的最终跨域行为当前均可用。该结果只覆盖标准 BV 视频、当前分P和已有独立字幕轨，不代表无字幕、硬字幕、番剧或直播已经支持。

## 手动验证

1. 在 Chrome 登录 B 站，并打开一个带“字幕”按钮的标准 BV 视频。
2. 打开 `chrome://extensions`，启用开发者模式。
3. 点击“加载已解压的扩展程序”，选择本目录：
   `/Users/wangchao/Documents/youtube-digest-bilibili-subtitle-poc/poc/bilibili-subtitle-verifier`
4. 回到视频页，点击工具栏中的 `Bilibili Subtitle Verifier`。
5. 检查弹窗是否显示当前分P、字幕轨、内容键、有效片段数和前 8 条样本。

建议依次验证：人工中文字幕、AI 中文字幕、多分P的 P2、没有字幕的视频。

## 通过标准

- 人工或 AI 字幕能转换为 `{ text, start, duration, language }`。
- 多分P使用当前 P 的 `cid`，内容键为 `bilibili:BVID:CID`。
- 字幕 URL 仅允许 Bilibili（当前实测为 `subtitle.bilibili.com`）、hdslb 或 bilivideo 域名，并且不会出现在验证结果中。
- 未登录和无字幕能显示不同错误；不自动回退到下载视频或 ASR。

## GitHub 参考

实现从零编写，数据链路参考了以下公开项目：

- [Bili Clipper](https://github.com/echore/bili-clipper/blob/master/extension/content.js)（MIT）
- [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved/blob/master/registry/lib/components/video/subtitle/download/utils.ts)
- [ChatGPTBox Bilibili adapter](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/master/src/content-script/site-adapters/bilibili/index.mjs)（MIT）
- [BiliNote browser subtitle adapter](https://github.com/JefferyHcool/BiliNote/blob/master/BillNote_extension/src/logic/bilibili-subtitle.ts)（MIT）
- [yt-dlp Bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)

这些接口属于 B 站网页内部实现，未来可能变化；该 PoC 的通过只证明当前验证样本有效。
