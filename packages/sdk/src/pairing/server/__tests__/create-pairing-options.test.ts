// `createPairing`'s audit, logger and bearerDays options (actana/client#12).
//
// Control 0.4.5 wired its audit log, its logger and `AC_CORE_BEARER_DAYS` into
// the pairing endpoint and the revocation sweep. These tests mount the real
// redeem handler from `createPairing` on an HTTPS server and read what reaches
// each seam.

import * as https from "node:https";
import { Server } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  openSession(label?: string, when?: { now: number; ttlMs: number }): Promise<{ sessionId: string; code: string }>;
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
    openSession: async (label = "laptop", when) => {
      const code = generatePairingCode();
      const sessionId = `ps_${Math.random().toString(16).slice(2, 10)}`;
      await store.createSession({
        id: sessionId,
        label,
        codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
        now: when?.now ?? Date.now(),
        ...(when ? { ttlMs: when.ttlMs } : {}),
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

describe("the audit option", () => {
  it("receives an issued record with the session, label and issued certSerial", async () => {
    const records: Record<string, unknown>[] = [];
    const rig = await startRig({ audit: (record) => records.push(record) });
    const { sessionId, code } = await rig.openSession("desk");

    const res = await rig.redeem({ sessionId, code });

    expect(res.status).toBe(200);
    expect(records).toHaveLength(1);
    const issued = records[0]!;
    expect(issued).toMatchObject({ outcome: "issued", sessionId, label: "desk" });
    expect(issued.certSerial).toEqual(expect.stringMatching(/^[0-9a-f]+$/i));
    expect(Object.keys(issued).sort()).toEqual(["at", "certSerial", "label", "outcome", "peer", "sessionId"]);
  }, 30_000);

  it("receives a wrong-code refusal with its reason and the wrong codes counted", async () => {
    const records: Record<string, unknown>[] = [];
    const rig = await startRig({ audit: (record) => records.push(record) });
    const { sessionId } = await rig.openSession("desk");

    const res = await rig.redeem({ sessionId, code: "ZZZZ-ZZZZ" });

    expect(res.status).toBe(403);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "refused",
      reason: "wrong-code",
      sessionId,
      label: "desk",
      attempts: 1,
    });
  }, 30_000);

  it("receives unknown-session, expired and revoked refusals", async () => {
    const records: Record<string, unknown>[] = [];
    const rig = await startRig({ audit: (record) => records.push(record) });
    const expired = await rig.openSession("old", { now: Date.now() - 60_000, ttlMs: 1_000 });
    const revoked = await rig.openSession("gone");
    await rig.store.revoke({ kind: "session", sessionId: revoked.sessionId, at: Date.now() });

    await rig.redeem({ sessionId: "ps_nobody", code: "AAAA-AAAA" });
    await rig.redeem(expired);
    await rig.redeem(revoked);

    expect(records.map((r) => [r.outcome, r.reason])).toEqual([
      ["refused", "unknown-session"],
      ["refused", "expired"],
      ["refused", "revoked"],
    ]);
    expect(records[1]).toMatchObject({ sessionId: expired.sessionId, label: "old" });
    expect(records[2]).toMatchObject({ sessionId: revoked.sessionId, label: "gone" });
  }, 30_000);

  it("receives a rate-limited record once a peer exceeds its window", async () => {
    const records: Record<string, unknown>[] = [];
    const rig = await startRig({ audit: (record) => records.push(record) });

    for (let i = 0; i < 11; i++) await rig.redeem({ sessionId: "ps_nobody", code: "AAAA-AAAA" });

    expect(records.filter((r) => r.outcome === "rate-limited")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ outcome: "rate-limited", reason: "peer" });
  }, 60_000);

  it("never hands the sink a pairing code, a bearer or a private key", async () => {
    const records: Record<string, unknown>[] = [];
    const rig = await startRig({ audit: (record) => records.push(record) });
    const { sessionId, code } = await rig.openSession();
    const wrong = await rig.openSession();

    const wrongRes = await rig.redeem({ sessionId: wrong.sessionId, code: "ZZZZ-ZZZZ" });
    const okRes = await rig.redeem({ sessionId, code });
    const bearer = (JSON.parse(okRes.body) as { bearer: string }).bearer;

    const written = JSON.stringify(records);
    expect(records).toHaveLength(2);
    expect(written).not.toContain(code);
    expect(written).not.toContain("ZZZZ-ZZZZ");
    expect(written).not.toContain(bearer);
    expect(written).not.toContain(bearer.split(".")[0]!);
    expect(written).not.toContain("PRIVATE KEY");
    expect(written).not.toContain(okRes.csrKey.split("\n")[1]!);
    expect(written).not.toContain(wrongRes.csrKey.split("\n")[1]!);
    expect(written).not.toContain(material.bearerSecret);
    expect(written).not.toContain(material.caKey.split("\n")[1]!);
  }, 30_000);

  it("still answers the client when the sink throws", async () => {
    const rig = await startRig({
      audit: () => {
        throw new Error("audit disk full");
      },
    });
    const { sessionId, code } = await rig.openSession();

    const res = await rig.redeem({ sessionId, code });

    expect(res.status).toBe(200);
  }, 30_000);
});

describe("the logger option", () => {
  type Line = { level: "error" | "info"; event: string; fields?: Record<string, unknown> };
  const capture = () => {
    const lines: Line[] = [];
    return {
      lines,
      logger: {
        error: (event: string, fields?: Record<string, unknown>) =>
          lines.push({ level: "error", event, ...(fields ? { fields } : {}) }),
        info: (event: string, fields?: Record<string, unknown>) =>
          lines.push({ level: "info", event, ...(fields ? { fields } : {}) }),
      },
    };
  };

  it("receives core-pairing.revocation.unreadable once when the store cannot be read", async () => {
    const { lines, logger } = capture();
    const base = createMemoryPairingStore();
    const broken: PairingStore = {
      ...base,
      revokedSerials: async () => {
        throw new Error("pairing store is corrupt");
      },
    };
    const rig = await startRig({ logger }, broken);

    const sweep = rig.pairing.startRevocationSweep();
    await vi.waitFor(() => expect(rig.pairing.gate.revocations.isFailClosed()).toBe(true));
    await rig.pairing.gate.revocations.refresh();
    sweep.stop();

    expect(lines).toEqual([
      {
        level: "error",
        event: "core-pairing.revocation.unreadable",
        fields: { error: "pairing store is corrupt", effect: "every pairing refused" },
      },
    ]);
  }, 30_000);

  it("receives pairing.revoked with the serial when a live pairing is revoked", async () => {
    const { lines, logger } = capture();
    const rig = await startRig({ logger });
    const { sessionId, code } = await rig.openSession();
    const issued = await rig.redeem({ sessionId, code });
    expect(issued.status).toBe(200);
    const [client] = [...(await rig.store.listClients())];
    const sweep = rig.pairing.startRevocationSweep();
    await vi.waitFor(() => expect(rig.pairing.gate.revocations.isFailClosed()).toBe(false));

    await rig.store.revoke({ kind: "client", certSerial: client!.certSerial, at: Date.now() });
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0), { timeout: 5_000 });
    sweep.stop();

    expect(lines).toEqual([{ level: "info", event: "pairing.revoked", fields: { certSerials: [client!.certSerial] } }]);
  }, 30_000);

  it("never logs a pairing code, a bearer or a private key", async () => {
    const { lines, logger } = capture();
    const rig = await startRig({ logger });
    const { sessionId, code } = await rig.openSession();
    const issued = await rig.redeem({ sessionId, code });
    const bearer = (JSON.parse(issued.body) as { bearer: string }).bearer;
    const [client] = [...(await rig.store.listClients())];
    const sweep = rig.pairing.startRevocationSweep();
    await vi.waitFor(() => expect(rig.pairing.gate.revocations.isFailClosed()).toBe(false));
    await rig.store.revoke({ kind: "client", certSerial: client!.certSerial, at: Date.now() });
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0), { timeout: 5_000 });
    sweep.stop();

    const written = JSON.stringify(lines);
    expect(written).not.toContain(code);
    expect(written).not.toContain(bearer);
    expect(written).not.toContain("PRIVATE KEY");
    expect(written).not.toContain(issued.csrKey.split("\n")[1]!);
    expect(written).not.toContain(material.bearerSecret);
  }, 30_000);
});
