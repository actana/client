// The factory behind `actana shared` (client #7, #8): the through-the-Core mode is what a paired
// Core gets by default. These suites bind a fake core link and a fake Files sender into the real
// factory, so what is checked is the wiring (the blob's origin, bearer and mTLS material reach the
// mode, and `watch` replays the Core's event log), not the mode itself, which has its own suite.

import { afterEach, describe, expect, it } from "vitest";
import type { CoreFilesFetch, CoreFilesRequest, CoreLinkEvent } from "@actana/sdk/core";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";
import { fakeSessionGateway, makeCliFixture, registerCore, sentinelBlobText, type CliFixture } from "./cli-harness.ts";
import type { CoreLinkClient } from "../core/core-connection.ts";
import {
  createOpenSharedThroughCore,
  openSharedThroughCore,
  SharedUnavailableError,
  sharedChangedEvents,
} from "../core/shared-gateway.ts";
import { EXIT_OK } from "../kit/exit-codes.ts";

const PROD = "wss://prod.test:9444";

const blob = (endpoint = PROD): CoreRegistrationBlob => ({
  endpoint,
  label: "prod",
  caCert: "CA-PEM",
  clientCert: "CERT-PEM",
  clientKey: "KEY-PEM",
  bearer: "bearer-token",
});

function sharedEvent(eventId: number, path: string, deleted = false): CoreLinkEvent {
  return {
    eventId,
    ts: 0,
    kind: "shared:changed",
    ptyId: null,
    sessionId: null,
    payload: JSON.stringify({ path, size: 3, mtime: 1_790_000_000_000, deleted }),
  };
}

/** A core link whose event log is an array: `subscribe(n)` replays up to `cap` events past n, then the marker. */
function fakeLink(opts: { cap?: number; reportsTip?: boolean } = {}) {
  const log: CoreLinkEvent[] = [];
  const eventCbs = new Set<(msg: { event: CoreLinkEvent }) => void>();
  const replayedCbs = new Set<(msg: { lastEventId: number; tipEventId?: number }) => void>();
  const disconnectedCbs = new Set<(msg: { error?: string }) => void>();
  const state = {
    log,
    subscribes: [] as number[],
    closed: 0,
    append(event: CoreLinkEvent) {
      log.push(event);
    },
    drop(error: string) {
      for (const cb of disconnectedCbs) cb({ error });
    },
  };
  const client: Pick<CoreLinkClient, "subscribeEvents" | "onEvent" | "onEventsReplayed" | "onDisconnected" | "close"> = {
    subscribeEvents: (from = 0) => {
      state.subscribes.push(from);
      const tail = log.filter((e) => e.eventId > from).slice(0, opts.cap ?? 1000);
      queueMicrotask(() => {
        for (const event of tail) for (const cb of eventCbs) cb({ event });
        const lastEventId = tail.length > 0 ? tail[tail.length - 1]!.eventId : from;
        const tip = log.length > 0 ? log[log.length - 1]!.eventId : 0;
        for (const cb of replayedCbs) cb({ lastEventId, ...(opts.reportsTip === false ? {} : { tipEventId: tip }) });
      });
      return true;
    },
    onEvent: (cb) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onEventsReplayed: (cb) => (replayedCbs.add(cb), () => replayedCbs.delete(cb)),
    onDisconnected: (cb) => (disconnectedCbs.add(cb), () => disconnectedCbs.delete(cb)),
    close: () => {
      state.closed += 1;
    },
  };
  return { ...state, client, state };
}

/** A Files sender that remembers PUTs and answers GET, HEAD and list from what it holds. */
function fakeFiles(opts: { onWrite?: (sharedPath: string, size: number) => void } = {}) {
  const requests: CoreFilesRequest[] = [];
  const files = new Map<string, string>();
  const fetch: CoreFilesFetch = async (req) => {
    requests.push(req);
    const url = new URL(req.url);
    const path = url.searchParams.get("path") ?? "";
    if (req.method === "PUT") {
      const body = await new Response(req.body ?? null).text();
      files.set(path, body);
      opts.onWrite?.(path.replace(/^shared\//, ""), body.length);
      return new Response('{"type":"done"}\n', { status: 200 });
    }
    if (url.pathname === "/v1/files/list") {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const lines = [...files]
        .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
        .map(([name, body]) => JSON.stringify({ type: "entry", path: name, kind: "file", size: body.length, mtime: 1 }));
      return new Response([...lines, '{"type":"done"}'].join("\n"), { status: 200 });
    }
    const body = files.get(path);
    if (body === undefined) return new Response(JSON.stringify({ code: "not-found", error: "no such file" }), { status: 404 });
    return req.method === "HEAD" ? new Response(null, { status: 200 }) : new Response(body, { status: 200 });
  };
  return { fetch, requests, files };
}

describe("the through-the-Core factory", () => {
  it("sends Files requests to the blob's HTTPS origin with the blob's bearer and mTLS material", async () => {
    const link = fakeLink();
    const files = fakeFiles();
    const tlsSeen: unknown[] = [];
    const open = createOpenSharedThroughCore({
      connect: async () => link.client as CoreLinkClient,
      createFilesFetch: (tls) => (tlsSeen.push(tls), files.fetch),
    });

    const handle = await open(blob());
    await handle.shared.put("reports/a.md", "hello");
    const got = await handle.shared.get("reports/a.md");

    expect(new TextDecoder().decode(got.body)).toBe("hello");
    expect(tlsSeen).toEqual([{ ca: "CA-PEM", cert: "CERT-PEM", key: "KEY-PEM" }]);
    const put = files.requests.find((r) => r.method === "PUT")!;
    expect(put.url).toBe("https://prod.test:9444/v1/files?path=shared%2Freports%2Fa.md");
    expect(put.headers.authorization).toBe("Bearer bearer-token");
  });

  it("hands back a handle that closes the link, and nothing else", async () => {
    const link = fakeLink();
    const open = createOpenSharedThroughCore({
      connect: async () => link.client as CoreLinkClient,
      createFilesFetch: () => fakeFiles().fetch,
    });

    const handle = await open(blob());
    expect(link.state.closed).toBe(0);
    handle.close();
    expect(link.state.closed).toBe(1);
  });

  it("is what the package binds by default: it dials the Core instead of refusing as unimplemented", async () => {
    // Nothing listens on port 1, so the dial fails fast. What matters is that it was a dial: the
    // stub that stood here until client PR 39 threw SharedUnavailableError without dialling.
    const failure = await openSharedThroughCore(blob("wss://127.0.0.1:1"), { timeoutMs: 2_000 }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SharedUnavailableError);
  });
});

describe("watch through the Core's event log", () => {
  async function opened(link: ReturnType<typeof fakeLink>) {
    const open = createOpenSharedThroughCore({
      connect: async () => link.client as CoreLinkClient,
      createFilesFetch: () => fakeFiles().fetch,
    });
    return open(blob());
  }

  it("starts at the log's tip and then reports only what was appended after it", async () => {
    const link = fakeLink();
    link.append(sharedEvent(1, "old.md"));
    const { shared } = await opened(link);

    const first = await shared.watch();
    link.append(sharedEvent(2, "sessions/s1/report-1.md"));
    link.append({ ...sharedEvent(3, "x"), kind: "session:updated" });
    const next = await shared.watch(first.cursor);

    expect(first.cursor).toBe("1");
    expect(next.changes.map((c) => c.path)).toEqual(["sessions/s1/report-1.md"]);
    expect(next.cursor).toBe("3");
  });

  it("reads a tail longer than the Core's cap in rounds, losing none", async () => {
    const link = fakeLink({ cap: 2 });
    for (let id = 1; id <= 5; id += 1) link.append(sharedEvent(id, `f${id}.md`));
    const events = sharedChangedEvents(link.client as CoreLinkClient);

    const since = await events.since(0);

    expect(since.map((e) => e.path)).toEqual(["f1.md", "f2.md", "f3.md", "f4.md", "f5.md"]);
  });

  it("learns the tip by reading the log through when the Core does not name it", async () => {
    const link = fakeLink({ cap: 2, reportsTip: false });
    for (let id = 1; id <= 5; id += 1) link.append(sharedEvent(id, `f${id}.md`));
    const events = sharedChangedEvents(link.client as CoreLinkClient);

    expect(await events.tip()).toBe(5);
  });

  it("learns the tip from the replay marker in one subscribe, without reading the log", async () => {
    const link = fakeLink({ cap: 2 });
    for (let id = 1; id <= 5; id += 1) link.append(sharedEvent(id, `f${id}.md`));
    const events = sharedChangedEvents(link.client as CoreLinkClient);

    expect(await events.tip()).toBe(5);
    expect(link.state.subscribes).toEqual([Number.MAX_SAFE_INTEGER]);
  });

  it("fails when the link drops mid-replay, with the reason, instead of waiting for ever", async () => {
    const link = fakeLink();
    const events = sharedChangedEvents(link.client as CoreLinkClient);
    link.client.subscribeEvents = () => {
      queueMicrotask(() => link.drop("socket closed"));
      return true;
    };

    await expect(events.since(0)).rejects.toThrow("socket closed");
  });

  it("fails when a replay never closes, naming the Core as the one not answering", async () => {
    const link = fakeLink();
    link.client.subscribeEvents = () => true;
    const events = sharedChangedEvents(link.client as CoreLinkClient, { timeoutMs: 20 });

    await expect(events.since(0)).rejects.toThrow("did not finish replaying");
  });
});

describe("the shared command, with the default mode", () => {
  let fixture: CliFixture | null = null;
  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  it("put, get and ls reach the Core's Files API, not a stub", async () => {
    fixture = makeCliFixture();
    registerCore(fixture.paths, "prod", sentinelBlobText(PROD));
    const files = fakeFiles();
    const link = fakeLink();
    const open = createOpenSharedThroughCore({
      connect: async () => link.client as CoreLinkClient,
      createFilesFetch: () => files.fetch,
    });

    const put = await fixture.run(["shared", "put", "reports/a.md"], { shared: open, stdin: "# done\n" });
    const get = await fixture.run(["shared", "get", "reports/a.md"], { shared: open });

    expect(put.code).toBe(EXIT_OK);
    expect(put.err).toEqual(["Wrote 7 bytes to prod:reports/a.md."]);
    expect(get.code).toBe(EXIT_OK);
    expect(get.out.join("\n")).toContain("# done");
    expect(link.state.closed).toBe(2);
  });
});

describe("send, wait and read end to end through the Shared folder of a Core", () => {
  let fixture: CliFixture | null = null;
  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  /** A Core whose Files API and event log are one: a write is a file and a `shared:changed` event. */
  function core() {
    const link = fakeLink();
    let eventId = 0;
    const files = fakeFiles({
      onWrite: (path, size) => {
        eventId += 1;
        link.append({ ...sharedEvent(eventId, path), payload: JSON.stringify({ path, size, mtime: 1, deleted: false }) });
      },
    });
    const open = createOpenSharedThroughCore({
      connect: async () => link.client as CoreLinkClient,
      createFilesFetch: () => files.fetch,
      pollIntervalMs: 5,
    });
    /** What the harness does on the Core: write its report into the home's shared folder. */
    return { link, files, open, bump: (path: string, body: string) => {
      files.files.set(`shared/${path}`, body);
      eventId += 1;
      link.append({ ...sharedEvent(eventId, path), payload: JSON.stringify({ path, size: body.length, mtime: 1, deleted: false }) });
    } };
  }

  it("sends a follow-up with the block, waits on the watcher for its report, and reads it back", async () => {
    fixture = makeCliFixture();
    registerCore(fixture.paths, "prod", sentinelBlobText(PROD));
    const c = core();
    const typed: string[] = [];
    const sessions = fakeSessionGateway({
      list: async () => [{ sessionId: "s1", title: "t", harness: "claude-code", status: "running", ptyId: "p", live: true, writable: null, lock: null, updatedAt: 0 }],
      send: async (_id, text) => {
        typed.push(text);
        // The harness answers a moment after it was typed to: its report lands in ~/shared on the Core.
        setTimeout(() => c.bump("sessions/s1/report-2.md", "# turn 2\nthe answer\nACT-REPORT-END\n"), 30);
        return { ok: true };
      },
    });
    // Turn 1 was reported before: send must number this one 2.
    c.bump("sessions/s1/report-1.md", "# turn 1\nACT-REPORT-END\n");

    const waited = await fixture.run(["session", "send", "s1", "now", "the", "tests", "--enter", "--wait", "--wait-timeout", "5"], { sessions, shared: c.open });
    const read = await fixture.run(["shared", "get", "sessions/s1/report-2.md"], { shared: c.open });

    expect(waited.code, waited.err.join("\n")).toBe(EXIT_OK);
    expect(waited.out).toEqual(["sessions/s1/report-2.md"]);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain("now the tests [Actana standard block v1]");
    expect(typed[0]).toContain("write your report to ~/shared/sessions/s1/report-2.md");
    expect(read.code, read.err.join("\n")).toBe(EXIT_OK);
    expect(read.out.join("\n")).toContain("the answer");
    // The report was learnt from the event log, and read over the Files API: no command ran on the Core.
    expect(c.files.requests.some((r) => r.url.includes("/v1/files?path=shared%2Fsessions%2Fs1%2Freport-2.md"))).toBe(true);
    expect(c.link.state.subscribes.length).toBeGreaterThan(1);
  });

  it("settles a wait on a report that was already there, then reads it", async () => {
    fixture = makeCliFixture();
    registerCore(fixture.paths, "prod", sentinelBlobText(PROD));
    const c = core();
    c.bump("sessions/s1/report-1.md", "done\nACT-REPORT-END\n");
    const sessions = fakeSessionGateway({
      list: async () => [{ sessionId: "s1", title: "t", harness: "claude-code", status: "finished", ptyId: null, live: false, writable: null, lock: null, updatedAt: 0 }],
    });

    const waited = await fixture.run(["session", "wait", "s1", "--wait-timeout", "5", "--json"], { sessions, shared: c.open });

    expect(waited.code, waited.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(waited.out.join("\n"))).toMatchObject({ turn: 1, settled: true, report: "done\nACT-REPORT-END\n" });
  });
});
