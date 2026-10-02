// `send --wait` carries Control's default deadline on both waits (actana/client#11).
//
// Control's `send --wait` gives up after 1020 seconds unless told otherwise (#405): the wait is for a turn that
// has not started yet, and a carriage return that lands on a dialog starts none, so nothing is ever reported. The
// report-file wait had no default and would sit for ever on a harness that never writes a report. `--wait-timeout
// <s>` replaces the deadline, `--wait-timeout 0` removes it, and `session wait` on its own still has none.

import { describe, it, expect, afterEach, vi } from "vitest";
import { fakeShared } from "./shared-fixture.ts";
import { fakeSessionGateway, fakeStartedSession, makeCliFixture, registerCore, type CliFixture } from "./cli-harness.ts";
import { EXIT_OK } from "../kit/exit-codes.ts";

type WaitOpts = { timeoutMs: number | null };
const reportWaits: WaitOpts[] = [];

vi.mock("../core/session-report-wait.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/session-report-wait.ts")>();
  return {
    ...real,
    awaitReport: async (shared: never, path: string, opts: WaitOpts) => {
      reportWaits.push({ timeoutMs: opts.timeoutMs });
      return { path, body: "done\nACT-REPORT-END\n", cursor: "0" };
    },
  };
});

let fixture: CliFixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  reportWaits.length = 0;
});

const DEFAULT_MS = 1020 * 1000;

async function run(argv: string[], opts: { shared: boolean }) {
  fixture = makeCliFixture();
  registerCore(fixture.paths, "prod");
  const statusDeadlines: Array<number | undefined> = [];
  const session = () =>
    fakeStartedSession({
      wait: async (waitOpts) => {
        statusDeadlines.push(waitOpts.timeoutMs);
        return { status: "finished", exited: false };
      },
    });
  const sessions = fakeSessionGateway({
    send: async () => ({ ok: true }),
    sendAndWait: async () => session(),
    wait: async () => session(),
    list: async () => [
      { sessionId: "session_1", title: "t", harness: "claude-code", status: "running", ptyId: "pty_1", live: true, writable: null, lock: null, updatedAt: 1 },
    ],
  });
  const shared = fakeShared({ pollIntervalMs: 1 });
  const result = await fixture.run(argv, {
    sessions,
    shared: opts.shared
      ? shared.open
      : async () => {
          throw new Error("this Core keeps no Shared folder");
        },
  });
  return { result, statusDeadlines };
}

describe("send --wait on the report file", () => {
  it("defaults to 1020 seconds", async () => {
    const { result } = await run(["session", "send", "session_1", "go", "--wait"], { shared: true });
    expect(result.code, result.err.join("\n")).toBe(EXIT_OK);
    expect(reportWaits).toEqual([{ timeoutMs: DEFAULT_MS }]);
  });

  it("takes --wait-timeout in place of the default, and 0 removes it", async () => {
    await run(["session", "send", "session_1", "go", "--wait", "--wait-timeout", "5"], { shared: true });
    await run(["session", "send", "session_1", "go", "--wait", "--wait-timeout", "0"], { shared: true });
    expect(reportWaits).toEqual([{ timeoutMs: 5000 }, { timeoutMs: null }]);
  });

  it("leaves `session wait` without a default deadline", async () => {
    await run(["session", "wait", "session_1"], { shared: true });
    expect(reportWaits).toEqual([{ timeoutMs: null }]);
  });
});

describe("send --wait on the status fallback", () => {
  it("defaults to 1020 seconds, replaced by --wait-timeout and removed by 0", async () => {
    const a = await run(["session", "send", "session_1", "go", "--wait"], { shared: false });
    const b = await run(["session", "send", "session_1", "go", "--wait", "--wait-timeout", "7"], { shared: false });
    const c = await run(["session", "send", "session_1", "go", "--wait", "--wait-timeout", "0"], { shared: false });
    expect(a.statusDeadlines).toEqual([DEFAULT_MS]);
    expect(b.statusDeadlines).toEqual([7000]);
    expect(c.statusDeadlines).toEqual([undefined]);
    expect(reportWaits).toEqual([]);
  });

  it("leaves `session wait` without a default deadline", async () => {
    const { statusDeadlines } = await run(["session", "wait", "session_1"], { shared: false });
    expect(statusDeadlines).toEqual([undefined]);
  });
});
