# 无 Key 字幕工具真实对比

本目录比较两条不需要 API Key 的 Python 路线：

- `yt-dlp`：以独立 CLI 进程运行，只下载 `json3` 字幕，不下载视频或音频。
- `youtube-transcript-api`：在 Python 进程内列出并拉取字幕轨。

实验不读取浏览器 cookies、代理环境变量、配置文件或任何凭据。所有请求都是签出状态下的直连请求；字幕正文只在临时内存/临时目录中存在，结果只保存形状指标和规范化正文的 SHA-256。

## 运行

```bash
./setup.sh
./run.sh --runs 2 --timeout 45
```

默认优先使用本机 `/Users/wangchao/.local/bin/python3.12`，依赖只安装到本目录忽略的 `.venv312/`，pip 缓存位于 `/tmp`。没有 Python 3.12 时，脚本会退回 `python3`，但当前 `yt-dlp 2026.7.4` 要求 Python 3.10 以上。

## 文件

- `cases.json`：从相邻真实 corpus 选出的 6 个判别场景。
- `benchmark.py`：两个适配器、通用规范化、计时和汇总。
- `probe_environment.py`：全局安装状态和 Python 兼容性快照。
- `results/raw.json`：每次请求的结果、警告、时延和文本摘要。
- `results/summary.json`：按工具/场景聚合的机器可读结果。
- `RESULTS.md`：本轮结论与面向 YouTube Digest 的建议。

## 判定口径

有字幕场景必须实际拉回至少一个规范化片段；只发现 `captionTracks` 不算成功。无字幕场景必须明确返回 `no_transcript`。人工/自动字幕使用同一语言代码时，必须分别指定轨道类型：

- `yt-dlp` 使用 `--write-subs` 与 `--write-auto-subs` 区分。
- `youtube-transcript-api` 读取 `is_generated` 后选择轨道。

`yt-dlp` 的 `json3.events[].segs[].utf8` 与 `youtube-transcript-api` 的 `FetchedTranscriptSnippet` 都被映射为 `{start, duration, text}`。跨工具对比只比较规范化后的计数和摘要，不保存字幕正文。
