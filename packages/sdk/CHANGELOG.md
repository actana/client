# @actana/sdk

## 0.6.0-next.1

### Minor Changes

- 134d113: Add the core-link Shared-folder frames `sharedAttach`, `sharedCredentials` and `sharedDetach`, the `sharedStatus` reply, the `ready.shared` capability, and redacting formatters for the credentials they carry. `CORE_LINK_PROTOCOL_VERSION` moves to 0.19.0.
- 134d113: Remove Projects from the core-link protocol and the CLI (actana/client#10 part 3, ADR 0041 D1–D2). Drop `projectsList` / `projectsMutate` and every `project:*` event, drop `projectId` on session rows and spawn, drop `cwd` on harness spawn. `CORE_LINK_PROTOCOL_VERSION` stays at 0.19.0: that minor already covers the Shared-folder frames (client#4 / PR 33); no published SDK carries 0.19.0, so both wire changes share it. Delete the `actana project` command and every project argument; `session start` takes a Core, a harness and a prompt only. `session ls` never dials a project frame. File transfer left the CLI with Projects (no `project cp`); part 4 lands `actana files`. A bare `actana session start web "…"` now treats `web` as the start of the prompt. Hard cut below 1.0, so the bump is minor (not major). The Files HTTPS URL stays for part 4.
- 134d113: Add `@actana/sdk/shared-key` (Node-only): the `SharedKeyIssuer` interface, a `createSharedKeyProvider` that refreshes a Core's key 15 minutes before it expires (never more than half its life), and the default SeaweedFS issuer. The controller holds the master signing key and issues each Core a 1-hour S3 key limited to `<prefix>/<core-id>/`; the result carries only the access key, secret, session token and expiry.

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
