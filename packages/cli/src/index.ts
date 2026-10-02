export {
  runClient,
  runActanaCli,
  NOT_HANDLED,
  clientHelp,
  CLI_VERSION,
  CLIENT_NOUNS,
  USAGE,
  type RunClientOptions,
} from "./run-client.ts";
export type { ClientDeps, MachineDeps, ClientPrompts, HarnessAvailabilityMap } from "./kit/cli-deps.ts";
export type { CliTerminal } from "./kit/cli-terminal.ts";
export type * from "./kit/client-ports.ts";

// The runtime implementations `entry.ts` binds, so a host (Control's built-in CLI) can build a complete
// `ClientDeps` and call `runClient(argv, deps)` without copying client code. Bind each one into the
// field of the same purpose, or replace it with its own.
export { probeCore } from "./core/core-probe.ts"; // ClientDeps.probe
export { connectCore } from "./core/core-connection.ts"; // ClientDeps.connect
export { sdkCorePairing } from "./core/core-pair.ts"; // ClientDeps.pairing
export { openSessionGateway } from "./core/session-gateway.ts"; // ClientDeps.openSessions
export { openCoreShell } from "./core/core-shell-channel.ts"; // ClientDeps.openShell
export { openSessionAttach } from "./core/session-attach-channel.ts"; // ClientDeps.openAttach
export { openSharedThroughCore } from "./core/shared-gateway.ts"; // ClientDeps.openShared
export { openFilesAtHome } from "./core/files-gateway.ts"; // ClientDeps.openFiles
export { terminalFromProcess } from "./kit/cli-terminal.ts"; // ClientDeps.terminal
export { nodeClientPrompts } from "./kit/node-system.ts"; // ClientDeps.system

// ── What a host needs to bind a port and to test it (client issue 11 follow-up) ─────────────────────────
//
// The published code tells errors apart with `instanceof`, which compares *class identity*: a host that
// throws its own copy of a class, or an SDK class from a second install of `@actana/sdk`, is not
// recognised, and the verb behaves as if an unknown error had come back. Every class the package tests
// that way is therefore exported from here, so a host's port (or its test double) throws the very class
// the verbs look for. The SDK's classes are re-exported rather than left to the host's own import, so
// they are the copy this package resolved, whatever the host's lockfile did.

// Defined in this package.
export { SessionWriteRefused } from "./core/session-attach-channel.ts"; // `session attach`: the lock was lost
export { SessionGatewayError } from "./core/session-gateway.ts"; // every `session` verb: a Core refusal
export { SharedUnavailableError } from "./core/shared-gateway.ts"; // `shared`: this build has no such mode
export { ReportWaitTimeoutError } from "./core/session-report-wait.ts"; // `session wait`: this side gave up

// Defined in `@actana/sdk`, as this package resolved it.
export { PairingError, CorePairingError } from "@actana/sdk/pairing"; // `core pair`, `search pair`
export {
  CoreLinkRequestError, // `session attach`: SESSION_LOCKED_ERROR_CODE
  CoreSessionAttachError, // `session wait`, `send --wait`: no live PTY
  CoreSessionLinkLostError, // the status wait: the link dropped
  CoreSessionTurnTimeoutError, // the status wait: this side's deadline
  CoreFilesRequestError, // `files`: a path the Core refused
  CoreFilesUnavailableError, // `files`: this Core has no such capability
  SESSION_LOCKED_ERROR_CODE,
} from "@actana/sdk/core";
export { CoreSharedError, CoreSharedPartialError } from "@actana/sdk/shared"; // `shared`, the report wait
export { SearchApiError } from "@actana/sdk/search"; // `search`

// Constants a host binds or tests against.
export {
  EXIT_OK,
  EXIT_FAILURE,
  EXIT_USAGE,
  EXIT_UNIMPLEMENTED,
  EXIT_LINK_LOST,
  EXIT_PAIR_UNREACHABLE,
  EXIT_PAIR_NOT_PAIRABLE,
  EXIT_PAIR_NO_CA,
  EXIT_PAIR_FINGERPRINT_UNCONFIRMED,
  EXIT_PAIR_FINGERPRINT_MISMATCH,
  EXIT_PAIR_HOSTNAME_MISMATCH,
  EXIT_PAIR_CERTIFICATE_INVALID,
  EXIT_PAIR_REFUSED,
  EXIT_PAIR_RATE_LIMITED,
  EXIT_PAIR_REJECTED,
  EXIT_PAIR_CORE_ERROR,
  EXIT_PAIR_SEARCH_ERROR,
  EXIT_PAIR_MALFORMED_RESPONSE,
} from "./kit/exit-codes.ts";
export { KNOWN_HARNESSES } from "./core/session-gateway.ts";
export { CORE_BLOB_ENV } from "./core/core-resolution.ts";
export {
  ORCHESTRATION_SKILL_FILES, // the skill folders `harness skills` installs, path to bytes
  ORCHESTRATION_SKILL_NAMES,
  ORCHESTRATION_SKILL_MARKER,
} from "./core/orchestration-skill-payload.ts";
export { nonInteractiveTerminal } from "./kit/cli-terminal.ts"; // a `CliTerminal` for a host's tests
