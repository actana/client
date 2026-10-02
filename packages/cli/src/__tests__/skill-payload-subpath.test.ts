// The `@actana/cli/skill-payload` subpath (client issue 11, found by actana/control#645).
//
// The Core daemon and a small Core helper import the orchestration skill payload from the package
// root, and the root drags the whole client and its `ws` dependency into a bundle that has to stand
// alone. The subpath is the payload and nothing else. These tests bundle a file that imports only
// the subpath, with the bundler vitest already ships (reached through vitest -> vite, as
// `orchestration-skill-payload.test.ts` does; nothing is added to the tree), and prove that no `ws`
// and no SDK code is in the result, that it still starts as CommonJS, and that the subpath and the
// root hand out identical values.

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as root from "../index.ts";
import * as subpath from "../skill-payload.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");
const PACKAGE = path.resolve(SRC, "..");

async function bundler(): Promise<(options: unknown) => Promise<unknown>> {
  const fromHere = createRequire(import.meta.url);
  const viaVitest = createRequire(fromHere.resolve("vitest/package.json"));
  const viaVite = createRequire(viaVitest.resolve("vite/package.json"));
  const mod = (await import(pathToFileURL(viaVite.resolve("rolldown")).href)) as {
    build: (options: unknown) => Promise<unknown>;
  };
  return mod.build;
}

const scratch = mkdtempSync(path.join(tmpdir(), "actana-subpath-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function bundleToCjs(name: string, source: string): Promise<{ file: string; code: string }> {
  const input = path.join(scratch, `${name}.ts`);
  const file = path.join(scratch, `${name}.cjs`);
  writeFileSync(input, source);
  const build = await bundler();
  await build({ input, platform: "node", output: { file, format: "cjs" }, logLevel: "silent" });
  return { file, code: readFileSync(file, "utf8") };
}

const printPayload = (from: string): string =>
  `import * as payload from ${JSON.stringify(from)};\n` +
  `process.stdout.write(JSON.stringify({ names: payload.ORCHESTRATION_SKILL_NAMES, ` +
  `marker: payload.ORCHESTRATION_SKILL_MARKER, files: payload.ORCHESTRATION_SKILL_FILES }));\n`;

describe("the skill-payload subpath", () => {
  it("is in the exports map, from source in the workspace and from dist once published", () => {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8")) as {
      exports: Record<string, string>;
      publishConfig: { exports: Record<string, { types: string; default: string }> };
    };
    expect(pkg.exports["./skill-payload"]).toBe("./src/skill-payload.ts");
    expect(pkg.publishConfig.exports["./skill-payload"]).toEqual({
      types: "./dist/skill-payload.d.ts",
      default: "./dist/skill-payload.js",
    });
    expect(pkg.exports["."]).toBe("./src/index.ts");
  });

  it("hands out the same values as the package root", () => {
    expect(subpath.ORCHESTRATION_SKILL_NAMES).toEqual(root.ORCHESTRATION_SKILL_NAMES);
    expect(subpath.ORCHESTRATION_SKILL_MARKER).toBe(root.ORCHESTRATION_SKILL_MARKER);
    expect(subpath.ORCHESTRATION_SKILL_FILES).toEqual(root.ORCHESTRATION_SKILL_FILES);
    expect(subpath.ORCHESTRATION_SKILL_NAMES).toBe(root.ORCHESTRATION_SKILL_NAMES);
    expect(subpath.ORCHESTRATION_SKILL_MARKER).toBe(root.ORCHESTRATION_SKILL_MARKER);
    expect(subpath.ORCHESTRATION_SKILL_FILES).toBe(root.ORCHESTRATION_SKILL_FILES);
    expect(Object.keys(subpath).sort()).toEqual([
      "ORCHESTRATION_SKILL_FILES",
      "ORCHESTRATION_SKILL_MARKER",
      "ORCHESTRATION_SKILL_NAMES",
    ]);
  });

  it("bundles to code with no ws, no SDK and no other client module in it, and it starts", async () => {
    const { file, code } = await bundleToCjs(
      "subpath",
      printPayload(path.join(SRC, "skill-payload.ts")),
    );
    // Nothing is required at all: a bundle that reaches `ws` or the SDK has to say so with a require.
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/from ["'](?!node:)/);
    expect(code).not.toContain("WebSocket");
    expect(code).not.toContain("@actana/sdk");
    expect(code).not.toContain("actana — reach your Cores");
    // The module graph, as the bundler printed it: the test's entry and the payload module, whose JSON
    // is inlined into it. A re-export-only module and the JSON print no region of their own.
    const regions = [...code.matchAll(/^\/\/#region (.+)$/gm)].map((m) => m[1]!.replace(/^(\.\.\/)+/, ""));
    const inPackage = regions.filter((r) => !r.startsWith("tmp/") && !r.includes("actana-subpath-"));
    expect(inPackage.map((r) => r.replace(/^.*?(src\/)/, "$1"))).toEqual([
      "src/core/orchestration-skill-payload.ts",
    ]);

    const run = spawnSync(process.execPath, [file], { cwd: tmpdir(), encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      names: [...root.ORCHESTRATION_SKILL_NAMES],
      marker: root.ORCHESTRATION_SKILL_MARKER,
      files: root.ORCHESTRATION_SKILL_FILES,
    });
  }, 60_000);

  it("is not vacuous: the same bundle taken from the package root does carry the client and ws", async () => {
    const { code } = await bundleToCjs("root", printPayload(path.join(SRC, "index.ts")));
    expect(code).toContain("WebSocket");
    expect(code).toContain("actana — reach your Cores");
  }, 60_000);
});
