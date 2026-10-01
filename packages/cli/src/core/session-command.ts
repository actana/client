// `actana session` — the Sessions running on a Core (#129 D10, #160).
//
//   actana session start [prompt]            start one; prints its id and exits
//   actana session ls                        what is running, and what settled
//   actana session logs <session>            the transcript, rendered
//   actana session resume <session> [prompt] pick a conversation back up
//   actana session send <session> <text>     type into a running Session, with the report block
//   actana session wait <session>            block until its report lands in the Shared folder (#8)
//   actana session kill <session>            stop the harness, whoever started it
//   actana session attach <session>          take the terminal (#163)
//
// Three rules this noun is built around. The first two are the ticket's, the
// third is what makes the other two usable from a script.
//
// **`attach` is the one verb that is a terminal**, and it lives in
// `session-attach.ts` because it is built out of things no other verb here needs
// — raw mode, a detach key, signal handling, and the Session write lock held for
// as long as it runs (ADR 0024 D3–D7). Everything below dials, prints and hangs
// up; that one takes the terminal and gives it back.
//
// **The Core delivers prompts (ADR 0026, #129 D3).** `start` hands its prompt to
// the SDK, which hands it to the Core, which waits for the harness's TUI to
// settle, answers whatever dialog it opened, and writes the prompt and the
// carriage return. Nothing in this package waits, retries, or presses Enter on
// a timer. `send` is a raw write too, with one addition (client #8): the standard
// block the Core appends to a starting prompt, because a follow-up turn does not
// go through the Core's delivery and the harness still has to be told where this
// turn's report goes.
// A prompt that goes missing is a Core bug and must be fixed there, where every
// client benefits; a client that compensated would hide it and would behave
// differently from the Panel doing the same thing.
//
// **A turn ends when its report file lands (client #8).** `wait` and `send --wait`
// settle on `sessions/<id>/report-<turn>.md` in the Core's Shared folder, ending
// with the marker, through the Shared watcher. They never read a screen or a
// status, and never run a command on the Core to look at the file.
//
// **A transcript is a screen.** `logs` renders the Core's replay ring through
// the SDK's terminal emulator, because a harness paints with cursor moves and
// repaints one row eighty times a second: the raw stream concatenates into
// spinner soup with the words jammed together. `--raw` hands over the bytes for
// a caller piping into a terminal that will render them itself.
//
// **`--json` means only JSON on stdout.** Every verb here writes exactly one
// JSON document to stdout under `--json` — including when it fails, where the
// document is `{"error": …}` — and every human line, every progress note and
// every warning goes to stderr. Without that rule each consumer has to strip
// prose out of a stream it is trying to parse.
//
// One more, which falls out of the last: **without `--json`, stdout carries the
// Session id and nothing else.** `SESSION=$(actana session start "fix it")` is
// the shape of every script that will ever use this, and it works with `--wait`
// as well as without it because the settled status goes to stderr too.

import { resolveCore } from "./core-resolution.ts";
import { formatJson, formatTable } from "../kit/cli-output.ts";
import { isKnownHarness, KNOWN_HARNESSES } from "./session-gateway.ts";
import type { SharedHandle } from "./shared-gateway.ts";
import { DEFAULT_WATCH_POLL_MS } from "./shared-gateway.ts";
import {
  appendPromptBlock,
  reportTurns,
  sessionReportFolder,
  sessionReportPath,
  turnForSend,
} from "./session-report.ts";
import { awaitReport, reportCursor, ReportWaitTimeoutError, type LandedReport } from "./session-report-wait.ts";
import { runSessionAttach } from "./session-attach.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";
import type { RegistryPaths } from "../registry/credentials.ts";
import type { ClientDeps } from "../kit/cli-deps.ts";
import type { ParsedArgs } from "../kit/cli-args.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";
import type {
  SessionGateway,
  SessionLogs,
  SessionOutcome,
  SessionRow,
  StartedSession,
} from "./session-gateway.ts";

/** How long a `session` verb waits for a Core to answer one request. */
const SESSION_TIMEOUT_MS = 30_000;

/**
 * The statuses that mean the Session did not end well.
 *
 * `--wait` exits non-zero on these and on a harness that exited non-zero, and
 * zero on everything else — `finished` obviously, but `needs-input` too: a
 * harness that stopped to ask a question did not fail, and a script that treats
 * a question as a failure cannot then answer it with `session send`.
 */
const UNHAPPY_STATUSES: ReadonlySet<string> = new Set(["terminated", "disconnected"]);

export const SESSION_HELP = `actana session — the Sessions running on a Core

Usage
  actana session start [prompt]             start a Session; prints its id
  actana session ls                         list Sessions on this Core
  actana session logs <session>             print the transcript, rendered
  actana session resume <session> [prompt]  start a Session that continues one
  actana session send <session> <text>      write text into a running Session, with the report block
  actana session wait <session>             block until the turn's report file lands
  actana session kill <session>             stop the harness running for it
  actana session attach <session>           watch a Session live, and type into it

Flags
  --core <name>       which registered Core to talk to
  --json              machine-readable output. Only JSON reaches stdout.
  --wait              start/resume: block until the Core reports it settled
                      send: block until the report of the turn that text starts lands
  --wait-timeout <s>  give up waiting after this many seconds, and say so
  --turn <n>          send/wait: which turn's report (default: send takes the next
                      turn; wait takes the latest one there is, or turn 1)
  --harness <name>    start: ${KNOWN_HARNESSES.join(", ")}
  --title <text>      start: what the Session is called in \`ls\`
  --raw               logs: the bytes, escape codes and all, unrendered
  --enter             send: follow the text with a carriage return
  --no-block          send: type the text as given, with no report block (to answer a dialog)
  --read-only         attach: watch without claiming the Session's write lock
  --dangerously-skip-permissions
                      start/resume: run the harness without permission prompts
  --verbose           explain the steps, on stderr. Never prints a blob.

A prompt or a text argument of \`-\` is read from stdin, so a long prompt can be
piped in:  cat brief.md | actana session start -

Sessions are the Core's, not this command's
  \`start\` exits as soon as the Core has the Session running, printing its id —
  the harness keeps going without this process (#129 D6). \`kill\`, \`send\` and
  \`logs\` name a Session by that id and work on any Session on the Core,
  including ones a Panel or another terminal started.

What \`logs\` can show you
  The Core's replay ring, which belongs to the harness's PTY — so a Session that
  has already exited has no transcript left to print, and the way to keep one is
  \`start --wait --json\`, whose object carries the screen as it settled.

Attaching, and who is allowed to type
  \`attach\` claims the Session's write lock. If another Core client already holds
  it — a Panel, an automation, a second terminal — you get a read-only view and
  a line saying so, never an error and never a takeover. Detaching gives the lock
  back, and so does this process dying: the Core releases a dropped connection's
  locks. Ctrl-] detaches; Ctrl-C goes to the harness.

Awaiting a turn
  A turn is over when its report file is in the Core's Shared folder and its last
  line is exactly \`ACT-REPORT-END\`. The report of a plain Session turn is
  \`sessions/<session-id>/report-<turn>.md\` (\`~/shared/…\` on the Core); the
  starting prompt is turn 1. \`wait\` and \`send --wait\` settle on that file
  through the Shared watcher: never on a screen, never on a status, and never by
  running a command on the Core to read the file. A report that landed before the
  wait began settles it at once.

  \`send <session> <text>\` appends the standard block to the text, naming the
  report path of that turn (the next one after the reports already there, so 2 at
  the first), the same block the Core appends to a starting prompt. With
  \`--wait\` it then waits for that report. Without it, it prints the turn, and
  \`wait <session> --turn <n>\` waits for it later.

  \`send --no-block\` types the text exactly as given: no block, no turn, no Shared
  folder. Use it to answer a Harness that stopped to ask (a permission or trust
  dialog), which is not a turn and has no report.

  \`wait <session>\` with no \`--turn\` waits for the latest report there is: a
  turn still being written, or the last one if it is complete. After a \`send\`
  that did not wait, say \`--turn\`: without it the answer is the previous turn's.

  The result: the report path on stdout, and with \`--json\` an object with
  \`sessionId\`, \`turn\`, \`reportPath\` and the \`report\` text. Read it again with
  \`actana shared get <reportPath>\`.

  A harness that writes no report runs out the \`--wait-timeout\` and the message
  says this side gave up. Without \`--wait-timeout\` there is no deadline: a turn
  takes as long as the work takes.

Who delivers the prompt
  The Core does (ADR 0026). It waits for the harness to settle, answers the
  dialog it opened, and writes the prompt, followed by the standard block. This CLI
  adds no timing of its own, and \`send\` writes the text it is given followed by
  that block — a lost prompt is a Core bug.`;

/** Dispatch a `session` verb. `args.positionals` still has the noun on the front. */
export async function runSessionCommand(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const [verb, ...rest] = args.positionals.slice(1);

  if (args.help || verb === undefined) {
    deps.out(SESSION_HELP);
    return verb === undefined && !args.help ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "start":
      return sessionStart(deps, args, paths, rest);
    case "ls":
    case "list":
      return sessionLs(deps, args, paths, rest);
    case "logs":
      return sessionLogs(deps, args, paths, rest);
    case "resume":
      return sessionResume(deps, args, paths, rest);
    case "send":
      return sessionSend(deps, args, paths, rest);
    case "wait":
      return sessionWait(deps, args, paths, rest);
    case "kill":
      return sessionKill(deps, args, paths, rest);
    case "attach": {
      // The flag check every other verb makes, made here rather than inside
      // `session-attach.ts`: the table of this noun's flags lives in this file,
      // and a second copy of it in the one verb that is a terminal is how the
      // two drift.
      const misused = misusedFlag(args, ["--read-only"]);
      if (misused) return usage(deps, "attach", misused);
      return runSessionAttach(deps, args, paths, rest);
    }
    default:
      deps.err(`actana session: unknown verb "${verb}".`);
      deps.err(
        "Verbs: start, ls, logs, resume, kill, send, wait, attach. `actana session --help` lists them.",
      );
      return EXIT_USAGE;
  }
}

// ─── The verbs ───────────────────────────────────────────────────────────────

/**
 * `actana session start [prompt]`.
 *
 * **Exits once the Core has the Session running** (#129 D6): the id goes to
 * stdout, the harness carries on without this process, and the socket closes.
 * `--wait` keeps the connection open until the Core reports the Session settled
 * — which is the Core's report off its event log, never a guess made here from
 * how quiet the output went.
 *
 * Takes a Core (via selection / `--core`), a harness (via `--harness` or
 * {@link DEFAULT_HARNESS}) and a prompt. There is no Project and no `--cwd`:
 * every Session starts in the Core's workspace (ADR 0041 D1–D2).
 */
async function sessionStart(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, [
    "--wait",
    "--wait-timeout",
    "--harness",
    "--title",
    "--dangerously-skip-permissions",
  ]);
  if (misused) return usage(deps, "start", misused);

  if (args.cwd !== null) {
    return usage(deps, "start", "`--cwd` is gone — every Session starts in the Core's workspace");
  }

  const timeout = waitTimeoutMs(args);
  if (timeout.error) return usage(deps, "start", timeout.error);

  const harness = args.harness;
  if (harness !== null && !isKnownHarness(harness)) {
    return usage(
      deps,
      "start",
      `unknown harness "${harness}". This build knows: ${KNOWN_HARNESSES.join(", ")}`,
    );
  }

  const prompt = await readText(deps, rest);
  if (prompt.error) return usage(deps, "start", prompt.error);

  return withGateway(deps, args, paths, "start", async (gateway) => {
    deps.verbose("starting a session");
    const session = await gateway.start({
      ...(prompt.text === null ? {} : { prompt: prompt.text }),
      ...(args.title === null ? {} : { title: args.title }),
      harness,
      dangerouslySkipPermissions: args.skipPermissions,
    });
    return reportStartedSession(deps, args, session, timeout.ms);
  });
}

/** `actana session resume <session> [prompt]` — a new harness on an old conversation. */
async function sessionResume(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, ["--wait", "--wait-timeout", "--dangerously-skip-permissions"]);
  if (misused) return usage(deps, "resume", misused);

  const [sessionId, ...promptWords] = rest;
  if (sessionId === undefined) {
    return usage(deps, "resume", "a session id is required — `actana session resume <session> [prompt]`");
  }

  const timeout = waitTimeoutMs(args);
  if (timeout.error) return usage(deps, "resume", timeout.error);

  const prompt = await readText(deps, promptWords);
  if (prompt.error) return usage(deps, "resume", prompt.error);

  return withGateway(deps, args, paths, "resume", async (gateway) => {
    deps.verbose(`resuming session ${sessionId}`);
    const session = await gateway.resume({
      sessionId,
      ...(prompt.text === null ? {} : { prompt: prompt.text }),
      dangerouslySkipPermissions: args.skipPermissions,
    });
    return reportStartedSession(deps, args, session, timeout.ms);
  });
}

/**
 * What `start` and `resume` print, which is the same thing because they produce
 * the same thing: a running Session, and a decision about whether to wait for it.
 */
async function reportStartedSession(
  deps: ClientDeps,
  args: ParsedArgs,
  session: StartedSession,
  timeoutMs: number | null,
): Promise<number> {
  try {
    deps.err(`Started ${session.harness} — session ${session.sessionId}, pty ${session.ptyId}.`);
    deps.verbose(`command: ${session.command}`);
    // Issue 177 finding 4, said out loud rather than left to be discovered.
    // Not `verbose`: an operator who has to know this is precisely one who has
    // not passed `-v`, and the line they would otherwise read is a `session
    // ls` that has not moved.
    if (!session.reportsTurnStart) deps.err(noTurnStartLine(session.harness));

    if (!args.wait) {
      // The one-shot default (#129 D6). The id is the whole of stdout, so it can
      // be captured; everything a person reads went to stderr above.
      //
      // The socket closes on the way out of `withGateway`, and the prompt has
      // almost certainly not been delivered yet — the Core waits for the
      // harness's screen to settle first. That is not a race this side has to
      // win: `initialInput` travelled with the spawn and delivery runs inside
      // the Core (ADR 0026 D2), which is exactly why a client can hang up.
      if (args.json) {
        deps.out(formatJson({ ...startedFields(session), waited: false }));
      } else {
        deps.out(session.sessionId);
      }
      return EXIT_OK;
    }

    return await awaitTurn(deps, args, session, timeoutMs);
  } finally {
    // Listeners on the client, released. The harness on the Core is untouched —
    // that is `session kill`.
    session.dispose();
  }
}

/**
 * Wait for a turn to end and print how it ended — the half `start`, `resume`,
 * `wait` and `send --wait` all share (#289 B).
 *
 * Shared on purpose, and it is what makes the promise "one result shape across
 * the commands" true rather than aspirational: there is one place that decides
 * what a settled Session prints, so a caller's parser cannot need a branch for
 * which verb produced the object.
 */
async function awaitTurn(
  deps: ClientDeps,
  args: ParsedArgs,
  session: StartedSession,
  timeoutMs: number | null,
): Promise<number> {
  deps.err("Waiting for the Core to report this session settled…");
  let outcome: SessionOutcome;
  try {
    outcome = await session.wait(timeoutMs === null ? {} : { timeoutMs });
  } catch (err) {
    // The only thing that reaches here is the deadline the operator asked for.
    // It is reported as what it is — this side gave up — rather than as a
    // status, because the Core never said one.
    const message = messageOf(err);
    if (args.json) deps.out(formatJson({ ...startedFields(session), waited: true, error: message }));
    deps.err(`actana session: ${message}`);
    return EXIT_FAILURE;
  }

  // Read while the Session is alive: a full-screen harness restores the main
  // buffer when it quits, and the main buffer is where nothing was printed.
  const screen = session.screen();

  if (args.json) {
    deps.out(
      formatJson({
        ...startedFields(session),
        waited: true,
        status: outcome.status,
        exited: outcome.exited,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        // The transcript rides along because a `--json` caller has no second
        // chance at it: the Core's replay ring lives with the PTY, so a
        // harness that exited takes its output with it and a later
        // `session logs` has nothing to answer with.
        screen,
      }),
    );
  } else {
    deps.out(session.sessionId);
    deps.err(settledLine(outcome));
    deps.err(`\`actana session logs ${session.sessionId}\` prints the transcript while the harness is running.`);
  }
  return settledWell(outcome) ? EXIT_OK : EXIT_FAILURE;
}

/**
 * `actana session wait <session>` — block until a turn's report lands in the Shared folder.
 *
 * **The primitive, and it ships as one** (#289 B, reworked by client #8): the verb settles on
 * `sessions/<id>/report-<turn>.md` ending with the marker, through the Shared watcher. It reads no
 * screen and no status, so a harness that reports nothing about its own turns settles it just the
 * same. With no `--turn` it means the latest report there is (a turn still being written, or the
 * last one if it is complete), or turn 1 when there is none; a report already there settles it at
 * once. After a `send` that did not wait, `--turn` names the turn that send printed.
 */
async function sessionWait(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, ["--wait-timeout", "--turn"]);
  if (misused) return usage(deps, "wait", misused);

  const [sessionId, ...extra] = rest;
  if (sessionId === undefined) {
    return usage(deps, "wait", "a session id is required — `actana session wait <session>`");
  }
  if (extra.length > 0) return usage(deps, "wait", `unexpected argument "${extra[0]}"`);

  // The verb *is* the wait, so `--wait-timeout` needs no `--wait` beside it —
  // and `--wait` is refused above rather than accepted as a synonym for the
  // verb's own name.
  const timeout = waitTimeoutMs(args, true);
  if (timeout.error) return usage(deps, "wait", timeout.error);
  const asked = turnFlag(args);
  if (asked.error) return usage(deps, "wait", asked.error);

  return withGateway(deps, args, paths, "wait", async (gateway, core) => {
    // A typo'd id would otherwise wait for a file nothing will write.
    const known = await gateway.list();
    if (!known.some((row) => row.sessionId === sessionId)) {
      return failed(deps, args, "wait", `this Core has no session ${sessionId}`);
    }
    return withShared(deps, args, "wait", core.blob, async (handle) => {
      const { shared } = handle;
      // The cursor first, then the folder: a report that lands in between is seen by the watch.
      const cursor = await reportCursor(shared);
      const turn = asked.turn ?? latestTurn(await listReportNames(shared, sessionId));
      deps.verbose(`waiting for ${sessionReportPath(sessionId, turn)}`);
      return awaitReportAndPrint(deps, args, handle, sessionId, turn, cursor, timeout.ms);
    });
  });
}

/** The Shared folder of the Core, opened for one verb and always closed. */
async function withShared(
  deps: ClientDeps,
  args: ParsedArgs,
  verb: string,
  blob: CoreRegistrationBlob,
  run: (handle: SharedHandle) => Promise<number>,
): Promise<number> {
  let handle: SharedHandle;
  try {
    handle = await deps.openShared(blob, { timeoutMs: SESSION_TIMEOUT_MS });
  } catch (err) {
    return failed(deps, args, verb, `could not reach the Shared folder of ${blob.endpoint} — ${messageOf(err)}`);
  }
  try {
    return await run(handle);
  } finally {
    handle.close();
  }
}

/** The file names in a Session's report folder. */
async function listReportNames(shared: SharedHandle["shared"], sessionId: string): Promise<string[]> {
  const entries = await shared.list(sessionReportFolder(sessionId));
  return entries.filter((entry) => entry.kind === "file").map((entry) => entry.path.split("/").pop() ?? "");
}

/** The latest turn there is a report file for, or turn 1 when there is none. */
function latestTurn(names: readonly string[]): number {
  return Math.max(1, ...reportTurns(names));
}

/** `--turn <n>`: a whole number from 1. */
function turnFlag(args: ParsedArgs): { turn: number | null; error?: string } {
  if (args.turn === null) return { turn: null };
  const turn = Number(args.turn);
  if (!/^[1-9][0-9]*$/.test(args.turn) || !Number.isSafeInteger(turn)) {
    return { turn: null, error: `--turn wants a turn number from 1, not "${args.turn}"` };
  }
  return { turn };
}

/** Wait for one turn's report and print how it went — what `wait` and `send --wait` share. */
async function awaitReportAndPrint(
  deps: ClientDeps,
  args: ParsedArgs,
  handle: SharedHandle,
  sessionId: string,
  turn: number,
  cursor: string,
  timeoutMs: number | null,
): Promise<number> {
  const reportPath = sessionReportPath(sessionId, turn);
  deps.err(`Waiting for ${reportPath} to land in the Shared folder…`);
  let landed: LandedReport;
  try {
    landed = await awaitReport(handle.shared, reportPath, {
      cursor,
      pollIntervalMs: handle.pollIntervalMs ?? DEFAULT_WATCH_POLL_MS,
      timeoutMs,
    });
  } catch (err) {
    const message = messageOf(err);
    if (args.json) {
      deps.out(formatJson({ sessionId, turn, reportPath, waited: true, error: message }));
    }
    deps.err(`actana session: ${message}`);
    // The one failure with a next step worth naming: it is this side's deadline, not a verdict.
    if (err instanceof ReportWaitTimeoutError) {
      deps.err(`\`actana session wait ${sessionId} --turn ${turn}\` waits again; \`actana session logs ${sessionId}\` shows the screen.`);
    }
    return EXIT_FAILURE;
  }

  if (args.json) {
    deps.out(formatJson({ sessionId, turn, reportPath, waited: true, settled: true, report: landed.body }));
  } else {
    deps.out(reportPath);
    deps.err(`Report landed: ${reportPath} (${new TextEncoder().encode(landed.body).byteLength} bytes). \`actana shared get ${reportPath}\` reads it.`);
  }
  return EXIT_OK;
}

/** `actana session ls` — every Session on the Core, newest first. */
async function sessionLs(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, []);
  if (misused) return usage(deps, "ls", misused);
  if (rest.length > 0) {
    return usage(
      deps,
      "ls",
      `unexpected argument "${rest[0]}" — Projects are gone; \`actana session ls\` lists every Session on the Core`,
    );
  }

  return withGateway(deps, args, paths, "ls", async (gateway) => {
    const rows = await gateway.list();
    rows.sort((a, b) => b.updatedAt - a.updatedAt);

    if (args.json) {
      deps.out(formatJson(rows));
      return EXIT_OK;
    }
    if (rows.length === 0) {
      deps.out("No sessions on this Core.");
      return EXIT_OK;
    }

    // The lock column appears only when the Core publishes lock state (ADR
    // 0024). A Core that predates it has no lock table, and a column of dashes
    // would read as "nobody may write" rather than "this Core does not answer
    // that question".
    const locks = rows.some((row) => row.lock !== null);
    const now = deps.now();
    const header = ["SESSION", "STATUS", "LIVE", "HARNESS", "TITLE", ...(locks ? ["LOCK"] : []), "AGE"];
    const table = formatTable(
      header,
      rows.map((row) => [
        row.sessionId,
        row.status,
        row.live ? "yes" : "",
        row.harness,
        row.title,
        ...(locks ? [lockCell(row)] : []),
        age(now, row.updatedAt),
      ]),
    );
    for (const line of table) deps.out(line);
    return EXIT_OK;
  });
}

/**
 * `actana session logs <session>` — the transcript, as a terminal would show it.
 *
 * Rendered, not raw: see the module header. What it can print is what the Core
 * still holds, and the Core holds a Session's output in a ring that belongs to
 * the PTY — so a harness that has already exited has no logs to give, which is
 * what `not-running` says.
 */
async function sessionLogs(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, ["--raw"]);
  if (misused) return usage(deps, "logs", misused);

  const [sessionId, ...extra] = rest;
  if (sessionId === undefined) {
    return usage(deps, "logs", "a session id is required — `actana session logs <session>`");
  }
  if (extra.length > 0) return usage(deps, "logs", `unexpected argument "${extra[0]}"`);

  return withGateway(deps, args, paths, "logs", async (gateway) => {
    const logs: SessionLogs = await gateway.logs(sessionId);
    deps.verbose(`read the replay ring of pty ${logs.ptyId}`);

    if (args.json) {
      deps.out(
        formatJson({
          sessionId: logs.sessionId,
          ptyId: logs.ptyId,
          rendered: !args.raw,
          screen: args.raw ? logs.raw : logs.screen,
        }),
      );
      return EXIT_OK;
    }
    const body = args.raw ? logs.raw : logs.screen;
    for (const line of body.split("\n")) deps.out(line);
    return EXIT_OK;
  });
}

/**
 * `actana session send <session> <text>` — the equivalent of typing, plus the report block.
 *
 * The text is written as given, followed by the standard block (client #8): the one-line text the
 * Core appends to a starting prompt, naming where this turn's report goes. A follow-up turn does
 * not pass through the Core's delivery (ADR 0026, #404), so without it the harness would not know.
 * `--enter` adds a second write of a carriage return **because the operator asked for one** — no
 * pause between them, no waiting for the harness to look ready. Both writes go to one PTY resolved
 * once. A *starting* prompt goes through `session start`, where the Core owns the schedule and
 * appends the block itself.
 *
 * The turn is numbered from the reports already in the Shared folder, and the Shared cursor is taken
 * *before* anything is written, so a report that lands at once is not missed. `--wait` then settles
 * on that turn's report, through the Shared watcher, and not on a status.
 */
async function sessionSend(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, ["--enter", "--wait", "--wait-timeout", "--turn", "--no-block"]);
  if (misused) return usage(deps, "send", misused);

  const [sessionId, ...words] = rest;
  if (sessionId === undefined) {
    return usage(deps, "send", "a session id is required — `actana session send <session> <text>`");
  }
  const timeout = waitTimeoutMs(args);
  if (timeout.error) return usage(deps, "send", timeout.error);
  const asked = turnFlag(args);
  if (asked.error) return usage(deps, "send", asked.error);
  const read = await readText(deps, words);
  if (read.error) return usage(deps, "send", read.error);
  if (read.text === null && !args.enter) {
    return usage(
      deps,
      "send",
      "nothing to send — pass text, `-` to read stdin, or --enter for a bare carriage return",
    );
  }
  if (read.text === "" && !args.enter) {
    // Empty stdin, and nothing else asked for. Reporting a delivery here would
    // be a lie in the one direction that matters: no Core was contacted, no
    // Session was proved to exist, and nothing was written.
    return usage(
      deps,
      "send",
      "nothing to send — stdin was empty; pass --enter to send a bare carriage return",
    );
  }
  const text = read.text ?? "";
  if (args.noBlock && (args.wait || args.turn !== null)) {
    // No block means no report was asked for, so there is no turn to number or to wait on.
    return usage(deps, "send", "--no-block asks for no report, so it does not combine with --wait or --turn");
  }
  if (text.length === 0 && args.wait && asked.turn === null) {
    // A bare carriage return carries no block, so it names no report to wait for.
    return usage(deps, "send", "a bare carriage return starts no report — name the turn to wait for with --turn");
  }

  return withGateway(deps, args, paths, "send", async (gateway, core) => {
    // A bare carriage return, or text sent with --no-block (an answer to a dialog), is not a
    // turn: no block, no report to number, and no Shared folder needed.
    if ((text.length === 0 || args.noBlock) && !args.wait) {
      return deliverAndReport(deps, args, gateway, sessionId, text, null);
    }

    return withShared(deps, args, "send", core.blob, async (handle) => {
      const { shared } = handle;
      // Before anything is written: a report that lands at once is then after this cursor.
      const cursor = await reportCursor(shared);
      const turn = asked.turn ?? turnForSend(await listReportNames(shared, sessionId));
      const body = text.length === 0 ? text : appendPromptBlock(text, { sessionId, turn });

      deps.verbose(`sending ${text.length} characters and the report block (turn ${turn}) to session ${sessionId}`);
      const code = await deliverAndReport(deps, args, gateway, sessionId, body, { turn, characters: text.length });
      if (code !== EXIT_OK || !args.wait) return code;
      return awaitReportAndPrint(deps, args, handle, sessionId, turn, cursor, timeout.ms);
    });
  });
}

/** Write the text (and the return, if asked), and say what was sent. */
async function deliverAndReport(
  deps: ClientDeps,
  args: ParsedArgs,
  gateway: SessionGateway,
  sessionId: string,
  body: string,
  turn: { turn: number; characters: number } | null,
): Promise<number> {
  // One call, one PTY resolution, both writes (#204 review). The command no
  // longer decides anything about the return beyond passing on the flag.
  const delivered = await gateway.send(sessionId, body, { enter: args.enter });
  const characters = turn?.characters ?? body.length;
  const andReturn = args.enter ? " and a carriage return" : "";

  if (args.wait && delivered) {
    // The wait prints the one document; this line is for a person.
    deps.err(`Sent ${characters} characters${turn ? " and the report block" : ""} to session ${sessionId}${andReturn}.`);
  } else if (args.json) {
    deps.out(
      formatJson({
        sessionId,
        characters,
        enter: args.enter,
        delivered,
        ...(turn ? { turn: turn.turn, reportPath: sessionReportPath(sessionId, turn.turn) } : {}),
      }),
    );
  } else if (delivered) {
    deps.err(`Sent ${characters} characters${turn ? " and the report block" : ""} to session ${sessionId}${andReturn}.`);
    if (turn) {
      deps.err(
        `Turn ${turn.turn}: the report goes to ${sessionReportPath(sessionId, turn.turn)}; ` +
          `\`actana session wait ${sessionId} --turn ${turn.turn}\` waits for it.`,
      );
    }
  }
  if (!delivered) {
    deps.err(`actana session send: the Core did not accept the write to session ${sessionId}.`);
    return EXIT_FAILURE;
  }
  return EXIT_OK;
}

/**
 * `actana session kill <session>`.
 *
 * **Works on a Session this CLI did not start**, which is the point of naming
 * Sessions by Session id: the PTY belongs to the Core, and a Panel, a cron job and
 * this command all name it the same way. Nothing about having started a Session
 * is remembered locally, so there is nothing here that could fail to recognise
 * one.
 */
async function sessionKill(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, []);
  if (misused) return usage(deps, "kill", misused);

  const [sessionId, ...extra] = rest;
  if (sessionId === undefined) {
    return usage(deps, "kill", "a session id is required — `actana session kill <session>`");
  }
  if (extra.length > 0) return usage(deps, "kill", `unexpected argument "${extra[0]}"`);

  return withGateway(deps, args, paths, "kill", async (gateway) => {
    const { ptyId, killed } = await gateway.kill(sessionId);
    if (args.json) {
      deps.out(formatJson({ sessionId, ptyId, killed }));
    } else if (killed) {
      deps.err(`Killed session ${sessionId} (pty ${ptyId}).`);
    }
    if (!killed) {
      deps.err(`actana session kill: the Core did not kill session ${sessionId}.`);
      return EXIT_FAILURE;
    }
    return EXIT_OK;
  });
}

// ─── The plumbing every verb shares ──────────────────────────────────────────

/**
 * Resolve the Core, open one connection, run the verb, and always hang up.
 *
 * Also the single place a {@link SessionGatewayError} becomes a message and an
 * exit code, so no verb writes its own version of "the Core refused" and every
 * one of them obeys the `--json` rule on the failure path as well as the happy
 * one — which is the path that usually forgets.
 */
async function withGateway(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  verb: string,
  run: (gateway: SessionGateway, core: { blob: CoreRegistrationBlob }) => Promise<number>,
): Promise<number> {
  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: args.core });
  if (!resolved.ok) return failed(deps, args, verb, resolved.error);

  deps.verbose(`dialling ${resolved.core.blob.endpoint}`);
  let gateway: SessionGateway;
  try {
    gateway = await deps.openSessions(resolved.core.blob, { timeoutMs: SESSION_TIMEOUT_MS });
  } catch (err) {
    return failed(deps, args, verb, `${resolved.core.blob.endpoint} did not answer — ${messageOf(err)}`);
  }

  try {
    return await run(gateway, resolved.core);
  } catch (err) {
    // Every failure here, not only the gateway's own kinds: a Core that answers
    // a frame with an error, or a link that drops mid-command, arrives as the
    // SDK's plain `Error`. Letting those through would exit on the entry file's
    // last-resort handler — which prints a message, but after `--json` has
    // already promised a document and produced none.
    return failed(deps, args, verb, messageOf(err));
  } finally {
    gateway.close();
  }
}

/** One failure, reported the same way every time: JSON on stdout, prose on stderr. */
function failed(deps: ClientDeps, args: ParsedArgs, verb: string, message: string): number {
  if (args.json) deps.out(formatJson({ error: message }));
  deps.err(`actana session ${verb}: ${message}`);
  return EXIT_FAILURE;
}

/** A command line this verb cannot act on. Never dials, so `--json` gets no document. */
function usage(deps: ClientDeps, verb: string, message: string): number {
  deps.err(`actana session ${verb}: ${message}.`);
  return EXIT_USAGE;
}

/** The session flags, and how to tell whether one was used. */
const SESSION_FLAGS: ReadonlyArray<{ name: string; used: (args: ParsedArgs) => boolean }> = [
  { name: "--wait", used: (args) => args.wait },
  { name: "--wait-timeout", used: (args) => args.waitTimeout !== null },
  { name: "--turn", used: (args) => args.turn !== null },
  { name: "--harness", used: (args) => args.harness !== null },
  { name: "--cwd", used: (args) => args.cwd !== null },
  { name: "--title", used: (args) => args.title !== null },
  { name: "--raw", used: (args) => args.raw },
  { name: "--no-block", used: (args) => args.noBlock },
  { name: "--enter", used: (args) => args.enter },
  { name: "--dangerously-skip-permissions", used: (args) => args.skipPermissions },
  { name: "--read-only", used: (args) => args.readOnly },
];

/**
 * The first flag that was passed to a verb that does not take it, or null.
 *
 * Rejected rather than ignored, because every one of these flags changes what
 * the operator expects to happen: `--wait` on `kill`, or `--harness` on
 * `resume` (whose harness is a fact about the conversation being resumed, not a
 * choice), read as instructions that were silently dropped.
 */
function misusedFlag(args: ParsedArgs, accepted: readonly string[]): string | null {
  for (const flag of SESSION_FLAGS) {
    if (flag.used(args) && !accepted.includes(flag.name)) {
      return `${flag.name} does not apply here`;
    }
  }
  return null;
}

/**
 * `--wait-timeout <seconds>`, in milliseconds.
 *
 * Only with `--wait`, because on its own it is an instruction that cannot be
 * carried out — and a deadline somebody believes they set is worse than no
 * deadline at all. The wait it bounds is the SDK's; nothing here counts time.
 */
function waitTimeoutMs(
  args: ParsedArgs,
  waiting: boolean = args.wait,
): { ms: number | null; error?: string } {
  if (args.waitTimeout === null) return { ms: null };
  // `waiting` is for the one verb that *is* a wait: `session wait` takes no
  // `--wait` (the verb says it), so its deadline cannot be gated on the flag.
  if (!waiting) return { ms: null, error: "--wait-timeout only means something with --wait" };
  const seconds = Number(args.waitTimeout);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ms: null, error: `--wait-timeout wants a number of seconds, not "${args.waitTimeout}"` };
  }
  return { ms: Math.round(seconds * 1000) };
}

/**
 * A prompt or a `send` text: the words as typed, or stdin when it is `-`.
 *
 * Words are joined with single spaces, which is what a shell has already done
 * to anything unquoted — so `session send s1 yes please` sends `yes please`
 * rather than failing over an argument the operator did not think of as a
 * second one. `-` is the conventional stdin marker, and it is what
 * a prompt longer than a command line arrives by.
 */
async function readText(
  deps: ClientDeps,
  words: string[],
): Promise<{ text: string | null; error?: string }> {
  if (words.length === 0) return { text: null };
  if (words.length === 1 && words[0] === "-") {
    if (deps.stdinIsTty) {
      return { text: null, error: "`-` reads stdin, and nothing is piped in" };
    }
    deps.verbose("reading the text from stdin");
    return { text: await deps.readStdin() };
  }
  return { text: words.join(" ") };
}

/**
 * What a caller is told when nothing will report this Session's turn starting.
 *
 * The Panel answers the same gap with a terminal-input fallback — it watches
 * the keystrokes going into the pane and calls an Enter the start of a turn.
 * A CLI has no equivalent: `start` hands the prompt to the Core and hangs up
 * (#129 D6), so there is no keystroke stream here to watch and inventing a
 * `running` this side never observed would be a status the Core did not say.
 *
 * So the asymmetry is printed instead. The sentence names what still works,
 * because the failure this prevents is an operator reading a stalled `session
 * ls` as a stalled harness and killing a Session that was working.
 */
function noTurnStartLine(harness: string | null): string {
  return (
    `Note: ${harness ?? "this harness"} does not report the start of a turn, so this session ` +
    `will not show as running until it stops. \`--wait\` and \`session logs\` ` +
    `are unaffected.`
  );
}

/** The identity fields `start` and `resume` report, in both output modes. */
function startedFields(session: StartedSession): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    ptyId: session.ptyId,
    harness: session.harness,
    command: session.command,
    // In `--json` too, and unconditionally: a script deciding whether a quiet
    // status means "still working" or "never started" needs the answer as a
    // field, not as a sentence on stderr it would have to parse.
    reportsTurnStart: session.reportsTurnStart,
  };
}

/** Did the Session settle in a way a script should call success? */
function settledWell(outcome: SessionOutcome): boolean {
  if (UNHAPPY_STATUSES.has(outcome.status)) return false;
  return !outcome.exited || (outcome.exitCode ?? 0) === 0;
}

function settledLine(outcome: SessionOutcome): string {
  if (outcome.exited) {
    return `The harness exited with code ${outcome.exitCode ?? 0} (status: ${outcome.status}).`;
  }
  return `The Core reports this session ${outcome.status}.`;
}

/** How a Session's lock reads in a table cell. */
function lockCell(row: SessionRow): string {
  switch (row.lock) {
    case "held-by-you":
      return "you";
    case "held-by-another":
      return "other";
    case "unlocked":
      return "free";
    default:
      return "";
  }
}

/**
 * How long ago, in the shortest unit that still says something.
 *
 * A table is read by eye and `2h` is what the eye wants; the exact epoch stays
 * on the `--json` row for anything that is going to compute with it.
 */
function age(now: number, updatedAt: number): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
