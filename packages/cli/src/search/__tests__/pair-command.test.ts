/**
 * `actana search pair` — client-side redemption.
 *
 * @vitest-environment node
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PairingError } from "@actana/sdk/pairing";
import type { SearchClient } from "@actana/sdk/search";
import { parseArgs } from "../../kit/cli-args.ts";
import {
  EXIT_OK,
  EXIT_PAIR_REFUSED,
  EXIT_PAIR_SEARCH_ERROR,
  EXIT_USAGE,
} from "../../kit/exit-codes.ts";
import { encodeRegistrationBlob } from "@actana/sdk/pairing";
import { registryPaths, readSearchBlobText, writeSearchBlob } from "../../registry/credentials.ts";
import { runSearchCommand } from "../search-command.ts";
import type { SearchCliDeps, SearchPairingPort } from "../search-deps.ts";

const BLOB = {
  endpoint: "https://search.internal:7443",
  label: "",
  caCert: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
  clientCert: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
  clientKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
  bearer: "inert",
};

let home: string;

function deps(overrides: Partial<SearchCliDeps> & { pairing: SearchPairingPort }): SearchCliDeps & {
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    argv: [],
    env: {} as NodeJS.ProcessEnv,
    home,
    out: (line) => void stdout.push(line),
    err: (line) => void stderr.push(line),
    verbose: () => {},
    readStdin: async () => "",
    readFile: async () => Buffer.from(""),
    stdoutIsTty: false,
    interactive: false,
    hostname: "laptop",
    platform: "darwin",
    now: () => Date.parse("2026-09-15T12:00:00.000Z"),
    clientFor: () =>
      ({
        baseUrl: BLOB.endpoint,
        pairStatus: async () => ({
          id: "pc-1",
          label: "laptop",
          platform: "darwin",
          scope: "read",
          kbIds: ["kb-1", "kb-2"],
          certSerial: "01",
          certNotAfter: "2027-09-15T12:00:00.000Z",
          pairedAt: "2026-09-15T12:00:00.000Z",
        }),
        close: async () => {},
      }) as unknown as SearchClient,
    ...overrides,
    stdout,
    stderr,
  };
}

async function run(argv: string[], pairing: SearchPairingPort) {
  const d = deps({ pairing });
  const code = await runSearchCommand(d, parseArgs(argv), registryPaths(d.env, d.home));
  return { code, d };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "actana-search-pair-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("search pair", () => {
  it("refuses without name, address and code", async () => {
    const { code, d } = await run(
      ["search", "pair"],
      { identify: async () => ({ fingerprint: "AA", caCert: "", host: "", port: 7443, httpsOrigin: "" }), pair: async () => BLOB },
    );
    expect(code).toBe(EXIT_USAGE);
    expect(d.stderr.join("\n")).toContain("name, an address and a code");
  });

  it("pairs, stores the blob and prints the success line", async () => {
    const pairing: SearchPairingPort = {
      identify: async () => ({
        fingerprint: "AA:BB",
        caCert: BLOB.caCert,
        host: "search.internal",
        port: 7443,
        httpsOrigin: "https://search.internal:7443",
      }),
      pair: async () => BLOB,
    };
    const { code, d } = await run(
      [
        "search",
        "pair",
        "docs",
        "search.internal:7443",
        "sess-abc:7K4M-2QPX",
        "--fingerprint",
        "AA:BB",
      ],
      pairing,
    );
    expect(code).toBe(EXIT_OK);
    expect(d.stdout.join("\n")).toBe("✓ paired Search docs  (scope read · 2 knowledge bases)");
    const paths = registryPaths({}, home);
    expect(readSearchBlobText(paths, "docs")).toBeTruthy();
  });

  it("exits PAIR_SEARCH_ERROR when the instance fails during redemption", async () => {
    const pairing: SearchPairingPort = {
      identify: async () => ({
        fingerprint: "AA:BB",
        caCert: BLOB.caCert,
        host: "search.internal",
        port: 7443,
        httpsOrigin: "https://search.internal:7443",
      }),
      pair: async () => {
        throw new PairingError("core-error", "the Search instance failed while handling the redemption");
      },
    };
    const { code, d } = await run(
      [
        "search",
        "pair",
        "docs",
        "search.internal:7443",
        "sess-abc:7K4M-2QPX",
        "--fingerprint",
        "AA:BB",
      ],
      pairing,
    );
    expect(code).toBe(EXIT_PAIR_SEARCH_ERROR);
    expect(code).toBe(20);
    expect(d.stderr.join("\n")).toContain("failed while handling the redemption");
  });

  it("exits EXIT_PAIR_REFUSED for a refused code", async () => {
    const pairing: SearchPairingPort = {
      identify: async () => ({
        fingerprint: "AA:BB",
        caCert: BLOB.caCert,
        host: "search.internal",
        port: 7443,
        httpsOrigin: "https://search.internal:7443",
      }),
      pair: async () => {
        throw new PairingError("refused", "the instance refused the pairing code");
      },
    };
    const { code } = await run(
      [
        "search",
        "pair",
        "docs",
        "search.internal:7443",
        "sess-abc:7K4M-2QPX",
        "--fingerprint",
        "AA:BB",
      ],
      pairing,
    );
    expect(code).toBe(EXIT_PAIR_REFUSED);
  });

  it("never prints a credential under --verbose", async () => {
    const verboseLines: string[] = [];
    const pairing: SearchPairingPort = {
      identify: async () => ({
        fingerprint: "AA:BB",
        caCert: BLOB.caCert,
        host: "search.internal",
        port: 7443,
        httpsOrigin: "https://search.internal:7443",
      }),
      pair: async () => BLOB,
    };
    const d = deps({
      pairing,
      verbose: (line) => void verboseLines.push(line),
    });
    await runSearchCommand(
      d,
      parseArgs([
        "search",
        "pair",
        "docs",
        "search.internal:7443",
        "sess-abc:7K4M-2QPX",
        "--fingerprint",
        "AA:BB",
        "--verbose",
      ]),
      registryPaths(d.env, d.home),
    );
    const blobHint = Buffer.from(JSON.stringify(BLOB)).toString("base64");
    for (const line of verboseLines) {
      expect(line).not.toContain(BLOB.clientKey);
      expect(line).not.toContain(BLOB.bearer);
      expect(line).not.toContain(blobHint);
    }
  });
});

describe("search ls | use | rm", () => {
  it("lists, selects and removes a stored Search instance", async () => {
    const paths = registryPaths({}, home);
    writeSearchBlob(paths, "docs", encodeRegistrationBlob(BLOB));

    const listDeps = deps({
      pairing: { identify: async () => { throw new Error("unused"); }, pair: async () => BLOB },
    });
    expect(await runSearchCommand(listDeps, parseArgs(["search", "ls"]), paths)).toBe(EXIT_OK);

    const useDeps = deps({
      pairing: { identify: async () => { throw new Error("unused"); }, pair: async () => BLOB },
    });
    expect(await runSearchCommand(useDeps, parseArgs(["search", "use", "docs"]), paths)).toBe(EXIT_OK);

    const rmDeps = deps({
      pairing: { identify: async () => { throw new Error("unused"); }, pair: async () => BLOB },
    });
    expect(await runSearchCommand(rmDeps, parseArgs(["search", "rm", "docs"]), paths)).toBe(EXIT_OK);
  });
});
