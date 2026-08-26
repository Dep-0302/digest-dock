# YouTube Subtitle Verifier

这是一个与正式扩展隔离的、可手动加载的 Manifest V3 验证器。它回答一个窄问题：普通 Chrome 扩展上下文能否在没有第三方字幕 API Key、登录 Cookie、代理或伪造 `User-Agent/Origin` 的情况下，通过非 WEB InnerTube client 取得非空字幕正文。

## 组合了哪些实践优点

- [`youtube-caption-extractor`](https://github.com/devhims/youtube-caption-extractor)：IOS、ANDROID_VR、MWEB client profile 与 JSON3 正文路径。
- [`youtube-transcript`](https://github.com/Kakulukian/youtube-transcript)：ANDROID player 请求上下文；没有复制其 srv3 时间单位错误。
- [`youtube-transcript-plus`](https://github.com/ericmmartin/youtube-transcript-plus)：严格语言语义，缺失语言/轨道类型时不静默回退。
- Bilibili PoC：真实 Chrome 手动加载、轨道与传输解耦、可信 URL、凭据隔离、临时签名 URL 不外泄、统一 contract 和脱敏诊断。

本目录从零实现最小 adapter，不运行或逐行复制上述第三方包。只有实际取得非空、可解析的 JSON3、srv3 或 classic XML 正文才算成功；“发现 `captionTracks`”不算成功。

## 安全边界

- 仅支持标准 `https://www.youtube.com/watch?v=...` 页面。
- 只请求 `youtubei.googleapis.com/youtubei/v1/player` 和 `www.youtube.com/api/timedtext`。
- 所有请求均为 `credentials: omit`；不声明或调用 Cookies/Storage API。
- 不设置浏览器禁止伪造的 `User-Agent` 或 `Origin`。
- 每次请求 15 秒超时、8 MiB 上限。
- 字幕 URL、查询串、签名和 Token 仅在函数局部使用，不进入弹窗诊断、缓存或存储。
- 弹窗只在内存中显示前 5 段；复制的 JSON 不包含任何字幕正文。

## 手动加载

1. 打开 `chrome://extensions/` 并启用开发者模式。
2. 点击“加载已解压的扩展程序”。
3. 选择本目录：

   ```text
   /Users/wangchao/Documents/youtube-digest-transcript-source-comparison-v2/experiments/transcript-sources/youtube-verifier
   ```

4. 打开一个标准 YouTube watch 页面。
5. 点击工具栏中的 `YouTube Subtitle Verifier`。弹窗会自动运行，也可以调整语言和轨道策略后重试。
6. 点击“复制”，把脱敏诊断结果带回本任务。

## 第一轮三例 smoke

| 目的 | Video ID | 参数 | 预期 |
| --- | --- | --- | --- |
| 短人工英文 | `jNQXAC9IVRw` | `en` + 只要人工 | 非空正文 |
| 72 分钟 ASR | `KLDVxx4TqcE` | `en` + 只要自动 | 非空正文 |
| 有人声但无字幕 | `4OEG33NfEK0` | `en` + 人工优先 | `NO_TRANSCRIPT` |

只有前两例都能取得正文、负样本能干净判无字幕，才进入第二轮完整 corpus。第一轮失败时应先区分扩展加载、host permission、player 请求和 timedtext 正文失败，不能把任何单次失败笼统写成“YouTube 不可行”。

## 第二轮（第一轮通过后）

复用相邻 `corpus/corpus.json` 的 7 个样本，各跑两轮，额外检查：

- 人工与 ASR 同语言并存时严格选轨；
- 繁中、日语且目标语言不是首轨；
- 长视频时间单位与片段数量；
- 两个无字幕负样本；
- SPA 切换后不接受旧 videoId/旧字幕。

本验证器不修改正式扩展，也不代表已经可以删除 Supadata。通过后再讨论生产 adapter、回退顺序和合并方式。

## Node 基线（不能替代真实 MV3）

同一个 adapter 可以先在 Node 中跑三例，确认 client 轮换、严格选轨、解析和脱敏诊断没有基础错误：

```bash
node run-node-baseline.js
```

结果写入 `results/node-baseline.json`，不包含字幕正文、URL 或 Token。Node 成功只证明 adapter 请求逻辑可用；普通 Chrome popup 仍是决定纯扩展可行性的验收面。
