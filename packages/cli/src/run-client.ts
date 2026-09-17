// Client noun dispatcher — tests and future `runClient` (T-219).
//
// Machine verbs stay in product repos; this module routes only the five client
// nouns that reach a Core through `@actana/sdk/core`.

import { parseArgs } from "./kit/cli-args.ts";
import { registryPaths } from "./registry/credentials.ts";
import { runCoreCommand } from "./core/core-command.ts";
import { runProjectCommand } from "./core/project-command.ts";
import { runHarnessCommand } from "./core/harness-command.ts";
import { runEventsCommand } from "./core/events-command.ts";
import { runSessionCommand } from "./core/session-command.ts";
import { ensureOrchestrationSkillQuietly } from "./core/orchestration-skill.ts";
import { EXIT_OK, EXIT_USAGE } from "./kit/exit-codes.ts";
import type { ClientDeps } from "./kit/cli-deps.ts";
import manifest from "../package.json" with { type: "json" };

export const CLI_VERSION: string = manifest.version;

export const CLIENT_NOUNS = ["core", "project", "harness", "events", "session"] as const;

export const USAGE = `actana — drive AI coding agents across your Cores

Usage:
  actana <noun> <verb> [flags]

Cores this machine can reach
  core       Pair with a Core, register, select and inspect them
  project    The Projects a Core owns: ls, add, browse, files, cp
  harness    The coding agents a Core can run: ls, install, skills
  events     Follow a Core's event log: tail
  session    Start, ls, logs, resume, attach, kill and send to Sessions on one
`;

/** Run one client-noun invocation. Returns the exit code; never calls process.exit. */
export async function runClient(deps: ClientDeps): Promise<number> {
  if (deps.argv.includes("--version") || deps.argv[0] === "-v") {
    deps.out(`actana ${CLI_VERSION}`);
    return EXIT_OK;
  }

  const args = parseArgs(deps.argv);
  const head = args.positionals[0];

  if (head === undefined) {
    return EXIT_USAGE;
  }

  if (!(CLIENT_NOUNS as readonly string[]).includes(head)) {
    deps.err(`actana: unknown command "${head}".`);
    deps.err("`actana --help` lists the commands this build knows.");
    return EXIT_USAGE;
  }

  if (args.missingValue) {
    deps.err(`actana: ${args.missingValue} needs a value.`);
    return EXIT_USAGE;
  }
  if (args.unknown.length > 0) {
    deps.err(`actana: unknown flag ${args.unknown[0]}.`);
    return EXIT_USAGE;
  }

  if (!(head === "harness" && args.positionals[1] === "skills")) {
    ensureOrchestrationSkillQuietly(deps.home);
  }

  const paths = registryPaths(deps.env, deps.home);

  switch (head) {
    case "core":
      return runCoreCommand(deps, args, paths);
    case "project":
      return runProjectCommand(deps, args, paths);
    case "harness":
      return runHarnessCommand(deps, args, paths);
    case "events":
      return runEventsCommand(deps, args, paths);
    default:
      return runSessionCommand(deps, args, paths);
  }
}

/** @deprecated Use {@link runClient}. Kept for lifted Control tests. */
export const runActanaCli = runClient;
