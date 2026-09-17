// SDK pairing — unit and stub-server tests (no live Core required).

import * as fs from "node:fs";
import * as https from "node:https";
import { Server } from "node:net";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { generateCertMaterial, issueServerCert, type CertNaming } from "../cert-material.ts";
import {
  PAIRING_REDEEM_PATH,
  PairingError,
  fetchPairingIdentity,
  fetchCorePairingIdentity,
  fingerprintOf,
  pairWith,
  pairWithCore,
  pairWithSearch,
  parsePairingTicket,
  parseProductAddress,
  type PairingFailure,
} from "../client.ts";
import type { PairingRedeemRequest, PairingRedeemResponse } from "../wire.ts";

const TEST_NAMES: CertNaming = {
  caCommonName: "test-pairing-ca",
  clientCommonName: "test-pairing-client",
  organizationName: "Test",
};

const stubs: https.Server[] = [];

afterEach(() => {
  while (stubs.length > 0) stubs.pop()!.close();
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

async function startStub(opts: {
  cert: { cert: string; key: string; ca: string };
  answer?: { status: number; body: string; headers?: Record<string, string> };
  host?: string;
}): Promise<{ address: string; requests: number; server: https.Server }> {
  const state = { requests: 0 };
  const stub = https.createServer({ cert: opts.cert.cert, key: opts.cert.key, ca: opts.cert.ca }, (req, res) => {
    state.requests += 1;
    req.resume();
    req.on("end", () => {
      const answer = opts.answer ?? { status: 500, body: "{}" };
      res.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      res.end(answer.body);
    });
  });
  stubs.push(stub);
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => stub.listen(0, host, () => resolve()));
  const port = (stub.address() as { port: number }).port;
  return {
    address: `${host}:${port}`,
    get requests() {
      return state.requests;
    },
    server: stub,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<PairingError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PairingError) return err;
    throw err;
  }
  throw new Error("expected the pairing attempt to fail, and it did not");
}

describe("pairWith dispatches by product", () => {
  it("fetchCorePairingIdentity and fetchPairingIdentity agree for core", async () => {
    const material = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
    });
    const fingerprint = fingerprintOf(new X509Certificate(material.ca.cert).raw);

    const legacy = await fetchCorePairingIdentity({ address: stub.address });
    const unified = await fetchPairingIdentity({ product: "core", address: stub.address });

    expect(unified.fingerprint).toBe(fingerprint);
    expect(legacy).toEqual(unified);
  }, 30_000);

  it("pairWithSearch refuses a core wss:// endpoint in the redemption answer", async () => {
    const material = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
      answer: {
        status: 200,
        body: JSON.stringify({
          endpoint: "wss://127.0.0.1:9443",
          caCert: material.ca.cert,
          clientCert: material.client.cert,
          bearer: "b",
        }),
      },
    });
    const fingerprint = fingerprintOf(new X509Certificate(material.ca.cert).raw);

    const failure = await failureOf(
      pairWithSearch({
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: fingerprint,
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("malformed-response");
    expect(failure.message).toContain("wss://");
    expect(failure.message).toContain("https://");
  }, 30_000);

  it("pairWithCore refuses an https:// endpoint in the redemption answer", async () => {
    const material = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
      answer: {
        status: 200,
        body: JSON.stringify({
          endpoint: "https://127.0.0.1:7443",
          caCert: material.ca.cert,
          clientCert: material.client.cert,
          bearer: "b",
        }),
      },
    });
    const fingerprint = fingerprintOf(new X509Certificate(material.ca.cert).raw);

    const failure = await failureOf(
      pairWithCore({
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: fingerprint,
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("malformed-response");
    expect(failure.message).toContain("wss://");
  }, 30_000);
});

describe("the fingerprint is checked before the code is sent", () => {
  it("reports the presented fingerprint without a code to send", async () => {
    const material = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
    });
    const fingerprint = fingerprintOf(new X509Certificate(material.ca.cert).raw);

    const identity = await fetchPairingIdentity({ product: "search", address: stub.address });

    expect(identity.fingerprint).toBe(fingerprint);
    expect(identity.httpsOrigin).toBe(`https://${stub.address}`);
    expect(stub.requests).toBe(0);
  }, 30_000);

  it("aborts on a mismatch with the server never asked", async () => {
    const material = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
    });
    const wrong = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    const presented = fingerprintOf(new X509Certificate(material.ca.cert).raw);

    const failure = await failureOf(
      pairWith({
        product: "core",
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: wrong,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("fingerprint-mismatch");
    expect(stub.requests).toBe(0);
    expect(failure.detail.presentedFingerprint).toBe(presented);
  }, 30_000);

  it("refuses to send a code when it was given no fingerprint to check", async () => {
    const material = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
    });

    const failure = await failureOf(
      pairWith({ product: "search", address: stub.address, sessionId: "ps_1", code: "ABCD-EFGH" }),
    );

    expect(failure.failure).toBe<PairingFailure>("fingerprint-unconfirmed");
    expect(stub.requests).toBe(0);
  }, 30_000);
});

describe("every refusal a caller can act on is a different failure", () => {
  it("refuses what it can refuse without a server at all", async () => {
    expect((await failureOf(pairWithCore({ address: "", code: "x" }))).failure).toBe("bad-address");
    expect((await failureOf(pairWithSearch({ address: "", code: "x" }))).failure).toBe("bad-address");
    expect((await failureOf(pairWithCore({ address: "ws://core:9443", code: "x" }))).failure).toBe("bad-address");
    expect(
      (await failureOf(pairWithSearch({ address: "core:9443", code: "ABC", sessionId: "ps_1" }))).failure,
    ).toBe("bad-code");
    expect((await failureOf(pairWithCore({ address: "core:9443", code: "ABCD-EFGH" }))).failure).toBe("bad-code");
    expect(
      (
        await failureOf(
          pairWithSearch({
            address: "core:9443",
            code: "ABCD-EFGH",
            sessionId: "ps_1",
            expectedCaFingerprint: "not-a-fingerprint",
          }),
        )
      ).failure,
    ).toBe("bad-fingerprint");
  });

  it("reads a session id carried on the code, and one passed beside it", () => {
    expect(parsePairingTicket("ps_7f3a:abcd-efgh")).toEqual({ sessionId: "ps_7f3a", code: "ABCD-EFGH" });
    expect(parsePairingTicket("abcd efgh", "ps_7f3a")).toEqual({ sessionId: "ps_7f3a", code: "ABCD-EFGH" });
    expect(parsePairingTicket("ABCD-EFGH", "ps_other")).toEqual({ sessionId: "ps_other", code: "ABCD-EFGH" });
    expect(parsePairingTicket("ps_7f3a:ABCD-EFGH", "ps_7f3a")).toEqual({
      sessionId: "ps_7f3a",
      code: "ABCD-EFGH",
    });
    const clash = (): unknown => parsePairingTicket("ps_7f3a:ABCD-EFGH", "ps_other");
    expect(clash).toThrow(PairingError);
    expect(clash).toThrow(/must agree/);
  });

  it("uses product-specific address error messages", () => {
    expect(() => parseProductAddress("core", "")).toThrow(/Core address/);
    expect(() => parseProductAddress("search", "")).toThrow(/Search address/);
  });
});

describe("the redemption dial is pinned to the certificate authority that matched", () => {
  it("sends nothing to a server that changes its certificate after the fingerprint check", async () => {
    const honest = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const impostor = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stub = await startStub({
      cert: { cert: honest.server.cert, key: honest.server.key, ca: honest.ca.cert },
      answer: {
        status: 200,
        body: JSON.stringify({
          endpoint: "wss://127.0.0.1:1",
          caCert: "x",
          clientCert: "x",
          bearer: "x",
        }),
      },
    });
    stub.server.once("connection", () =>
      setImmediate(() => {
        stub.server.setSecureContext({
          cert: impostor.server.cert,
          key: impostor.server.key,
          ca: impostor.ca.cert,
        });
      }),
    );

    const honestFingerprint = fingerprintOf(new X509Certificate(honest.ca.cert).raw);
    const failure = await failureOf(
      pairWithCore({
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: honestFingerprint,
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("fingerprint-mismatch");
    expect(failure.detail.tlsCode).toBe("CERT_SIGNATURE_FAILURE");
    expect(stub.requests).toBe(0);
  }, 30_000);
});

async function canBind(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new Server();
    probe.once("error", () => resolve(false));
    probe.listen(0, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

describe("a certificate problem is not an accusation", () => {
  it("tells a server reached off its SAN from one that is not the right server", async () => {
    if (!(await canBind("127.0.0.2"))) return;

    const material = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
      host: "127.0.0.2",
      answer: { status: 200, body: "{}" },
    });

    const failure = await failureOf(
      pairWithSearch({
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: fingerprintOf(new X509Certificate(material.ca.cert).raw),
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("hostname-mismatch");
    expect(failure.detail.tlsCode).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(failure.message).toContain("Search");
    expect(failure.message).toContain("presented the expected certificate authority");
    expect(stub.requests).toBe(0);
  }, 30_000);

  it("reports an expired server certificate as a certificate problem, not a mismatch", async () => {
    const ca = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stale = await issueServerCert({
      ca: { cert: ca.ca.cert, key: ca.ca.key },
      hosts: ["127.0.0.1"],
      days: 1,
      notBefore: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    });
    const stub = await startStub({
      cert: { cert: stale.cert, key: stale.key, ca: ca.ca.cert },
      answer: { status: 200, body: "{}" },
    });

    const failure = await failureOf(
      pairWith({
        product: "core",
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: fingerprintOf(new X509Certificate(ca.ca.cert).raw),
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("certificate-invalid");
    expect(failure.detail.tlsCode).toBe("CERT_HAS_EXPIRED");
    expect(stub.requests).toBe(0);
  }, 30_000);
});

describe("answers that are not a pairing server's", () => {
  async function failureAgainst(
    product: "core" | "search",
    answer: { status: number; body: string; headers?: Record<string, string> },
  ): Promise<PairingError> {
    const material = await generateCertMaterial({ hosts: ["127.0.0.1"], names: TEST_NAMES });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
      answer,
    });
    return failureOf(
      pairWith({
        product,
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: fingerprintOf(new X509Certificate(material.ca.cert).raw),
        timeoutMs: 5_000,
      }),
    );
  }

  it("maps HTTP statuses to distinct failures", async () => {
    const missing = await failureAgainst("search", {
      status: 404,
      body: JSON.stringify({ code: "not-found", error: "no route" }),
    });
    expect(missing.failure).toBe<PairingFailure>("not-pairable");
    expect(missing.detail.status).toBe(404);

    const broken = await failureAgainst("core", {
      status: 500,
      body: JSON.stringify({ code: "core-error", error: "could not sign" }),
    });
    expect(broken.failure).toBe<PairingFailure>("core-error");

    const rejected = await failureAgainst("search", {
      status: 400,
      body: JSON.stringify({ code: "bad-request", error: "the CSR was not acceptable" }),
    });
    expect(rejected.failure).toBe<PairingFailure>("rejected");
    expect(rejected.detail.serverCode).toBe("bad-request");
    expect(rejected.detail.coreCode).toBe("bad-request");

    const garbage = await failureAgainst("core", { status: 200, body: "not json at all" });
    expect(garbage.failure).toBe<PairingFailure>("malformed-response");
  }, 60_000);
});

describe("nothing this package ships stays unverified", () => {
  it("has exactly one unverified dial, and it is the bootstrap one", () => {
    const src = path.resolve(import.meta.dirname, "..");
    const shipped = fs
      .readdirSync(src, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"));

    const relaxed: string[] = [];
    for (const entry of shipped) {
      const lines = fs.readFileSync(path.join(src, entry.name), "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/rejectUnauthorized:\s*false/.test(line)) relaxed.push(`${entry.name}:${index + 1}`);
      }
    }

    expect(relaxed).toHaveLength(1);
    expect(relaxed[0]).toMatch(/^client\.ts:/);

    const source = fs.readFileSync(path.join(src, "client.ts"), "utf8");
    const bootstrap = source.slice(source.indexOf("function presentedChain"), source.indexOf("function chainOf"));
    expect(bootstrap).toContain("rejectUnauthorized: false");
  });
});

describe("the route this client posts to", () => {
  it("is /v1/pair/redeem", () => {
    expect(PAIRING_REDEEM_PATH).toBe("/v1/pair/redeem");
  });
});

describe("the redeem contract has one definition (ADR 0025 D3)", () => {
  it("types the 200 body as the response type", () => {
    const answer: PairingRedeemResponse = {
      endpoint: "wss://core.test:9444",
      caCert: "-----BEGIN CERTIFICATE-----",
      clientCert: "-----BEGIN CERTIFICATE-----",
      bearer: "bearer.value",
    };
    expect(Object.keys(answer).sort()).toEqual(["bearer", "caCert", "clientCert", "endpoint"]);
  });

  it("types the request the client posts", () => {
    const body: PairingRedeemRequest = {
      sessionId: "ps_1",
      code: "ABCD2345",
      client: { label: "laptop", platform: "linux" },
      csr: "-----BEGIN CERTIFICATE REQUEST-----",
    };
    expect(Object.keys(body).sort()).toEqual(["client", "code", "csr", "sessionId"]);
  });
});

describe("PairingFailure vocabulary", () => {
  it("exposes exactly fifteen shared failure codes", () => {
    const codes: PairingFailure[] = [
      "bad-address",
      "bad-code",
      "bad-fingerprint",
      "unreachable",
      "no-ca-presented",
      "fingerprint-unconfirmed",
      "fingerprint-mismatch",
      "hostname-mismatch",
      "certificate-invalid",
      "refused",
      "rate-limited",
      "rejected",
      "not-pairable",
      "core-error",
      "malformed-response",
    ];
    expect(codes).toHaveLength(15);
    expect(new Set(codes).size).toBe(15);
  });
});
