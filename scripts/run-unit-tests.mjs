#!/usr/bin/env node
// `pnpm test` — every package suite, every time, and a report that names what
// failed. `pnpm -r test` bails on the first failing package and hides the rest.

import { spawnSync } from "node:child_process";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

const STAGES = [
  { name: "scripts", command: ["exec", "vitest", "run", "--config", "vitest.config.ts"] },
  { name: "@actana/sdk", filter: "@actana/sdk" },
  { name: "@actana/cli", filter: "@actana/cli" },
  { name: "changesets (CLI-only bump)", script: "scripts/assert-cli-only-changeset.mjs" },
];

const results = [];

for (const stage of STAGES) {
  console.log(`\n── ${stage.name} ──`);
  const run = stage.script
    ? spawnSync(process.execPath, [path.join(repoRoot, stage.script)], {
        cwd: repoRoot,
        stdio: "inherit",
        env: process.env,
      })
    : spawnSync(
        "pnpm",
        stage.command ?? ["--filter", stage.filter, "--if-present", "test"],
        { cwd: repoRoot, stdio: "inherit", env: process.env },
      );
  results.push({ ...stage, code: run.status ?? 1 });
}

const failed = results.filter((r) => r.code !== 0);

console.log("\n── summary ──");
for (const r of results) {
  console.log(`${r.code === 0 ? "✓" : "✗"} ${r.name}`);
}

if (failed.length > 0) {
  const names = failed.map((r) => r.name).join(", ");
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Unit Tests::Red suites: ${names}`);
  }
  console.error(`\n${failed.length} suite(s) failed: ${names}`);
  process.exit(1);
}

console.log("\nAll suites passed.");
