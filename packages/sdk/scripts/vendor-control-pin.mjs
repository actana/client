// Extract actana/control @ 9d91c77 (merged PR 620, the Files API at /v1/files, on feat/0.5.0) for test-only @actana/core and @actana/shared aliases.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findActanaControlSibling } from "./find-actana-control-sibling.mjs";

const PIN = "9d91c77b6190520ba69dd6cb338f85b931f0ba3c";
const here = path.dirname(fileURLToPath(import.meta.url));
// Same path vitest.config.ts resolves: <client-root>/.vendor/control-9d91c77
const vendorRoot = path.resolve(here, "../../../.vendor/control-9d91c77");
const vendorSrc = path.join(vendorRoot, "src");
const controlRepo = findActanaControlSibling(here);

if (existsSync(path.join(vendorSrc, "pty-core-link-server.ts"))) {
  process.exit(0);
}

mkdirSync(vendorRoot, { recursive: true });
const archive = spawnSync(
  "git",
  ["-C", controlRepo, "archive", PIN, "packages/core/src", "packages/shared/src"],
  { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
);
if (archive.status !== 0) {
  throw new Error(
    `git archive ${PIN} failed: ${archive.stderr?.toString() || archive.error?.message}`,
  );
}
execFileSync("tar", ["-x", "--strip-components=2"], { input: archive.stdout, cwd: vendorRoot });
