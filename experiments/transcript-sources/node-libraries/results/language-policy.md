# Node 无 Key 字幕库真实对比：language-policy

运行时间：2026-08-18T08:41:45.874Z；环境：v22.23.1 / darwin-arm64。

本结果只代表同一台机器、同一网络出口的一次签出态冷调用矩阵。未使用 API Key、Cookie、代理或已保存字幕；每次调用有独立超时，候选顺序按样本轮换。

## 结果摘要

| 候选 | 正样本成功率 | 负样本判断 | 缺失语言边界 | 中位总耗时 | 总 HTTP 请求 | 错误 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| youtube-caption-extractor | 100% (1/1) | — (0/0) | 0% (0/1) | 619 ms | 4 | {} |
| youtube-transcript | 100% (1/1) | — (0/0) | 100% (1/1) | 353 ms | 3 | {"language-unavailable":1} |
| youtube-transcript-plus | 100% (1/1) | — (0/0) | 100% (1/1) | 1260 ms | 5 | {"language-unavailable":1} |
| youtubei.js | 0% (0/1) | — (0/0) | 0% (0/1) | 987 ms | 8 | {"upstream-api-error":2} |

## 每个真实样本

| 样本 | 预期 | youtube-caption-extractor | youtube-transcript | youtube-transcript-plus | youtubei.js |
| --- | --- | --- | --- | --- | --- |
| language-policy-control-en | transcript (en) | 字幕 61 段 / 746 ms | 字幕 61 段 / 459 ms | 字幕 61 段 / 1542 ms | 错误 upstream-api-error / 1034 ms |
| language-policy-missing-fr | language-unavailable (fr) | 字幕 61 段 / 491 ms | 语言不存在 / 246 ms | 语言不存在 / 977 ms | 错误 upstream-api-error / 940 ms |

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
| youtube-caption-extractor | dur, start, text | not-exposed-by-result; requested=en; library-can-fallback | 2089 / 2089 | a229ed9bcfe2 | 211.32 秒 |
| youtube-transcript | duration, lang, offset, text | result-lang-field | 2089 / 2089 | a229ed9bcfe2 | 211320 秒 |
| youtube-transcript-plus | duration, lang, offset, text | result-lang-field | 2165 / 2089 | a229ed9bcfe2 | 211.32 秒 |
| youtubei.js | 无成功结果 | 无 | — | — | — 秒 |

## 可复核观察

- youtubei.js 在本轮 2/2 次调用中报错：upstream-api-error: Request to https://www.youtube.com/youtubei/v1/get_transcript failed with status code 400。
- 时间单位疑似不符合各库文档的秒约定：youtube-transcript/language-policy-control-en maxEnd=211320。接入前必须归一化并写回归测试。
- language-policy-control-en：原始长度/哈希不同，但 HTML entity decode + NFKC + 全空白折叠后完全一致；差异属于编码或空白格式。youtube-caption-extractor=raw:2089,canonical:2089,sha:a229ed9bcfe2；youtube-transcript=raw:2089,canonical:2089,sha:a229ed9bcfe2；youtube-transcript-plus=raw:2165,canonical:2089,sha:a229ed9bcfe2。
- 缺失 fr 语言边界：youtube-caption-extractor=静默回退且正文与 en 控制完全相同；youtube-transcript=严格报语言不存在；youtube-transcript-plus=严格报语言不存在；youtubei.js=error/upstream-api-error。
- HTTP 日志只保存 origin + path，不保存字幕 URL 查询串、API key 参数、Cookie 或请求正文。JSON 不保存完整字幕，只保存段数、字符数与 SHA-256。

## 本组建议边界

仅在“需要 Node 伴随进程”的候选里，本轮应优先继续验证 youtube-transcript-plus：它的正样本成功率为 100%，安装足迹约 100.5 KiB。这不是直接采用结论；还应与纯扩展 MAIN-world / transcript-panel 路径比较，因为 Node 库意味着额外运行时边界。

youtube-transcript 虽然正样本都取到了正文，但当前 srv3 解析分支把毫秒放进文档声称为“秒”的 `offset` / `duration`；另一个 classic XML 分支又返回秒，不能安全地无条件除以 1000，因此不建议未经修补直接接入。

youtubei.js 本轮不应作为字幕主链候选：其能力面远大于字幕需求，安装与 bundle 显著更大，并且真实 get_transcript 已出现上游 400；浏览器版本还需要代理。

四个候选都不是“把一个文件直接放进现有 MV3”即可完成的方案：前三者仍需打包与真实扩展 CORS/host-permission 验证，youtubei.js 上游则明确要求浏览器代理。

复跑命令：`npm install --ignore-scripts --cache .npm-cache --no-audit --no-fund && npm run probe && npm run report`。可用 `CASES`、`CANDIDATES`、`ROUNDS`、`TIMEOUT_MS`、`DELAY_MS` 环境变量缩小或扩展矩阵。
