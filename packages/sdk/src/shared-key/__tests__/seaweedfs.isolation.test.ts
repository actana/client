// Isolation proof against a REAL SeaweedFS (CI job `shared-key-seaweedfs`, see .github/workflows/ci.yml).
// It needs a running SeaweedFS configured from seaweedfs/iam.json.tmpl; without SEAWEEDFS_ENDPOINT it
// is skipped locally and fails in the CI job that sets SEAWEEDFS_REQUIRED=1 (a skipped proof is not a pass).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSeaweedfsKeyIssuer, publicJwks, SHARED_KEY_LIFETIME_SECONDS, type SharedKey } from "../index.ts";
import { loadSigningKey, SEAWEEDFS_KEY_ID } from "../../shared/__tests__/seaweedfs-harness.ts";
import { s3Request, type S3Credentials } from "./sigv4.ts";

const env = {
  endpoint: process.env.SEAWEEDFS_ENDPOINT,
  adminKey: process.env.SEAWEEDFS_ADMIN_ACCESS_KEY,
  adminSecret: process.env.SEAWEEDFS_ADMIN_SECRET_KEY,
  issuer: process.env.SEAWEEDFS_OIDC_ISSUER,
  jwksPort: Number(process.env.SEAWEEDFS_JWKS_PORT),
  audience: process.env.SEAWEEDFS_OIDC_AUDIENCE ?? "actana-shared",
  bucket: process.env.SEAWEEDFS_BUCKET ?? "actana-shared",
  prefix: process.env.SEAWEEDFS_PREFIX ?? "cores",
};
const configured = Boolean(env.endpoint && env.adminKey && env.adminSecret && env.issuer && env.jwksPort);

if (!configured && process.env.SEAWEEDFS_REQUIRED === "1") {
  throw new Error("SEAWEEDFS_* is not set: the isolation test must run against SeaweedFS in CI");
}

const asCreds = (key: SharedKey): S3Credentials => ({
  accessKeyId: key.accessKeyId,
  secretAccessKey: key.secretAccessKey,
  sessionToken: key.sessionToken,
});

describe.skipIf(!configured)("SeaweedFS issuer: a Core's key is limited to its own prefix", () => {
  let jwksServer: Server;
  let keyA: SharedKey;
  let keyB: SharedKey;
  let a: S3Credentials;
  let b: S3Credentials;
  const endpoint = env.endpoint!;
  const bucket = env.bucket;
  const A = "core-iso-a";
  const B = "core-iso-b";
  const objA = `${bucket}/${env.prefix}/${A}/notes/todo.md`;
  const objB = `${bucket}/${env.prefix}/${B}/notes/todo.md`;

  beforeAll(async () => {
    const privateKey = loadSigningKey();
    const jwks = JSON.stringify(publicJwks(privateKey, SEAWEEDFS_KEY_ID));
    jwksServer = createServer((req, res) => {
      res.writeHead(req.url === "/jwks.json" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/jwks.json" ? jwks : "{}");
    });
    await new Promise<void>((resolve) => jwksServer.listen(env.jwksPort, "127.0.0.1", resolve));
    expect((jwksServer.address() as AddressInfo).port).toBe(env.jwksPort);

    // The bucket is made with the static admin identity, which Cores never receive.
    const admin: S3Credentials = { accessKeyId: env.adminKey!, secretAccessKey: env.adminSecret! };
    const made = await s3Request(endpoint, admin, "PUT", bucket);
    expect([200, 409], made.body).toContain(made.status);

    const issuer = createSeaweedfsKeyIssuer({
      endpoint,
      issuer: env.issuer!,
      audience: env.audience,
      signingKey: privateKey,
      keyId: SEAWEEDFS_KEY_ID,
    });
    const before = Date.now();
    [keyA, keyB] = await Promise.all([issuer.issue(A), issuer.issue(B)]);
    a = asCreds(keyA);
    b = asCreds(keyB);

    // Expiry: one hour, as asked of STS and as granted.
    const life = (keyA.expiresAt.getTime() - before) / 1000;
    expect(life).toBeGreaterThan(SHARED_KEY_LIFETIME_SECONDS - 120);
    expect(life).toBeLessThanOrEqual(SHARED_KEY_LIFETIME_SECONDS + 5);
  });

  afterAll(async () => {
    await new Promise((resolve) => jwksServer?.close(resolve));
  });

  it("A can put, get and list under A's prefix", async () => {
    const put = await s3Request(endpoint, a, "PUT", objA, { body: "a-data" });
    expect(put.status, put.body).toBe(200);
    const get = await s3Request(endpoint, a, "GET", objA);
    expect(get.status, get.body).toBe(200);
    expect(get.body).toBe("a-data");
    const list = await s3Request(endpoint, a, "GET", bucket, {
      query: { "list-type": "2", prefix: `${env.prefix}/${A}/` },
    });
    expect(list.status, list.body).toBe(200);
    expect(list.body).toContain(`${env.prefix}/${A}/notes/todo.md`);
  });

  it("A gets AccessDenied reading and writing B's prefix, even where B's object exists", async () => {
    const seeded = await s3Request(endpoint, b, "PUT", objB, { body: "b-secret" });
    expect(seeded.status, seeded.body).toBe(200);

    const read = await s3Request(endpoint, a, "GET", objB);
    expect(read.status).toBe(403);
    expect(read.body).toContain("AccessDenied");
    expect(read.body).not.toContain("b-secret");

    const write = await s3Request(endpoint, a, "PUT", `${bucket}/${env.prefix}/${B}/planted.txt`, { body: "x" });
    expect(write.status).toBe(403);
    expect(write.body).toContain("AccessDenied");

    const del = await s3Request(endpoint, a, "DELETE", objB);
    expect(del.status).toBe(403);

    // B's object is untouched.
    const still = await s3Request(endpoint, b, "GET", objB);
    expect(still.body).toBe("b-secret");
  });

  it("A gets AccessDenied listing B's prefix, the bucket root and the shared prefix", async () => {
    for (const query of [
      { "list-type": "2", prefix: `${env.prefix}/${B}/` },
      { "list-type": "2" },
      { "list-type": "2", prefix: "" },
      { "list-type": "2", prefix: `${env.prefix}/` },
      { "list-type": "2", prefix: `${env.prefix}/${A}` }, // no trailing slash would also match core-ab
    ]) {
      const list = await s3Request(endpoint, a, "GET", bucket, { query });
      expect(list.status, JSON.stringify(query)).toBe(403);
      expect(list.body).toContain("AccessDenied");
      expect(list.body).not.toContain(B);
    }
  });

  it("A cannot write beside its prefix or into a look-alike prefix", async () => {
    for (const key of [`${env.prefix}/x.txt`, "root.txt", `${env.prefix}/${A}-evil/x.txt`]) {
      const put = await s3Request(endpoint, a, "PUT", `${bucket}/${key}`, { body: "x" });
      expect(put.status, key).toBe(403);
    }
  });

  it("each key stops at its own Core: B reads its own and not A's", async () => {
    expect((await s3Request(endpoint, b, "GET", objB)).status).toBe(200);
    expect((await s3Request(endpoint, b, "GET", objA)).status).toBe(403);
  });

  it("a key without its session token is refused", async () => {
    const bare = await s3Request(endpoint, { ...a, sessionToken: undefined }, "GET", objA);
    expect(bare.status).toBeGreaterThanOrEqual(400);
  });
});
