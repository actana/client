import { SearchApiError } from "@actana/sdk/search";
import type { SearchClient } from "@actana/sdk/search";
import type { ParsedArgs } from "../kit/cli-args.ts";
import {
  redactCredentialSecrets,
  type RegistryPaths,
} from "../registry/credentials.ts";
import { EXIT_FAILURE, EXIT_UNIMPLEMENTED } from "../kit/exit-codes.ts";
import type { SearchCliDeps } from "./search-deps.ts";
import { resolveSearch } from "./search-resolution.ts";

export async function withClient(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  paths: RegistryPaths,
  verb: string,
  run: (client: SearchClient, name: string) => Promise<number>,
): Promise<number> {
  const resolved = resolveSearch({ paths, searchFlag: flags.search });
  if (!resolved.ok) {
    deps.err(`actana search ${verb}: ${resolved.error}`);
    return EXIT_FAILURE;
  }
  const { name, blob, source } = resolved.search;
  deps.verbose(
    redactCredentialSecrets(`using Search "${name}" from ${source} → ${blob.endpoint}`),
  );
  const client = deps.clientFor(blob);
  try {
    return await run(client, name);
  } catch (err) {
    return reportApi(deps, verb, err);
  } finally {
    await client.close().catch(() => {});
  }
}

export function reportApi(deps: SearchCliDeps, verb: string, err: unknown): number {
  if (err instanceof SearchApiError && err.code === "not-implemented") {
    deps.err(`actana search ${verb}: that instance does not serve this route.`);
    deps.err(
      "This command is wired to the current contract, so the instance is the older half — " +
        "`actana search status` prints its schema version.",
    );
    return EXIT_UNIMPLEMENTED;
  }
  if (err instanceof SearchApiError) {
    deps.err(`actana search ${verb}: ${err.message}`);
    if (err.code === "unreachable") {
      deps.err("The instance did not answer. Check it is running and reachable from here.");
    }
    if (err.status === 403) {
      deps.err("This certificate's scope does not cover that. `search pair ls` on the instance shows it.");
    }
    return EXIT_FAILURE;
  }
  deps.err(`actana search ${verb}: ${err instanceof Error ? err.message : String(err)}`);
  return EXIT_FAILURE;
}
