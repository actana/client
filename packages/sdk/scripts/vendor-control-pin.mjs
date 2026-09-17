// Extract actana/control @ d7eeb65 for test-only @actana/core and @actana/shared aliases.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findActanaControlSibling } from "./find-actana-control-sibling.mjs";

const PIN = "d7eeb65cd1f15e2bda56e7285da8b8ba8d3879cb";
const here = path.dirname(fileURLToPath(import.meta.url));
// Same path vitest.config.ts resolves: <client-root>/.vendor/control-d7eeb65
const vendorRoot = path.resolve(here, "../../../.vendor/control-d7eeb65");
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
