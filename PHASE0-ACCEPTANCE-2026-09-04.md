# 阶段 0 真实 Chrome 验收清单

> 执行中。执行人在每项后填写结果与日期。
> 被测对象：工作树 `worktrees/notes-trust-phase0`，分支 `codex/notes-trust-phase0`，基线 `ac1c840`
> 自动门禁状态：`npm run check` 754/754 测试与 47 个白名单文件检查通过；`git diff --check` 通过（2026-09-04）
> 方案出处：`NOTES-LIBRARY-MVP-PLAN-2026-09-04.md` §4 阶段 0

本文件只记录真实浏览器验收。提交、推送与发布另行记录。

---

## 0. 准备

### 0.1 你的真实笔记不会被动到

工作树是**另一个目录**，Chrome 按目录区分扩展，所以它拿到独立的扩展 ID 和独立的 `storage.local`。被测扩展看不到、也写不到你日常那份 DigestDock 的笔记。

下面的造数据步骤只影响被测扩展。

### 0.2 关掉日常版本

打开 `chrome://extensions`，把你日常在用的 DigestDock **临时停用**。两份同时启用时页面上会出现两套控件，验收结论不可信。

### 0.3 装载被测版本

1. `chrome://extensions` → 右上角打开「开发者模式」
2. 点「加载已解压的扩展程序」
3. 选择这个目录：
   ```
   /Users/wangchao/Documents/061-DigestDock/worktrees/notes-trust-phase0
   ```
4. 记下新卡片上的扩展 ID：`jfjiohpdeohjiopbeapdjmaelkiejcen`

### 0.4 打开 Service Worker 控制台

在被测扩展的卡片上点 **「Service Worker」** 链接，弹出的 DevTools Console 就是下面所有命令的执行位置。

> 后续每条命令都在这个控制台里执行。造完数据后，侧栏需要关掉重开才会重新读取。

---

## 1. 满库拒绝保存，且一条旧笔记都不删

**这是本轮最重要的一项。** 修复前：存第 101 条会静默删掉最旧的一条并报告成功。

### 1.1 造 500 条笔记（满库）

在 Service Worker 控制台粘贴执行：

```js
const seed = (n) => Array.from({ length: n }, (_, i) => {
  const k = i + 1;
  const sec = k * 7;
  return {
    id: `seed-${String(k).padStart(4, "0")}`,
    videoId: "SEEDVIDEO01",
    mediaKey: "SEEDVIDEO01",
    platform: "youtube",
    canonicalUrl: "https://www.youtube.com/watch?v=SEEDVIDEO01",
    videoTitle: "验收用造数据视频",
    channelName: "验收频道",
    timestamp: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`,
    timestampSeconds: sec,
    timestampedUrl: `https://www.youtube.com/watch?v=SEEDVIDEO01&t=${sec}s`,
    text: `造数据笔记 ${k}`,
    rawText: `造数据笔记 ${k}`,
    translatedText: "",
    translatedValidated: false,
    translatedValidationVersion: 0,
    translatedUnchanged: false,
    sourceLanguage: "en",
    textLanguage: "",
    createdAt: Date.now() - (500 - k) * 1000,
  };
}).reverse(); // storage uses newest-first order; the oldest note stays at the end

await chrome.storage.local.set({ ytd_notes: seed(500) });
const before = (await chrome.storage.local.get("ytd_notes")).ytd_notes;
console.log("已造", before.length, "条；最旧一条 =", before[before.length - 1].id);
```

预期输出：`已造 500 条；最旧一条 = seed-0001`

### 1.2 尝试保存第 501 条

1. 打开任意一个**有字幕的** YouTube 视频页
2. 点扩展图标打开侧栏，等字幕读出来
3. 点页面上的笔记按钮（或侧栏的「保存当前时刻」）保存一条

**预期**：按钮显示 **「笔记已达上限」**，不是「已保存」，也不是「出错了」。

### 1.3 确认一条都没丢

回控制台执行：

```js
const after = (await chrome.storage.local.get("ytd_notes")).ytd_notes;
console.log("条数 =", after.length);
console.log("最旧一条 =", after[after.length - 1].id);
console.log("有无新笔记 =", after.some(n => !n.id.startsWith("seed-")));
```

**预期**：`条数 = 500`、`最旧一条 = seed-0001`、`有无新笔记 = false`

- [x] 通过  日期：2026-09-04
- 备注：验收脚本原顺序与“最旧在末尾”的断言相反，本次用 `seed(500).reverse()` 生成 newest-first 数据。页面按钮实测显示「笔记已达上限」；控制台回读 `COUNT 500`、`OLDEST seed-0001`、`HAS_NEW false`，500 条旧笔记一条未删。旁路发现：若测试扩展残留 AI Key，达到容量检查前仍会先尝试笔记清理调用；本次残留的是无效 Key，随后已按授权清空。

---

## 2. 「原文」显示的是字幕原话，不是 AI 改写版

修复前：配置了 AI Key 后，笔记正文存的是 Provider 改写过的句子，而「原文」模式优先显示它；真正的原话 `rawText` 在界面上没有任何入口。

### 2.1 造一条「原话与改写版明显不同」的笔记

```js
await chrome.storage.local.set({ ytd_notes: [{
  id: "verbatim-check",
  videoId: "SEEDVIDEO02",
  mediaKey: "SEEDVIDEO02",
  platform: "youtube",
  canonicalUrl: "https://www.youtube.com/watch?v=SEEDVIDEO02",
  videoTitle: "原文语义验收",
  channelName: "验收频道",
  timestamp: "0:30",
  timestampSeconds: 30,
  timestampedUrl: "https://www.youtube.com/watch?v=SEEDVIDEO02&t=30s",
  rawText: "RAW: uh so we we shipped it on a friday and it broke",
  text: "CLEANED: We shipped the release on a Friday, and it broke.",
  translatedText: "",
  translatedValidated: false,
  translatedValidationVersion: 0,
  translatedUnchanged: false,
  sourceLanguage: "en",
  textLanguage: "",
  createdAt: Date.now(),
}] });
```

### 2.2 看侧栏显示哪一个

1. 关掉侧栏再重新打开
2. 进「笔记」页 → 点「全部笔记」
3. 语言模式切到 **「原文」**

**预期**：卡片正文以 **`RAW:`** 开头。
**不通过的样子**：正文以 `CLEANED:` 开头——那说明改写版仍在冒充原文。

### 2.3 顺带确认导出也是原话

在「全部笔记」中找到「原文语义验收」分组，点「导出此视频笔记」→「直接导出」，打开 TXT 确认里面是 `RAW:` 那一句。

- [x] 通过  日期：2026-09-04
- 备注：英文/非中文对照路径原先已通过：切到「原文」后卡片与 TXT 均只含 `RAW:`，不含 `CLEANED:`。追加可信中文边界后曾复现中文分支错误，并据此修复。重新加载扩展复验时，卡片显示 `RAW-ZH: 呃我们周五上线然后坏了`；导出的 `中文原文语义边界-notes-original-2026-09-05.txt` 也只含 `RAW-ZH:`，不含 `CLEANED-ZH:`。“原文”现统一取字幕原话。

---

## 3. 容量状态条

上限 500，状态条阈值 **450**（含）。

### 3.1 阈值以下不出现

```js
await chrome.storage.local.set({ ytd_notes: seed(449) });
```
关掉侧栏重开 → 笔记页 → 全部笔记。
**预期**：**看不到**任何容量提示。

### 3.2 接近上限

```js
await chrome.storage.local.set({ ytd_notes: seed(450) });
```
关掉侧栏重开。
**预期**：出现状态条，写着 `已保存 450 / 500 条笔记，接近上限。建议先导出一份备份。`，左边框是蓝青色（不是红色），右侧有「导出备份」按钮。

### 3.3 已满

```js
await chrome.storage.local.set({ ytd_notes: seed(500) });
```
关掉侧栏重开。
**预期**：文案变成「已达上限。新的笔记会被拒绝保存，已保存的笔记不会被删除……」，`500 / 500` 变红，左边框变红。

### 3.4 「导出备份」能到地方

点状态条上的「导出备份」→ 应打开设置页。在「笔记备份」卡片点「导出笔记备份」，确认下载出 JSON 且里面是 500 条。

> 这一步同时验证了上限单一真源：修复前 background 存 100、备份模块也卡 100，两个常量各自为政。现在两边都是 500，能存下就一定导得出。

- [x] 通过  日期：2026-09-04
- 备注：449 条时无容量提示；450 条时出现蓝青色状态条、精确文案 `已保存 450 / 500 条笔记，接近上限。建议先导出一份备份。` 与「导出备份」按钮；500 条时为红色满额状态并明确新笔记会被拒绝。设置页导出的 `digest-dock-notes-2026-09-05.json` 为 schema v3、500 条、249262 bytes，顶层字段仅为合同允许的 `exportedAt`、`extensionVersion`、`format`、`notes`、`schemaVersion`。

---

## 4. 重置数据清得干净

修复前：「重置全部数据」只清 `storage.local`，Passive 字幕桥存在 `storage.session` 的状态会留下。

### 4.1 造一点 session 状态

先正常打开一个 YouTube 视频、开侧栏读出字幕（这会自然写入 session 状态），然后回控制台：

```js
console.log("重置前 session =", await chrome.storage.session.get(null));
```
应该看到非空对象。若为空，手动造一条也可以：
```js
await chrome.storage.session.set({ __acceptance_probe: { videoId: "abc" } });
```

### 4.2 重置

设置页 → 找到「重置全部扩展数据」→ 执行。

### 4.3 确认两边都空了

```js
console.log("session =", await chrome.storage.session.get(null));
console.log("local   =", await chrome.storage.local.get(null));
```

**预期**：`session = {}`；`local` 只剩语言偏好 `ytd_options_language`。

- [x] 通过  日期：2026-09-04
- 备注：重置后控制台精确回读 `session = {}`，`local = {"ytd_options_language":"zh-CN"}`。首轮真实操作还发现“重置成功后残留设置加载失败”的页面竞态；修复并重新加载扩展后，以两条真实笔记再次重置，页面立即同时显示「设置没有未保存的更改。」和「已删除全部 DigestDock 数据。」，未再出现假失败。

---

## 5. 隐身模式不再收编笔记

修复前 manifest 没有 `incognito` 字段，默认 `spanning`——隐身窗口里看的视频，笔记会写进同一个普通资料库。

1. `chrome://extensions` → 被测扩展卡片 → 点「详情」
2. 找「在无痕模式下启用」这一项

**预期**：这个开关**不存在**（或明确不可用）。有它就说明 `"incognito": "not_allowed"` 没生效。

3. 开一个隐身窗口打开 YouTube 视频，确认扩展图标不可用、侧栏打不开。

- [x] 通过  日期：2026-09-04
- 备注：扩展详情页实测没有「在无痕模式下启用」开关；隐身窗口打开 YouTube 后没有 DigestDock 页面注入，也无法打开该扩展侧栏。Service Worker 同时回读 `incognito: not_allowed`。

---

## 6. 回归：正常路径没被弄坏

在 §4 重置后的**空库**状态下走一遍日常流程。若单独重跑本节，只删除笔记键后重开侧栏：`await chrome.storage.local.remove("ytd_notes")`；不要使用 `local.clear()`，否则会同时删除语言、Provider 设置和缓存，改变本节前提。

- [x] YouTube 有字幕视频：字幕读得出、时间码能跳转
- [x] 保存一条笔记 → 显示「已保存」，笔记页能看到
- [x] B站 BV 视频：字幕读得出、能保存笔记
- [x] 笔记页三种语言模式切换正常
- [x] 导出 TXT 正常
- [x] 笔记备份导出 → 重置 → 导入，笔记回来了

日期：2026-09-04  备注：YouTube `LEY9kenjVaA` 读出中文字幕，点击时间码后播放器跳至对应位置，并在 05:46 保存原文笔记；B站 `BV1zfg36ZEXi` 读出字幕、点击 00:10 后播放器跳转，并在 00:14 保存原文笔记。笔记页「原文 / 中文 / 双语」三态均实测；双平台 TXT 含两个视频分组、正确 URL/平台/时间码与原话。随后导出 schema v3 的两条真实笔记备份、执行重置、导入，设置页显示「已恢复 2 条新笔记。当前共保存 2 条笔记。」；再次导出的 JSON 与重置前标准化内容完全一致，保留两个原始 ID、媒体身份、14/346 秒时间码及 `rawText`。当前选取的英文 YouTube 样本均由 YouTube 原生层报告 CC 不可用，扩展按设计失败关闭；本节 YouTube 正向路径由上述中文字幕样本完成，不把英语路径记作已通过。

---

## 7. 收尾

1. 在 `chrome://extensions` 移除被测扩展（它的造数据随之消失）
2. 重新启用你日常在用的 DigestDock

---

## 验收结论

- [x] 全部通过 → 可以提交
- [ ] 有不通过项 → 记录在下方，先修再提交

不通过项：无。
