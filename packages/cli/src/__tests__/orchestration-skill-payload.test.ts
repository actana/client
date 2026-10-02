// The orchestration-skill payload: what it says, and that a CommonJS bundle can start with it
// (client issue 11, actana/control#578).
//
// A bundle of this CLI as CommonJS has no `import.meta.url`, and the payload module used to read its
// JSON from disk beside that URL at load — so the bundle crashed before it printed a word. The
// bundle test builds the real entry to CommonJS with the bundler that ships under vitest (no new
// dependency; it is reached through vitest and vite, the way the Core's own tarball build reaches its
// bundler) and starts it in a child process. A start is the assertion: exit 0, help on stdout,
// nothing on stderr.

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_MARKER,
  ORCHESTRATION_SKILL_NAMES,
} from "../core/orchestration-skill-payload.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");
const SKILL = ORCHESTRATION_SKILL_FILES["actana-sessions"]!["SKILL.md"]!;

describe("the actana-sessions skill teaches --await-prompt", () => {
  it("tells an agent to start with it when the next thing is a send, and shows the command", () => {
    expect(SKILL).toContain("--await-prompt");
    expect(SKILL).toMatch(/actana session start "<prompt>" --await-prompt/);
    expect(SKILL).toContain("Running is not the same fact as ready to be sent to");
  });

  it("says what its exit code and `promptDelivered: null` mean, and that it excludes --wait", () => {
    expect(SKILL).toContain("exits non-zero");
    expect(SKILL).toContain("promptDelivered: null");
    expect(SKILL).toContain("cannot be combined with `--await-prompt`");
  });

  it("keeps the marker the installer matches on, in every file it ships", () => {
    for (const name of ORCHESTRATION_SKILL_NAMES) {
      for (const [file, text] of Object.entries(ORCHESTRATION_SKILL_FILES[name]!)) {
        expect(text, `${name}/${file}`).toContain(ORCHESTRATION_SKILL_MARKER);
      }
    }
  });
});

describe("the payload module is a static import", () => {
  it("reads nothing from disk and asks for no `import.meta` at load", () => {
    const source = readFileSync(path.join(SRC, "core/orchestration-skill-payload.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("import.meta");
    expect(code).not.toMatch(/readFileSync|node:fs|fileURLToPath/);
    expect(code).toMatch(/import payload from "\.\.\/\.\.\/data\/orchestration-skill\.json" with \{ type: "json" \}/);
  });
});

/** The bundler vitest already ships, reached through vitest -> vite. Nothing is added to the tree. */
async function bundler(): Promise<(options: unknown) => Promise<unknown>> {
  const fromHere = createRequire(import.meta.url);
  const viaVitest = createRequire(fromHere.resolve("vitest/package.json"));
  const viaVite = createRequire(viaVitest.resolve("vite/package.json"));
  const mod = (await import(pathToFileURL(viaVite.resolve("rolldown")).href)) as {
    build: (options: unknown) => Promise<unknown>;
  };
  return mod.build;
}

const scratch = mkdtempSync(path.join(tmpdir(), "actana-cjs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function bundleToCjs(name: string, source: string): Promise<string> {
  const input = path.join(scratch, `${name}.ts`);
  const file = path.join(scratch, `${name}.cjs`);
  writeFileSync(input, source);
  const build = await bundler();
  await build({ input, platform: "node", output: { file, format: "cjs" }, logLevel: "silent" });
  return file;
}

describe("a CommonJS bundle of the CLI starts", () => {
  it("runs the real entry as CommonJS: help on stdout, exit 0, nothing on stderr", async () => {
    const file = await bundleToCjs(
      "entry",
      `import { runClient } from ${JSON.stringify(path.join(SRC, "entry.ts"))};\n` +
        `runClient(process.argv.slice(2)).then((code) => process.exit(code));\n`,
    );
    // Run from a directory that is not the package, so nothing is found by luck beside the bundle.
    const run = spawnSync(process.execPath, [file, "--help"], { cwd: tmpdir(), encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("actana — reach your Cores and Search instances");
  }, 60_000);

  it("carries the whole skill payload inside the bundle, --await-prompt included", async () => {
    const file = await bundleToCjs(
      "payload",
      `import { ORCHESTRATION_SKILL_FILES, ORCHESTRATION_SKILL_NAMES } from ` +
        `${JSON.stringify(path.join(SRC, "core/orchestration-skill-payload.ts"))};\n` +
        `process.stdout.write(JSON.stringify({ names: ORCHESTRATION_SKILL_NAMES, skill: ORCHESTRATION_SKILL_FILES["actana-sessions"]["SKILL.md"] }));\n`,
    );
    const run = spawnSync(process.execPath, [file], { cwd: tmpdir(), encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as { names: string[]; skill: string };
    expect(out.names).toEqual([...ORCHESTRATION_SKILL_NAMES]);
    expect(out.skill).toBe(SKILL);
  }, 60_000);
});
