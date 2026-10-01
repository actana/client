# The report contract (client issue 8)

A Session hands work back by writing a **report file** into the Core's Shared folder (`~/shared` on the Core). `actana session wait` settles on that file, through the Shared watcher, and not on a screen or a status.

## Paths

Relative to the Shared folder (what `actana shared` takes); the Core and the harness say `~/shared/…`.

| What | Path |
| --- | --- |
| a plain Session turn | `sessions/<session-id>/report-<turn>.md` |
| a Task's result | `tasks/<task-id>/success.md`, `fail.md` or `partial-<n>.md` |
| a Task's log of one attempt | `tasks/<task-id>/attempt-<n>.log` |
| an older result, after a re-run | renamed to `attempt-<n>-<name>` |

A report is **finished** when its last non-blank line is exactly `ACT-REPORT-END`. The marker anywhere else does not count. The helpers are in `packages/cli/src/core/session-report.ts`.

## The prompt block

The Core appends a versioned standard block to every starting prompt (control PR 621). It tells the harness that its workspace is `~`, that `~/shared` is shared with the operator, where to write this turn's report and what its last line is, and not to use sudo. A follow-up turn is a raw write on the Core, so `actana session send` appends the **same block** itself, with the path of that turn. The text in `session-report.ts` is the Core's, word for word, and a test pins it; a wording change bumps `PROMPT_BLOCK_VERSION` on both sides.

## Turns

The starting prompt is turn 1. `session send` takes the turn after the highest report already in `sessions/<id>/`, and never 1; `--turn <n>` names one. Two sends before either has reported would take the same number: wait for the first, or give each a `--turn`.

`session wait <id>` with no `--turn` means the latest report there is (one still being written, or the last complete one), or turn 1 when there is none. After a `send` that did not wait, name the turn it printed.

## How the wait settles

1. Take a Shared cursor (`watch()`), **before** the first look and, for `send --wait`, before the text is written.
2. Read the report. If it is there and finished, settle.
3. Otherwise ask `watch(cursor)` until a change to that path is reported, read it again, and settle if it is finished. The file is read when it was reported changed, never on a timer, and nothing runs a command on the Core.

Because the cursor comes first, a report that landed before the wait began (or while the text was being sent) settles it at once. `--wait-timeout <seconds>` is this side giving up; it prints the path it was waiting for and exits 1.

The through-the-Core mode (`actana shared` and these verbs) needs a Core that keeps a Shared folder; without one `wait` and `send` say so on stderr and exit 1.
