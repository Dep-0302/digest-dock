# Provider brand icon provenance

DigestDock shows each AI provider's official brand icon next to its name in the
options-page provider picker. Per the project rules these icons must come only
from each provider's official website, official brand-resource page, or official
developer documentation. They must be bundled locally (never hot-linked or
loaded from a remote URL at runtime), must keep the official shape, ratio, and
color, and must never be hand-drawn, traced, or substituted with a third-party
icon set.

Each row below records the official brand-source URL to obtain the asset from,
the local filename referenced by `ai-providers.js` (`iconPath`), the exact asset
URL observed on that official page, and any format-only transformation.

## Bundled assets

| Provider | iconPath | Official brand source | Retrieved | Format | Transform | Status |
|---|---|---|---|---|---|---|
| DeepSeek | `icons/providers/deepseek.png` | Page: https://www.deepseek.com/ · Asset: https://www.deepseek.com/favicon.ico | 2026-08-22 | PNG | Official ICO converted to PNG; no crop, recolor, or redraw | bundled |
| 智谱 GLM (Zhipu) | `icons/providers/zhipu.png` | Page: https://www.bigmodel.cn/ · Asset: https://static.bigmodel.cn/wd-paas-front/static/images/favicon.png | 2026-08-22 | PNG | none | bundled |
| 阿里云百炼 Qwen | `icons/providers/dashscope-qwen.png` | Canonical page: https://www.aliyun.com/product/bailian · Observed page: https://cn.aliyun.com/product/bailian · Asset: https://img.alicdn.com/tfs/TB1_ZXuNcfpK1RjSZFOXXa6nFXa-32-32.ico | 2026-08-22 | PNG | Official Alibaba Cloud ICO converted to PNG; no crop, recolor, or redraw | bundled |
| SiliconFlow | `icons/providers/siliconflow.png` | Page: https://www.siliconflow.cn/ · Asset: https://www.siliconflow.cn/favicon.ico | 2026-08-22 | PNG | Source is PNG data served with `.ico` path; extension normalized only | bundled |
| Fireworks AI | `icons/providers/fireworks.svg` | Page: https://fireworks.ai/ · Asset: https://fireworks.ai/icon0.svg?e3d99deadffb6216 | 2026-08-22 | SVG | none; inspected for scripts, event handlers, and external references | bundled |
| 腾讯混元 (API fail-closed) | `icons/providers/tencent-hunyuan.svg` | Page: https://hunyuan.tencent.com/ · Asset: https://hunyuan-blog-web-prod-1258344703.cos.ap-guangzhou.myqcloud.com/logo.svg | 2026-08-22 | SVG | none; inspected for scripts, event handlers, and external references | bundled |

## Verification notes

- Every asset was discovered by reading the official page's declared favicon or
  official Logo image URL. No search-result thumbnail or third-party icon source
  was used.
- The Alibaba entry intentionally uses the official Alibaba Cloud mark exposed by
  the Bailian product page; the unrelated light-bulb feature illustration on the
  same page was rejected.
- The Tencent entry uses the official Tencent Hunyuan site's own `logo.svg`; a
  QR-code graphic and generic Tencent Cloud favicon were rejected.
- The Provider picker retains the provider name beside every icon, so forced
  colors, failed image rendering, and screen readers do not rely on the Logo
  alone.
- Tencent's official model name is `hunyuan-translation-lite`; the earlier
  `Hy-MT2-Lite` label was not retained as an API model ID. The preset remains
  fail-closed because the official material does not verify that translation
  model on the extension's single-key OpenAI-compatible route. Its official
  brand icon is bundled independently and does not make the preset selectable.
