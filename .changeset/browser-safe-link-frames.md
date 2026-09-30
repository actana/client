---
"@actana/sdk": minor
---

Add the Node-free `@actana/sdk/core/link-frames` subpath (frame types, schemas and constants) and mark the package `sideEffects: false`, so browser bundles no longer pull undici, ws or Node builtins.
