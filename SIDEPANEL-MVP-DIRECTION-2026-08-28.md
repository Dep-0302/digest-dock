# DigestDock 侧边栏 MVP 交互方向确认稿

- 状态：**用户已确认方向；尚未开始 MVP 实现**
- 确认日期：2026-08-28
- 适用对象：DigestDock Chrome 侧边栏
- 当前实验真源：`/Users/wangchao/Documents/061-DigestDock/worktrees/transcript-source-comparison-v2`
- 确认前基线：`codex/transcript-source-comparison-v2 @ f14d59970038ac3bb1c9877746796a3dc477f139`
- 计划实施分支：`codex/sidepanel-mvp-interaction`

本文是 MVP 交互方向和验收契约，不是实施完成证明。代码修改、自动测试、真实 Chrome 验收、提交、推送与发布必须分别记录。

## 1. 产品任务与用户

DigestDock 侧边栏是“当前视频的阅读、理解与笔记工作台”。用户可能首次使用，也可能已经熟悉 YouTube/B 站、字幕、播放跟随和时间码；产品不能要求用户先读说明书才能完成核心任务。

用户进入侧栏后，应持续、自然地回答三个问题：

1. 当前正在处理哪个视频？
2. 字幕、概览或笔记现在处于什么状态，我能做什么？
3. 我刚才的点击或滚动是否已经生效？

目标不是删除一切文字，而是删除“教学型解释”，保留必要的事实、授权和恢复信息。可发现性主要由结构、控件、状态和微反馈承担。

## 2. 设计主张

> **持久外壳 + 区域状态机 + 动作即反馈 + 滚动有模式。**

- 视频身份、语言控件和 `字幕 / 概览 / 笔记` 导航持续可见；局部加载或错误不得清空整个工作台。
- 字幕、概览、笔记分别拥有显式状态；状态决定可见结构和允许动作。
- 按钮名称必须准确描述其下一步，不再使用无对象、含义漂移的“重试”。
- 每次点击在当前帧出现按下、pending 或成功反馈；长任务在所属区域就地反馈。
- 用户手动滚动后明确显示跟随已暂停，并提供带当前时间码的回位动作。
- 红色只用于真正错误；操作引导、第三方授权和终止事实使用不同结构，不使用同一错误容器。

## 3. 不可变产品边界

### 3.1 字幕取得

产品路线固定为：

```text
正缓存 / Passive
  → 页面脱敏选轨：任一中文优先；无中文时当前轨优先，否则默认轨
  → 固定 IOS + json3 Active，最多 1 player + 1 timedtext
  → 首次 UNKNOWN：提示打开 YouTube CC
  → 用户明确点击一次免费重试
  → 重试仍为 UNKNOWN：才可显示 Supadata
  → 用户逐视频、逐次明确同意后，才可实际调用 Supadata
```

- 首次 `UNKNOWN` 不得显示、暗示或调用 Supadata。
- `captionRetry` 只代表用户明确点击的一次免费重试，不能由自动刷新代替。
- `supadataConsent` 只存在于当前一次调用，不进入持久状态；保存 Key 不构成授权。同意在 `USER_CONSENT` 时铸造一次性令牌，并在请求发出的瞬间消耗。
- Provider 内部重试、重定向、429 冷却后的再次尝试、保存 Key、侧栏重开或页面/视频切换均不得复用旧令牌；必须重新显示授权卡并取得新的明确同意。
- `CONFIRMED_UNAVAILABLE`、`NO_TRANSCRIPT`、登录/访问限制、视频不可用、`PAGE_CONTEXT_CHANGED` 均在 CC/Supadata 前停止。
- Active 只允许使用已实测的固定 IOS/json3 单次路线；Panel 不进入产品消息路径。
- Active 首个 429 立即停止并进入冷却，不显示 CC 或 Supadata，不切换客户端或格式。
- 同一视频的自动刷新、人工重试和授权请求继续服从 single-flight 与迟到结果防护。

### 3.2 既有产品语义

- 保留 `原文 / 中文 / 双语` 的现有语义；有中文轨时中文变体同权、人工优先自动、同类型沿 YouTube 原顺序；无中文时读取当前轨，否则默认轨。
- 从笔记进入字幕流程时必须保留“返回笔记”。
- 字幕正文继续可选择；时间码或明确控件承担跳转。
- 不新增 Provider，不恢复 Panel 产品路线，不改变现有导出业务出口。
- 不修改 Chrome 原生侧栏标题栏结构。
- §7 的 CC、免费重试与 Supadata 链只适用于 YouTube。B 站及其他非 YouTube `routeKey` 沿用现有取得逻辑，只映射到本文的 Progress/Terminal/Error/Ready 结构，永不显示 Supadata。

## 4. 信息架构

侧栏由四层组成：

### A. 视频身份区（持久）

显示视频标题、频道、时长、当前语言模式和设置入口。视频身份解析完成后，在局部任务进行、失败或恢复时都不得消失。

### B. 主导航区（持久）

`字幕 / 概览 / 笔记` 始终可见。只有在不可见 Tab 存在后台任务、完成待查看或需要用户处理时，才显示轻量状态点；当前可见 Tab 不重复显示状态。

### C. 工作区（局部状态）

每个 Tab 独立渲染加载、空态、结果、终止和错误。字幕取得不得再切换全局 `welcome/loading/error/results`。

### D. 瞬时反馈区

只承载跨区域或需要恢复入口的反馈：回到当前字幕、删除撤销、导出完成文件名。复制和保存使用触发控件内的 `✓`，不进入全局反馈区。

## 5. 显式状态模型

### 5.1 Session

负责当前媒体身份和代际：

```text
resolving(generation) → ready(videoId, routeKey, generation)
                      → unsupported
```

- 所有异步结果绑定 `videoId + routeKey + generation + epoch`。
- videoId 变化时递增 `generation`，硬重置三个工作区并中止旧任务。
- 同一 videoId 的页面 epoch 变化时，可保留已经验证的本地结果只读展示，但清除 `retryUsed` 和 Supadata 同意；重新连接进入 `loading(retryUsed=false, consent=null)`，其 UNKNOWN 结果只能进入 `needs_cc`。
- “只读展示”表示不发起新的字幕取得、AI 或写入请求；浏览、复制与时间码跳转保持可用，保存/删除等写动作禁用，直到重新连接成功。

### 5.2 Transcript

```text
loading(retryUsed=false, taskOrigin)
  ├─ success → ready
  ├─ first UNKNOWN → needs_cc(retryUsed=false)
  ├─ terminal result → terminal(reason)
  └─ technical failure → error(kind)

needs_cc(retryUsed=false)
  └─ USER_RETRY_FREE → retrying_free(retryUsed=true, taskOrigin=USER_RETRY_FREE)
       ├─ success → ready
       ├─ UNKNOWN from the same USER_RETRY_FREE task → needs_supadata_choice
       └─ terminal/error → terminal(reason) / error(kind)

needs_supadata_choice
  ├─ USER_DECLINE → fallback_declined
  ├─ USER_CONSENT + key → fetching_supadata(consentToken)
  ├─ USER_CONSENT + no key → needs_supadata_config
  └─ USER_RETURN_TO_CAPTIONS during cooldown → needs_cc(retryUsed=false)

needs_supadata_config
  ├─ KEY_SAVED → needs_supadata_choice
  └─ USER_BACK_WITHOUT_KEY → needs_supadata_choice(unconfigured)

fetching_supadata
  ├─ success → ready
  ├─ confirmed terminal → terminal(reason)
  ├─ RATE_LIMITED → needs_supadata_choice(cooldownUntil)
  └─ technical failure → error(kind)

fallback_declined
  ├─ USER_RECONSIDER → needs_supadata_choice
  └─ USER_RESTART_FREE → needs_cc(retryUsed=false)

terminal(login_required)
  └─ USER_RESOLVED → loading(retryUsed=false, taskOrigin=USER_RESOLVED)

terminal(page_context_changed)
  └─ USER_RECONNECT_CURRENT_VIDEO → loading(retryUsed=false, consent=null)

error(kind)
  └─ a named user action → a source-limited recovery state
```

只有当结果携带 `taskOrigin=USER_RETRY_FREE`，且 `retryUsed` 由同一次用户点击置为 `true` 时，`UNKNOWN` 才能进入 `needs_supadata_choice`。`loading`、`needs_cc` 或其他状态中的自动刷新、Passive 更新和被动结果返回 `UNKNOWN`，一律停留在原状态且不得改变 `retryUsed`。

`terminal(login_required) --USER_RESOLVED--> loading` 与 `PAGE_CONTEXT_CHANGED` 后的重新绑定都属于新的首次读取，不是免费重试；其 `UNKNOWN` 只能进入 `needs_cc`。

进入 `needs_supadata_choice` 的无条件前置为：`routeKey=youtube`，当前 `generation+epoch` 内 `retryUsed=true`，且解锁结果来自同一次 `USER_RETRY_FREE` 任务返回的 `UNKNOWN`。任何不满足者一律进入或停留在 `needs_cc(retryUsed=false)`。

`error(kind, source)` 按来源限制恢复：

- `source=fetching_supadata` 才允许回到 `needs_supadata_choice`，且必须重新授权；
- `source ∈ {loading, passive, retrying_free}` 只能回到 `loading(retryUsed=false)` 或 `needs_cc(retryUsed=false)`；
- 免费重试的技术失败不构成 Supadata 解锁，`retryUsed` 回落为 `false`。

`ready` 在同一 `generation+epoch` 内是吸收态：后续迟到的 `UNKNOWN`、终止或技术失败结果全部丢弃，不能让已经显示的字幕回落到 CC 或 Supadata 状态。page epoch 变化是唯一允许在不递增 `generation` 的情况下离开 `ready` 的事件；旧 epoch 的结果全部丢弃，已验证内容按 §5.1 只读保留。

除 `ready` 吸收态外，`needs_cc`、`needs_supadata_choice`、`needs_supadata_config` 与 `fallback_declined` 收到同一身份的 Passive/自动刷新结果时遵循通用出边：被动 `success → ready`；被动终止结果 `→ terminal(reason)`；被动 `UNKNOWN` 停留原状态且不改变 `retryUsed`。

非 YouTube 路由不使用 `needs_cc` 或 `needs_supadata_choice`：成功进入 `ready`，已确认终止进入 `terminal(reason)`，普通 `UNKNOWN` 进入 `terminal(unknown_reason)`，技术失败进入 `error(kind, source)`。

允许的状态：

- `loading`
- `ready`
- `needs_cc`
- `retrying_free`
- `needs_supadata_choice`
- `needs_supadata_config`
- `fetching_supadata`
- `fallback_declined`
- `terminal(reason)`
- `error(kind)`

终止和错误使用参数化 `reason/kind`，避免状态数量爆炸。

### 5.3 Overview

```text
blocked(no_transcript) --TRANSCRIPT_READY--> idle
idle --USER_ENTER_READY_TAB / USER_GENERATE--> generating
generating → ready(cache|fresh) | error
error --USER_REGENERATE--> generating
```

- 只有 `transcript=ready` 且 `overview=idle` 时，用户首次主动点击“概览”才启动一次生成。
- 字幕未 ready 时进入概览显示 `blocked(no_transcript)`：只陈述“字幕就绪后可生成概览”，不得触发字幕、Supadata 或 AI 请求。
- `blocked(no_transcript) --TRANSCRIPT_READY--> idle`，不得自动生成。
- 只有进入概览 Tab 的那一次点击发生时 `transcript=ready && overview=idle`，该点击才视为生成意图。
- 如果用户已经停留在概览 Tab，字幕之后才变为 ready，`idle` 必须显示 `生成概览` 主动作，等待新的明确点击。
- 缓存命中不重复生成；失败后才显示“重新生成概览”。
- `error` 后再次进入 Tab 不自动重跑，只有明确点击“重新生成概览”才能再次请求。
- 切换 Tab 不取消任务；不可见时使用轻量状态点表示进行中或完成待查看。

### 5.4 Notes

视图状态与任务状态分离：

- 视图：当前视频/全部笔记、语言、滚动、展开和选择范围。
- 任务：保存、复制、播放、删除、导出，以及既有笔记翻译进度；本轮不扩展笔记翻译业务语义。
- 视频切换是唯一硬重置点；普通 Tab 切换只挂起/恢复。

### 5.5 Follow

```text
{ mode: following | paused, anchorTime, programmaticToken }
```

- `USER_SCROLL` 进入 `paused`；程序滚动不改变模式。
- `USER_RETURN_TO_PLAYBACK` 将模式置回 `following`，滚到当前字幕并更新 `anchorTime`。
- Tab 往返保存并恢复完整 Follow 状态；状态快照纳入自动测试。

### 5.6 既有 outcome 适配表

实施第 1 步必须把当前 background/message 结果收敛到以下映射；未知码默认失败关闭，不得自行猜测或解锁 Supadata：

| 既有结果 | 新状态 |
| --- | --- |
| `success=true` / `HAVE_TRANSCRIPT` | `ready` |
| YouTube 首次 `UNKNOWN` / `YOUTUBE_CAPTIONS_REQUIRED` / `requiresCaptionEnable=true` | `needs_cc(retryUsed=false)` |
| 同一次 `USER_RETRY_FREE` 返回的 `UNKNOWN` 且三重前置成立 | `needs_supadata_choice` |
| `PAGE_CONTEXT_CHANGED` | `terminal(page_context_changed)` |
| `NO_TRANSCRIPT` / `CONFIRMED_UNAVAILABLE` | `terminal(reason)` |
| `LOGIN_REQUIRED` / `VIDEO_UNAVAILABLE` | 对应 `terminal(reason)` |
| 已解锁后的 `SUPADATA_NOT_CONFIGURED` | `needs_supadata_config` |
| `fetching_supadata` 的 `RATE_LIMITED` | `needs_supadata_choice(cooldownUntil)` |
| `fetching_supadata` 的 Key/Provider/网络错误 | `error(kind, source=fetching_supadata)` |
| 非 YouTube 普通 `UNKNOWN` | `terminal(unknown_reason)` |
| 未登记结果码 | `terminal(unknown_reason)`；零 Supadata |

若当前错误码不足以完成该映射，继任任务必须先提出最小 background outcome 变更并取得单独确认，不能在 UI 中推测。

## 6. 五类状态结构

| 类型 | 语义 | 视觉方向 | 典型用途 |
| --- | --- | --- | --- |
| Progress | 系统正在工作 | 中性背景、字幕骨架、细进度 | 初次读取、免费重试、Supadata、概览生成 |
| Action | 用户需要完成一步 | 蓝青信息结构、清晰主动作 | 打开 YouTube CC |
| Consent | 用户决定是否授权 | 蓝青授权结构、范围与成本披露 | Supadata 逐次同意 |
| Terminal | 已确认事实、流程停止 | 中性灰、精确原因 | 无字幕、受限、视频不可用 |
| Error | 真正故障 | 红色、具体恢复动作 | 网络、内部异常、Provider 故障 |

不新增琥珀色语义，避免增加一层需要学习和测试的颜色系统。

## 7. 字幕取得交互

### 7.1 初次读取

- 字幕区就地显示 3–4 条字幕卡骨架；顶部和 Tab 不消失。
- cache 在短阈值内命中时直接显示结果，避免骨架闪烁。
- 成功后骨架淡入字幕列表。

### 7.2 CC 引导

使用稳定的本地 CC 图标和两步结构，不使用可能随 YouTube UI 漂移的截图：

```text
① 在 YouTube 打开 CC
② 回到这里重新读取
```

主动作：`已看到字幕，重新读取`。

点击后按钮就地进入 pending，字幕区显示重读骨架；不得切换为全屏 loading。

### 7.3 Supadata

授权卡先说明出现原因：

> 免费重新读取仍未取得字幕。可为当前视频选择 Supadata。

必须披露：

- 仅当前视频；
- 仅本次；
- 可能消耗用户额度。

动作：

- `本次使用 Supadata`
- `暂不使用`
- 未配置时：`管理 Supadata 设置`

保存 Key 后重新显示授权卡，不得自动调用。

Provider 失败时使用具体动作：

- 429：进入 `needs_supadata_choice(cooldownUntil)`；冷却期内授权主动作禁用且零请求。用户可选择 `返回字幕提示` 进入 `needs_cc(retryUsed=false)`，之后必须重新完成一次明确免费重试才可再次显示 Supadata。
- Key 无效：管理 Supadata 密钥。
- 其他 Provider 错误：再次选择 Supadata（只回到授权卡，不直接请求）。

### 7.4 终止状态权威表

| reason | 可见事实 | 允许动作 | Supadata |
| --- | --- | --- | --- |
| `NO_TRANSCRIPT` | 此视频没有字幕 | 无；笔记上下文可返回笔记 | 禁止 |
| `CONFIRMED_UNAVAILABLE` | 当前视频已确认无法取得字幕 | 无；笔记上下文可返回笔记 | 禁止 |
| `LOGIN_REQUIRED` | 需要登录或完成访问验证 | `我已完成登录，重新检查`，进入新的 `loading(retryUsed=false)` | 禁止 |
| `VIDEO_UNAVAILABLE` | 视频当前不可用 | 无；等待用户切换视频 | 禁止 |
| `PAGE_CONTEXT_CHANGED` | 页面上下文已变化 | 用户点击 `重新连接当前视频`，进入 `loading(retryUsed=false, consent=null)` | 禁止 |
| `unknown_reason` | 当前字幕流程已停止 | 无；等待用户切换视频或页面状态变化 | 禁止 |

`fallback_declined` 不是终止事实：它表示用户在免费重读失败后暂不使用第三方，可选择重新考虑 Supadata，但仍必须重新经过完整授权卡，不能直接调用。

侧栏关闭重开时，`retryUsed`、`needs_supadata_choice`、`needs_supadata_config` 与任何同意令牌全部丢弃，重新从 `loading` 开始。打开设置页本身不构成 page epoch 变化；同一侧栏会话保存 Key 返回后重新显示授权卡，且保持零自动调用。

## 8. 点击反馈契约

- `0–100ms`：出现按下态或控件内 pending。
- 任务在 `300ms` 内未完成时，在所属区域持续显示任务状态。
- 成功：原控件位置显示 `✓`，约 1.2 秒后恢复。
- 失败：信息贴近触发控件，控件恢复可操作状态。
- 只有结果发生在当前区域之外时才使用 toast。

禁止无对象的“重试”。动作必须写明对象；以下是命名规则示例，各状态的规范字面量以 §7 为准：

- `needs_cc`：`已看到字幕，重新读取`
- 重新生成概览
- 再次选择 Supadata
- 重新连接当前视频

示例：

- 复制 → `✓ 已复制`
- 保存笔记 → `✓ 已保存`，笔记计数 +1
- 点击时间码 → 立即按下反馈，目标字幕卡短脉冲
- 删除笔记 → 乐观移除，显示 5 秒撤销
- 导出 → 按钮 pending；成功时控件内显示 `✓`，实际下载文件名进入瞬时反馈区

切换视频、侧栏隐藏或关闭时，立即提交处于撤销窗内的待删除项并关闭撤销入口，避免跨视频复活或静默丢弃。

## 9. 滚动与播放跟随

跟随使用一个状态源、两种呈现：

- 字幕区显示 `跟随中 / 已暂停`；
- 用户滚动暂停后，底部出现 `回到播放位置 03:21`。

规则：

- 高亮计算与滚动分离；暂停跟随时，当前播放卡仍更新。
- 使用 `wheel / touchstart / 键盘滚动` 表达用户意图。
- 程序滚动使用 token 与 `scrollend`/rAF 回退识别，不只依赖固定 1 秒时间窗。
- 回位标签中的时间码绑定实时播放位置，按 cue 变化或至少每秒更新，不是暂停发生时的旧时间。
- 点击回位后滚到当前播放 cue、更新 `anchorTime`、短暂加强高亮，并把 Follow 模式恢复为 `following`。
- 切换 Tab 保存 `scrollTop` 和跟随状态。
- 返回字幕时：跟随中定位播放位置；已暂停恢复用户阅读位置。
- 页面不可见时停止轮询。

## 10. 概览、笔记与导出

### 10.1 概览

- 删除“打开此标签页后会提取关键语句”教学空态。
- 字幕未就绪时显示 `blocked(no_transcript)`，不触发任何获取或生成请求。
- 字幕已就绪且概览仍为 `idle` 时，首次主动点击概览即就地生成。
- 缓存命中直接显示；不重复调用。
- 失败后提供 `重新生成概览`；再次进入 Tab 不自动重试。

### 10.2 笔记

- 将“如何保存笔记”变成真实控件，不再依赖教学段落。
- 字幕当前行或聚焦行提供 `保存这一段`。
- 笔记空态提供 `保存当前时刻`。
- 与页面书签和 `N` 键共用写入、去重和来源固化路径。
- 字幕未取得或上下文失效时置灰，不能因此触发字幕或 Supadata 请求。

### 10.3 导出

- 当前导出业务出口保持不变。
- 选择模式显示已选数量、明确的完成/直接导出和取消动作。
- 完成后显示实际下载文件名。
- 长任务切换 Tab 后继续，但对应 Tab 显示进行中或完成待查看状态。

## 11. 前端实现约束

项目继续使用原生 HTML/CSS/JavaScript，不引入 React 或重型状态库。

建议模块：

- `sidepanel-state.js`：纯状态、事件、reducer、动作派生。
- `sidepanel-effects.js`：Chrome message、single-flight、取消、generation 与迟到结果丢弃。
- `sidepanel-follow.js`：播放高亮、用户滚动意图与回位控制。
- `sidepanel.js`：DOM 绑定、视图渲染和既有业务组合。

核心形式：

```text
state + event → nextState
state → visible component
state → allowed actions
```

按钮只保存 `{ id, label, kind, event }`，不保存临时回调。`sidepanel-state.js` 不得直接调用 `chrome.*`；所有外部副作用只由 `sidepanel-effects.js` 执行。

`background.js` 原则上不改变产品路线；只有当现有错误码不足以表达 UI 契约时，才允许增加稳定 outcome 映射，并需单独确认。

## 12. MVP 范围

### 包含

- 持久外壳和区域状态机
- 五类状态结构
- 点击反馈原语
- 跟随模式与滚动恢复
- Tab 局部状态保存
- 概览首次生成与缓存反馈
- 侧栏笔记入口
- 终止状态精确映射
- 键盘、焦点、`aria-live`、减少动态
- 320–480px 与 200% 缩放

### 不包含

- 新 Provider
- Panel 进入产品路线
- 固定 IOS/json3 之外的客户端或字幕格式扩散
- 设置页整体重设计
- 富文本笔记
- 跨设备同步
- 新的导出业务语义
- 遥测系统

## 13. 实施顺序

1. 状态、事件、动作和身份代际契约；建立新测试基线。
2. 持久外壳与字幕主链：读取、CC、免费重试、Supadata、terminal、error。
3. 滚动与跟随：用户意图、回位、Tab 往返。
4. 概览、笔记与导出反馈统一。
5. 可访问性、窄宽和真实 Chrome 连续验收。

迁移期间允许单向适配器把旧结果映射到新状态；MVP 验收前，旧 `showError`、`errorAction` 和 `errorSecondaryAction` 产品调用必须归零，不允许最终双轨共存。

## 14. 自动验收契约

至少覆盖：

- 状态转换表和 `state → action label/event` 快照
- `needs_cc` 期间自动刷新或 Passive 返回 UNKNOWN 不显示 Supadata、不改变 `retryUsed`
- 非 ready 交互态收到被动 success 进入 ready，被动 terminal 进入对应 terminal(reason)
- `terminal(login_required)` 处理后的新读取按首次 UNKNOWN 处理，只能进入 `needs_cc`
- `terminal(page_context_changed)` 只有明确重连动作才能进入新的 loading
- page epoch/videoId 变化清除 `retryUsed` 与所有同意令牌
- 首次 UNKNOWN 不出现 Supadata
- 一次明确免费重试后才可出现 Supadata
- Supadata 同意不持久，切视频立即失效
- 保存 Key 事件本身零 Supadata 请求，返回后重新显示授权卡
- 429 冷却期内授权动作禁用且零请求
- `retryUsed=false` 时任何 error 恢复都不能进入 Supadata
- 免费重试的技术失败不构成解锁，回到 `needs_cc(retryUsed=false)`
- terminal 状态零 Supadata
- 非 YouTube 普通 UNKNOWN 进入 `terminal(unknown_reason)`，不出现 CC/Supadata
- Passive 命中时 Active/Panel 产品调用为零；Passive miss 的 Active 最多 `1 player + 1 timedtext`，Panel 始终为零
- 同一 `generation+epoch` 的 `ready` 丢弃后续降级结果
- single-flight 与迟到结果丢弃
- 程序滚动不暂停跟随
- wheel/touch/键盘滚动暂停跟随
- Follow 状态快照；点击回位恢复 `following`
- `follow=paused` 时 Tab 往返恢复滚动位置、筛选和跟随
- `follow=following` 时 Tab 返回定位当前播放字幕卡
- 暂停期间回位标签随实时播放 cue 更新，点击后定位当前 cue
- 字幕未 ready 时概览为 `blocked` 且零字幕/Supadata/AI 请求
- 概览 Tab 可见期间字幕转 ready，只进入 `idle`，不得自动生成
- 概览首次只生成一次，缓存不重复
- 侧栏笔记与页面按钮共享去重路径
- 撤销窗内切换视频、隐藏或关闭侧栏时，待删除项立即提交且撤销入口关闭

测试载体必须显式区分：

### 14.1 Pure Node 单测

- 状态转换、`state → action label/event`、`state → Progress/Action/Consent/Terminal/Error` 组件类别快照。
- `sidepanel-follow.js` 暴露注入式纯决策核心（scroller、clock、输入事件端口），在无 DOM 环境下验证用户滚动、程序滚动、Follow 模式、实时 cue 标签和 Tab 往返指令。
- single-flight、`generation+epoch`、一次性同意令牌和迟到结果丢弃。
- 点击 dispatch 到视图指令用 `performance.mark` 断言 ≤100ms；任务未完成时的局部状态指令 ≤300ms。

### 14.2 静态断言

- §7 是规范文案来源，`state → action label/event` 快照是其机器编码和自动核验载体。
- 产品源码静态断言只允许引用固定 IOS/json3 Active 文件；不得引用 Panel 产品文件或实验消息名。
- `sidepanel-state.js` 不得出现 `chrome.*`。
- MVP 验收时产品路径中的 `showError`、`errorAction`、`errorSecondaryAction` 调用数必须为零。
- 错误色 token 只允许出现在 `kind=error` 组件的 CSS 允许列表。
- cache 骨架显示阈值固定为 150ms；短成功反馈持续 `1200ms ± 200ms`。

### 14.3 真实 Chrome（§15）

以下不在当前纯 Node harness 中伪造：实际绘制反馈、wheel/touch/键盘事件、`scrollend`/滚动位置、320/360/400/480px、200% 缩放、键盘焦点、VoiceOver 与减少动态。若实施中决定新增 DOM/浏览器自动化 harness，必须先把它加入 §12 MVP 范围并单独确认；未确认时以 §15 连续可见验收为准。

## 15. 真实 Chrome 连续验收

1. 缓存命中，零新请求。
2. CC 关闭 → 引导 → 开 CC → 免费重读成功。
3. 免费重读仍失败 → Supadata 选择 → 拒绝零请求 → 再次选择 → 明确授权。
4. 同一侧栏会话未配置 Key → 设置 → 返回后授权卡重新出现、零自动调用；关闭重开侧栏则从首次读取重新开始。
5. 无字幕、登录限制、视频不可用分别正确终止。
6. 请求中切视频，旧结果不得写入新视频。
7. 自动跟随 → 手动滚动暂停 → 回位 → Tab 往返。
8. 概览生成、缓存复用与失败恢复。
9. 保存笔记、删除撤销与导出反馈。
10. 320/360/400/480px、200% 缩放、键盘、VoiceOver、减少动态和窄宽复验。

量化门槛：

- 可见点击后无可感沉默；自动化只证明状态/视图指令 ≤100ms，真实绘制由本节观察。
- 未在 300ms 内完成的长任务，须在 300ms 时已经显示局部状态。
- `follow=paused` 时 Tab 往返滚动位置误差 <8px；`follow=following` 时返回后定位当前播放字幕卡。
- 视频身份就绪后不再出现全屏 loading/error。
- 红色只用于真正错误。
- 所有按钮名称与实际事件一致。

## 16. 风险与恢复

- 状态机爆炸：终止/错误参数化，转换表保持一屏可读。
- 状态点噪音：只显示后台进行、完成待查看或需操作。
- 跨视频串台：所有任务绑定 `videoId + routeKey + generation + epoch`。
- 同意泄漏：Supadata 同意不存储，页面切换立即作废。
- 大工作树冲突：MVP 只在独立分支/工作树实施。
- 测试假绿：先建立状态和动作契约，再迁移旧 DOM 测试。

## 17. 外部共审

本文落盘后由 Codex、Opus 5 MAX 与 K3-2 聚焦复核以下三类问题：

1. 是否违反不可变字幕/Supadata 边界；
2. 状态机、点击和滚动契约是否存在遗漏或过度设计；
3. MVP 范围、实施顺序和验收是否足以交给独立继任任务执行。

### 17.1 审查结果与修订

- 第一轮完整审查：Opus 5 MAX 与 K3-2 均返回 `CHANGES_REQUIRED`。问题集中于 `taskOrigin/retryUsed` 未写死、登录/页面重连可能被误建模为免费重试、同意令牌消耗时点、状态出边、概览 blocked、跟随与自动/真实验收载体。
- 第二轮完整审查：Opus 返回 `PASS`（同时列出 4 项 P2 登记缺口）；K3-2 返回 `CHANGES_REQUIRED`（2 项相同 P2）。
- 已完成修订：加入三重 Supadata 解锁前置、error 来源限制、同意令牌一次性消耗、`generation+epoch` 身份、被动结果通用出边、429/重连回边、非 YouTube fail-closed、既有 outcome 适配表、Follow 显式模型和 Pure Node/静态/真实 Chrome 三类验收载体。
- 最终差量复核：Opus 入口未返回可用 verdict；K3-2 入口达到回合上限。两次失败均不冒充通过。Codex 已逐条对照两路最后报告，确认其列出的 P0/P1/P2 均在当前正文有明确落点；本文状态写为“共审意见已吸收”，不写“两路最终签字 PASS”。

### 17.2 模型执行回执

| 执行岗位 | 入口 | 实际模型/档位 | 结果 |
| --- | --- | --- | --- |
| MVP 方向文件完整审查与复核 | cld | `claude-opus-5` / 档位未核实（请求 `max`） | 完整审查、复核和修订意见已返回；最终差量入口未给可用 verdict |
| MVP 方向文件完整审查与复核 | cbd | 模型未核实 / 档位未核实（请求 `kimi-k3-2 / xhigh`） | 两轮完整意见已返回；最终差量入口达到回合上限 |

结论：**外部共审已执行且全部有效发现已吸收到本文；没有把未返回结果写成 PASS。MVP 实施仍须按本文自动门和真实 Chrome 门重新验收。**

## 18. 继任与写入权

- 当前任务负责：固化方向、合并并发布当前字幕链、建立新分支/工作树、注入交接、核实继任任务接住。
- 新任务负责：只在新 MVP 工作树实现本文，不修改旧实验工作树。
- 新任务核实接住前保持休眠；写入权不得在两个任务间并行。
- 旧实验工作树与 Active/Panel 实验证据不得删除。
