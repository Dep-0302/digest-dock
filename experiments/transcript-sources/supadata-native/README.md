# `supadata-native` experiment wrapper

This fixture wrapper exists to compare the production Supadata route under the
same strict result contract. It always uses the canonical YouTube watch URL,
`text=false`, and `mode=native`. It sends nothing until `consent === true` for
that one call.

The wrapper deliberately performs no real request in normal tests. Tomorrow's
strict single-provider check can use the standalone unpacked extension in
`manual-probe/`. Its key field is never stored and the explicit button is the
consent action for that one attempt. DigestDock's existing side-panel flow
remains the product comparison. A configured key is never standing consent.

The action popup only opens a stable extension tab. The real request and any
long-job polling run in that tab so closing a transient popup cannot discard a
possibly billed result.
