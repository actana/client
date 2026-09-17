import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DRIFT_ISSUE_TITLE,
  checkControlDrift,
  controlSourceIndex,
  formatDriftIssueBody,
  localControlReader,
  openDriftIssue,
  readOriginsManifest,
  sha256,
} from "../lib/control-drift.mjs";

const fixtureRoot = path.resolve(import.meta.dirname, "..", "__fixtures__", "control-drift");
const manifestPath = path.join(fixtureRoot, "manifest.json");
const controlRoot = path.join(fixtureRoot, "control");

describe("control drift check", () => {
  it("reports no drift when manifest hashes match Control files", async () => {
    const manifest = readOriginsManifest(manifestPath);
    const index = controlSourceIndex(manifest.entries);
    const pairingCodeHash = sha256("export const PAIRING_CODE = \"fixture\";\n");
    const pairingStoreHash = sha256("export const PAIRING_STORE = \"fixture\";\n");

    index.get("packages/shared/src/pairing-code.ts").sha256 = pairingCodeHash;
    index.get("packages/shared/src/pairing-store.ts").sha256 = pairingStoreHash;

    const result = await checkControlDrift(index, localControlReader(controlRoot));
    expect(result.checked).toBe(2);
    expect(result.drifts).toEqual([]);
  });

  it("reports drift when a manifest hash is wrong", async () => {
    const manifest = readOriginsManifest(manifestPath);
    const index = controlSourceIndex(manifest.entries);
    const pairingStoreHash = sha256("export const PAIRING_STORE = \"fixture\";\n");

    index.get("packages/shared/src/pairing-store.ts").sha256 = pairingStoreHash;

    const result = await checkControlDrift(index, localControlReader(controlRoot));
    expect(result.drifts).toEqual([
      {
        sourcePath: "packages/shared/src/pairing-code.ts",
        expectedSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        actualSha256: sha256("export const PAIRING_CODE = \"fixture\";\n"),
        destPaths: ["packages/sdk/src/pairing/code.ts"],
      },
    ]);
  });

  it("names every drifted Control path in the issue body", () => {
    const body = formatDriftIssueBody({
      drifts: [
        {
          sourcePath: "packages/shared/src/pairing-code.ts",
          expectedSha256: "deadbeef",
          actualSha256: "cafebabe",
          destPaths: ["packages/sdk/src/pairing/code.ts"],
        },
      ],
      runUrl: "https://example.com/run/1",
    });

    expect(body).toContain("packages/shared/src/pairing-code.ts");
    expect(body).toContain("packages/sdk/src/pairing/code.ts");
    expect(body).toContain("https://example.com/run/1");
  });

  it("dry-runs issue opening without calling GitHub", async () => {
    const result = await openDriftIssue({
      title: DRIFT_ISSUE_TITLE,
      body: "drift",
      repo: "actana/client",
      dryRun: true,
      createIssue: async () => {
        throw new Error("should not create an issue in dry-run");
      },
      listOpenIssues: async () => {
        throw new Error("should not list issues in dry-run");
      },
    });

    expect(result.action).toBe("dry-run");
    expect(result.repo).toBe("actana/client");
  });

  it("ignores Search entries — Control only", () => {
    const manifest = readOriginsManifest(manifestPath);
    const index = controlSourceIndex(manifest.entries);
    expect([...index.keys()]).toEqual([
      "packages/shared/src/pairing-code.ts",
      "packages/shared/src/pairing-store.ts",
    ]);
  });
});
