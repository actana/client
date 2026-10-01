// Reaching a Core's Shared folder for the `shared` noun (client #7).
//
// One small factory is the whole seam between the command and a mode of
// `CoreShared`. The command (`shared-command.ts`) is written against the
// `CoreShared` interface that `@actana/sdk/shared` exports and nothing else: it
// does not know whether the folder is reached through the Core or straight in
// S3, and it never imports a mode.
//
// **The through-the-Core mode is the default for a paired Core**, because a
// paired Core is what the CLI holds a credential for (client PR 39 is that mode;
// {@link openSharedThroughCore} binds it). Files go over the Core's HTTPS Files API
// with the same mTLS material and bearer the core link uses; changes come from the
// `shared:changed` events on the Core's event log, replayed by cursor. Tests bind a
// double through `deps.openShared`, or inject a fake link and fetch into
// {@link createOpenSharedThroughCore}. The direct-S3 mode is not offered here on
// purpose: it needs the master key, which a Core blob does not carry.

import { createThroughCoreShared } from "@actana/sdk/shared";
import type { CoreShared, SharedChangedEvent, SharedChangedEventSource } from "@actana/sdk/shared";
import { createCoreFilesFetch } from "@actana/sdk/core";
import type { CoreFilesFetch, CoreLinkEvent, CoreLinkTlsMaterial } from "@actana/sdk/core";
import { coreConnectionFromBlob } from "@actana/sdk/pairing";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";
import { connectCore, type CoreConnectFn, type CoreLinkClient } from "./core-connection.ts";

/** An open view of one Core's Shared folder. */
export type SharedHandle = {
  shared: CoreShared;
  /** How long `shared watch` waits between polls. Default {@link DEFAULT_WATCH_POLL_MS}. */
  pollIntervalMs?: number;
  /** Release whatever the mode holds open. Called once, when the command is done. */
  close(): void;
};

/** How the `shared` noun reaches a Core's Shared folder. Injected, so every verb is testable. */
export type OpenSharedFn = (
  blob: CoreRegistrationBlob,
  opts?: { timeoutMs?: number },
) => Promise<SharedHandle>;

/** `shared watch` polls `CoreShared.watch(since)`: the interface has no push. */
export const DEFAULT_WATCH_POLL_MS = 2_000;

/** This build has no implementation of the mode asked for. Not a typo, not a Core refusal. */
export class SharedUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedUnavailableError";
  }
}

/** The event kind the Core appends for a change in the Shared folder (control PR 619). */
const SHARED_CHANGED_KIND = "shared:changed";

/** A replay that has not closed in this long is a Core that is not answering. */
const REPLAY_TIMEOUT_MS = 30_000;

/** A cursor no log has reached: subscribing from it replays nothing and learns the tip. */
const PAST_THE_END = Number.MAX_SAFE_INTEGER;

/** One `shared:changed` event off the log, or null when it is another kind or not well formed. */
function sharedChangedFrom(event: CoreLinkEvent): SharedChangedEvent | null {
  if (event.kind !== SHARED_CHANGED_KIND) return null;
  try {
    const p = JSON.parse(event.payload) as Record<string, unknown>;
    if (typeof p.path !== "string" || typeof p.deleted !== "boolean") return null;
    return {
      eventId: event.eventId,
      path: p.path,
      size: typeof p.size === "number" ? p.size : 0,
      mtime: typeof p.mtime === "number" ? p.mtime : 0,
      deleted: p.deleted,
    };
  } catch {
    return null;
  }
}

type ReplayRound = { events: CoreLinkEvent[]; lastEventId: number; tipEventId?: number };

/**
 * The event-log half of the through-the-Core mode, over an open core link.
 *
 * Each question is a fresh `subscribe` from a cursor: the Core replays the tail
 * past it and closes with `eventsReplayed`. That marker is a receipt for what was
 * sent, not the end of the log (a tail longer than the Core's cap arrives in
 * rounds), so a round that delivered anything is followed by another from the
 * highest id seen, until one comes back empty or the marker names the tip.
 */
export function sharedChangedEvents(
  client: Pick<CoreLinkClient, "subscribeEvents" | "onEvent" | "onEventsReplayed" | "onDisconnected">,
  opts: { timeoutMs?: number } = {},
): SharedChangedEventSource {
  const timeoutMs = opts.timeoutMs ?? REPLAY_TIMEOUT_MS;

  const round = (from: number): Promise<ReplayRound> =>
    new Promise((resolve, reject) => {
      const events: CoreLinkEvent[] = [];
      const off: Array<() => void> = [];
      const finish = (done: () => void) => {
        clearTimeout(timer);
        for (const stop of off) stop();
        done();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("the Core did not finish replaying its event log"))),
        timeoutMs,
      );
      off.push(client.onEvent(({ event }) => void events.push(event)));
      off.push(
        client.onEventsReplayed((marker) =>
          finish(() =>
            resolve({
              events,
              lastEventId: marker.lastEventId,
              ...(marker.tipEventId === undefined ? {} : { tipEventId: marker.tipEventId }),
            }),
          ),
        ),
      );
      off.push(
        client.onDisconnected(({ error }) =>
          finish(() => reject(new Error(error ?? "the link to the Core dropped"))),
        ),
      );
      if (!client.subscribeEvents(from)) {
        finish(() => reject(new Error("the link to the Core is not open")));
      }
    });

  /** Every event past `from`, in rounds, and the highest id the Core said exists. */
  const replay = async (from: number): Promise<{ events: Map<number, CoreLinkEvent>; tip: number }> => {
    const seen = new Map<number, CoreLinkEvent>();
    let cursor = from;
    let tip = from;
    for (;;) {
      const got = await round(cursor);
      if (got.tipEventId !== undefined && got.tipEventId > tip) tip = got.tipEventId;
      let highest = cursor;
      for (const event of got.events) {
        if (event.eventId <= from) continue;
        seen.set(event.eventId, event);
        if (event.eventId > highest) highest = event.eventId;
        if (event.eventId > tip) tip = event.eventId;
      }
      // An empty tail is the Core saying it has nothing past the cursor; a marker
      // that reaches the tip it named is the same sentence without the extra trip.
      if (highest === cursor) return { events: seen, tip };
      cursor = highest;
      if (got.tipEventId !== undefined && cursor >= got.tipEventId) return { events: seen, tip };
    }
  };

  return {
    async tip() {
      const probe = await round(PAST_THE_END);
      if (probe.tipEventId !== undefined) return probe.tipEventId;
      // A Core that does not name its tip: read the log through to its end.
      return (await replay(0)).tip;
    },
    async since(since) {
      const { events } = await replay(since);
      const changes: SharedChangedEvent[] = [];
      for (const event of [...events.values()].sort((a, b) => a.eventId - b.eventId)) {
        const change = sharedChangedFrom(event);
        if (change !== null) changes.push(change);
      }
      return changes;
    },
  };
}

/** What the factory needs from outside: the link, and how Files requests are sent. */
export type SharedThroughCoreDeps = {
  connect: CoreConnectFn;
  createFilesFetch: (tls: CoreLinkTlsMaterial | null) => CoreFilesFetch;
  /** Between two polls of `watch`. Default {@link DEFAULT_WATCH_POLL_MS}. */
  pollIntervalMs?: number;
};

/** Build the through-the-Core factory over a link and a Files sender. Tests inject fakes. */
export function createOpenSharedThroughCore(deps: SharedThroughCoreDeps): OpenSharedFn {
  return async (blob, opts = {}) => {
    const connection = coreConnectionFromBlob(blob);
    const client = await deps.connect(blob, opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs });
    const shared = createThroughCoreShared({
      baseUrl: connection.httpsBaseUrl,
      bearer: connection.bearer,
      fetch: deps.createFilesFetch(connection.tls),
      events: sharedChangedEvents(client, opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    return {
      shared,
      ...(deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: deps.pollIntervalMs }),
      close: () => client.close(),
    };
  };
}

/** The default factory: the through-the-Core mode, bound to the real link and the real mTLS sender. */
export const openSharedThroughCore: OpenSharedFn = createOpenSharedThroughCore({
  connect: connectCore,
  createFilesFetch: createCoreFilesFetch,
});
