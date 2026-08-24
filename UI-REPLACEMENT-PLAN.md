# DigestDock UI 替换执行方案

状态：2026-08-23 已在当前未提交工作树完成主体替换和功能扩展；自动测试已通过，真实扩展浏览器验收与用户验收仍需单独记录。
设计真源：[DESIGN.md](DESIGN.md)。
视觉证据：[docs/design/final-design-board.jpg](docs/design/final-design-board.jpg)。

## 目标

将页面入口、侧栏和设置页替换为已确认的 DigestDock UI，并完成本轮已经确认的产品扩展：平台语言矩阵、笔记标题多语言、按视频来源分组、笔记／字幕导出、多 AI Provider 预设、Key Map 与官网本地图标。

本方案不授权推送、合并、发布或创建 Release；这些动作需要单独授权。

## Gate 0：确定实施基线（已完成）

当前 `main` 相对 `upstream/main` ahead 20，并存在多项未提交修改。UI 实施前必须再次读取实时状态，不能自动 stash、覆盖或把现有修改当作本次 UI 工作。

开始编码前需要完成：

1. 列出当前修改、所属功能与是否应成为 UI 实施基线。
2. 由用户确认使用当前工作树，或先把既有工作整理成可追踪基线。
3. 推荐在 `codex/ui-redesign-v1` 隔离分支／工作树中实施；不得丢失当前未提交内容。
4. 记录实施前 manifest 版本、测试数和 Chrome 实际加载路径。

当前实现直接保留在既有未提交工作树中；未执行 stash、reset、提交、推送、发布或版本号修改。

## Phase 1：设计资产与基础 Token（已实现）

### 变更

- 将 `icons/icon16-solid.png`、`icon48-solid.png`、`icon128-solid.png` 替换为 manifest 正式引用的 `icon16.png`、`icon48.png`、`icon128.png`。
- 保留 `icons/digestdock-icon-solid.svg` 作为矢量真源。
- 增加本地字体目录与 Barlow Condensed Regular/Medium WOFF2、OFL 许可证。
- 在 `sidepanel.css` 与 `options.css` 建立一致的颜色、圆角、间距、字体、时间码和投影 Token。

### 验证

- PNG 尺寸、透明圆角、manifest 路径正确。
- 字体只从扩展包加载，不产生外部字体请求。
- 发布 allowlist 与包体积检查更新。

## Phase 2：YouTube 与 B 站页面入口（已实现，待真实页面复核）

### 目标

- 页面工具栏：品牌图标按钮，移除 `DigestDock` 长文字。
- 播放器悬浮：`bookmark-plus` 笔记按钮，移除 `DigestDock 笔记` 长文字。

### 主要文件

- `content.js`
- `content-bilibili.js`
- `manifest.json`
- `tests/digest-button.test.js`
- `tests/bilibili-content.test.js`

### 实施要点

- 使用一致的 SVG 图标库或项目内图标组件，不使用 emoji。
- 保留当前按扩展 ID 隔离 DOM 的共存逻辑。
- 保留 `aria-label`、title/tooltip、键盘 `N` 和刷新失败提示。
- 视觉按钮约 `36px`，不破坏 YouTube/B 站宿主工具栏布局。

### 验证

- 两个平台真实页面中位置稳定、无重复注入。
- 旧版扩展共存时不互相删除按钮。
- 打开侧栏、保存笔记与错误反馈行为不变。

## Phase 3：侧栏框架、顶部与主导航（已实现，待真实页面复核）

### 主要文件

- `sidepanel.html`
- `sidepanel.css`
- `sidepanel.js`

### 实施要点

- 接入确认后的品牌图标。
- 视频标题、元数据、语言控件和设置按钮形成紧凑顶部区。
- `字幕 / 概览 / 笔记` 使用文字导航与短下划线活动态。
- 删除大面积活动胶囊和重复品牌文字。
- 保持 Chrome 原生标题栏不变。

### 验证

- 320、360、400、480px 宽度无截断。
- 长标题、中文／英文界面和三种语言模式不互相挤压。
- 键盘焦点顺序与视觉顺序一致。

## Phase 4：字幕卡与播放跟随（已实现，待真实页面复核）

### 主要文件

- `sidepanel.js`
- `sidepanel.css`
- `tests/translation.test.js`
- 建议新增时间码格式与卡片状态测试。

### 实施要点

- 每个字幕组渲染成独立卡片，间距 `8px`。
- 正文只承担选择文本；时间码承担跳转。
- 移除整行蓝色选择样式和点击指针暗示。
- 当前播放卡右移 `6px`，冷蓝浅底、左侧蓝青竖线和中性投影。
- 时间栏固定约 `66px`，使用本地 Barlow Condensed 与 tabular numerals。
- 时间格式函数统一处理 `MM:SS` 与 `H:MM:SS`。
- “跟随播放”显示完整时间。

### 验证矩阵

- 10 分钟视频：`00:37`。
- 59 分钟视频：`59:18`。
- 1 小时视频：`1:00:27`。
- 2–3 小时视频：`2:14:48`、`3:02:58`。
- 正文拖选不会触发跳转；点击时间会跳转。
- 自动跟随、用户滚动离开和恢复跟随行为正常。

## Phase 5：概览与关键语句（已实现，待真实页面复核）

### 主要文件

- `sidepanel.js`
- `sidepanel.css`
- 概览相关测试。

### 实施要点

- 章节使用与字幕相同的独立卡片和时间栏。
- 选中章节使用 6px 缩进、冷蓝浅底、蓝青左竖线和投影。
- 关键语句使用普通细边卡，不再依赖粗彩色侧边。
- 保存笔记、复制和跳转按钮保持图标化。

### 验证

- 章节选择与视频跳转状态同步。
- 长视频章节时间不截断。
- 原文／中文／双语切换不破坏卡片高度与选择态。

## Phase 6：笔记、来源分组与可恢复导出（本地工作树已实现，待文件与浏览器验收）

### 主要文件

- `sidepanel.js`
- `sidepanel.css`
- 笔记与备份相关测试。

### 实施要点

- “全部笔记”以稳定 `mediaKey` 分成来源容器；同一视频不再因保存时间或标题变化被拆开。
- 来源容器内只按时间码升序，等时刻以 note id 稳定排序。
- 视频标题、笔记正文与导出统一支持 `原文 / 中文 / 双语`；标题翻译按媒体去重并进入 schema 3 备份。
- 当前视频、所选视频、全部笔记和单个来源容器均可导出 UTF-8 TXT；包含标题、频道、网址、简介和已保存笔记，不附带整部字幕。“全部笔记”支持按来源多选。完整字幕只由字幕页导出 TXT。
- 字幕按钮导出完整 UTF-8 TXT，并使用当前字幕语言模式和语言后缀文件名。
- 中文／双语存在缺口时先做只读预检；固定动作是“补充导出 / 直接导出 / 导出原文 / 放弃导出”。只有补充导出或继续补齐才可调用当前 AI Provider；元数据只读取用户明确打开的视频页，原文和直接导出始终零 AI 请求。
- `ytd_note_sources_v2` 保存按原文指纹校验的视频标题、简介块与字幕段译文；旧 `ytd_note_sources` 只读惰性迁移。再次打开视频或重新导出时先回灌持久资料，只规划真正缺少的单元。
- `ytd_note_export_jobs_v1` 保存轻量恢复状态，不保存 API Key、字幕／笔记正文或译文。导出范围、语言模式、来源版本与 Provider 快照在任务创建时冻结。
- 总任务可超过旧 240 单元／80 批限制；每轮最多启动 20 个任务批次、最多 100 次保守模型请求。每批校验后立即写入来源资料和任务 checkpoint；一轮结束后必须再次点击，不能自动续跑。
- 取消只停止后续批次。已发出的当前批次若仍匹配冻结来源版本可进入持久复用缓存，但不得继续下一批、污染当前页面或自动下载。
- 补译不调用 Supadata，不静默换 Provider；保存 Key 不是持续授权。删除全部笔记或重置数据同时清理来源资料和导出任务。

### 验证

- 当前视频与跨视频笔记标题都能正确截断和切换语言。
- 复制文字、复制链接、播放、删除、来源导出与语言生成状态不回归。
- 笔记 TXT 与字幕 TXT 的内容和文件名分别覆盖原文、中文、双语；中文导出不得以原文冒充。
- 100 条笔记上限、旧备份导入、旧来源惰性迁移、缺失来源资料、长视频分轮补译、暂停／继续、取消和失败状态可读。
- 完成若干批后关闭再打开侧栏，完成数不回退；已验证单元不再次进入翻译计划。

## Phase 7：设置页与多 Provider（主体已实现，腾讯保持安全禁用）

### 主要文件

- `options.html`
- `options.css`
- `options.js`
- `settings.js`
- `notes-backup.js`
- `tests/settings.test.js`
- `tests/options-language.test.js`
- `tests/notes-backup.test.js`

### 实施要点

- 建立左侧分区导航与右侧内容区。
- 服务连接宽屏双列，窄屏单列。
- 保留现有输入框与按钮 ID，或同步更新 JS 与测试；不得只改视觉后破坏事件绑定。
- 最终导航只保留服务连接、笔记与备份、本地数据、隐私说明；删除“字幕服务／字幕回退”和“本地改造”。
- 设置页为 `100vh` 工作区，右侧内容独立滚动，左侧导航与底部保存栏持续可见；点击、滚动与 hash 同步活动态。
- AI 服务使用带官网本地图标的 ARIA combobox/listbox。五个已核实 Provider 可选择；腾讯混元翻译显示第六个图标和“暂不可用”，不可选择或保存为活动 Provider。
- Endpoint、模型和请求差异由 `ai-providers.js` 预设；用户只填写当前 Provider Key。Key Map 分槽保存且不静默回退。
- Supadata 保留在服务连接卡片，仍只用于用户逐视频确认后的 YouTube 原生字幕请求。
- 危险操作集中在“本地数据”，保持明确确认。
- 保存栏固定在内容底部并报告未保存／保存成功／保存失败状态。

### 验证

- 760、1024、1440px 宽度与窄屏；200% 浏览器缩放。
- 中文与英文文案不会溢出。
- Provider 图标、方向键、Home/End、Enter/Space、Escape、焦点返回、Key 切换、保存、导入／导出、清理和重置行为不回归。
- 不读取、不记录、不截图任何真实 API Key。

腾讯混元当前边界：腾讯官方确认 `hunyuan-translation-lite` 和专用翻译 API，也确认通用 OpenAI-compatible Bearer Endpoint；但官方资料尚未确认该翻译模型可通过当前单 Key 的兼容 Endpoint 调用。不得据此猜测模型路由，也不得在没有 SecretId/SecretKey 设计决策时实现 TC3-HMAC 路径。

## Phase 8：状态、响应式与无障碍（代码已实现，待浏览器验收）

覆盖：

- 初次使用、空字幕、无概览、无笔记。
- 加载、翻译中、重试、错误、Supadata 确认。
- disabled、focus-visible、hover、pressed、success。
- `prefers-reduced-motion`、`prefers-reduced-transparency`、`prefers-contrast`。
- 键盘导航、屏幕阅读名称、点击热区与颜色对比。

本阶段只补齐现有功能的设计状态，不再扩展产品范围。

## Phase 9：测试、真实页面验收与打包（自动门通过，浏览器验收进行中）

按项目门槛执行：

```bash
npm test
npm run check
npm run package
git diff --check
```

还需完成：

1. YouTube 英文字幕与中文字幕视频：平台语言矩阵、卡片、时间跳转和三类笔记模式。
2. B 站标准 BV 视频：字幕／概览隐藏语言控件，笔记保留三种模式。
3. 当前视频、所选视频、全部笔记、单个来源 TXT，以及字幕 TXT 的三种语言输出。
4. 构造超过旧 240 单元上限的长视频缺口：首轮最多 20 批，取消后没有下一批或自动下载；关闭再打开后进度不回退，继续时不重复翻译已完成单元。
5. 切换视频或原文版本后，旧任务不得写入当前页面；只有仍匹配冻结来源的在途结果可进入本地缓存。
6. 设置页桌面和窄屏：六个图标、五个可选项、腾讯禁用态、键盘交互、导航活动态、独立滚动和固定保存栏。
7. 断网图标复核；页面不得请求远程品牌图片。
8. Supadata 未授权零请求；阅读导出补译始终零 Supadata 请求，字幕授权路径仍需用户当次确认且只作用于当前 YouTube 视频。
9. Chrome 重新加载扩展后核对扩展 ID、加载路径、版本、错误面板和页面按钮，避免把另一个解压副本当成本工作树。
10. 记录“自动测试通过”“浏览器已验证”“用户验收”为三个独立结果。

没有真实页面证据时，不得写“端到端已验证”。

## 文件变更矩阵

| 区域 | 预期文件 |
| --- | --- |
| 图标与 manifest | `icons/*`、`icons/providers/*`、`manifest.json` |
| 页面入口 | `content.js`、`content-bilibili.js` |
| 侧栏结构、分组与导出 | `sidepanel.html`、`sidepanel.css`、`sidepanel.js`、`note-export.js`、`note-sources.js`、`export-jobs.js` |
| 设置页 | `options.html`、`options.css`、`options.js` |
| 字体与许可 | 新增 `fonts/*` 与许可证 |
| Provider | `ai-providers.js`、`settings.js`、`background.js` |
| 测试 | `tests/digest-button.test.js`、`tests/bilibili-content.test.js`、`tests/settings.test.js`、`tests/options-language.test.js`、`tests/notes-backup.test.js`、`tests/ai-providers.test.js`、`tests/note-export.test.js`、`tests/note-sources.test.js`、`tests/export-jobs.test.js`、`tests/notes-presentation.test.js`、`tests/translation.test.js` |
| 发布检查 | `scripts/check-release.sh`、`tests/release.test.js`（如 allowlist 需要） |
| 文档 | `DESIGN.md`、`UI-REPLACEMENT-PLAN.md`、README、PRIVACY、SECURITY；不得把本地实现写成已发布事实 |

## 提交与回滚建议

若之后获得 Git 授权，建议按以下边界提交，便于单独回滚：

1. 图标、字体与 Token。
2. YouTube/B 站页面入口。
3. 侧栏框架、字幕、概览与笔记。
4. 设置页与响应式。
5. 测试与文档。

每个阶段必须保持可运行；不得把所有 UI 变化压成一个无法定位回归的大提交。

## 实施完成定义

- “已应用”：代码与资产已替换。
- “测试通过”：自动测试和发布检查通过。
- “已验证”：真实 YouTube/B 站路径与设置页检查完成。
- “用户验收”：用户根据最终截图或本地 Chrome 明确确认。
- “已发布”：只有完成单独授权的 push/PR/merge/Release 后才能使用。

以上状态不得互相替代。
