#!/usr/bin/env node
// T-222 — build and pack the @actana/sdk + @actana/cli tarballs for local consumption.
//
// Writes actana-sdk-<version>.tgz and actana-cli-<version>.tgz under .pack/ (gitignored). Each
// version is read from that package's package.json, so any version works, a prerelease such as
// 0.6.0-next.0 included. (The file name still says 0.5.0 because the scripts were named for it.)
// Phase 3 (Search) can install with file: paths until npm publishes the version.

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

const sdkManifest = JSON.parse(readFileSync(join(repoRoot, "packages/sdk/package.json"), "utf8"));
const cliManifest = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8"));
const sdkTgz = join(outDir, `actana-sdk-${sdkManifest.version}.tgz`);
const cliTgz = join(outDir, `actana-cli-${cliManifest.version}.tgz`);

for (const file of [sdkTgz, cliTgz]) {
  if (!existsSync(file)) {
    console.error(`pack-0.5.0: expected tarball missing: ${file}`);
    process.exit(1);
  }
}

// A packed CLI must name a real version; the tarball existing above already ties it to package.json.
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
for (const manifest of [sdkManifest, cliManifest]) {
  if (!SEMVER.test(manifest.version)) {
    console.error(`pack-0.5.0: ${manifest.name} has no valid semver version: ${manifest.version}`);
    process.exit(1);
  }
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
