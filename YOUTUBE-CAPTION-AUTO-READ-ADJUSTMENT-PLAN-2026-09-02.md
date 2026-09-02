# DigestDock YouTube 字幕自动读取调整计划

日期：2026-09-02

状态：Rev.2，Opus 5 Max 已 PASS；授权执行阶段 1–4

实施基线：`8c6c664ce7b59c548fa44cccca4d960fa90bd2cf`

实施分支：`codex/sidepanel-mvp-interaction`

## 1. 目标

恢复并扩展用户已经认可的“打开 DigestDock 即可阅读字幕”体验：

1. 不要求用户逐视频点击 YouTube CC 或设置字幕语言。
2. 视频存在任何中文原生轨时，中文优先；简体、繁体、粤语等中文变体同等。
3. 同为中文时，人工字幕优先于自动字幕；同类型沿用 YouTube 的轨道顺序。
4. 视频没有中文、但只提供一种可用语言时，自动读取该语言；同语言的人工轨优先于自动轨。
5. 多语言且没有中文时，不猜测用户想读哪种语言，保留现有 CC 提示。
6. 不调用 Supadata、AI Provider、音频下载、ASR 或 OCR。
7. 不增加设置开关或用户操作步骤。
8. 只有用户打开 DigestDock、启动当前视频字幕任务时才允许执行；普通浏览期间不预取。

范围确认：用户已经明确同意“无中文但只有一个可用语言组时也自动读取”，并确认不增加总开关。这是有意覆盖多数单语言字幕视频的产品范围，不再作为待确认项；真实探针和最终文档必须按该真实范围验收与披露。

## 2. 已确认事实

### 2.1 Git 与当前状态

- 最后验收并备份的提交是 `8c6c664`。
- 本地 `main` 与功能分支在计划编写前都指向该提交。
- 当前自动中文 WIP 尚未提交、合并或推送。
- `.workbuddy/` 是未跟踪外部目录，继续排除。

### 2.2 真实 Chrome 证据

| 视频 | 页面真实轨道 | CC 关闭结果 | 用户打开 CC 后 |
| --- | --- | --- | --- |
| `LEY9kenjVaA` | `en/manual`、`zh/manual`、`zh-Hant/manual` | 当前 WIP 进入 CC 提示 | Passive 成功读取 `zh` |
| `bSorYHuY0V8` | `en/manual`、`en/asr`；播放器 tracklist 对用户表现为单一 `en` | 当前 WIP 进入 CC 提示 | 尚未作为本轮连续探针重新记录 |

两个页面均为 `playability=OK`、`isLiveContent=false`。第一条视频中的中文轨是 YouTube 原生 `captionTracks`，不是第三方翻译轨。

### 2.3 直接 `baseUrl` 路线已被否定

仓库 `experiments/transcript-sources/browser-direct/RESULTS.md` 已记录：

- raw `baseUrl`；
- `fmt=json3`；
- `fmt=srv3`；
- 复制播放器观察到的 `pot`、`potc`、`c=WEB` 与签名参数；

均可能返回 `HTTP 200 / 0B`。既有记录来自无登录 headless、`credentials: omit`；当前 WIP 使用真实会话的 `credentials: same-origin`，两者环境不同，不能把旧记录的精确失败码外推到本轮。但当前 WIP 的非空正文只来自测试 Mock，真实 Chrome 又未取得正文，已经足以否定把 `captionTracks[].baseUrl` 直取作为产品路线。删除前若无法在不扩大产品日志的前提下区分 `PREFERRED_TRACK_FAILED` 与 `PREFERRED_TRACK_EMPTY`，结果记录为“真实直取 miss、精确内部码未观测”，不得伪造精确失败码。

### 2.4 旧版“自动读取”来源

`8c6c664` 的产品自动来源只有：

1. 30 天内、策略版本为 v5 的有效正缓存；
2. YouTube 页面自行发起字幕请求后，被 document-start Passive 捕获。

Active 与 Panel 在 `8c6c664` 中仍是实验代码，没有进入产品消息路径。

当前 WIP 把 `TRANSCRIPT_SOURCE_POLICY_VERSION` 从 5 升到 6，导致所有既有 YouTube v5 正缓存被忽略。这能解释“上次 Git 版本可以自动读、当前英文视频又要求 CC”的主要差异；没有证据表明 Passive 本身退化。

### 2.5 已确认缓存 Bug

当前缓存写入同时保存：

- `transcriptRequestedLanguage`：通常来自视频默认音频语言；
- `transcriptLanguage` 与 `selectedTrack.language`：实际取得的字幕语言。

但 `startDigest` 还有一层“默认音频语言必须与字幕语言同主语言”的额外判断。英文音频视频取得中文轨后，会被该判断错误丢弃，即使缓存本身的请求身份、选中轨和正文指纹都有效。

## 3. 不可跳过的产品边界

1. 正缓存命中立即结束，不发请求。
2. Passive 仍是零新增请求的第一自动来源。
3. 阶段 1 恢复旧排序；只有真实胜出路线接入时，才启用“任何中文”或“唯一语言组”的新选择策略。多语言无中文不猜。
4. 字幕正文非空且可解析才算成功；轨道存在、按钮状态、HTTP 200 都不是成功。
5. 登录、年龄、会员、地区、视频不可用、直播、明确零轨、页面身份变化必须在自动动作前停止。
6. 每次实验或产品请求必须绑定 `tabId + videoId + generation + epoch`，服从 single-flight 和迟到结果拒绝。
7. 429 立即停止并进入冷却，不切换轨道、不切换客户端、不继续 Supadata。
8. 临时字幕地址、签名、Cookie、请求头和页面对象不得跨上下文、存储或写入日志。
9. Active、播放器激活与 Panel 是三种不同路线；测试和诊断不得互相借用成功证据。
10. 真实 Chrome 没有通过前，不更新产品文案为“自动读取已可用”，不提交、不合并、不推送、不发布。

## 4. 分阶段实施

### 阶段 1：回退失败 WIP，恢复上次 Git 体验

目标：先回到可信基线，不让失败实验继续影响用户。

修改：

1. 删除 `readYoutubePreferredChineseTranscript()` 及其 direct `baseUrl` 获取分支。
2. 删除 `youtube-preferred` 产品缓存来源、相关 single-flight、超时和体积常量。
3. 选择一致性方案 A：把尚未发布的 `TRANSCRIPT_SOURCE_POLICY_VERSION` 从 6 恢复为 5，同时把 Passive 排序恢复到 `8c6c664` 的 requested/default-audio 优先顺序。中文优先与新版本只允许在真实胜出路线接入时一起启用，绝不出现“新排序 + 旧缓存版本”。
4. 删除合成非空 timedtext Mock 所形成的假绿测试及 flow harness 对 preferred 调用的启发式识别；补 `200/0B`、空 `events` 不得成功或写缓存的负向测试。直读函数删除后，该负向断言落在 Passive capture/body 归一化层，不保留一个不存在的产品 direct fetch 测试入口。
5. 完整回退 README、PRIVACY、SECURITY、DESIGN 和方向稿中“直接读取一个中文 baseUrl”的事实性错误，包括 `README.md`、`README.zh-CN.md` 的使用流程/覆盖范围/排错段落，以及 `PRIVACY.md` 被 WIP 改动的生效日期。

保留：

1. 页面只返回 `{language, kind}` 的脱敏 `availableTracks`，不返回 URL；阶段 1–2 只作为惰性证据，不改变产品控制流。
2. 中文变体识别和人工轨优先的纯选择逻辑移入阶段 3 探针共享 helper；阶段 1–2 不在产品 `background.js` 留下未使用选择器。
3. 上一轮已经通过真实验收的字幕换行、时间码、跟随、概览和笔记改动。

验收：

- WIP 期间未被 v6 覆盖写入的旧 v5 正缓存重新命中，关闭再开侧栏为零请求；已经被 v6 覆盖的条目不能声称可恢复。
- 当前 WIP 产生的 `youtube-preferred` 结果不被接受。
- Passive 成功恢复 `8c6c664` 的立即返回，不因惰性 `availableTracks` 多执行 MAIN world 快照。
- `npm test`、`npm run check`、`git diff --check` 全部通过。

阶段 1 完成自动门后，创建一个仅位于功能分支的本地 Git 检查点；不合并、不推送、不发布。阶段 2 使用独立检查点，便于分别判断“旧缓存恢复”和“缓存 Bug 修复”。

### 阶段 2：修复跨语言字幕缓存

目标：英文音频视频取得中文轨后，下次打开仍可零请求复用。

修改：

1. 同时修复 `startDigest` 的两处跨语言判断：
   - 删除用默认音频语言推断字幕轨变化的 `sourceTrackChanged`。阶段 2 不另造替代猜测；同一 `videoId + routeKey` 的重复 tab 激活、页面完成事件和计划刷新不得重置字幕、概览、跟随或 Tab 状态。真正的视频或 routeKey 变化仍必须 reset；未来只有新一代、经过 selectedTrack + artifactIdentity 验证的字幕结果才能替换当前轨。
   - 删除缓存命中后“默认音频语言必须与缓存字幕语言同主语言”的额外淘汰条件。
2. 继续依赖 `validateTranscriptCacheRecord()` 的完整门禁：
   - 当前请求语言与缓存 `transcriptRequestedLanguage` 一致；
   - 缓存 `selectedTrack.language` 与 `transcriptLanguage` 一致；
   - video/media/route/track kind/fingerprint/artifact identity 全部一致。
3. 不把“原文”重新解释成默认音频语言；它仍表示实际取得的字幕轨语言。
4. 处理 `transcriptRequestedLanguage` 的启动期不稳定，但不放宽非空冲突：旧缓存请求语言为空、后来页面补出 `en` 时，仅在 exact video/route、selectedTrack 与 transcriptLanguage 一致、fingerprint 与 artifact identity 均有效时兼容；两个非空请求语言不同仍拒绝。
5. 增加纯本地、无遥测的缓存拒绝原因测试接口或表驱动断言，分别覆盖 policy、route、requestedLanguage、selectedTrack、transcriptLanguage、fingerprint 与 artifactIdentity；不得把调试内容写入持久状态或生产日志。

测试：

- 请求语言 `en`、实际轨 `zh`、缓存轨 `zh`：命中。
- 当前请求语言变化、选中轨与正文语言不一致、指纹变化：仍拒绝。
- 首次请求语言为空、同一页面后来补出 `en`：在其余完整门禁一致时命中；两个非空语言冲突仍拒绝。
- 同一视频连续多次 tab 切换、`status=complete` 与计划刷新不得触发 reset、清空概览或打断跟随。
- videoId 或 routeKey 真实变化仍必须 reset；不能因删除 `sourceTrackChanged` 弱化媒体身份门禁。
- B 站缓存与 YouTube 规则继续隔离。

阶段 2 完成自动门后创建第二个本地功能分支检查点；不合并、不推送、不发布。阶段 2 失败不得用阶段 1 的缓存恢复结果掩盖。

### 阶段 3：建立两条独立真实探针

阶段 3 只进入实验目录，不接产品消息路径。

已知 Passive 限制：`youtube-passive-main.js` 当前用 `tlang || lang` 生成单一 `language`，无法区分原生中文轨与 YouTube 机器翻译中文。因为阶段 1 已回退中文优先排序，阶段 1–3 不会把该缺口放大为“中文优先”。任何胜出路线进入阶段 5 前，必须先让 MAIN world 只增加脱敏的 `translated` 布尔标记和原始 `sourceLanguage`，且不外传 URL；bridge/background 身份必须保留该标记，机器翻译 capture 不得作为“原生中文优先”证据，也不得以原生中文身份写缓存。相关实现、UI 语义和迁移须再次经过阶段 4 后的计划复核。

#### 探针 A：播放器激活 → Passive 捕获 → 恢复

候选流程：

1. 用实时 playerResponse 读取脱敏轨道列表。
2. 选择目标：任何中文优先；无中文时，按主语言去重后只有一个语言组才选择；人工优先自动。
3. 记录原始状态：captions module、当前轨、CC `aria-pressed`。
4. 仅一次调用播放器 captions 模块激活目标轨，不模拟设置菜单点击。
5. 使用探针自己的最多 3 秒等待，不修改产品 `YOUTUBE_PASSIVE_WAIT_MS=1500`；只接受现有 Passive 捕获的非空正文。播放器因本地内存缓存而没有发新请求时仍按 miss 处理。
6. 在 `finally` 中恢复原轨与原 CC 状态，并再次读取状态确认；若视频身份已经变化，恢复动作必须 no-op，不能把旧视频状态写入新视频。
7. 页面切换、超时、失败、429、重复点击同样进入同一个恢复所有者。
8. 激活后、恢复前发生导航或标签页关闭时必须作为独立用例；身份变化后恢复 no-op，且不得把 CC 偏好泄漏给新视频。

产品候选门：

- `LEY9kenjVaA` 在 CC 关闭冷启动时准确取得中文人工轨。
- `bSorYHuY0V8` 把 `en/manual + en/asr` 识别为一个语言组并取得英文人工轨。
- 请求数为页面自己发出的单次 timedtext；正文大于 0。
- CC 前后状态一致，原本打开的轨也能恢复。
- 登录态与未登录态分别验证：流程结束后打开另一视频、另开窗口并刷新，CC 仍保持用户原有偏好。依据只使用可见播放器状态，不读取 Cookie、localStorage 或浏览器私有存储。
- 播放中/暂停、普通/剧场模式分别观察；播放器不存在或全屏时探针直接跳过。
- 用连续可见观察和前后截图判断闪动；如果用户能感知字幕闪现，该路线不得进入产品。不得注入样式隐藏闪动后宣称无副作用。
- 恢复二次确认只要出现一次明确“未恢复”，路线 A 立即失去产品候选资格，不做重试美化结果。

#### 探针 B：Active 隔离路线中文验证

基于仓库保留的 `youtube-transcript-active.js` 与 verifier，不复制到产品。

已知真实证据：

- `jNQXAC9IVRw`：IOS，1 次 player + 1 次 timedtext，6 段人工英文字幕。
- `KLDVxx4TqcE`：IOS，1 次 player + 1 次 timedtext，1,828 段自动英文字幕。

新增真实验证：

1. `LEY9kenjVaA` 请求任一中文人工轨，必须返回非空正文和真实中文 selectedTrack。
2. `bSorYHuY0V8` 无中文时，唯一语言组选择英文人工轨。
3. 全程不改变播放器 CC、轨道或页面 UI。
4. 凭据为 `omit`；不读 Cookie/存储；不伪造 `User-Agent`、`Origin` 或 Cookie。风险披露必须明确：请求体会声明非 WEB 的 IOS 客户端、Apple 设备与 iPhone 型号，而不是笼统写成“无头伪装”。
5. 记录真实 player/timedtext 请求数、HTTP 状态、正文尺寸和最终段数，但不保存正文、URL、签名或 Token。
6. 429、登录限制、无轨、页面变化均失败关闭。
7. 本轮探针固定一个已验证 IOS 客户端和一个 json3 字幕格式；成功与失败都最多 `1 player + 1 timedtext`，不得沿用现有模块的 4 客户端/3 格式自动扩散。
8. `LEY9kenjVaA` 只能真实证明 `zh*`；“所有中文变体同权”还需要至少一个公开 `yue` 或 `cmn` 轨样本。找不到样本时可以验证纯选择契约，但不得把技术可用性外推为所有中文变体已实测。
9. 固定 IOS 请求若返回 403，记为终止失败；不得切换第二客户端或第二格式。

产品候选门：

- 两个目标视频均通过；中文选轨不能只由 Mock 证明。
- 典型成功最多 `1 player + 1 timedtext`。
- 任一失败路径也不超过 `1 player + 1 timedtext`。
- 产品与发布审查明确接受“非 WEB 客户端上下文”的稳定性与条款风险；否则即使技术通过也不得接入。

### 阶段 4：按真实证据选择路线

选择顺序：

1. 探针 A 只有在准确选轨、正文非空、完全恢复且用户不可感知时才优先。
2. 探针 A 出现闪动、偏好污染或恢复不确定，而探针 B 中文真实通过且边界审查接受时，选择探针 B。
3. 两条都未通过时停止：恢复阶段 1–2 的旧缓存/Passive 体验，继续保留手动 CC；不得把 Panel 或 Supadata当作自动替代。

Panel 不列为优先候选：既有证据包含 `get_transcript 400`、DOM/本地化依赖、页面滚动与 engagement panel 恢复风险，且中文选轨证据不足。

阶段 4 是本轮执行硬终点。完成路线判定后必须停止，形成真实证据摘要，再交 Opus 5 Max 复核并向用户报告；本轮计划复核通过不授权自动进入阶段 5–6。只有第二次路线接入计划复核通过后，才能修改产品消息路径与发布文案。

### 阶段 5：接入胜出路线

共同要求：

1. 新路线位于 Cache/Passive 之后、首次 CC 提示之前。
2. 只在当前字幕任务内运行；没有设置开关，没有后台预取。
3. 使用 `tabId + videoId + generation + epoch` single-flight。
4. Passive 已有同等或更优字幕时不运行。
5. 成功结果记录真实来源与 selectedTrack；只缓存正结果。
6. 普通失败回到首次 CC 提示；不得直接解锁 Supadata。
7. 429、限制、不可用和页面变化继续在 CC/Supadata 前停止。
8. Active/Panel 其余实验能力不得随胜出路线一起进入产品。
9. 在重新启用中文优先前，必须完成 `tlang`/原生轨身份分离；机器翻译不能冒充原生中文。
10. 自动路线与用户 CC 重试若共用 native cooldown，429 的可见文案、`supadataEligible` 和恢复动作必须统一，不能一条显示第三方后备、一条禁止后备。

路线 A 专项：恢复逻辑必须是 `finally` 所有出边共享的单一所有者。

路线 B 专项：只保留已验证客户端和最小 1+1 成功路径；失败时不得自动扩散到多客户端请求，除非计划再次经过用户确认与真实成本/限流验收。

若路线 B 胜出，第二次复核必须明确批准：

- 产品请求体声明 IOS/Apple/iPhone 设备身份的稳定性与条款风险；
- `youtube-transcript-active.js` 或其最小子集进入 `scripts/check-release.sh` 的 `public_allowlist` 与 `required_public_files`；
- 翻转 `tests/release.test.js` 中“Active 不在发布名单”的负向断言；
- SECURITY/PRIVACY 对实际请求范围的准确说明。

若路线 A 胜出，第二次复核同样必须明确批准新增播放器激活模块进入 manifest、`scripts/check-release.sh` 的 `public_allowlist` 与 `required_public_files`，并补齐 `tests/release.test.js` 的双重发布文件断言。

### 阶段 6：文档、测试与真实验收

文档必须与最终胜出路线一致：

- `SIDEPANEL-MVP-DIRECTION-2026-08-28.md`
- `DESIGN.md`
- `README.md`
- `README.zh-CN.md`
- `PRIVACY.md`
- `SECURITY.md`

自动测试至少覆盖：

- 中文变体同权、人工优先；
- 单一语言组（人工 + ASR）选择人工；
- 多语言无中文返回 null；
- 正缓存立即结束；
- 英文请求 + 中文字幕缓存命中；
- `200/0B`、空 JSON、格式错误绝不成功；
- single-flight、重复点击、SPA、A→B→A、迟到结果；
- 429 冷却与零 Supadata；
- `tlang=zh` 的机器翻译 capture 带 `translated=true`，不得冒充原生中文优先或原生缓存；
- 选中路线的状态恢复或零 UI 副作用；
- 签名 URL、正文和凭据不进入日志、诊断或持久状态。

Mock 只允许证明选轨、门禁、请求上限、恢复调用序列和不泄露字段，不能证明字幕路线可用。可用性只接受同一连续 Chrome 时序产生、通过既有 schema validator 的真实记录；真实记录必须包含 player/timedtext 请求数、HTTP 状态、正文字节、段数、轨道语言/类型和 CC 前后状态，不保存正文或临时地址。

完整门：

1. 定向测试通过。
2. `npm test` 全通过。
3. `npm run check` 全通过。
4. release allowlist 与敏感信息扫描通过。
5. `git diff --check` 通过。
6. 使用同一 Chrome、同一扩展 ID、同一连续时序完成真实验收。
7. 自动化通过不替代用户实际交互验收。

## 5. 文件范围

计划阶段只新增本文档。实施阶段预计只修改：

- 产品：`background.js`、`sidepanel.js`；路线 A 如胜出，可新增一个职责单一的播放器激活模块。
- 实验：`experiments/transcript-sources/` 下的独立探针与证据，不复写旧证据。
- 测试：`tests/translation.test.js`、YouTube API/Passive/flow/cache/sidepanel 直接相关测试。
- 文档：方向稿、设计、README、隐私与安全说明。

不得修改：

- Supadata 调用与逐次同意契约；
- AI Provider、翻译、概览和笔记路线；
- 字幕显示分组、换行、跟随、时间码和主题；
- `.workbuddy/`；
- 旧 Active/Panel 实验原始证据。

## 6. 停止条件

以下任一发生即停止并报告，不继续接产品：

1. Opus 5 Max 对计划给出阻断项。
2. 真实探针不能稳定取得非空字幕正文。
3. 不能准确选择中文或唯一语言组。
4. 播放器状态无法确定记录或恢复。
5. 新视频继承了自动激活造成的 CC 偏好。
6. 请求数超过计划上限或发生自动多客户端扩散。
7. 429 后仍发生后续请求。
8. 页面切换后旧结果写入新视频。
9. 临时 URL、签名、Token、Cookie 或正文进入持久记录。
10. 产品路线需要新增 Supadata、AI、音频或 OCR 才能完成。
11. 阶段 4 真实证据形成后，未完成第二次 Opus 计划复核就试图进入阶段 5。

## 7. 回退

- 开始实施前的可恢复基线固定为 Git 提交 `8c6c664`。
- 阶段 1、阶段 2 各自通过后只在功能分支创建独立本地检查点；实验探针与两者分开。实验失败不反转缓存修复。
- 产品集成未通过真实验收时，只保留“v5 正缓存恢复 + `8c6c664` 旧 Passive 排序 + 跨语言缓存修复”，不保留失败自动路线。
- 阶段 1 恢复旧排序，因此阶段 1–4 的保底组合准确为“v5 正缓存恢复 + 旧 Passive 排序 + 跨语言缓存修复 + 惰性脱敏轨道证据”。中文优先只随真实胜出路线一起进入后续版本。
- 未经阶段 4 后的第二次 Opus 复核和用户后续验收，不提交产品集成、不合并、不推送或发布。

## 8. Rev.2 对首次 Opus 阻断项的处理

1. B1：选择方案 A。v6、direct 路线和中文优先 Passive 排序一起回退；阶段 1 恢复 v5 与 `8c6c664` 控制流。不存在“新排序 + 旧缓存版本”。
2. B2：阶段 1 回退中文优先排序，因此当前阻断解除；`tlang` 身份丢失记录为阶段 5 前硬门。任何中文优先重新进入产品前必须增加脱敏 `translated/sourceLanguage` 契约并阻止机器翻译冒充原生轨。
3. B3：阶段 2 同时处理 `sourceTrackChanged` 与缓存加载后的额外语言淘汰，并新增同一视频重复激活/完成/刷新不得 reset 的验收。
4. 非阻断项：补全 v6 覆盖不可恢复说明、请求语言空→非空兼容、阶段 1 文档清单、探针 A 身份变化 no-op 与可见状态验收、探针 B 单客户端/单格式和非 WEB 设备身份披露、Stage 4 第二次复核硬门。浏览器安全边界禁止检查 Cookie/localStorage，因此用登录/未登录、另一视频、另一窗口和刷新后的可见 CC 状态替代私有存储读取。
5. PASS 强制条件：Bilibili 策略数组恢复 `8c6c664` 的 `[4, TRANSCRIPT_SOURCE_POLICY_VERSION]`；WIP 的 v6 测试字面量和“v5 必须失效”断言全部回退；Passive 成功恢复立即返回；阶段 1 文档字幕段落恢复为 `8c6c664` 原文。
6. 不追溯边界：回退不会改写已保存笔记。若 WIP 曾把 `youtube-preferred` 正文固化进 `YTD_NOTE_SOURCES`，只有该视频重新打开并触发既有派生产物失效流程时才会清理；不得声称回退自动清除了历史笔记摘录。失效 v6 行仍可能暂时占用 20 条缓存预算，直到正常淘汰。

## 9. Opus 5 Max 复核问题

请独立复核以下内容：

1. 阶段顺序是否真正恢复旧体验，而不是再次用假数据覆盖失败。
2. v6→v5 回退和跨语言缓存修复是否有身份或缓存污染风险。
3. 探针 A 的状态读取、激活、Passive 等待和恢复是否完整覆盖所有出边。
4. 探针 B 是否保持既有真实证据边界，没有把英文成功外推为中文成功。
5. 胜出标准是否足够严格，能防止可见闪动、偏好污染、请求扩散和迟到写入。
6. 是否存在更小、更可靠且已有证据支持的路径。
7. 文档、隐私、安全和发布门是否遗漏。
