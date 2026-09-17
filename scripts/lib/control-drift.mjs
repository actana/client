import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

export const CONTROL_REPO = "actana/control";
export const DEFAULT_CONTROL_REF = "main";
export const DRIFT_ISSUE_TITLE =
  "Control pairing drift: port lifted files from actana/control main";

/** @typedef {{ sourceRepo: string, sourcePath: string, sha256: string, destPath?: string }} ManifestEntry */
/** @typedef {{ sourcePath: string, expectedSha256: string, actualSha256: string, destPaths: string[] }} DriftRow */

/**
 * @param {string | Buffer} content
 * @returns {string}
 */
export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * @param {unknown} value
 * @returns {value is { entries: ManifestEntry[] }}
 */
export function isOriginsManifest(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(/** @type {{ entries?: unknown }} */ (value).entries)
  );
}

/**
 * One row per Control source path — the manifest may map one source to several
 * destinations (for example the two halves of pairing-store.ts).
 *
 * @param {ManifestEntry[]} entries
 * @returns {Map<string, { sha256: string, destPaths: string[] }>}
 */
export function controlSourceIndex(entries) {
  /** @type {Map<string, { sha256: string, destPaths: string[] }>} */
  const index = new Map();

  for (const entry of entries) {
    if (entry.sourceRepo !== CONTROL_REPO) continue;

    const existing = index.get(entry.sourcePath);
    if (existing) {
      if (existing.sha256 !== entry.sha256) {
        throw new Error(
          `origins manifest disagrees on ${entry.sourcePath}: ${existing.sha256} vs ${entry.sha256}`,
        );
      }
      if (entry.destPath && !existing.destPaths.includes(entry.destPath)) {
        existing.destPaths.push(entry.destPath);
      }
      continue;
    }

    index.set(entry.sourcePath, {
      sha256: entry.sha256,
      destPaths: entry.destPath ? [entry.destPath] : [],
    });
  }

  return index;
}

/**
 * @param {string} manifestPath
 */
export function readOriginsManifest(manifestPath) {
  const raw = readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!isOriginsManifest(parsed)) {
    throw new Error(`${manifestPath} is not an origins manifest`);
  }
  return parsed;
}

/**
 * @param {Map<string, { sha256: string, destPaths: string[] }>} index
 * @param {(sourcePath: string) => Promise<Buffer | string | null>} readControlFile
 * @returns {Promise<{ drifts: DriftRow[], checked: number }>}
 */
export async function checkControlDrift(index, readControlFile) {
  /** @type {DriftRow[]} */
  const drifts = [];
  let checked = 0;

  for (const [sourcePath, expected] of [...index.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    checked += 1;
    const content = await readControlFile(sourcePath);
    if (content === null) {
      drifts.push({
        sourcePath,
        expectedSha256: expected.sha256,
        actualSha256: "(missing on Control main)",
        destPaths: expected.destPaths,
      });
      continue;
    }

    const actualSha256 = sha256(content);
    if (actualSha256 !== expected.sha256) {
      drifts.push({
        sourcePath,
        expectedSha256: expected.sha256,
        actualSha256,
        destPaths: expected.destPaths,
      });
    }
  }

  return { drifts, checked };
}

/**
 * @param {{ drifts: DriftRow[], controlRef?: string, runUrl?: string }} input
 */
export function formatDriftIssueBody({ drifts, controlRef = DEFAULT_CONTROL_REF, runUrl }) {
  const lines = [
    `Control \`${controlRef}\` no longer matches \`origins-manifest.json\`.`,
    "",
    "Port the drifted files into this repository within the week (see CONTRIBUTING.md).",
    "",
    "| Control path | Expected sha256 | Actual sha256 | Client destination(s) |",
    "| --- | --- | --- | --- |",
  ];

  for (const row of drifts) {
    const dest =
      row.destPaths.length > 0
        ? row.destPaths.map((p) => `\`${p}\``).join(", ")
        : "—";
    lines.push(
      `| \`${row.sourcePath}\` | \`${row.expectedSha256}\` | \`${row.actualSha256}\` | ${dest} |`,
    );
  }

  if (runUrl) {
    lines.push("", `[Workflow run](${runUrl})`);
  }

  return lines.join("\n");
}

/**
 * @param {{ title?: string, body: string, repo?: string, dryRun?: boolean, createIssue?: (input: { title: string, body: string, repo: string }) => Promise<{ number: number, url: string }>, listOpenIssues?: (input: { title: string, repo: string }) => Promise<number | undefined> }} input
 */
export async function openDriftIssue({
  title = DRIFT_ISSUE_TITLE,
  body,
  repo,
  dryRun = false,
  createIssue,
  listOpenIssues,
}) {
  if (!repo) {
    throw new Error("repo is required to open a drift issue");
  }

  if (dryRun) {
    return { action: "dry-run", title, body, repo };
  }

  if (!createIssue || !listOpenIssues) {
    throw new Error("createIssue and listOpenIssues are required unless dryRun is set");
  }

  const existing = await listOpenIssues({ title, repo });
  if (existing) {
    return { action: "existing", number: existing, title, repo };
  }

  const created = await createIssue({ title, body, repo });
  return { action: "created", ...created, title, repo };
}

/**
 * @param {string} controlRoot
 * @returns {(sourcePath: string) => Promise<Buffer | null>}
 */
export function localControlReader(controlRoot) {
  return async (sourcePath) => {
    const filePath = path.join(controlRoot, sourcePath);
    try {
      return readFileSync(filePath);
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        /** @type {{ code: string }} */ (err).code === "ENOENT"
      ) {
        return null;
      }
      throw err;
    }
  };
}

/**
 * @param {{ repo?: string, ref?: string, token?: string }} [options]
 * @returns {(sourcePath: string) => Promise<Buffer | null>}
 */
export function githubControlReader({ repo = CONTROL_REPO, ref = DEFAULT_CONTROL_REF, token } = {}) {
  return async (sourcePath) => {
    const url = new URL(
      `https://raw.githubusercontent.com/${repo}/${ref}/${sourcePath}`,
    );
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(url, { headers, redirect: "follow" });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `failed to fetch ${repo}@${ref}:${sourcePath} (${response.status} ${response.statusText})`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  };
}
