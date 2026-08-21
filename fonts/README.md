# Bundled time-code font — Barlow Condensed

DigestDock renders time codes (transcript rail, chapters, notes) in **Barlow
Condensed** so long stamps such as `3:02:58` stay compact and use tabular
numerals. The font is loaded **only from the extension package** — there is no
runtime request to Google Fonts or any third party.

## Required files

Place these two WOFF2 subsets next to this README:

| File | Weight | `@font-face` |
| --- | --- | --- |
| `BarlowCondensed-Regular.woff2` | 400 | `font-weight: 400` |
| `BarlowCondensed-Medium.woff2` | 500 | `font-weight: 500` |

The `@font-face` rules live in `sidepanel.css` and `options.css`. Both rules
also list `local("Barlow Condensed")` first, so a system-installed copy is used
without any packaged request, and a condensed system fallback
(`"Arial Narrow"`) keeps the fixed-width time rail correct if the WOFF2 files
are absent.

## Upstream source and license

- Upstream: https://github.com/google/fonts/tree/main/ofl/barlowcondensed
- License: SIL Open Font License 1.1 — see [`OFL.txt`](OFL.txt).

To (re)generate the subsets from the upstream TTFs, keep the Latin glyphs plus
the digits, colon, and space, e.g. with `fonttools`:

```
pyftsubset BarlowCondensed-Regular.ttf \
  --output-file=BarlowCondensed-Regular.woff2 \
  --flavor=woff2 --layout-features='tnum' \
  --unicodes="U+0030-0039,U+003A,U+0020,U+0041-005A,U+0061-007A"
```

Only the WOFF2 files are shipped in the release ZIP (see the release
allowlist in `scripts/check-release.sh`); the OFL text ships alongside them.
