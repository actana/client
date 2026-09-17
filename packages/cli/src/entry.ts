// The one file that knows about `process`.
//
// Everything above takes side effects as arguments and returns an exit code.
// This is where the real argv, environment, streams and Core dial get bound.

import * as os from "node:os";
import { runClient as dispatchRunClient } from "./run-client.ts";
import { probeCore } from "./core/core-probe.ts";
import { openCoreShell } from "./core/core-shell-channel.ts";
import { terminalFromProcess } from "./kit/cli-terminal.ts";
import { connectCore } from "./core/core-connection.ts";
import { sdkCorePairing } from "./core/core-pair.ts";
import { openSessionGateway } from "./core/session-gateway.ts";
import { openProjectFiles } from "./core/project-files-gateway.ts";
import { openSessionAttach } from "./core/session-attach-channel.ts";
import { nodeClientPrompts } from "./kit/node-system.ts";
import { EXIT_FAILURE } from "./kit/exit-codes.ts";

/** Read stdin to end. Only called by a verb that was told to read it. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<number> {
  const verboseOn = argv.includes("--verbose");
  return dispatchRunClient(argv, {
    argv,
    env: process.env,
    home: os.homedir(),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    outBytes: (chunk) => {
      process.stdout.write(chunk);
    },
    errBytes: (chunk) => {
      process.stderr.write(chunk);
    },
    verbose: verboseOn
      ? (line) => {
          process.stderr.write(`actana: ${line}\n`);
        }
      : () => {},
    readStdin,
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    probe: probeCore,
    connect: connectCore,
    pairing: sdkCorePairing,
    openSessions: openSessionGateway,
    openFiles: openProjectFiles,
    now: () => Date.now(),
    terminal: terminalFromProcess(process),
    openShell: openCoreShell,
    openAttach: openSessionAttach,
    hostname: os.hostname(),
    platform: process.platform,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    system: nodeClientPrompts(),
  }).catch((err: unknown) => {
    process.stderr.write(`actana: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_FAILURE;
  });
}

/** Process-bound entry — what `bin/actana.mjs` loads. */
export async function runClient(argv: string[]): Promise<number> {
  return main(argv);
}
