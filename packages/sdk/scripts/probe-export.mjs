// Probe one SDK export subpath in an isolated Node process (built dist entries).
// Usage: node scripts/probe-export.mjs ./pairing

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const subpath = process.argv[2];

if (!subpath) {
  console.error("usage: probe-export.mjs <export-subpath>");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
const published = pkg.publishConfig?.exports?.[subpath];
const distRel =
  published && typeof published === "object" && typeof published.default === "string"
    ? published.default
    : null;
if (!distRel) {
  console.error(`missing publishConfig export: ${subpath}`);
  process.exit(2);
}

const entryPath = resolve(sdkRoot, distRel);
if (!existsSync(entryPath)) {
  console.error(`missing built entry: ${entryPath} (run pnpm build)`);
  process.exit(2);
}

const logDir = mkdtempSync(join(tmpdir(), "actana-isolation-"));
const logPath = join(logDir, "resolved.txt");
const entry = pathToFileURL(entryPath).href;
const bootstrap = pathToFileURL(join(sdkRoot, "scripts/isolation-bootstrap.mjs")).href;

const child = spawnSync(
  process.execPath,
  [`--import=${bootstrap}`, "--input-type=module", "-e", `await import(${JSON.stringify(entry)});`],
  {
    cwd: sdkRoot,
    env: { ...process.env, ACTANA_ISOLATION_LOG: logPath },
    encoding: "utf8",
  },
);

if (child.status !== 0) {
  process.stderr.write(child.stderr || child.stdout || `probe failed for ${subpath}\n`);
  rmSync(logDir, { recursive: true, force: true });
  process.exit(child.status ?? 1);
}

const resolved = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
rmSync(logDir, { recursive: true, force: true });

const depPattern = /(?:^|[\\/])node_modules[\\/](ws|zod|pg|undici)([\\/]|$)/;
const hits = resolved.filter(
  (specifier) =>
    specifier === "ws" ||
    specifier === "zod" ||
    specifier === "pg" ||
    specifier === "undici" ||
    depPattern.test(specifier),
);

process.stdout.write(JSON.stringify(hits));
