---
"@actana/sdk": minor
---

Add the through-the-Core mode of `@actana/sdk/shared`: `createThroughCoreShared` talks to the Core's Files API under `~/shared` (list, get, put, mkdir, delete with trailing slash for folders, move, upload) and watches `shared:changed` events by event-log cursor. Same CoreShared contract suite as the S3 mode; Node-only subpath, no new dependency.
