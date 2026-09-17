#!/usr/bin/env node
/**
 * Diff actana/control main against origins-manifest.json.
 *
 * Reads Control only — never writes to it. On drift, optionally opens an issue
 * in actana/client naming the files (see `.github/workflows/drift-check.yml`).
 *
 *   node scripts/check-control-drift.mjs
 *   node scripts/check-control-drift.mjs --control-root /path/to/control --dry-run-issue
 */

import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import {
  CONTROL_REPO,
  DEFAULT_CONTROL_REF,
  DRIFT_ISSUE_TITLE,
  checkControlDrift,
  controlSourceIndex,
  formatDriftIssueBody,
  githubControlReader,
  localControlReader,
  openDriftIssue,
  readOriginsManifest,
} from "./lib/control-drift.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function usage() {
  console.error(`Usage: check-control-drift.mjs [options]

Options:
  --manifest <path>       Origins manifest (default: origins-manifest.json)
  --control-root <path>   Read Control files locally instead of GitHub
  --control-ref <ref>     Control git ref when fetching (default: main)
  --open-issue            Open a GitHub issue when drift is found
  --dry-run-issue         Print the issue that would be opened; no gh call
  --repo <owner/name>     Issue repository (default: GITHUB_REPOSITORY or actana/client)
  --run-url <url>         Link appended to the issue body
  --json                  Print machine-readable summary on stdout
  -h, --help              Show this help
`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const options = {
    manifest: path.join(repoRoot, "origins-manifest.json"),
    controlRef: DEFAULT_CONTROL_REF,
    openIssue: false,
    dryRunIssue: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--open-issue") {
      options.openIssue = true;
      continue;
    }
    if (arg === "--dry-run-issue") {
      options.dryRunIssue = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      options[key] = value;
      i += 1;
    }
  }

  return options;
}

/** @param {{ title: string, body: string, repo: string }} input */
async function ghCreateIssue({ title, body, repo }) {
  const file = path.join(os.tmpdir(), `control-drift-issue-${process.pid}.md`);
  const fs = await import("node:fs/promises");
  await fs.writeFile(file, body, "utf8");

  const run = spawnSync(
    "gh",
    ["issue", "create", "--repo", repo, "--title", title, "--body-file", file, "--label", "needs-triage"],
    { encoding: "utf8" },
  );

  await fs.unlink(file).catch(() => undefined);

  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || "gh issue create failed");
  }

  const url = run.stdout.trim();
  const numberMatch = url.match(/\/issues\/(\d+)\s*$/);
  return { url, number: numberMatch ? Number(numberMatch[1]) : 0 };
}

/** @param {{ title: string, repo: string }} input */
async function ghListOpenIssue({ title, repo }) {
  const run = spawnSync(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `"${title}" in:title`,
      "--json",
      "number,title",
    ],
    { encoding: "utf8" },
  );

  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || "gh issue list failed");
  }

  const rows = JSON.parse(run.stdout || "[]");
  const match = rows.find((row) => row.title === title);
  return match?.number;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }

  const manifestPath = path.resolve(String(options.manifest));
  const manifest = readOriginsManifest(manifestPath);
  const index = controlSourceIndex(manifest.entries);

  const readControlFile =
    typeof options.controlRoot === "string"
      ? localControlReader(path.resolve(options.controlRoot))
      : githubControlReader({
          repo: CONTROL_REPO,
          ref: String(options.controlRef),
          token: process.env.GITHUB_TOKEN,
        });

  const { drifts, checked } = await checkControlDrift(index, readControlFile);

  const summary = {
    ok: drifts.length === 0,
    checked,
    driftCount: drifts.length,
    drifts,
    manifest: manifestPath,
    controlRef: String(options.controlRef),
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (drifts.length === 0) {
    console.log(`✓ ${checked} Control file(s) match origins-manifest.json`);
  } else {
    console.error(`✗ ${drifts.length} Control file(s) drifted:`);
    for (const row of drifts) {
      console.error(`  - ${row.sourcePath}`);
    }
  }

  if (drifts.length > 0 && (options.openIssue || options.dryRunIssue)) {
    const issueRepo =
      (typeof options.repo === "string" && options.repo) ||
      process.env.GITHUB_REPOSITORY ||
      "actana/client";
    const body = formatDriftIssueBody({
      drifts,
      controlRef: String(options.controlRef),
      runUrl: typeof options.runUrl === "string" ? options.runUrl : undefined,
    });

    const result = await openDriftIssue({
      title: DRIFT_ISSUE_TITLE,
      body,
      repo: issueRepo,
      dryRun: Boolean(options.dryRunIssue),
      createIssue: ghCreateIssue,
      listOpenIssues: ghListOpenIssue,
    });

    if (options.json) {
      console.log(JSON.stringify({ issue: result }, null, 2));
    } else if (result.action === "dry-run") {
      console.log("\n--- issue dry-run ---");
      console.log(`repo: ${result.repo}`);
      console.log(`title: ${result.title}`);
      console.log(result.body);
    } else if (result.action === "existing") {
      console.log(`::notice title=Drift already tracked::Issue #${result.number} is open.`);
    } else if (result.action === "created") {
      console.log(`Opened drift issue #${result.number}: ${result.url}`);
    }
  }

  if (drifts.length > 0) {
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::warning title=Control drift::${drifts.length} lifted file(s) changed on Control main`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
