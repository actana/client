/**
 * `search endpoint add` — and what it sends about the endpoints it is *not* adding.
 *
 * @vitest-environment node
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SearchClient } from "@actana/sdk/search";
import type {
  Endpoint,
  GetEndpointsResponse,
  PutEndpointsRequest,
} from "@actana/sdk/search/contracts";
import { encodeRegistrationBlob } from "@actana/sdk/pairing/registration-blob";
import { parseArgs } from "../../kit/cli-args.ts";
import { EXIT_FAILURE, EXIT_OK } from "../../kit/exit-codes.ts";
import { registryPaths, writeSearchBlob, writeCurrentSearch } from "../../registry/credentials.ts";
import { runSearchCommand } from "../search-command.ts";
import type { SearchCliDeps, SearchPairingPort } from "../search-deps.ts";

const blob = {
  endpoint: "https://search.internal:7443",
  label: "laptop",
  caCert: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
  clientCert: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
  clientKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
  bearer: "inert",
};

function endpoint(over: Partial<Endpoint> = {}): Endpoint {
  return {
    id: "ep-1",
    externalId: "cli-embedding-openai-text-embedding-3-small",
    kind: "embedding",
    provider: "openai",
    template: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
    baseUrl: null,
    label: "primary",
    source: "local",
    hasKey: true,
    config: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

let home: string;
let pushed: PutEndpointsRequest[];
let listed: GetEndpointsResponse;

function stubClient(): SearchClient {
  return {
    baseUrl: blob.endpoint,
    endpoints: {
      get: async () => listed,
      put: async (body: PutEndpointsRequest) => {
        pushed.push(body);
        return {
          endpoints: body.endpoints.map((e, i) => ({ id: `ep-new-${i}`, externalId: e.externalId })),
        };
      },
    },
    close: async () => {},
  } as unknown as SearchClient;
}

const unusedPairing: SearchPairingPort = {
  identify: async () => {
    throw new Error("not used");
  },
  pair: async () => {
    throw new Error("not used");
  },
};

function deps(argv: string[], stdin = "sk-a-provider-key-0123456789") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    argv,
    env: {} as NodeJS.ProcessEnv,
    home,
    out: (line: string) => void stdout.push(line),
    err: (line: string) => void stderr.push(line),
    verbose: () => {},
    now: () => Date.parse("2026-09-15T12:00:00.000Z"),
    stdoutIsTty: false,
    interactive: false,
    hostname: "laptop",
    platform: "darwin",
    readStdin: async () => stdin,
    readFile: async () => Buffer.from(""),
    pairing: unusedPairing,
    clientFor: () => stubClient(),
    stdout,
    stderr,
  } satisfies SearchCliDeps & { stdout: string[]; stderr: string[] };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "actana-search-endpoint-"));
  const paths = registryPaths({}, home);
  writeSearchBlob(paths, "default", encodeRegistrationBlob(blob));
  writeCurrentSearch(paths, "default");
  pushed = [];
  listed = { source: { kind: "local" }, endpoints: [] };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const ADD = [
  "search",
  "endpoint",
  "add",
  "--kind",
  "embedding",
  "--provider",
  "voyage",
  "--model",
  "voyage-3",
  "--dimensions",
  "1024",
  "--key-stdin",
];

describe("endpoint add", () => {
  it("pushes the declared endpoint beside the set that is already there", async () => {
    listed = { source: { kind: "local" }, endpoints: [endpoint()] };
    const d = deps(ADD);

    expect(await runSearchCommand(d, parseArgs(ADD), registryPaths({}, home))).toBe(EXIT_OK);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.endpoints).toHaveLength(2);
    expect(pushed[0]!.endpoints[0]).toEqual({
      externalId: "cli-embedding-openai-text-embedding-3-small",
      kind: "embedding",
      provider: "openai",
      template: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      label: "primary",
      config: {},
    });
    expect(pushed[0]!.endpoints[0]).not.toHaveProperty("apiKey");
    expect(pushed[0]!.endpoints[1]).toMatchObject({
      kind: "embedding",
      provider: "voyage",
      model: "voyage-3",
      dimensions: 1024,
      apiKey: "sk-a-provider-key-0123456789",
    });
  });

  it("refuses rather than inventing a model for an endpoint that has none", async () => {
    listed = {
      source: { kind: "local" },
      endpoints: [endpoint({ id: "ep-modelless", externalId: "pushed-by-studio", model: null })],
    };
    const d = deps(ADD);

    expect(await runSearchCommand(d, parseArgs(ADD), registryPaths({}, home))).toBe(EXIT_FAILURE);
    expect(pushed).toEqual([]);
    const stderr = d.stderr.join("\n");
    expect(stderr).toContain("cannot be re-declared");
    expect(stderr).toContain("ep-modelless");
    expect(stderr).toContain("--model");
  });

  it("refuses for a missing label too, and names both when both are missing", async () => {
    listed = {
      source: { kind: "local" },
      endpoints: [endpoint({ id: "ep-bare", model: null, label: null })],
    };
    const d = deps(ADD);

    expect(await runSearchCommand(d, parseArgs(ADD), registryPaths({}, home))).toBe(EXIT_FAILURE);
    expect(pushed).toEqual([]);
    expect(d.stderr.join("\n")).toContain("has no --model and no --label");
  });

  it("refuses to write a key on a client that mirrors its own catalog", async () => {
    listed = {
      source: { kind: "mirrored", resolverUrl: "https://studio.example/resolve", resolverScope: null },
      endpoints: [],
    };
    const d = deps(ADD);

    expect(await runSearchCommand(d, parseArgs(ADD), registryPaths({}, home))).toBe(EXIT_FAILURE);
    expect(pushed).toEqual([]);
    expect(d.stderr.join("\n")).toContain("mirrors its own catalog");
  });
});
