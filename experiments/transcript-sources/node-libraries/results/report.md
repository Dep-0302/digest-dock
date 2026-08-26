# Node 无 Key 字幕库真实对比

运行时间：2026-08-18T08:40:36.368Z；环境：v22.23.1 / darwin-arm64。

本结果只代表同一台机器、同一网络出口的一次签出态冷调用矩阵。未使用 API Key、Cookie、代理或已保存字幕；每次调用有独立超时，候选顺序按样本轮换。

## 结果摘要

| 候选 | 正样本成功率 | 负样本判断 | 缺失语言边界 | 中位总耗时 | 总 HTTP 请求 | 错误 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| youtube-caption-extractor | 100% (3/3) | 100% (1/1) | — (0/0) | 584 ms | 9 | {} |
| youtube-transcript | 100% (3/3) | 100% (1/1) | — (0/0) | 663 ms | 8 | {"no-caption":1} |
| youtube-transcript-plus | 100% (3/3) | 100% (1/1) | — (0/0) | 1125 ms | 11 | {"no-caption":1} |
| youtubei.js | 0% (0/3) | 100% (1/1) | — (0/0) | 920 ms | 15 | {"upstream-api-error":3,"no-caption":1} |

## 每个真实样本

| 样本 | 预期 | youtube-caption-extractor | youtube-transcript | youtube-transcript-plus | youtubei.js |
| --- | --- | --- | --- | --- | --- |
| many-tracks-authored-en | transcript (en) | 字幕 427 段 / 659 ms | 字幕 427 段 / 545 ms | 字幕 427 段 / 1058 ms | 错误 upstream-api-error / 1249 ms |
| asr-long-retrieval-divergence | transcript (en) | 字幕 1828 段 / 1025 ms | 字幕 1828 段 / 756 ms | 字幕 1828 段 / 1192 ms | 错误 upstream-api-error / 903 ms |
| traditional-chinese-explicit | transcript (zh-TW) | 字幕 402 段 / 423 ms | 字幕 402 段 / 569 ms | 字幕 402 段 / 1197 ms | 错误 upstream-api-error / 937 ms |
| spoken-no-caption | no-caption | 无字幕 / 509 ms | 无字幕 / 914 ms | 无字幕 / 1017 ms | 无字幕 / 662 ms |

## 安装与浏览器现实

| 候选 | 版本 | 自身文件 | 连同运行时依赖 | 运行时包数 | Node | 浏览器 / MV3 边界 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| [youtube-caption-extractor](https://github.com/devhims/youtube-caption-extractor) | 1.10.2 | 30.4 KiB | 169.0 KiB | 3 | >=18.0.0 | Published entry is CommonJS and upstream recommends server-side use because browser calls face CORS; a bundler/bridge would still be required for the current MV3 extension. |
| [youtube-transcript](https://github.com/Kakulukian/youtube-transcript) | 1.3.1 | 42.8 KiB | 42.8 KiB | 1 | >=18.0.0 | Small ESM/CJS package with a custom fetch hook, but direct MV3 use still needs browser host/CORS validation. |
| [youtube-transcript-plus](https://github.com/ericmmartin/youtube-transcript-plus) | 2.0.1 | 100.5 KiB | 100.5 KiB | 1 | >=20.0.0 | Node >=20 package; no browser export or ready-to-load MV3 bundle is declared. |
| [youtubei.js](https://github.com/LuanRT/YouTube.js) | 17.2.0 | 14.93 MiB | 18.86 MiB | 4 | 未声明 | Ships a browser bundle, but upstream documentation requires requests to go through a server proxy. This is not equivalent to dropping the bundle into the current MV3 extension. |

youtubei.js 自带 browser bundle 为 1.47 MiB（gzip 250.8 KiB），但上游明确要求浏览器请求经过自有服务端代理，所以“有浏览器 bundle”不等于可直接放进当前无打包体系的 MV3 扩展。

## 实际请求链

| 候选 | 典型成功链（首个成功样本） | 配置策略 |
| --- | --- | --- |
| youtube-caption-extractor | player:200 → timedtext:200 | Tries IOS, ANDROID_VR, then MWEB player clients until caption tracks are found; downloads json3 timedtext. |
| youtube-transcript | player:200 → timedtext:200 | ANDROID InnerTube first, then watch-page fallback; downloads XML timedtext. |
| youtube-transcript-plus | watch_page:200 → player:200 → timedtext:200 | Watch page for API key, ANDROID player request, then XML timedtext; optional retry/cache hooks are disabled in this benchmark. |
| youtubei.js | other:200 → player:200 → next:200 → get_transcript:400 | Creates an Innertube session, requests video info/next data, then calls get_transcript. |

## 返回格式与可接入性

| 候选 | 原始首段字段 | 语言证据 | 原始字符 / canonical 字符 | canonical SHA-256 | 时间最大值检查 |
| --- | --- | --- | ---: | --- | ---: |
| youtube-caption-extractor | dur, start, text | not-exposed-by-result; requested=en; library-can-fallback | 17574 / 17574 | 0db418f907a9 | 1165.213 秒 |
| youtube-transcript | duration, lang, offset, text | result-lang-field | 17574 / 17574 | 0db418f907a9 | 1165213 秒 |
| youtube-transcript-plus | duration, lang, offset, text | result-lang-field | 18486 / 17574 | 0db418f907a9 | 1165.213 秒 |
| youtubei.js | 无成功结果 | 无 | — | — | — 秒 |

## 可复核观察

- youtubei.js 在本轮 4/4 次调用中报错：upstream-api-error: Request to https://www.youtube.com/youtubei/v1/get_transcript failed with status code 400；no-caption: Transcript panel not found. Video likely has no transcript.。
- 长 ASR 样本的浏览器基线曾是 panel 无字幕、direct timedtext 空正文，但本轮三个小型 Node 库都成功取得 1828 段，说明客户端类型或请求上下文会实质改变结果；youtube-transcript=transcript；youtube-transcript-plus=transcript；youtubei.js=error/upstream-api-error；youtube-caption-extractor=transcript。
- 时间单位疑似不符合各库文档的秒约定：youtube-transcript/asr-long-retrieval-divergence maxEnd=4342520。接入前必须归一化并写回归测试。
- 显式 zh-TW：youtube-transcript-plus=transcript/zh-TW；youtubei.js=error；youtube-caption-extractor=transcript；youtube-transcript=transcript/zh-TW。
- many-tracks-authored-en：原始长度/哈希不同，但 HTML entity decode + NFKC + 全空白折叠后完全一致；差异属于编码或空白格式。youtube-caption-extractor=raw:17574,canonical:17574,sha:0db418f907a9；youtube-transcript=raw:17574,canonical:17574,sha:0db418f907a9；youtube-transcript-plus=raw:18486,canonical:17574,sha:0db418f907a9。
- asr-long-retrieval-divergence：原始长度/哈希不同，但 HTML entity decode + NFKC + 全空白折叠后完全一致；差异属于编码或空白格式。youtube-transcript=raw:63109,canonical:63109,sha:f3ee14455aa5；youtube-transcript-plus=raw:65545,canonical:63109,sha:f3ee14455aa5；youtube-caption-extractor=raw:63109,canonical:63109,sha:f3ee14455aa5。
- traditional-chinese-explicit：原始长度/哈希不同，但 HTML entity decode + NFKC + 全空白折叠后完全一致；差异属于编码或空白格式。youtube-transcript-plus=raw:4395,canonical:4386,sha:fd8efd20f958；youtube-caption-extractor=raw:4387,canonical:4386,sha:fd8efd20f958；youtube-transcript=raw:4387,canonical:4386,sha:fd8efd20f958。
- HTTP 日志只保存 origin + path，不保存字幕 URL 查询串、API key 参数、Cookie 或请求正文。JSON 不保存完整字幕，只保存段数、字符数与 SHA-256。

## 本组建议边界

仅在“需要 Node 伴随进程”的候选里，本轮应优先继续验证 youtube-caption-extractor：它的正样本成功率为 100%，安装足迹约 169.0 KiB。这不是直接采用结论；还应与纯扩展 MAIN-world / transcript-panel 路径比较，因为 Node 库意味着额外运行时边界。

youtube-transcript 虽然正样本都取到了正文，但当前 srv3 解析分支把毫秒放进文档声称为“秒”的 `offset` / `duration`；另一个 classic XML 分支又返回秒，不能安全地无条件除以 1000，因此不建议未经修补直接接入。

youtubei.js 本轮不应作为字幕主链候选：其能力面远大于字幕需求，安装与 bundle 显著更大，并且真实 get_transcript 已出现上游 400；浏览器版本还需要代理。

四个候选都不是“把一个文件直接放进现有 MV3”即可完成的方案：前三者仍需打包与真实扩展 CORS/host-permission 验证，youtubei.js 上游则明确要求浏览器代理。

复跑命令：`npm install --ignore-scripts --cache .npm-cache --no-audit --no-fund && npm run probe && npm run report`。可用 `CASES`、`CANDIDATES`、`ROUNDS`、`TIMEOUT_MS`、`DELAY_MS` 环境变量缩小或扩展矩阵。
