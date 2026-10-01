---
"@actana/sdk": minor
---

Add `@actana/sdk/shared-key` (Node-only): the `SharedKeyIssuer` interface, a `createSharedKeyProvider` that refreshes a Core's key 15 minutes before it expires (never more than half its life), and the default SeaweedFS issuer. The controller holds the master signing key and issues each Core a 1-hour S3 key limited to `<prefix>/<core-id>/`; the result carries only the access key, secret, session token and expiry.
