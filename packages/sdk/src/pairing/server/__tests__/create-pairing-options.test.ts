// `createPairing`'s audit, logger and bearerDays options (actana/client#12).
//
// Control 0.4.5 wired its audit log, its logger and `AC_CORE_BEARER_DAYS` into
// the pairing endpoint and the revocation sweep. These tests mount the real
// redeem handler from `createPairing` on an HTTPS server and read what reaches
// each seam.

import * as https from "node:https";
import { Server } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeBearer } from "../../bearer.ts";
import { generateClientCsr, type CertNaming } from "../../cert-material.ts";
import { generatePairingCode } from "../../code.ts";
import { derivePairingCodeKey, hashPairingCode } from "../../digest.ts";
import { mintFreshMaterial, type PersistedMaterial } from "../../material-store.ts";
import { createMemoryPairingStore } from "../../stores/memory.ts";
import type { PairingStore } from "../../store-port.ts";
import { PAIRING_REDEEM_PATH } from "../../wire.ts";
import { createPairing, type CreatePairingOptions } from "../index.ts";

const TEST_NAMES: CertNaming = {
  caCommonName: "test-pairing-ca",
  clientCommonName: "test-pairing-client",
  organizationName: "Test",
};

const DAY_MS = 24 * 60 * 60 * 1000;

let material: PersistedMaterial;
let server: https.Server | null = null;

beforeAll(async () => {
  material = await mintFreshMaterial(["127.0.0.1"], { names: TEST_NAMES });
}, 30_000);

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

type Rig = {
  store: PairingStore;
  pairing: ReturnType<typeof createPairing>;
  openSession(label?: string): Promise<{ sessionId: string; code: string }>;
  redeem(redemption: { sessionId: string; code: string }): Promise<{ status: number; body: string; csrKey: string }>;
};

async function startRig(
  extra: Partial<CreatePairingOptions> = {},
  store: PairingStore = createMemoryPairingStore(),
): Promise<Rig> {
  const port = await freePort();
  const pairing = createPairing({
    store,
    material,
    endpointScheme: "wss",
    port,
    publicHosts: ["127.0.0.1"],
    onRevoked: () => {},
    names: { ...TEST_NAMES, issPrefix: "core:" },
    ...extra,
  });
  server = https.createServer(
    { cert: material.serverCert, key: material.serverKey, ca: material.caCert },
    (req, res) => {
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
  const codeKey = derivePairingCodeKey(material.bearerSecret);
  return {
    store,
    pairing,
    openSession: async (label = "laptop") => {
      const code = generatePairingCode();
      const sessionId = `ps_${Math.random().toString(16).slice(2, 10)}`;
      await store.createSession({
        id: sessionId,
        label,
        codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
        now: Date.now(),
      });
      return { sessionId, code };
    },
    redeem: async ({ sessionId, code }) => {
      const { csrPem, privateKeyPem } = await generateClientCsr("laptop");
      const payload = JSON.stringify({ sessionId, code, client: { label: "laptop" }, csr: csrPem });
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = https.request(
          `https://127.0.0.1:${port}${PAIRING_REDEEM_PATH}`,
          {
            method: "POST",
            agent: false,
            ca: material.caCert,
            headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        req.end(payload);
      });
      return { ...res, csrKey: privateKeyPem };
    },
  };
}

describe("createPairing with none of the new options", () => {
  it("issues a 365-day bearer and accepts a redemption and a sweep with no sink or logger", async () => {
    const rig = await startRig();
    const { sessionId, code } = await rig.openSession();
    const before = Date.now();

    const res = await rig.redeem({ sessionId, code });
    const wrong = await rig.redeem({ sessionId: "ps_unknown", code: "AAAA-AAAA" });

    expect(res.status).toBe(200);
    expect(wrong.status).toBe(403);
    const claims = decodeBearer((JSON.parse(res.body) as { bearer: string }).bearer)!;
    expect(claims.exp - before).toBeGreaterThanOrEqual(365 * DAY_MS);
    expect(claims.exp - Date.now()).toBeLessThanOrEqual(365 * DAY_MS);
    const sweep = rig.pairing.startRevocationSweep();
    sweep.stop();
  }, 30_000);
});
