// `matchRing`, the "last n matches" the `events tail --kind … --limit n` walk holds (client issue 11,
// ported from Control's events-command.ts, actana/control #403).

import { describe, it, expect } from "vitest";
import type { CoreLinkEvent } from "@actana/sdk/core";
import { matchRing } from "../core/events-command.ts";

const ev = (eventId: number) => ({ eventId, kind: "k", ts: 0, ptyId: null, payload: "{}" }) as CoreLinkEvent;
const ids = (events: CoreLinkEvent[]) => events.map((e) => e.eventId);

describe("matchRing", () => {
  it("hands back what it holds, oldest first, while it is not full", () => {
    const ring = matchRing(3);
    ring.add(ev(1));
    ring.add(ev(2));
    expect(ids(ring.drain())).toEqual([1, 2]);
  });

  it("keeps only the newest `capacity`, in order, once it wraps", () => {
    const ring = matchRing(3);
    for (let i = 1; i <= 8; i += 1) ring.add(ev(i));
    expect(ids(ring.drain())).toEqual([6, 7, 8]);
  });

  it("is exactly full without having wrapped", () => {
    const ring = matchRing(3);
    for (let i = 1; i <= 3; i += 1) ring.add(ev(i));
    expect(ids(ring.drain())).toEqual([1, 2, 3]);
  });

  it("is emptied by drain, so the same event cannot be handed over twice", () => {
    const ring = matchRing(2);
    for (let i = 1; i <= 5; i += 1) ring.add(ev(i));
    expect(ids(ring.drain())).toEqual([4, 5]);
    expect(ring.drain()).toEqual([]);
    // And it starts over cleanly: no stale write index from the first fill.
    ring.add(ev(9));
    ring.add(ev(10));
    ring.add(ev(11));
    expect(ids(ring.drain())).toEqual([10, 11]);
  });

  it("holds no more than `capacity`, however long the log is", () => {
    const ring = matchRing(5);
    for (let i = 1; i <= 100_000; i += 1) ring.add(ev(i));
    expect(ids(ring.drain())).toEqual([99_996, 99_997, 99_998, 99_999, 100_000]);
  });
});
