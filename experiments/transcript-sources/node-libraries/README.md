# Node 无 API Key 字幕候选对比

这个目录是隔离实验，不参与扩展生产构建。它比较：

- `youtube-caption-extractor`
- `youtube-transcript`
- `youtube-transcript-plus`
- `youtubei.js`（YouTube.js）

所有真实调用都直接从当前 Node 进程访问 YouTube，且明确不使用 API Key、Cookie、代理或浏览器登录态。结果只保存结构、数量、耗时、错误、去查询串后的请求路径和字幕正文 SHA-256，不保存完整字幕。

## 复跑

```bash
npm install
npm test
npm run probe
npm run report
```

依赖和 npm 缓存都局限在本目录。`cases.json` 包含五个主语料样本和一对缺失语言策略样本；建议用 `CASES` 明确选择小矩阵并只跑一轮，减少短时间大量请求造成的限流偏差。

可选环境变量：

```bash
CASES=many-tracks-authored-en,traditional-chinese-explicit \
CANDIDATES=youtube-caption-extractor,youtube-transcript-plus \
ROUNDS=2 TIMEOUT_MS=20000 DELAY_MS=500 RESULT_NAME=my-run npm run probe

RESULT_NAME=my-run npm run report
```

`CASES` 和 `CANDIDATES` 都是逗号分隔的精确 ID。`RESULT_NAME` 默认是 `latest`；使用其他小写名称可以保存并列结果，例如 `results/language-policy.json` 和 `results/language-policy.md`。`latest` 的报告文件固定为 `results/report.md`。

## 读结果时的边界

- “正样本成功率”只统计语料中预期有字幕的样本。
- “负样本判断”要求候选明确返回空数组或可识别的无字幕错误；网络错误和上游 400 不算正确负样本。
- 发现 `captionTracks` 不等于能下载正文，长 ASR 样本专门测试这一区别。
- 单轮耗时只适合看数量级与请求链，不能当严谨性能基准。
- 每份摘要同时记录原始字符数/哈希和 HTML entity decode、NFKC、全空白折叠后的 canonical 字符数/哈希，用于区分正文差异与纯格式差异。
- `youtubei.js` 有浏览器 bundle，但上游文档要求浏览器请求经过服务端代理；它不是可直接放入当前 MV3 扩展的零基础设施方案。
