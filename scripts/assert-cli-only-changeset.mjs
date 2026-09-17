#!/usr/bin/env node
// T-220 — prove a CLI-only changeset bumps @actana/cli and leaves @actana/sdk alone.
// Dry-run: copies the workspace into a temp dir, applies one patch changeset for the
// CLI, runs `changeset version`, and asserts the SDK version is unchanged.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const changesetCli = path.join(
  repoRoot,
  "node_modules/@changesets/cli/bin.js",
);

function readVersion(packageDir) {
  const manifest = JSON.parse(
    readFileSync(path.join(packageDir, "package.json"), "utf8"),
  );
  return manifest.version;
}

function fail(message) {
  console.error(`assert-cli-only-changeset: ${message}`);
  process.exit(1);
}

if (!existsSync(changesetCli)) {
  fail("install dependencies first (`pnpm install`)");
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "actana-changeset-cli-only-"));

try {
  cpSync(path.join(repoRoot, "package.json"), path.join(tempRoot, "package.json"));
  cpSync(path.join(repoRoot, "pnpm-workspace.yaml"), path.join(tempRoot, "pnpm-workspace.yaml"));
  cpSync(path.join(repoRoot, ".changeset"), path.join(tempRoot, ".changeset"), {
    recursive: true,
  });
  cpSync(path.join(repoRoot, "packages"), path.join(tempRoot, "packages"), {
    recursive: true,
  });

  const sdkBefore = readVersion(path.join(tempRoot, "packages/sdk"));
  const cliBefore = readVersion(path.join(tempRoot, "packages/cli"));

  writeFileSync(
    path.join(tempRoot, ".changeset/cli-only-test.md"),
    `---
"@actana/cli": patch
---

CLI-only changeset dry-run (T-220).
`,
  );

  const version = spawnSync(process.execPath, [changesetCli, "version"], {
    cwd: tempRoot,
    encoding: "utf8",
  });

  if (version.status !== 0) {
    console.error(version.stdout);
    console.error(version.stderr);
    fail("`changeset version` failed");
  }

  const sdkAfter = readVersion(path.join(tempRoot, "packages/sdk"));
  const cliAfter = readVersion(path.join(tempRoot, "packages/cli"));

  if (sdkAfter !== sdkBefore) {
    fail(
      `@actana/sdk changed ${sdkBefore} → ${sdkAfter}; expected no bump for a CLI-only changeset`,
    );
  }

  if (cliAfter === cliBefore) {
    fail(`@actana/cli stayed at ${cliBefore}; expected a patch bump`);
  }

  console.log(
    `OK: CLI-only changeset bumped @actana/cli ${cliBefore} → ${cliAfter}; @actana/sdk stayed ${sdkBefore}`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
