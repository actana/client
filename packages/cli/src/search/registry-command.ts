import type { ParsedArgs } from "../kit/cli-args.ts";
import { formatJson, formatTable } from "../kit/cli-output.ts";
import {
  clearCurrentSearch,
  listSearchNames,
  listUsableSearchNames,
  readCurrentSearch,
  readSearchRegistry,
  removeSearchBlob,
  searchExists,
  searchNameError,
  writeCurrentSearch,
  type RegistryPaths,
} from "../registry/credentials.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";
import type { SearchCliDeps } from "./search-deps.ts";

export function searchLs(deps: SearchCliDeps, flags: ParsedArgs, paths: RegistryPaths): number {
  const rows = readSearchRegistry(paths);

  if (flags.json) {
    deps.out(
      formatJson(
        rows.map((row) => ({
          name: row.name,
          current: row.current,
          endpoint: row.summary?.endpoint ?? null,
          label: row.summary?.label ?? null,
          insecureMode: row.insecureMode,
          error: row.error,
        })),
      ),
    );
    return EXIT_OK;
  }

  if (rows.length === 0) {
    deps.out("No Search instances registered. `actana search pair <name> <address> <code>` registers one.");
    return EXIT_OK;
  }

  for (const line of formatTable(
    ["NAME", "CURRENT", "ENDPOINT", "LABEL"],
    rows.map((row) => [
      row.name,
      row.current ? "*" : "",
      row.summary?.endpoint ?? `(unusable: ${row.error})`,
      row.summary?.label ?? "",
    ]),
  )) {
    deps.out(line);
  }

  for (const row of rows.filter((r) => r.insecureMode)) {
    deps.err(
      `warning: the blob for "${row.name}" is readable by more than its owner. ` +
        `chmod 600 ${paths.searchDir}/${row.name}.txt`,
    );
  }
  return EXIT_OK;
}

export function searchUse(deps: SearchCliDeps, paths: RegistryPaths, rest: string[]): number {
  const [name] = rest;
  if (name === undefined) {
    deps.err("actana search use: a name is required — `actana search use <name>`.");
    return EXIT_USAGE;
  }
  if (searchNameError(name) !== null || !searchExists(paths, name)) {
    deps.err(`actana search use: no Search instance named "${name}".`);
    const known = listUsableSearchNames(paths);
    deps.err(known.length > 0 ? `Known: ${known.join(", ")}` : nothingToSelect(paths));
    return EXIT_FAILURE;
  }
  writeCurrentSearch(paths, name);
  deps.out(`\`current\` now points at "${name}".`);
  return EXIT_OK;
}

export function searchRm(deps: SearchCliDeps, paths: RegistryPaths, rest: string[]): number {
  const [name] = rest;
  if (name === undefined) {
    deps.err("actana search rm: a name is required — `actana search rm <name>`.");
    return EXIT_USAGE;
  }
  if (searchNameError(name) !== null) {
    deps.err(`actana search rm: no Search instance named "${name}".`);
    return EXIT_FAILURE;
  }
  const wasCurrent = readCurrentSearch(paths) === name;
  if (!removeSearchBlob(paths, name)) {
    deps.err(`actana search rm: no Search instance named "${name}".`);
    return EXIT_FAILURE;
  }
  if (wasCurrent) clearCurrentSearch(paths);

  deps.out(`Removed Search instance "${name}".`);
  if (wasCurrent) {
    const left = listUsableSearchNames(paths);
    deps.out(
      left.length > 0
        ? `Nothing is \`current\` now — \`actana search use <name>\` selects one of: ${left.join(", ")}`
        : `Nothing is \`current\` now, and ${nothingToSelect(paths)}`,
    );
  }
  return EXIT_OK;
}

function nothingToSelect(paths: RegistryPaths): string {
  return listSearchNames(paths).length > 0
    ? "no Search instance in the registry has a usable name — `actana search ls` shows what is there."
    : "no Search instances are registered.";
}
