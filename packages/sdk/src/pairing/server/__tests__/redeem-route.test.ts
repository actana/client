// The pairing redeem route, against an in-memory store (#282).
//
// Ported from actana/control `core-pairing-redeem.test.ts`: the handler is
// mounted on a real HTTPS server, certificates come from `generateCertMaterial`,
// and sessions go through the same `PairingStore` port the products will use.

import * as https from "node:https";
import { Server } from "node:net";
import { X509Certificate, createPublicKey } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBearer, decodeBearer } from "../../bearer.ts";
import { generatePairingCode } from "../../code.ts";
import { generateCertMaterial, generateClientCsr, type CertNaming } from "../../cert-material.ts";
import { derivePairingCodeKey, hashPairingCode } from "../../digest.ts";
import { createMemoryPairingStore } from "../../stores/memory.ts";
import type { PairingAuditEvent } from "../../audit.ts";
import type { PairingRefusalBody } from "../../wire.ts";
import { PAIRING_REDEEM_PATH } from "../../wire.ts";
import { PairingRateLimiter } from "../rate-limit.ts";
import { buildPairingEndpointResolver, createPairingRedeemHandler } from "../redeem-route.ts";
import type { PairingStore } from "../../store-port.ts";

const SECRET = "core-pairing-suite-secret-at-least-32-bytes";
const CORE_UUID = "3f6d0f0a-6c1f-4a5e-9c2f-1d0a5b7e9c31";

const TEST_NAMES: CertNaming = {
  caCommonName: "test-pairing-ca",
  clientCommonName: "test-pairing-client",
  organizationName: "Test",
};

type Rig = {
  origin: string;
  caCert: string;
  store: PairingStore;
  audit: PairingAuditEvent[];
  clock: { now: number };
  openSession(opts?: {
    label?: string;
    ttlMs?: number;
    now?: number;
    endpointHost?: string;
  }): Promise<{ sessionId: string; code: string }>;
};

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

function parseRefusal(body: string): PairingRefusalBody {
  const parsed = JSON.parse(body) as PairingRefusalBody;
  expect(parsed).toMatchObject({
    code: expect.any(String),
    error: expect.any(String),
    message: expect.any(String),
    detail: expect.any(Object),
  });
  return parsed;
}

async function startServer(
  opts: { rateLimiter?: PairingRateLimiter; publicHosts?: string[] } = {},
): Promise<Rig> {
  const publicHosts = opts.publicHosts ?? ["127.0.0.1"];
  const material = await generateCertMaterial({ hosts: publicHosts, names: TEST_NAMES });
  const port = await freePort();
  const store = createMemoryPairingStore();
  const audit: PairingAuditEvent[] = [];
  const clock = { now: Date.now() };
  const codeKey = derivePairingCodeKey(SECRET);

  const pairingRoutes = createPairingRedeemHandler({
    material: {
      caCert: material.ca.cert,
      caKey: material.ca.key,
      bearerSecret: SECRET,
      issuerId: "core_pairing",
      audience: CORE_UUID,
      issPrefix: "core:",
    },
    store,
    endpointScheme: "wss",
    endpointFor: buildPairingEndpointResolver({ endpointScheme: "wss", publicHosts, port }),
    clientLabel: "session",
    now: () => clock.now,
    audit: (event) => audit.push(event),
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  });

  server = https.createServer(
    {
      cert: material.server.cert,
      key: material.server.key,
      ca: material.ca.cert,
      requestCert: false,
      rejectUnauthorized: false,
    },
    (req, res) => {
      if (!pairingRoutes.handle(req, res)) {
        res.writeHead(404);
        res.end();
      }
    },
  );

  const rig: Rig = {
    origin: `https://127.0.0.1:${port}`,
    caCert: material.ca.cert,
    store,
    audit,
    clock,
    openSession: async ({ label = "laptop", ttlMs, now, endpointHost } = {}) => {
      const code = generatePairingCode();
      const sessionId = `ps_${Math.random().toString(16).slice(2, 10)}`;
      await store.createSession({
        id: sessionId,
        label,
        codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
        now: now ?? clock.now,
        ...(ttlMs === undefined ? {} : { ttlMs }),
        ...(endpointHost === undefined ? {} : { endpointHost }),
      });
      return { sessionId, code };
    },
  };

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(port, "127.0.0.1", () => resolve());
  });

  return rig;
}

type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function post(
  rig: Rig,
  url: string,
  body: string | object,
  opts: {
    contentType?: string;
    method?: string;
    host?: string;
  } = {},
): Promise<Response> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${rig.origin}${url}`,
      {
        method: opts.method ?? "POST",
        agent: false,
        ca: rig.caCert,
        ...(opts.host === undefined ? {} : { servername: "" }),
        headers: {
          "content-type": opts.contentType ?? "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          ...(opts.host === undefined ? {} : { host: opts.host }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

type Redemption = { sessionId: string; code: string; csr: string; label?: string };

function redeem(rig: Rig, redemption: Redemption): Promise<Response> {
  return post(rig, PAIRING_REDEEM_PATH, {
    sessionId: redemption.sessionId,
    code: redemption.code,
    client: { label: redemption.label ?? "laptop", platform: "linux" },
    csr: redemption.csr,
  });
}

describe("every refusal carries all four fields", () => {
  it("on pairing-refused, bad-request, rate-limited and not-found", async () => {
    const rig = await startServer();
    const { sessionId } = await rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    parseRefusal((await redeem(rig, { sessionId, code: "ZZZZ-ZZZZ", csr: csrPem })).body);
    parseRefusal((await post(rig, PAIRING_REDEEM_PATH, { sessionId: "ps_x", code: "AAAA-AAAA", csr: "x" })).body);
    parseRefusal((await post(rig, "/v1/pair/missing", { sessionId: "ps_x", code: "AAAA-AAAA", csr: "x" })).body);

    const limited = await startServer({
      rateLimiter: new PairingRateLimiter({ peer: { limit: 1, windowMs: 60_000 } }),
    });
    const limitedSession = await limited.openSession();
    const csr = await generateClientCsr("laptop");
    await redeem(limited, { sessionId: limitedSession.sessionId, code: "ZZZZ-ZZZZ", csr: csr.csrPem });
    parseRefusal((await redeem(limited, { sessionId: limitedSession.sessionId, code: "ZZZZ-ZZZZ", csr: csr.csrPem })).body);
  }, 30_000);
});

describe("a client with a code pairs end to end", () => {
  it("issues a certificate, a CA and a bearer — and never a private key", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession({ label: "laptop" });
    const { csrPem, privateKeyPem } = await generateClientCsr("laptop");

    const res = await redeem(rig, { sessionId, code, csr: csrPem });

    expect(res.status).toBe(200);
    const issued = JSON.parse(res.body) as Record<string, string>;
    expect(Object.keys(issued).sort()).toEqual(["bearer", "caCert", "clientCert", "endpoint"]);
    expect(issued.endpoint).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/);
    expect(res.body).not.toMatch(/PRIVATE KEY/);
    expect(res.body).not.toContain(privateKeyPem.split("\n")[1]!);

    const cert = new X509Certificate(issued.clientCert!);
    expect(cert.verify(createPublicKey(issued.caCert!))).toBe(true);
    expect(cert.ca).toBe(false);
  }, 30_000);

  it("issues a bearer carrying iss, sub, aud and jti beside exp", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    const res = await redeem(rig, { sessionId, code, csr: csrPem });
    const issued = JSON.parse(res.body) as Record<string, string>;

    const verdict = verifyBearer(issued.bearer!, SECRET);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.aud).toBe(CORE_UUID);
    expect(verdict.iss).toBe("core:core_pairing");
    expect(verdict.sub).toBe(`pair:${new X509Certificate(issued.clientCert!).serialNumber.toLowerCase()}`);
    expect(decodeBearer(issued.bearer!)?.jti).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);

  it("persists the paired client so listClients has something to read", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession({ label: "studio laptop" });
    const { csrPem } = await generateClientCsr("laptop");

    const res = await redeem(rig, { sessionId, code, csr: csrPem });
    const issued = JSON.parse(res.body) as Record<string, string>;

    const [client] = await rig.store.listClients();
    expect(client).toMatchObject({
      label: "studio laptop",
      sessionId,
      revokedAt: null,
      created_by: null,
      tenant_id: null,
      auth_method: null,
    });
    expect(client!.certSerial).toBe(new X509Certificate(issued.clientCert!).serialNumber.toLowerCase());
    expect(client!.certSubject).toContain("studio laptop");
  }, 30_000);
});

describe("the defences", () => {
  it("kills the session at five wrong codes, and refuses identically throughout", async () => {
    const rig = await startServer();
    const { sessionId } = await rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    const refusals: Response[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      refusals.push(await redeem(rig, { sessionId, code: "ZZZZ-ZZZZ", csr: csrPem }));
    }

    expect(refusals.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect(new Set(refusals.map((r) => r.body)).size).toBe(1);
    for (const refusal of refusals) parseRefusal(refusal.body);

    const listed = await rig.store.listSessions();
    expect(listed.find((s) => s.id === sessionId)?.attempts).toBe(5);

    const { code } = await rig.openSession();
    const dead = await redeem(rig, { sessionId, code, csr: csrPem });
    expect(dead.status).toBe(403);
    expect(dead.body).toBe(refusals[0]!.body);
  }, 30_000);

  it("refuses an expired session", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession({ ttlMs: 60_000 });
    const { csrPem } = await generateClientCsr("laptop");

    rig.clock.now += 60_001;
    const res = await redeem(rig, { sessionId, code, csr: csrPem });

    expect(res.status).toBe(403);
    parseRefusal(res.body);
    expect(rig.audit.at(-1)).toMatchObject({ outcome: "refused", reason: "expired" });
  }, 30_000);

  it("refuses a replay of a consumed session", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession();
    const first = await generateClientCsr("laptop");
    const second = await generateClientCsr("attacker");

    const ok = await redeem(rig, { sessionId, code, csr: first.csrPem });
    const replay = await redeem(rig, { sessionId, code, csr: second.csrPem });

    expect(ok.status).toBe(200);
    expect(replay.status).toBe(403);
    expect((await rig.store.listClients()).length).toBe(1);
  }, 30_000);

  it("refuses a code that belongs to another session", async () => {
    const rig = await startServer();
    const a = await rig.openSession({ label: "a" });
    const b = await rig.openSession({ label: "b" });
    const { csrPem } = await generateClientCsr("laptop");

    const crossed = await redeem(rig, { sessionId: b.sessionId, code: a.code, csr: csrPem });

    expect(crossed.status).toBe(403);
    const listed = await rig.store.listSessions();
    expect(listed.find((s) => s.id === b.sessionId)?.attempts).toBe(1);
    expect(listed.find((s) => s.id === a.sessionId)?.attempts).toBe(0);
  }, 30_000);

  it("refuses an unknown session with the same answer as a wrong code", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    const unknown = await redeem(rig, { sessionId: "ps_nothing", code, csr: csrPem });
    const wrong = await redeem(rig, { sessionId, code: "ZZZZ-ZZZZ", csr: csrPem });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toBe(wrong.body);
    expect(unknown.headers["content-length"]).toBe(wrong.headers["content-length"]);
  }, 30_000);

  it("trips its own rate limit before the per-session cap is spent", async () => {
    const rig = await startServer({
      rateLimiter: new PairingRateLimiter({ peer: { limit: 3, windowMs: 60_000 } }),
    });
    const { sessionId } = await rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await redeem(rig, { sessionId, code: "ZZZZ-ZZZZ", csr: csrPem })).status);
    }

    expect(statuses).toEqual([403, 403, 403, 429]);
    const listed = await rig.store.listSessions();
    expect(listed.find((s) => s.id === sessionId)?.attempts).toBe(3);
    expect(rig.audit.at(-1)).toMatchObject({ outcome: "rate-limited" });
  }, 30_000);

  it("does not spend the session on a CSR it cannot sign", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession();

    const bad = await redeem(rig, { sessionId, code, csr: "-----BEGIN CERTIFICATE REQUEST-----\nnope\n" });

    expect(bad.status).toBe(400);
    const listed = await rig.store.listSessions();
    expect(listed.find((s) => s.id === sessionId)?.consumedAt).toBeNull();

    const { csrPem } = await generateClientCsr("laptop");
    expect((await redeem(rig, { sessionId, code, csr: csrPem })).status).toBe(200);
  }, 30_000);

  it("lets only one of two simultaneous redemptions win", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession();
    const first = await generateClientCsr("laptop");
    const second = await generateClientCsr("desktop");

    const [a, b] = await Promise.all([
      redeem(rig, { sessionId, code, csr: first.csrPem }),
      redeem(rig, { sessionId, code, csr: second.csrPem }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect((await rig.store.listClients()).length).toBe(1);
  }, 30_000);

  it("audits every attempt — success and failure — and never the code or the CSR", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession({ label: "laptop" });
    const { csrPem } = await generateClientCsr("laptop");

    await redeem(rig, { sessionId, code: "ZZZZ-ZZZZ", csr: csrPem });
    await redeem(rig, { sessionId, code, csr: csrPem });

    expect(rig.audit.map((event) => event.outcome)).toEqual(["refused", "issued"]);
    for (const event of rig.audit) {
      expect(event.peer).toMatch(/127\.0\.0\.1|::ffff:127\.0\.0\.1|::1/);
      expect(event.label).toBe("laptop");
      const serialised = JSON.stringify(event);
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain("CERTIFICATE REQUEST");
    }
  }, 30_000);

  it("refuses a body too large to be a redemption", async () => {
    const rig = await startServer();
    const res = await post(rig, PAIRING_REDEEM_PATH, { csr: "x".repeat(64 * 1024) });
    expect(res.status).toBe(413);
    parseRefusal(res.body);
  }, 30_000);

  it("refuses a GET at the redemption path", async () => {
    const rig = await startServer();
    const res = await post(rig, PAIRING_REDEEM_PATH, "", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
    parseRefusal(res.body);
  }, 30_000);
});

describe("a session the operator cancelled (#283)", () => {
  it("is refused, and the refusal is indistinguishable from every other one", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    await rig.store.revoke({ kind: "session", sessionId, at: rig.clock.now });

    const res = await redeem(rig, { sessionId, code, csr: csrPem });
    expect(res.status).toBe(403);
    expect(await rig.store.listClients()).toEqual([]);
  }, 30_000);

  it("says `revoked` in the audit log, not `wrong-code`", async () => {
    const rig = await startServer();
    const { sessionId, code } = await rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");
    await rig.store.revoke({ kind: "session", sessionId, at: rig.clock.now });

    await redeem(rig, { sessionId, code, csr: csrPem });

    expect(rig.audit.at(-1)).toMatchObject({ outcome: "refused", reason: "revoked", sessionId });
  }, 30_000);

  it("does not spend an attempt the session will never get to use", async () => {
    const rig = await startServer();
    const { sessionId } = await rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");
    await rig.store.revoke({ kind: "session", sessionId, at: rig.clock.now });

    await redeem(rig, { sessionId, code: "AAAA-BBBB", csr: csrPem });

    const listed = await rig.store.listSessions();
    expect(listed.find((s) => s.id === sessionId)?.attempts).toBe(0);
  }, 30_000);
});

describe("the endpoint a redemption hands back", () => {
  it("is the host the operator chose for that code", async () => {
    const rig = await startServer({ publicHosts: ["core", "10.0.0.5"] });
    const panel = await rig.openSession({ label: "panel", endpointHost: "core" });
    const laptop = await rig.openSession({ label: "laptop", endpointHost: "10.0.0.5" });

    const first = await redeem(rig, {
      sessionId: panel.sessionId,
      code: panel.code,
      csr: (await generateClientCsr("panel")).csrPem,
    });
    const second = await redeem(rig, {
      sessionId: laptop.sessionId,
      code: laptop.code,
      csr: (await generateClientCsr("laptop")).csrPem,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(first.body).endpoint).toMatch(/^wss:\/\/core:\d+$/);
    expect(JSON.parse(second.body).endpoint).toMatch(/^wss:\/\/10\.0\.0\.5:\d+$/);
  }, 30_000);

  it("is the primary when the code chose nothing", async () => {
    const rig = await startServer({ publicHosts: ["core", "10.0.0.5"] });
    const { sessionId, code } = await rig.openSession({ label: "panel" });

    const res = await redeem(rig, {
      sessionId,
      code,
      csr: (await generateClientCsr("panel")).csrPem,
    });

    expect(JSON.parse(res.body).endpoint).toMatch(/^wss:\/\/core:\d+$/);
  }, 30_000);

  it("ignores the Host header, whatever it claims", async () => {
    const rig = await startServer({ publicHosts: ["core", "10.0.0.5"] });
    const { sessionId, code } = await rig.openSession({ label: "panel" });

    const res = await post(
      rig,
      PAIRING_REDEEM_PATH,
      {
        sessionId,
        code,
        client: { label: "panel", platform: "linux" },
        csr: (await generateClientCsr("panel")).csrPem,
      },
      { host: "attacker.example" },
    );

    expect(res.status).toBe(200);
    const { endpoint } = JSON.parse(res.body) as { endpoint: string };
    expect(endpoint).not.toContain("attacker.example");
    expect(endpoint).toMatch(/^wss:\/\/core:\d+$/);
  }, 30_000);

  it("falls back to the primary for a host that is no longer configured", async () => {
    const rig = await startServer({ publicHosts: ["core"] });
    const { sessionId, code } = await rig.openSession({ label: "laptop", endpointHost: "10.0.0.5" });

    const res = await redeem(rig, {
      sessionId,
      code,
      csr: (await generateClientCsr("laptop")).csrPem,
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).endpoint).toMatch(/^wss:\/\/core:\d+$/);
  }, 30_000);
});
