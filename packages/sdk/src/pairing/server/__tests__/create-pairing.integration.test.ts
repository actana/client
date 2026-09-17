// Mint → redeem → revoke through createPairing against json-file and postgres.

import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { Server } from "node:net";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePairingCode } from "../../code.ts";
import { generateClientCsr, type CertNaming } from "../../cert-material.ts";
import { derivePairingCodeKey, hashPairingCode } from "../../digest.ts";
import { mintFreshMaterial, type PersistedMaterial } from "../../material-store.ts";
import { createJsonFilePairingStore } from "../../stores/json-file.ts";
import {
  ensurePairingTables,
  truncatePairingTables,
} from "../../stores/postgres-schema.ts";
import { createPostgresPairingStore } from "../../stores/postgres.ts";
import type { PairingStore } from "../../store-port.ts";
import { PAIRING_REDEEM_PATH } from "../../wire.ts";
import { createPairing } from "../index.ts";

const execFile = promisify(execFileCb);

const TEST_NAMES: CertNaming = {
  caCommonName: "test-pairing-ca",
  clientCommonName: "test-pairing-client",
  organizationName: "Test",
};

const DOCKER_PORT = 55_433;
const DOCKER_IMAGE = "postgres:16-alpine";
const DOCKER_URL = `postgresql://postgres:postgres@127.0.0.1:${DOCKER_PORT}/postgres`;

type PgModule = typeof import("pg");

let server: https.Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Server();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const { port } = address;
        probe.close(() => resolve(port));
      } else {
        probe.close();
        reject(new Error("no port"));
      }
    });
  });
}

async function dockerDaemonAvailable(): Promise<boolean> {
  try {
    await execFile("docker", ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForPostgres(url: string, attempts = 30): Promise<void> {
  const pg = await import("pg");
  for (let i = 0; i < attempts; i++) {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Postgres did not become ready at ${url}`);
}

async function startDockerPostgres(): Promise<string> {
  const { stdout } = await execFile("docker", [
    "run",
    "-d",
    "--rm",
    "-p",
    `${DOCKER_PORT}:5432`,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    DOCKER_IMAGE,
  ]);
  const containerId = stdout.trim();
  await waitForPostgres(DOCKER_URL);
  return containerId;
}

type TestDatabase = {
  pool: InstanceType<PgModule["Pool"]>;
  dockerContainerId: string | null;
};

async function resolveTestDatabase(): Promise<TestDatabase | null> {
  const configured =
    process.env.SEARCH_TEST_DATABASE_URL ?? process.env.ACTANA_TEST_DATABASE_URL ?? "";
  if (configured !== "") {
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: configured, max: 4 });
    await ensurePairingTables(pool, "search");
    return { pool, dockerContainerId: null };
  }
  if (!(await dockerDaemonAvailable())) return null;
  const containerId = await startDockerPostgres();
  const pg = await import("pg");
  const pool = new pg.Pool({ connectionString: DOCKER_URL, max: 4 });
  await ensurePairingTables(pool, "search");
  return { pool, dockerContainerId: containerId };
}

async function materialFor(hosts: string[]): Promise<PersistedMaterial> {
  return mintFreshMaterial(hosts, { names: TEST_NAMES });
}

type Rig = {
  store: PairingStore;
  material: PersistedMaterial;
  port: number;
  origin: string;
  onRevoked: ReturnType<typeof vi.fn>;
  openSession(): Promise<{ sessionId: string; code: string }>;
};

async function startPairingServer(store: PairingStore, material: PersistedMaterial): Promise<Rig> {
  const port = await freePort();
  const onRevoked = vi.fn();
  const pairing = createPairing({
    store,
    material,
    endpointScheme: "wss",
    port,
    publicHosts: ["127.0.0.1"],
    onRevoked,
    names: { ...TEST_NAMES, issPrefix: "core:" },
  });
  const sweep = pairing.startRevocationSweep();
  const codeKey = derivePairingCodeKey(material.bearerSecret);

  server = https.createServer(
    {
      cert: material.serverCert,
      key: material.serverKey,
      ca: material.caCert,
      requestCert: false,
      rejectUnauthorized: false,
    },
    (req, res) => {
      if (!pairing.gate.mayServe(req)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!pairing.redeem.handle(req, res)) {
        res.writeHead(404);
        res.end();
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(port, "127.0.0.1", () => resolve());
  });

  const rig: Rig = {
    store,
    material,
    port,
    origin: `https://127.0.0.1:${port}`,
    onRevoked,
    openSession: async () => {
      const code = generatePairingCode();
      const sessionId = `ps_${Math.random().toString(16).slice(2, 10)}`;
      await store.createSession({
        id: sessionId,
        label: "laptop",
        codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
        now: Date.now(),
      });
      return { sessionId, code };
    },
  };

  rig.onRevoked.mockImplementation(() => sweep.stop());
  return rig;
}

function post(origin: string, caCert: string, url: string, body: object): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${origin}${url}`,
      {
        method: "POST",
        agent: false,
        ca: caCert,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function redeemSession(
  rig: Rig,
  session: { sessionId: string; code: string },
): Promise<{ status: number; body: string; certSerial: string }> {
  const { csrPem } = await generateClientCsr("laptop");
  const response = await post(rig.origin, rig.material.caCert, PAIRING_REDEEM_PATH, {
    sessionId: session.sessionId,
    code: session.code,
    client: { label: "laptop", platform: "linux" },
    csr: csrPem,
  });
  const parsed = JSON.parse(response.body) as { clientCert: string };
  const certSerial = new X509Certificate(parsed.clientCert).serialNumber.toLowerCase();
  return { ...response, certSerial };
}

async function mintRedeemRevoke(store: PairingStore, material: PersistedMaterial): Promise<void> {
  const rig = await startPairingServer(store, material);
  const session = await rig.openSession();
  const redeemed = await redeemSession(rig, session);
  expect(redeemed.status).toBe(200);

  const revoked = await store.revoke({ kind: "client", certSerial: redeemed.certSerial, at: Date.now() });
  expect(revoked.ok).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(rig.onRevoked).toHaveBeenCalled();
  expect((await store.revokedSerials()).has(redeemed.certSerial)).toBe(true);
}

describe("createPairing integration", () => {
  describe("json-file store", () => {
    let filePath: string;

    beforeEach(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-create-"));
      filePath = path.join(dir, "pairing.json");
    });

    it("mints, redeems, and revokes through createPairing.redeem", async () => {
      const material = await materialFor(["127.0.0.1"]);
      const store = createJsonFilePairingStore(filePath);
      await mintRedeemRevoke(store, material);
    });
  });

  describe("postgres store", () => {
    let db: TestDatabase | null = null;

    beforeAll(async () => {
      db = await resolveTestDatabase();
    });

    afterAll(async () => {
      if (db?.dockerContainerId) {
        await execFile("docker", ["stop", db.dockerContainerId]).catch(() => undefined);
      }
      await db?.pool.end().catch(() => undefined);
    });

    beforeEach(async () => {
      if (db) await truncatePairingTables(db.pool, "search");
    });

    it.skipIf(!db)("mints, redeems, and revokes through createPairing.redeem", async () => {
      if (!db) return;
      const material = await materialFor(["127.0.0.1"]);
      const store = createPostgresPairingStore(db.pool, { schema: "search" });
      await mintRedeemRevoke(store, material);
    });
  });
});
