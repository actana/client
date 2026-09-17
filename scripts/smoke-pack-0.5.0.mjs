#!/usr/bin/env node
// T-222 — smoke-test packed @actana/sdk and @actana/cli tarballs in an isolated directory.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

if (spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status !== 0) {
  fail("pnpm not found on PATH");
}

run(repoRoot, process.execPath, [packScript]);

const sdkTgz = join(repoRoot, ".pack/actana-sdk-0.5.0.tgz");
const cliTgz = join(repoRoot, ".pack/actana-cli-0.5.0.tgz");
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
if (installedCli.dependencies?.["@actana/sdk"] !== "0.5.0") {
  fail(`packed CLI must depend on @actana/sdk@0.5.0, got ${installedCli.dependencies?.["@actana/sdk"]}`);
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
if (!versionOut.includes("0.5.0")) {
  fail(`actana -V must print 0.5.0, got: ${versionOut}`);
}

const dryRunSdk = spawnSync("npm", ["publish", "--dry-run", sdkTgz], {
  cwd: repoRoot,
  encoding: "utf8",
});
const dryRunCli = spawnSync("npm", ["publish", "--dry-run", cliTgz], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (dryRunSdk.status !== 0 || dryRunCli.status !== 0) {
  fail("npm publish --dry-run failed");
}

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
console.log(`  npm publish --dry-run: @actana/sdk@0.5.0, @actana/cli@0.5.0`);

rmSync(smokeRoot, { recursive: true, force: true });
