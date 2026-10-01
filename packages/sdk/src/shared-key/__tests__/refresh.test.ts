import { describe, expect, it } from "vitest";
import {
  createSharedKeyProvider,
  refreshAtMs,
  SHARED_KEY_LIFETIME_SECONDS,
  SHARED_KEY_REFRESH_MARGIN_SECONDS,
  type SharedKey,
  type SharedKeyIssuer,
} from "../index.ts";

const MIN = 60_000;

function fakeIssuer(clock: { t: number }, lifeMs = SHARED_KEY_LIFETIME_SECONDS * 1000) {
  const calls: string[] = [];
  const issuer: SharedKeyIssuer = {
    async issue(coreId): Promise<SharedKey> {
      calls.push(coreId);
      return {
        accessKeyId: `AK${calls.length}`,
        secretAccessKey: "s",
        sessionToken: "t",
        expiresAt: new Date(clock.t + lifeMs),
      };
    },
  };
  return { issuer, calls };
}

describe("constants", () => {
  it("a key lives one hour and is refreshed 15 minutes early", () => {
    expect(SHARED_KEY_LIFETIME_SECONDS).toBe(3600);
    expect(SHARED_KEY_REFRESH_MARGIN_SECONDS).toBe(900);
  });
});

describe("refreshAtMs", () => {
  it("is 15 minutes before expiry for a 1-hour key", () => {
    expect(refreshAtMs({ expiresAt: new Date(60 * MIN) }, 0)).toBe(45 * MIN);
  });

  it("never lets the margin exceed half the key's life", () => {
    // A 20-minute key: 15 minutes early would be 5 minutes in; half its life is 10.
    expect(refreshAtMs({ expiresAt: new Date(20 * MIN) }, 0)).toBe(10 * MIN);
  });

  it("an already expired key is due at once", () => {
    expect(refreshAtMs({ expiresAt: new Date(0) }, 5 * MIN)).toBe(0);
  });
});

describe("createSharedKeyProvider", () => {
  it("reuses the key until 15 minutes before it expires, then issues a new one", async () => {
    const clock = { t: 1_000_000 };
    const { issuer, calls } = fakeIssuer(clock);
    const provider = createSharedKeyProvider({ issuer, coreId: "core-a", now: () => clock.t });

    expect((await provider.get()).accessKeyId).toBe("AK1");
    clock.t += 44 * MIN + 59_000;
    expect((await provider.get()).accessKeyId).toBe("AK1");
    expect(calls).toEqual(["core-a"]);

    clock.t += 1_000; // 45:00 into a 60:00 key
    expect((await provider.get()).accessKeyId).toBe("AK2");
    expect(calls).toHaveLength(2);
  });

  it("refreshes at half-life when the issued key is shorter than 30 minutes", async () => {
    const clock = { t: 0 };
    const { issuer } = fakeIssuer(clock, 20 * MIN);
    const provider = createSharedKeyProvider({ issuer, coreId: "core-a", now: () => clock.t });
    await provider.get();
    clock.t = 10 * MIN - 1;
    expect((await provider.get()).accessKeyId).toBe("AK1");
    clock.t = 10 * MIN;
    expect((await provider.get()).accessKeyId).toBe("AK2");
  });

  it("shares one issue call between concurrent callers", async () => {
    const clock = { t: 0 };
    const { issuer, calls } = fakeIssuer(clock);
    const provider = createSharedKeyProvider({ issuer, coreId: "core-a", now: () => clock.t });
    const keys = await Promise.all([provider.get(), provider.get(), provider.get()]);
    expect(calls).toHaveLength(1);
    expect(new Set(keys.map((k) => k.accessKeyId)).size).toBe(1);
  });

  it("keeps serving the old key when an early refresh fails, and throws once it has expired", async () => {
    const clock = { t: 0 };
    let fail = false;
    const issuer: SharedKeyIssuer = {
      async issue() {
        if (fail) throw new Error("STS down");
        return { accessKeyId: "AK1", secretAccessKey: "s", sessionToken: "t", expiresAt: new Date(60 * MIN) };
      },
    };
    const provider = createSharedKeyProvider({ issuer, coreId: "core-a", now: () => clock.t });
    await provider.get();
    fail = true;
    clock.t = 50 * MIN;
    expect((await provider.get()).accessKeyId).toBe("AK1");
    clock.t = 60 * MIN;
    await expect(provider.get()).rejects.toThrow("STS down");
  });

  it("does not cache a failure", async () => {
    const clock = { t: 0 };
    let fail = true;
    const issuer: SharedKeyIssuer = {
      async issue() {
        if (fail) throw new Error("boom");
        return { accessKeyId: "AK1", secretAccessKey: "s", sessionToken: "t", expiresAt: new Date(60 * MIN) };
      },
    };
    const provider = createSharedKeyProvider({ issuer, coreId: "core-a", now: () => clock.t });
    await expect(provider.get()).rejects.toThrow("boom");
    fail = false;
    expect((await provider.get()).accessKeyId).toBe("AK1");
  });
});
