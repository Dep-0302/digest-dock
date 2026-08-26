# `youtube-active` experiment wrapper

This provider keeps the local extractor inside this experiment as
`youtube-transcript.js` and maps it into the strict comparison contract. The
repository root is free to follow API-primary `main`; the experiment copy never
calls Supadata or another provider after failure.

The existing DigestDock implementation remains the browser test surface. A
measured run must use cache bypass and record the player/timedtext request
classes. The active provider's timedtext GET remains in the extension's
ISOLATED world; the passive MAIN-world observer must not be credited for it.
