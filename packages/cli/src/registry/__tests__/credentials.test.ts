// Credential registry: product-keyed blobs, migration, and verbose redaction (T-216).

import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BLOB_FILE_MODE,
  clearCurrentCore,
  coreBlobPath,
  coreNameError,
  ensureCredentialRegistry,
  listCoreNames,
  listSearchNames,
  listUsableCoreNames,
  loadCoreBlob,
  readCoreBlobText,
  readCurrentCore,
  readCurrentPointers,
  readCurrentSearch,
  readRegistry,
  readSearchBlobText,
  redactCredentialSecrets,
  registryPaths,
  removeCoreBlob,
  searchBlobPath,
  verboseRegistryDetail,
  writeCoreBlob,
  writeCurrentCore,
  writeCurrentPointers,
} from "../credentials.ts";

const SENTINEL_CA = "-----BEGIN CERTIFICATE-----CA-SENTINEL-QQQ-----END CERTIFICATE-----";
const SENTINEL_CERT = "-----BEGIN CERTIFICATE-----CLIENT-SENTINEL-ZZZ-----END CERTIFICATE-----";
const SENTINEL_KEY = "-----BEGIN PRIVATE KEY-----KEY-SENTINEL-WWW-----END PRIVATE KEY-----";
const SENTINEL_BEARER = "bearer-SENTINEL-YYY.signature-SENTINEL-XXX";
const SENTINELS = [SENTINEL_CA, SENTINEL_CERT, SENTINEL_KEY, SENTINEL_BEARER];

function sentinelBlobText(endpoint = "wss://core.test:9444", label = "the-test-core"): string {
  return Buffer.from(
    JSON.stringify({
      endpoint,
      label,
      caCert: SENTINEL_CA,
      clientCert: SENTINEL_CERT,
      clientKey: SENTINEL_KEY,
      bearer: SENTINEL_BEARER,
    }),
    "utf8",
  ).toString("base64");
}

function searchSentinelBlobText(endpoint = "https://search.test:8443", label = "the-test-search"): string {
  return Buffer.from(
    JSON.stringify({
      endpoint,
      label,
      caCert: SENTINEL_CA,
      clientCert: SENTINEL_CERT,
      clientKey: SENTINEL_KEY,
      bearer: SENTINEL_BEARER,
    }),
    "utf8",
  ).toString("base64");
}

const roots: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "actana-registry-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("where the registry lives", () => {
  it("honours XDG_CONFIG_HOME", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: "/xdg/config" }, "/home/someone");
    expect(paths.root).toBe("/xdg/config/actana");
    expect(paths.coresDir).toBe("/xdg/config/actana/cores");
    expect(paths.searchDir).toBe("/xdg/config/actana/search");
    expect(paths.currentPointer).toBe("/xdg/config/actana/current.txt");
    expect(paths.currentJson).toBe("/xdg/config/actana/current.json");
    expect(paths.legacySearchCliJson).toBe("/home/someone/.actana-search/cli.json");
  });

  it("falls back to ~/.config when it is unset", () => {
    const paths = registryPaths({}, "/home/someone");
    expect(paths.coresDir).toBe("/home/someone/.config/actana/cores");
  });

  it("ignores a relative XDG_CONFIG_HOME rather than resolving it against the cwd", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: "relative/config" }, "/home/someone");
    expect(paths.coresDir).toBe("/home/someone/.config/actana/cores");
  });

  it("puts the `current` pointer beside `cores/`, so a Core may be named `current`", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: "/xdg" }, "/home/someone");
    expect(coreBlobPath(paths, "current")).toBe("/xdg/actana/cores/current.txt");
    expect(paths.currentPointer).not.toBe(coreBlobPath(paths, "current"));
  });
});

describe("a blob is a credential", () => {
  it("writes it at mode 0600, in a directory only its owner can read", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    writeCoreBlob(paths, "prod", sentinelBlobText());

    expect(statSync(coreBlobPath(paths, "prod")).mode & 0o777).toBe(BLOB_FILE_MODE);
    expect(statSync(paths.coresDir).mode & 0o777).toBe(0o700);
  });

  it("re-tightens the mode when it overwrites a file something else loosened", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    mkdirSync(paths.coresDir, { recursive: true });
    const file = coreBlobPath(paths, "prod");
    writeFileSync(file, "stale");
    chmodSync(file, 0o644);

    writeCoreBlob(paths, "prod", sentinelBlobText());
    expect(statSync(file).mode & 0o777).toBe(BLOB_FILE_MODE);
  });

  it("reports a loose mode in the registry rather than silently repairing it", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    writeCoreBlob(paths, "prod", sentinelBlobText());
    chmodSync(coreBlobPath(paths, "prod"), 0o644);

    const [row] = readRegistry(paths);
    expect(row!.insecureMode).toBe(true);
  });
});

describe("what a Core may be named", () => {
  it("accepts ordinary names", () => {
    for (const name of ["prod", "dev-core", "core_2", "Core.EU", "a"]) {
      expect(coreNameError(name), name).toBeNull();
    }
  });

  it("refuses anything that could become a different path", () => {
    for (const name of ["..", ".", "../etc/passwd", "a/b", "a\\b", ".hidden", "", " prod"]) {
      expect(coreNameError(name), name).not.toBeNull();
    }
  });

  it("refuses a name too long to tabulate", () => {
    expect(coreNameError("a".repeat(65))).not.toBeNull();
    expect(coreNameError("a".repeat(64))).toBeNull();
  });
});

describe("listing and the current pointer", () => {
  it("lists nothing, rather than throwing, before anything is registered", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    expect(listCoreNames(paths)).toEqual([]);
    expect(readRegistry(paths)).toEqual([]);
    expect(readCurrentCore(paths)).toBeNull();
  });

  it("sorts, so two runs print the same table", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    for (const name of ["zeta", "alpha", "mid"]) writeCoreBlob(paths, name, sentinelBlobText());
    expect(listCoreNames(paths)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("reads a pointer at a Core that has since been removed as `nothing selected`", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    writeCoreBlob(paths, "prod", sentinelBlobText());
    writeCurrentCore(paths, "prod");
    expect(readCurrentCore(paths)).toBe("prod");

    removeCoreBlob(paths, "prod");
    expect(readCurrentCore(paths)).toBeNull();
  });

  it("clears cleanly when there is no pointer to clear", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    expect(() => clearCurrentCore(paths)).not.toThrow();
  });

  it("lists a hand-placed file whose name no verb would accept", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    writeCoreBlob(paths, "good", sentinelBlobText());
    mkdirSync(paths.coresDir, { recursive: true });
    writeFileSync(path.join(paths.coresDir, "my core.txt"), sentinelBlobText());

    expect(listCoreNames(paths)).toEqual(["good", "my core"]);

    const rows = readRegistry(paths);
    const odd = rows.find((r) => r.name === "my core");
    expect(odd?.error).toContain("not a usable Core name");
    expect(odd?.error).toContain("my core.txt");
    expect(odd?.summary).toBeNull();
  });

  it("does not suggest a name a verb would then refuse", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    writeCoreBlob(paths, "good", sentinelBlobText());
    mkdirSync(paths.coresDir, { recursive: true });
    writeFileSync(path.join(paths.coresDir, "my core.txt"), sentinelBlobText());

    expect(listUsableCoreNames(paths)).toEqual(["good"]);
  });

  it("surfaces a corrupt entry as a row with a reason, not as a missing row", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    writeCoreBlob(paths, "good", sentinelBlobText());
    writeCoreBlob(paths, "broken", "not-a-blob!!");

    const rows = readRegistry(paths);
    expect(rows.map((r) => r.name)).toEqual(["broken", "good"]);
    expect(rows[0]!.error).toBeTruthy();
    expect(rows[0]!.summary).toBeNull();
    expect(rows[1]!.summary?.endpoint).toBe("wss://core.test:9444");
  });
});

describe("loading a blob for the SDK", () => {
  it("returns the blob object, with no path or encoding on it (#129 D9)", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    writeCoreBlob(paths, "prod", sentinelBlobText());

    const loaded = loadCoreBlob(paths, "prod");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(Object.keys(loaded.blob).sort()).toEqual([
      "bearer",
      "caCert",
      "clientCert",
      "clientKey",
      "endpoint",
      "label",
    ]);
  });

  it("names the Core rather than the file when there is nothing stored", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    const loaded = loadCoreBlob(paths, "absent");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("absent");
  });

  it("stores the blob text as given, with one trailing newline", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    const text = sentinelBlobText();
    writeCoreBlob(paths, "prod", `  ${text}\n\n`);
    expect(readFileSync(coreBlobPath(paths, "prod"), "utf8")).toBe(`${text}\n`);
  });
});

describe("legacy layout migration", () => {
  it("imports cli.json and current.txt so both credentials are usable", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);

    mkdirSync(paths.coresDir, { recursive: true });
    writeCoreBlob(paths, "prod", sentinelBlobText());
    writeFileSync(paths.currentPointer, "prod\n");

    const searchBlob = searchSentinelBlobText();
    mkdirSync(path.dirname(paths.legacySearchCliJson), { recursive: true });
    writeFileSync(
      paths.legacySearchCliJson,
      `${JSON.stringify(
        {
          version: 1,
          defaultProfile: "docs",
          profiles: {
            docs: {
              blob: searchBlob,
              endpoint: "https://search.test:8443",
              label: "docs-search",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    ensureCredentialRegistry(paths);

    expect(listSearchNames(paths)).toEqual(["docs"]);
    expect(readSearchBlobText(paths, "docs")).toBe(`${searchBlob}\n`);
    expect(readCurrentCore(paths)).toBe("prod");
    expect(readCurrentSearch(paths)).toBe("docs");
    expect(readCurrentPointers(paths)).toEqual({ core: "prod", search: "docs" });
    expect(readCoreBlobText(paths, "prod")).toBeTruthy();
    expect(loadCoreBlob(paths, "prod").ok).toBe(true);
  });
});

describe("verbose output never prints a credential", () => {
  it("redacts blob material, PEMs and bearer tokens from diagnostic text", () => {
    const blob = sentinelBlobText();
    const raw = [
      `stored blob ${blob}`,
      `ca ${SENTINEL_CA}`,
      `key ${SENTINEL_KEY}`,
      `bearer ${SENTINEL_BEARER}`,
    ].join("\n");
    const redacted = redactCredentialSecrets(raw);
    for (const sentinel of SENTINELS) {
      expect(redacted).not.toContain(sentinel);
    }
    expect(redacted).not.toContain(blob);
  });

  it("never puts credential material in verbose registry lines", () => {
    const home = tempHome();
    const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
    const blob = sentinelBlobText();
    writeCoreBlob(paths, "prod", blob);

    const line = verboseRegistryDetail("stored credential", {
      path: coreBlobPath(paths, "prod"),
      blobText: readCoreBlobText(paths, "prod")!,
    });

    for (const sentinel of SENTINELS) {
      expect(line).not.toContain(sentinel);
    }
    expect(line).not.toContain(blob);
    expect(line).toContain("stored credential");
    expect(line).toContain("prod.txt");
  });
});
