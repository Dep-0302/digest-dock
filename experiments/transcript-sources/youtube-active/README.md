# `youtube-active` experiment wrapper

This provider keeps the local extractor inside this experiment as
`youtube-transcript.js` and maps it into the strict comparison contract. The
repository root is free to follow API-primary `main`; the experiment copy never
calls Supadata or another provider after failure.

The isolated `../youtube-verifier/` unpacked extension is the browser test
surface; the production/root DigestDock extension is not. A measured run must
use cache bypass and record the player/timedtext request classes. The active
provider's player and timedtext requests run in the current YouTube tab's
ISOLATED world; the passive MAIN-world observer must not be credited for them.

The accepted and rejected live variants, evidence files, safety checks, and
remaining limits are frozen in `ACTIVE-ACCEPTANCE-2026-08-27.md`.

The wrapper forwards `captionTracks` only when the caller actually supplies
page-track evidence. An omitted field must not be converted into an empty page
track list, because that would change login/unavailable failure classification.
