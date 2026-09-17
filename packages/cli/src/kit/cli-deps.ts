// What the general client CLI needs from the world, as one injected bag.
//
// `ClientDeps` is the client half: streams, terminal, and the ports that reach
// a Core or a Search instance. `MachineDeps` extends it with the fields a
// product built-in needs on its own machine — system port, release fetcher,
// daemon loader — without pulling in `actana-system.ts` or `actana-release.ts`.
//
// `runClient` takes `ClientDeps` and returns an exit code instead of calling
// `process.exit`, so dispatch, flag validation, output and exit codes are all
// exercised by unit tests rather than by a subprocess. The entry shim is the
// only file that knows about `process`.

import type { CliTerminal } from "./cli-terminal.ts";
import type {
  CoreConnectFn,
  CorePairingPort,
  CoreProbeFn,
  OpenCoreShellFn,
  OpenProjectFilesFn,
  OpenSessionAttachFn,
  OpenSessionGateway,
} from "./client-ports.ts";
import type { ActanaSystem, ReleaseFetcher } from "./machine-ports.ts";

/** Harness availability as the Core's PATH probe reports it. */
export type HarnessAvailabilityMap = Record<string, { available: boolean }>;

export type ClientDeps = {
  /** `process.argv.slice(2)`. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  home: string;
  /** Where ordinary output goes. One call per line; the line has no newline on it. */
  out: (line: string) => void;
  /** Where errors and diagnostics go. */
  err: (line: string) => void;
  /**
   * The same two streams, as bytes: written exactly as given, with nothing
   * appended.
   */
  outBytes: (chunk: string) => void;
  errBytes: (chunk: string) => void;
  /**
   * Where `--verbose` goes, when it is on.
   *
   * **Nothing that reaches here has ever held a credential.**
   */
  verbose: (line: string) => void;
  /** Read stdin to end. Only called when a verb was actually told to read it. */
  readStdin: () => Promise<string>;
  /** Whether stdin is a terminal. */
  stdinIsTty: boolean;
  /**
   * Whether **stdout** is a terminal — the whole of the switch between the two
   * shapes `actana pair new` prints.
   */
  stdoutIsTty: boolean;

  /** How `core status` reaches a Core. */
  probe: CoreProbeFn;
  /** How every other Core noun reaches a Core. */
  connect: CoreConnectFn;
  /** How `core pair` reaches a Core with no credential yet. */
  pairing: CorePairingPort;
  /** How the `session` noun reaches a Core. */
  openSessions: OpenSessionGateway;
  /** How `project cp` and `project files` reach a Core's file surface. */
  openFiles: OpenProjectFilesFn;
  /** Epoch ms. Only the bearer-expiry line reads it. */
  now: () => number;
  /** The operator's terminal — raw mode, keystrokes, size, signals. */
  terminal: CliTerminal;
  /** How `core shell` opens a shell on a Core. */
  openShell: OpenCoreShellFn;
  /** How `session attach` reaches a running Session. */
  openAttach: OpenSessionAttachFn;
};

export type MachineDeps = ClientDeps & {
  hostname: string;
  networkInterfaces: NodeJS.Dict<{ address: string; family: string; internal: boolean }[]>;
  platform: NodeJS.Platform;
  arch: string;
  /** The operator's username, for `loginctl`. */
  user: string;
  /** The operator's uid, for the launchd domain. */
  uid: number;
  /**
   * The extracted tarball tree this CLI is running from, when it is running
   * from one.
   */
  installRoot: string;
  /** Whether there is a terminal to prompt on. */
  interactive: boolean;
  system: ActanaSystem;
  /** How `actana install` and `actana update` reach the release channel. */
  fetcher: ReleaseFetcher;
  /**
   * Where the update check's silent failures go.
   *
   * Separate from {@link ClientDeps.err} because they are not the operator's business.
   */
  debug: (line: string) => void;
  /** The Core's own PATH probe — the source of truth for Harness availability. */
  probeHarnesses: () => HarnessAvailabilityMap;
  /** Run the Core daemon in the foreground. In-process, never spawned. */
  runDaemon: (env: Record<string, string>) => Promise<void>;
};
