import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJsonFilePairingStore } from "../stores/json-file.ts";
import { pairingStoreContract } from "./store-contract.ts";
import type { PairedClient } from "../store-port.ts";

const NOW_MS = 1_700_000_000_000;

function tmpStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-json-"));
  return path.join(dir, "pairing.json");
}

function client(overrides: Partial<PairedClient> = {}): PairedClient {
  return {
    certSerial: "0a1b",
    certSubject: "CN=laptop",
    label: "laptop",
    sessionId: "ps_1",
    pairedAt: NOW_MS,
    certNotAfter: NOW_MS + 365 * 24 * 60 * 60 * 1000,
    revokedAt: null,
    created_by: null,
    tenant_id: null,
    auth_method: null,
    ...overrides,
  };
}

/** Child worker: revoke one client serial from PAIRING_FILE. */
async function revokeInChild(filePath: string, certSerial: string, at: number): Promise<void> {
  const worker = fileURLToPath(new URL("./json-file-revoke-worker.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(worker, [], {
      execArgv: ["--experimental-strip-types"],
      env: {
        ...process.env,
        PAIRING_FILE: filePath,
        PAIRING_SERIAL: certSerial,
        PAIRING_AT: String(at),
      },
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`revoke worker exited ${code}: ${stderr}`));
    });
  });
}

describe("json-file pairing store", () => {
  pairingStoreContract(() => createJsonFilePairingStore(tmpStorePath()));

  it("two processes revoking different clients keep both stamps", async () => {
    const filePath = tmpStorePath();
    const store = createJsonFilePairingStore(filePath);
    await store.recordClient(client({ certSerial: "aa" }));
    await store.recordClient(client({ certSerial: "bb" }));

    await Promise.all([
      revokeInChild(filePath, "aa", NOW_MS + 1),
      revokeInChild(filePath, "bb", NOW_MS + 2),
    ]);

    const listed = await store.listClients();
    const bySerial = new Map(listed.map((row) => [row.certSerial, row]));
    expect(bySerial.get("aa")?.revokedAt).toBe(NOW_MS + 1);
    expect(bySerial.get("bb")?.revokedAt).toBe(NOW_MS + 2);
    expect(await store.revokedSerials()).toEqual(new Set(["aa", "bb"]));
  });
});
