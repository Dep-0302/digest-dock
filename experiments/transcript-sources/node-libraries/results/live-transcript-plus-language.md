# Node 无 Key 字幕库真实对比：live-transcript-plus-language

运行时间：2026-08-26T07:04:32.355Z；环境：v22.23.1 / darwin-arm64。

本结果只代表同一台机器、同一网络出口的一次签出态冷调用矩阵。未使用 API Key、Cookie、代理或已保存字幕；每次调用有独立超时，候选顺序按样本轮换。

## 结果摘要

| 候选 | 正样本成功率 | 负样本判断 | 缺失语言边界 | 中位总耗时 | 总 HTTP 请求 | 错误 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| youtube-transcript-plus | — (0/0) | — (0/0) | 100% (1/1) | 2006 ms | 2 | {"language-unavailable":1} |

## 每个真实样本

| 样本 | 预期 | youtube-transcript-plus |
| --- | --- | --- |
| language-policy-missing-fr | language-unavailable (fr) | 语言不存在 / 2006 ms |

## 安装与浏览器现实

| 候选 | 版本 | 自身文件 | 连同运行时依赖 | 运行时包数 | Node | 浏览器 / MV3 边界 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| [youtube-transcript-plus](https://github.com/ericmmartin/youtube-transcript-plus) | 2.0.1 | 100.5 KiB | 100.5 KiB | 1 | >=20.0.0 | Node >=20 package; no browser export or ready-to-load MV3 bundle is declared. |

youtubei.js 自带 browser bundle 为 1.47 MiB（gzip 250.8 KiB），但上游明确要求浏览器请求经过自有服务端代理，所以“有浏览器 bundle”不等于可直接放进当前无打包体系的 MV3 扩展。

## 实际请求链

| 候选 | 典型成功链（首个成功样本） | 配置策略 |
| --- | --- | --- |
| youtube-transcript-plus | watch_page:200 → player:200 | Watch page for API key, ANDROID player request, then XML timedtext; optional retry/cache hooks are disabled in this benchmark. |

## 返回格式与可接入性

| 候选 | 原始首段字段 | 语言证据 | 原始字符 / canonical 字符 | canonical SHA-256 | 时间最大值检查 |
| --- | --- | --- | ---: | --- | ---: |
| youtube-transcript-plus | 无成功结果 | 无 | — | — | — 秒 |

## 可复核观察

- HTTP 日志只保存 origin + path，不保存字幕 URL 查询串、API key 参数、Cookie 或请求正文。JSON 不保存完整字幕，只保存段数、字符数与 SHA-256。

## 本组建议边界

仅在“需要 Node 伴随进程”的候选里，本轮应优先继续验证 youtube-transcript-plus：它的正样本成功率为 —，安装足迹约 100.5 KiB。这不是直接采用结论；还应与纯扩展 MAIN-world / transcript-panel 路径比较，因为 Node 库意味着额外运行时边界。

youtubei.js 本轮不应作为字幕主链候选：其能力面远大于字幕需求，安装与 bundle 显著更大，并且真实 get_transcript 已出现上游 400；浏览器版本还需要代理。

四个候选都不是“把一个文件直接放进现有 MV3”即可完成的方案：前三者仍需打包与真实扩展 CORS/host-permission 验证，youtubei.js 上游则明确要求浏览器代理。

复跑命令：`npm install --ignore-scripts --cache .npm-cache --no-audit --no-fund && npm run probe && npm run report`。可用 `CASES`、`CANDIDATES`、`ROUNDS`、`TIMEOUT_MS`、`DELAY_MS` 环境变量缩小或扩展矩阵。
