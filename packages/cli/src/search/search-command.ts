// `actana search` — client nouns for a paired Search instance.

import type { ParsedArgs } from "../kit/cli-args.ts";
import { ensureCredentialRegistry, registryPaths, type RegistryPaths } from "../registry/credentials.ts";
import { EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";
import type { SearchCliDeps } from "./search-deps.ts";
import { runEndpointCommand } from "./endpoint-command.ts";
import {
  runIngestCommand,
  runKbCommand,
  runQueryCommand,
  runStatusCommand,
} from "./kb-command.ts";
import { runSearchPair, SEARCH_PAIR_HELP } from "./pair-command.ts";
import { searchLs, searchRm, searchUse } from "./registry-command.ts";

export const SEARCH_HELP = `actana search — paired Search instances on this machine

Usage
  actana search pair <name> <address> <code> --session <id> --fingerprint <sha256>
  actana search ls [--json]
  actana search use <name>
  actana search rm <name>
  actana search status [--json]
  actana search kb ls | create <name> | rm <id>
  actana search ingest <kb> <file>
  actana search query <kb> "<text>"
  actana search endpoint add | ls

Flags
  --search <name>   which paired Search instance (default: current)
  --json            machine-readable output
  --verbose         explain the steps. Never prints a credential.
  -h, --help        show this help`;

/** Dispatch a `search` verb. Positionals[0] must be `search`. */
export async function runSearchCommand(
  deps: SearchCliDeps,
  args: ParsedArgs,
  paths?: RegistryPaths,
): Promise<number> {
  const registry = paths ?? registryPaths(deps.env, deps.home);
  ensureCredentialRegistry(registry);

  const [noun, verb, ...rest] = args.positionals;
  if (noun !== "search") {
    deps.err(`actana search: expected the search noun, got "${noun ?? ""}".`);
    return EXIT_USAGE;
  }

  if (args.help || verb === undefined) {
    deps.out(SEARCH_HELP);
    return verb === undefined && !args.help ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "pair":
      return runSearchPair(deps, args, registry, rest);
    case "ls":
    case "list":
      return searchLs(deps, args, registry);
    case "use":
      return searchUse(deps, registry, rest);
    case "rm":
    case "remove":
      return searchRm(deps, registry, rest);
    case "status":
      return runStatusCommand(deps, args, registry);
    case "kb":
      return runKbCommand(deps, args, registry, rest);
    case "ingest":
      return runIngestCommand(deps, args, registry, rest);
    case "query":
      return runQueryCommand(deps, args, registry, rest);
    case "endpoint":
      return runEndpointCommand(deps, args, registry, rest);
    default:
      deps.err(`actana search: unknown verb "${verb}".`);
      deps.err("Verbs: pair, ls, use, rm, status, kb, ingest, query, endpoint.");
      return EXIT_USAGE;
  }
}

export { SEARCH_PAIR_HELP };
