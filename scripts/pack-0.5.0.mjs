#!/usr/bin/env node
// T-222 — build and pack @actana/sdk + @actana/cli 0.5.0 tarballs for local consumption.
//
// Writes actana-sdk-0.5.0.tgz and actana-cli-0.5.0.tgz under .pack/ (gitignored).
// Phase 3 (Search) can install with file: paths until npm publishes 0.5.0.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, ".pack");

function run(label, args, opts = {}) {
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    ...opts,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${label} failed (exit ${result.status ?? "unknown"})`);
  }
  return result;
}

if (spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error("pack-0.5.0: pnpm not found on PATH");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

run("sdk build", ["--filter", "@actana/sdk", "run", "build"]);
run("cli build", ["--filter", "@actana/cli", "run", "build"]);

run("sdk pack", ["--filter", "@actana/sdk", "pack", "--pack-destination", outDir]);
run("cli pack", ["--filter", "@actana/cli", "pack", "--pack-destination", outDir]);

const sdkTgz = join(outDir, "actana-sdk-0.5.0.tgz");
const cliTgz = join(outDir, "actana-cli-0.5.0.tgz");

for (const file of [sdkTgz, cliTgz]) {
  if (!existsSync(file)) {
    console.error(`pack-0.5.0: expected tarball missing: ${file}`);
    process.exit(1);
  }
}

const cliManifest = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8"));
if (cliManifest.version !== "0.5.0") {
  console.error(`pack-0.5.0: expected CLI 0.5.0, got ${cliManifest.version}`);
  process.exit(1);
}

process.stdout.write(
  [
    "pack-0.5.0: OK",
    `  ${sdkTgz}`,
    `  ${cliTgz}`,
    "",
    "Install in another repo (phase 3) with:",
    `  "@actana/sdk": "file:${sdkTgz}"`,
    `  "@actana/cli": "file:${cliTgz}"`,
    "",
  ].join("\n"),
);
