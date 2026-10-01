---
"@actana/sdk": minor
---

Rename Task to Session across the SDK: `taskId` is now `sessionId` in every type, frame and event, the `task:*` event kinds are `session:*`, the row frames are `sessionRowsList`, `archivedSessionRowsList`, `sessionsMutate` and `findBySession`, and `CORE_LINK_PROTOCOL_VERSION` moves from 0.17.0 to 0.18.0. This is a hard cut with no `taskId` alias and no dual-read, so a 0.18 SDK and a 0.17 Core refuse each other at the version gate.
