# YouTube 字幕候选链 Phase 4 集成验收记录

状态：原 Active/Panel 集成门已被用户批准的减法决策撤销；简化链已实施，待重新加载后可见验收

验收时间：2026-08-27 04:50 PDT

## 构建身份

- 工作树：`/Users/wangchao/Documents/youtube-digest-transcript-source-comparison-v2`
- 分支：`codex/transcript-source-comparison-v2`
- HEAD：`f14d59970038ac3bb1c9877746796a3dc477f139`
- Manifest：`1.4.4`
- unpacked extension ID：`bmckpnondaeffpengbpfmlfajcjiaikg`
- 工作树仍为未提交实验状态；本轮未暂存、提交、推送、合并或发布。

## 后续可见复验与产品减法决策

- 扩展重新加载并刷新 YouTube 页面后，侧栏在两个视频之间同步成功，旧视频标题和字幕没有残留。
- `4OEG33NfEK0` 在页面确认零字幕轨时显示“当前视频没有可用字幕”；打开 DigestDock 后没有新增 player、timedtext 或 transcript-panel 请求，也没有显示 Supadata。
- 已缓存视频重新打开时直接恢复字幕；DigestDock 动作后新增 player、timedtext 和 transcript-panel 请求均为 0。
- 同一长 ASR 视频 `KLDVxx4TqcE` 在未缓存且 CC 关闭时未取得字幕；打开 CC 后 Passive 取得完整 `en` 字幕；随后再次关闭 CC，正向缓存继续零请求命中。
- 用户据此批准将产品链收敛为“缓存/Passive → 提示打开 CC → 显式免费重试 → 可选 Supadata”。Active 与 Panel 保留实验实现和证据，但不再作为产品自动路线；原 Phase 4 对 Active/Panel 集成的退出条件由该决策撤销，不得继续据此扩大请求测试。

## 简化链实施回执

- 产品 background 在 Passive miss 后不再调用 Active 或 Panel；首次只返回 CC 提示，只有严格布尔 `captionRetry=true` 的用户重试仍 miss 时才允许显示现有 Supadata 后备。
- `CONFIRMED_UNAVAILABLE`、登录／访问限制与 `PAGE_CONTEXT_CHANGED` 继续在 CC 提示和 Supadata 之前终止。
- 侧栏主按钮文案为“已打开字幕，重新读取”；首次提示不显示 Supadata，从保存笔记进入时仍保留“返回笔记”。
- Active 与 Panel 源码及独立测试保留为实验证据，但已从候选 release allowlist 移除；候选 ZIP 包含 41 个批准文件，不含两个产品模块。
- 离线结果：根扩展 `561/561`、七路线实验 `74/74`、Node 比较器 `10/10`、Active 独立验证器 `12/12`、local-helper `11/11`；registry、release check、语法和 `git diff --check` 均通过。
- 未发布候选 ZIP：`dist/digest-dock-v1.4.4.zip`；SHA-256 `ee039855f500fa4e911f025716754872170bc62ca926c641e246b3caddd0f73d`。该文件未提交、未推送、未发布。
- 新简化链仍需重新加载 unpacked 扩展并做一次可见验收；离线通过不等于真实 Chrome 已通过。

## 原验收冻结边界（历史）

- 当时只测试当前实验分支的 cache/Passive → Active → Panel → final `UNKNOWN` 产品候选链；该链现已被上方后续决策取代。
- 不点击、不配置、不调用 Supadata；不调用 hosted API 或 AI 生成字幕。
- 只记录 video/run identity、endpoint class、状态码、请求数与页面结果；不保存字幕正文、签名 URL、Key、Cookie 或请求头。
- 当时的停止规则是观察到首个 YouTube 429 即停止后续 Active/Panel 测试；现在不再继续这些产品集成测试。

## 已观察结果

| 样本 | 前置状态 | 可见结果 | 请求证据 | 分类 |
| --- | --- | --- | --- | --- |
| `dQw4w9WgXcQ` | CC 开启；URL/player identity 一致 | DDK 打开后没有操作 YouTube Transcript panel | 刷新阶段观察到 1 个 `timedtext` 200；随后点击 DDK 新增 player/timedtext/panel/Supadata 请求均为 0 | PASS：Passive/正向结果零放大 |
| `3lPnN8omdPA` | 用户确认先前未开启 CC；后开启 CC | DigestDock 侧栏显示当前视频的时间戳字幕行 | 跨回合后 CDP 缓冲不可追溯，endpoint class 数量未验证 | PASS：可见字幕结果；请求数未验证 |
| `m8WomdCLBqE` | 准备阶段 CC 明确关闭；URL/player identity 一致 | 侧栏显示“免费字幕未能取得”，只提供 Supadata 配置入口 | 用户点击发生在浏览器控制回合之外，请求数未验证 | FAIL/UNKNOWN：未证明 Active 或 Panel 成功 |
| `UQSG41UD7jM` | CC 明确关闭；URL/player identity 一致；页面字幕按钮显示“无法显示字幕” | 侧栏显示“免费字幕未能取得”，只提供 Supadata 配置入口 | 用户可见 UI 与自动监听发生时序错位，请求数未验证 | FAIL：未闭合 `CONFIRMED_UNAVAILABLE` 边界，落为 final `UNKNOWN` |

## 通过项

- 加载路径对应的候选扩展已注入页面，扩展 ID、videoId 与 player identity 可复核。
- 页面已有字幕响应时，Passive/正向路径在 DDK 动作后没有增加字幕请求。
- 侧栏成功显示过与当前视频绑定的时间戳字幕。
- 两个最终 `UNKNOWN` 页面只显示 Supadata 可选入口；用户未点击，未观察到自动第三方调用。
- 同步观察窗口内没有 YouTube 429。

## 未通过或未验证项

- Active 短人工、长 ASR 的产品集成成功与准确 1 player + 1 timedtext 计数未验证。
- no-caption 产品结果没有稳定收敛为 `CONFIRMED_UNAVAILABLE`；当前真实样本显示 final `UNKNOWN`。
- Panel 自动打开、页面诱发请求、连续覆盖、语言绑定和完整恢复未验证。
- 用户手动点击发生在浏览器控制回合之外时，CDP 事件缓冲无法跨回合保留；这些运行不得补写请求数或升级为通过。

## 停止原因与下一步

用户明确指出可见 Chrome UI 与自动化监听不同步。为避免重复点击放大请求，本轮停止继续换视频或重跑 Active/Panel。

下一步应先选择一种同一可见时序的取证方式，再只复测一个已知有字幕且未缓存的样本；在此之前，Phase 4 保持“部分通过，未达到退出条件”，不得晋级 Phase 5 或正式 `main`。

## 失败后最小修复

修复时间：2026-08-27 05:04 PDT

- MAIN-world 页面快照现在只增加 text-free allowlist：已知轨道数和可证明的默认轨道 `{language, kind}`；不返回轨道数组、名称、`baseUrl`、签名参数、Cookie、headers 或字幕正文。
- 只有实时 player response、精确 videoId、`playability=OK`、明确 `isLiveContent=false`、导航 epoch 复核仍一致且轨道数已知为 0 时，才返回 `NO_TRANSCRIPT / CONFIRMED_UNAVAILABLE`；Active、Panel 和 Supadata 均为 0 次。
- 页面已知存在轨道时仍先运行 Active；只有 Active 普通 `UNKNOWN` 才把安全的数量与默认语言/类型证据交给 Panel。Active 自己的 selected track 始终优先。
- Panel 诊断会区分 `active` 与 `page-default` 证据；没有 selected track 时不再伪造 Active 证据。
- 定向状态机/API/Panel 测试 `117/117` 通过；根扩展全量 `562/562` 通过；release check 通过（43 个 allowlisted 文件）；独立复核 `PASS`。

这些结果只证明修复已离线验证。候选扩展仍需重新加载，并对一个已知有字幕样本和一个已知无字幕样本做一次新的可见复验；Phase 4 状态仍为“部分通过”。
