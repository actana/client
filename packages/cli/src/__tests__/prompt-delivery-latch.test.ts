// The prompt-delivery latch, and the gateway verbs around it (client issue 11).
//
// Ported in substance from Control's `in-process-core-session.test.ts` at origin/feat/0.5.0
// (#395, #483, #494, #495). Control runs those against a real `PtyCoreLinkServer`; that server is
// the Core's own code and does not live in this repository, so they run here against a fake
// `CoreClient` that stages the same frames in the same order: the replay marker, the live rows, the
// exit and the disconnect. What each case proves is the latch's judgement, not the wire.

import { describe, it, expect } from "vitest";
import type { CoreClient, CoreLinkEvent } from "@actana/sdk/core";
import {
  SESSION_PROMPT_ABANDONED_EVENT_KIND,
  SESSION_PROMPT_DELIVERED_EVENT_KIND,
} from "@actana/sdk/core";
import { openPromptDeliveryLatch, sessionGatewayFor } from "../core/session-gateway.ts";

type Handler<T> = (value: T) => void;

/** The slice of `CoreClient` the latch listens on, with the means to speak as the Core. */
function fakeLink(opts: { alreadySubscribed?: boolean } = {}) {
  const events: Array<Handler<{ event: CoreLinkEvent }>> = [];
  const replayed: Array<Handler<{ lastEventId: number; tipEventId?: number }>> = [];
  const down: Array<Handler<{ error?: string }>> = [];
  const exits: Array<Handler<{ ptyId: string }>> = [];
  const calls: string[] = [];
  let subscribed = opts.alreadySubscribed === true;
  const on = <T>(list: Array<Handler<T>>, name: string) => (cb: Handler<T>) => {
    calls.push(`on:${name}`);
    list.push(cb);
    return () => {
      const at = list.indexOf(cb);
      if (at >= 0) list.splice(at, 1);
    };
  };
  const client = {
    onEvent: on(events, "event"),
    onEventsReplayed: on(replayed, "replayed"),
    onDisconnected: on(down, "disconnected"),
    onExit: on(exits, "exit"),
    isSubscribedToEvents: () => subscribed,
    subscribeEvents: () => {
      calls.push("subscribeEvents");
      subscribed = true;
      return true;
    },
  } as unknown as CoreClient;
  return {
    client,
    calls,
    listeners: () => events.length + replayed.length + down.length + exits.length,
    replay: (tipEventId: number | undefined) =>
      replayed.slice().forEach((cb) => cb({ lastEventId: tipEventId ?? 0, tipEventId })),
    event: (e: Partial<CoreLinkEvent> & { eventId: number; kind: string }) =>
      events.slice().forEach((cb) =>
        cb({
          event: { ts: 0, ptyId: null, sessionId: "s1", payload: "{}", ...e } as CoreLinkEvent,
        }),
      ),
    exit: (ptyId: string) => exits.slice().forEach((cb) => cb({ ptyId })),
    disconnect: (error?: string) => down.slice().forEach((cb) => cb(error === undefined ? {} : { error })),
  };
}

const delivered = (eventId: number, composerObserved = true, sessionId = "s1") => ({
  eventId,
  sessionId,
  kind: SESSION_PROMPT_DELIVERED_EVENT_KIND,
  payload: JSON.stringify({ sessionId, ptyId: "p1", composerObserved }),
});
const abandoned = (eventId: number, reason = "no composer", sessionId = "s1") => ({
  eventId,
  sessionId,
  kind: SESSION_PROMPT_ABANDONED_EVENT_KIND,
  payload: JSON.stringify({ sessionId, ptyId: "p1", reason }),
});

const arm = (latch: ReturnType<typeof openPromptDeliveryLatch>) =>
  latch.arm({ sessionId: "s1", ptyId: "p1", afterEventId: 0 });

describe("openPromptDeliveryLatch", () => {
  it("subscribes itself, after it is listening, so the replay marker is its own", () => {
    const link = fakeLink();
    openPromptDeliveryLatch(link.client);
    expect(link.calls.indexOf("subscribeEvents")).toBeGreaterThan(link.calls.lastIndexOf("on:event"));
    expect(link.calls.filter((c) => c === "subscribeEvents")).toHaveLength(1);
  });

  it("reports delivered on the Core's own row, and nothing before it", async () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(10);
    expect(latch.current()).toBeNull();
    link.event(delivered(11));
    expect(latch.current()).toEqual({ outcome: "delivered" });
    await expect(latch.settled()).resolves.toEqual({ outcome: "delivered" });
  });

  it("reports abandoned with the Core's reason, and keeps answering reason()", async () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(10);
    link.event(abandoned(11, "opencode composer never appeared"));
    await expect(latch.settled()).resolves.toEqual({
      outcome: "abandoned",
      reason: "opencode composer never appeared",
    });
    expect(latch.reason()).toEqual({ reason: "opencode composer never appeared" });
  });

  it("holds a row that lands inside the deaf window and judges it once armed", async () => {
    // The row arrives before the Session id is known (the spawn round trip): dropped, it would
    // leave `--await-prompt` waiting for ever on a prompt that was lost in a second.
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    link.replay(10);
    link.event(abandoned(11, "blocked by folder-trust"));
    expect(latch.current()).toBeNull();
    arm(latch);
    expect(latch.current()).toEqual({ outcome: "abandoned", reason: "blocked by folder-trust" });
  });

  it("holds rows until the replay marker says where history ends", () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.event(delivered(11));
    expect(latch.current()).toBeNull();
    link.replay(10);
    expect(latch.current()).toEqual({ outcome: "delivered" });
  });

  it("does not read a previous start's rows as this start's verdict", () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(500);
    // Replayed history, in either direction — both are at or below the tip.
    link.event(abandoned(300, "last Tuesday"));
    link.event(delivered(400));
    // And the tip itself: the floor is exclusive, so the last row that existed is still history.
    link.event(delivered(500));
    expect(latch.current()).toBeNull();
    link.event(delivered(501));
    expect(latch.current()).toEqual({ outcome: "delivered" });
  });

  it("does not answer from history that arrives as live frames behind a capped replay", () => {
    // The Core caps the replayed tail, so older rows can come through as ordinary events. The floor
    // is the log's tip, not the last row it sent.
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(5000);
    link.event(delivered(1200));
    link.event(abandoned(1300));
    expect(latch.current()).toBeNull();
  });

  it("ignores rows about another Session", () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(1);
    link.event(delivered(2, true, "someone-else"));
    expect(latch.current()).toBeNull();
  });

  it("does not call a prompt typed with no composer in sight a delivery", () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(1);
    link.event(delivered(2, false));
    expect(latch.current()).toMatchObject({ outcome: "unverified" });
  });

  it("fails closed on a delivered row it cannot parse", () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(1);
    link.event({ eventId: 2, kind: SESSION_PROMPT_DELIVERED_EVENT_KIND, payload: "not json" });
    expect(latch.current()).toMatchObject({ outcome: "unverified" });
  });

  it("still counts an unparseable abandon row as the Core giving up", () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(1);
    link.event({ eventId: 2, kind: SESSION_PROMPT_ABANDONED_EVENT_KIND, payload: "{" });
    expect(latch.current()).toEqual({ outcome: "abandoned", reason: "" });
  });

  it("stops waiting when its own harness exits, rather than for ever", async () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(1);
    link.exit("some-other-pty");
    expect(latch.current()).toBeNull();
    link.exit("p1");
    await expect(latch.settled()).resolves.toMatchObject({
      outcome: "unavailable",
      reason: expect.stringContaining("harness exited"),
    });
  });

  it("holds an exit that arrives before it knows which PTY is its own", () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    link.replay(1);
    link.exit("p1");
    expect(latch.current()).toBeNull();
    arm(latch);
    expect(latch.current()).toMatchObject({ outcome: "unavailable" });
  });

  it("hears why the harness died before it hears that it died", () => {
    // The reason row is flushed ahead of the exit; the Core's verdict is the better answer and the
    // exit must not shadow it.
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(1);
    link.event(abandoned(2, "the harness exited before the prompt was delivered"));
    link.exit("p1");
    expect(latch.current()).toMatchObject({ outcome: "abandoned" });
  });

  it("keeps reason() on an abandon row that arrives after the link already dropped", () => {
    // `report` is whatever spoke first; `reason()` is the Core saying it gave up, and a dropped
    // link must not turn it into a weaker claim.
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(1);
    link.disconnect("socket closed");
    expect(latch.current()).toMatchObject({ outcome: "unavailable" });
    link.event(abandoned(2, "late"));
    expect(latch.reason()).toEqual({ reason: "late" });
    expect(latch.current()).toMatchObject({ outcome: "unavailable" });
  });

  it("says the connection went down, as unavailable and never as a lost prompt", async () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(1);
    link.disconnect("ECONNRESET");
    const report = await latch.settled();
    expect(report).toEqual({
      outcome: "unavailable",
      reason: "the connection to the Core went down (ECONNRESET)",
    });
    expect(latch.reason()).toBeNull();
  });

  it("refuses rather than waits on a Core that cannot say where its log ends", async () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(undefined);
    await expect(latch.settled()).resolves.toMatchObject({
      outcome: "unavailable",
      reason: expect.stringContaining("does not report where its event log ends"),
    });
  });

  it("says so, at once, when it was handed a client that was already subscribed", async () => {
    const link = fakeLink({ alreadySubscribed: true });
    const latch = openPromptDeliveryLatch(link.client);
    expect(link.calls).not.toContain("subscribeEvents");
    await expect(latch.settled()).resolves.toMatchObject({
      outcome: "unavailable",
      reason: expect.stringContaining("already subscribed"),
    });
  });

  it("takes only the first verdict", () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    arm(latch);
    link.replay(1);
    link.event(delivered(2));
    link.event(abandoned(3));
    link.disconnect();
    expect(latch.current()).toEqual({ outcome: "delivered" });
  });

  it("close() releases every listener and answers anyone still waiting", async () => {
    const link = fakeLink();
    const latch = openPromptDeliveryLatch(link.client);
    const waiting = latch.settled();
    expect(link.listeners()).toBe(4);
    latch.close();
    expect(link.listeners()).toBe(0);
    await expect(waiting).resolves.toMatchObject({ outcome: "unavailable" });
  });
});

describe("the session gateway", () => {
  it("send answers SendResult: ok, text refused, and the return refused after the text landed", async () => {
    const writes: string[] = [];
    const clientWith = (accept: (data: string) => boolean) =>
      ({
        findBySession: async () => ({ ptyId: "p1" }),
        write: async (_pty: string, data: string) => {
          writes.push(data);
          return accept(data);
        },
      }) as unknown as CoreClient;

    expect(await sessionGatewayFor(clientWith(() => true)).send("s1", "hi", { enter: true })).toEqual({
      ok: true,
    });
    expect(writes).toEqual(["hi", "\r"]);

    writes.length = 0;
    expect(await sessionGatewayFor(clientWith(() => false)).send("s1", "hi", { enter: true })).toEqual({
      ok: false,
      failed: "text",
    });
    expect(writes).toEqual(["hi"]);

    writes.length = 0;
    expect(await sessionGatewayFor(clientWith((d) => d !== "\r")).send("s1", "hi", { enter: true })).toEqual({
      ok: false,
      failed: "carriage-return",
    });
    expect(writes).toEqual(["hi", "\r"]);

    // Text only: the return is not written, and its absence is not a failure.
    writes.length = 0;
    expect(await sessionGatewayFor(clientWith(() => true)).send("s1", "hi")).toEqual({ ok: true });
    expect(writes).toEqual(["hi"]);
  });

  it("opens the latch before it asks the Core anything, and closes it when a start is refused", async () => {
    // The fake has no spawn path at all, so `CoreSession.start` fails on its first question — which
    // is the point: by then the latch has already subscribed, and the failure must not leave its
    // four listeners on a connection the command is finished with.
    const link = fakeLink();
    const started = sessionGatewayFor(link.client).start({
      prompt: "go",
      harness: null,
      dangerouslySkipPermissions: false,
    });
    await expect(started).rejects.toMatchObject({ name: "SessionGatewayError", kind: "refused" });
    expect(link.calls.filter((c) => c === "subscribeEvents")).toHaveLength(1);
    // The latch was listening on all four frames before the subscribe went out, and the refused
    // start released them again.
    expect(link.calls.slice(0, 5)).toEqual([
      "on:event",
      "on:replayed",
      "on:disconnected",
      "on:exit",
      "subscribeEvents",
    ]);
    expect(link.listeners()).toBe(0);
  });
});
