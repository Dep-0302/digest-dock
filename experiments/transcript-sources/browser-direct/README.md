# Browser-direct transcript source experiment

This experiment measures what a signed-out desktop YouTube page exposes without
Supadata or another transcript API. It does not load the production extension.

See [`RESULTS.md`](./RESULTS.md) for the conclusion from the recorded 2026-08-18
run and `results/latest.md` / `results/latest.json` for its direct evidence.

It keeps three outcomes separate:

1. `captionTracks` discovery from `movie_player.getPlayerResponse()`;
2. a direct fetch of the advertised raw `baseUrl` (default, `json3`, and `srv3`);
3. fetches derived from the player's real timedtext resource, including observed
   `pot`/`c` parameters.

The runner also records whether it had to select a track through the player API or
click the visible CC button, the before/after CC state, and a real watch-to-watch SPA
navigation. Transcript text, signed URLs, signature values, PO token values, login
cookies, and user Chrome profile data are never written to disk.

## Run

This worktree does not install Playwright. Use an existing Playwright package and
the system Chrome binary. In the Codex desktop workspace used for the recorded run:

```sh
NODE_PATH=/Users/wangchao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
  node experiments/transcript-sources/browser-direct/run.cjs
```

Playwright launches Chrome with a newly created temporary profile. The script
passes an explicitly empty initial `storageState`, does not load extensions, and
uses `credentials: "omit"` for every direct timedtext comparison fetch.

Optional bounded waits:

```sh
YD_WAIT_AFTER_DOM_MS=8000 \
YD_WAIT_AFTER_CAPTION_ACTION_MS=5000 \
NODE_PATH=/path/to/node_modules \
  node experiments/transcript-sources/browser-direct/run.cjs
```

Outputs are overwritten on each run so that stale evidence is not mistaken for the
latest observation:

- `results/latest.json`: complete structured evidence;
- `results/latest.md`: compact comparison table and interpretation;
- `logs/latest.ndjson`: lifecycle/error log without transcript or token content.

## Current corpus slice

The default matrix intentionally covers different failure boundaries:

- `jNQXAC9IVRw`: short authored English;
- `iG9CE55wbtY`: authored English and English ASR coexist; the test requests ASR;
- `KLDVxx4TqcE`: long ASR-only video previously observed to expose a track while
  returning an empty direct timedtext body;
- `4OEG33NfEK0`: spoken public video with no advertised caption tracks;
- `aqz-KE-bpKQ`: stable non-verbal/no-caption negative control.

YouTube can change captions, player parameters, or token policy at any time. Re-run
the experiment before using its output as implementation evidence.
