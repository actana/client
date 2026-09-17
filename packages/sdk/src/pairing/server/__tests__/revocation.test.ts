// What a revoked pairing means to a running server (#283).
//
// `pair revoke` runs in another process and can only stamp a row. These tests
// are about the half that makes the stamp mean something: the set the gates
// consult, and the sweep that notices a stamp arriving under a server that is
// already running.
import { describe, expect, it, vi } from "vitest";
import {
  PairingRevocations,
  REVOCATION_SWEEP_MS,
  certSerialFromBearerSubject,
  normaliseCertSerial,
  pairingBearerSubject,
  startPairingRevocationSweep,
  type RevocationStorePort,
} from "../revocation.js";
import { createMemoryPairingStore } from "../../stores/memory.js";
import type { PairedClient } from "../../store-port.js";

const NOW = 1_700_000_000_000;

function client(over: Partial<PairedClient> = {}): PairedClient {
  return {
    certSerial: "0a1b2c",
    certSubject: "CN=laptop",
    label: "laptop",
    sessionId: "ps_1",
    pairedAt: NOW,
    certNotAfter: NOW + 1,
    revokedAt: null,
    created_by: null,
    tenant_id: null,
    auth_method: null,
    ...over,
  };
}

/**
 * A store double, so a test can revoke a row between two reads.
 *
 * `revokedSerials` throws when `broken` is set — the fail-closed seam the
 * real adapters enforce strictly.
 */
function fakeRevocationStore(initial: string[] = []) {
  const revoked = new Set(initial);
  let broken = false;
  const port: RevocationStorePort = {
    revokedSerials: async () => {
      if (broken) throw new Error("pairing store is not readable");
      return new Set(revoked);
    },
  };
  return {
    port,
    revoke(serial: string) {
      revoked.add(serial);
    },
    breakStore() {
      broken = true;
    },
    fixStore() {
      broken = false;
    },
  };
}

describe("the bearer subject a pairing speaks for", () => {
  it("round-trips", () => {
    expect(certSerialFromBearerSubject(pairingBearerSubject("0a1b"))).toBe("0a1b");
  });

  it("reads a bearer with no pairing subject as naming no pairing", () => {
    expect(certSerialFromBearerSubject(undefined)).toBe(null);
    expect(certSerialFromBearerSubject("something-else")).toBe(null);
    expect(certSerialFromBearerSubject("pair:")).toBe(null);
  });
});

describe("one spelling of a serial", () => {
  it("folds case, separators and leading zeros", () => {
    expect(normaliseCertSerial("0a:1b:2c")).toBe("A1B2C");
    expect(normaliseCertSerial("0A1B2C")).toBe("A1B2C");
    expect(normaliseCertSerial("00a1b2c")).toBe("A1B2C");
  });

  it("does not fold a serial away to nothing", () => {
    expect(normaliseCertSerial("00")).toBe("0");
  });
});

describe("the revoked set", () => {
  it("is empty until something is revoked", async () => {
    const revocations = new PairingRevocations(fakeRevocationStore().port);
    expect(await revocations.refresh()).toEqual({ ok: true, revoked: [] });
    expect(revocations.isRevoked("0a1b2c")).toBe(false);
    expect(revocations.isFailClosed()).toBe(false);
  });

  it("holds a serial once its row is stamped", async () => {
    const store = fakeRevocationStore(["0a1b2c"]);
    const revocations = new PairingRevocations(store.port);
    expect(await revocations.refresh()).toEqual({ ok: true, revoked: ["0a1b2c"] });
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
  });

  it("matches however the serial is spelled", async () => {
    const revocations = new PairingRevocations(fakeRevocationStore(["0a1b2c"]).port);
    await revocations.refresh();
    expect(revocations.isRevoked("0A1B2C")).toBe(true);
    expect(revocations.isRevoked("A1B2C")).toBe(true);
  });

  it("reports each serial once, so a sweep acts on it once", async () => {
    const store = fakeRevocationStore(["0a1b2c"]);
    const revocations = new PairingRevocations(store.port);
    expect(await revocations.refresh()).toEqual({ ok: true, revoked: ["0a1b2c"] });
    expect(await revocations.refresh()).toEqual({ ok: true, revoked: [] });
  });

  it("finds a pairing revoked through its bearer's subject", async () => {
    const revocations = new PairingRevocations(fakeRevocationStore(["0a1b2c"]).port);
    await revocations.refresh();
    expect(revocations.isBearerSubjectRevoked(pairingBearerSubject("0a1b2c"))).toBe(true);
    expect(revocations.isBearerSubjectRevoked(pairingBearerSubject("ffff"))).toBe(false);
    expect(revocations.isBearerSubjectRevoked(undefined)).toBe(false);
  });

  it("revokes everything when the store cannot be read", async () => {
    const store = fakeRevocationStore(["0a1b2c"]);
    const revocations = new PairingRevocations(store.port);
    await revocations.refresh();
    expect(revocations.isRevoked("never-seen-before")).toBe(false);

    store.breakStore();
    expect(await revocations.refresh()).toEqual({
      ok: false,
      error: expect.stringContaining("not readable"),
    });
    expect(revocations.isFailClosed()).toBe(true);
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
    expect(revocations.isRevoked("never-seen-before")).toBe(true);
    expect(revocations.isBearerSubjectRevoked(pairingBearerSubject("never-seen-before"))).toBe(true);
  });

  it("fails closed at boot, where there is no last time to fall back on", async () => {
    const revocations = new PairingRevocations({
      revokedSerials: async () => {
        throw new Error("pairing store is not readable");
      },
    });
    await revocations.refresh();
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
  });

  it("stops failing closed once the store is readable again", async () => {
    const store = fakeRevocationStore();
    const revocations = new PairingRevocations(store.port);
    store.breakStore();
    await revocations.refresh();
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
    store.fixStore();
    expect(await revocations.refresh()).toEqual({ ok: true, revoked: [] });
    expect(revocations.isFailClosed()).toBe(false);
    expect(revocations.isRevoked("0a1b2c")).toBe(false);
  });

  it("leaves a bearer that names no pairing alone, even while failing closed", async () => {
    const revocations = new PairingRevocations({
      revokedSerials: async () => {
        throw new Error("unreadable");
      },
    });
    await revocations.refresh();
    expect(revocations.isBearerSubjectRevoked(undefined)).toBe(false);
    expect(revocations.isBearerSubjectRevoked("something-else")).toBe(false);
    expect(revocations.isRevoked(null)).toBe(false);
  });

  it("says nothing about a connection with no certificate at all", async () => {
    const revocations = new PairingRevocations(fakeRevocationStore(["0a1b2c"]).port);
    await revocations.refresh();
    expect(revocations.isRevoked(null)).toBe(false);
    expect(revocations.isRevoked("")).toBe(false);
  });

  it("reads an empty in-memory store as nobody-revoked", async () => {
    const store = createMemoryPairingStore();
    const revocations = new PairingRevocations(store);
    expect(await revocations.refresh()).toEqual({ ok: true, revoked: [] });
    expect(revocations.isRevoked("0a1b2c")).toBe(false);
  });

  it("tracks a revocation through the in-memory store port", async () => {
    const store = createMemoryPairingStore();
    await store.recordClient(client());
    await store.revoke({ kind: "client", certSerial: "0a1b2c", at: NOW });
    const revocations = new PairingRevocations(store);
    expect(await revocations.refresh()).toEqual({ ok: true, revoked: ["0a1b2c"] });
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
  });
});

describe("the sweep", () => {
  it("seeds the set at boot without reporting anything to close", async () => {
    vi.useFakeTimers();
    try {
      const revocations = new PairingRevocations(fakeRevocationStore(["0a1b2c"]).port);
      let closes = 0;
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) });
      await vi.advanceTimersByTimeAsync(0);
      expect(closes).toBe(0);
      expect(revocations.isRevoked("0a1b2c")).toBe(true);
      await vi.advanceTimersByTimeAsync(REVOCATION_SWEEP_MS * 3);
      expect(closes).toBe(0);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a revocation that lands under a running server", async () => {
    vi.useFakeTimers();
    try {
      const store = fakeRevocationStore();
      const revocations = new PairingRevocations(store.port);
      let closes = 0;
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) });
      await vi.advanceTimersByTimeAsync(0);

      store.revoke("0a1b2c");

      await vi.advanceTimersByTimeAsync(REVOCATION_SWEEP_MS);
      expect(closes).toBe(1);
      await vi.advanceTimersByTimeAsync(REVOCATION_SWEEP_MS * 3);
      expect(closes).toBe(1);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls back when the store becomes unreadable, and only on the crossing", async () => {
    vi.useFakeTimers();
    try {
      const store = fakeRevocationStore();
      let closes = 0;
      const revocations = new PairingRevocations(store.port);
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) });
      await vi.advanceTimersByTimeAsync(REVOCATION_SWEEP_MS);
      expect(closes).toBe(0);

      store.breakStore();
      await vi.advanceTimersByTimeAsync(REVOCATION_SWEEP_MS);
      expect(closes).toBe(1);
      await vi.advanceTimersByTimeAsync(REVOCATION_SWEEP_MS * 3);
      expect(closes).toBe(1);

      store.fixStore();
      await vi.advanceTimersByTimeAsync(REVOCATION_SWEEP_MS);
      expect(closes).toBe(1);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds fail-closed at boot before the first request is served", async () => {
    vi.useFakeTimers();
    try {
      const revocations = new PairingRevocations({
        revokedSerials: async () => {
          throw new Error("unreadable");
        },
      });
      let closes = 0;
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) });
      await vi.advanceTimersByTimeAsync(0);
      expect(revocations.isFailClosed()).toBe(true);
      expect(closes).toBe(0);
      await vi.advanceTimersByTimeAsync(REVOCATION_SWEEP_MS * 3);
      expect(closes).toBe(0);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the server does", async () => {
    vi.useFakeTimers();
    try {
      const store = fakeRevocationStore();
      const revocations = new PairingRevocations(store.port);
      let closes = 0;
      startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) }).stop();
      store.revoke("0a1b2c");
      await vi.advanceTimersByTimeAsync(REVOCATION_SWEEP_MS * 5);
      expect(closes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stack ticks while the store is slow", async () => {
    vi.useFakeTimers();
    try {
      let concurrent = 0;
      let maxConcurrent = 0;
      const slowMs = 500;
      const revocations = new PairingRevocations({
        revokedSerials: async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, slowMs);
          });
          concurrent -= 1;
          return new Set<string>();
        },
      });
      const sweep = startPairingRevocationSweep({
        revocations,
        onRevoked: () => {},
        intervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(slowMs);
      expect(maxConcurrent).toBe(1);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires onRevoked at compile time", () => {
    const revocations = new PairingRevocations(fakeRevocationStore().port);
    // @ts-expect-error onRevoked is required
    startPairingRevocationSweep({ revocations });
    expect(true).toBe(true);
  });
});
