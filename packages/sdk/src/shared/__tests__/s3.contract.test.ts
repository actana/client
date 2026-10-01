// The contract suite against the S3 mode: on an in-memory S3 always, and on a REAL SeaweedFS in the
// CI job `shared-key-seaweedfs` (see seaweedfs-harness.ts; fails there if SEAWEEDFS_* is unset).
import { afterAll } from "vitest";
import { createS3CoreShared } from "../s3.ts";
import { runCoreSharedContract } from "./contract.ts";
import { startFakeS3 } from "./fake-s3.ts";
import { seaweedfsEnv, seaweedfsHarness } from "./seaweedfs-harness.ts";

runCoreSharedContract("S3 mode on an in-memory S3", async () => {
  const s3 = await startFakeS3();
  const key = {
    accessKeyId: "AKIAFAKE",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiresAt: new Date(Date.now() + 3600_000),
  };
  return {
    shared: createS3CoreShared({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      prefix: "cores/core-a",
      credentials: { get: async () => key },
    }),
    dispose: () => s3.close(),
  };
});

const seaweed = seaweedfsHarness();
if (seaweed) {
  afterAll(() => seaweed.close());
  runCoreSharedContract("S3 mode on SeaweedFS", () => seaweed.newCore());
} else if (process.env.SEAWEEDFS_REQUIRED === "1") {
  throw new Error(`SEAWEEDFS_* is not set (${JSON.stringify(Object.keys(seaweedfsEnv))}): the contract suite must run against SeaweedFS in CI`);
}
