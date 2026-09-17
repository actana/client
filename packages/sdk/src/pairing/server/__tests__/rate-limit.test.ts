// The defence the per-session attempt cap cannot provide (#280, #282).
//
// A session dies after five wrong codes. That bounds guessing inside one
// session and nothing else: an attacker who can open the endpoint at will gets
// five fresh guesses for every session an operator ever opens, as fast as they
// can send them. These tests pin the two windows that close that gap, and the
// memory bound that keeps the closing of it from being its own attack.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_WINDOW,
  DEFAULT_PEER_WINDOW,
  EVICTION_BATCH,
  MAX_TRACKED_PEERS,
  PairingRateLimiter,
} from "../rate-limit.ts";

function limiterAt(clock: { now: number }, opts: ConstructorParameters<typeof PairingRateLimiter>[0] = {}) {
  return new PairingRateLimiter({ ...opts, now: () => clock.now });
}

describe("the per-peer window", () => {
  it("allows up to the limit and refuses the next", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 3, windowMs: 60_000 } });

    const verdicts = [1, 2, 3, 4].map(() => limiter.check("10.0.0.1"));

    expect(verdicts.map((v) => v.ok)).toEqual([true, true, true, false]);
    expect(verdicts[3]).toMatchObject({ ok: false, scope: "peer" });
  });

  it("does not count a refusal against the caller a second time", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 2, windowMs: 60_000 } });

    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");
    clock.now += 60_001;

    expect(limiter.check("10.0.0.1").ok).toBe(true);
  });

  it("keeps one peer's spending off another peer's budget", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 2, windowMs: 60_000 } });

    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");

    expect(limiter.check("10.0.0.1").ok).toBe(false);
    expect(limiter.check("10.0.0.2").ok).toBe(true);
  });

  it("lets the window slide off", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 1, windowMs: 60_000 } });

    expect(limiter.check("10.0.0.1").ok).toBe(true);
    expect(limiter.check("10.0.0.1").ok).toBe(false);
    clock.now += 60_001;
    expect(limiter.check("10.0.0.1").ok).toBe(true);
  });

  it("says how long to wait", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 1, windowMs: 60_000 } });

    limiter.check("10.0.0.1");
    clock.now += 10_000;
    const refused = limiter.check("10.0.0.1");

    expect(refused).toMatchObject({ ok: false, retryAfterMs: 50_000 });
  });
});

describe("the global window", () => {
  it("stops a spray spread across many addresses", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, {
      peer: { limit: 10, windowMs: 60_000 },
      global: { limit: 5, windowMs: 60_000 },
    });

    const verdicts = Array.from({ length: 6 }, (_, i) => limiter.check(`10.0.0.${i}`));

    expect(verdicts.slice(0, 5).every((v) => v.ok)).toBe(true);
    expect(verdicts[5]).toMatchObject({ ok: false, scope: "global" });
  });

  it("names the peer limit rather than the global one when both would refuse", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, {
      peer: { limit: 1, windowMs: 60_000 },
      global: { limit: 1, windowMs: 60_000 },
    });

    limiter.check("10.0.0.1");

    expect(limiter.check("10.0.0.1")).toMatchObject({ ok: false, scope: "peer" });
  });
});

describe("the memory bound", () => {
  const sprayer = (i: number): string => `10.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`;

  function saturateGlobalWindow(limiter: PairingRateLimiter): void {
    const perPeer = DEFAULT_PEER_WINDOW.limit;
    const peers = Math.ceil(DEFAULT_GLOBAL_WINDOW.limit / perPeer);
    for (let peer = 0; peer < peers; peer += 1) {
      for (let hit = 0; hit < perPeer; hit += 1) limiter.check(`192.168.0.${peer}`);
    }
  }

  it("forgets the quietest peers on the path that admits them", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, {
      peer: { limit: 1, windowMs: 1_000 },
      global: DEFAULT_GLOBAL_WINDOW,
    });

    for (let i = 0; i < MAX_TRACKED_PEERS + EVICTION_BATCH + 50; i += 1) {
      expect(limiter.check(sprayer(i)).ok).toBe(true);
      clock.now += 2_000;
    }

    expect(limiter.trackedPeers()).toBeLessThanOrEqual(MAX_TRACKED_PEERS);
  });

  it("holds the bound once the global window is saturated, which is the attacker's branch", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: DEFAULT_PEER_WINDOW, global: DEFAULT_GLOBAL_WINDOW });
    saturateGlobalWindow(limiter);
    const trackedBeforeTheSpray = limiter.trackedPeers();

    const scopes = new Set<string>();
    for (let i = 0; i < MAX_TRACKED_PEERS * 2; i += 1) {
      const verdict = limiter.check(sprayer(i));
      if (!verdict.ok) scopes.add(verdict.scope);
    }

    expect([...scopes]).toEqual(["global"]);
    expect(limiter.trackedPeers()).toBeLessThanOrEqual(MAX_TRACKED_PEERS);
    expect(limiter.trackedPeers()).toBe(trackedBeforeTheSpray);
  });

  it("leaves nothing behind for a caller it refused globally", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: DEFAULT_PEER_WINDOW, global: DEFAULT_GLOBAL_WINDOW });
    saturateGlobalWindow(limiter);

    expect(limiter.check("203.0.113.7")).toMatchObject({ ok: false, scope: "global" });

    expect(limiter.peerAttempts("203.0.113.7")).toBe(0);
    clock.now += DEFAULT_GLOBAL_WINDOW.windowMs + 1;
    expect(limiter.check("203.0.113.7").ok).toBe(true);
  });

  it("does not record a caller the peer window refuses without ever having admitted", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 0, windowMs: 60_000 }, global: DEFAULT_GLOBAL_WINDOW });

    expect(limiter.check("203.0.113.9")).toMatchObject({ ok: false, scope: "peer" });

    expect(limiter.trackedPeers()).toBe(0);
  });

  it("still prunes a tracked caller's window when it refuses them", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 2, windowMs: 60_000 }, global: DEFAULT_GLOBAL_WINDOW });
    limiter.check("203.0.113.11");
    clock.now += 30_000;
    limiter.check("203.0.113.11");

    expect(limiter.check("203.0.113.11")).toMatchObject({ ok: false, scope: "peer" });

    clock.now += 30_001;
    expect(limiter.peerAttempts("203.0.113.11")).toBe(1);
  });
});
