import type { QueryRequest } from "@actana/sdk/search";
import { parseFraction, parseInteger, type ParsedArgs } from "../kit/cli-args.ts";
import { formatJson, formatTable, orDash, relativeTime } from "../kit/cli-output.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";
import type { RegistryPaths } from "../registry/credentials.ts";
import { withClient } from "./client.ts";
import type { SearchCliDeps } from "./search-deps.ts";

export const STATUS_HELP = `actana search status — is this credential good?

Usage
  actana search status [--search <name>] [--json]`;

export const KB_HELP = `actana search kb — the knowledge bases on a paired instance

Usage
  actana search kb ls [--json]
  actana search kb create <name> [--json]
  actana search kb rm <id>

Flags
  --search <name>   which stored credential to use
  --json            machine-readable output
  -h, --help        show this help`;

export const INGEST_HELP = `actana search ingest — put a document into a knowledge base

Usage
  actana search ingest <kb> <file>

Flags
  --search <name>   which stored credential to use
  --json            machine-readable output`;

export const QUERY_HELP = `actana search query — ask a knowledge base

Usage
  actana search query <kb> "<text>" [--top-k <n>] [--keyword-weight <0..1>]

Flags
  --top-k <n>              how many matches to return
  --keyword-weight <0..1>  how much of the score keywords are worth
  --search <name>          which stored credential to use
  --json                   machine-readable output`;

export async function runStatusCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  if (flags.help) {
    deps.out(STATUS_HELP);
    return EXIT_OK;
  }
  return withClient(deps, flags, paths, "status", async (client) => {
    const health = await client.health();
    const pair = await client.pairStatus();
    if (flags.json) {
      deps.out(formatJson({ endpoint: client.baseUrl, health, pair }));
      return EXIT_OK;
    }
    deps.out(`Instance       ${client.baseUrl}`);
    deps.out(`Health         ${health.ok ? "ok" : "not ok"} (schema ${health.schemaVersion})`);
    deps.out(`Client         ${orDash(pair.id)}`);
    deps.out(`Label          ${orDash(pair.label)}`);
    deps.out(`Scope          ${orDash(pair.scope)}`);
    deps.out(`Knowledge bases ${pair.kbIds?.length ? pair.kbIds.join(", ") : "all"}`);
    if (pair.certNotAfter) {
      deps.out(`Certificate    expires ${relativeTime(pair.certNotAfter, deps.now())}`);
    }
    return EXIT_OK;
  });
}

export async function runKbCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || flags.help) {
    deps.out(KB_HELP);
    return verb === undefined ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "ls":
    case "list":
      return withClient(deps, flags, paths, "kb ls", async (client) => {
        const kbs = await client.kbs.list();
        if (flags.json) {
          deps.out(formatJson(kbs));
          return EXIT_OK;
        }
        if (kbs.length === 0) {
          deps.out("No knowledge bases.");
          return EXIT_OK;
        }
        for (const line of formatTable(
          ["ID", "NAME", "DOCUMENTS", "CLUSTERS"],
          kbs.map((kb) => [
            kb.id,
            kb.name,
            orDash(kb.docCount),
            orDash(kb.clusterCount),
          ]),
        )) {
          deps.out(line);
        }
        return EXIT_OK;
      });

    case "create": {
      const name = rest[1];
      if (!name) {
        deps.err("actana search kb create: give the knowledge base a name.");
        return EXIT_USAGE;
      }
      return withClient(deps, flags, paths, "kb create", async (client) => {
        const kb = await client.kbs.create({ name });
        deps.out(flags.json ? formatJson(kb) : `Created ${String(kb.id)} (${name}).`);
        return EXIT_OK;
      });
    }

    case "rm":
    case "delete": {
      const id = rest[1];
      if (!id) {
        deps.err("actana search kb rm: name the knowledge base to delete.");
        return EXIT_USAGE;
      }
      return withClient(deps, flags, paths, "kb rm", async (client) => {
        await client.kbs.delete(id);
        deps.out(flags.json ? formatJson({ deleted: id }) : `Deleted ${id}.`);
        return EXIT_OK;
      });
    }

    default:
      deps.err(`actana search kb: unknown verb "${verb}".`);
      deps.err("Verbs: ls, create, rm.");
      return EXIT_USAGE;
  }
}

export async function runIngestCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  if (flags.help) {
    deps.out(INGEST_HELP);
    return EXIT_OK;
  }
  const [kbId, file] = rest;
  if (!kbId || !file) {
    deps.err("actana search ingest: give a knowledge base and a file.");
    deps.err("  actana search ingest my-kb ./handbook.md");
    return EXIT_USAGE;
  }

  let bytes: Buffer;
  try {
    bytes = await deps.readFile(file);
  } catch (err) {
    deps.err(`actana search ingest: ${file} could not be read.`);
    deps.err(err instanceof Error ? err.message : String(err));
    return EXIT_FAILURE;
  }
  const filename = file.split("/").pop() || file;

  return withClient(deps, flags, paths, "ingest", async (client) => {
    const result = await client.kbs.ingest(kbId, {
      filename,
      text: bytes.toString("utf8"),
    });
    deps.out(
      flags.json
        ? formatJson(result)
        : `Ingesting ${filename} → ${String(result.documentId)} (${String(result.processingStatus)}).`,
    );
    return EXIT_OK;
  });
}

export async function runQueryCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  if (flags.help) {
    deps.out(QUERY_HELP);
    return EXIT_OK;
  }
  const [kbId, ...words] = rest;
  const text = words.join(" ").trim();
  if (!kbId || !text) {
    deps.err("actana search query: give a knowledge base and something to ask.");
    deps.err('  actana search query my-kb "parental leave policy"');
    return EXIT_USAGE;
  }

  const body: QueryRequest = { text };
  if (flags.topK) {
    const parsed = parseInteger(flags.topK, "--top-k");
    if ("error" in parsed) {
      deps.err(`actana search query: ${parsed.error}.`);
      return EXIT_USAGE;
    }
    body.topK = parsed.value;
  }
  if (flags.keywordWeight) {
    const parsed = parseFraction(flags.keywordWeight, "--keyword-weight");
    if ("error" in parsed) {
      deps.err(`actana search query: ${parsed.error}.`);
      return EXIT_USAGE;
    }
    body.keywordWeight = parsed.value;
  }

  return withClient(deps, flags, paths, "query", async (client) => {
    const result = await client.kbs.query(kbId, body);
    if (flags.json) {
      deps.out(formatJson(result));
      return EXIT_OK;
    }
    if (result.mode === "v1-tags") {
      if (result.matches.length === 0) {
        deps.out("No matches.");
        return EXIT_OK;
      }
      for (const line of formatTable(
        ["DISTANCE", "DOCUMENT", "CHUNK", "TEXT"],
        result.matches.map((m) => [
          m.distance.toFixed(4),
          m.documentId,
          orDash(m.chunkIndex),
          String(m.content ?? "").replace(/\s+/g, " ").slice(0, 96),
        ]),
      )) {
        deps.out(line);
      }
      return EXIT_OK;
    }

    const matches = result.matches;
    if (matches.length === 0) {
      deps.out("No matches.");
      return EXIT_OK;
    }
    for (const line of formatTable(
      ["SCORE", "DOCUMENT", "CHUNK", "TEXT"],
      matches.map((m) => [
        m.score.toFixed(4),
        m.documentId,
        orDash(m.chunkIndex),
        String(m.content ?? "").replace(/\s+/g, " ").slice(0, 96),
      ]),
    )) {
      deps.out(line);
    }
    return EXIT_OK;
  });
}
