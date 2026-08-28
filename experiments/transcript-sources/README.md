# Seven-provider YouTube transcript source experiment

This directory contains the shared contract, historical evidence, isolated
dependencies, and manual-result entrypoints for seven transcript providers. It
remains outside the public DigestDock extension ZIP. After the user-approved
product simplification, only cache/Passive remains an automatic free route;
Active and Panel are retained as evidence-only experiments. The product
shortlist is now cache/Passive, an explicit user CC retry, and optional
explicit-consent Supadata.

## Fixed providers

| Provider ID | Entry | Current evidence and disposition |
| --- | --- | --- |
| `youtube-passive` | `passive-capture/extension/` | Retain as primary zero-request route; real MV3 accepted with 670 segments and SPA freshness |
| `youtube-active` | `youtube-verifier/` plus `youtube-active/adapter.js` | Evidence only: `isolated-tab` passed bounded standalone cases, but is no longer called by the product flow; both popup-origin variants remain rejected after repeatable 403s |
| `youtube-panel` | `browser-panel/manual-probe/` | Evidence only: manual rendered-panel collection succeeded in a limited sample, but the product no longer opens or scrolls the panel automatically |
| `supadata-native` | `supadata-native/manual-probe/` | Removed from the live shortlist; fixture/history retained only, with no deletion authorization |
| `node-libraries` | `node-libraries/` | Evidence only; `youtube-transcript-plus` is the accepted Node comparator, not a production MV3 dependency |
| `local-helper` | `local-helper/` | Evidence only; real core extraction and authenticated MV3 loopback health accepted, but the companion-process burden is not retained for production |
| `hosted-api-slot` | `hosted-api-slot/` | Removed from the live shortlist; provider-neutral fixture/history retained only, with no deletion authorization |

The YouTube Data API, Downie, ASR, OCR, proxy rotation, and access-control
bypasses are outside this matrix.

The authoritative accepted/rejected variants, evidence levels, dispositions,
and validation dates are recorded in `provider-registry.json`. The current eight
text-free browser results are summarized in `manual-results/REPORT.md`;
expected-negative boundaries are reported separately from unexpected failures.
Here, `accepted` means the single-route evidence was sufficient for shortlist
and experimental integration. It does not mean the combined product chain has
passed Phase 4: the Panel receipt still lacks a saved language-menu signal and
manual text comparison, and the integrated chain still needs its own current
page, first/last coverage, request, and restore receipt.

## Offline verification

These commands must not make external requests:

```bash
cd experiments/transcript-sources
npm test
npm run check

cd node-libraries
npm test

cd ../local-helper
.venv/bin/python -m unittest test_server.py
```

`npm test` uses `shared/no-network-preload.cjs` to block Node fetch, HTTP(S),
DNS, sockets, child processes, and subprocess launches inside the experiment
tests. Live runners remain separate and are never called by normal project
tests, `npm run check`, or packaging.

## Shared comparison dimensions

- public manual captions
- public auto-generated captions
- non-English and multiple caption tracks
- long-form video
- no-caption or unavailable boundary
- SPA navigation freshness where a browser is involved
- success/failure classification
- elapsed time and segment count
- timestamp and text shape
- install size and runtime requirements
- page side effects, credentials, cookies, proxies, or local services required
- maintenance exposure to YouTube private endpoints, client versions, and PO tokens

## Safety and scope

- Implementation and offline tests use no API keys, account cookies, browser
  profiles, proxies, paid requests, or live YouTube transcript requests.
- No attempt to bypass consent, access restrictions, or anti-bot challenges.
- Only public videos and YouTube-provided manual/automatic captions.
- Third-party code stays inside this experiment and is not copied into the
  production extension.
- Supadata and the hosted-provider slot are outside the current live shortlist.
  Their code and fixture evidence remain only because removal was not
  authorized. No key request, paid call, vendor research, or live attempt may
  resume without a new explicit decision.

## Output

`summary.md` preserves the 2026-08-18 historical baseline. The authoritative
current completion record and subtraction decisions are in
`../../TRANSCRIPT-SEVEN-PROVIDER-EXECUTION.md`; the implementation plan is in
`../../TRANSCRIPT-SHORTLIST-EXECUTION.md`.
