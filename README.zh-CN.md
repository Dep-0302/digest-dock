# DigestDock

[English](README.md) | [简体中文](README.zh-CN.md)

DigestDock 是一个基于 Manifest V3 的 Chrome 扩展，用来把带字幕的媒体整理成结构化学习资料。字幕、双语翻译、AI 概览、内容讲解和时间戳笔记都在内容旁边的同一个侧边栏中完成，不需要在多个工具之间来回切换。

此版本也支持带有人工或 AI 字幕轨的标准 `www.bilibili.com/video/BV...` 页面。扩展只处理当前分P，复用当前浏览器中的 B 站登录会话，但不会读取或保存 Cookie 值；对于中文字幕，概览和润色笔记都直接使用中文生成。

核心流程保持精简：

- 阅读和搜索带时间戳的原始字幕。
- 在原文、简体中文和双语对照视图之间切换。
- 生成按章节组织的概览，查看重点引用，并讲解选中的字幕。
- 从字幕、概览或笔记中的时间戳返回视频对应位置。
- 保存润色后的时间戳笔记，并通过带版本信息的 JSON 备份在设备间迁移。
- 自行提供 API Key，凭据和项目数据保存在本地 Chrome 中，不包含分析统计或行为追踪。

DigestDock 是在 [Zara Zhang 原作 YouTube Digest](https://github.com/zarazhangrui/youtube-digest) 基础上的个人衍生版本。它保留了现有 YouTube 流程，并增加 B 站字幕支持和跨平台笔记备份与恢复。原项目以及 B 站整合阶段参考的公开实现统一列在 [致谢与参考项目](#致谢与参考项目) 中。

扩展通过 GitHub 以本地方式安装，目前没有上架 Chrome 应用商店，不赠送 API 额度，也不依赖开发者运营的后端服务。

## 让你的编程 Agent 帮你安装

复制当前正在阅读的仓库页面 URL，然后把下面这段话发送给你的编程 Agent：

> 请从 `[在这里粘贴当前仓库 URL]` 下载或克隆项目，把它放到我选择的长期保留文件夹，告诉我准确的完整路径，并让 Chrome“加载已解压的扩展程序”使用同一个文件夹。如果我在第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/digest-dock`，或 Windows 上的 `%USERPROFILE%\Documents\digest-dock`，但不要假设我一定使用这些路径。请用清楚的步骤指导我完成安装和配置。

你的 Agent 应该帮你：

1. 先询问你想把项目长期保存在哪里，再下载或克隆到那里，并告诉你准确的完整路径。如果你需要建议，可以推荐 macOS 或 Linux 上的 `~/Documents/digest-dock`，或 Windows 上的 `%USERPROFILE%\Documents\digest-dock`。
2. 打开下方 Supadata 和 DeepSeek 官方页面，指导你创建自己的账号。
3. 指导你在 Chrome 中通过“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹。
4. 告诉你应该在扩展的“设置”页面哪个位置填写 API Key。
5. 打开一个带字幕的 YouTube 视频，确认字幕和翻译功能可以使用。

安装后请让这个文件夹留在原位。如果移动或删除它，Chrome 中加载的本地扩展会失效，需要从新的长期存放位置重新加载。

不要把 API Key 发送到 AI 对话、源代码、截图或公开消息中。请你自己在 DigestDock 的设置页面直接填写。编程 Agent 可以告诉你填写位置，但不需要看到 Key。

## 手动安装

如果手动安装：

1. 在当前正在阅读的仓库页面点击 **Code**，再选择 **Download ZIP**。
2. 选择一个长期保留的文件夹，并把项目解压到这里。可选建议是 macOS 或 Linux 上的 `~/Documents/digest-dock`，或 Windows 上的 `%USERPROFILE%\Documents\digest-dock`。你也可以使用其他文件夹。
3. 在 Chrome 地址栏打开 `chrome://extensions`。
4. 打开右上角的“开发者模式”。
5. 点击“加载已解压的扩展程序”。
6. 选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest.json`。
7. 如果需要，可以在 Chrome 扩展菜单中固定 DigestDock。

这是一个本地加载的扩展，不会自动更新。下载新版或让 Agent 修改代码后，请在 `chrome://extensions` 中找到 DigestDock 并点击“重新加载”，然后刷新已经打开的 YouTube 或 B 站视频页面。如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。

如果要把已有安装从旧的 `youtube-digest` 文件夹迁移到新的 `digest-dock` 文件夹，请先导出笔记备份。Chrome 可能把不同的本地加载路径视为两个扩展，因此本地设置和笔记不一定自动跟随；加载新文件夹后，请重新配置设置并导入备份。

## 设置 API Key

服务访问使用你自己的账号和 Key。YouTube 需要下面两个 Key；如果只使用 B 站，只需要 DeepSeek，不需要 Supadata：

1. **Supadata API Key**，用于获取 YouTube 字幕；只使用 B 站时可不填写。
2. **DeepSeek API Key**，用于生成概览、讲解内容、翻译和自动润色笔记。

### 获取 Supadata API Key

1. 打开 Supadata 官方[注册页面](https://dash.supadata.ai/auth/sign-up)。
2. 创建账号并完成简短的新手引导。
3. Supadata 会在新手引导过程中自动生成 API Key。
4. 之后可以随时打开 [Supadata 控制台](https://dash.supadata.ai/)查找或管理 Key。
5. 复制 Key，并粘贴到 DigestDock 设置中的 **Supadata API key**。

如果页面流程发生变化，请查看 [Supadata 官方文档](https://docs.supadata.ai/)。

### 获取 DeepSeek API Key

1. 打开 DeepSeek 官方 [API Keys 页面](https://platform.deepseek.com/api_keys)。
2. 按照提示登录，或创建 DeepSeek 开放平台账号。
3. 点击 **Create new API key**，填写容易识别的名称，例如 `DigestDock`，然后创建 Key。
4. 立即复制 Key。完整 Key 可能只会显示一次。
5. 把 Key 粘贴到 DigestDock 设置中的 **DeepSeek API key**。
6. 如果 DeepSeek 提示余额不足，请在 DeepSeek 开放平台账号中充值后再试。

当前账号和接口说明请查看 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)。

在侧边栏中打开 **Settings**。你也可以在 `chrome://extensions` 的 DigestDock 卡片中打开扩展选项。Key 只能粘贴到这些设置输入框中。不要把 Key 发送到 AI 对话、项目文件、截图或公开消息中。

发布版本只支持 DeepSeek V4 Flash：

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

DigestDock 会让所有 DeepSeek 请求使用非思考模式，以获得更快、更稳定的交互。设置中的接口地址和模型固定，只需要填写 DeepSeek API Key。如果想使用其他服务或模型，请在设置中复制安全的自定义 prompt，让编程 Agent 修改你自己的本地副本。不要把任何 API Key 放进 prompt 或对话。

API Key 和设置保存在你设备上的 Chrome 扩展本地存储中。发布包不会包含或使用 `config.js`。

## 使用 DigestDock

一次普通的 YouTube 使用流程如下：

1. 打开一个提供原生字幕轨的标准 YouTube 视频页面。
2. 点击 DigestDock 扩展图标，打开侧边栏。
3. 阅读带时间戳的字幕，或选择 **Original**、**中文**、**双语**。
4. 打开 **概览** 查看中文优先的章节总结，并可选择 **原文**、**中文**或**双语**。
5. 选中需要进一步理解的字幕片段，获取针对性讲解。
6. 从播放器或重点引用中保存笔记，之后可以在 **笔记** 中选择 **原文**、**中文**或**双语**查看。

使用 B 站时，打开一个有字幕的标准 BV 视频。每个分P都作为独立学习资料处理。可以点击扩展图标或页面中的“生成摘要”，并通过播放器悬浮按钮保存时间戳笔记。

## 备份和恢复笔记

设置页中的 **笔记备份** 卡片提供带版本信息的 JSON 恢复格式。重装扩展、清理 Chrome 个人资料或把笔记迁移到另一台设备前，建议先导出一份备份。

创建备份：

1. 打开 DigestDock **设置**。
2. 在 **笔记备份** 中点击 **导出笔记备份**。
3. 妥善保存下载的 `digest-dock-notes-YYYY-MM-DD.json` 文件，并确保新设备可以取得该文件。

在另一台设备或另一个 Chrome 个人资料中恢复：

1. 安装或重新加载 DigestDock，然后打开 **设置**。
2. 在 **笔记备份** 中点击 **导入笔记备份**，再选择 JSON 文件。
3. 等待设置页显示导入结果。API Key 和其他设置需要另外配置，不会从此文件恢复。

JSON 文件只包含备份格式信息和已保存的笔记记录，包括其中已存储的原文／英文和简体中文内容，以及恢复笔记所需且经过校验的 YouTube 或 B 站媒体身份与时间戳信息；不包含 API Key、扩展设置、完整字幕或字幕缓存，也不包含概览或摘要缓存。已经保存在单条笔记中的原字幕片段仍属于该笔记记录。导出和导入只会使用下载文件与 Chrome 扩展本地存储，不会把备份发送给 B 站、Supadata、DeepSeek 或其他网络服务。

导入会与设备上已有笔记合并，并自动跳过重复项；如果已有笔记缺少某些已保存内容，导入可以用备份中的内容补全。如果相同笔记 ID 的内容发生冲突，或合并后将超过 100 条笔记上限，整次导入都会被拒绝。无效、不受支持、过大或因其他原因失败的导入，都不会改变设备上原有的笔记。

备份文件是未加密的纯文本 JSON，可能包含个人笔记，请按敏感文件妥善保存和分享。移除扩展或清除扩展本地数据，不会删除之前已经下载的备份文件；不再需要时请另外手动删除。

即使文件名看起来正确，也应把每个导入的 JSON 文件视为不可信输入；只导入来源清楚的备份。DigestDock 会根据经过校验的媒体字段重建时间戳 URL，不会信任备份文件提供的 URL。

改名前导出的备份，包括名为 `youtube-digest-notes-YYYY-MM-DD.json` 的文件，仍然可以导入。DigestDock 会验证 JSON 内容，不会把文件名当作可信依据。

当前 JSON 功能是用于恢复 DigestDock 笔记的备份格式。面向学习工具的 Markdown、CSV、Anki 等导出属于另一类未来功能，当前 JSON 备份并不提供这些格式。

## 当前支持范围

- Chrome 116 或更高版本。
- 标准的 `youtube.com/watch` 视频页面。
- 标准的 `www.bilibili.com/video/BV...` 视频页面，每次只处理当前分P。
- 当前 B 站浏览器会话可以访问的人工或 AI 字幕轨。B 站字幕读取不消耗 Supadata 额度。
- Supadata 返回的一条原生字幕轨。YouTube 能提供默认字幕语言时，扩展会请求该语言并拒绝其他语言的回退结果；无法取得该提示时，才把实际返回的原生字幕轨视为**原文**。
- 原文、简体中文和双语对照字幕。
- AI 概览直接生成简体中文底稿。非中文字幕只有在请求**原文**或**双语**时，才翻译章节标题和总结；重点引用会保留源字幕原句。中文字幕的三种模式复用同一份中文内容，不发起额外翻译。
- 笔记先生成一次润色后的英文，再单独生成一次简体中文；双语笔记只合并两份已保存内容。
- 如果笔记对应的原字幕已经是中文，则直接复用原字幕作为中文笔记，不再发送中文翻译请求。
- 对 B 站中文字幕，概览和润色笔记各只进行一次中文 AI 请求，不经过“中文→英文→中文”。
- 本地笔记、带版本信息的 JSON 笔记备份与恢复，以及最近字幕、概览和翻译的本地缓存。
- 发布版本的所有 AI 功能都使用 DeepSeek V4 Flash。其他服务需要修改本地代码，不属于发布版本的支持范围。

Shorts、直播、B 站番剧页、私密或受访问限制的视频、画面硬字幕，以及没有原生字幕轨的视频可能无法使用。目前没有测试 Firefox、Safari、移动浏览器或其他 Chromium 浏览器。

YouTube 路径强制使用 Supadata 的 `mode=native`。两个平台都不会在没有原生字幕时请求生成式转录，也不会在本地转录音频或使用 OCR。

## Supadata 免费额度和请求成本

截至 2026 年 8 月 9 日，[Supadata 价格页面](https://supadata.ai/pricing)显示免费版每月提供 **100 credits**，不需要信用卡，未使用的额度不会结转。价格可能变化，使用前请查看最新页面。

[Supadata 字幕接口文档](https://docs.supadata.ai/get-transcript)说明了不同模式的计费方式：

- 获取一次原生字幕消耗 **1 credit**，与视频时长无关。
- AI 生成字幕每分钟消耗 **2 credits**。DigestDock 不会使用这条路径，因为它强制使用 `mode=native`。
- 如果没有可用原生字幕并返回 HTTP `206`，仍会消耗 **1 credit**。

按照当前只获取原生字幕的方式，如果每次请求都成功，免费版每月大约可以查询 100 个视频。重试和没有字幕的查询也会消耗额度，所以实际成功数量可能更少。

DeepSeek 的额度与 Supadata 分开计算。DeepSeek 可能有自己的免费额度、限速或费用。DigestDock 不收款，也不转售 API 服务。建议为两个账号设置消费上限并定期查看用量。下方估算说明了当前 DeepSeek 翻译成本。

## DeepSeek V4 Flash 翻译成本估算

截至 2026 年 8 月 10 日，DeepSeek 官方[价格页面](https://api-docs.deepseek.com/quick_start/pricing/)列出的每 100 万 token 价格是：

- 缓存命中输入：**¥0.02**。
- 缓存未命中输入：**¥1**。
- 输出：**¥2**。

DeepSeek 说明这些价格可能很快上调，因此使用此估算前必须查看当前价格页面。官方 [token 用量指南](https://api-docs.deepseek.com/quick_start/token_usage/)估算每个英文字符约为 0.3 token，每个中文字符约为 0.6 token。[上下文缓存指南](https://api-docs.deepseek.com/guides/kv_cache/)说明了重复前缀使用的自动尽力而为磁盘缓存。

一个实测的 20 分钟英文演讲包含 **2,935 个英文口语词**和 15,433 个字幕字符。按 DigestDock 当前的分组方式，它会变成 128 个语义分段，以每次 3 段的方式发出 43 次请求。算上重复 prompt 和 JSON 后，渲染后的输入约为 108,528 个英文字符，按官方每个英文字符 0.3 token 的经验值，即**约 32,600 个输入 token**。按每个中文字符 0.6 token 的经验值，再加上 JSON 和 ID 开销，中文 JSON 输出估计为 3,500 到 4,500 token。

如果所有输入都按缓存未命中计费，输入约 $0.0046，输出约 $0.0010 到 $0.0013，总计约 $0.0056 到 $0.0059。当大量重复的 system prompt 命中 DeepSeek 自动尽力而为缓存时，更现实的低值约为 $0.002 到 $0.003。完整翻译这段演讲的实用估算是 **$0.002 到 $0.006 USD，约 ¥0.02 到 ¥0.04**。

翻译是延迟按需和渐进式的。已缓存的分段会复用，只有滚动到并请求的字幕行才会发起调用。重试、服务商行为和价格变化都可能增加最终成本。

## 用编程 Agent 改造成自己的版本

本仓库按个人 Remix 项目维护，不接受上游 Issue 或 Pull Request。如果需要不同的行为，请从自己的 Fork 或本地副本继续修改，并让改动范围只作用于对应版本。

DigestDock 使用原生 HTML、CSS 和 JavaScript，应用本身没有构建步骤，因此本地修改和 Agent 辅助开发都比较直接。适合继续扩展的方向包括：

- 增加更多翻译语言，并让每个人选择自己的学习语言。
- 为课程、访谈、教程、测评或研究视频增加自定义总结模板。
- 增加生词本，保存单词、原句、解释和视频时间戳。
- 增加面向学习的 Markdown、CSV 或 Anki 导出。当前 JSON 功能是恢复备份，不是学习工具导出。
- 增加个人主题筛选，只突出与你目标相关的章节。
- 增加本地模型选项，获得不同的隐私和成本方案。
- 改善键盘操作、字体大小和高对比度等无障碍体验。

继续开发时应保留用户自带 API Key 的模式，不要把秘密写入源代码，并运行下方检查。分享自己的版本前，也要在真实视频上测试受影响的平台路径。

如果想使用其他 AI 服务或模型，请先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 DigestDock 项目文件夹。然后打开 DigestDock 设置并点击 **Copy customization prompt**。发送前替换 `[PROVIDER]` 和 `[MODEL]`，但不要加入任何 API Key。Agent 完成本地代码修改后，请你自己在它指出的设置位置填写 Key。

## 隐私和数据流向

DigestDock 会直接从扩展向服务商发送请求：

1. 把标准化的 YouTube 视频地址发送给 Supadata，用于获取原生字幕。
2. 对 B 站，直接向 B 站请求当前视频元数据和已有字幕轨，复用浏览器当前会话但不读取或保存 Cookie 值。
3. 当你使用 AI 功能时，把字幕和相关视频信息发送给 DeepSeek。
4. 翻译或讲解等功能只发送当前需要的内容，例如选中的文本和上下文，或少量字幕分段。
5. API Key、设置、笔记和最近缓存保存在 Chrome 本地。

DigestDock 没有账号系统、广告、分析统计或行为追踪。B 站、Supadata 和 DeepSeek 仍会按照各自的条款和隐私政策处理请求。详情请查看 [PRIVACY.md](PRIVACY.md)。

## 常见问题

### 视频页面没有显示 Digest 按钮

- 在 `chrome://extensions` 中找到 DigestDock，点击“重新加载”，然后刷新视频页面。
- 确认当前页面是标准 `https://www.youtube.com/watch?...` 或 `https://www.bilibili.com/video/BV...` 页面，而不是 Shorts、嵌入页、直播页或 B 站番剧页。
- 当前版本会在 YouTube 响应式操作栏变化时自动重新定位按钮。页面加载完成后可以稍等片刻。
- 如果你使用的是较早下载的版本，可以先横向调整一次 YouTube 窗口宽度让按钮出现，然后下载最新版，这样之后不再需要调整窗口。
- 如果按钮仍然没有出现，让你的编程 Agent 在这个具体视频页面检查 content script。

### 侧边栏无法打开

- 确认你打开的是标准 `https://www.youtube.com/watch?...` 或 `https://www.bilibili.com/video/BV...` 页面。
- 在 `chrome://extensions` 中确认 DigestDock 已启用，并点击“重新加载”。
- 重新加载扩展后，刷新视频页面。
- 如果问题仍然存在，让你的编程 Agent 检查扩展。

### DigestDock 提示需要设置

- 使用 YouTube 时保存 Supadata Key 和 DeepSeek Key；只使用 B 站时保存 DeepSeek Key，Supadata 可以留空。
- 发布版本固定使用 DeepSeek V4 Flash，没有需要填写的 Base URL 或 Model 字段。
- 如果设置提示旧的自定义服务已移除，请重新填写 DeepSeek Key。旧 AI Key 已安全清除，避免被错误用于 DeepSeek。

### 找不到字幕

- 确认视频是公开的，并且有原生字幕。
- 使用 YouTube 时，检查 Supadata Key、剩余额度、限速和账号状态；没有字幕的查询和手动重试也可能消耗额度。
- 使用 B 站时，确认当前分P存在独立字幕轨；若该字幕要求登录，请确认当前 Chrome 已登录 B 站。画面中的硬字幕无法读取。

DigestDock 不会自动改用 AI 生成字幕。

### AI 请求失败

- `401` 或 `403` 通常表示 DeepSeek Key 或账号权限有问题。
- `429` 通常表示达到了 DeepSeek 服务限速或消费上限。
- 确认 Key 来自上方链接的 DeepSeek 开放平台账号，并且账号有可用额度。
- 如果你把本地副本改成了其他模型，请再次使用设置中的自定义 prompt，让编程 Agent 检查本地实现。

不要在对话、截图或日志中分享 API Key、私密字幕或个人笔记。

## 给编程 Agent 的检查命令

修改项目后，让你的编程 Agent 运行：

```bash
npm test
npm run check
npm run package
```

Agent 还应该在 Chrome 中重新加载扩展，并在每个发生改动的支持平台上测试真实视频。自动检查通过，不代表真实服务请求或页面交互一定正常。

## 致谢与参考项目

DigestDock 基于 [Zara Zhang](https://github.com/zarazhangrui) 创建并以 MIT 许可证发布的原项目 [YouTube Digest](https://github.com/zarazhangrui/youtube-digest) 继续开发。感谢 Zara 公开原始侧边栏工作流，让这个项目能够被阅读、修改和扩展。

本仓库内实现了 B 站数据链路。开发过程中，下面这些公开项目用于理解和交叉验证 B 站页面元数据、当前分P身份、登录态可见字幕轨和字幕正文归一化等行为；它们不是本扩展的运行时依赖，列在这里也不表示其源代码被打包进本扩展：

- [Bili Clipper](https://github.com/echore/bili-clipper)
- [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved)
- [ChatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox)
- [BiliNote](https://github.com/JefferyHcool/BiliNote)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)

感谢这些项目的作者和维护者公开实现与文档，为浏览器集成中较难验证的行为提供了可靠参考。各项目仍适用其各自的许可证和版权声明；B 站网页内部接口也可能随平台更新而变化。

## 开源许可

MIT，详见 [LICENSE](LICENSE)。原始版权声明继续保留。
