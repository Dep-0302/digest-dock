# `hosted-api-slot` experiment

No vendor has been selected. This folder therefore contains only a
fixture-tested adapter contract and **cannot make a live request by default**.

A later vendor adapter must fix one exact HTTPS endpoint in source and provide
three functions: `buildRequest`, `parseResponse`, and `mapError`. It must not
expose an arbitrary base URL in user settings, request broad host permissions,
or infer consent from a stored key.

Before this slot becomes live, separately verify the vendor's current API,
pricing, retention/privacy terms, supported transcript modes, response limits,
and authentication requirements. Then add one exact experimental host
permission and repeat the fixture tests with the real response schema. No API
key belongs in this directory, chat, logs, screenshots, or test reports.
