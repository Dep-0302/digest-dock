# YouTube auto-read Stage-3 probes

These files are experiment-only and are not referenced by the DigestDock
manifest, background worker, release allowlist, or product message path.

- `selection.js`: Chinese-first / one-language-group target selection.
- `player-activation.js`: records the current caption state, activates one
  target through the page player, waits within the probe budget, and restores
  through one `finally` owner.
- `active-ios-single.js`: a frozen copy of the retained Active experiment,
  reduced to one IOS player request and one json3 timedtext request for both
  success and failure paths.

Mock tests prove only contracts and restoration calls. Route availability is
decided only by headed Chrome evidence. Evidence records contain counts,
statuses, byte sizes, selected-track metadata, and state restoration results;
they must never store transcript text, signed URLs, tokens, cookies, or request
headers.
