# `actana files`

A Core's files, from the command line (client issue 10, on the Core's Files API at the home folder: control #557). `actana files --help` is the reference; this page says what the help does not.

```
actana files ls [<core>:][<path>] [--depth <n>|all] [--sha256]
actana files get <[<core>:]<path>> [<local-file>]
actana files put <[<core>:]<path>> [<local-file>|-]
actana files rm <[<core>:]<path>>
```

There is no project argument and no project in any route. A 0.5.0 Core has one home folder (`~`, the home of the user it runs Sessions as), and every path is relative to it.

## Which Core

`<core>:` is a name in the registry, the same one `--core` takes, resolved by the same code as every other noun (`--core`, then `ACTANA_CORE_BLOB`, then `actana core use`). A prefix and `--core` that name different Cores are refused. A prefix is a Core name only when it is shaped like one, so `notes/a:b.md` is a path; a leading colon (`:a:b`) says "no prefix". The conventions are the ones of [`actana shared`](cli-shared.md); the two commands differ only in what the path is relative to (the home folder here, the Shared folder, `~/shared`, there).

## Paths

Relative to the home folder. A path ending in `/` is a folder, anything else a file. `ls` with no path lists the home itself, one level deep; `--depth 3` goes deeper and `--depth all` lists the whole tree. `--sha256` adds each file's digest, which means the Core reads every byte, so it is off by default. `rm` of a folder takes its contents with it and needs the trailing slash (`rm reports` is refused by the Core; `rm reports/` deletes the folder). The home itself cannot be deleted. `put` creates missing folders.

A `..` segment, an absolute path, a backslash or a NUL byte exit 2 before any connection is made (the SDK's `homePathRefusal`, the same checks and codes as the Core's own). A path that passes those and still resolves outside the home (a symlink that leaves it) is refused by the Core with `outside-project-root`, and also exits 2.

## Output and exit codes

Data on stdout; confirmations and failures on stderr; with `--json`, one document on stdout (an `{"error": …}` document on failure, except for `get`, whose stdout is the file). Exit 0 worked, 1 did not work (a missing path, a refusal, a Core that did not answer), 2 the command line was wrong, which includes a path the Core would refuse.

`get` streams text to stdout. A binary file wants a `<local-file>` or `--json` (the bytes as base64). `put` streams a `<local-file>` to the Core; stdin is read as text. A folder is not a file: `get` of one fails, and `put` onto a non-empty folder is refused by the Core (`directory-in-the-way`).

## In the SDK

`CoreClient.files` has the same four calls (`list`, `download`, `upload`, `remove`) on the same routes (`/v1/files`, `/v1/files/list`), streaming, and refuses unsafe paths before a request is sent. `client.project(id).files` and `CoreProject` are gone.
