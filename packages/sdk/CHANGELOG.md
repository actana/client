# @actana/sdk

## 0.6.0-next.0

### Minor Changes

- ad92934: Add the Node-free `@actana/sdk/core/link-frames` subpath (frame types, schemas and constants) and mark the package `sideEffects: false`, so browser bundles no longer pull undici, ws or Node builtins.
- ad92934: Pairing stores now charge an attempt only when the code does not match. `claimAttempt` still reserves an attempt so the cap holds under races, and the new `PairingStore.releaseAttempt` hands it back when the code matches, so a right code after four wrong ones pairs and a right code with a bad CSR costs nothing. Custom `PairingStore` implementations must add `releaseAttempt`.
- ad92934: Rename Task to Session across the SDK: `taskId` is now `sessionId` in every type, frame and event, the `task:*` event kinds are `session:*`, the row frames are `sessionRowsList`, `archivedSessionRowsList`, `sessionsMutate` and `findBySession`, and `CORE_LINK_PROTOCOL_VERSION` moves from 0.17.0 to 0.18.0. This is a hard cut with no `taskId` alias and no dual-read, so a 0.18 SDK and a 0.17 Core refuse each other at the version gate.

### Patch Changes

- ad92934: `createPairing` takes optional `audit`, `logger` and `bearerDays` options, so a host gets Control 0.4.5's pairing audit (`pairing.attempt`), revocation logs (`core-pairing.revocation.unreadable`, `pairing.revoked`) and bearer lifetime back. `startRevocationSweep()` also returns a `ready` promise that settles once the first read has seeded the revoked set. Left unset, nothing changes.

## 0.5.0

### Minor Changes

First release from [`actana/client`](https://github.com/actana/client) at **0.5.0**, continuing from Control's `@actana/sdk@0.4.5`.

- Six explicit export subpaths (`./pairing`, `./core`, `./search`, pairing server and stores) — no root barrel and no `./*` catch-all.
- Published tarball ships compiled `dist/` JavaScript and type declarations (`publishConfig.exports`).
- Pairing library, core-link client, and Search contracts extracted from Control for shared use by CLI and Search phase 3.
