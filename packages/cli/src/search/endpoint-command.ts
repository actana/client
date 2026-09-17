import type { EndpointDeclaration, GetEndpointsResponse } from "@actana/sdk/search";
import type { SearchClient } from "@actana/sdk/search";
import { parseInteger, type ParsedArgs } from "../kit/cli-args.ts";
import { formatJson, formatTable, orDash } from "../kit/cli-output.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";
import type { RegistryPaths } from "../registry/credentials.ts";
import { withClient } from "./client.ts";
import type { SearchCliDeps } from "./search-deps.ts";

export const ENDPOINT_HELP = `actana search endpoint — the models a knowledge base uses

Usage
  actana search endpoint add --kind embedding --provider openai \\
      --model text-embedding-3-small --dimensions 1536 --key-stdin
  actana search endpoint ls [--search <name>] [--json]

Flags
  --kind <k>          embedding or inference
  --provider <id>     openai, voyage, google, cohere, mistral, …
  --template <id>     the request shape, when it differs from the provider name
  --model <name>      the provider-side model
  --dimensions <n>    vector width — required for an embedding endpoint
  --base-url <url>    an OpenAI-compatible endpoint behind another URL
  --label <name>      what to call it in a listing
  --external-id <id>  your own stable id for it
  --search <name>     which stored credential to use
  --key-stdin         read the provider key from stdin
  --json              machine-readable output
  -h, --help          show this help`;

export async function runEndpointCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || flags.help) {
    deps.out(ENDPOINT_HELP);
    return verb === undefined ? EXIT_USAGE : EXIT_OK;
  }
  switch (verb) {
    case "add":
      return endpointAdd(deps, flags, paths);
    case "ls":
    case "list":
      return endpointLs(deps, flags, paths);
    default:
      deps.err(`actana search endpoint: unknown verb "${verb}".`);
      deps.err("Verbs: add, ls.");
      return EXIT_USAGE;
  }
}

type Redeclared =
  | { ok: true; declaration: EndpointDeclaration }
  | { ok: false; reason: string };

function endpointKind(flags: ParsedArgs): string | null {
  return flags.kind.at(-1) ?? null;
}

function redeclare(endpoint: GetEndpointsResponse["endpoints"][number]): Redeclared {
  const missing = [
    endpoint.model === null ? "--model" : null,
    endpoint.label === null ? "--label" : null,
  ].filter((f): f is string => f !== null);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `${endpoint.id} (${endpoint.externalId ?? "no external id"}) has no ${missing.join(" and no ")}`,
    };
  }
  return {
    ok: true,
    declaration: {
      externalId: endpoint.externalId!,
      kind: endpoint.kind,
      provider: endpoint.provider,
      template: endpoint.template,
      model: endpoint.model!,
      ...(endpoint.dimensions === null ? {} : { dimensions: endpoint.dimensions }),
      ...(endpoint.baseUrl === null ? {} : { baseUrl: endpoint.baseUrl }),
      label: endpoint.label!,
      config: endpoint.config,
    },
  };
}

function derivedExternalId(kind: string, provider: string, model: string): string {
  return `cli-${[kind, provider, model].join("-")}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

async function endpointAdd(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const kind = endpointKind(flags);
  if (kind !== "embedding" && kind !== "inference") {
    deps.err("actana search endpoint add: --kind is embedding or inference.");
    return EXIT_USAGE;
  }
  if (!flags.provider) {
    deps.err("actana search endpoint add: --provider is required (openai, voyage, google, …).");
    return EXIT_USAGE;
  }
  if (!flags.model) {
    deps.err("actana search endpoint add: --model is required.");
    return EXIT_USAGE;
  }

  let dimensions: number | null = null;
  if (flags.dimensions) {
    const parsed = parseInteger(flags.dimensions, "--dimensions");
    if ("error" in parsed) {
      deps.err(`actana search endpoint add: ${parsed.error}.`);
      return EXIT_USAGE;
    }
    dimensions = parsed.value;
  }
  if (kind === "embedding" && dimensions === null) {
    deps.err("actana search endpoint add: an embedding endpoint needs --dimensions.");
    return EXIT_USAGE;
  }
  if (kind === "inference" && dimensions !== null) {
    deps.err("actana search endpoint add: --dimensions is for an embedding endpoint.");
    return EXIT_USAGE;
  }

  if (!flags.keyStdin) {
    deps.err("actana search endpoint add: pass the provider key with --key-stdin.");
    return EXIT_USAGE;
  }
  const apiKey = (await deps.readStdin()).trim();
  if (!apiKey) {
    deps.err("actana search endpoint add: nothing arrived on stdin.");
    return EXIT_USAGE;
  }

  const externalId =
    flags.externalId?.trim() || derivedExternalId(kind, flags.provider, flags.model);
  const declaration: EndpointDeclaration = {
    externalId,
    kind,
    provider: flags.provider,
    template: flags.template || flags.provider,
    model: flags.model,
    ...(dimensions === null ? {} : { dimensions }),
    ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
    label: flags.label || `${flags.provider} ${flags.model}`,
    apiKey,
  };

  return withClient(deps, flags, paths, "endpoint add", async (client: SearchClient) => {
    const current = await client.endpoints.get();
    if (current.source.kind === "mirrored") {
      deps.err("actana search endpoint add: this client mirrors its own catalog.");
      deps.err(
        `Its endpoints come from the resolver at ${current.source.resolverUrl}, and the ` +
          "instance never holds a key for them.",
      );
      return EXIT_FAILURE;
    }

    const kept: EndpointDeclaration[] = [];
    const unredeclarable: string[] = [];
    for (const existing of current.endpoints) {
      if (existing.externalId === null || existing.externalId === externalId) continue;
      const result = redeclare(existing);
      if (result.ok) kept.push(result.declaration);
      else unredeclarable.push(result.reason);
    }
    if (unredeclarable.length > 0) {
      deps.err("actana search endpoint add: another endpoint cannot be re-declared as it is.");
      for (const reason of unredeclarable) deps.err(`  ${reason}`);
      deps.err("`endpoint add` re-sends the whole set, and it will not invent a value for one.");
      return EXIT_FAILURE;
    }

    const { endpoints } = await client.endpoints.put({
      source: { kind: "local" },
      endpoints: [...kept, declaration],
    });
    const written = endpoints.find((e) => e.externalId === externalId);

    if (flags.json) {
      deps.out(formatJson({ endpoint: written ?? null, externalId }));
      return EXIT_OK;
    }
    deps.out(`Registered ${kind} endpoint ${written?.id ?? "(id not returned)"}.`);
    deps.out(`External id    ${externalId}`);
    deps.err("The key is sealed on the instance and will not be printed back.");
    return EXIT_OK;
  });
}

async function endpointLs(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  return withClient(deps, flags, paths, "endpoint ls", async (client) => {
    const result = await client.endpoints.get();
    if (flags.json) {
      deps.out(formatJson(result));
      return EXIT_OK;
    }
    if (result.source.kind === "mirrored") {
      deps.out(`Keys are mirrored from ${result.source.resolverUrl}`);
      deps.out(`Resolver scope ${orDash(result.source.resolverScope)}`);
    } else {
      deps.out("Keys are held by this instance (local).");
    }
    if (result.endpoints.length === 0) {
      deps.out("No endpoints are registered for this client.");
      return EXIT_OK;
    }
    for (const line of formatTable(
      ["ID", "EXTERNAL ID", "KIND", "PROVIDER", "MODEL", "DIMS", "SOURCE", "KEY"],
      result.endpoints.map((e) => [
        e.id,
        orDash(e.externalId),
        e.kind,
        e.provider,
        orDash(e.model),
        orDash(e.dimensions),
        e.source,
        e.hasKey ? "yes" : "no",
      ]),
    )) {
      deps.out(line);
    }
    return EXIT_OK;
  });
}
