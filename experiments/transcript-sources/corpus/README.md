# 真实 YouTube 字幕对比样本

这 7 个样本用于比较不依赖第三方 API Key 的字幕提取方案。它们不是“随便找几个能打开的视频”，而是分别压中真实实现最容易混淆的边界：轨道发现、轨道选择、文字稿取回和无字幕判定。

## 已核验到哪一层

- 2026-08-18，在未登录、`zh-CN` 界面的 YouTube 桌面页逐个打开 watch URL。
- 从页面内联的 `ytInitialPlayerResponse` 读取 `playabilityStatus`、视频元数据和 `captionTracks`。7 个页面均为 `OK`。
- 只对两个分歧样本额外运行浏览器文字稿导出：
  - `iG9CE55wbtY` 成功导出 20,419 字节，浏览器按当前界面环境选择了人工 `zh-CN`。
  - `KLDVxx4TqcE` 虽然公开了唯一 `en/asr` 轨道，但浏览器文字稿导出报告没有文字稿；同页 `baseUrl` 的一次 `fmt=json3` 直达请求为空。
- 其余样本只确认“页面可播放 + 页面声明的字幕轨状态”，没有把“存在 baseUrl”写成“已成功取回文字稿”。

机器可读的完整记录见 [corpus.json](./corpus.json)。

## 建议的分组跑法

1. 基础成功组
   - `jNQXAC9IVRw`：19 秒，人工英文，验证最小成功路径。
   - `6i7RcP39NB0`：中文原声，人工 `zh-TW + en`，验证不要盲选第一个英文轨。

2. 轨道选择组
   - `iG9CE55wbtY`：65 轨，同为英文的人工轨和 ASR 轨并存。
   - `gBumdOWWMhY`：日语原声、8 条人工翻译轨，日语在观察顺序中排第 5。

3. 长视频与源差异组
   - `KLDVxx4TqcE`：72 分钟，只有英文 ASR。必须把“发现轨道”和“拿到文本”分开计分。

4. 无字幕组
   - `4OEG33NfEK0`：有中文演讲，但当前 `captionTracks=0`，属于真实不可用边界。
   - `aqz-KE-bpKQ`：无对白且 `captionTracks=0`，属于正常负对照。

## 判分时不要合并的状态

- `page_ok`：视频页可播放。
- `tracks_found`：页面播放器响应声明了字幕轨。
- `text_retrieved`：方案实际拿到了非空字幕文本。
- `language_selected`：方案最终选了哪种语言、人工还是 ASR。
- `clean_no_caption`：方案快速、明确地报告没有字幕。

只有 `text_retrieved` 才算提取成功。`tracks_found` 不能代替它，`captionTracks=0` 也不能被笼统记成网络错误。

## 复跑注意

- YouTube 的字幕、签名和 PO Token 行为会变化；每轮对比前应重新读取 `captionTracks`，特别是较新的 `4OEG33NfEK0`。
- 不要把本次 `zh-CN` 浏览器自动选择的轨道当成跨地区固定行为。
- 本目录只保存公开元数据和测试结论，不保存视频、音频或完整字幕正文。
