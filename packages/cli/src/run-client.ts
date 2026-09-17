// The general client CLI dispatcher — Cores, Search, help and version.

import { parseArgs } from "./kit/cli-args.ts";
import { registryPaths } from "./registry/credentials.ts";
import { runCoreCommand } from "./core/core-command.ts";
import { runProjectCommand } from "./core/project-command.ts";
import { runHarnessCommand } from "./core/harness-command.ts";
import { runEventsCommand } from "./core/events-command.ts";
import { runSessionCommand } from "./core/session-command.ts";
import { ensureOrchestrationSkillQuietly } from "./core/orchestration-skill.ts";
import { runSearchCommand } from "./search/search-command.ts";
import { searchDepsFrom } from "./search/search-wiring.ts";
import { EXIT_OK, EXIT_USAGE } from "./kit/exit-codes.ts";
import type { ClientDeps } from "./kit/cli-deps.ts";
import manifest from "../package.json" with { type: "json" };

export const CLI_VERSION: string = manifest.version;

/** Returned by a built-in's machine layer when the general CLI should take over. */
export const NOT_HANDLED = Symbol.for("actana.cli.NOT_HANDLED");

export const CLIENT_NOUNS = ["core", "project", "harness", "events", "session"] as const;

export type RunClientOptions = {
  /** Appended after the general help — machine verbs from a product built-in. */
  extraHelp?: string;
  /** When set, `actana -V` prints this line after the general CLI version. */
  version?: { self?: string };
};

/** General help for `actana --help`, as drawn on modular-split page 05. */
export function clientHelp(extraHelp?: string): string {
  const base = `actana — reach your Cores and Search instances

Usage
  actana <noun> <verb> [flags]

Cores
  core       pair, ls, use, rm, status, shell, exec
  project    ls, add, browse, files, cp
  harness    ls, install, skills
  events     tail
  session    start, ls, logs, resume, attach, kill, send

Search
  search     pair, ls, use, rm, status, kb, ingest, query, endpoint

Flags
  --core <name>     which paired Core
  --search <name>   which paired Search instance
  --json            machine-readable output
  --verbose         explain the steps, on stderr. Never prints a credential.

Running on a Core or a Search instance? Its own \`actana\` adds the machine verbs.`;
  if (extraHelp === undefined || extraHelp === "") return base;
  return `${base}\n\n${extraHelp.trimEnd()}`;
}

/** @deprecated Use {@link clientHelp}. */
export const USAGE = clientHelp();

function printVersion(deps: ClientDeps, opts: RunClientOptions): void {
  deps.out(`actana ${CLI_VERSION}`);
  if (opts.version?.self) deps.out(opts.version.self);
}

function validateGlobalFlags(
  deps: ClientDeps,
  args: ReturnType<typeof parseArgs>,
): number | null {
  if (args.missingValue) {
    deps.err(`actana: ${args.missingValue} needs a value.`);
    return EXIT_USAGE;
  }
  if (args.unknown.length > 0) {
    deps.err(`actana: unknown flag ${args.unknown[0]}.`);
    deps.err("`actana --help` lists the flags this build knows.");
    return EXIT_USAGE;
  }
  return null;
}

/** Run one general-client invocation. Returns the exit code; never calls process.exit. */
export async function runClient(
  argv: string[],
  deps: ClientDeps,
  opts: RunClientOptions = {},
): Promise<number> {
  const args = parseArgs(argv);
  const head = args.positionals[0];
  const clientDeps = { ...deps, argv };

  if (head === undefined) {
    if (args.version || argv[0] === "-v") {
      printVersion(clientDeps, opts);
      return EXIT_OK;
    }
    clientDeps.out(clientHelp(opts.extraHelp).trimEnd());
    return EXIT_OK;
  }

  if (head === "help") {
    clientDeps.out(clientHelp(opts.extraHelp).trimEnd());
    return EXIT_OK;
  }

  const knownNoun =
    head === "search" || (CLIENT_NOUNS as readonly string[]).includes(head);

  if (!knownNoun) {
    clientDeps.err(`actana: unknown command "${head}".`);
    clientDeps.err("`actana --help` lists the commands this build knows.");
    return EXIT_USAGE;
  }

  const flagError = validateGlobalFlags(clientDeps, args);
  if (flagError !== null) return flagError;

  if (!(head === "harness" && args.positionals[1] === "skills")) {
    ensureOrchestrationSkillQuietly(clientDeps.home);
  }

  const paths = registryPaths(clientDeps.env, clientDeps.home);

  if (head === "search") {
    return runSearchCommand(searchDepsFrom(clientDeps, argv), args, paths);
  }

  switch (head) {
    case "core":
      return runCoreCommand(clientDeps, args, paths);
    case "project":
      return runProjectCommand(clientDeps, args, paths);
    case "harness":
      return runHarnessCommand(clientDeps, args, paths);
    case "events":
      return runEventsCommand(clientDeps, args, paths);
    default:
      return runSessionCommand(clientDeps, args, paths);
  }
}

/** @deprecated Use {@link runClient}. Kept for lifted Control tests. */
export async function runActanaCli(deps: ClientDeps): Promise<number> {
  return runClient(deps.argv, deps);
}
