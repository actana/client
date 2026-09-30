import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const smokeScript = join(repoRoot, "scripts/smoke-pack-0.5.0.mjs");

describe("packed 0.5.0 smoke (T-222)", () => {
  it("packs, dry-runs publish, and runs actana from tarballs", { timeout: 180_000 }, () => {
    const result = spawnSync(process.execPath, [smokeScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
    });
    if (result.status !== 0) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    expect(result.stderr).not.toContain("npm publish --dry-run failed");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("smoke-pack-0.5.0: OK");
    // The dry run uses a throwaway prerelease in a scratch copy, never the real version.
    expect(result.stdout).toMatch(/npm publish --dry-run: .* as 0\.0\.0-smoke\.\d+/);
    for (const pkg of ["sdk", "cli"]) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, `packages/${pkg}/package.json`), "utf8"));
      expect(manifest.version).not.toContain("smoke");
    }
  });

  describe("without pnpm on PATH", () => {
    // The smoke script is started by its absolute node path, so a PATH that holds only a
    // scratch directory hides pnpm and every other tool the real environment provides.
    function runWithPath(dir) {
      return spawnSync(process.execPath, [smokeScript], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, CI: "true", PATH: dir },
      });
    }

    function withScratchDir(fn) {
      const dir = mkdtempSync(join(tmpdir(), "actana-smoke-test-"));
      try {
        return fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("fails loudly, naming the cause, when corepack is missing too", () => {
      withScratchDir((dir) => {
        const result = runWithPath(dir);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("pnpm is not on PATH and corepack pnpm is unavailable");
        expect(result.stdout).not.toContain("smoke-pack-0.5.0: OK");
      });
    });

    it("runs pnpm through corepack pnpm instead of skipping", () => {
      withScratchDir((dir) => {
        const log = join(dir, "corepack.log");
        const fake = join(dir, "corepack");
        writeFileSync(
          fake,
          `#!/bin/sh\necho "$@" >> "${log}"\n[ "$*" = "pnpm --version" ] && { echo 9.9.9; exit 0; }\nexit 3\n`,
        );
        chmodSync(fake, 0o755);
        const result = runWithPath(dir);
        const calls = readFileSync(log, "utf8");
        expect(calls).toContain("pnpm --version");
        // The pack step reached pnpm through the shim, so the fake corepack was asked to build.
        expect(calls).toMatch(/^pnpm --filter @actana\/sdk run build$/m);
        expect(result.stdout).toContain("running through corepack pnpm 9.9.9");
        expect(result.stderr).toContain("sdk build failed (exit 3)");
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("smoke-pack-0.5.0: OK");
      });
    });
  });
});
