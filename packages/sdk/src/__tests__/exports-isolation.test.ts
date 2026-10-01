import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const probeScript = join(sdkRoot, "scripts/probe-export.mjs");
const nodeArgs = [probeScript];
const packageJson = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
const exportsMap = packageJson.exports as Record<string, string>;

beforeAll(() => {
  const build = spawnSync("pnpm", ["run", "build"], { cwd: sdkRoot, encoding: "utf8" });
  expect(build.status, build.stderr || build.stdout).toBe(0);
});

type Dep = "ws" | "zod" | "pg" | "undici";

function probeExport(subpath: string): Dep[] {
  const child = spawnSync(process.execPath, [...nodeArgs, subpath], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  expect(child.status, child.stderr || child.stdout).toBe(0);
  return JSON.parse(child.stdout.trim()) as Dep[];
}

function depNames(hits: string[]): Dep[] {
  const names = new Set<Dep>();
  for (const hit of hits) {
    if (hit === "ws" || hit === "zod" || hit === "pg" || hit === "undici") {
      names.add(hit);
      continue;
    }
    const match = hit.match(/node_modules[\\/](ws|zod|pg|undici)([\\/]|$)/);
    if (match) names.add(match[1] as Dep);
  }
  return [...names];
}

describe("SDK export isolation", () => {
  it("exports exactly the documented subpaths (no root barrel, no catch-all)", () => {
    expect(Object.keys(exportsMap).sort()).toEqual(
      [
        "./core",
        "./core/link-frames",
        "./pairing",
        "./pairing/server",
        "./pairing/stores/json-file",
        "./pairing/stores/postgres",
        "./search",
        "./shared",
        "./shared-key",
      ].sort(),
    );
    expect(Object.hasOwn(exportsMap, ".")).toBe(false);
    expect(Object.hasOwn(exportsMap, "./*")).toBe(false);
  });

  it("rejects import of the package root (no barrel)", () => {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "import('@actana/sdk')"],
      { cwd: sdkRoot, encoding: "utf8" },
    );
    expect(child.status).not.toBe(0);
    expect(`${child.stderr}${child.stdout}`).toMatch(/not exported|ERR_PACKAGE_PATH_NOT_EXPORTED/i);
  });

  it.each(["@actana/sdk/pairing/client", "@actana/sdk/search/contracts"] as const)(
    "rejects deep import %s",
    (specifier) => {
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `import('${specifier}')`],
        { cwd: sdkRoot, encoding: "utf8" },
      );
      expect(child.status).not.toBe(0);
      expect(`${child.stderr}${child.stdout}`).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED/i);
    },
  );

  it.each(["./pairing", "./pairing/server", "./pairing/stores/json-file"] as const)(
    "importing %s does not load ws, zod, or pg",
    (subpath) => {
      const loaded = depNames(probeExport(subpath));
      expect(loaded).not.toContain("ws");
      expect(loaded).not.toContain("zod");
      expect(loaded).not.toContain("pg");
    },
  );

  it("importing ./core may load ws and undici", () => {
    const loaded = depNames(probeExport("./core"));
    expect(loaded).toContain("ws");
    expect(loaded).toContain("undici");
    expect(loaded).not.toContain("zod");
    expect(loaded).not.toContain("pg");
  });

  it("importing ./core/link-frames loads none of ws, undici, zod or pg", () => {
    expect(depNames(probeExport("./core/link-frames"))).toEqual([]);
  });

  it("importing ./shared-key loads none of ws, undici, zod or pg", () => {
    expect(depNames(probeExport("./shared-key"))).toEqual([]);
  });

  it("importing ./search does not load ws", () => {
    const loaded = depNames(probeExport("./search"));
    expect(loaded).not.toContain("ws");
  });

  it("only ./pairing/stores/postgres may load pg among the public exports", () => {
    const publicExports = [
      "./pairing",
      "./pairing/server",
      "./pairing/stores/json-file",
      "./core",
      "./core/link-frames",
      "./search",
    ];
    for (const subpath of publicExports) {
      expect(depNames(probeExport(subpath))).not.toContain("pg");
    }
  });
});
