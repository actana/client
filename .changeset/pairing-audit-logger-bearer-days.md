---
"@actana/sdk": patch
---

`createPairing` takes optional `audit`, `logger` and `bearerDays` options, so a host gets Control 0.4.5's pairing audit (`pairing.attempt`), revocation logs (`core-pairing.revocation.unreadable`, `pairing.revoked`) and bearer lifetime back. `startRevocationSweep()` also returns a `ready` promise that settles once the first read has seeded the revoked set. Left unset, nothing changes.
