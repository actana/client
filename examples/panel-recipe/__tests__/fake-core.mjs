// A fake Core for the recipe's tests: the Core end of the core-link, hand-written from the frames
// the SDK documents (`@actana/sdk/core`'s `link-frames`). It is a socket FACTORY for
// `CoreClient({ createSocket })`, so the recipe's steps run on the real SDK client against it.
//
// It stands in for the things a unit test cannot have: a Core, and a harness. What it does:
//   - `ready` (with the `shared` capability), `auth` -> `authOk`, `reclaim`, `subscribe`;
//   - `sessionsMutate` create -> a Session row; `spawn` -> `spawned`, then calls the `harness` hook
//     with the prompt the way the Core types it, INCLUDING the standard block the real Core appends
//     to a starting prompt (control PR 621);
//   - `sharedAttach` / `sharedCredentials` / `sharedDetach` -> `sharedStatus`, and it remembers the
//     last credentials it was handed, so a "harness" can write to the Shared folder with them;
//   - everything it was sent is in `frames`, which is how a test reads what crossed the wire.
// It does NOT run a harness, mount a folder or sync one: a Core-backed claim in a PR is a fake
// unless it says it ran a real Core.
import { CORE_LINK_PROTOCOL_VERSION } from "@actana/sdk/core";
import { appendPromptBlock } from "../src/report-contract.mjs";

export function startFakeCore({
  coreId = "core-fake",
  bearer = "fake-bearer-NEVER-PRINT",
  shared = { version: 1 },
  /** Called once per spawn: ({ sessionId, ptyId, prompt, credentials, exit(code), emitEvent }). */
  harness = () => undefined,
  /** Reply to sharedAttach; return a `status` object. Default: attached. */
  attach = (frame) => ({ state: "attached", expiresAt: frame.expiresAt }),
} = {}) {
  const frames = [];
  const state = { sessionCount: 0, eventId: 0, credentials: null, attached: null, sockets: [] };
  const spawns = [];

  function serve() {
    const listeners = { open: [], message: [], close: [], error: [], pong: [] };
    const send = (frame) => queueMicrotask(() => listeners.message.forEach((cb) => cb(JSON.stringify(frame))));
    const pty = { id: null, sessionId: null };

    const reply = (frame, extra) => send({ reqId: frame.reqId, ...extra });
    const handlers = {
      auth: (f) => {
        if (f.bearer !== bearer) return reply(f, { type: "authError", reason: "bad-signature" });
        reply(f, { type: "authOk", coreId, exp: Date.now() + 3_600_000 });
      },
      reclaim: (f) => reply(f, { type: "reclaimResult", replaced: false, sessionIds: [] }),
      subscribe: (f) => reply(f, { type: "eventsReplayed", lastEventId: 0, tipEventId: state.eventId }),
      ptySubscribe: (f) => reply(f, { type: "ptySubscribeAck", ptyId: f.ptyId, subscribed: true }),
      sessionsMutate: (f) => {
        state.sessionCount += 1;
        const sessionId = `sess-${state.sessionCount}`;
        reply(f, {
          type: "sessionsMutateResult",
          session: {
            sessionId,
            title: f.mutation.title,
            titleManuallySet: false,
            claudeSessionId: null,
            agent: f.mutation.agent,
            status: "ready",
            pinned: false,
            archived: false,
            icon: null,
            updatedAt: 1,
          },
        });
      },
      spawn: (f) => {
        pty.id = `pty-${state.sessionCount}`;
        pty.sessionId = f.opts.sessionId;
        const prompt =
          f.opts.initialInput === undefined
            ? undefined
            : appendPromptBlock(f.opts.initialInput, { sessionId: pty.sessionId, turn: 1 });
        spawns.push({ ...f.opts, prompt });
        reply(f, { type: "spawned", ptyId: pty.id });
        // The harness runs after the spawn is answered, as a real one does.
        setTimeout(() => {
          void harness({
            sessionId: pty.sessionId,
            ptyId: pty.id,
            prompt,
            credentials: state.credentials,
            exit: (exitCode = 0) => send({ type: "exit", ptyId: pty.id, exitCode }),
          });
        }, 0);
      },
      kill: (f) => reply(f, { type: "killResult", ok: true }),
      sharedAttach: (f) => {
        state.credentials = { endpoint: f.endpoint, bucket: f.bucket, prefix: f.prefix, region: f.region, ...f.credentials };
        const status = attach(f);
        if (status.state === "attached") state.attached = { prefix: f.prefix, bucket: f.bucket, endpoint: f.endpoint };
        reply(f, { type: "sharedStatus", status });
      },
      sharedCredentials: (f) => {
        state.credentials = { ...state.credentials, ...f.credentials };
        reply(f, { type: "sharedStatus", status: { state: "attached", expiresAt: f.expiresAt } });
      },
      sharedDetach: (f) => {
        state.attached = null;
        reply(f, { type: "sharedStatus", status: { state: "detached", keptLocalCopy: true } });
      },
    };

    const sock = {
      readyState: 0,
      send(data) {
        const frame = JSON.parse(data);
        frames.push(frame);
        const handler = handlers[frame.type];
        if (handler) handler(frame);
      },
      close() {
        sock.readyState = 3;
        listeners.close.forEach((cb) => cb());
      },
      on(event, cb) {
        listeners[event]?.push(cb);
      },
    };
    state.sockets.push(sock);
    queueMicrotask(() => {
      sock.readyState = 1;
      listeners.open.forEach((cb) => cb());
      send({ type: "ready", version: CORE_LINK_PROTOCOL_VERSION, ...(shared ? { shared } : {}) });
    });
    return sock;
  }

  return {
    coreId,
    bearer,
    createSocket: serve,
    frames,
    spawns,
    state,
    framesOfType: (type) => frames.filter((f) => f.type === type),
  };
}
