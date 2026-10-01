// Step 3 against the fake Core: start a Session, the harness writes the report where the Core's
// block says, and the recipe settles on that file through the Shared watcher.
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient } from "@actana/sdk/core";
import { startFakeCore } from "./fake-core.mjs";
import { createMemoryShared } from "./memory-shared.mjs";
import { reportingHarness } from "./harness.mjs";
import { startSessionAndWatch, awaitReport } from "../src/session.mjs";
import { NoReportError, TimeoutError } from "../src/errors.mjs";
import { REPORT_END_MARKER, sessionReportPath } from "../src/report-contract.mjs";

const clients = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

async function connect(core) {
  const client = new CoreClient({ url: "wss://fake-core.invalid", bearer: core.bearer, createSocket: core.createSocket });
  clients.push(client);
  await client.connect();
  return client;
}

const fast = { pollMs: 5, exitGraceMs: 40, timeoutMs: 2_000 };

describe("step 3: start a Session and watch its report", () => {
  it("settles on the report the harness wrote where the Core's block said", async () => {
    const shared = createMemoryShared();
    const core = startFakeCore({ harness: reportingHarness(shared, { body: "The repo has two packages." }) });
    const client = await connect(core);

    const result = await startSessionAndWatch({ client, shared, harness: "claude-code", prompt: "summarise this repo", ...fast });

    expect(result.sessionId).toBe("sess-1");
    expect(result.reportPath).toBe("sessions/sess-1/report-1.md");
    expect(result.report).toContain("The repo has two packages.");
    expect(result.report).not.toContain(REPORT_END_MARKER);
    // The Core appended the block to the starting prompt; the recipe sent the bare prompt.
    expect(core.framesOfType("spawn")[0].opts.initialInput).toBe("summarise this repo");
    expect(core.spawns[0].prompt).toContain("[Actana standard block v1]");
  });

  it("settles on a report that landed before the first look (the cursor comes first)", async () => {
    const shared = createMemoryShared();
    // The harness answers instantly, before the recipe has had a chance to look.
    const core = startFakeCore({ harness: reportingHarness(shared, { delayMs: 0 }) });
    const client = await connect(core);
    const result = await startSessionAndWatch({ client, shared, harness: "claude-code", prompt: "p", ...fast });
    expect(result.report).toContain("Report for sess-1");
  });

  it("does not settle on a report that is still being written (no end marker)", async () => {
    const shared = createMemoryShared();
    await shared.put(sessionReportPath("sess-1", 1), "# half a repor");
    const core = startFakeCore({
      harness: async ({ exit }) => {
        // Never finishes the file; exits instead.
        exit(0);
      },
    });
    const client = await connect(core);
    await expect(
      startSessionAndWatch({ client, shared, harness: "claude-code", prompt: "p", ...fast }),
    ).rejects.toBeInstanceOf(NoReportError);
  });
});

describe("awaitReport", () => {
  it("sees a report that lands between the first look and the first watch, because the cursor is older than the look", async () => {
    const shared = createMemoryShared();
    const path = "sessions/x/report-1.md";
    const { cursor } = await shared.watch();
    // The first look finds nothing, and the harness finishes right after it, before any watch is asked.
    const realGet = shared.get;
    let looks = 0;
    shared.get = async (p) => {
      looks += 1;
      try {
        return await realGet(p);
      } finally {
        if (looks === 1) await shared.put(path, `# late\n\n${REPORT_END_MARKER}\n`);
      }
    };
    // Only the change feed may tell it: a later look is not allowed to find the file by itself.
    const realWatch = shared.watch;
    let watched = false;
    shared.watch = async (since) => {
      watched = true;
      return realWatch(since);
    };
    const body = await awaitReport({ shared, path, since: cursor, pollMs: 2, timeoutMs: 500 });
    expect(body).toContain("# late");
    expect(watched).toBe(true);
  });

  it("times out with a TimeoutError naming the file", async () => {
    const shared = createMemoryShared();
    const { cursor } = await shared.watch();
    const err = await awaitReport({ shared, path: "sessions/x/report-1.md", since: cursor, pollMs: 2, timeoutMs: 30 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain("sessions/x/report-1.md");
    expect(err.exitCode).toBe(3);
  });
});
