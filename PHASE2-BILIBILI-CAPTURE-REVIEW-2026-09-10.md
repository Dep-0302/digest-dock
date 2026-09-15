# 阶段 2b：B 站捕获对齐待复核

> **历史记录（2026-09-14 归档）：** 下文的状态、版本、门禁数字和执行约束属于文中所标的原阶段，不代表当前分支。保留原文用于追溯；当前阶段 2 的适用修订见 [规格 §10](PHASE2-THOUGHT-LAYER-2026-09-09.md#10-2026-09-14-收尾修订现行判据)，最终状态见 [收尾记录](PHASE2-CLOSEOUT-2026-09-14.md)。

> 授权：用户在 Claude 提出 B 站捕获范围缺口后明确回复“补齐补齐，保持一致”。增加独立 B 站捕获提交，原有不 push / merge / release 等边界不变。
> 基线：`f9571ee`，分支 `codex/thought-layer-phase2`。
> 状态：原 Claude 会话 Message 39 已独立复核，结论“阻断项：无。同意提交 2b。”；已提交 `9e0d021`。

## 范围与 diff

只改三个文件：

| 文件 | 用途 |
| --- | --- |
| `content-bilibili.js` | 对齐 T1–T4；10 秒 toast、第二次 N 输入、Enter/Esc/IME、失败保留草稿、后台重启重试、分 P 与迟到响应归属 |
| `tests/helpers/thought-layer-harness.js` | 增加 B 站测试上下文；真实加载 `content-bilibili.js` 和真实 Bilibili adapter，只替换远程元数据响应，沿用真实 background 写入 |
| `tests/thought-layer.test.js` | 将原来的 9 项捕获断言同时运行于 YouTube/Bilibili；再加 2 项 B 站分 P/迟到响应用例；增加输入框可访问名称检查 |

diff 为 204 行新增、50 行删除。删除行主要是测试参数化和将异步按钮引用绑定到本次调用；没有删减或调低断言。逐条文本比对，原有 176 条 assert 语句全部保留。

```sh
git diff f9571ee -- content-bilibili.js tests/helpers/thought-layer-harness.js tests/thought-layer.test.js
```

精确 diff SHA256：`10f9c00834d78f690ea8380631922ca1164507727fb9a62d905b7b6a8bb9382c`。

## 对齐的行为

- 第一次 N：原保存路径、不暂停、空 thought/null thoughtAt；不改变原 -3 秒反应偏移与字幕锚点。
- 普通 toast 保持 10 秒，过期后清除所属笔记引用；下一次 N 保存新笔记。
- toast 可见期间第二次 N：同一容器变为输入框、聚焦、暂停；不重复保存，不自动消失。
- Enter 原文存储，成功才关闭，不恢复播放；Esc 只丢弃草稿；中文组合输入期间的 Enter 不提交。
- 失败保留输入并显示“保存失败，请重试”；请求进行时防重复提交。
- 复用上一份已复核的后台 `updateNoteThought` 和一次 worker 重启标识刷新重试，后台文件没有修改。
- B 站仍坚持不用 innerHTML，使用节点创建、textContent 和 setAttribute。
- B 站来源标识使用现有 pathname + 分 P 的 navigationKey；切换 P 会释放旧输入，下一条笔记按真实 adapter 解析到新的 CID。
- 保存与恢复按钮的引用绑定本次调用，旧响应不改新 P 的按钮或 toast；迟到写入响应不关闭其他 toast。

没有修改 manifest、字幕获取链路、概览、导出、存储结构、YouTube 内容脚本或旧工作树。

## 先红后绿与回归

1. 在改生产代码前，新增 B 站 11 项测试：1 过、10 失，10 个失败全部为 ERR_ASSERTION；没有运行时异常、取消或跳过。
2. 实现后，B 站 11 项全部通过。
3. 两平台捕获/存储及现状保护定向检查：26 / 26 通过。
4. 全量 `npm test`：863 项，835 过、28 失；原有 809 项全过，新增阶段 2 测试共 54 项（26 过、28 等待后续实现）。
5. `npm run check` 仍在同一批 28 项红测处停止，退出码 1，不能写完整门禁通过。

这次没有新增一套“假想实现”的测试逻辑：9 项捕获行为使用同一份断言循环执行；B 站从真实 content 消息进入真实 background，通过真实 Bilibili adapter 的元数据解析取得 CID。字幕使用夹具缓存，若意外进入远程字幕请求，桩直接报错。所有网络均离线，不读取或使用真实 API Key。

两项 B 站额外测试：

- P1 有未保存草稿 → 切换 P2 → 旧输入关闭 → 新笔记 CID 124/page 2 → 想法只写 P2，P1 全字段不变。
- P1 保存已落库但回应延迟 → 切换 P2 并保存 → 释放 P1 回应 → P2 toast 不被替换 → 输入只写 P2。

复现：

```sh
node --test --test-name-pattern='\[bilibili\]' tests/thought-layer.test.js
node --test --test-name-pattern='^\[(?:harness|T[1-4]|T1–T3|T2–T4|T3/T9)\]|^\[T9\] (worker|concurrent|stale)|^\[T8\] default/current' tests/thought-layer.test.js
npm test
npm run check
```

本地日志：`/private/tmp/digestdock-phase2-bilibili-red.log`、`/private/tmp/digestdock-phase2-bilibili-green.log`、`/private/tmp/digestdock-phase2-both-capture.log`、`/private/tmp/digestdock-phase2-bilibili-full.log`、`/private/tmp/digestdock-phase2-bilibili-check.log`。

## 复核要求与下一步

请 Claude 在原会话中自行核对 diff、断言保留与测试数字，检查是否有阻断项，明确是否同意独立提交 2b。只读，可以运行测试；不修改或提交代码，不动真实 Chrome 扩展数据。

正式真实 Chrome 验收仍在阶段 2 全部实现、完整门禁通过之后。本次没有宣称完成真机 T1–T10，也没有重新加载/启停任何扩展。

通过复核后仅提交这三个文件，根目录文档不提交。然后进入原计划的检索与「最近」。

复核回流：Claude 自行确认 SHA、测试删除行仅为参数化声明/构造调用、B 站真实 adapter、26 项通过及原有 809 项无回归。实际模型/档位未核实（界面选择不作执行元数据）。记录项：Esc 后两个平台都保持暂停；两套输入状态机今后需同步维护，共享模块抽取不在本轮。未进行真实 Chrome 验收。
