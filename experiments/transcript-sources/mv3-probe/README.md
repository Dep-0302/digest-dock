# MV3 service worker probe

This isolated experiment asks one narrow question: can a real Manifest V3
extension service worker, with YouTube host permissions but no API key, Cookie,
or proxy, call non-WEB InnerTube player clients and then retrieve `json3`
timedtext?

It reimplements only the small request idea observed in
`youtube-caption-extractor` 1.10.2: IOS, ANDROID_VR, and MWEB client profiles.
No third-party transcript package or transcript body is copied into the
extension or production code. Browser-forbidden `User-Agent` and `Origin`
spoofing is deliberately omitted, because this probe measures deployable MV3
behavior rather than Node behavior.

## Run

```sh
npm --cache /tmp/youtube-digest-mv3-npm-cache install --ignore-scripts --no-audit --no-fund
npm run probe
```

The runner launches `/Applications/Google Chrome.app` headlessly with an
unpacked extension and a fresh temporary profile, adds `--no-proxy-server`,
waits at most eight seconds for the service worker, and removes the profile on
exit. It never opens or modifies the user's normal Chrome profile.

The fixed smoke corpus is two positive samples and one negative boundary:

- `jNQXAC9IVRw`: short authored English captions
- `KLDVxx4TqcE`: long English ASR captions
- `4OEG33NfEK0`: public spoken video with no advertised caption tracks

Results are written to `results/latest.json` and `results/latest.md`. Persisted
evidence is limited to classifications, counts, timings, HTTP status/byte
counts, language metadata, and SHA-256. Transcript text, caption URLs/query
strings, player payloads, tokens, request bodies, and browser profiles are not
saved.

Branded Chrome may ignore command-line side-loading in recent releases. If the
service worker is not observable, that is recorded as the experiment blocker;
the runner does not download another browser or fall back to a user profile.

## Observed result (2026-08-18)

The sandboxed smoke reached browser process launch but not CDP attachment:
Google Chrome 151 exited with `SIGABRT` before any extension service worker was
observable. A narrowly scoped elevated retry was rejected by the host because
the active global boundary forbids script-launching system Chrome. Per that
boundary, no workaround, downloaded test browser, headed retry, or user-profile
fallback was attempted.

This is a **tooling / launch-policy blocker**, not evidence that the extension
loaded and failed. There were zero InnerTube or timedtext attempts, so this run
does not establish whether branded Chrome 151 accepts `--load-extension`, nor
whether IOS, ANDROID_VR, or MWEB works from a real MV3 service worker.
