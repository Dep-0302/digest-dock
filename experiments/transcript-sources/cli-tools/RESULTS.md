# yt-dlp 与 youtube-transcript-api 实测结论

测试时间：2026-08-18（America/Los_Angeles）
环境：macOS arm64、Python 3.12.13、`yt-dlp 2026.7.4`、`youtube-transcript-api 1.2.4`
约束：无 API Key、无 cookies、无代理、无凭据、直连 YouTube；每个场景 2 轮。

## 结果先行

两者在本轮功能覆盖上打平：各 12/12 次符合预期。4 个有字幕场景（人工英文、同语言自动英文、72 分钟自动英文、繁体中文人工字幕）都实际取回正文；2 个无字幕场景都稳定返回 `no_transcript`。

更重要的是，4 个有字幕场景在两个工具之间的规范化 SHA-256、片段数和字符数全部完全一致。这说明本轮它们拿到的是同一份 YouTube 字幕数据，而不是一个工具只拿到轨道列表或截断文本。此前在浏览器面板和裸 `timedtext` 上失败的 72 分钟样本，两者本轮都成功取回 1,828 段、63,109 字符；“页面路径失败”不能直接推导为这两个提取器失败。

| 场景 | yt-dlp 中位时延 | youtube-transcript-api 中位时延 | 结果 |
| --- | ---: | ---: | --- |
| 65 轨中的人工英文 | 3.291 秒 | 1.349 秒 | 两者成功，摘要一致 |
| 同视频同语言的自动英文 | 4.584 秒 | 1.180 秒 | 两者成功，摘要一致 |
| 72 分钟 ASR-only 英文 | 2.905 秒 | 1.280 秒 | 两者成功，摘要一致 |
| 繁体中文人工字幕 | 1.728 秒 | 1.142 秒 | 两者成功，摘要一致 |
| 有演讲但 0 字幕轨 | 2.381 秒 | 1.337 秒 | 两者正确判无字幕 |
| 无对白且 0 字幕轨 | 1.494 秒 | 1.044 秒 | 两者正确判无字幕 |

全部 12 次请求的总体中位数是：`yt-dlp 2.199 秒`，`youtube-transcript-api 1.199 秒`；本轮后者约快 1.8 倍。样本只有两轮，这个倍率只能代表本机本时段，不能外推成 SLA。

## 真实实践差别

### 1. 轨道选择

两者都能准确区分人工与自动字幕，但必须显式写策略。只传 `en` 不够，因为 `iG9CE55wbtY` 同时存在人工 `en` 和 ASR `en`。

- `youtube-transcript-api` 先 `list()`，再按 `language_code` 和 `is_generated` 过滤，意图清楚，也能把完整轨道列表交给上层。
- `yt-dlp` 通过 `--write-subs` / `--write-auto-subs` 与 `--sub-langs` 选择。可以做到同样准确，但策略散落在命令行参数和输出文件命名中。

### 2. 输出规范化

`youtube-transcript-api` 更省事：返回结构化 `FetchedTranscriptSnippet(text, start, duration)`，直接一层映射即可。

`yt-dlp` 需要启动子进程、建立临时目录、寻找语言后缀不固定的 `.json3` 文件，再合并 `events[].segs[].utf8` 并处理空事件。规范化后的结果并不差，本轮与另一工具逐字一致；差别在适配代码和故障面更多。

无字幕时也有实践差异：`youtube-transcript-api` 抛出可分类的 `TranscriptsDisabled`；`yt-dlp` 退出码仍为 0、但不生成字幕文件，因此适配器必须把“成功退出且无文件”映射为正常负结果，不能误报成功。

### 3. 时延与进程成本

- 本轮 `youtube-transcript-api` 在同一 Python 进程内执行，不启动子进程、不落地字幕文件；每次 0 个子进程。
- 本轮 `yt-dlp` 每次启动 1 个 CLI 进程并写临时 JSON3；12 次请求累计 12 个子进程。
- 两者都可以通过注入 `requests.Session` 或 `subprocess` timeout 做 45 秒边界。`youtube-transcript-api` 没有直接的每次调用 timeout 参数，本实验用带默认 timeout 的 Session 补上。

对浏览器扩展而言，这两者都不能直接跑在 MV3 Service Worker 中；生产接入仍要 Python 本地伴随服务、Native Messaging 或远端后端。也就是说，“不要第三方 API Key”成立，“纯扩展、零伴随进程”不成立。

### 4. 安装与维护成本

本机全局原本两者都未安装。隔离环境中的未压缩包体观察值：

- `yt-dlp` 主包约 20.85 MB。
- `youtube-transcript-api` 主包约 2.31 MB；加 `requests` 及其本轮安装的直接运行依赖约 5.70 MB。

当前 `yt-dlp 2026.7.4` 要求 Python `>=3.10`。系统 Python 3.9.6 做同样的不锁版本安装时，只能解析到 `yt-dlp 2025.10.14`；`youtube-transcript-api 1.2.4` 的范围是 Python `>=3.8,<3.15`。因此只为字幕部署时，后者的 Python 兼容面和安装体量更轻。

`yt-dlp` 的额外维护风险在本轮已经可见：12/12 次均警告缺少受支持的 JavaScript runtime，8/8 次字幕正样本还警告缺少 impersonation target。字幕仍然全部成功，但 yt-dlp 明确把“无 JS runtime 的 YouTube 提取”标为弃用路径；未来为保持可用性可能还要引入 Deno/Node 等 runtime 和 impersonation 依赖，实际部署成本会继续增长。12/12 次也有 `ffmpeg not found`，但本实验只取字幕且使用 `--skip-download`，ffmpeg 对这条路径不是必需项，不应仅为消除该警告而安装。

## 建议

如果只能在这两个方案里选，并且接受增加一个 Python 本地服务，我建议以 `youtube-transcript-api` 做字幕主路径：本轮覆盖率与 `yt-dlp` 相同，正文完全一致，同时更快、更小、结构化输出更直接、无字幕错误更容易分类。

`yt-dlp` 更适合保留为“已经有 yt-dlp 基础设施”或“未来确实还要下载音频/视频、做更广泛 YouTube 提取”的方案。仅为了字幕给 YouTube Digest 新增它，当前收益不足以覆盖子进程、临时文件、Python 版本、JS runtime 和 impersonation 的维护面。

对当前纯浏览器扩展的最终建议仍是：不要把任何一个直接当作 Supadata 的无服务替换。优先比较扩展内原生提取路线；若原生路线的真实覆盖率不足，再把 `youtube-transcript-api` 作为可选本地伴随服务验证。此结论只基于当前签出状态、单一住宅网络和 6 个真实场景；尚未覆盖 IP 封锁、请求频率限制、登录/年龄限制、地区限制与未来 YouTube 改版。
