import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const smokeScript = join(repoRoot, "scripts/smoke-pack-0.5.0.mjs");

describe("packed 0.5.0 smoke (T-222)", () => {
  it("packs, dry-runs publish, and runs actana from tarballs", { timeout: 180_000 }, () => {
    if (spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status !== 0) {
      return;
    }
    const result = spawnSync(process.execPath, [smokeScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
    });
    if (result.status !== 0) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("smoke-pack-0.5.0: OK");
  });
});
