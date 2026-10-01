// The contract suite against the S3 mode: on an in-memory S3 always, and on a REAL SeaweedFS in the
// CI job `shared-key-seaweedfs` (see seaweedfs-harness.ts; fails there if SEAWEEDFS_* is unset).
import { afterAll, describe, expect, it } from "vitest";
import { createS3CoreShared } from "../s3.ts";
import { expectCode, runCoreSharedContract } from "./contract.ts";
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
      listPageSize: 5,
      credentials: { get: async () => key },
    }),
    dispose: () => s3.close(),
  };
});

const seaweed = seaweedfsHarness();
if (seaweed) {
  afterAll(() => seaweed.close());
  runCoreSharedContract("S3 mode on SeaweedFS", () => seaweed.newCore());

  describe("S3 mode on SeaweedFS: what only a real store and a real key can show", () => {
    it("a signed URL never outlives the key, and still downloads", async () => {
      const core = await seaweed.newCore();
      await core.shared.put("r.txt", "report");
      const key = await core.key();
      const signed = await core.shared.signedUrl("r.txt", { expiresInSeconds: 604800 });
      expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(key.expiresAt.getTime());
      expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(await (await fetch(signed.url)).text()).toBe("report");
    });

    it("a path that would reach another Core's folder is refused before the store, and that folder is untouched", async () => {
      const a = await seaweed.newCore();
      const b = await seaweed.newCore();
      await b.shared.put("secret.txt", "b-data");
      for (const path of [`../${b.coreId}/secret.txt`, `../${b.coreId}/planted.txt`, `/cores/${b.coreId}/secret.txt`]) {
        await expectCode(a.shared.get(path), "invalid-path");
        await expectCode(a.shared.put(path, "x"), "invalid-path");
        await expectCode(a.shared.rm(path), "invalid-path");
      }
      expect((await b.shared.list("")).map((e) => e.path)).toEqual(["secret.txt"]);
      expect(new TextDecoder().decode((await b.shared.get("secret.txt")).body)).toBe("b-data");
    });

    it("a key for another Core's prefix is refused by the store itself, as forbidden", async () => {
      const a = await seaweed.newCore();
      const b = await seaweed.newCore();
      await b.shared.put("secret.txt", "b-data");
      const crossed = createS3CoreShared({
        endpoint: seaweedfsEnv.endpoint!,
        bucket: seaweedfsEnv.bucket,
        prefix: `${seaweedfsEnv.prefix}/${b.coreId}`,
        credentials: { get: () => a.key() },
      });
      await expectCode(crossed.get("secret.txt"), "forbidden");
      await expectCode(crossed.put("planted.txt", "x"), "forbidden");
      await expectCode(crossed.list(""), "forbidden");
      expect((await b.shared.list("")).map((e) => e.path)).toEqual(["secret.txt"]);
    });
  });
} else if (process.env.SEAWEEDFS_REQUIRED === "1") {
  throw new Error(`SEAWEEDFS_* is not set (${JSON.stringify(Object.keys(seaweedfsEnv))}): the contract suite must run against SeaweedFS in CI`);
}
