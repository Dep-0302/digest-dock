# DigestDock UI 替换执行方案

状态：规划完成，尚未开始替换 UI。
设计真源：[DESIGN.md](DESIGN.md)。
视觉证据：[docs/design/final-design-board.jpg](docs/design/final-design-board.jpg)。

## 目标

在不改变字幕、AI、笔记、备份和存储逻辑的前提下，将当前页面入口、侧栏和设置页替换为已确认的 DigestDock UI。

本方案不授权推送、合并、发布或创建 Release；这些动作需要单独授权。

## Gate 0：确定实施基线

当前 `main` 相对 `upstream/main` ahead 20，并存在多项未提交修改。UI 实施前必须再次读取实时状态，不能自动 stash、覆盖或把现有修改当作本次 UI 工作。

开始编码前需要完成：

1. 列出当前修改、所属功能与是否应成为 UI 实施基线。
2. 由用户确认使用当前工作树，或先把既有工作整理成可追踪基线。
3. 推荐在 `codex/ui-redesign-v1` 隔离分支／工作树中实施；不得丢失当前未提交内容。
4. 记录实施前 manifest 版本、测试数和 Chrome 实际加载路径。

Gate 0 未确认时，只能继续分析，不能批量修改 UI 文件。

## Phase 1：设计资产与基础 Token

### 变更

- 将 `icons/icon16-solid.png`、`icon48-solid.png`、`icon128-solid.png` 替换为 manifest 正式引用的 `icon16.png`、`icon48.png`、`icon128.png`。
- 保留 `icons/digestdock-icon-solid.svg` 作为矢量真源。
- 增加本地字体目录与 Barlow Condensed Regular/Medium WOFF2、OFL 许可证。
- 在 `sidepanel.css` 与 `options.css` 建立一致的颜色、圆角、间距、字体、时间码和投影 Token。

### 验证

- PNG 尺寸、透明圆角、manifest 路径正确。
- 字体只从扩展包加载，不产生外部字体请求。
- 发布 allowlist 与包体积检查更新。

## Phase 2：YouTube 与 B 站页面入口

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

## Phase 3：侧栏框架、顶部与主导航

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

## Phase 4：字幕卡与播放跟随

### 主要文件

- `sidepanel.js`
- `sidepanel.css`
- `tests/translation.test.js`
- 建议新增时间码格式与卡片状态测试。

### 实施要点

- 每个字幕组渲染成独立卡片，间距 `8px`。
- 正文只承担选择文本；时间码承担跳转。
- 移除整行蓝色选择样式和点击指针暗示。
- 当前播放卡右移 `6px`，暖底色、左侧珊瑚竖线、中性投影。
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

## Phase 5：概览与关键语句

### 主要文件

- `sidepanel.js`
- `sidepanel.css`
- 概览相关测试。

### 实施要点

- 章节使用与字幕相同的独立卡片和时间栏。
- 选中章节使用 6px 缩进、暖底、左竖线和投影。
- 关键语句使用普通细边卡，不再依赖粗彩色侧边。
- 保存笔记、复制和跳转按钮保持图标化。

### 验证

- 章节选择与视频跳转状态同步。
- 长视频章节时间不截断。
- 原文／中文／双语切换不破坏卡片高度与选择态。

## Phase 6：笔记页

### 主要文件

- `sidepanel.js`
- `sidepanel.css`
- 笔记与备份相关测试。

### 实施要点

- 保持连续列表，而非字幕式浮动卡片。
- 重新排列时间、视频名、正文和动作层级。
- 播放为珊瑚主操作；复制与链接为中性动作；删除进入更多菜单。
- 保留当前视频／全部笔记筛选以及语言模式。

### 验证

- 当前视频与跨视频笔记标题都能正确截断。
- 复制文字、复制链接、播放、删除与语言生成状态不回归。
- 100 条上限、空状态和加载状态可读。

## Phase 7：设置页重构

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
- 将备份、本地数据、本地改造、隐私说明放入对应分区。
- 危险操作集中在“本地数据”，保持明确确认。
- 保存栏固定在内容底部并报告未保存／保存成功／保存失败状态。

### 验证

- 760、1024、1440px 宽度；200% 浏览器缩放。
- 中文与英文文案不会溢出。
- API Key 显示／隐藏、保存、导入／导出、清理和重置行为不回归。
- 不读取、不记录、不截图任何真实 API Key。

## Phase 8：状态、响应式与无障碍

覆盖：

- 初次使用、空字幕、无概览、无笔记。
- 加载、翻译中、重试、错误、Supadata 确认。
- disabled、focus-visible、hover、pressed、success。
- `prefers-reduced-motion`、`prefers-reduced-transparency`、`prefers-contrast`。
- 键盘导航、屏幕阅读名称、点击热区与颜色对比。

本阶段不得新加功能，只补齐现有功能的设计状态。

## Phase 9：测试、真实页面验收与打包

按项目门槛执行：

```bash
npm test
npm run check
npm run package
git diff --check
```

还需完成：

1. YouTube 普通视频、长视频和可选字幕回退路径。
2. B 站标准 BV 视频、长视频或长分 P。
3. 侧栏字幕／概览／笔记逐页截图对照设计稿。
4. 设置页宽屏与窄屏截图对照。
5. Chrome 重新加载扩展后验证 16px 图标和页面按钮。
6. 记录“测试通过”与“用户验收”为两个独立结果。

没有真实页面证据时，不得写“端到端已验证”。

## 文件变更矩阵

| 区域 | 预期文件 |
| --- | --- |
| 图标与 manifest | `icons/*`、`manifest.json` |
| 页面入口 | `content.js`、`content-bilibili.js` |
| 侧栏结构与样式 | `sidepanel.html`、`sidepanel.css`、`sidepanel.js` |
| 设置页 | `options.html`、`options.css`、`options.js` |
| 字体与许可 | 新增 `fonts/*` 与许可证 |
| 测试 | `tests/digest-button.test.js`、`tests/bilibili-content.test.js`、`tests/settings.test.js`、`tests/options-language.test.js`、`tests/notes-backup.test.js` 及新增 UI 规则测试 |
| 发布检查 | `scripts/check-release.sh`、`tests/release.test.js`（如 allowlist 需要） |
| 文档 | 必要时更新 README、PRIVACY、SECURITY 中与界面操作相关的说明；不得扩大事实范围 |

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
