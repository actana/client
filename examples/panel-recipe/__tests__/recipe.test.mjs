// The whole script, `main()`, against the fake Core: the four steps in order, what each prints, and
// how a failure surfaces (stderr and the exit code, not only stdout).
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeRegistrationBlob } from "@actana/sdk/pairing";
import { main } from "../recipe.mjs";
import { startFakeCore } from "./fake-core.mjs";
import { createMemoryShared } from "./memory-shared.mjs";
import { reportPathFromPrompt } from "./harness.mjs";
import { REPORT_END_MARKER } from "../src/report-contract.mjs";

const recipe = fileURLToPath(new URL("../recipe.mjs", import.meta.url));
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panel-recipe-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SECRETS = ["fake-bearer-NEVER-PRINT", "SECRET-ACCESS-NEVER-PRINT", "SESSION-TOKEN-NEVER-PRINT", "CLIENT-KEY-NEVER-PRINT"];

const blob = {
  endpoint: "wss://fake-core.invalid:8765",
  caCert: "CA",
  clientCert: "CERT",
  clientKey: "CLIENT-KEY-NEVER-PRINT",
  bearer: "fake-bearer-NEVER-PRINT",
};

const issuer = {
  async issue(coreId) {
    return {
      accessKeyId: `AKIA-${coreId}`,
      secretAccessKey: "SECRET-ACCESS-NEVER-PRINT",
      sessionToken: "SESSION-TOKEN-NEVER-PRINT",
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  },
};

function sink() {
  const chunks = { out: "", err: "" };
  return { chunks, io: { stdout: { write: (s) => (chunks.out += s) }, stderr: { write: (s) => (chunks.err += s) } } };
}

function env(extra = {}) {
  return {
    SEAWEEDFS_ENDPOINT: "http://s3.invalid:8333",
    SEAWEEDFS_OIDC_ISSUER: "http://controller.invalid",
    SEAWEEDFS_OIDC_AUDIENCE: "actana-shared",
    SEAWEEDFS_SIGNING_KEY_FILE: join(dir, "unused.pem"),
    SEAWEEDFS_KEY_ID: "k1",
    SEAWEEDFS_BUCKET: "actana-shared",
    SEAWEEDFS_PREFIX: "cores",
    ACTANA_POLL_MS: "5",
    ACTANA_TIMEOUT_MS: "3000",
    ...extra,
  };
}

/** A Core whose harness writes the Session report, or the Task result, wherever the prompt says. */
function coreWritingTo(shared) {
  return startFakeCore({
    coreId: "core-a",
    harness: async ({ prompt, sessionId }) => {
      await new Promise((r) => setTimeout(r, 10));
      // A Task's prompt carries the Core's block too (the Core appends it to every starting prompt),
      // so the Task is told apart by its own result instructions.
      const report = reportPathFromPrompt(prompt);
      if (!prompt.includes("~/shared/tasks/T-9/") && report !== null) {
        await shared.put(report, `# Session ${sessionId}\n\nHello.\n\n${REPORT_END_MARKER}\n`);
      } else {
        await shared.put("tasks/T-9/partial-1.md", `# Half done\n\nTwo of three.\n\n${REPORT_END_MARKER}\n`);
      }
    },
  });
}

describe("main(): the four steps", () => {
  it("pairs, attaches, runs a Session and dispatches a Task, one JSON result per step on stdout", async () => {
    const shared = createMemoryShared();
    const core = coreWritingTo(shared);
    const { chunks, io } = sink();
    const blobFile = join(dir, "blob.txt");

    const code = await main(
      ["all", "say hello", "--task-id", "T-9", "--task-title", "Count the files", "--task-description", "All of them."],
      env({ ACTANA_CORE_ADDRESS: "core.invalid:8765", ACTANA_PAIRING_CODE: "ps_1:ABCD-EFGH", ACTANA_CA_FINGERPRINT: "aa:bb", ACTANA_BLOB_OUT: blobFile }),
      io,
      {
        pair: async (opts) => {
          // The fingerprint reached the pairing call, so the code is checked against it first.
          expect(opts).toMatchObject({ address: "core.invalid:8765", code: "ps_1:ABCD-EFGH", expectedCaFingerprint: "aa:bb" });
          return blob;
        },
        createSocket: core.createSocket,
        issuer,
        shared,
      },
    );

    expect(code).toBe(0);
    const results = chunks.out.trim().split("\n").map((l) => JSON.parse(l));
    expect(results.map((r) => r.step)).toEqual(["pair", "attach", "session", "task"]);
    expect(results[0]).toMatchObject({ endpoint: blob.endpoint, blobFile });
    expect(results[1]).toMatchObject({ coreId: "core-a", prefix: "cores/core-a/", state: "attached" });
    expect(results[2]).toMatchObject({ sessionId: "sess-1", reportPath: "sessions/sess-1/report-1.md", report: "# Session sess-1\n\nHello." });
    expect(results[3]).toMatchObject({ taskId: "T-9", sessionId: "sess-2", status: "partial", resultFile: "partial-1.md", comment: "# Half done\n\nTwo of three." });
    // The blob went to a file only its owner can read.
    expect(statSync(blobFile).mode & 0o777).toBe(0o600);
  });

  it("never prints a bearer, a key, a token or the blob, on stdout or stderr", async () => {
    const shared = createMemoryShared();
    const core = coreWritingTo(shared);
    const { chunks, io } = sink();
    const blobFile = join(dir, "blob.txt");
    writeFileSync(blobFile, encodeRegistrationBlob(blob));
    const code = await main(["session", "hi"], env({ ACTANA_CORE_BLOB: blobFile }), io, { createSocket: core.createSocket, issuer, shared });
    expect(code).toBe(0);
    for (const secret of SECRETS) {
      expect(chunks.out).not.toContain(secret);
      expect(chunks.err).not.toContain(secret);
    }
    expect(chunks.err).not.toContain(encodeRegistrationBlob(blob));
  });

  it("session and task run on a Core attached earlier, without sending sharedAttach again", async () => {
    const shared = createMemoryShared();
    const core = coreWritingTo(shared);
    const { io } = sink();
    const blobFile = join(dir, "blob.txt");
    writeFileSync(blobFile, encodeRegistrationBlob(blob));
    expect(await main(["session", "hi"], env({ ACTANA_CORE_BLOB: blobFile }), io, { createSocket: core.createSocket, issuer, shared })).toBe(0);
    expect(core.framesOfType("sharedAttach")).toEqual([]);
  });
});

describe("main(): failures end on stderr with an exit code", () => {
  it("a missing setting names the variable, never a value, and exits 2", async () => {
    const { chunks, io } = sink();
    const code = await main(["attach"], {}, io);
    expect(code).toBe(2);
    expect(chunks.err).toContain("UsageError: set ACTANA_CORE_BLOB");
    expect(chunks.out).toBe("");
  });

  it("an unknown command exits 2 with the usage on stderr", async () => {
    const { chunks, io } = sink();
    expect(await main(["dance"], {}, io)).toBe(2);
    expect(chunks.err).toContain("expected one of pair, attach, session, task, all");
  });

  it("a blob that is not a blob exits 2 and does not echo it", async () => {
    const { chunks, io } = sink();
    const code = await main(["attach"], env({ ACTANA_CORE_BLOB: "NOT-A-BLOB-SECRET-LOOKING" }), io);
    expect(code).toBe(2);
    expect(chunks.err).toContain("is not a Core registration blob");
    expect(chunks.err).not.toContain("NOT-A-BLOB-SECRET-LOOKING");
  });

  it("a Core that refuses the attach exits 4 and the message carries the code, not the key", async () => {
    const core = startFakeCore({ attach: () => ({ state: "error", code: "mount-failed", message: "no route to the bucket" }) });
    const { chunks, io } = sink();
    const blobFile = join(dir, "blob.txt");
    writeFileSync(blobFile, encodeRegistrationBlob(blob));
    const code = await main(["attach"], env({ ACTANA_CORE_BLOB: blobFile }), io, { createSocket: core.createSocket, issuer });
    expect(code).toBe(4);
    expect(chunks.err).toContain("mount-failed: no route to the bucket");
    for (const secret of SECRETS) expect(chunks.err).not.toContain(secret);
  });

  it("a report that never comes exits 3", async () => {
    const core = startFakeCore();
    const { chunks, io } = sink();
    const blobFile = join(dir, "blob.txt");
    writeFileSync(blobFile, encodeRegistrationBlob(blob));
    const code = await main(["session", "hi"], env({ ACTANA_CORE_BLOB: blobFile, ACTANA_TIMEOUT_MS: "60" }), io, {
      createSocket: core.createSocket,
      issuer,
      shared: createMemoryShared(),
    });
    expect(code).toBe(3);
    expect(chunks.err).toMatch(/TimeoutError: sessions\/sess-1\/report-1\.md was not finished/);
  });

  it("a harness that exits without a report exits 5", async () => {
    const core = startFakeCore({ harness: async ({ exit }) => exit(1) });
    const { chunks, io } = sink();
    const blobFile = join(dir, "blob.txt");
    writeFileSync(blobFile, encodeRegistrationBlob(blob));
    const code = await main(["session", "hi"], env({ ACTANA_CORE_BLOB: blobFile, ACTANA_EXIT_GRACE_MS: "40" }), io, {
      createSocket: core.createSocket,
      issuer,
      shared: createMemoryShared(),
    });
    expect(code).toBe(5);
    expect(chunks.err).toContain("NoReportError");
  });

  it("a pairing without the expected fingerprint is refused by the SDK before any code is sent (exit 4)", async () => {
    // The real pairWithCore: it needs the fingerprint first. Nothing is listening on the port; the
    // refusal on a bad fingerprint argument comes before any network use.
    const { chunks, io } = sink();
    const code = await main(["pair"], { ACTANA_CORE_ADDRESS: "127.0.0.1:9", ACTANA_PAIRING_CODE: "ps_1:ABCD-EFGH", ACTANA_CA_FINGERPRINT: "not-a-fingerprint", ACTANA_BLOB_OUT: join(dir, "b") }, io);
    expect(code).toBe(4);
    expect(chunks.err).toContain("PairingError");
    expect(() => readFileSync(join(dir, "b"))).toThrow();
  });
});

describe("the script as a process", () => {
  it("--help prints the usage on stdout and exits 0", () => {
    const run = spawnSync(process.execPath, [recipe, "--help"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("usage: node examples/panel-recipe/recipe.mjs");
    expect(run.stderr).toBe("");
  });

  it("missing settings exit 2 with the reason on stderr and nothing on stdout", () => {
    const run = spawnSync(process.execPath, [recipe, "session", "hi"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("recipe: UsageError: set ACTANA_CORE_BLOB");
    expect(run.stdout).toBe("");
  });
});
