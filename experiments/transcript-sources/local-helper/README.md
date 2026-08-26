# `local-helper` experiment

This route wraps `youtube-transcript-api` behind a test-only contract. It is not
a production dependency. Its pinned dependency is installed only in the ignored
experiment `.venv`.

Two transports share the same validated request shape:

- `python3 server.py --stdio` for a disabled-by-default JSONL contract shell.
- `python3 server.py --port 8765` for a disabled-by-default Chrome loopback shell.

The standalone unpacked Chrome client for that loopback check is in
`extension/`. It displays its exact `chrome-extension://...` origin, accepts the
pairing token only in a password field, sends one request, clears the field, and
shows a text-free result summary.

The action popup only opens a stable extension tab, so a long loopback request
cannot lose its result when a transient popup closes.

Use **只检查连接** first. It calls authenticated `GET /health`, reports
`networkRequests: 0`, and cannot contact YouTube.

The HTTP mode binds only to `127.0.0.1`, requires an exact Chrome extension
origin and a 32-256 character pairing token, accepts only `POST /v1/transcript`,
and inherits no proxy environment in the live provider session.

Both shells require `--allow-live` before they can contact YouTube. Without it,
transcript requests return `PROVIDER_UNAVAILABLE`; authenticated `GET /health`
still works and reports `networkRequests: 0`.

## Before tomorrow's live run

The isolated `.venv` is already prepared. `bash setup.sh` can recreate it and
never uses global `pip`. Set these two environment variables in the same
terminal that starts the server:

- `DIGESTDOCK_TRANSCRIPT_HELPER_ORIGIN=chrome-extension://<exact-id>`
- `DIGESTDOCK_TRANSCRIPT_HELPER_TOKEN=<fresh-random-token>`

Do not paste the token into chat, a source file, a report, a URL, or a commit.
The client passes it only in `X-DigestDock-Helper-Token`.

The offline contract tests do not import or call the third-party package:

```text
python3 -m unittest test_server.py
```
