// A CoreShared on a real SeaweedFS for the contract suite, reusing PR 32's pieces: the same env as
// seaweedfs.isolation.test.ts, the SeaweedFS key issuer and its JWKS, and the bucket made with the
// static admin identity. Each call to newCore() is a new Core id, so a test starts on an empty folder.
import { generateKeyPairSync, randomBytes } from "node:crypto";
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

export interface SeaweedfsHarness {
  newCore(options?: { keyOverride?: (key: SharedKey) => SharedKey }): Promise<ContractHarness & { coreId: string }>;
  close(): Promise<void>;
}

/** Undefined when SEAWEEDFS_* is not set. */
export function seaweedfsHarness(): SeaweedfsHarness | undefined {
  const env = seaweedfsEnv;
  if (!(env.endpoint && env.adminKey && env.adminSecret && env.issuer && env.jwksPort)) return undefined;
  let ready: Promise<{ server: Server; issuer: ReturnType<typeof createSeaweedfsKeyIssuer> }> | undefined;

  const start = async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwks = JSON.stringify(publicJwks(privateKey, "contract-key"));
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
      keyId: "contract-key",
    });
    return { server, issuer };
  };

  return {
    async newCore(options = {}) {
      ready ??= start();
      const { issuer } = await ready;
      const coreId = `core-c-${randomBytes(5).toString("hex")}`;
      const provider = createSharedKeyProvider({ issuer, coreId });
      const credentials = options.keyOverride
        ? { get: async () => options.keyOverride!(await provider.get()) }
        : provider;
      return {
        coreId,
        shared: createS3CoreShared({
          endpoint: env.endpoint!,
          bucket: env.bucket,
          prefix: `${env.prefix}/${coreId}`,
          credentials,
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
