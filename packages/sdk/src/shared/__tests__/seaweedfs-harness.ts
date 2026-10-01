// A CoreShared on a real SeaweedFS for the contract suite, reusing PR 32's pieces: the same env as
// seaweedfs.isolation.test.ts, the SeaweedFS key issuer and its JWKS, and the bucket made with the
// static admin identity. Each call to newCore() is a new Core id, so a test starts on an empty folder.
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createSeaweedfsKeyIssuer, createSharedKeyProvider, publicJwks, type SharedKey } from "../../shared-key.ts";
import { createS3CoreShared } from "../s3.ts";
import type { ContractHarness } from "./contract.ts";
import { s3Request } from "../../shared-key/__tests__/sigv4.ts";

export const seaweedfsEnv = {
  endpoint: process.env.SEAWEEDFS_ENDPOINT,
  adminKey: process.env.SEAWEEDFS_ADMIN_ACCESS_KEY,
  adminSecret: process.env.SEAWEEDFS_ADMIN_SECRET_KEY,
  issuer: process.env.SEAWEEDFS_OIDC_ISSUER,
  jwksPort: Number(process.env.SEAWEEDFS_JWKS_PORT),
  audience: process.env.SEAWEEDFS_OIDC_AUDIENCE ?? "actana-shared",
  bucket: process.env.SEAWEEDFS_BUCKET ?? "actana-shared",
  prefix: process.env.SEAWEEDFS_PREFIX ?? "cores",
};

/**
 * The controller's signing key. SeaweedFS reads the JWKS once and may keep it, so every test file of
 * a CI job must sign with the same key: the job makes one and names it in SEAWEEDFS_SIGNING_KEY_FILE.
 * Without it (a developer's own SeaweedFS) a fresh key is made, fine for a single file.
 */
export function loadSigningKey(): string | KeyObject {
  const file = process.env.SEAWEEDFS_SIGNING_KEY_FILE;
  return file ? readFileSync(file, "utf8") : generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
}

export const SEAWEEDFS_KEY_ID = "ci-key";

export interface SeaweedfsHarness {
  newCore(): Promise<ContractHarness & { coreId: string; key(): Promise<SharedKey> }>;
  close(): Promise<void>;
}

/** Undefined when SEAWEEDFS_* is not set. */
export function seaweedfsHarness(): SeaweedfsHarness | undefined {
  const env = seaweedfsEnv;
  if (!(env.endpoint && env.adminKey && env.adminSecret && env.issuer && env.jwksPort)) return undefined;
  let ready: Promise<{ server: Server; issuer: ReturnType<typeof createSeaweedfsKeyIssuer> }> | undefined;

  const start = async () => {
    const privateKey = loadSigningKey();
    const jwks = JSON.stringify(publicJwks(privateKey, SEAWEEDFS_KEY_ID));
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/jwks.json" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/jwks.json" ? jwks : "{}");
    });
    await new Promise<void>((resolve) => server.listen(env.jwksPort, "127.0.0.1", resolve));
    const made = await s3Request(env.endpoint!, { accessKeyId: env.adminKey!, secretAccessKey: env.adminSecret! }, "PUT", env.bucket);
    if (![200, 409].includes(made.status)) throw new Error(`could not make the bucket: ${made.status} ${made.body}`);
    const issuer = createSeaweedfsKeyIssuer({
      endpoint: env.endpoint!,
      issuer: env.issuer!,
      audience: env.audience,
      signingKey: privateKey,
      keyId: SEAWEEDFS_KEY_ID,
    });
    return { server, issuer };
  };

  return {
    async newCore() {
      ready ??= start();
      const { issuer } = await ready;
      const coreId = `core-c-${randomBytes(5).toString("hex")}`;
      const provider = createSharedKeyProvider({ issuer, coreId });
      return {
        coreId,
        key: () => provider.get(),
        shared: createS3CoreShared({
          endpoint: env.endpoint!,
          bucket: env.bucket,
          prefix: `${env.prefix}/${coreId}`,
          listPageSize: 5,
          credentials: provider,
        }),
        dispose: async () => {},
      };
    },
    async close() {
      if (!ready) return;
      const { server } = await ready;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
