# `session start --await-prompt`, the delivery report, and binding the ports

Client issue 11: `@actana/cli` carries the client-side behaviour Control's own CLI ships, ported from `actana/control` at `feat/0.5.0` (its #395, #483, #494, #495), so that `actana/control` can adopt this package (actana/control issue 580).

## Running is not ready

`start` returns once the Core has spawned the harness, which is before the harness can take a keystroke. A `session send` in that gap lands in a terminal that is not reading and is discarded with the starting prompt. `--await-prompt` (on `start` and `resume`) blocks until the Core says what became of the prompt, and nothing on this side times it: no poll, no retry, no clock. It ends on the Core's `session:promptDelivered` or `session:promptAbandoned` row, on the harness exiting, or on the connection going down.

| The Core said | exit | `promptDelivered` | stderr |
|---|---|---|---|
| delivered, into a composer it saw | 0 | `true` (`composerObserved: true`) | "The Core delivered the starting prompt…" |
| abandoned (`promptAbandonedReason`) | 1 | `false` | "The Core did not deliver the starting prompt…" |
| typed with no composer in sight | 1 | `null` (`composerObserved: false`) | "…cannot vouch for where it landed" |
| nothing: link down, harness gone, Core cannot say where its log ends | 1 | `null` (`promptUnknownReason`) | "The Core did not report what became of…" |

Without the flag, `--json` carries `promptDelivered: null` and stderr says the prompt has not been delivered yet. With `--wait` it carries what the Core said while the turn ran, and an abandoned prompt fails the command. `--await-prompt` is refused with `--wait`, with `--wait-timeout`, and on a prompt the Core would drop (empty, or only spaces and control characters).

## Binding the ports

`@actana/cli` exports `ClientDeps`, `MachineDeps` and every port type the bag names (`OpenSessionGateway`, `SessionGateway`, `SendResult`, `StartedSession`, `PromptDeliveryReport`, `CoreProbeFn`, `CoreConnectFn`, `CorePairingPort`, `OpenCoreShellFn`, `OpenSessionAttachFn`, `OpenFilesFn`, `OpenSharedFn`). `send` answers `SendResult` (`{ ok: true }`, or `{ ok: false, failed: "text" | "carriage-return" }`), so a host can tell a write that is safe to repeat from one that would submit the text twice. `control-ports.test.ts` mirrors Control's gateway shape and fails the typecheck if it stops fitting.

## The Core pointer

`current.json` is the pointer and `current.txt` is the same name in the form Control writes today. Reading prefers `current.json` and falls back to `current.txt` when the JSON names no Core this machine has. The client writes both. Control writes only `current.txt` until issue 580 makes it write both, so on a machine where Control's `core use` ran after the client's, the JSON still wins; run `actana core use` once from this CLI to bring them in line.

## A CommonJS bundle

`orchestration-skill-payload.ts` imports its JSON statically. `orchestration-skill-payload.test.ts` bundles the real entry to CommonJS and starts it in a child process.
