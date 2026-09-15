# 阶段 2：提交 2「捕获与存储」待复核

> **历史记录（2026-09-14 归档）：** 下文的状态、版本、门禁数字和执行约束属于文中所标的原阶段，不代表当前分支。保留原文用于追溯；当前阶段 2 的适用修订见 [规格 §10](PHASE2-THOUGHT-LAYER-2026-09-09.md#10-2026-09-14-收尾修订现行判据)，最终状态见 [收尾记录](PHASE2-CLOSEOUT-2026-09-14.md)。

> 当前停点：已通过原 Claude 桌面会话独立复核，无阻断项；捕获与存储已提交为 `f9571ee`。B 站捕获对齐是否加入本轮，等待用户决定。下文保留实现及验证证据。
> 基线：`main @ cea382e`；当前分支：`codex/thought-layer-phase2`。
> 行为真源：`PHASE2-THOUGHT-LAYER-2026-09-09.md`，225 行二次修订版。

## 1. 红测补项与实际提交

用户要求的补测 A、B 已加入：

- A：toast 过期后再按 N 必须产生新笔记；第一条所有字段不变；随后第二个 toast 内输入只修改第二条。
- B：正常 8 条库的全部想法进入 provider 输入，界面没有截断提示。

补后实跑：42 项，3 过、39 失。39 个失败全部为 `ERR_ASSERTION`，没有 ReferenceError、TypeError、SyntaxError、未处理拒绝、取消或跳过。

已提交：`7d522df test: define phase 2 thought-layer acceptance contracts`。

该提交只包含两个测试文件，579 行；没有规格文档、功能实现或其他文件。

## 2. 本次待复核的实现范围

| 文件 | 改动 | 对应验收 |
| --- | --- | --- |
| `content.js` | 10 秒 toast；第二次 N 就地输入与暂停；Enter/Esc；中文组合输入；失效 toast 释放；保存回应归属；后台重启的一次刷新重试 | T1–T4、补测 A |
| `background.js` | 保存结果带瞬时数据版本标识；新增想法更新消息；串行更新单条笔记及其索引；删除/重置后的过时编辑拒绝 | T3、T9 写入侧 |
| `tests/thought-layer.test.js` | 新增 1 条后台重启回归，11 行；已先红后绿；未修改、删减或放松已批准的 42 项断言 | T3 |

当前 diff：3 个文件，202 行新增、6 行删除。测试辅助桩未修改。

复核命令：

```sh
git diff 7d522df -- background.js content.js tests/thought-layer.test.js
```

候选 diff SHA256：`095888ef8f852deb4fc381384d3e521a786c1febc85654477c08d07ca417c6a8`。

检索、「最近」界面、AI 兜底、回跳降级没有开始实现。T9 的最近内编辑入口属于下一份视图提交，本次仅完成它将调用的写入侧。

## 3. 实现行为与保护点

### 捕获

- 第一次 N 继续走既有保存路径；不暂停；锚点与字幕获取逻辑未改。
- toast 状态只持有它刚保存的笔记对象；普通 toast 10 秒后退出并释放引用。
- 可见期间第二次 N 将同一容器变为输入框，聚焦并暂停；同时取消退出与动画结束两个计时器。
- Enter 原文提交；成功后才关闭，始终不自动播放。Esc 不提交草稿，不删金句。
- 组合输入期间的 Enter 不提交；请求进行时保持输入框，不允许重复保存；失败保留原输入并提示“保存失败，请重试”。
- 页面切换清理 toast；迟到的旧保存结果不接管新的捕获；旧输入请求的响应不能关闭另一条 toast。

### 存储

- 复用 `thought`、`thoughtAt`，不新增任何持久化字段。
- 有内容保留原输入；空白输入按空想法处理并令 thoughtAt 为 null，与现有索引的空白判断一致。
- 只更新目标分片的目标记录，以及该 ID 的 `hasThought`/`searchText`；同一个 storage.set 写入分片和索引。
- 创建时间、锚点、来源、字幕正文、冻结窗口及其他字段原样保留；索引 savedAt 不改。
- 复用已有笔记写入队列与数据重置标识；串行读取最新记录后再更新，避免并发编辑互相覆盖。
- ID 不存在时返回失败，不重建被删除的笔记；同一后台进程的数据重置不能被过时编辑越过。
- 更新成功广播既有 `notesChanged`；它的侧栏刷新路径本来就是 `translateMissing: false`，没有改动其他翻译行为。
- 想法写入不调用 provider；本次没有实现或改动 AI 检索。

### 新增的后台重启回归

自查发现：输入框可无限停留，但 MV3 后台可能重启；若一直使用旧 runtime 标识，用户即使重试也无法保存。

新增回归使用第二个真实 background VM 模拟重启，复制原存储，再把原 content 的消息接到新后台。它先以“想法仍为空”产生 `ERR_ASSERTION`，修复后通过。

修复复用侧栏现有语义：只有后台明确返回版本失配、新 runtime 与旧 runtime 不同、数据代数为合法偶数时，才更新瞬时标识并重试一次。相同 runtime 内的数据重置不自动刷新；目标笔记若不存在仍失败。该标识只在消息和内存中使用，不写入笔记。

## 4. 自己跑过的结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 补后红测提交前 | 42 项：3 过、39 失 | 全部失败为 ERR_ASSERTION；符合先红要求 |
| 后台重启新回归，修复前 | 1 项失败 | ERR_ASSERTION：想法仍为空 |
| 后台重启新回归，修复后 | 1 项通过 | 真实新 worker 接收旧 content 后完成保存 |
| 捕获/写入及保护对照定向测试 | 15 / 15 通过 | 退出码 0，取消/跳过为 0 |
| 当前全量 `npm test` | 852 项：824 过、28 失 | 原有 809 项全过；新增 43 项中 15 过、28 等待后续实现 |
| 当前 `npm run check` | 测试阶段 824 过、28 失，退出码 1 | 仍有后续红测，不能标完整 check 通过 |
| `git diff --check` | 通过 | 无 diff 空白错误 |

当前 28 个失败全部为 `ERR_ASSERTION`，对应未实现的 T5/T6/T7/T8 新视图、T9 最近编辑入口、T10。没有通过跳过或调低断言制造通过结果。

复现定向测试：

```sh
node --test --test-name-pattern='^\[(?:harness|T[1-4]|T1–T3|T3/T9)\]|^\[T9\] (worker|concurrent|stale)|^\[T8\] default/current' tests/thought-layer.test.js
```

全部原有断言保留。DOM 中的想法在前，不等于最终视觉顺序一定正确；真实 Chrome T5 仍需后续核验。

## 5. Claude 复核已完成（CLI 失败后改用原桌面会话）

已尝试通过本机 Claude CLI 进行只读复核：safe mode、禁用全部工具和 Chrome/MCP、无会话持久化；输入为规格、精确 diff、相关原实现上下文与测试。

CLI 退出码 1，结果为 `is_error: true`，错误：`Failed to authenticate: OAuth session expired and could not be refreshed`。没有实际复核结论。回执没有 modelUsage 条目，无法核实模型或档位。

| 执行岗位 | 入口 | 实际模型/档位 | 结果 |
| --- | --- | --- | --- |
| 提交 2 只读 diff 复核 | cld | 模型未核实 / 档位未核实 | OAuth 过期，未完成复核 |

随后按用户明确要求，由 Codex 直接把复核委托交给 Claude 桌面 App 中的原「digestDock Chrome 插件评估」会话，并自行等候、取回回复。没有修改登录或配置。

会话入口：[digestDock Chrome 插件评估](https://claude.ai/cowork/cse_012ybnpwSW8N8yFhAZVzKj5S)，本次结果为 Message 37。界面明确显示回复完成。

Claude 结论原文：“1）阻断项：无。”“3）同意这份 diff 提交。”

它独立核对了完整 diff SHA256、三文件增删行数、原有断言零删减；运行专项与全量测试，确认 43 项中 15 过/28 个 ERR_ASSERTION、原有 809 项全部通过；并核对数据重置保护、后台重启重试、索引九字段及四处 searchText 构造一致性。

| 执行岗位 | 入口 | 实际模型/档位 | 结果 |
| --- | --- | --- | --- |
| 提交 2 只读 diff 复核 | cld（原 Claude 桌面会话） | 模型未核实 / 档位未核实 | 已完成；无阻断项，明确同意提交 |

本次界面显示选择项为 Opus 5 Max，但没有回复专属执行元数据，因此不将该配置当作已核实的实际模型回执。

提交前再次核对 diff 哈希完全不变，只暂存三个已复核文件，提交为 `f9571ee feat: capture and persist thoughts from the note toast`。

## 6. 边界与下一步

- 未改 sidepanel、manifest、字幕获取、概览、导出、版本号或原有锚点/窗口。
- 旧工作树未修改。Chrome 安装项未重新加载或切换；本次没有真实 Chrome 验收声明。
- 暂存前发现一个无活跃 Git 进程持有的空 index.lock；核对后移到 `/private/tmp/digestdock-phase2-index-lock-20260909-204234` 保留，未删除锁文件内容或任何用户数据。
- 根目录规格与复核说明不纳入提交。
- Claude 提出一个非阻断范围缺口：当前想法捕获只在 YouTube；B 站的 `content-bilibili.js` 仍有独立 N 处理器，第二次 N 继续保存新笔记，toast 仍为 5 秒。Codex 已直接读代码核实，B 站文件本轮没有改动。
- Claude 建议增加独立“B 站捕获对齐”提交，排在检索之前；这超出当前已经固定的四份提交安排，不能以评审建议代替用户的产品范围授权。
- 下一步：把该差异反馈用户，由用户决定是否本轮增加 B 站对齐。尚未开始这项新增范围或后两份实现。
- 已完成红测 `7d522df` 和捕获与存储 `f9571ee` 两个本地提交；未 push、未 merge、未 release。

本地证据：`/private/tmp/digestdock-phase2-red-42.log`、`digestdock-phase2-worker-restart-red.log`、`digestdock-phase2-worker-restart-green.log`、`digestdock-phase2-capture-focused.log`、`digestdock-phase2-capture-full.log`、`digestdock-phase2-capture-check.log`、`digestdock-phase2-capture-claude-review.json`（均在 `/private/tmp/`）。
