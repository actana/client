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
