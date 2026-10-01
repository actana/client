---
"@actana/cli": minor
---

`actana session send` appends the standard report block to the text it types, naming the report path of that turn, and `actana session wait` and `send --wait` settle on that report file (`sessions/<id>/report-<turn>.md` ending with `ACT-REPORT-END`) through the Shared watcher, not on a screen or a status; both take `--turn`. `actana shared` reaches a paired Core through the Core by default. The shipped orchestration skills (`actana-sessions`, `actana-subagent`, `await.sh`) document only this contract: the `.actana/reports` convention and `core exec` polling are gone. Breaking below 1.0, so minor: `session wait` and `send --wait` no longer print the Session id or report a status, they print the report path (or, with `--json`, `sessionId`, `turn`, `reportPath` and `report`).
