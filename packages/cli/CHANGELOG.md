# @actana/cli

## 0.6.0-next.8

### Patch Changes

- 971b667: Export what a host needs to bind a port and to test it from the package root (actana/client#11). The published code tells errors apart with `instanceof`, which is class identity, so a host that could not import `SessionWriteRefused` could not throw the class `session attach` looks for, and the lock-loss path answered as if an unknown error had come back. The root now exports every class the package tests with `instanceof` (`SessionWriteRefused`, `SessionGatewayError`, `SharedUnavailableError`, `ReportWaitTimeoutError`, and the SDK's `PairingError`, `CorePairingError`, `CoreLinkRequestError`, `CoreSessionAttachError`, `CoreSessionLinkLostError`, `CoreSessionTurnTimeoutError`, `CoreFilesRequestError`, `CoreFilesUnavailableError`, `CoreSharedError`, `CoreSharedPartialError`, `SearchApiError`, re-exported so they are the copy this package resolved), the orchestration skill payload constants (`ORCHESTRATION_SKILL_FILES`, `ORCHESTRATION_SKILL_NAMES`, `ORCHESTRATION_SKILL_MARKER`), the exit codes, `KNOWN_HARNESSES`, `CORE_BLOB_ENV`, `SESSION_LOCKED_ERROR_CODE` and `nonInteractiveTerminal`. A test fails when a new `instanceof` class is not exported. The skill now teaches `actana files` (it already taught `actana shared`), and `skill-verbs-exist` holds both nouns. No behaviour of any verb changes.

## 0.6.0-next.7

### Minor Changes

- 326990c: Restore the Control CLI behaviour that 0.6.0-next.5 and next.6 changed (actana/client#11, ported from actana/control at `feat/0.5.0`).

  **Behaviour change for anyone on a 0.6.0 prerelease: `actana session send` presses Enter again.** On next.5 and next.6 a send wrote the text and no carriage return, and `--enter` was what submitted it. Control's CLI has pressed Enter by default since #404, and a Core's orchestration scripts rely on it, so the default is Control's again: the text goes out, then a carriage return as its own write. `--no-enter` types without submitting, says on stderr that no turn was started, and cannot be combined with `--wait`. `--enter` is accepted and changes nothing on a send that carries text (a bare `send <id> --enter` is still a bare return), and `--enter` together with `--no-enter` is refused. A script that passed `--enter` keeps working; a script that relied on next.5's "no return" must now pass `--no-enter`.

  - `session send --json` keeps Control's `enter` (the request) and `submitted` (the outcome) beside `delivered` and `failed`; the report fields `turn` and `reportPath` are added beside them, never in their place.
  - A plain `send` works without the Shared folder. When `openShared` cannot attach, or the Core has no Shared folder, the text and the return still go out and one stderr line says no report block was appended. The report contract is unchanged when the folder is there (turn numbering, the appended block, `--turn`, `--no-block`, and `send --wait` settling on the report file). The Core appends the standard block only to a Session's starting prompt (control `pty-manager.ts`, issue 563), never to a follow-up write, so `send` appending its own turn's block cannot double it, and a text that already carries a block is left alone.
  - `session wait` and `send --wait` fall back to Control's status-based wait when there is no Shared folder (`openShared` cannot attach, or the folder cannot be listed): the Core stamps the delivery, the wait settles on the first status after it, `send --wait` defaults to 1020 seconds there, and one stderr line says the status-based wait was used and why. With the folder, the report-file wait stays the default. `--turn` names a report file, so on the fallback it is refused rather than ignored.
  - `--wait-timeout 0` means no deadline on `session start`, `resume`, `send --wait` and `wait`, as in Control; a negative value is still refused.
  - `--model`, `--search`, `--external-id`, `--provider`, `--template`, `--dimensions`, `--base-url`, `--top-k`, `--keyword-weight` and `--key-stdin` are unknown flags on every noun but `search`, as on Control's CLI, instead of being accepted and ignored.
  - The session help names `--no-enter` and carries Control's account of what submits a send, and the skill no longer says `--enter` is what submits. A new test holds every flag the skill shows to the parser.

  Control's pinned tests for the whole `session` noun (all 73), the flag table and `session attach` (lock loss, Ctrl-C, keystroke count, no resize after the lock is lost, which already held) are carried into this repository as table-driven parity tests, so the next drift fails here.

## 0.6.0-next.6

### Patch Changes

- 6ce992c: Export the runtime port implementations `entry.ts` binds from the package root, so a host can build a complete `ClientDeps` without copying client code: `probeCore`, `connectCore`, `sdkCorePairing`, `openSessionGateway`, `openCoreShell`, `openSessionAttach`, `openSharedThroughCore`, `openFilesAtHome`, `terminalFromProcess` and `nodeClientPrompts`. Until now only their types were exported, and the package exports map has only the root. No behaviour changes.

## 0.6.0-next.5

### Minor Changes

- 80bbf4b: Bring `@actana/cli` up to the client-side behaviour Control ships in its own CLI (actana/client#11, ported from actana/control at `feat/0.5.0`, not rewritten). `actana session start|resume --await-prompt` blocks until the Core reports the starting prompt delivered, and `--json` carries `promptDelivered` (`true`, `false`, or `null` for "not known") on every path with the prompt-abandoned, not-yet, unknown and unverified lines on stderr. `events tail` gains Control's `--kind` newest-n walk, the `--limit` read-to-the-end rule and the 30s deadline on a Core that stops answering. The Core pointer is read from `current.json` first and from `current.txt` when the JSON names no Core, which is what Control writes until actana/control#580. The orchestration skill teaches `--await-prompt`, and its JSON is a static import so a CommonJS bundle no longer crashes at start. `@actana/cli` now exports its ports and `ClientDeps`. Breaking below 1.0, hence minor: `SessionGateway.send` answers `SendResult` instead of a boolean, and `StartedSession` carries `promptAbandoned`, `promptDeliveryReport` and `awaitPromptDelivery`, so a host that binds its own gateway must return them (Control's already does). `session send --json` gains a `failed` key (`"text"` or `"carriage-return"`) on a failed write, and a half-delivered send says not to resend the text.

## 0.6.0-next.4

### Minor Changes

- 5bba7f7: Add `actana files ls|get|put|rm [<core>:]<path>`, relative to the Core's home folder, and re-address the SDK's Files client at the Core's `/v1/files` routes (control #557). The SDK's `client.project(id)` and `CoreProject` are replaced by `client.files` (`list`, `download`, `upload` and the new `remove`); no Project id is sent anywhere, and `..` or an absolute path is refused before any request. This breaks callers of `client.project(id).files` below 1.0, so both packages are minor; a 0.5.0 Core answers the new routes, a 0.4 Core does not.

### Patch Changes

- Updated dependencies [5bba7f7]
  - @actana/sdk@0.6.0-next.4

## 0.6.0-next.3

### Patch Changes

- Updated dependencies [e77de32]
  - @actana/sdk@0.6.0-next.3

## 0.6.0-next.2

### Minor Changes

- 108286d: Add `actana shared`: `ls`, `get`, `put`, `rm` and `mkdir` on `[<core>:]<path>`, and `watch [<core>] [--since <cursor>] [--json]`, which prints one change per line (NDJSON with `--json`) and resumes from a cursor. The command is written against the `CoreShared` interface of `@actana/sdk/shared` and reaches it through one factory; the default, through-the-Core mode, is a stub that exits 3 until client PR 39 lands. A new command, so minor, and no existing command changes.
- 108286d: `actana session send` appends the standard report block to the text it types, naming the report path of that turn, and `actana session wait` and `send --wait` settle on that report file (`sessions/<id>/report-<turn>.md` ending with `ACT-REPORT-END`) through the Shared watcher, not on a screen or a status; both take `--turn`. `actana shared` reaches a paired Core through the Core by default. The shipped orchestration skills (`actana-sessions`, `actana-subagent`, `await.sh`) document only this contract: the `.actana/reports` convention and `core exec` polling are gone. Breaking below 1.0, so minor: `session wait` and `send --wait` no longer print the Session id or report a status, they print the report path (or, with `--json`, `sessionId`, `turn`, `reportPath` and `report`).

### Patch Changes

- Updated dependencies [108286d]
- Updated dependencies [108286d]
  - @actana/sdk@0.6.0-next.2

## 0.6.0-next.1

### Minor Changes

- 134d113: Remove Projects from the core-link protocol and the CLI (actana/client#10 part 3, ADR 0041 D1–D2). Drop `projectsList` / `projectsMutate` and every `project:*` event, drop `projectId` on session rows and spawn, drop `cwd` on harness spawn. `CORE_LINK_PROTOCOL_VERSION` stays at 0.19.0: that minor already covers the Shared-folder frames (client#4 / PR 33); no published SDK carries 0.19.0, so both wire changes share it. Delete the `actana project` command and every project argument; `session start` takes a Core, a harness and a prompt only. `session ls` never dials a project frame. File transfer left the CLI with Projects (no `project cp`); part 4 lands `actana files`. A bare `actana session start web "…"` now treats `web` as the start of the prompt. Hard cut below 1.0, so the bump is minor (not major). The Files HTTPS URL stays for part 4.

### Patch Changes

- Updated dependencies [134d113]
- Updated dependencies [134d113]
- Updated dependencies [134d113]
  - @actana/sdk@0.6.0-next.1

## 0.6.0-next.0

### Minor Changes

- ad92934: Rename Task to Session across the CLI: `session start|resume|logs|send|kill --json` print `sessionId` and no longer carry `taskId`, `actana events` labels a session's events `session=<id>` and filters on the `session:*` kinds, and the CLI calls the renamed SDK (`sessionRowsList`, `archivedSessionRowsList`, `findBySession`). This is a hard cut with no `taskId` alias, so scripts that read `.taskId` from `--json` must read `.sessionId`; the CLI now speaks core-link 0.18.0 and refuses a 0.17 Core at the version gate.

### Patch Changes

- Updated dependencies [ad92934]
- Updated dependencies [ad92934]
- Updated dependencies [ad92934]
- Updated dependencies [ad92934]
  - @actana/sdk@0.6.0-next.0

## 0.5.0

### Minor Changes

First release from [`actana/client`](https://github.com/actana/client) at **0.5.0**, continuing from Control's `@actana/cli@0.4.5`.

- Packable `dist/` build with `prepack`, `publishConfig.exports`, and `bin/actana.mjs` wired to compiled entry.
- `runClient` dispatcher with general help and version; Core nouns (`core`, `project`, `harness`, `events`, `session`) and Search nouns (`search`).
- Product-keyed credential registry under `~/.config/actana` with one-release migration from `~/.actana-search/cli.json` (T-216).
