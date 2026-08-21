# DigestDock 字幕提供器拆分执行方案

日期：2026-08-21
执行对象：`/Users/wangchao/Documents/youtube-digest` 的本地 `main`
执行者：Claude Opus 4.8 Max
复核者：当前 Codex 主任务

## 一、目标

将 DigestDock 的 YouTube 字幕主线恢复为稳定、明确授权的 Supadata API 路径；保留本轮已经完成的 UI、品牌、Bilibili、笔记、备份和双扩展共存改动。当前 YouTube 页面内字幕提取实现保留在独立实验工作树，等待 YouTube 限流解除后再做真实视频验证。

本次不是删除研究成果，也不是回滚 Git 历史。主线采用前向 provider switch，实验分支保留当前完整实现。

## 二、冻结基线与恢复入口

- 主线安全快照：`7e15275 Snapshot UI and transcript work before provider split`
- 主线目录：`/Users/wangchao/Documents/youtube-digest`
- 新实验分支：`codex/transcript-source-comparison-v2`
- 新实验工作树：`/Users/wangchao/Documents/youtube-digest-transcript-source-comparison-v2`
- 新实验工作树从 `7e15275` 创建，包含当前完整的页面字幕提取、tab bridge、429 分类和 UI 快照。
- 旧实验分支：`codex/transcript-source-comparison`
- 旧实验工作树：`/Users/wangchao/Documents/youtube-digest/.playwright-mcp/worktrees/transcript-source-comparison`
- 旧实验工作树含未跟踪 `experiments/`，本次严禁修改、清理、stash、移动或覆盖。

快照基线已经完成离线验证：`npm test` 236/236 通过，`npm run check` 通过，发布检查为 29 个 allowlisted 文件。

## 三、授权边界

允许：

- 仅在主线目录修改项目文件。
- 删除主线专属的本地 YouTube 字幕 adapter 及其主线测试，因为实验分支已经保留。
- 新增或调整主线 Supadata provider、错误分类、缓存策略和离线测试。
- 运行本地、stubbed、无网络的测试、检查和打包命令。

禁止：

- 不访问真实 YouTube、`youtubei`、`timedtext` 或 Supadata 网络接口。
- 不操作 Chrome，不做真实视频验收。
- 不读取或输出 API Key、Token、Cookie、signed caption URL。
- 不修改新旧字幕实验工作树。
- 不使用 `git reset --hard`、`git clean`、`git checkout --`、`stash -a`。
- 不提交 Git，不 push，不建 PR，不发布 Release。
- 不回滚或覆盖 UI、品牌资产、Bilibili、笔记、备份和双扩展共存改动。

## 四、主线产品语义

### 4.1 YouTube 字幕来源

- 对新的或过期的 YouTube 缓存，Supadata 是主线唯一字幕正文来源。
- 请求必须保持 `mode=native`，只获取 YouTube 已存在字幕，不执行音频 ASR。
- 发送给 Supadata 的只能是规范化 YouTube watch URL；不得包含 playlist、timestamp、referral 或其他浏览参数。
- 主线不再请求 YouTube `youtubei/v1/player` 或 `/api/timedtext`。
- 主线不再加载或打包 `youtube-transcript.js`。

### 4.2 用户授权

- Supadata Key 本身不等于持续授权。
- 缓存未命中时，侧栏先显示清楚的单次授权提示；只有严格的 `supadataConsent === true` 才能发起本次 Supadata 请求。
- 文案必须说明会发送标准 YouTube 链接，并可能消耗 Supadata API 额度。
- 拒绝后不得自动重试、不得显示“继续读取 YouTube 原生字幕”、不得静默调用其他字幕来源。
- 缓存命中时不重复提示、不访问 Supadata。
- Bilibili 不需要 Supadata，设置页中的 Supadata Key 对整个扩展仍可为空，但应明确“新的 YouTube 字幕需要配置并逐次授权”。

### 4.3 页面安全门

- 保留只读、无网络的 YouTube 页面身份与 playability 检查，用于：
  - 绑定当前 `tabId + videoId`；
  - 阻止 SPA 导航后把旧视频发给 Supadata；
  - 对明确的登录、年龄、成员、地区、不可用状态返回终态错误，不调用 Supadata。
- 页面读取不得返回、缓存或记录字幕 signed URL。
- 页面没有可见 captionTracks 不能单独作为禁止 Supadata 的充分证据；由 `mode=native` 的 provider 返回最终无字幕状态。

### 4.4 缓存、笔记与并发

- 将 `RUNTIME_PROTOCOL_VERSION` 从 8 升到 9，侧栏要求值同步。
- 将 `TRANSCRIPT_SOURCE_POLICY_VERSION` 从 3 升到 4，后台和侧栏同步。
- v4 只接受来源明确为 `supadata` 的 YouTube 字幕缓存；旧 `youtube-timedtext` 缓存不得伪装成 API 结果。
- 不删除用户笔记、设置或备份数据。
- 缓存缺失时保存 YouTube 笔记不得静默调用 Supadata，应返回明确提示：先在侧栏授权并生成字幕。
- 后台增加按 `tabId + videoId + preferredLanguage` 的 Supadata single-flight，合并侧栏初始化、按钮广播、页面完成事件和多窗口的同一请求。
- 首个 Supadata 429 后进入有界 cooldown；冷却期间不自动请求。错误文案必须明确是 Supadata 限流，而不是 YouTube 限流。
- 同一次授权只允许一条 provider 请求链；异步 job polling 属于同一授权，不需要再次确认。

## 五、实现范围

### 5.1 `background.js`

- 移除 `importScripts("youtube-transcript.js")`。
- 删除或断开 YouTube tab fetch bridge、本地 adapter 和本地 fallback 调用。
- 将 YouTube router 改为：页面身份/受限检查 → Key 检查 → 严格 consent 检查 → Supadata。
- 保留 Bilibili 独立路由。
- 保留 `pendingUrl || url` 导航校验、异步 job 导航中止和 canonical URL。
- 统一初始请求和 polling 的错误契约：无 Key、401、404/206、429、超时、超限、网络失败、空字幕、页面切换。
- Supadata 初始请求和 polling 必须有明确 timeout、响应体大小上限和安全解析；不得记录 Key 或完整响应正文。
- 增加后台级 single-flight 与 429 cooldown。
- 冷缓存 note save 返回“先在侧栏授权”，不得自动请求 Supadata。

### 5.2 `sidepanel.js` 与 UI 文案

- 缓存未命中时直接显示 Supadata 单次授权，不再先运行本地字幕提取。
- 将“本地失败后的回退”文案改为“本视频将通过 Supadata 获取原生字幕”。
- 删除本地 PAGE/IOS/timedtext 诊断展示和 YouTube 本地限流分支。
- 429 标题和正文明确指向 Supadata。
- 拒绝授权后停留在安全、可理解的无字幕状态，可提供设置入口，但不能提供会立即发请求的原生字幕重试。
- 保留当前 UI 重设计、图标、时间轨、笔记菜单和双扩展共存行为。

### 5.3 `options.*`、文档与政策

- 更新英文/中文设置文案：Supadata 对整个扩展仍是可选配置，但新的 YouTube 字幕依赖它并逐次授权。
- 更新 `README.md`、`README.zh-CN.md`、`PRIVACY.md`、`SECURITY.md`：删除主线 local-first、tab bridge、timedtext 和本地限流承诺；保留 canonical URL、逐次授权、`mode=native`、无音频 ASR、Bilibili 本地字幕边界。
- 不改已经确认的 UI 设计文档内容，除非修正与实际实现直接冲突的状态表述。

### 5.4 主线文件和发布面

- 从主线删除 `youtube-transcript.js`。
- 从 `scripts/check-release.sh` 和发布测试中删除该文件的必需项。
- 删除或替换 `tests/youtube-transcript-adapter.test.js`。
- 将 `tests/youtube-local-first.test.js` 改造成 API-primary 契约测试，文件名可以按真实语义重命名。
- 更新所有静态协议、缓存版本和来源标签断言。

## 六、必须覆盖的离线测试

至少覆盖：

1. 缓存命中：零 Supadata 调用、零确认。
2. 新视频无 Key：零网络，提示配置。
3. 有 Key 无 consent：零网络，显示单次授权。
4. 严格布尔 consent：只有 `true` 可授权。
5. consent 后恰好一次 Supadata 请求，canonical URL 与 `mode=native` 正确。
6. 同一视频的初始化、按钮广播、页面 complete 和多窗口请求被后台 single-flight 合并。
7. 页面或 pendingUrl 切换时，不开始或不接受旧视频结果。
8. 明确 LOGIN/AGE/UNPLAYABLE 状态零 Supadata 调用。
9. 401、404/206、429、timeout、response-too-large、network、empty transcript 有稳定且 provider-specific 的错误。
10. 429 cooldown 期间网络调用数保持不变。
11. 异步 202 job 在同一次授权中完成；页面切换时停止；polling 401/429/timeout 正确传播。
12. v4 不接受 `youtube-timedtext` 缓存；允许符合策略的 Supadata 缓存。
13. cache-miss note save 不调用 Supadata，并提示先打开侧栏授权。
14. Bilibili 路径完全不读取 Supadata 设置、不显示 consent。
15. UI、设置导航、双扩展共存、备份与笔记测试继续通过。

## 七、执行与交付

执行完成后必须运行：

```text
npm test
npm run check
npm run package
git diff --check
```

不得运行真实 YouTube 或 Supadata 请求。不得提交 Git。

交付给复核者：

- 修改文件清单与核心行为摘要；
- 四项门禁的真实结果；
- 删除/保留的字幕来源说明；
- 仍需等限流解除后验证的真实 Chrome 项目；
- 任何未解决问题或无法满足的验收项。

## 八、复核标准

复核者重点检查：

- 主线是否真正没有 YouTube 字幕网络请求；
- Supadata 是否只能经单次明确授权；
- 自动重入是否被后台 single-flight/cooldown 约束；
- note save、受限视频、导航切换是否零静默第三方调用；
- UI 与 Bilibili 是否保持当前快照行为；
- 文档、隐私说明、测试和发布包是否与 API-primary 事实一致。
