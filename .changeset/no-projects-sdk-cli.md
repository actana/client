---
"@actana/sdk": minor
"@actana/cli": minor
---

Remove Projects from the core-link protocol and the CLI (actana/client#10 part 3, ADR 0041 D1–D2). Drop `projectsList` / `projectsMutate` and every `project:*` event, drop `projectId` on session rows and spawn, drop `cwd` on harness spawn, and bump `CORE_LINK_PROTOCOL_VERSION` from 0.18.0 to 0.19.0 so a 0.18 Core and this build refuse each other at the version gate. Delete the `actana project` command and every project argument; `session start` takes a Core, a harness and a prompt only. Hard cut below 1.0, so the bump is minor (not major). The Files client and `/v1/projects/:id/files` stay for part 4.
