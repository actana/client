// The S3-backed parts of the recipe against a REAL SeaweedFS: the real SeaweedFS key issuer
// (AssumeRoleWithWebIdentity), the direct-S3 mode of CoreShared, and the recipe's steps 2, 3 and 4 on
// top of them. Run by CI job `shared-key-seaweedfs` (.github/workflows/ci.yml), which starts the
// pinned SeaweedFS and sets SEAWEEDFS_*. Without SEAWEEDFS_ENDPOINT it is skipped locally and FAILS
// in that job (SEAWEEDFS_REQUIRED=1): a skipped proof is not a pass.
//
// What is real here: SeaweedFS, the issuer, the keys, the S3 mode, the JWKS the recipe serves.
// What is NOT: the Core. The Core end of the core-link is `fake-core.mjs`, and its "harness" writes
// the report into the Shared folder with the very key the recipe sent it in `sharedAttach` (so the
// key it was handed is what is proven to work, and to be limited to its own folder).
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoreClient } from "@actana/sdk/core";
import { encodeRegistrationBlob } from "@actana/sdk/pairing";
import { CoreSharedError, createS3CoreShared } from "@actana/sdk/shared";
import { main } from "../recipe.mjs";
import { attachShared, createIssuer, serveJwks } from "../src/attach.mjs";
import { startSessionAndWatch } from "../src/session.mjs";
import { dispatchTask } from "../src/task.mjs";
import { REPORT_END_MARKER } from "../src/report-contract.mjs";
import { startFakeCore } from "./fake-core.mjs";
import { reportPathFromPrompt } from "./harness.mjs";

const env = {
  endpoint: process.env.SEAWEEDFS_ENDPOINT,
  adminKey: process.env.SEAWEEDFS_ADMIN_ACCESS_KEY,
  adminSecret: process.env.SEAWEEDFS_ADMIN_SECRET_KEY,
  issuer: process.env.SEAWEEDFS_OIDC_ISSUER,
  audience: process.env.SEAWEEDFS_OIDC_AUDIENCE ?? "actana-shared",
  jwksPort: Number(process.env.SEAWEEDFS_JWKS_PORT),
  bucket: process.env.SEAWEEDFS_BUCKET ?? "actana-shared",
  prefix: process.env.SEAWEEDFS_PREFIX ?? "cores",
  signingKeyFile: process.env.SEAWEEDFS_SIGNING_KEY_FILE,
  keyId: process.env.SEAWEEDFS_KEY_ID ?? "ci-key",
};
const configured = Boolean(env.endpoint && env.adminKey && env.adminSecret && env.issuer && env.jwksPort && env.signingKeyFile);

if (!configured && process.env.SEAWEEDFS_REQUIRED === "1") {
  throw new Error("SEAWEEDFS_* is not set: the recipe's S3 steps must run against SeaweedFS in CI");
}

/** PUT /<bucket> with the static admin identity (which Cores never receive): SigV4 on node:crypto. */
async function makeBucket() {
  const url = new URL(`/${env.bucket}`, env.endpoint);
  const date = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = date.slice(0, 8);
  const payloadHash = createHash("sha256").update("").digest("hex");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["PUT", url.pathname, "", `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${env.adminSecret}`, day), "us-east-1"), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "x-amz-date": date,
      "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${env.adminKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  if (![200, 409].includes(response.status)) throw new Error(`could not make the bucket: ${response.status} ${await response.text()}`);
}

const seaweedfs = () => ({
  endpoint: env.endpoint,
  oidcIssuer: env.issuer,
  oidcAudience: env.audience,
  signingKeyFile: env.signingKeyFile,
  keyId: env.keyId,
});
const newCoreId = () => `core-rc-${randomBytes(5).toString("hex")}`;
const fast = { pollMs: 250, timeoutMs: 60_000, exitGraceMs: 20_000 };

/** The Core's own view of the folder, signed with the key the recipe handed it (not the controller's). */
function coreSideShared(core) {
  const c = core.state.credentials;
  return createS3CoreShared({
    endpoint: env.endpoint,
    bucket: c.bucket,
    prefix: c.prefix.replace(/\/$/, ""),
    credentials: {
      get: async () => ({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, expiresAt: new Date(Date.now() + 3_600_000) }),
    },
  });
}

async function connect(core) {
  const client = new CoreClient({ url: "wss://fake-core.invalid", bearer: core.bearer, createSocket: core.createSocket });
  return { client, info: await client.connect() };
}

describe.skipIf(!configured)("the recipe's S3 steps on a real SeaweedFS", () => {
  let jwks;
  let issuer;
  const dirs = [];

  beforeAll(async () => {
    await makeBucket();
    jwks = await serveJwks({ signingKeyFile: env.signingKeyFile, keyId: env.keyId, port: env.jwksPort });
    issuer = createIssuer(seaweedfs());
  });
  afterAll(async () => {
    await jwks?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("step 2: attaches with a real 1-hour key, and the controller reads the Core's folder in S3", async () => {
    const coreId = newCoreId();
    const core = startFakeCore({ coreId });
    const { client, info } = await connect(core);
    try {
      const attached = await attachShared({ client, info, issuer, bucket: env.bucket, prefix: env.prefix, endpoint: env.endpoint });
      const [frame] = core.framesOfType("sharedAttach");
      expect(frame.prefix).toBe(`${env.prefix}/${coreId}/`);
      const life = (Date.parse(frame.expiresAt) - Date.now()) / 1000;
      expect(life).toBeGreaterThan(3600 - 120);
      expect(life).toBeLessThanOrEqual(3605);

      // The Core writes with the key it was handed; the controller sees it with its own.
      await coreSideShared(core).put("notes/hello.md", "from the Core");
      const seen = await attached.shared.get("notes/hello.md");
      expect(new TextDecoder().decode(seen.body)).toBe("from the Core");
    } finally {
      client.close();
    }
  });

  it("the key the Core was handed cannot reach another Core's folder", async () => {
    const core = startFakeCore({ coreId: newCoreId() });
    const { client, info } = await connect(core);
    try {
      await attachShared({ client, info, issuer, bucket: env.bucket, prefix: env.prefix, endpoint: env.endpoint });
      const c = core.state.credentials;
      const intruder = createS3CoreShared({
        endpoint: env.endpoint,
        bucket: c.bucket,
        prefix: `${env.prefix}/${newCoreId()}`,
        credentials: { get: async () => ({ ...c, expiresAt: new Date(Date.now() + 3_600_000) }) },
      });
      const err = await intruder.put("stolen.md", "x").catch((e) => e);
      expect(err).toBeInstanceOf(CoreSharedError);
      expect(err.code).toBe("forbidden");
    } finally {
      client.close();
    }
  });

  it("step 3: a Session's report is seen through S3 as the harness writes it", async () => {
    const core = startFakeCore({
      coreId: newCoreId(),
      harness: async ({ prompt }) => {
        await new Promise((r) => setTimeout(r, 300));
        await coreSideShared(core).put(reportPathFromPrompt(prompt), `# Done\n\nread over S3.\n\n${REPORT_END_MARKER}\n`);
      },
    });
    const { client, info } = await connect(core);
    try {
      const { shared } = await attachShared({ client, info, issuer, bucket: env.bucket, prefix: env.prefix, endpoint: env.endpoint });
      const result = await startSessionAndWatch({ client, shared, harness: "claude-code", prompt: "say hi", ...fast });
      expect(result.reportPath).toBe("sessions/sess-1/report-1.md");
      expect(result.report).toBe("# Done\n\nread over S3.");
    } finally {
      client.close();
    }
  });

  it("step 4: a Task's result file becomes a status, and a re-run archives the old result (a real S3 move)", async () => {
    const task = { id: "T-1", title: "Count", description: "the files" };
    const core = startFakeCore({
      coreId: newCoreId(),
      harness: async ({ prompt }) => {
        await new Promise((r) => setTimeout(r, 300));
        const file = prompt.includes("attempt 1)") ? "fail.md" : "success.md";
        await coreSideShared(core).put(`tasks/T-1/${file}`, `# ${file}\n\nbody\n\n${REPORT_END_MARKER}\n`);
      },
    });
    const { client, info } = await connect(core);
    try {
      const { shared } = await attachShared({ client, info, issuer, bucket: env.bucket, prefix: env.prefix, endpoint: env.endpoint });
      const first = await dispatchTask({ client, shared, task, attempt: 1, harness: "claude-code", ...fast });
      expect(first).toMatchObject({ status: "failed", resultFile: "fail.md", comment: "# fail.md\n\nbody" });

      const second = await dispatchTask({ client, shared, task, attempt: 2, harness: "claude-code", ...fast });
      expect(second).toMatchObject({ status: "done", resultFile: "success.md", sourceFile: "attempt-2-success.md" });
      const names = (await shared.list("tasks/T-1/")).map((e) => e.path.split("/").pop()).sort();
      expect(names).toEqual(["attempt-1-fail.md", "success.md"]);
    } finally {
      client.close();
    }
  }, 120_000);

  it("the script end to end (main all): pair is faked, attach/session/task use the real issuer, S3 and the JWKS it serves itself", async () => {
    await jwks.close();
    jwks = null;
    const dir = mkdtempSync(join(tmpdir(), "panel-recipe-seaweedfs-"));
    dirs.push(dir);
    const core = startFakeCore({
      coreId: newCoreId(),
      harness: async ({ prompt }) => {
        await new Promise((r) => setTimeout(r, 300));
        const session = reportPathFromPrompt(prompt);
        const path = prompt.includes("~/shared/tasks/T-7/") ? `tasks/T-7/success.md` : session;
        await coreSideShared(core).put(path, `# ok\n\n${path}\n\n${REPORT_END_MARKER}\n`);
      },
    });
    const blob = { endpoint: "wss://fake-core.invalid", caCert: "CA", clientCert: "CERT", clientKey: "KEY", bearer: core.bearer };
    const blobFile = join(dir, "blob.txt");
    writeFileSync(blobFile, encodeRegistrationBlob(blob));
    const chunks = { out: "", err: "" };
    const code = await main(
      ["all", "say hi", "--task-id", "T-7", "--task-title", "Seven"],
      {
        ACTANA_CORE_BLOB: blobFile,
        SEAWEEDFS_ENDPOINT: env.endpoint,
        SEAWEEDFS_OIDC_ISSUER: env.issuer,
        SEAWEEDFS_OIDC_AUDIENCE: env.audience,
        SEAWEEDFS_SIGNING_KEY_FILE: env.signingKeyFile,
        SEAWEEDFS_KEY_ID: env.keyId,
        SEAWEEDFS_BUCKET: env.bucket,
        SEAWEEDFS_PREFIX: env.prefix,
        SEAWEEDFS_JWKS_PORT: String(env.jwksPort),
        ACTANA_POLL_MS: "250",
        ACTANA_TIMEOUT_MS: "60000",
      },
      { stdout: { write: (s) => (chunks.out += s) }, stderr: { write: (s) => (chunks.err += s) } },
      { createSocket: core.createSocket },
    );
    expect(chunks.err).not.toMatch(/Error/);
    expect(code).toBe(0);
    const steps = chunks.out.trim().split("\n").map((l) => JSON.parse(l));
    expect(steps.map((s) => s.step)).toEqual(["attach", "session", "task"]);
    expect(steps[2]).toMatchObject({ status: "done", taskId: "T-7" });
  }, 180_000);
});
