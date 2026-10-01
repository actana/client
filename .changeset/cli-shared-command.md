---
"@actana/cli": minor
---

Add `actana shared`: `ls`, `get`, `put`, `rm` and `mkdir` on `[<core>:]<path>`, and `watch [<core>] [--since <cursor>] [--json]`, which prints one change per line (NDJSON with `--json`) and resumes from a cursor. The command is written against the `CoreShared` interface of `@actana/sdk/shared` and reaches it through one factory; the default, through-the-Core mode, is a stub that exits 3 until client PR 39 lands. A new command, so minor, and no existing command changes.
