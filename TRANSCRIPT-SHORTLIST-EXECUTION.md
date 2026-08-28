# YouTube 字幕三路线收敛执行方案

状态：原三路线 Phase 4 已被后续减法决策取代；简化链已实施，待离线与重新加载后的可见验收
方案日期：2026-08-27（America/Los_Angeles）
实验真源：`/Users/wangchao/Documents/061-DigestDock/worktrees/transcript-source-comparison-v2`
实验分支：`codex/transcript-source-comparison-v2`

> 用户已于 2026-08-27 授权在当前实验分支执行 Phase 1-3。该授权不包含删除实验、合并 `main`、提交、推送、版本变更、发布或新的 YouTube / Supadata / hosted API 请求；Phase 4 真实浏览器验收仍需另行明确启动。

> **后续决策（2026-08-27）**：真实验收证明缓存/Passive 在 YouTube 字幕开启时可稳定工作，成功缓存后关闭字幕仍可复用；但 Active 与自动 Panel 未在产品集成中闭环。用户据此批准进一步做减法：产品执行链改为“正向缓存/Passive → 首次 miss 提示用户打开 YouTube 字幕（CC）→ 用户显式免费重试 → 仍 miss 才显示 Supadata”。Active、Panel 仅保留为实验证据，不再由正式候选链自动调用。本文其余 Active/Panel 串行内容保留为历史实施记录，凡与本段冲突均以本段为准。

## 1. 决策摘要

最终候选只保留以下产品链路：

1. **本地正向缓存 + Passive**：零新增请求优先。
2. **打开 YouTube 字幕提示**：首次 miss 只提示用户打开 CC，并由用户点击后执行一次免费重试。
3. **Supadata**：不属于免费链路；默认隐藏，仅在显式 CC 重试仍为 `UNKNOWN` 时向用户显示，并继续保留逐视频授权。
4. **Active / Panel**：只保留实验证据和独立测试，不进入产品执行链或候选 ZIP。

任何时刻只允许一条路线执行。不得并行预取、自动请求 YouTube 字幕、自动操作文字稿面板、自动调用 Supadata 或新增其他字幕 Provider。

## 2. 目标与成功定义

### 2.1 唯一目标

在当前隔离实验分支中，把已验证的缓存/Passive 收敛成一条简单、快速、可解释的 YouTube 字幕获取链，并在 miss 时提示用户打开 CC；Active 与 Panel 只保留为实验参考。

### 2.2 三个不可破坏的产品原则

- **简单**：免费路线不新增确认按钮、设置项、评分系统或用户手动采集步骤。
- **速度快**：先查现有正向缓存和 Passive 捕获；不存在可等待的页面字幕响应时不固定空等。
- **有效**：成功、确定无字幕、视频受限、页面切换和 429 都有明确终止规则；普通技术失败才允许进入下一路线。

### 2.3 完成不等于发布

本方案的“完成”分四层，必须分开报告：

1. 实验代码完成；
2. 离线测试通过；
3. 真实 unpacked MV3 验收通过；
4. 正式 DigestDock 集成、提交、推送和发布。

前一层不能自动升级为后一层。

## 3. 明确非目标

本轮不得：

- 把 `local-helper`、Node libraries、`yt-dlp`、`youtubei.js` 或其他新 Provider 加回产品链；
- 继续测试或研究 `supadata-native`、`hosted-api-slot` 的服务商、价格、Key 或真实调用；
- 自动调用 Supadata，或把已保存 Key 解释为持续授权；
- 下载音频、执行 ASR/OCR、代理轮换、Cookie 读取、请求头伪造或访问控制绕过；
- 修改 B 站字幕路线、AI 概览、翻译、笔记或导出逻辑，除非是修复本次改动直接造成的回归；
- 建立成功率评分、自适应路由、并行竞速、指数退避、熔断器、后台健康探测或新的控制台；
- 保存“没有字幕”的负面缓存；
- 清理或删除输掉的实验实现；删除必须在产品链验收后另给精确清单并单独授权；
- 直接把实验分支合并到 `main`、提交、推送、变更版本号或发布。

## 4. 当前基线

### 4.1 实施前的正式主线基线

- 根扩展版本为 1.4.4。
- YouTube 字幕正文当前只允许经逐视频授权后的 Supadata 获取。
- `background.js` 已有 Supadata 单次授权、后台 single-flight、页面身份复核、响应上限和 60 秒 session cooldown。
- `sidepanel.js` 已有：
  - `digestGeneration` 与 route identity；
  - 当前页面切换后的旧结果拒绝；
  - 侧栏内 single-flight；
  - `digest_<videoId>` 正向字幕缓存；
  - 30 天过期、最多 20 个视频；
  - `TRANSCRIPT_SOURCE_POLICY_VERSION` 来源验证。
- `manifest.json` 已有 `storage`、`tabs`、`scripting` 和 YouTube host permission；不得新增 `cookies` 权限。

### 4.2 已有实验事实

- Passive：真实 MV3、零新增请求、SPA 新旧视频隔离通过；未覆盖完整 ASR / 无字幕矩阵。
- Active isolated-tab：真实 MV3 已覆盖短人工、长 ASR、`NO_TRANSCRIPT`、`TRACK_UNAVAILABLE`；成功样本为 1 player + 1 timedtext；无字幕/缺轨样本为 4 player。
- Active popup-origin：两个域名均 403，永久退出候选。
- Panel：一个真实 MV3 手工字幕样本完成 24 段、连续覆盖；另两个有字幕视频的 YouTube `get_transcript` 返回 400；400 不是无字幕证据。
- 三条字幕端点实测均未返回 429；已观察到的 429 来自页面独立 `RotateCookies` 请求。不得据此宣称 Active 永不触发 429。

### 4.3 当前工作树边界

- 当前实验结果和修复仍未提交。
- 实施开始快照为 21 个 tracked modifications 与 28 个 untracked artifacts（含本方案），均属于用户已有实验成果；实施时不得覆盖、重置或批量暂存。
- 新方案文件和后续实现必须单独列出、逐文件处理；禁止 `git add -A` 或 `git add .`。

## 5. 冻结后的状态机

### 5.1 触发范围

- Passive observer 可以在 YouTube 页面常驻，因为它不创建字幕请求。
- 免费获取流程只在 **DigestDock 需要当前打开视频的字幕** 时启动，例如用户打开侧栏并进入字幕/概览处理流程。
- 普通浏览、仅打开保存笔记、切换标签页或后台页面完成事件不得静默启动 Active、Panel 或 Supadata。

### 5.2 两种不同身份

必须把“缓存身份”和“本次任务身份”分开：

- **缓存身份**：`platform + videoId/mediaKey + requestedLanguage + trackKind + policyVersion`。用于判断重新打开旧视频时能否复用成功字幕；不得包含 tabId 或本次运行 generation。
- **本次任务身份**：`tabId + digestGeneration + routeKey + requestedLanguage + trackKind`。复用 `sidepanel.js` 已有的 `digestGeneration`，只用于 single-flight、页面切换取消和旧结果拒绝；不得再创建第二套同义 generation。

background 的 native single-flight 另用 `videoId + requestedLanguage + trackKind` 作为共享键：同一视频在多个 tab / 窗口的并发请求挂到同一个 in-flight；每个等待者仍保留自己的 tabId、runId 与 routeKey，并在接受结果前独立复核当前页面。tabId 不得成为放大同视频网络请求的分片键。

重新打开以前的视频时先查正向缓存：缓存有效就直接使用；缓存不存在、过期、语言/轨道不匹配或来源策略不兼容时，必须允许重新获取。历史执行记录不能永久跳过视频。

### 5.3 路由结果

产品编排只使用三类结果：

- `HAVE_TRANSCRIPT`：已有可验证的完整字幕，保存并结束。
- `CONFIRMED_UNAVAILABLE`：明确无字幕、登录/年龄/会员/地区限制或视频不可用，向用户说明并结束；不显示 Supadata。
- `UNKNOWN`：当前路线因为技术原因不能确定结果，按允许的顺序进入下一路线。

以下是特殊控制结果，不进入普通后备：

- `PAGE_CONTEXT_CHANGED`：取消旧流程，由新页面周期决定是否重新启动。
- `RATE_LIMITED`：保留为内部诊断码，记录 YouTube 原生路线冷却并停止 Active / Panel；对当前产品流程收敛成最终 `UNKNOWN`，因此 Supadata 卡片仍只有“最终 UNKNOWN”一个显示条件。缓存和 Passive 继续可用。

详细错误码（400、timeout、empty、incomplete 等）继续保留在诊断中，但不扩张产品分支。

### 5.4 严格串行流程

#### Step 0：正向缓存 + Passive 零请求门

1. 读取现有正向字幕缓存并验证来源策略、语言、轨道、完整性和 30 天过期时间。
2. 同时读取当前 tab / video / language / track 对应的 Passive 捕获缓冲，并用本次 `digestGeneration` 拒绝迟到结果。
3. 任一命中即返回 `HAVE_TRANSCRIPT`，不运行 Active 或 Panel。
4. 不设置固定等待时间：
   - Passive 已记录当前视频字幕请求正在进行时，只等待一次最多 1,500 ms 的内部窗口；
   - 没有 in-flight 证据时立即进入 Active。
5. 不保存负面缓存。

#### Step 1：Active isolated-tab

1. 仅在 Step 0 未取得字幕且不处于 YouTube 原生路线冷却时运行。
2. 在当前 YouTube tab 的 ISOLATED world 执行，保持：
   - `credentials: omit`；
   - 不读 Cookie / storage；
   - 不进入 MAIN world；
   - 不伪造 `User-Agent` / `Origin`；
   - 不回退到其他 Provider。
3. 典型成功目标为 1 player + 1 timedtext。
4. 设置明确硬上限，防止 track / format / client 组合造成请求数失控：
   - player 请求不超过当前已验证的四 client 上限；
   - 只对一个已选轨道读取字幕正文；
   - 字幕格式最多尝试 JSON3 / srv3 / classic 三种；
   - 单次 Active 硬上限为 4 player + 3 timedtext，典型成功目标仍为 1 + 1；
   - 任一 429 在读取响应正文前立即停止全部后续尝试。
5. “首个确定性空轨即可停止”的优化不得直接上线。先用现有语料证明首个 playable client 的空轨不会掩盖后续 client 可见轨道；证据不足时维持已验证的 bounded client fallback。
6. 返回规则：
   - 字幕成功：`HAVE_TRANSCRIPT`；
   - 明确无字幕或限制：`CONFIRMED_UNAVAILABLE`；
   - 普通网络/解析/端点技术失败：`UNKNOWN`，允许 Panel；
   - 429：`RATE_LIMITED`；
   - 页面切换：`PAGE_CONTEXT_CHANGED`。
7. 目标 tab 被关闭、导航离开、变成受限页面或无法注入时一律按 `PAGE_CONTEXT_CHANGED` 处理：不进入 Panel、不写缓存、不显示 Supadata。

#### Step 2：Panel 自动后备

1. 仅在 Active 返回普通技术 `UNKNOWN` 时运行；Active 的 `CONFIRMED_UNAVAILABLE`、429 或页面切换不能进入 Panel。
2. 运行前做零请求前置判断：
   - Active 已发现字幕轨；或
   - 当前页面存在可识别的文字稿入口。
3. 不满足前置条件时直接返回 `UNKNOWN`，不打开页面面板。
4. 满足条件时自动执行一次，总时限 15 秒：
   - 记录页面和面板初始状态；
   - 必要时展开描述并打开文字稿；
   - 找到真实内部滚动容器；
   - 连续滚动并收集，必须覆盖顶部、中间和底部；
   - 绑定当前 videoId 和本次 `digestGeneration`；
   - 完成、失败、超时、页面切换或任务取消后，都必须在仍可访问该 tab 时恢复由扩展造成的页面滚动、描述展开和面板状态。
5. 设置单次总超时；不重试、不循环重开。
6. 400、空面板、无入口、超时、不完整、DOM 变化均返回 `UNKNOWN`。400 不能转成 `NO_TRANSCRIPT`。

#### Step 3：Supadata 隐藏后备

1. 正常侧栏和默认设置视图不展示 Supadata。
2. 仅在免费链最终为 `UNKNOWN` 时显示一次可选后备卡片；429 先写入 cooldown，再在当前任务中收敛为 `UNKNOWN`，不增加第二种 UI 触发分支。
3. `CONFIRMED_UNAVAILABLE`、访问限制或页面切换不显示后备卡片。
4. 未配置 Key：显示简短说明和“了解并配置 Supadata”入口；用户主动进入后才显示注册链接和 Key 输入。
5. 已配置 Key：显示“为当前视频使用 Supadata”，仍需逐视频明确点击。
6. 已保存 Key 不构成授权；拒绝后发送请求数必须为 0。
7. 用户确认 Supadata 时，不重新执行 Passive / Active / Panel；只重新验证当前 tab / video identity、访问限制、Supadata cooldown 和 single-flight，然后调用现有 `mode=native` 路径。

### 5.5 429 最小机制

- 只增加一个 session-scoped 数值：`youtube_native_cooldown_until`。
- 首个 Active player/timedtext 429 写入固定 60 秒初始冷却；该值只防止立即重入，不代表 60 秒后 YouTube 必然解除限制。不做指数退避、计数器、熔断器或用户设置项。
- 冷却期间：
  - 正向缓存和 Passive 继续可用；
  - Active 与 Panel 均不运行；
  - 当前免费链结果收敛为最终 `UNKNOWN`，用户可选择等待，或主动使用同一 Supadata 后备卡片；
  - 不自动调用 Supadata。
- 冷却后仅在新的用户字幕任务中允许下一次 Active；不得由定时器后台自动重试。

## 6. 架构与代码归属

### 6.1 唯一编排所有者

- `background.js` 成为 YouTube 字幕免费链与 Supadata 后备的唯一 Provider 编排所有者。`sidepanel.js` 发出的请求必须携带 `digestGeneration` / runId，background 原样回传；迟到结果仍由 sidepanel 的 `isCurrentDigest()` 做最终拒绝。
- `sidepanel.js` 继续作为持久正向缓存的唯一读写所有者：先用现有校验函数查 cache，miss 后才向 background 发起字幕任务；background 不再复制一套持久缓存校验，只读取 Passive session buffer 并编排网络/页面路线。
- `sidepanel.js` 还负责显示简单状态、接收结果和呈现 Supadata 可选卡片；不得决定 Provider 级回退。
- 页面脚本只负责当前 runtime world 的观察或读取，不决定跨 Provider 回退。

### 6.2 单一 canonical core

- Active 当前在 `youtube-active/youtube-transcript.js` 与 `youtube-verifier/verifier.js` 有重复实现。实施时直接以已经通过真实 isolated-tab MV3 验收的实现生成唯一产品 Active 模块；现有实验副本冻结为证据，不再建立一个需要二次搬运的中间 canonical 副本。
- Panel 以已通过真实 MV3 的 `manual-probe/reader.js` 为源，但产品版本必须加入自动打开/滚动/恢复和总超时。
- Passive 以现有 MAIN hook、ISOLATED bridge 和 service-worker 逻辑为源，不复制第三套解析器。
- 正式根目录只允许每个 runtime world 一份生产模块；实验 fixture 和产品文件不得长期双向漂移。

### 6.3 预期产品文件

最终晋级根扩展时，预期最小文件面为：

- `manifest.json`：加入 Passive 的 document-start MAIN / ISOLATED 脚本；不新增 host 或 cookies 权限。
- `background.js`：加入串行路由、native single-flight、Passive read、Active/Panel 调用、native cooldown、Supadata 分流。
- `sidepanel.js`：接入三类结果、正向缓存来源、隐藏 Supadata 卡片、当前页面周期取消。
- `options.html` / `options.js`：未配置 Key 时 Supadata 区域默认隐藏；只有失败卡片的显式入口才能显示并聚焦。已经配置 Key 时保留一个低层级管理入口，确保用户可查看、替换或删除 Key，但不得在正常字幕流程中主动推广。
- `settings.js`：继续保存可选 Key；不保存站立授权、负面结果或用户级自动回退偏好。
- 每个 runtime world 的最小生产模块：Passive MAIN、Passive bridge、Active core、Panel reader。最终命名由实现阶段确定，但不得把 `experiments/` 路径放进发布包。
- `scripts/check-release.sh`：Phase 3 先在实验分支显式加入并验证必要产品文件；Phase 5 决策后才允许把同一清单移植到正式 `main` 的 release allowlist。
- `SECURITY.md`、`PRIVACY.md`、`README.md`、`README.zh-CN.md`：与实际路由、权限、页面副作用和第三方边界同步。

现有“必须先配置 AI Provider Key 才进入主面板”的产品门不在本轮改造范围。免费字幕路线与 AI Key 是否解耦需要另行产品决策；本方案不得顺手重构 AI onboarding。

## 7. 分阶段执行

### Phase 0：授权与政策门

实施开始前必须获得一次单独授权，确认只在当前实验分支修改根扩展和实验文件。

同时必须明确接受实验分支的安全策略草案：

- Passive 可观察并转发页面已请求的字幕正文，但不得转发签名 URL；
- Active 可在用户启动 DigestDock 字幕任务后发起 bounded YouTube player/timedtext 请求；
- Panel 可在后备阶段自动改变并恢复当前 YouTube 页面 UI；
- 不读取 Cookie、不下载音频、不做 ASR/OCR、不绕过访问控制；
- Supadata 仍是显式第三方后备，永不自动调用。

未通过此门，只能整理实验代码和证据，不得修改根扩展或现有 `SECURITY.md`。

### Phase 1：实验真源收敛

1. 修复当前证据漂移：
   - 根执行记录中 Active long-ASR / no-caption 的旧 pending 状态；
   - `manual-results/REPORT.md` 漏掉的运行；
   - provider registry 的 accepted/rejected/disposition 状态；
   - 顶层实验 README 的过期 live 状态。

   > 范围说明：Node 单候选报告模板不影响三路线实施，本阶段不修改；如需整理，放入 Phase 6 的独立清理预览。
2. 冻结真实验收过的 Active isolated-tab 行为作为产品模块来源，并列出产品实现必须统一的字段：`providerVariant=isolated-tab`、`PAGE_CONTEXT_CHANGED`、429 立即停止、request counts 与完整 transcript contract；不在实验目录再造中间 core。
3. 保持 popup-origin 两变体为 rejected evidence，不再运行或研究。
4. 实验目录只补最小结果枚举和终止规则断言；完整串行、缓存、UI 与并发合同集中在 Phase 3 的根扩展测试，避免两份状态机测试漂移。

**退出条件**：实验 registry、报告、README、Active acceptance 与原始 JSON 对同一状态无冲突；所有实验离线测试通过。

### Phase 2：实验分支根扩展实现

1. 加入 Passive document-start observer，并与当前 `content.js` 生命周期隔离。
2. 在 background 建立：
   - 以 `videoId + requestedLanguage + trackKind` 为共享键的跨 tab / 窗口 native route single-flight；
   - page/run identity；
   - sidepanel cache miss 后的 Passive zero-request gate；
   - Active bounded attempt；
   - Panel eligibility + one-shot attempt；
   - one-timestamp native cooldown；
   - Supadata direct-confirm branch。
3. 让 sidepanel 只发送一个当前字幕任务；不得分别触发三路线。
4. 更新缓存来源策略并提升 `TRANSCRIPT_SOURCE_POLICY_VERSION`：
   - 接受 `youtube-passive`、`youtube-active`、`youtube-panel`、`supadata`；
   - 保留 B 站独立来源；
   - 验证 requested language、selected track、media identity；
   - 继续只保存成功字幕；不写负面缓存；
   - transcript source、正文 fingerprint 或语言变化时，不复用不匹配的旧概览、翻译或导出资料。
5. 改造 Supadata UI：
   - 正常设置页隐藏；
   - 免费链最终 `UNKNOWN` 后显示可选卡；
   - 未配置时深链到隐藏设置区；
   - 已配置时逐视频确认；
   - 已配置 Key 始终有可发现的删除/替换入口；
   - 首次安装与普通设置说明不再要求用户预先注册 Supadata；
   - 拒绝后请求数为 0。

**退出条件**：所有路线都由同一 background 状态机串行调用；sidepanel 无 Provider 级回退逻辑；无新用户设置项。

### Phase 3：离线验证

离线测试不得访问 YouTube、Supadata 或其他网络。

必须覆盖：

#### 状态机与串行

- cache hit / Passive hit 后 Active、Panel、Supadata 调用数均为 0；
- Passive miss 后才运行 Active；
- Active 普通技术失败后才运行 Panel；
- `CONFIRMED_UNAVAILABLE` 不进入 Panel 或 Supadata；
- 429 写入 cooldown，停止 Active 后续请求并跳过 Panel；
- Panel 失败后只显示 Supadata 可选卡，不发第三方请求；
- 任何时刻最多一个 route in-flight；
- 同一 video/language/track 的多 tab、多窗口和重复事件共享一个 native in-flight；各等待者独立复核自己的 tab/runId；
- A → B → A 的旧 A 结果不能被新 A 接受；
- tab 关闭、导航离开或不可注入返回 `PAGE_CONTEXT_CHANGED`，后续 route 调用数和缓存写入数均为 0。

#### 缓存与当前页面周期

- 重新打开旧视频：有效正向缓存直接使用；
- 缓存缺失/过期/语言或轨道不匹配：允许重新获取；
- `digestGeneration` 变化只取消当前任务，不污染正向缓存；
- background 回传的 runId 与当前 `digestGeneration` 不一致时必须丢弃；
- 不存在负面缓存写入；
- policy version 变化使不兼容旧来源失效。
- transcript fingerprint / source / language 变化后，旧概览、翻译和导出资料不能冒充当前资料。

#### Passive

- 新增字幕请求数恒为 0；
- signed URL 不进入消息、storage、日志或 fixture；
- 只接受当前 tab / video / language / track；
- SPA 旧视频 capture 被拒绝；
- in-flight 标志只造成一次短等待；
- in-flight 等待不超过 1,500 ms；
- hook 可清理，异常不改变页面原请求结果。

#### Active

- 短人工、长 ASR、no-caption、缺轨和语言边界；
- 成功典型 1 player + 1 timedtext；
- 单次总请求硬上限为 4 player + 3 timedtext；
- 429 在读取正文前立即停止；
- timeout、过大响应、无效 JSON、空正文和页面切换；
- `credentials: omit`，不读 cookies/storage，不伪造 header；
- 首 client 空轨早停只有在证据门通过后才改变现有行为。

#### Panel

- 无字幕轨证据且无文字稿入口时不打开 UI；
- 自动打开、滚动、连续覆盖、完成并恢复页面；
- 单次总时限不超过 15 秒；
- 400、空面板、无入口、超时、不完整统一为 `UNKNOWN`；
- 400 不写 `NO_TRANSCRIPT`；
- 页面切换立即取消；
- 失败、超时、页面切换和取消后，在目标 tab 仍可访问且页面上下文仍可恢复时，不留下扩展造成的页面滚动/描述/面板残留；
- Panel reader 自身直接 `fetch` / `XMLHttpRequest` 数为 0；自动打开文字稿可能诱发 YouTube 页面自己的 panel 请求，必须单独记录为 page-induced，而不能表述成整体网络请求为 0。

#### Supadata 与 UI

- 正常侧栏和默认设置视图不出现 Supadata；
- 免费链成功或 `CONFIRMED_UNAVAILABLE` 不出现 Supadata；
- 最终 `UNKNOWN` 才显示可选卡；native 429 先写 cooldown，再收敛到同一个 `UNKNOWN`；
- 无 Key 时只有用户点击后才显示注册和 Key 区；
- 有 Key 仍需当前视频的显式确认；
- 已配置 Key 可以从低层级管理入口删除或替换；
- 首次安装不要求配置 Supadata；
- 拒绝、关闭卡片、页面切换、普通自动刷新都不发送第三方请求；
- 确认后不重跑免费链。

#### 回归与发布边界

- B 站字幕、概览、翻译、笔记、导出和设置保存现有测试全部保持通过；
- 实验分支的 release allowlist 验证不含 `experiments/`、Node/Python 依赖、manual results 或 transcript 正文；这不等于已晋级正式 `main`；
- manifest 不新增 cookies 权限；
- ZIP 中只有显式批准的产品文件。

执行门：

```text
npm test
npm run check
npm run package
git diff --check
```

另跑实验目录现有离线测试。任何测试意外联网即失败。

### Phase 4：真实 unpacked MV3 验收

真实测试必须由用户另行明确启动；编码阶段不得自动运行。

执行状态（2026-08-27）：用户已授权启动，当前为“部分通过，未达到退出条件”。准确构建身份、Passive 零放大成功、可见字幕成功、两个 final `UNKNOWN` 样本、未验证项与停止原因记录在 `TRANSCRIPT-SHORTLIST-PHASE4-ACCEPTANCE-2026-08-27.md`。在 Active/Panel 请求计数与 no-caption 分类闭合前，不得进入 Phase 5。

失败后最小补丁已完成离线验证：页面 known-zero 轨道现在收敛为 `CONFIRMED_UNAVAILABLE`，页面已知轨道可作为 Active 技术失败后的 Panel eligibility，且不传任何签名 URL。全量 `562/562` 与独立复核通过；重新加载候选扩展后的两样本可见复验仍待执行，因此本阶段尚未通过。

验收使用当前实验分支的准确 unpacked 路径，一次只加载一个 DigestDock 测试副本。先记录扩展 ID、分支、HEAD、manifest version 和测试时间。

最小语料：

1. 有效正向缓存：重新打开旧视频，0 个新字幕请求；
2. Passive 手工字幕：0 新请求、正文抽样、SPA A → B；
3. Active 短人工：成功、请求计数；
4. Active 长 ASR：完整段数、首尾时间、canonical hash；
5. Active no-caption：准确 `CONFIRMED_UNAVAILABLE`；
6. Active 缺轨：不静默回退错误轨道；
7. Panel 可用样本：无人干预自动打开/滚动/恢复，连续覆盖；
8. Panel 400 样本：返回 `UNKNOWN`，不声称无字幕；
9. 页面切换：旧结果不能落到新视频；
10. Supadata 隐藏与零请求：免费链未终止前不可见；终止后只显示卡片，不做真实调用。

每份验收 receipt 固定记录：扩展 ID、分支、HEAD、manifest version、时间、tab/video/run identity、route、结果分类、endpoint class 次数、首尾时间、段数、页面恢复结果和停止原因；不保存 query string、签名 URL 或字幕正文。第一次观察到任何 YouTube 429 后立即停止 Active / Panel 测试；不为制造 429 而重复调用。Supadata 真实请求继续禁止，除非用户另行授权 Key、额度和单次尝试。

**退出条件**：关键用例通过、无未解释新增请求、无页面残留副作用、无 stale result、无第三方自动调用；失败用例保留原始 text-free receipt。

### Phase 5：晋级正式 DigestDock 的用户决策门

真实验收完成后，提供一份简短晋级报告：

- 每条路线成功/失败覆盖；
- 典型与最坏请求数；
- 页面副作用；
- 429 / cooldown 结果；
- 权限与隐私变化；
- 未解决风险；
- 与当前 Supadata-only 主线的差异。

只有用户明确批准后，才允许：

1. 更新正式 `SECURITY.md` / `PRIVACY.md` 规则；
2. 从当前远端 `main` 建立干净发布工作树；
3. 以审核后的最小差异移植代码；
4. 重新运行完整测试、release allowlist、ZIP 内容和浏览器验收；
5. 再单独请求 commit / push / version / release 权限。

不得把当前脏实验工作树直接合并进 `main`。

### Phase 6：实验减法清理（独立授权）

产品链晋级后再生成精确清理预览，分为：

- 保留：三路线原始 text-free receipts、验收记录、最终决策、canonical fixtures；
- 删除候选实现：Active popup-origin、输掉的 Node 候选、yt-dlp 字幕专用比较器、Supadata/hosted live-probe 身份；
- 继续留档但不进入产品：local-helper、youtube-transcript-plus；
- 禁止删除：用户未提交实验结果、Git 历史或用户未点名的文件。

清理预览与物理删除是两个授权门；shortlist 确认不等于删除授权。

## 8. 目标—任务—证据追踪表

| 用户已确认目标 | 实施任务 | 验收证据 |
| --- | --- | --- |
| 当前打开视频，而非永久 videoId 跳过 | 分离 cache identity 与现有 digestGeneration/run identity | 重开旧视频：有缓存直接用；无缓存重新获取 |
| 失败后才进入下一路线 | background 串行状态机 | 每条 route 调用计数；上一条非允许终态时下一条为 0 |
| Passive 默认后台且零请求 | document-start observer + current-video binding | providerInitiated=0；SPA stale rejection |
| Active 无二次确认但不随普通浏览启动 | 仅 DigestDock 当前字幕任务触发 | 普通导航调用数 0；任务触发一次 single-flight |
| Panel 无人干预 | eligibility check + 自动打开/滚动/恢复 | 完整覆盖；页面状态前后相同 |
| 429 不放大 | 单时间戳 session cooldown | 首个 429 后 Active/Panel 请求数不再增长 |
| Supadata 默认隐藏 | 免费链最终 UNKNOWN 才显示卡片 | 正常 UI 不出现；拒绝后第三方请求为 0 |
| 简单、快速、有效 | 复用现有缓存/generation/single-flight；无并行/评分/新设置 | 文件与状态数量审查；典型路径调用次数 |

## 9. 自审清单

方案在交付前必须逐项回答“是”：

### 9.1 目标漂移

- 是否仍只有 Passive、Active isolated-tab、Panel 三条免费候选？
- 是否仍把 Supadata 作为隐藏、显式、第三方后备，而非自动 Provider？
- 是否没有把 local-helper、Node、ASR、OCR、代理或其他 Provider 带回？
- 是否没有扩张到 B 站、AI、笔记和导出的主动重构？

### 9.2 任务遗漏

- 是否覆盖缓存、当前页面周期、A → B → A、重复事件、跨 tab/窗口 single-flight、tab 关闭/不可注入和取消？
- 是否覆盖成功、确定无字幕、受限、普通技术失败、400、429 和页面切换？
- 是否覆盖 Panel 在成功/失败/超时/切换/取消后的页面恢复，以及 Supadata 隐藏/拒绝/已配置三种状态？
- 是否覆盖文档、隐私、安全、release allowlist 和 ZIP？
- 是否覆盖 transcript 来源变化后的旧概览/翻译失效，以及已配置 Supadata Key 的删除入口？
- 是否保留真实浏览器门、停止条件和回退路径？

### 9.3 复杂度

- 是否只有一个编排所有者？
- 是否复用现有正向缓存、generation、single-flight 和 error UI？
- 是否没有新增用户设置、路线评分、并行请求、复杂退避、后台监控或负面缓存？
- 是否只有一个 native cooldown 时间戳？
- 是否没有为了“完整”而增加没有改变下一步行为的产品分支？

### 9.4 证据边界

- 是否把已有实测、待实现和待真实验收分开？
- 是否没有把离线测试写成真实 YouTube 验收？
- 是否没有把 Panel 400写成无字幕？
- 是否没有把当前未提交工作树写成已提交、已合并或已发布？
- 是否没有新增真实 YouTube / Supadata / hosted 请求？

## 10. 停止条件与恢复

任何阶段出现以下情况立即停止并回到最近一个已通过 Gate：

- 第一条 YouTube 429；
- signed URL、Cookie、Key 或字幕正文进入日志/fixture/commit；
- 当前视频身份与返回结果不一致；
- Passive 或 Panel 被证实新增字幕请求；
- 免费链成功后仍调用下一路线；
- Supadata 在没有当前视频显式确认时收到请求；
- 现有 B 站、AI、笔记、导出或设置保存回归；
- release ZIP 包含实验文件、依赖或结果；
- 实施需要新增 Provider、用户设置、常驻服务或更复杂治理才能继续。

恢复原则：先保留失败证据，禁用/撤回本阶段最小差异；不自动重试、不换 Provider、不扩大权限、不绕过限制。

## 11. 审查与交付状态

### 11.1 Codex 自审

- 目标漂移：PASS；免费候选仍只有 Passive、Active isolated-tab、Panel。
- 任务遗漏：PASS；覆盖缓存/运行周期、失败串行、跨窗口去重、400、429、页面恢复、Supadata 隐藏与 Key 管理、晋级/回退 Gate。
- 复杂度：PASS；一个 background 编排所有者、一个 cooldown 时间戳、无新 Provider、无并行、无评分、无负面缓存、无新用户设置。
- 证据边界：PASS；实施、离线测试、真实 MV3、正式晋级和发布保持分层。

### 11.2 Opus 5 终审

- 无工具、单轮全文终审返回 `PASS`。
- `simple`、`fast`、`effective`、`scope_control`、`evidence_boundaries` 五项均为 `PASS`。
- 无 blocking issue、无 target drift。
- 终审指出的三个澄清项已吸收：跨 tab/窗口 native single-flight 键；tab 关闭/不可注入归类；Panel 取消路径恢复页面。
- 终审指出的减法建议已吸收：cooldown 统一收敛到 `UNKNOWN` UI；实验状态机测试仅保留最小合同；不再建立中间 Active canonical 副本。
- 终审建议的明确上限已写入：Passive 1,500 ms、Active 4 player + 3 timedtext、Panel 15 秒。

### 11.3 当前交付边界

用户随后已授权执行 Phase 1-3，因此“只新增本文件”的方案交付边界已经被后续授权替代。当前允许的写入仍只限本实验分支中的证据收敛、根扩展候选实现、离线测试与同步文档；Git index、`main`、远端、版本号和发布状态继续保持不变。

### 11.4 Phase 1-3 执行回执

- Phase 1：registry、实验 README、根执行记录和 8 份手工结果报告已收敛；两条 popup-origin 保持 rejected，Supadata/hosted live scope 保持移除，未删除任何实验实现。
- Phase 2：实验分支根扩展已实现 cache/Passive → Active → Panel 串行链、当前 tab/run/导航 epoch、native single-flight、429 cooldown、Panel 自动恢复和最终 `UNKNOWN` 的隐藏 Supadata 分流；未增加 Cookie 权限或用户设置项。
- Phase 3：根扩展 `554/554` 离线测试通过；release check 通过并确认 43 个 allowlisted 文件；实验套件 `74/74`、Node 比较器 `10/10`、local-helper `11/11` 通过；实验 registry check 通过。
- 实验真源 `dist/` 中的 ignored 候选 ZIP 仅用于边界验证；失败后最小补丁重建后的 SHA-256 为 `a2adde420aa9d56edb041f44847c07f94a93a3727c92e7e214ef013c6f7fd072`；它未提交、未推送、未发布。
- 集成、安全／并发、Panel/UI 和文档终审均为 `PASS`。本轮没有运行真实 Chrome，没有新增 YouTube、Supadata、hosted API 或 AI 请求。
- Phase 4 仍是下一道硬门：必须由用户另行授权，并验证产品自动 Panel 的真实语言绑定、页面诱发请求、429 边界与页面恢复；在此之前不得表述为真实集成已通过。
