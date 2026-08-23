# DigestDock 可恢复补译与导出调整执行方案

状态：2026-08-23 已按本文件实施；自动门与 Opus 4.8 Max 复审通过，Chrome 页面入口与侧栏打开动作已复核

本地基线：`76d660e Checkpoint DigestDock UI, providers, and exports`

目标范围：笔记 Markdown 导出、字幕 TXT 下载、视频级翻译复用、旧资料回填、长视频分轮补译、取消与恢复、相关测试和文档。

边界：不使用真实 API Key，不发真实 Provider 或 Supadata 请求，不改变版本号，不推送 GitHub，不发布。

## 1. 问题与根因

当前产品分别保存单条笔记中文、视频标题中文、页面渐进字幕中文和导出来源资料。后加的阅读导出要求每个视频同时包含标题、频道、网址、简介、完整字幕和笔记。当前实现把所有未翻译单元一次性规划，并以 240 单元、80 批和 100 次保守模型调用作为整个任务的硬上限。长视频因此只有“全部一次完成”或“完全禁用”两种结果。

这不是网页资料获取问题。当前页面和字幕下载已经拥有原始标题、频道、网址、简介与完整原始字幕；真正缺少的是统一、持久、可验证和可恢复的中文翻译状态。

## 2. 已证实的 P0 风险

1. **批次结果写盘过晚**：当前在所有 source batch 完成后才写入。取消、超时、面板关闭或中途失败会丢掉已付费结果并在重试时重复计费。
2. **持久翻译没有回灌当前视频**：当前字幕与当前视频导出主要读取内存和 digest；再次打开视频时，`ytd_note_sources` 中已有译文不能成为首选来源。
3. **字幕仅按取整时间对齐**：`.1s` 与 `.9s` 会同时变成 `0`。相同起点、分段变化或字幕更新可能错配旧译文并被误判完整。
4. **没有原文指纹**：原字幕文本发生变化后，同时间码的旧译文仍可能被复用。
5. **来源表并发写会丢记录**：多个 `writeNoteSource()` 同时读取旧 map，后写者可能覆盖先写者。
6. **导航后晚响应污染**：补译任务没有绑定媒体身份与 route generation。A → B 或 A → B → A 时，旧响应可能更新新页面或触发错误导出。

以上六项全部解决前，不把本功能标记为完成。

## 3. 最终产品行为

### 3.1 原文导出

- 标题、频道、网址、简介和完整原字幕直接复用当前页面、本地 digest 或 `ytd_note_sources_v2`。
- 不调用 Supadata，不调用 AI Provider。
- 当前视频资料存在时立即导出。

### 3.2 中文与双语导出

预检分开显示已经完成的笔记、标题、简介和字幕段，尚需补齐的简介块、字幕段、标题和笔记，以及缺少原始资料而无法补译的历史视频。

示例文案：

> 3 条笔记均已翻译。还需补齐 1 个简介和 395 段字幕，共约 99 批。本轮最多执行 20 批；每批完成后立即保存，可暂停并在下次继续。

按钮：

- 初次：`开始补齐（本轮最多 20 批）`
- 已有进度：`继续补齐（已完成 80 / 396）`
- 运行中：`取消后续批次`
- 原文备用：`改为导出原文`
- 全部完成：自动生成当前语言模式文件

### 3.3 长视频安全边界

- 总任务可以超过 240 个单元或 80 批，不再因此永久禁用。
- 每轮最多启动 20 个任务批次。
- 每轮保守模型请求上限为 100 次；笔记/标题内部恢复仍计入保守上限。
- 每一轮都需要明确用户点击；保存的 Key 不构成自动继续授权。
- 取消只停止后续批次；已发送的当前批次若仍匹配冻结 source revision，可以写入持久复用缓存，但不得更新当前页面、继续下一批或自动导出。
- 已完成批次永久保留，下次只规划缺失单元。

## 4. 单一视频资料真源

以新键 `ytd_note_sources_v2.records[mediaKey]` 作为阅读导出的持久资料真源。旧 `ytd_note_sources` 只读惰性迁移，避免旧版或未来 schema 被当前代码降级覆盖。当前页面、digest 和旧笔记只负责无网络回填。

资料优先级：

1. 当前打开页面的实时标题、频道、网址、简介和完整字幕。
2. `ytd_note_sources_v2` 已持久化的原文与中文资料。
3. 有效 `digest_<mediaKey>` 缓存中的原字幕和段落翻译。
4. 笔记自身的标题、频道、网址与双语正文。
5. 无法恢复的字段明确标记缺失；不静默联网。

当前视频打开后，必须先合并持久来源资料，再用页面更新资料升级；不能用空中文字段覆盖已有中文。

## 5. 数据结构调整

新增 `ytd_note_sources_v2` library schema 2；旧 `ytd_note_sources` 保持只读迁移。现有 schema 3 JSON 备份继续只包含笔记，不把完整字幕、简介或任务状态塞入备份。

```js
{
  librarySchemaVersion: 2,
  records: {
   [mediaKey]: {
  schemaVersion: 2,
  mediaKey,
  platform,
  canonicalUrl,
  titleOriginal,
  titleZh,
  channelName,
  descriptionState: "unknown" | "confirmed-empty" | "present",
  descriptionOriginal,
  descriptionZh,
  descriptionZhChunks: [
    { index, sourceHash, textZh, translationVersion }
  ],
  sourceLanguage,
  transcriptState: "missing" | "complete" | "truncated",
  transcriptExpectedCount,
  transcriptOriginal: [
    { segmentId, start, text, sourceHash }
  ],
  transcriptZh: [
    { segmentId, start, sourceHash, text, translationVersion }
  ],
  revision,
  updatedAt
   }
  },
  migration: { state, cursor, updatedAt, errors }
}
```

### 5.1 字幕身份

字幕译文不得再只按 `Math.floor(start)` 匹配。稳定身份为：

```text
mediaKey + segmentId + exact start milliseconds + normalized sourceHash
```

- 当前语义分段已有 `segment.id` 时保留。
- 旧资料没有 `segmentId` 时，按原顺序、精确起点和原文指纹生成稳定 legacy id。
- 原文变化只使对应段译文失效；其他段继续复用。
- 同起点的多段字幕保持独立。

### 5.2 简介分块

- 简介按最多 3000 字符的自然边界分块。
- 每个块独立保存 `sourceHash + textZh`。
- 部分完成时保留已完成块。
- 所有当前指纹块齐全后再组装 `descriptionZh`。
- 简介原文变化时只保留仍能指纹匹配的块。

### 5.3 迁移

- schema 1 的 `transcriptZh` 在能与当前原文唯一对应时，补写 `segmentId` 和 `sourceHash`，不重新翻译。
- 同起点存在歧义时失败关闭，只把歧义段视为待补译。
- 旧 digest 的 `paragraphCache` 已包含文本指纹；可匹配译文直接迁移。
- digest 回填的原文与中文必须来自同一次 `groupTranscriptEntries()`，禁止 raw caption 原文与 semantic 中文混用。
- 当前视频迁移和来源补建成功前，不得先淘汰对应 digest。
- 不在安装或设置页批量迁移全部数据；只在当前视频加载、导出预检或来源读取时惰性迁移。
- 未知/未来来源 schema 失败关闭，不能 normalize 成当前 schema 后覆盖。

## 6. 可恢复补译状态机

另存轻量任务键 `ytd_note_export_jobs_v1`。任务只保存冻结意图、稳定 unit key、轮次、游标、Provider 快照和错误；正文与译文仍只存在来源资料/笔记真源中，避免双份重数据。

```js
{
  jobId,
  state,
  intent: { scope, mediaKeys, mode, format, autoExport },
  sourceRevisions,
  notesRevision,
  orderedUnitKeys,
  completedUnitKeys,
  currentBatch: { batchId, unitKeys, leaseUntil },
  cursor,
  roundBudget: { maxBatches: 20 },
  providerSnapshot,
  exportClaim,
  lastError,
  updatedAt
}
```

进度真实性仍由 schema 2 的原文指纹和已验证翻译推导；任务记录不能让已经失效的译文重新变有效。

```text
idle → planned → running → paused → running → complete → exported
                    ↘ cancelled
                    ↘ failed
```

- `planned`：只读计算缺口与批次，不联网。
- `running`：用户明确点击后执行本轮。
- `paused`：达到 20 批、页面关闭或出现可恢复错误。
- `cancelled`：停止后续批次；已经发送的当前批次若返回有效结果，仍原子写入可复用缓存，但不得自动继续或导出。
- `failed`：显示 Provider 错误及恢复动作；已完成批次保留。
- `complete`：重新预检为零缺口后自动导出。

每个运行任务绑定：

```text
scopeFingerprint + mediaKeys + mode + routeKey + digestGeneration + exportGeneration
```

任一绑定发生变化，任务停止，不导出、不把晚响应写入当前页面。

## 7. 分轮执行算法

1. 读取最新 notes、note sources、当前页面与 digest。
2. 无网络合并并持久化当前视频原始资料。
3. 用原文指纹移除已经完成的标题、笔记、简介块和字幕段。
4. 生成稳定 unit id，而不是每次重排的 `u0/u1`。
5. 构造最多 4 个文本、总字符不超过 12000 的字幕/简介批次。
6. 从完整计划中截取本轮最多 20 批。
7. 每批返回后先校验任务绑定与取消 generation。
8. 每个有效批次由 background 单飞并立即原子写入 `ytd_note_sources_v2`，同时推进 job cursor；笔记/标题沿用 background 串行队列。
9. 每批写入后更新进度，不等待整轮结束。
10. 本轮结束后重新从持久资料构造计划，不能靠内存递减猜测。
11. 若仍有缺口，显示继续按钮；若缺口为零，自动导出。

## 8. 并发与写入安全

- `note-sources.js` 为每个 storage adapter 建立串行写队列。
- `writeNoteSource()`、`removeNoteSources()` 和迁移写回走同一队列。
- 每次排到队列头后重新读取最新 map，再 merge 和 set。
- 不把整轮开始时的旧 map 在结束时整表覆盖。
- 当前视频内存缓存只在持久写成功后更新。
- 多次点击同一导出操作使用 single-flight；不同 scope 仍由全局补译锁串行。
- 超过每来源或总存储上限时返回明确 `SOURCE_TOO_LARGE` / `SOURCE_STORAGE_FULL`；禁止裁成前缀后仍声称完整。
- 淘汰只允许作用于没有任何笔记引用的 orphan source；所有 `ytd_notes` mediaKey 自动受保护。

## 9. 文件级调整

### `note-sources.js`

- schema 2 正规化与 schema 1 惰性迁移。
- 稳定原文指纹、segment identity 与简介分块。
- hash-aware 缺口计算和翻译计划。
- `takeExportTranslationRound(plan, limits)`。
- 单 batch 应用与立即持久化。
- storage 写队列与并发测试。

### `sidepanel.js`

- 当前视频先从 `ytd_note_sources_v2` 回灌，再合并页面/digest。
- 字幕页、字幕下载和笔记导出共用同一来源翻译。
- `runConfirmedExportTranslationRound()` 取代一次性全量执行。
- 绑定 route/digest/export generation，阻止跨视频晚响应。
- 每批写盘、实时进度、暂停/继续、取消和自动导出。
- total-over-limit 禁用文案改为单轮说明。
- 最终导出使用 job 冻结的 scope、mediaKeys、mode、format 和 source revision，不递归读取当前全局视频状态。

### `background.js`

- 沿用 Provider Adapter、翻译批次校验和一次 JSON 恢复。
- 不新增自动 Provider fallback。
- 不返回或记录 API Key。
- 增加 source batch single-flight 与“翻译成功后立即提交来源+任务 checkpoint”的后台动作。

### `sidepanel.html` / `sidepanel.css`

- 预检区增加完成/总量、当前轮次、继续与原文导出动作。
- 保持冷灰白、蓝青状态和无障碍状态播报。

### 文档

- `DESIGN.md`
- `UI-REPLACEMENT-PLAN.md`
- `README.md` / `README.zh-CN.md`
- `PRIVACY.md` / `SECURITY.md`

## 10. 测试矩阵

### 10.1 纯逻辑

- `.1s` / `.9s` 同秒字幕不会合并或假完成。
- 同起点不同 segment id 独立匹配。
- 原文变化只使对应译文失效。
- legacy 无 hash 译文在唯一对应时迁移且零 Provider 请求。
- 简介 3 块完成 1 块后，重建计划只剩 2 块。
- 395 段字幕可规划约 99 批，不因 total limit 禁用。
- 单轮只返回前 20 批，第二轮从已持久化结果继续。
- 已完成单元永不重新进入计划。

### 10.2 写入与取消

- 两个并发来源写入不会丢任一 mediaKey。
- 每批完成立即落盘；第 7 批失败时前 6 批仍存在。
- 取消后不启动第 N+1 批。
- 取消期间返回且仍匹配冻结 revision 的当前有效响应可以写入可复用缓存，但后续零调用、零自动下载；跨媒体或 revision 已变化的晚响应零写入。
- 页面 A → B、A → B → A 时旧响应不污染当前状态或触发导出。
- 面板关闭/重新打开后从持久进度恢复。

### 10.3 导出

- 已翻译笔记不重新调用 Provider。
- 字幕页翻译可被笔记导出复用。
- 笔记导出补译可被字幕下载复用。
- 简介与字幕齐全后中文/双语自动下载。
- 原文导出始终零 Provider 请求。
- 历史视频缺少原字幕时提示重新打开一次，不静默调用 Supadata。
- 缺简介 `unknown` 阻断完整导出；网页明确无简介时 `confirmed-empty` 可导出占位。
- 超过旧 1.5 MiB 限制时完整保存或明确失败，绝不 `truncated + complete`。

### 10.4 自动门

```bash
npm test
npm run check
npm run package
node --check note-sources.js
node --check sidepanel.js
node --check background.js
git diff --check
```

### 10.5 浏览器验收

1. 当前英文视频构造超过 240 个缺口，按钮仍可启动本轮。
2. 完成若干批后取消，刷新/关闭侧栏再打开，完成数不回退。
3. 继续若干轮后自动导出双语 TXT/Markdown。
4. 已翻译笔记不出现在缺口文案中。
5. 切换到另一个视频时旧任务停止，不自动下载。
6. 设置页与页面入口无回归。

真实 Provider 调用仍需用户当次明确授权；自动验收使用完全模拟的 Provider 响应。

## 11. 实施顺序

1. 冻结当前本地 Git 基线。
2. 增加失败复现测试：时间碰撞、旧译污染、并发丢写、批次中断丢进度。
3. 实施 schema 2、指纹和串行写队列。
4. 实施单 batch 应用与每批持久化。
5. 实施每轮 20 批的状态机和 UI。
6. 接入当前视频来源回灌与跨导航失效。
7. 更新文档和发布检查。
8. Codex 完整测试与浏览器验收。
9. Claude Opus 4.8 Max 只读复审。
10. 修复复审阻断项并重跑全部验收。
11. 创建最终本地 Git 提交，不同步 GitHub。

## 12. 完成定义

只有同时满足以下条件才可报告完成：

1. 长视频不再因总量上限永久禁用。
2. 已完成笔记、标题、简介块和字幕段不会重复翻译。
3. 每批有效结果立即持久化，刷新或失败不丢进度。
4. 同起点、字幕变化、跨视频导航和并发写入专项测试通过。
5. 字幕下载与笔记导出共享同一视频级翻译资料。
6. 原文导出零网络；中文/双语只在明确点击后调用当前 Provider。
7. 全量测试、发布检查、打包、语法和 diff 检查通过。
8. 浏览器验收无阻断项。
9. Opus 4.8 Max 复审无未处理阻断项。
10. 最终结果已做本地 Git 提交，未 push、未发布。

## 13. 本地实施记录（2026-08-23）

- 已新增 `ytd_note_sources_v2` schema 2、旧来源惰性迁移、精确毫秒/段落身份/原文指纹、标题原文指纹与简介分块。
- 已新增 `ytd_note_export_jobs_v1`，并将 job/source 的运行期写入统一到 background realm。
- 已接通每轮最多 20 批、逐批立即持久化、暂停/继续、真实取消、关闭后恢复和“改为导出原文”。
- 字幕导出只补字幕，不为不进入 TXT 的视频简介产生额外调用；笔记阅读导出仍按需要补标题、简介、字幕和笔记。
- 笔记/标题导出使用 job-aware 后台动作，在真正 Provider 请求前复核冻结 Provider、模型、笔记版本和视频来源版本。
- 最终自动下载会重新读取本地真源、复核冻结范围和零缺口，以原子 `exportClaim` 防并发重复，下载成功后任务进入 `completed`。
- 清空全部笔记或重置前先对来源库和任务库做只读预检；未来 schema、并发清理或晚响应均失败关闭，不能部分删除或复活资料。
- 导出任务库达到 32 条时只淘汰最旧的 `completed/stale` 历史；仍可恢复的任务全部受保护，若没有安全可淘汰项则失败关闭。
- 自动测试使用完全模拟的 Provider；没有读取真实 Key，也没有发送真实 Provider/Supadata 请求。
- Claude Opus 4.8 Max 完整复审与聚焦复审均为 PASS、无 P0/P1；其任务容量、超大旧库迁移保护、YouTube 简介状态和无效状态分支建议均已修复并补测。
- Chrome 已确认相同扩展 ID 的 YouTube 页面入口、侧栏打开动作与页面零错误；浏览器自动化截图不包含 Chrome 原生侧栏区域，因此不把这项证据表述为完整视觉用户验收。
- 本节只记录本地实现与工程验收状态，不代表已发布、已同步 GitHub 或已经用户最终验收。
