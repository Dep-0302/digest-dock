# Seven-provider YouTube transcript source experiment

This directory contains the shared contract, historical evidence, isolated
dependencies, and tomorrow's manual entrypoints for seven transcript providers.
It remains outside the public DigestDock extension ZIP.

## Fixed providers

| Provider ID | Entry | Current implementation state |
| --- | --- | --- |
| `youtube-passive` | `passive-capture/extension/` | Standalone MV3 observer plus offline tests; live YouTube unverified |
| `youtube-active` | repository root plus `youtube-active/adapter.js` | Existing active adapter plus strict experiment wrapper |
| `youtube-panel` | `browser-panel/manual-probe/` | User-opened panel collector plus historical automated runner |
| `supadata-native` | `supadata-native/manual-probe/` | Direct per-attempt control and fixture wrapper; no request run today |
| `node-libraries` | `node-libraries/` | Pinned dependencies installed locally; live probe not rerun today |
| `local-helper` | `local-helper/` | Token-paired loopback server/client and isolated venv; YouTube unverified |
| `hosted-api-slot` | `hosted-api-slot/` | Fixed-endpoint fixture contract only; no vendor selected |

The YouTube Data API, Downie, ASR, OCR, proxy rotation, and access-control
bypasses are outside this matrix.

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
- Supadata and any later hosted provider require a new visible action for every
  real attempt. Keys/tokens are typed into password fields and are not stored by
  the standalone probes.

## Output

`summary.md` preserves the 2026-08-18 historical baseline. The authoritative
current plan, completion record, subtraction rules, and tomorrow runbook are in
`../../TRANSCRIPT-SEVEN-PROVIDER-EXECUTION.md`.
