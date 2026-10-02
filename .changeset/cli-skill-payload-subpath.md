---
"@actana/cli": patch
---

Add a payload-only `@actana/cli/skill-payload` subpath export with `ORCHESTRATION_SKILL_FILES`, `ORCHESTRATION_SKILL_NAMES` and `ORCHESTRATION_SKILL_MARKER`, so a bundle that only needs the orchestration skill files no longer pulls in the whole client and `ws`. The package root still exports the same three constants. No behaviour changes.
