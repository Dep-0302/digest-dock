# YouTube 字幕来源真实对比结论

> 历史基线：本文件记录 2026-08-18 的真实对比，不代表 2026-08-23 新增的
> `youtube-passive`、严格 provider 契约、本地 HTTP 助手或手动探针已经通过
> 真实视频验收。当前执行状态以仓库根目录
> `TRANSCRIPT-SEVEN-PROVIDER-EXECUTION.md` 为准。

测试日期：2026-08-18。测试均未使用第三方 API Key、登录 Cookie、代理或用户 Chrome profile。

## 结论先行

当前不建议直接删除 Supadata 并把“页面 `captionTracks` + timedtext”或“文字稿面板”设为唯一主链。

- 页面直取在 3 个有字幕判别样本上实际取回正文为 **0/3**。即使捕获到 YouTube 播放器真实加入的 `pot/potc/c=WEB/client/signature`，仍是 `HTTP 200 / 0B`。
- 文字稿面板在 3 个有字幕判别样本上实际成功 **1/3**；另两例稳定返回 `get_transcript 400 FAILED_PRECONDITION`，并且 SPA 切换存在约 0.9 秒旧字幕窗口。
- 非浏览器客户端路径明显更可靠：三个小型 Node 库都在 3 个正样本上取回正文；`youtube-transcript-api` 与 `yt-dlp` 在 24 次运行中均为 12/12 符合预期。

因此，现有证据支持两个不同产品选择：

1. **仍要求只安装一个 Chrome 扩展**：暂时保留 Supadata；纯扩展替代尚未达到可发布证据门槛。
2. **可以接受本机伴随服务，以换取无第三方字幕 Key**：优先做 `youtube-transcript-api` localhost PoC；若项目明确选择 Node 伴随进程，再考虑 `youtube-transcript-plus`。

## 实际运行范围

7 个公开视频组成总语料库，覆盖人工英文、人工/自动英文并存、繁体中文、日语、多语言、72 分钟 ASR、有人声无字幕和无对白负对照。各方案使用判别子集，并非完整 7×全部候选矩阵：

| 组别 | 实际范围 | 说明 |
| --- | --- | --- |
| Browser direct | 5 个 corpus 视频 | 3 个有轨、2 个 0 轨 |
| Browser panel | 4 个 corpus 视频，核心结果复跑 | 3 个有轨、1 个 0 轨，另做真实 SPA |
| Node libraries | 4 个核心视频 + 2 个语言策略视频 | 4 个库 |
| Python / CLI | 6 场景 × 2 工具 × 2 轮 | 共 24 次 |
| MV3 service worker | 0 次网络请求 | Chrome/CDP 启动在宿主规则处被阻塞，结论为未验证 |
| Supadata | 未实时调用 | 避免读取存储 Key 和消耗额度；仅做当前架构基线 |

日语视频已验证字幕轨，但没有进入提取矩阵。因此这里不能声称已证明与 Supadata 的全语种覆盖率等价。

## 各路线的真实差别

### 1. 页面直取：能发现轨，不等于能拿到字幕

`movie_player.getPlayerResponse()` 在三个正样本上都能发现 `captionTracks`，但 raw `baseUrl` 的 default/json3/srv3 请求全部为 200 空正文。两个样本还能观察到播放器自己的 WEB timedtext 请求携带完整 PO Token 和客户端参数，但原生响应与 exact refetch 仍为空。

本轮只能证明 `pot/c` **不充分**；它是否为必要条件并未被隔离验证。把“捕获 pot/c”直接写成主方案会高估可靠性。该路径适合廉价轨道发现和诊断，不适合作为当前唯一正文来源。

### 2. 文字稿面板：有独立价值，但覆盖和页面副作用明显

短人工字幕视频读取到 3 段，首尾均进入可访问树；但测试没有找到可滚动容器，因此不能仅凭本轮证明面板内容完整或不存在虚拟化。65 轨视频和长 ASR 视频都能打开面板，却没有任何段落，后台 `get_transcript` 为 400。成功案例使用新的 `transcript-segment-view-model`，且面板不一定有稳定 `target-id`。

面板还会展开描述、改变页面滚动并留下可见 engagement panel。真实 SPA 测试中，播放器已经切到新 videoId 后，旧字幕仍短暂保留约 0.9 秒。实现必须等待页面元数据稳定、绑定当前 videoId，并拒绝旧 segment hash。

因此它只适合作为有严格超时和防陈旧校验的第二 fallback。

### 3. 小型 Node 库：请求上下文确实能改变结果

同一个 72 分钟 ASR 视频在浏览器 WEB 路径失败，但以下三个 Node 库都取得 1,828 段，强烈表明客户端类型或请求上下文会实质影响可用性；本轮没有隔离出唯一因果变量。

| 候选 | 核心正样本 | 中位耗时 | 主要优点 | 实际问题 |
| --- | ---: | ---: | --- | --- |
| `youtube-transcript-plus` | 3/3 | 1.125 秒 | 严格缺失语言、时间单位正确、错误/API 完整 | 每次 3 请求；Node >=20；不是现成 MV3 bundle |
| `youtube-caption-extractor` | 3/3 | 0.584 秒 | 2 请求、169 KiB 依赖闭包 | 缺失 `fr` 时静默返回英文，结果不暴露实际语言 |
| `youtube-transcript` | 3/3 | 0.663 秒 | 最小；正样本中位最快 | srv3 返回毫秒，classic 返回秒；同一字段单位不稳定 |
| `youtubei.js` | 0/3 | 0.920 秒 | 功能面广、带 browser bundle | 正样本 `get_transcript` 全部 400；18.86 MiB 依赖闭包；浏览器仍需代理 |

三种成功库的正文在 HTML entity decode、NFKC 和空白折叠后，三个正样本的字符数和 SHA-256 完全一致。差异主要来自输出格式，而不是正文内容。

### 4. Python / CLI：覆盖相同，字幕专用库更轻

`youtube-transcript-api` 与 `yt-dlp` 在 6 场景、2 轮中各 12/12 符合预期。四个有字幕场景的段数、字符数和规范化 SHA-256 跨工具完全一致；两个 0 轨场景都正确判定为 `no_transcript`。

- `youtube-transcript-api` 总体中位 1.199 秒，主包约 2.31 MB，返回结构化 `text/start/duration`，能按 `language_code + is_generated` 明确选轨。
- `yt-dlp` 总体中位 2.199 秒，主包约 20.85 MB；每次需要子进程和临时 JSON3。12/12 均警告缺 JS runtime，8/8 正样本还警告缺 impersonation target。

只为字幕新增本地后端时，`yt-dlp` 的额外能力没有在本轮带来覆盖优势，维护成本却明显更大。

## 推荐排序

### 当前发布默认

1. **Supadata 暂时保留。** 它仍是当前“单扩展安装”形态中唯一已经集成的主链；本轮没有消耗额度做覆盖率对照，所以这里只是“不建议删除”，不是为其成功率背书。
2. **Browser panel 仅作可选 fallback。** 必须有 10–15 秒上限、当前 videoId 校验、SPA 稳定等待、旧 segment hash 拒绝和 UI 恢复策略。
3. **`getPlayerResponse()` 仅作轨道发现/语言清单。** 必须拿到非空、可解析正文后才算成功。

### 如果目标改为“个人本机无字幕 API Key”

1. **首选让 `youtube-transcript-api` 进入 localhost PoC。** 本轮验证的是库进程，不是完整 helper：12/12、输出与 yt-dlp 完全一致、速度和包体更好、人工/自动轨选择明确。
2. **Node 备选为 `youtube-transcript-plus`。** 当产品已经决定维护 Node 20 本机桥时，它的严格语言语义和正确时间单位优于另外两个小库；但本轮样本少于 Python/CLI 组。
3. **不建议仅为字幕采用 yt-dlp。** 除非未来还要下载音视频或项目已经有完整 yt-dlp、受支持 JS runtime 与 impersonation 基础设施。

上述包体都不包含 Python/Node runtime、HTTP 或 Native Messaging 桥、开机启动和安装器。最小 PoC 只需证明一条 `扩展 -> 127.0.0.1 -> youtube-transcript-api -> 现有 internal contract` 请求，同时验证仅监听 loopback、固定 extension origin 或短期 secret、请求超时和响应大小限制；不应把库成功写成完整 helper 已验证。

### 当前排除

- `youtubei.js`：真实正样本全部 400，体积和能力面过大。
- `youtube-transcript`：时间单位分支不一致，未经修补不能安全接入。
- `youtube-caption-extractor` 原样接入：静默语言回退会把英文误当请求语言或“原文”。若采用其请求思路，必须改为严格选轨并返回实际语言/轨道类型。
- 远端自托管抓取：本轮未做远端部署实测；从架构上推断，它仍是一个需要认证、限流和运维的 API，并可能额外面对云 IP 风控。

## 下一关键门槛

真正的 MV3 service worker + 非 WEB InnerTube client 尚未跑通测试环境：最小扩展已经准备好，但系统 Chrome 自动侧载在 CDP 前被宿主启动规则阻塞，实际为 0 service worker、0 请求。这不能写成 MV3 失败，也不能作为纯扩展可用证据。

如果仍希望追求“单扩展、无 Supadata”，下一步是普通 Chrome 中的手动 MV3 smoke，但当前最小 probe 还需要先补可执行的手动触发与结果读回说明。先验证 2 个正样本和 1 个负样本，再扩大 corpus、补 SPA 与现有内部 contract 集成验证。单次失败只有在确认属于实际 transport/YouTube 失败、而不是加载或触发问题后，才足以停止纯扩展路线。

## 证据入口

- [真实 corpus](./corpus/README.md)
- [Browser direct 结论](./browser-direct/RESULTS.md)
- [Browser panel 结论](./browser-panel/findings.md)
- [Node 库报告](./node-libraries/results/report.md)
- [Node 语言策略报告](./node-libraries/results/language-policy.md)
- [Python / CLI 报告](./cli-tools/RESULTS.md)
- [MV3 未验证记录](./mv3-probe/results/latest.md)
- [当前 Supadata 结构基线](./current-supadata-baseline.md)
