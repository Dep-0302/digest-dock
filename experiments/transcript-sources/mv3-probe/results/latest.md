# MV3 service worker transcript probe

- Result: **blocked** — system-chrome-launch-policy-blocker
- Browser: Google Chrome 151.0.7922.138
- Isolation: fresh temporary profile, removed after run; no user Chrome profile
- Inputs: no API key, no Cookie, no proxy; all extension fetches use `credentials: omit`
- Privacy: no transcript body, caption URL, query token, request body, or player payload is persisted

Reached stage: browser launch before CDP. Sandboxed Chrome exited with `SIGABRT`;
the narrowly scoped elevated retry was rejected because the active global
boundary forbids script-launching system Chrome.

No MV3 service worker, InnerTube request, or timedtext request was observed.
Therefore this is a tooling / launch-policy blocker, not an MV3 or YouTube
failure. Extension side-loading itself remains unverified.
