import { describe, it, expect, beforeEach } from "vitest";
import {
  PAIRING_ATTEMPT_CAP,
  createPairingSession,
  type NewPairingSession,
} from "../session.ts";
import type { PairingStore, PairedClient } from "../store-port.ts";

const NOW_MS = 1_700_000_000_000;
const NOW = new Date(NOW_MS);

function mintInput(overrides: Partial<NewPairingSession> = {}): NewPairingSession {
  return {
    id: "ps_1",
    label: "laptop",
    codeHash: "a".repeat(64),
    now: NOW_MS,
    ...overrides,
  };
}

function client(overrides: Partial<PairedClient> = {}): PairedClient {
  return {
    certSerial: "0a1b",
    certSubject: "CN=laptop",
    label: "laptop",
    sessionId: "ps_1",
    pairedAt: NOW_MS,
    certNotAfter: NOW_MS + 365 * 24 * 60 * 60 * 1000,
    revokedAt: null,
    created_by: null,
    tenant_id: null,
    auth_method: null,
    ...overrides,
  };
}

/**
 * One contract suite every `PairingStore` adapter must pass.
 *
 * Call from each adapter's test file with a factory that returns a fresh store.
 */
export function pairingStoreContract(factory: () => PairingStore): void {
  let store: PairingStore;

  beforeEach(() => {
    store = factory();
  });

  describe("createSession", () => {
    it("round-trips through listSessions without the code digest", async () => {
      await store.createSession(mintInput());
      const listed = await store.listSessions();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: "ps_1",
        label: "laptop",
        attempts: 0,
        consumedAt: null,
      });
      expect(listed[0]).not.toHaveProperty("codeHash");
    });
  });

  describe("claimAttempt", () => {
    it("hands back the digest and metadata for a live session", async () => {
      await store.createSession(mintInput());
      const claim = await store.claimAttempt("ps_1", NOW);
      expect(claim).toEqual({
        ok: true,
        codeDigest: Buffer.from("a".repeat(64), "hex"),
        label: "laptop",
        grant: undefined,
      });
      const listed = await store.listSessions();
      expect(listed[0]?.attempts).toBe(1);
    });

    it("refuses an unknown session", async () => {
      expect(await store.claimAttempt("ps_nobody", NOW)).toEqual({ ok: false, reason: "unknown" });
    });

    it("refuses a revoked session", async () => {
      await store.createSession(mintInput());
      await store.revoke({ kind: "session", sessionId: "ps_1", at: NOW_MS });
      expect(await store.claimAttempt("ps_1", NOW)).toEqual({ ok: false, reason: "revoked" });
    });

    it("refuses a consumed session", async () => {
      await store.createSession(mintInput());
      expect(await store.consume("ps_1", NOW)).toBe(true);
      expect(await store.claimAttempt("ps_1", NOW)).toEqual({ ok: false, reason: "consumed" });
    });

    it("refuses an expired session", async () => {
      await store.createSession(mintInput({ ttlMs: 60_000 }));
      const later = new Date(NOW_MS + 60_001);
      expect(await store.claimAttempt("ps_1", later)).toEqual({ ok: false, reason: "expired" });
    });

    it("refuses when the attempt cap is already spent", async () => {
      const session = createPairingSession(mintInput({ attemptCap: 2 }));
      await store.createSession({
        id: session.id,
        label: session.label,
        codeHash: session.codeHash,
        now: session.createdAt,
        attemptCap: session.attemptCap,
      });
      await store.claimAttempt("ps_1", NOW);
      await store.claimAttempt("ps_1", NOW);
      expect(await store.claimAttempt("ps_1", NOW)).toEqual({ ok: false, reason: "exhausted" });
    });

    it("lets only the cap win when many claims race — the store decides", async () => {
      await store.createSession(mintInput());
      const burst = 20;
      const results = await Promise.all(
        Array.from({ length: burst }, () => store.claimAttempt("ps_1", NOW)),
      );
      expect(results.filter((r) => r.ok).length).toBe(PAIRING_ATTEMPT_CAP);
      expect(results.filter((r) => !r.ok && r.reason === "exhausted").length).toBe(
        burst - PAIRING_ATTEMPT_CAP,
      );
      const listed = await store.listSessions();
      expect(listed[0]?.attempts).toBe(PAIRING_ATTEMPT_CAP);
    });
  });

  describe("consume", () => {
    it("spends once and refuses the replay", async () => {
      await store.createSession(mintInput());
      expect(await store.consume("ps_1", NOW)).toBe(true);
      expect(await store.consume("ps_1", NOW)).toBe(false);
      const listed = await store.listSessions();
      expect(listed[0]?.consumedAt).toBe(NOW_MS);
    });

    it("returns false for an unknown session", async () => {
      expect(await store.consume("ps_nobody", NOW)).toBe(false);
    });
  });

  describe("revoke", () => {
    it("cancels a pending session", async () => {
      await store.createSession(mintInput());
      const result = await store.revoke({ kind: "session", sessionId: "ps_1", at: NOW_MS });
      expect(result).toMatchObject({ ok: true, kind: "session" });
      expect(await store.claimAttempt("ps_1", NOW)).toEqual({ ok: false, reason: "revoked" });
    });

    it("revokes a paired client by serial", async () => {
      await store.recordClient(client());
      const result = await store.revoke({ kind: "client", certSerial: "0a1b", at: NOW_MS + 5 });
      expect(result).toMatchObject({
        ok: true,
        kind: "client",
        client: { certSerial: "0a1b", revokedAt: NOW_MS + 5 },
      });
    });

    it("answers not-found for a target this store does not have", async () => {
      expect(await store.revoke({ kind: "session", sessionId: "ps_nope", at: NOW_MS })).toEqual({
        ok: false,
        reason: "not-found",
      });
      expect(await store.revoke({ kind: "client", certSerial: "nope", at: NOW_MS })).toEqual({
        ok: false,
        reason: "not-found",
      });
    });
  });

  describe("listClients", () => {
    it("returns recorded clients newest first", async () => {
      await store.recordClient(client({ certSerial: "aa", pairedAt: NOW_MS }));
      await store.recordClient(client({ certSerial: "bb", pairedAt: NOW_MS + 1 }));
      const listed = await store.listClients();
      expect(listed.map((c) => c.certSerial)).toEqual(["bb", "aa"]);
    });
  });

  describe("revokedSerials", () => {
    it("lists only revoked client serials", async () => {
      await store.recordClient(client({ certSerial: "live" }));
      await store.recordClient(client({ certSerial: "gone" }));
      await store.revoke({ kind: "client", certSerial: "gone", at: NOW_MS });
      const serials = await store.revokedSerials();
      expect(serials.has("gone")).toBe(true);
      expect(serials.has("live")).toBe(false);
    });
  });
}
