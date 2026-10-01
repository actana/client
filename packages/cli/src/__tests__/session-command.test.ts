// The `session` noun's surface: flags, output, exit codes (#160).
//
// The gateway is injected (`session-gateway.ts` is the only module that dials),
// so everything here runs with no Core and no socket — which is what makes it
// possible to assert the things a Core would otherwise hide: that `start`
// returns without waiting, that stdout carries the id and nothing else, that
// `--json` never shares stdout with prose, and that a flag a verb does not take
// is refused rather than ignored.
//
// `in-process-core-session.test.ts` is the other half: the same verbs against a
// real `PtyCoreLinkServer`, proving the frames are the ones a Core answers.

import { describe, it, expect, afterEach } from "vitest";
import { fakeShared, type FakeShared } from "./shared-fixture.ts";
import { appendPromptBlock, buildPromptBlock } from "../core/session-report.ts";
import {
  fakeSessionGateway,
  fakeStartedSession,
  makeCliFixture,
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
import { SessionGatewayError, type SessionRow } from "../core/session-gateway.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";

const END = "ACT-REPORT-END";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** A registered Core, so resolution finds one and the verbs get as far as the gateway. */
async function withRegisteredCore(): Promise<void> {
  registerCore(cli().paths, "prod");
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "session_1",
    title: "fix the flaky test",
    harness: "claude-code",
    status: "running",
    ptyId: "pty_1",
    live: true,
    writable: null,
    lock: null,
    updatedAt: Date.UTC(2026, 7, 12) - 3_600_000,
    ...overrides,
  };
}

describe("actana session — the command tree", () => {
  it("prints its help, and a bare `session` is a usage error", async () => {
    const help = await cli().run(["session", "--help"]);
    expect(help.code).toBe(EXIT_OK);
    expect(help.out.join("\n")).toContain("actana session start [prompt]");

    const bare = await cli().run(["session"]);
    expect(bare.code).toBe(EXIT_USAGE);
  });

  it("refuses `attach` from something that is not a terminal, rather than half-doing it", async () => {
    // The fixture's default terminal is not a TTY, which is what a pipe or a CI
    // job gets. `attach` is raw mode and keystrokes; there is nothing partial it
    // could usefully do there, and it dials nothing to say so — the fixture
    // throws on `openAttach`, so a run that reached the wire would fail here.
    await withRegisteredCore();
    const run = await cli().run(["session", "attach", "session_1"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("not a terminal");
    // And it points at the two verbs that *do* work from a script.
    expect(run.err.join("\n")).toContain("session logs");
    expect(run.err.join("\n")).toContain("session send");
  });

  it("rejects an unknown verb without dialling anything", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "detach", "session_1"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain('unknown verb "detach"');
  });

  it("refuses a flag the verb does not take rather than ignoring it", async () => {
    await withRegisteredCore();
    // `--wait` on `kill` is an instruction that would otherwise be silently
    // dropped, and the operator would believe they had waited.
    const run = await cli().run(["session", "kill", "session_1", "--wait"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("--wait does not apply here");
  });

  it("says which Core it could not find when none is selected", async () => {
    const run = await cli().run(["session", "ls"], { sessions: fakeSessionGateway() });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("no Core selected");
  });
});

describe("actana session ls", () => {
  it("renders a table, and the lock column only when the Core publishes one", async () => {
    await withRegisteredCore();
    const plain = await cli().run(["session", "ls"], {
      sessions: fakeSessionGateway({ list: async () => [row()] }),
    });
    expect(plain.code, plain.err.join("\n")).toBe(EXIT_OK);
    expect(plain.out[0]).toContain("SESSION");
    expect(plain.out[0]).not.toContain("LOCK");
    expect(plain.out[1]).toContain("session_1");
    expect(plain.out[1]).toContain("fix the flaky test");
    // Relative age, from the injected clock rather than the wall clock.
    expect(plain.out[1]).toContain("1h");

    const locked = await cli().run(["session", "ls"], {
      sessions: fakeSessionGateway({
        list: async () => [row({ lock: "held-by-another", writable: false })],
      }),
    });
    expect(locked.out[0]).toContain("LOCK");
    expect(locked.out[1]).toContain("other");
  });

  it("says so when there are none, in both output modes", async () => {
    await withRegisteredCore();
    const human = await cli().run(["session", "ls"], {
      sessions: fakeSessionGateway({ list: async () => [] }),
    });
    expect(human.code).toBe(EXIT_OK);
    expect(human.out.join("\n")).toContain("No sessions");

    const json = await cli().run(["session", "ls", "--json"], {
      sessions: fakeSessionGateway({ list: async () => [] }),
    });
    expect(JSON.parse(json.out.join("\n"))).toEqual([]);
  });

  it("refuses a leftover project argument on ls", async () => {
    registerCore(cli().paths, "prod");
    const run = await cli().run(["session", "ls", "web"], {
      sessions: fakeSessionGateway({ list: async () => [] }),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toMatch(/unexpected argument/i);
    expect(run.out.join("\n")).toBe("");
  });


  it("exits without waiting, printing the id and nothing else on stdout", async () => {
    await withRegisteredCore();
    let waited = false;
    const run = await cli().run(["session", "start", "fix", "the", "tests"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => {
              waited = true;
              return { status: "finished", exited: false };
            },
          }),
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // The one-shot default (#129 D6): the Session outlives the command.
    expect(waited).toBe(false);
    // `SESSION=$(actana session start …)` is the shape of every script that will
    // use this, so stdout is the id and the progress line went to stderr.
    expect(run.out).toEqual(["session_1"]);
    expect(run.err.join("\n")).toContain("Started claude-code — session session_1");
  });

  // ─── The turn-start asymmetry (issue 177 finding 4) ────────────────────
  //
  // Over the CLI a cursor-cli Session is statusless from prompt to stop:
  // cursor-agent takes the Core's `.cursor/hooks.json` and never fires
  // `beforeSubmitPrompt`, so nothing moves the row to `running`. The Panel
  // compensates by watching the keystrokes going into its pane; `start` hands
  // the prompt over and hangs up, so it has no keystrokes to watch. What it
  // can do is say so, which is the half of the acceptance criterion a CLI can
  // honestly meet.

  it("says plainly when nothing will report the start of a turn", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--harness", "cursor-cli"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({ harness: "cursor-cli", reportsTurnStart: false }),
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    const err = run.err.join("\n");
    expect(err).toContain("does not report the start of a turn");
    expect(err).toContain("cursor-cli");
    // Named so an operator does not read the caveat as "this session is
    // broken" — the two things that still work are the two they would reach
    // for next.
    expect(err).toContain("--wait");
    expect(err).toContain("session logs");
    // Still just the id on stdout: a caveat is not output a script captures.
    expect(run.out).toEqual(["session_1"]);
  });

  it("says nothing about turn starts for a harness that reports them", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go"], {
      sessions: fakeSessionGateway({
        start: async () => fakeStartedSession({ reportsTurnStart: true }),
      }),
    });
    expect(run.err.join("\n")).not.toContain("does not report the start of a turn");
  });

  it("carries the answer as a --json field, not only as prose", async () => {
    // A script deciding whether a quiet status means "still working" or "never
    // started" cannot parse a sentence off stderr.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({ harness: "cursor-cli", reportsTurnStart: false }),
      }),
    });
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({ reportsTurnStart: false });
  });

  it("hands the prompt over as typed, and never a carriage return with it", async () => {
    await withRegisteredCore();
    let seen: Record<string, unknown> | null = null;
    await cli().run(["session", "start", "fix the tests"], {
      sessions: fakeSessionGateway({
        start: async (request) => {
          seen = request as unknown as Record<string, unknown>;
          return fakeStartedSession();
        },
      }),
    });
    // Prompt delivery is the Core's (ADR 0026, #129 D3). What leaves this
    // process is text — no return, no timing, nothing appended.
    expect(seen!.prompt).toBe("fix the tests");
  });

  it("reads a prompt from stdin when it is `-`", async () => {
    await withRegisteredCore();
    let seen = "";
    await cli().run(["session", "start", "-"], {
      stdin: "a prompt too long for a command line\n",
      sessions: fakeSessionGateway({
        start: async (request) => {
          seen = request.prompt ?? "";
          return fakeStartedSession();
        },
      }),
    });
    expect(seen).toBe("a prompt too long for a command line\n");
  });

  it("names the id sessionId and never taskId, in every verb's --json, stdout and stderr", async () => {
    await withRegisteredCore();
    const gateway = fakeSessionGateway({
      start: async () => fakeStartedSession(),
      resume: async () => fakeStartedSession(),
      logs: async () => ({ sessionId: "session_1", ptyId: "pty_1", screen: "a screen", raw: "raw" }),
      send: async () => true,
      kill: async () => ({ ptyId: "pty_1", killed: true }),
      list: async () => [row()],
    });
    const shared = fakeShared();
    shared.folder().seed("sessions/session_1/report-1.md", `done\n${END}\n`);
    shared.folder().seed("sessions/session_1/report-2.md", `done\n${END}\n`);
    shared.folder().seed("sessions/session_1/report-3.md", `done\n${END}\n`);
    for (const argv of [
      ["session", "start", "go", "--json", "--verbose"],
      ["session", "resume", "session_1", "--json", "--verbose"],
      ["session", "logs", "session_1", "--json", "--verbose"],
      ["session", "send", "session_1", "hi", "--json", "--verbose"],
      ["session", "kill", "session_1", "--json", "--verbose"],
      ["session", "ls", "--json", "--verbose"],
      ["session", "wait", "session_1", "--wait-timeout", "2", "--json", "--verbose"],
      ["session", "send", "session_1", "hi", "--wait", "--turn", "3", "--wait-timeout", "2", "--json", "--verbose"],
    ]) {
      const run = await cli().run(argv, { sessions: gateway, shared: shared.open });
      const where = argv.join(" ");
      expect(run.code, where).toBe(EXIT_OK);
      const stdout = run.out.join("\n");
      expect(stdout, where).toContain("sessionId");
      expect(stdout, where).not.toMatch(/taskId/i);
      expect(run.err.join("\n"), where).not.toMatch(/taskId/i);
    }
    const start = await cli().run(["session", "start", "go", "--json"], { sessions: gateway });
    expect(Object.keys(JSON.parse(start.out.join("\n")))).not.toContain("taskId");
  });

  it("emits one object under --json, with no prose beside it", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--json", "--verbose"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload).toMatchObject({ sessionId: "session_1", ptyId: "pty_1", waited: false });
    // `--verbose` is the flag most likely to break the rule, so it is on here.
    expect(run.err.length).toBeGreaterThan(0);
  });

  it("blocks with --wait and reports the state the Core settled on", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--wait", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => ({ status: "finished", exited: true, exitCode: 0 }),
            screen: () => "the rendered transcript",
          }),
      }),
    });
    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload).toMatchObject({ waited: true, status: "finished", exited: true, exitCode: 0 });
    // The transcript rides along: the Core's replay ring dies with the PTY, so
    // a `--json` caller has no second chance at it.
    expect(payload.screen).toBe("the rendered transcript");
  });

  it("exits non-zero when the harness died, and zero when it stopped to ask", async () => {
    await withRegisteredCore();
    const died = await cli().run(["session", "start", "go", "--wait"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({ wait: async () => ({ status: "terminated", exited: true, exitCode: 137 }) }),
      }),
    });
    expect(died.code).toBe(EXIT_FAILURE);

    // A question is not a failure — a script that treated it as one could not
    // then answer it with `session send`.
    const asked = await cli().run(["session", "start", "go", "--wait"], {
      sessions: fakeSessionGateway({
        start: async () => fakeStartedSession({ wait: async () => ({ status: "needs-input", exited: false }) }),
      }),
    });
    expect(asked.code).toBe(EXIT_OK);
    expect(asked.err.join("\n")).toContain("needs-input");
  });

  it("passes --wait-timeout through as the SDK's deadline, and refuses it alone", async () => {
    await withRegisteredCore();
    let timeoutMs: number | undefined;
    const run = await cli().run(["session", "start", "go", "--wait", "--wait-timeout", "90"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async (opts) => {
              timeoutMs = opts.timeoutMs;
              return { status: "finished", exited: false };
            },
          }),
      }),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(timeoutMs).toBe(90_000);

    const alone = await cli().run(["session", "start", "go", "--wait-timeout", "90"], {
      sessions: fakeSessionGateway(),
    });
    expect(alone.code).toBe(EXIT_USAGE);
    expect(alone.err.join("\n")).toContain("only means something with --wait");
  });

  it("reports a wait that ran out as this side giving up, not as a status", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--wait", "--wait-timeout", "1", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => {
              throw new Error("session session_1 was still running after 1000ms");
            },
          }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.error).toContain("still running after");
    expect(payload.status).toBeUndefined();
  });

  it("checks the harness name before dialling", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "--harness", "emacs"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("claude-code");
  });

  it("refuses --cwd on start", async () => {
    registerCore(cli().paths, "prod");
    const run = await cli().run(["session", "start", "--cwd", "/tmp", "hi"], {
      sessions: fakeSessionGateway({
        start: async () => {
          throw new Error("start must not run");
        },
      }),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toMatch(/--cwd/i);
  });


  it("starts a Session on an existing conversation and reports it like `start`", async () => {
    await withRegisteredCore();
    let asked = "";
    const run = await cli().run(["session", "resume", "session_1", "carry on"], {
      sessions: fakeSessionGateway({
        resume: async (request) => {
          asked = request.sessionId;
          expect(request.prompt).toBe("carry on");
          return fakeStartedSession({ command: "claude --resume abc" });
        },
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(asked).toBe("session_1");
    expect(run.out).toEqual(["session_1"]);
  });

  it("passes the gateway's reason through when there is nothing to resume", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "resume", "session_1", "--json"], {
      sessions: fakeSessionGateway({
        resume: async () => {
          throw new SessionGatewayError("nothing-to-resume", "session session_1 has no harness session id on it");
        },
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.out.join("\n")).error).toContain("no harness session id");
    expect(run.err.join("\n")).toContain("actana session resume:");
  });

  it("does not take --harness: the harness is a fact about the conversation", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "resume", "session_1", "--harness", "codex"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
  });
});

describe("actana session logs", () => {
  it("prints the rendered screen, and the raw bytes only when asked", async () => {
    await withRegisteredCore();
    const logs = {
      sessionId: "session_1",
      ptyId: "pty_1",
      screen: "done: 3 files changed",
      raw: "[1GScanning…[1Gdone: 3 files changed",
    };
    const rendered = await cli().run(["session", "logs", "session_1"], {
      sessions: fakeSessionGateway({ logs: async () => logs }),
    });
    expect(rendered.code, rendered.err.join("\n")).toBe(EXIT_OK);
    expect(rendered.out.join("\n")).toBe("done: 3 files changed");

    const raw = await cli().run(["session", "logs", "session_1", "--raw"], {
      sessions: fakeSessionGateway({ logs: async () => logs }),
    });
    expect(raw.out.join("\n")).toContain("[1G");
  });

  it("puts the transcript in one JSON object, saying which form it is", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "logs", "session_1", "--json"], {
      sessions: fakeSessionGateway({
        logs: async () => ({ sessionId: "session_1", ptyId: "pty_1", screen: "a screen", raw: "raw" }),
      }),
    });
    expect(JSON.parse(run.out.join("\n"))).toEqual({
      sessionId: "session_1",
      ptyId: "pty_1",
      rendered: true,
      screen: "a screen",
    });
  });
});

describe("actana session wait, and send --wait (client #8): the report file settles a turn", () => {
  const REPORT_1 = "sessions/session_1/report-1.md";
  const REPORT_2 = "sessions/session_1/report-2.md";
  const FINISHED = `all done\n${END}\n`;

  /** A Core with one Session, whatever its status says, and a Shared folder that polls fast. */
  function world(status = "running") {
    const shared = fakeShared({ pollIntervalMs: 2 });
    const events: string[] = [];
    const gateway = fakeSessionGateway({
      list: async () => [row({ status, live: status === "running" })],
      send: async (_id, text, opts) => {
        events.push(`send ${JSON.stringify(text)} enter=${opts?.enter === true}`);
        return true;
      },
    });
    return { shared, events, gateway, folder: () => shared.folder() };
  }

  /** What the fake Shared folder was asked, minus the polling noise. */
  const reads = (w: ReturnType<typeof world>) => w.folder().calls.filter((c) => c.startsWith("get "));

  it("settles on a report that landed before the wait started, and prints its path", async () => {
    await withRegisteredCore();
    const w = world();
    w.folder().seed(REPORT_1, FINISHED);

    const run = await cli().run(["session", "wait", "session_1", "--wait-timeout", "2"], { sessions: w.gateway, shared: w.shared.open });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(run.out).toEqual([REPORT_1]);
    expect(run.err.join("\n")).toContain("Report landed: sessions/session_1/report-1.md");
    expect(reads(w)).toEqual([`get ${REPORT_1}`]);
  });

  it("settles when the report lands after the wait started, reading it only once it changed", async () => {
    await withRegisteredCore();
    const w = world();
    setTimeout(() => void w.folder().put(REPORT_1, FINISHED), 25);

    const run = await cli().run(["session", "wait", "session_1", "--wait-timeout", "2", "--json"], { sessions: w.gateway, shared: w.shared.open });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n"))).toEqual({
      sessionId: "session_1",
      turn: 1,
      reportPath: REPORT_1,
      waited: true,
      settled: true,
      report: FINISHED,
    });
    // One look when it began (nothing there) and one when the watcher said it changed: not a poll of the file.
    expect(reads(w)).toEqual([`get ${REPORT_1}`, `get ${REPORT_1}`]);
    expect(w.folder().calls.filter((c) => c.startsWith("watch")).length).toBeGreaterThan(1);
  });

  it("does not settle on a report without its end marker, and settles when it is finished", async () => {
    await withRegisteredCore();
    const w = world();
    setTimeout(() => void w.folder().put(REPORT_1, `halfway\n${END} is what I will write\n`), 15);
    setTimeout(() => void w.folder().put(REPORT_1, `halfway\n${END}\nbut then more\n`), 40);
    const finishedAt: number[] = [];
    setTimeout(() => {
      finishedAt.push(Date.now());
      void w.folder().put(REPORT_1, FINISHED);
    }, 70);

    const run = await cli().run(["session", "wait", "session_1", "--wait-timeout", "2", "--json"], { sessions: w.gateway, shared: w.shared.open });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n")).report).toBe(FINISHED);
    expect(finishedAt).toHaveLength(1);
  });

  it.each(["finished", "needs-input", "interrupted", "terminated", "disconnected", "ready"])(
    "is not settled by the Session's status (%s): with no report it runs out its own deadline",
    async (status) => {
      await withRegisteredCore();
      const w = world(status);

      const run = await cli().run(["session", "wait", "session_1", "--wait-timeout", "0.06", "--json"], {
        sessions: w.gateway,
        shared: w.shared.open,
      });

      expect(run.code).toBe(EXIT_FAILURE);
      const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
      expect(doc.settled).toBeUndefined();
      expect(String(doc.error)).toContain("did not appear with its end marker");
      expect(run.err.join("\n")).toContain("gave up after 0.06 seconds");
      expect(run.err.join("\n")).toContain("The Session is still running on the Core");
      // And the screen's `waitForTurnEnd` was never asked: the double has no wait to call.
    },
  );

  it("waits for the report of the turn it is told, and a stale earlier report does not settle it", async () => {
    await withRegisteredCore();
    const w = world();
    w.folder().seed(REPORT_1, FINISHED);

    const stale = await cli().run(["session", "wait", "session_1", "--turn", "2", "--wait-timeout", "0.05"], {
      sessions: w.gateway,
      shared: w.shared.open,
    });
    expect(stale.code).toBe(EXIT_FAILURE);
    expect(stale.err.join("\n")).toContain("sessions/session_1/report-2.md did not appear");

    setTimeout(() => void w.folder().put(REPORT_2, FINISHED), 20);
    const fresh = await cli().run(["session", "wait", "session_1", "--turn", "2", "--wait-timeout", "2"], {
      sessions: w.gateway,
      shared: w.shared.open,
    });
    expect(fresh.code, fresh.err.join("\n")).toBe(EXIT_OK);
    expect(fresh.out).toEqual([REPORT_2]);
  });

  it("without --turn means the latest report there is, or turn 1", async () => {
    await withRegisteredCore();
    const w = world();
    w.folder().seed(REPORT_1, FINISHED);
    w.folder().seed(REPORT_2, FINISHED);
    w.folder().seed("sessions/session_1/notes.md", "not a report");

    const latest = await cli().run(["session", "wait", "session_1", "--wait-timeout", "2"], { sessions: w.gateway, shared: w.shared.open });
    expect(latest.out).toEqual([REPORT_2]);

    const none = world();
    const first = await cli().run(["session", "wait", "session_1", "--wait-timeout", "0.04"], {
      sessions: none.gateway,
      shared: none.shared.open,
    });
    expect(first.err.join("\n")).toContain("sessions/session_1/report-1.md did not appear");
  });

  it("refuses a Session this Core does not have, instead of waiting for a file nothing will write", async () => {
    await withRegisteredCore();
    const w = world();

    const run = await cli().run(["session", "wait", "session_typo"], { sessions: w.gateway, shared: w.shared.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("this Core has no session session_typo");
    expect(w.shared.opened).toEqual([]);
  });

  it("says so, on stderr and with a failing exit code, when the Shared folder cannot be reached", async () => {
    await withRegisteredCore();
    const w = world();

    const run = await cli().run(["session", "wait", "session_1", "--json"], {
      sessions: w.gateway,
      shared: async () => {
        throw new Error("no shared capability");
      },
    });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("could not reach the Shared folder");
    expect(run.err.join("\n")).toContain("no shared capability");
    expect(JSON.parse(run.out.join("\n")).error).toContain("no shared capability");
  });

  it("closes the Shared handle it opened", async () => {
    await withRegisteredCore();
    const w = world();
    w.folder().seed(REPORT_1, FINISHED);

    await cli().run(["session", "wait", "session_1", "--wait-timeout", "2"], { sessions: w.gateway, shared: w.shared.open });

    expect(w.shared.closed.count).toBe(1);
  });

  it("refuses the flags it does not take, `--wait` included, and a bad --turn", async () => {
    await withRegisteredCore();
    for (const flag of ["--wait", "--enter", "--harness", "--raw"]) {
      const argv = flag === "--harness" ? ["--harness", "codex"] : [flag];
      const run = await cli().run(["session", "wait", "session_1", ...argv], { sessions: fakeSessionGateway() });
      // `--wait` is refused rather than accepted as a synonym for the verb's
      // own name: a flag that means nothing here would be a flag somebody
      // believed they set.
      expect(run.code, `${flag} was not refused`).toBe(EXIT_USAGE);
      expect(run.err.join("\n")).toContain(`${flag} does not apply here`);
    }
    for (const turn of ["0", "-1", "1.5", "two", "01"]) {
      const run = await cli().run(["session", "wait", "session_1", "--turn", turn], { sessions: fakeSessionGateway() });
      expect(run.code, turn).toBe(EXIT_USAGE);
      expect(run.err.join("\n"), turn).toContain("--turn wants a turn number from 1");
    }
  });

  it("needs a session id, and refuses a second argument", async () => {
    await withRegisteredCore();
    const bare = await cli().run(["session", "wait"], { sessions: fakeSessionGateway() });
    expect(bare.code).toBe(EXIT_USAGE);
    expect(bare.err.join("\n")).toContain("a session id is required");

    const extra = await cli().run(["session", "wait", "session_1", "session_2"], { sessions: fakeSessionGateway() });
    expect(extra.code).toBe(EXIT_USAGE);
    expect(extra.err.join("\n")).toContain('unexpected argument "session_2"');
  });

  describe("send --wait", () => {
    it("settles on the turn's report even when it landed while the text was being sent", async () => {
      await withRegisteredCore();
      const w = world();
      // The fastest harness there is: its report exists by the time the write returns.
      const gateway = fakeSessionGateway({
        list: async () => [row()],
        send: async (_id, text, opts) => {
          w.events.push(`send ${text}`);
          void opts;
          await w.folder().put(REPORT_2, FINISHED);
          return true;
        },
      });

      const run = await cli().run(["session", "send", "session_1", "carry", "on", "--enter", "--wait", "--wait-timeout", "2", "--json"], {
        sessions: gateway,
        shared: w.shared.open,
      });

      expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
      expect(JSON.parse(run.out.join("\n"))).toMatchObject({ turn: 2, reportPath: REPORT_2, settled: true });
    });

    it("takes the Shared cursor before it writes, and then waits on the watcher", async () => {
      await withRegisteredCore();
      const w = world();
      const order: string[] = [];
      const folder = w.folder();
      const watch = folder.watch.bind(folder);
      folder.watch = async (since) => {
        order.push(since === undefined ? "cursor" : "watch");
        return watch(since);
      };
      const gateway = fakeSessionGateway({
        send: async () => {
          order.push("write");
          setTimeout(() => void folder.put(REPORT_2, FINISHED), 15);
          return true;
        },
      });

      const run = await cli().run(["session", "send", "session_1", "go", "--wait", "--wait-timeout", "2"], { sessions: gateway, shared: w.shared.open });

      expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
      expect(order.indexOf("cursor")).toBeLessThan(order.indexOf("write"));
      expect(order.indexOf("write")).toBeLessThan(order.indexOf("watch"));
    });

    it("is not settled by a status either: no report, it gives up at its deadline", async () => {
      await withRegisteredCore();
      const w = world("finished");

      const run = await cli().run(
        ["session", "send", "session_1", "go on", "--wait", "--wait-timeout", "0.05", "--json"],
        { sessions: w.gateway, shared: w.shared.open },
      );

      expect(run.code).toBe(EXIT_FAILURE);
      const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
      expect(doc).toMatchObject({ waited: true, turn: 2, reportPath: REPORT_2 });
      expect(String(doc.error)).toContain("did not appear with its end marker");
      expect(doc.status).toBeUndefined();
      expect(run.err.join("\n")).toContain("Sent 5 characters and the report block");
    });

    it("does not wait, or print a document, when the Core declined the write", async () => {
      await withRegisteredCore();
      const w = world();

      const run = await cli().run(["session", "send", "session_1", "go", "--wait", "--wait-timeout", "5"], {
        sessions: fakeSessionGateway({ send: async () => false }),
        shared: w.shared.open,
      });

      expect(run.code).toBe(EXIT_FAILURE);
      expect(run.err.join("\n")).toContain("did not accept the write");
      expect(w.folder().calls.filter((c) => c.startsWith("get "))).toEqual([]);
    });

    it("needs a text, or a --turn, to wait for: a bare carriage return starts no report", async () => {
      await withRegisteredCore();
      const w = world();

      const run = await cli().run(["session", "send", "session_1", "--enter", "--wait"], { sessions: w.gateway, shared: w.shared.open });
      expect(run.code).toBe(EXIT_USAGE);
      expect(run.err.join("\n")).toContain("a bare carriage return starts no report");

      w.folder().seed(REPORT_1, FINISHED);
      const named = await cli().run(["session", "send", "session_1", "--enter", "--wait", "--turn", "1"], {
        sessions: w.gateway,
        shared: w.shared.open,
      });
      expect(named.code, named.err.join("\n")).toBe(EXIT_OK);
      expect(w.events).toEqual(["send \"\" enter=true"]);
    });
  });

  it("refuses --wait-timeout on a send that is not waiting", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "session_1", "go", "--wait-timeout", "90"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("only means something with --wait");
  });

  it("documents the contract in the help, and not the status wait", async () => {
    const help = (await cli().run(["session", "--help"])).out.join("\n");
    expect(help).toContain("sessions/<session-id>/report-<turn>.md");
    expect(help).toContain("ACT-REPORT-END");
    expect(help).toContain("through the Shared watcher");
    expect(help).toContain("this side gave up");
    expect(help).not.toContain("resolves on that turn's end");
    expect(help).not.toContain("the Core stamps the delivery");
  });
});

describe("actana session send", () => {
  /** The Shared folder every send needs, to number its turn from. */
  function sharedFolder(seed: Record<string, string> = {}): FakeShared {
    const shared = fakeShared();
    for (const [path, body] of Object.entries(seed)) shared.folder().seed(path, body);
    return shared;
  }
  const sendInto = (writes: Array<{ text: string; enter: boolean | undefined }>) =>
    fakeSessionGateway({
      send: async (_sessionId, text, opts) => {
        writes.push({ text, enter: opts?.enter });
        return true;
      },
    });

  it("writes the text and the standard block, once, as turn 2 when no report is there yet", async () => {
    await withRegisteredCore();
    const writes: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "session_1", "yes", "please"], {
      sessions: sendInto(writes),
      shared: sharedFolder().open,
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // Joined the way a shell already joined them, then the block of this turn: one write, no
    // carriage return, no second write, no timer (ADR 0026).
    expect(writes).toEqual([{ text: `yes please ${buildPromptBlock({ sessionId: "session_1", turn: 2 })}`, enter: false }]);
    expect(writes[0]!.text.match(/\[Actana standard block/g)).toHaveLength(1);
    expect(run.out).toEqual([]);
    expect(run.err.join("\n")).toContain("Sent 10 characters and the report block to session session_1.");
    expect(run.err.join("\n")).toContain("Turn 2: the report goes to sessions/session_1/report-2.md");
    expect(run.err.join("\n")).toContain("session wait session_1 --turn 2");
  });

  it("numbers the turn after the reports already there", async () => {
    await withRegisteredCore();
    const writes: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "session_1", "next", "--json"], {
      sessions: sendInto(writes),
      shared: sharedFolder({
        "sessions/session_1/report-1.md": `a\n${END}\n`,
        "sessions/session_1/report-2.md": `b\n${END}\n`,
        "sessions/session_1/notes.md": "x",
        "sessions/other/report-9.md": "another Session",
      }).open,
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(writes[0]!.text).toContain("~/shared/sessions/session_1/report-3.md");
    expect(JSON.parse(run.out.join("\n"))).toEqual({
      sessionId: "session_1",
      characters: 4,
      enter: false,
      delivered: true,
      turn: 3,
      reportPath: "sessions/session_1/report-3.md",
    });
  });

  it("takes the turn from --turn when it is given", async () => {
    await withRegisteredCore();
    const writes: Array<{ text: string; enter: boolean | undefined }> = [];
    await cli().run(["session", "send", "session_1", "again", "--turn", "7"], {
      sessions: sendInto(writes),
      shared: sharedFolder().open,
    });
    expect(writes[0]!.text).toContain("~/shared/sessions/session_1/report-7.md");
  });

  it("does not stack a second block on a text that already carries one", async () => {
    await withRegisteredCore();
    const writes: Array<{ text: string; enter: boolean | undefined }> = [];
    const carried = appendPromptBlock("redo it", { sessionId: "session_1", turn: 5 });
    await cli().run(["session", "send", "session_1", carried], { sessions: sendInto(writes), shared: sharedFolder().open });
    expect(writes[0]!.text).toBe(carried);
  });

  it("writes nothing when it cannot number the turn, and says why on stderr", async () => {
    await withRegisteredCore();
    const writes: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "session_1", "hello"], {
      sessions: sendInto(writes),
      shared: async () => {
        throw new Error("this Core keeps no Shared folder");
      },
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(writes).toEqual([]);
    expect(run.err.join("\n")).toContain("could not reach the Shared folder");
    expect(run.err.join("\n")).toContain("this Core keeps no Shared folder");
  });

  it("asks for the return in the same call, so the PTY is resolved once", async () => {
    await withRegisteredCore();
    const calls: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "session_1", "2", "--enter", "--json"], {
      sessions: sendInto(calls),
      shared: sharedFolder().open,
    });
    expect(run.code).toBe(EXIT_OK);
    // One call, not two: the gateway resolves the PTY once and writes both, so
    // there is no window in which the text lands and the return goes nowhere.
    // That the return is a *separate write* to that PTY is asserted against a
    // real Core in `in-process-core-session.test.ts`.
    expect(calls).toEqual([{ text: `2 ${buildPromptBlock({ sessionId: "session_1", turn: 2 })}`, enter: true }]);
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({ enter: true, delivered: true, turn: 2 });
  });

  it("refuses empty stdin rather than reporting a delivery it never made", async () => {
    await withRegisteredCore();
    // The Core is never reached, so the fixture's gateway would throw if it
    // were — which is the assertion: nothing claimed a write it did not do.
    const run = await cli().run(["session", "send", "session_1", "-"], {
      sessions: fakeSessionGateway(),
      stdin: "",
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("stdin was empty");
  });

  it("still sends a bare carriage return, with no block and no Shared folder, when stdin is empty and --enter was asked for", async () => {
    await withRegisteredCore();
    const calls: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "session_1", "-", "--enter"], {
      sessions: fakeSessionGateway({
        send: async (_sessionId, text, opts) => {
          calls.push({ text, enter: opts?.enter });
          return true;
        },
      }),
      stdin: "",
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(calls).toEqual([{ text: "", enter: true }]);
  });

  it("fails when the Core declined the write", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "session_1", "hello"], {
      sessions: fakeSessionGateway({ send: async () => false }),
      shared: sharedFolder().open,
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("did not accept the write");
  });

  it("needs something to send", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "session_1"], { sessions: fakeSessionGateway() });
    expect(run.code).toBe(EXIT_USAGE);
  });
});

describe("actana session kill", () => {
  it("kills by session id, which is all it ever knew about the Session", async () => {
    await withRegisteredCore();
    // Nothing local is consulted: this fixture has never started a Session, and
    // the verb still works — the ticket's "killing a session the CLI did not
    // start" criterion, at the surface level.
    let asked = "";
    const run = await cli().run(["session", "kill", "session_from_the_panel"], {
      sessions: fakeSessionGateway({
        kill: async (sessionId) => {
          asked = sessionId;
          return { ptyId: "pty_9", killed: true };
        },
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(asked).toBe("session_from_the_panel");
    expect(run.err.join("\n")).toContain("Killed session session_from_the_panel");
  });

  it("reports a Session with nothing running as such", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "kill", "session_1", "--json"], {
      sessions: fakeSessionGateway({
        kill: async () => {
          throw new SessionGatewayError("not-running", "session session_1 has no harness running");
        },
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.out.join("\n")).error).toContain("no harness running");
  });
});

describe("--json means only JSON on stdout", () => {
  it("holds for every verb, on the failing path too", async () => {
    await withRegisteredCore();
    const boom = () => async () => {
      throw new SessionGatewayError("refused", "the Core refused");
    };
    const gateway = fakeSessionGateway({
      list: boom(),
      start: boom(),
      resume: boom(),
      logs: boom(),
      send: boom(),
      kill: boom(),
    });

    for (const argv of [
      ["session", "ls", "--json", "--verbose"],
      ["session", "start", "go", "--json", "--verbose"],
      ["session", "resume", "session_1", "--json", "--verbose"],
      ["session", "logs", "session_1", "--json", "--verbose"],
      ["session", "send", "session_1", "hi", "--json", "--verbose"],
      ["session", "kill", "session_1", "--json", "--verbose"],
    ]) {
      const run = await cli().run(argv, { sessions: gateway, shared: fakeShared().open });
      expect(run.code, argv.join(" ")).toBe(EXIT_FAILURE);
      const parsed = JSON.parse(run.out.join("\n"));
      expect(parsed.error, argv.join(" ")).toBe("the Core refused");
      // And the human half went where it belongs.
      expect(run.err.join("\n"), argv.join(" ")).toContain("the Core refused");
    }
  });
});
