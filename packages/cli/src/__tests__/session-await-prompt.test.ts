// `--await-prompt`, the prompt-delivery report and the `SendResult` port (client issue 11).
//
// Ported from Control's in-repo CLI (`packages/cli/src/__tests__/session-command.test.ts` at
// origin/feat/0.5.0, actana/control #395, #483, #494, #495), adapted to what the client already
// changed: Sessions and no Projects, and a `send` that appends the report block unless `--no-block`
// is given. The gateway is injected, so every verb runs with no Core.
//
// Where a failure surfaces matters as much as that it does: these assert stderr and the exit code,
// and `--json` keeps stdout to one document.

import { describe, it, expect, afterEach } from "vitest";
import {
  fakeSessionGateway,
  fakeStartedSession,
  makeCliFixture,
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

async function withRegisteredCore(): Promise<void> {
  registerCore(cli().paths, "prod");
}

describe("actana session start: what the Core said about the prompt (--wait and --await-prompt)", () => {
  it("says the prompt did not land, and exits non-zero, when the Core abandoned it", async () => {
    // Issue 483. The status a lost prompt produces is `needs-input`, which the
    // test above proves is a zero exit on purpose — a harness that stopped to
    // ask a question did not fail. A harness that never received the prompt
    // did, and reporting it the same way is the false success the issue is
    // about: after #387 settles a stranded `ready` Session, this presents as a
    // settled Session that produced no report and nothing else.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--wait"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => ({ status: "needs-input", exited: false }),
            promptAbandoned: () => ({
              reason: "opencode composer never appeared within 90000 ms",
            }),
          }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("did not deliver the starting prompt");
    expect(err).toContain("opencode composer never appeared within 90000 ms");
    // And it says what to do about it, which is not what `needs-input` implies.
    expect(err).toContain("session send");
  });

  it("puts the delivery on the --json object as a field, not only in prose", async () => {
    await withRegisteredCore();
    const lost = await cli().run(["session", "start", "go", "--wait", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => ({ status: "needs-input", exited: false }),
            promptAbandoned: () => ({ reason: "blocked by folder-trust" }),
          }),
      }),
    });
    expect(lost.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(lost.out.join("\n"))).toMatchObject({
      status: "needs-input",
      promptDelivered: false,
      promptAbandonedReason: "blocked by folder-trust",
    });

    // The ordinary case says so too, so a script reads one field either way
    // rather than testing for a key's absence.
    const landed = await cli().run(["session", "start", "go", "--wait", "--json"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    const payload = JSON.parse(landed.out.join("\n"));
    expect(payload.promptDelivered).toBe(true);
    expect(payload.promptAbandonedReason).toBeUndefined();
  });

  // ─── `--await-prompt`: running is not the same fact as ready (#395) ────
  //
  // The defect this closes is a race with no error in it. `start` returns when
  // the Core has the Session running, which is before the harness can take a
  // keystroke; a `send` at that moment goes into a terminal that is not reading
  // and takes the starting prompt down with it. Both halves are tested: the
  // wait itself, and the fact that a `start` which does *not* wait stops
  // implying it established anything.

  it("waits for the Core to report the starting prompt delivered", async () => {
    await withRegisteredCore();
    let waitedForTurn = false;
    let askedForDelivery = false;
    const run = await cli().run(["session", "start", "go", "--await-prompt"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => {
              waitedForTurn = true;
              return { status: "finished", exited: false };
            },
            awaitPromptDelivery: async () => {
              askedForDelivery = true;
              return { outcome: "delivered" };
            },
          }),
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(askedForDelivery).toBe(true);
    // Emphatically **not** `--wait`. This is the short wait — the Session
    // becoming sendable — and a turn that runs for an hour is not part of it.
    expect(waitedForTurn).toBe(false);
    // `SID=$(actana session start "fix it" --await-prompt)` still works.
    expect(run.out).toEqual(["session_1"]);
    expect(run.err.join("\n")).toContain("session send session_1");
  });

  it("exits non-zero and says what stopped it when the Core gave the prompt up", async () => {
    // The whole point of gating on the Core's verdict rather than on a clock:
    // the answer can be "it did not land", and a zero exit there would be the
    // false success this train exists to remove.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--await-prompt"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            awaitPromptDelivery: async () => ({
              outcome: "abandoned",
              reason: "opencode composer never appeared within 90000 ms",
            }),
          }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("did not deliver the starting prompt");
    expect(err).toContain("opencode composer never appeared within 90000 ms");
  });

  it("does not call a lost connection a lost prompt", async () => {
    // `unavailable` is this side saying it stopped being able to hear, and it
    // must not be reported as the Core's verdict: the prompt may have landed a
    // second later, and telling an operator to send it again would put the text
    // in twice. Non-zero all the same — nothing was established.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--await-prompt", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            awaitPromptDelivery: async () => ({
              outcome: "unavailable",
              reason: "the connection to the Core went down",
            }),
          }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.promptDelivered).toBeNull();
    expect(payload.promptAbandonedReason).toBeUndefined();
    expect(payload.promptUnknownReason).toContain("went down");
  });

  it("answers promptDelivered null, never true, when --wait ended before the Core said anything", async () => {
    // The harness left before the Core decided: nobody adjudicated the prompt, and `true` there is
    // the false success this field exists to remove. Read without waiting, so `null` is the report.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--wait", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => ({ status: "finished", exited: true, exitCode: 0 }),
            promptDeliveryReport: () => null,
          }),
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.promptDelivered).toBeNull();
    expect(payload.exited).toBe(true);
  });

  it("puts the delivery on the --await-prompt --json object without a turn's fields", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--await-prompt", "--json"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload).toMatchObject({
      sessionId: "session_1",
      waited: false,
      awaitedPrompt: true,
      promptDelivered: true,
    });
    // No turn was awaited, so no turn's fields are invented for one.
    expect(payload.status).toBeUndefined();
  });

  it("says the prompt has not landed yet, and answers null rather than true, without the flag", async () => {
    // The other half of "must not claim readiness it has not established". A
    // bare start hangs up before the Core decides (#129 D6) — which is fine —
    // so it reports that it does not know, in prose and as a field.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--json"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    // `null`, not `false`: nobody reached a verdict, and `false` would be one.
    expect(payload.promptDelivered).toBeNull();
    expect(payload.waited).toBe(false);
    const err = run.err.join("\n");
    expect(err).toContain("has not been delivered yet");
    expect(err).toContain("--await-prompt");
  });

  it("says nothing about a prompt on a start that has none", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.err.join("\n")).not.toContain("has not been delivered yet");
  });

  it("does not call a prompt typed on a quiet screen a delivery", async () => {
    // #494 review, blocker 3, at the command's own layer: the report says the
    // Core typed without seeing a composer, and the exit code has to say the
    // same. `null` and not `false` — nothing was lost, nothing was established.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--await-prompt", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            harness: "codex",
            awaitPromptDelivery: async () => ({
              outcome: "unverified",
              reason: "it has no composer marker",
            }),
          }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.promptDelivered).toBeNull();
    expect(payload.composerObserved).toBe(false);
    expect(payload.promptAbandonedReason).toBeUndefined();

    // And the sentence, on the run that has room for one.
    const prose = await cli().run(["session", "start", "go", "--await-prompt"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            harness: "codex",
            awaitPromptDelivery: async () => ({
              outcome: "unverified",
              reason: "it has no composer marker",
            }),
          }),
      }),
    });
    expect(prose.code).toBe(EXIT_FAILURE);
    const err = prose.err.join("\n");
    expect(err).toContain("cannot vouch for where it landed");
    expect(err).toContain("codex");
  });

  it("says a composer was seen on the delivery it does call one", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "go", "--await-prompt", "--json"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({
      promptDelivered: true,
      composerObserved: true,
    });
  });

  it("refuses --await-prompt on a prompt the Core would drop before the harness", async () => {
    // #494 review, blocker 2, third case. `""` never leaves this package and
    // `"   "` is trimmed away by the Core's `sanitizeInitialInput`, so neither
    // produces a delivery, neither produces a row, and a wait for one runs
    // until the operator kills it. Refused on the same test the Core applies.
    await withRegisteredCore();
    for (const prompt of ["", "   ", "\t\n"]) {
      const run = await cli().run(["session", "start", prompt, "--await-prompt"], {
        sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
      });
      expect(run.code, `"${prompt}" was accepted`).toBe(EXIT_USAGE);
      expect(run.err.join("\n")).toContain("delivers none");
    }

    // And a prompt with something in it is still a prompt, spaces and all.
    const ok = await cli().run(["session", "start", " go ", "--await-prompt"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    expect(ok.code, ok.err.join("\n")).toBe(EXIT_OK);
  });

  it("refuses --await-prompt where there is no report for it to wait for", async () => {
    await withRegisteredCore();
    // No prompt: nothing is delivered, so nothing can be reported delivered.
    const bare = await cli().run(["session", "start", "--await-prompt"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    expect(bare.code).toBe(EXIT_USAGE);
    expect(bare.err.join("\n")).toContain("delivers none");

    // With `--wait`, which already reports the delivery and waits longer.
    const both = await cli().run(["session", "start", "go", "--await-prompt", "--wait"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    expect(both.code).toBe(EXIT_USAGE);
    expect(both.err.join("\n")).toContain("Pick one");

    // And no deadline of its own: the Core's per-harness ceiling is the bound,
    // and a second one here could only cut the wait short with nothing to say.
    const timed = await cli().run(
      ["session", "start", "go", "--await-prompt", "--wait-timeout", "5"],
      { sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }) },
    );
    expect(timed.code).toBe(EXIT_USAGE);
    expect(timed.err.join("\n")).toContain("bounds --wait, not --await-prompt");
  });
});

describe("actana session resume: the same report as start", () => {
  it("takes --await-prompt and prints the delivery", async () => {
    await withRegisteredCore();
    let resumed = "";
    const run = await cli().run(["session", "resume", "session_1", "go on", "--await-prompt", "--json"], {
      sessions: fakeSessionGateway({
        resume: async (request) => {
          resumed = request.sessionId;
          return fakeStartedSession();
        },
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(resumed).toBe("session_1");
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({
      awaitedPrompt: true,
      promptDelivered: true,
    });
  });

  it("exits non-zero when the Core gave the resumed prompt up, and says so on stderr", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "resume", "session_1", "go on", "--await-prompt"], {
      sessions: fakeSessionGateway({
        resume: async () =>
          fakeStartedSession({
            awaitPromptDelivery: async () => ({ outcome: "abandoned", reason: "composer never appeared" }),
          }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("composer never appeared");
  });

  it("refuses --await-prompt with no prompt, before dialling", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "resume", "session_1", "--await-prompt"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("delivers none");
  });

  it("says the prompt has not landed yet, and answers null, without the flag", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "resume", "session_1", "go on", "--json"], {
      sessions: fakeSessionGateway({ resume: async () => fakeStartedSession() }),
    });
    expect(JSON.parse(run.out.join("\n")).promptDelivered).toBeNull();
    expect(run.err.join("\n")).toContain("has not been delivered yet");
  });
});

describe("actana session send: a SendResult says which half of the write went missing", () => {
  it("refuses --await-prompt on send: the flag does not apply there", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "session_1", "hi", "--no-block", "--await-prompt"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("--await-prompt does not apply here");
  });

  it("fails when the Core declined the text, and says a resend is safe", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "session_1", "hello", "--no-block"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: false, failed: "text" }) }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("did not accept the write");
    expect(err).toContain("Nothing was written, so sending it again is safe");
  });

  it("tells a half-delivered send NOT to resend the text", async () => {
    await withRegisteredCore();
    // Two writes have three outcomes. The one a boolean could not express: the text is on the PTY
    // and the return is not. A resend now carries a return of its own and submits the text twice.
    const run = await cli().run(["session", "send", "session_1", "hello", "--no-block", "--enter"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: false, failed: "carriage-return" }) }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("took the text");
    expect(err).toContain("no turn was started");
    expect(err).toContain("do not send it again");
    expect(err).toContain("actana session send session_1 --enter");
    expect(err).not.toContain("Nothing was written");
  });

  it("does not tell a bare --enter not to resend text it never sent", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "session_1", "--enter"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: false, failed: "carriage-return" }) }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("did not accept the carriage return");
    expect(err).toContain("Nothing was written, so sending it again is safe");
    expect(err).not.toContain("took the text");
    expect(err).not.toContain("do not send it again");
  });

  it("carries `failed` in --json, and no `failed` key on a success", async () => {
    await withRegisteredCore();
    const half = await cli().run(["session", "send", "session_1", "hello", "--no-block", "--enter", "--json"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: false, failed: "carriage-return" }) }),
    });
    expect(half.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(half.out.join("\n"))).toMatchObject({
      enter: true,
      delivered: false,
      failed: "carriage-return",
    });

    const refused = await cli().run(["session", "send", "session_1", "hello", "--no-block", "--json"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: false, failed: "text" }) }),
    });
    expect(JSON.parse(refused.out.join("\n"))).toMatchObject({ delivered: false, failed: "text" });

    const fine = await cli().run(["session", "send", "session_1", "hello", "--no-block", "--json"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: true }) }),
    });
    const document = JSON.parse(fine.out.join("\n"));
    expect(document.delivered).toBe(true);
    expect(document.failed).toBeUndefined();
  });
});
