#!/usr/bin/env node
// T-222 — smoke-test packed @actana/sdk and @actana/cli tarballs in an isolated directory.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packScript = join(repoRoot, "scripts/pack-0.5.0.mjs");

function fail(message) {
  console.error(`smoke-pack-0.5.0: ${message}`);
  process.exit(1);
}

function run(cwd, command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ...env },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    fail(`command failed: ${command} ${args.join(" ")}`);
  }
  return (result.stdout ?? "").trim();
}

// pack-0.5.0.mjs calls plain `pnpm`. When it is not on PATH, put a shim that runs
// `corepack pnpm` in front of PATH for every child; if that cannot work either, fail
// with the reason instead of letting the caller believe the pack ran.
function ensurePnpm() {
  if (spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status === 0) return;
  const probe = spawnSync("corepack", ["pnpm", "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  if (probe.status !== 0) {
    const reason = probe.error?.message ?? (probe.stderr || probe.stdout || `exit ${probe.status}`).trim();
    fail(`pnpm is not on PATH and corepack pnpm is unavailable: ${reason}`);
  }
  const shimDir = mkdtempSync(join(tmpdir(), "actana-smoke-pnpm-"));
  const shim = join(shimDir, "pnpm");
  writeFileSync(shim, '#!/bin/sh\nexec corepack pnpm "$@"\n');
  chmodSync(shim, 0o755);
  process.on("exit", () => rmSync(shimDir, { recursive: true, force: true }));
  process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  console.log(`smoke-pack-0.5.0: pnpm not on PATH, running through corepack pnpm ${probe.stdout.trim()}`);
}

ensurePnpm();

run(repoRoot, process.execPath, [packScript]);

// Versions come from the package manifests, so the smoke runs for any version (0.6.0-next.0 too).
const sdkVersion = JSON.parse(readFileSync(join(repoRoot, "packages/sdk/package.json"), "utf8")).version;
const cliVersion = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8")).version;
const sdkTgz = join(repoRoot, `.pack/actana-sdk-${sdkVersion}.tgz`);
const cliTgz = join(repoRoot, `.pack/actana-cli-${cliVersion}.tgz`);
if (!existsSync(sdkTgz) || !existsSync(cliTgz)) {
  fail("missing tarballs under .pack/");
}

const smokeRoot = mkdtempSync(join(tmpdir(), "actana-smoke-0.5.0-"));
writeFileSync(
  join(smokeRoot, "package.json"),
  `${JSON.stringify({ name: "actana-smoke", private: true, type: "module" }, null, 2)}\n`,
);

run(smokeRoot, "npm", ["install", sdkTgz, cliTgz, "--no-fund", "--no-audit"]);

const installedCli = JSON.parse(
  readFileSync(join(smokeRoot, "node_modules/@actana/cli/package.json"), "utf8"),
);
if (installedCli.dependencies?.["@actana/sdk"] !== sdkVersion) {
  fail(`packed CLI must depend on @actana/sdk@${sdkVersion}, got ${installedCli.dependencies?.["@actana/sdk"]}`);
}

const importProbe = `
const pairing = await import("@actana/sdk/pairing");
const search = await import("@actana/sdk/search");
const core = await import("@actana/sdk/core");
const cli = await import("@actana/cli");
if (typeof pairing.encodeRegistrationBlob !== "function") throw new Error("pairing export missing");
if (typeof search.SearchClient !== "function") throw new Error("search export missing");
if (typeof core.CoreClient !== "function") throw new Error("core export missing");
if (typeof cli.runClient !== "function") throw new Error("cli.runClient missing");
if (cli.NOT_HANDLED !== Symbol.for("actana.cli.NOT_HANDLED")) throw new Error("cli.NOT_HANDLED missing");
if (typeof cli.clientHelp !== "function") throw new Error("cli.clientHelp missing");
console.log("imports-ok");
`;
run(smokeRoot, process.execPath, ["--input-type=module", "-e", importProbe]);

const actanaBin = join(smokeRoot, "node_modules/.bin/actana");
const helpOut = run(smokeRoot, actanaBin, ["--help"]);
if (!helpOut.includes("Cores") || !helpOut.includes("Search")) {
  fail("actana --help must mention Cores and Search");
}

const versionOut = run(smokeRoot, actanaBin, ["-V"]);
if (!versionOut.includes(cliVersion)) {
  fail(`actana -V must print ${cliVersion}, got: ${versionOut}`);
}

// Dry-run publish against a throwaway prerelease so it can never collide with a version
// already on npm. The version is rewritten only inside a scratch copy of each tarball;
// the real package.json files and the packed tarballs under .pack/ are left untouched.
const smokeVersion = `0.0.0-smoke.${Date.now()}`;
const publishRoot = mkdtempSync(join(tmpdir(), "actana-smoke-publish-"));
const publishEnv = { ...process.env, CI: "true" };
for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "npm_config__authToken"]) delete publishEnv[key];

function dryRunPublish(name, tgz) {
  const dir = join(publishRoot, name);
  mkdirSync(dir, { recursive: true });
  run(dir, "tar", ["-xzf", tgz]);
  const manifestPath = join(dir, "package/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = smokeVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const scratchTgz = join(publishRoot, `${name}.tgz`);
  run(dir, "tar", ["-czf", scratchTgz, "package"]);
  const result = spawnSync("npm", ["publish", "--dry-run", "--tag", "smoke", scratchTgz], {
    cwd: publishRoot,
    encoding: "utf8",
    env: publishEnv,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    fail(`npm publish --dry-run failed for ${manifest.name}@${smokeVersion}`);
  }
  return manifest.name;
}

const dryRunNames = [dryRunPublish("sdk", sdkTgz), dryRunPublish("cli", cliTgz)];
rmSync(publishRoot, { recursive: true, force: true });

const cliListing = spawnSync("tar", ["-tzf", cliTgz], { encoding: "utf8" });
if (cliListing.status !== 0) fail("could not list CLI tarball");
if (/^(package\/)?src\//m.test(cliListing.stdout ?? "")) {
  fail("CLI tarball must not ship src/*.ts");
}

console.log("smoke-pack-0.5.0: OK");
console.log(`  actana --help: Cores + Search present`);
console.log(`  actana -V: ${versionOut}`);
console.log(`  @actana/cli → @actana/sdk@${installedCli.dependencies["@actana/sdk"]}`);
console.log(`  CLI tarball: no src/ (dist + bin + data only)`);
console.log(`  npm publish --dry-run: ${dryRunNames.join(", ")} as ${smokeVersion} (scratch copy)`);

rmSync(smokeRoot, { recursive: true, force: true });
