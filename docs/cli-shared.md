# `actana shared`

The Shared folder of a Core, from the command line (client issue 7). It lets an orchestrator send work, watch, and read reports with no `core exec`: files go in and out of the folder, and `watch` says when something changed. `actana shared --help` is the reference; this page says what the help does not.

```
actana shared ls [<core>:][<path>]
actana shared get <[<core>:]<path>> [<local-file>]
actana shared put <[<core>:]<path>> [<local-file>|-]
actana shared rm <[<core>:]<path>>
actana shared mkdir <[<core>:]<path>>
actana shared watch [<core>] [--since <cursor>|start] [--limit <n>] [--json]
```

## Which Core

`<core>:` is a name in the registry, the same one `--core` takes, resolved by the same code as every other noun (`--core`, then `ACTANA_CORE_BLOB`, then `actana core use`). A prefix and `--core` that name different Cores are refused. A prefix is a Core name only when it is shaped like one, so `notes/a:b.md` is a path; a leading colon (`:a:b`) says "no prefix".

## Paths

Relative to the Shared folder. A path ending in `/` is a folder, anything else a file. `ls` with no path lists the root. `rm` of a folder takes its contents with it; `mkdir reports` makes the folder `reports/`. Paths the `CoreShared` interface refuses (`..`, absolute, empty segments) exit 2, checked with the interface's own parser before any connection is made.

## Output and exit codes

Data on stdout; confirmations and failures on stderr; with `--json`, one document on stdout (an `{"error": …}` document on failure, except for `get` and `watch`, whose stdout is data). Exit 0 worked, 1 did not work, 2 the command line was wrong, 3 this build cannot do it yet.

`get` writes text to stdout. A binary file wants a `<local-file>` or `--json` (the bytes as base64). `put` reads stdin as text; a binary file wants a `<local-file>`.

## Watch

`watch` polls `CoreShared.watch(since)`. With no `--since` it starts from now, like `tail -f`; `--since start` prints everything. A change is one line, `path  kind  size  time` or `path  deleted`. With `--json` it is one object per line: `path`, `kind`, `deleted`, `size` and `modifiedAt` where present, and `cursor`.

The lines of one poll share the cursor that names the position after all of them. Resume with `--since <cursor>` only once every line carrying that cursor has been handled. `--limit n` stops after the poll that holds the nth change and prints all of that poll, so the cursor on its lines never skips a change. A failure stops the command and prints `Resume with --since <cursor>` on stderr. Folder changes are hints: the interface only promises every file change.

## Modes

The command knows only the `CoreShared` interface. `src/core/shared-gateway.ts` holds the one factory (`OpenSharedFn`) that picks the mode. The through-the-Core mode (client PR 39) is the default for a paired Core: `openSharedThroughCore` sends Files requests to the blob's HTTPS origin with its mTLS material and bearer, and replays the Core's `shared:changed` events for `watch`. The tests bind a test double, or inject a fake link and sender into `createOpenSharedThroughCore`.
