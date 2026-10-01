---
"@actana/sdk": minor
---

Add `@actana/sdk/shared` (Node-only): the `CoreShared` interface (list, get, put, mkdir, rm, move, upload of a folder tree, watch since a cursor, signedUrl) and its direct-S3 mode, `createS3CoreShared`, for a controller that holds the master key and works while the Core is offline. Paths are relative to the Core's prefix and never escape it. A move is copy then delete and reports what a partial failure leaves behind; `watch` polls a listing and returns changes by an opaque cursor; a signed URL never outlives the key. The through-the-Core mode is a later change.
