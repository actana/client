// Reaching a Core for the `session` noun (#129 D10, #160).
//
// The same seam `core-probe.ts` opened for `core status`, widened exactly as
// its header said it would be: one module that dials, so the noun above it —
// flags, tables, `--json` shapes, exit codes — is exercised by unit tests with
// no Core anywhere near them. Everything in this file is behind
// {@link OpenSessionGateway}, which `actana-cli-entry.ts` binds to the real
// implementation and the test harness binds to a fake.
//
// **This file is where the SDK is used, and it is used and not re-implemented.**
// Three rules that live here rather than in the command module, because they
// are properties of talking to a Core rather than of printing:
//
//   1. **The Core delivers prompts (ADR 0026, #129 D3).** A starting prompt is
//      handed to `CoreSession.start` as `prompt` and that is the whole of the
//      CLI's involvement. Nothing here waits for a harness to look ready,
//      re-sends anything, or presses Enter after a pause — no timer of any kind
//      appears in this package, and `src/__tests__/no-prompt-timing.test.ts` is
//      what keeps that true. A prompt that does not arrive is a Core bug, and a
//      client that papered over it would hide the bug from the one machine that
//      can fix it and would behave differently from every other client.
//   2. **A transcript is a screen, not a byte log.** `logs` renders the Core's
//      replay ring through the SDK's `TerminalScreen` — the same emulator the
//      session layer builds `screen()` from. A harness paints with cursor moves
//      and repaints one row eighty times a second; concatenating that stream
//      raw produces spinner soup, not a transcript. `--raw` still exists for a
//      caller piping into a terminal that will do the rendering itself.
//   3. **Idleness is the Core's report.** `--wait` is `CoreSession.waitForIdle`,
//      which watches the Core's event log for a status the Core decided on.
//      Nothing here inspects output for quietness.
//
// Everything this module hands back is plain data or a small object with
// methods — no `CoreClient`, no `CoreSession`, no frames escape it. That is
// what keeps `session-command.ts` free of the SDK and free of a socket.

import { CoreClient } from "@actana/sdk/core";
import {
  CoreSession,
  HARNESS_LAUNCH_COMMANDS,
} from "@actana/sdk/core";
import { TerminalScreen, DEFAULT_COLS, DEFAULT_ROWS } from "@actana/sdk/core";
import { harnessResumeCommand } from "./harness-resume.ts";
import type {
  CoreLinkPtySpawnHarness,
  CoreLinkSessionLockState,
  CoreLinkSessionRow,
} from "@actana/sdk/core";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";

/** The harnesses this build knows, in the order `--help` lists them. */
export const KNOWN_HARNESSES: readonly CoreLinkPtySpawnHarness[] = Object.keys(
  HARNESS_LAUNCH_COMMANDS,
) as CoreLinkPtySpawnHarness[];

/** The harness a `session start` gets when `--harness` is omitted. */
export const DEFAULT_HARNESS: CoreLinkPtySpawnHarness = "claude-code";

/** Is this string one of the harnesses the Core can be asked for? */
export function isKnownHarness(value: string): value is CoreLinkPtySpawnHarness {
  return (KNOWN_HARNESSES as readonly string[]).includes(value);
}

/**
 * What went wrong, in a vocabulary the command module can turn into a message
 * and an exit code without parsing English out of an SDK error.
 *
 * The kinds are the situations a person actually lands in, and each is a
 * different next step: a Session id that does not exist is a typo, a Session with
 * no live PTY is a harness that has already exited, a Session the harness never
 * reported a session id for has nothing to resume *from*, and a Session that is
 * already running is one to `send` to rather than start again. Anything the
 * Core refused for its own reasons arrives as `refused` carrying the Core's own
 * message — this side does not paraphrase a machine it is not on.
 */
export type SessionGatewayErrorKind =
  | "no-such-session"
  | "not-running"
  | "already-running"
  | "nothing-to-resume"
  | "refused";

export class SessionGatewayError extends Error {
  readonly kind: SessionGatewayErrorKind;
  constructor(kind: SessionGatewayErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionGatewayError";
    this.kind = kind;
  }
}

/** One row of `actana session ls`. */
export type SessionRow = {
  sessionId: string;
  title: string;
  /** The harness on the Session row, as the Core spells it. */
  harness: string;
  /** The Core's status for the Session — `running`, `finished`, `needs-input`, … */
  status: string;
  /** The live PTY, or null when nothing is running for this Session right now. */
  ptyId: string | null;
  /** Whether a harness process is running for this Session — `ptyId !== null`, named. */
  live: boolean;
  /**
   * Whether *this* client may write to the Session, and which of the three lock
   * states it is in — both null on a Core that does not publish lock state (ADR
   * 0024). Null is "this Core has no lock table", not "you may not write".
   */
  writable: boolean | null;
  lock: CoreLinkSessionLockState | null;
  updatedAt: number;
};

export type SessionStartRequest = {
  /** The starting prompt. Handed to the Core to deliver; never timed here. */
  prompt?: string;
  title?: string;
  /** `--harness`, or null for {@link DEFAULT_HARNESS}. */
  harness: CoreLinkPtySpawnHarness | null;
  dangerouslySkipPermissions: boolean;
};

export type SessionResumeRequest = {
  sessionId: string;
  prompt?: string;
  dangerouslySkipPermissions: boolean;
};

/** How a Session ended up, once the Core reported it settled. */
export type SessionOutcome = {
  /** One of the settled statuses — `finished`, `needs-input`, `interrupted`, … */
  status: string;
  /** True when the harness's process exited rather than settling on a status. */
  exited: boolean;
  exitCode?: number;
};

/**
 * A Session this invocation is connected to, and can wait on.
 *
 * `start` and `resume` produce one by spawning. `session wait` and `send --wait` no
 * longer attach to a harness: they settle on the report file in the Shared folder
 * (client #8, `session-report-wait.ts`), not on a status, so they do not go
 * through this type.
 */
export type StartedSession = {
  sessionId: string;
  ptyId: string;
  /**
   * The harness running in it, as the Core spells it.
   */
  harness: string | null;
  /**
   * The command the Core was asked to run, after defaulting.
   */
  command: string | null;
  /**
   * Will anything move this Session to `running` when a turn begins?
   *
   * The Core's answer for this Session, off the spawn (issue 84, issue 177
   * finding 4) — not a property of the harness family, because it depends on
   * which hooks actually landed on that machine and on whether the vendor
   * fires them. `false` for `cursor-cli` today: the Core writes
   * `.cursor/hooks.json` and cursor-agent never fires `beforeSubmitPrompt`.
   *
   * The CLI's job with it is to say so. `--wait` still works — turn *end* is
   * reported, which is what `waitForIdle` waits for — but everything between
   * the prompt and the stop is invisible, so a `session ls` run against a
   * working cursor Session shows the status it had before the turn began. An
   * operator told that is reading a quiet table correctly; one who is not has
   * no way to tell it from a harness that never started.
   */
  reportsTurnStart: boolean | null;
  /**
   * Block until the Core reports this Session settled.
   *
   * The SDK's wait, which is the Core's event log — see rule 3 in the header.
   * `timeoutMs` is a deadline the *operator* asked for (`--wait-timeout`) and
   * its expiry is an error, never a status invented here.
   *
   * A spawned Session has observed no status, so the first it hears is this
   * turn's. (`session wait` and `send --wait` do not use this: they wait for the
   * report file, client #8.)
   */
  wait(opts: { timeoutMs?: number }): Promise<SessionOutcome>;
  /** The rendered transcript, read while the Session is alive. */
  screen(): string;
  /** Release the listeners this Session holds. The harness keeps running. */
  dispose(): void;
};

/** What `actana session logs` reads back. */
export type SessionLogs = {
  sessionId: string;
  ptyId: string;
  /** The replay ring rendered as a terminal would show it, scrollback included. */
  screen: string;
  /** The same bytes unrendered, for a caller piping into a real terminal. */
  raw: string;
};

/** Everything the `session` noun asks of a Core, and nothing else. */
export type SessionGateway = {
  /** Every Session on this Core. Never filters by Project — there are none. */
  list(): Promise<SessionRow[]>;
  start(request: SessionStartRequest): Promise<StartedSession>;
  resume(request: SessionResumeRequest): Promise<StartedSession>;
  logs(sessionId: string): Promise<SessionLogs>;
  /**
   * Write text to a running Session, verbatim. Resolves false if the Core
   * declined. `enter` adds a carriage return as a **separate write to the same
   * PTY**, resolved once for both, so there is no window between them in which
   * the text lands and the return is sent somewhere else — or nowhere.
   */
  send(sessionId: string, text: string, opts?: { enter?: boolean }): Promise<boolean>;
  /** Kill the harness running for this Session, whoever started it. */
  kill(sessionId: string): Promise<{ ptyId: string; killed: boolean }>;
  close(): void;
};

/** How the `session` noun reaches a Core. Injected, so every verb is testable. */
export type OpenSessionGateway = (
  blob: CoreRegistrationBlob,
  opts: { timeoutMs: number },
) => Promise<SessionGateway>;

/**
 * The real gateway: connect, and hand back the verbs bound to that connection.
 *
 * Connecting here rather than per verb is deliberate — every `session` verb
 * needs a live socket, and a command that dialled twice would double the
 * latency of the fast path (`ls`) for no gain.
 */
export const openSessionGateway: OpenSessionGateway = async (blob, opts) => {
  const client = CoreClient.fromRegistrationBlob(blob, {
    connectTimeoutMs: opts.timeoutMs,
    requestTimeoutMs: opts.timeoutMs,
  });
  await client.connect();
  return sessionGatewayFor(client);
};

/**
 * Bind the session verbs to an already-connected client.
 *
 * Exported so a unit test can prove {@link SessionGateway.list} never dials a
 * Project frame — a 0.5.0 Core answers `projectsList` with "unhandled frame
 * type" (actana/control#555 / PR 618; CI run 36851520551).
 */
export function sessionGatewayFor(client: CoreClient): SessionGateway {
  return new CoreLinkSessionGateway(client);
}

class CoreLinkSessionGateway implements SessionGateway {
  constructor(private readonly client: CoreClient) {}

  async list(): Promise<SessionRow[]> {
    // Two reads because they answer two questions: `sessionsList` is the
    // Session view (status, the live PTY, this client's lock) and the Session rows
    // carry what a person reads a list by — the title and the harness. Neither
    // frame carries the other's fields. No `projectsList`: a 0.5.0 Core answers
    // that with "unhandled frame type" (actana/control#555 / PR 618).
    const [sessions, rows] = await Promise.all([
      this.client.sessionsList(),
      this.client.sessionRowsList(),
    ]);
    const bySessionRow = new Map(rows.sessions.map((row) => [row.sessionId, row]));

    return sessions.map((session) => {
      const row = bySessionRow.get(session.sessionId);
      return {
        sessionId: session.sessionId,
        title: row?.title ?? "(untitled)",
        harness: row?.agent ?? "(unknown)",
        status: session.status,
        ptyId: session.ptyId,
        live: session.ptyId !== null,
        writable: session.lock?.writable ?? null,
        lock: session.lock?.state ?? null,
        updatedAt: session.updatedAt,
      };
    });
  }

  async start(request: SessionStartRequest): Promise<StartedSession> {
    const harness = request.harness ?? DEFAULT_HARNESS;

    const session = await this.begin({
      harness,
      title: request.title ?? titleFor(request.prompt),
      prompt: request.prompt,
      dangerouslySkipPermissions: request.dangerouslySkipPermissions,
    });
    return wrap(session, { harness });
  }

  async resume(request: SessionResumeRequest): Promise<StartedSession> {
    const row = await this.findSessionRow(request.sessionId);

    // A Session with a live PTY is one that never stopped. Starting a second
    // harness on the same row would leave two processes writing one transcript
    // and one of them unreachable — `session send` and `session logs` resolve a
    // Session to *the* PTY, and there would be two.
    const live = await this.client.findBySession(row.sessionId);
    if (live.ptyId !== null) {
      throw new SessionGatewayError(
        "already-running",
        `session ${row.sessionId} is already running (pty ${live.ptyId})`,
      );
    }

    // The harness's own id for the conversation, written on the Session row by the
    // Core's hook pipeline. Absent means no harness ever reported one — there is
    // nothing to resume, and inventing an id would start a fresh Session while
    // claiming to have continued one.
    if (!row.claudeSessionId) {
      throw new SessionGatewayError(
        "nothing-to-resume",
        `session ${row.sessionId} has no harness session id on it — nothing was recorded to resume from`,
      );
    }
    if (!isKnownHarness(row.agent)) {
      throw new SessionGatewayError(
        "refused",
        `session ${row.sessionId} ran under "${row.agent}", which this build cannot start`,
      );
    }

    const session = await this.begin({
      sessionId: row.sessionId,
      harness: row.agent,
      command: harnessResumeCommand(row.agent, row.claudeSessionId, {
        dangerouslySkipPermissions: request.dangerouslySkipPermissions,
      }),
      prompt: request.prompt,
      dangerouslySkipPermissions: request.dangerouslySkipPermissions,
    });
    return wrap(session, { harness: row.agent });
  }

  async logs(sessionId: string): Promise<SessionLogs> {
    const ptyId = await this.livePty(sessionId);
    const replay = await this.client.replay(ptyId);

    // Rule 2 in the header, in four lines. The screen is built at the Core's own
    // default PTY size because the protocol carries no way to ask what size this
    // PTY actually is; a Session started at another size wraps differently here
    // than it does there, which is the one inaccuracy this verb has and the
    // reason `--raw` exists beside it.
    const terminal = new TerminalScreen({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    terminal.write(replay.data);
    return { sessionId, ptyId, screen: terminal.text(), raw: replay.data };
  }

  async send(sessionId: string, text: string, opts: { enter?: boolean } = {}): Promise<boolean> {
    // One resolution for the whole verb. Resolving again for the return would
    // open a window — the harness exits between the two round trips, the text
    // has landed, and the command reports a failure after a partial delivery.
    const ptyId = await this.livePty(sessionId);

    // Verbatim, and that is the whole verb. See rule 1: nothing is appended,
    // nothing is timed, nothing is retried. The return, when it was asked for,
    // is its own write of its own byte — never glued to the text.
    if (text.length > 0 && !(await this.client.write(ptyId, text))) return false;
    if (!opts.enter) return true;
    return this.client.write(ptyId, "\r");
  }

  async kill(sessionId: string): Promise<{ ptyId: string; killed: boolean }> {
    // Resolved through the Core by Session id, which is what makes killing a
    // Session this CLI did not start ordinary rather than special: the PTY
    // belongs to the Core, and every client names it the same way. The only
    // Session this refuses is one another client holds the write lock on, and
    // that refusal is the Core's (ADR 0024).
    const ptyId = await this.livePty(sessionId);
    const killed = await this.client.kill(ptyId);
    return { ptyId, killed };
  }

  close(): void {
    this.client.close();
  }

  /** Start a Session, translating the SDK's refusal into a gateway error. */
  private async begin(opts: {
    sessionId?: string;
    harness: CoreLinkPtySpawnHarness;
    title?: string;
    command?: string;
    prompt?: string;
    dangerouslySkipPermissions: boolean;
  }): Promise<CoreSession> {
    try {
      return await CoreSession.start(this.client, {
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.command ? { command: opts.command } : {}),
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        // Sent only when it is true: the Core allow-lists a harness's
        // skip-permissions flag *only* on a spawn that also set this option, so
        // the two travel together or not at all.
        ...(opts.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
        harness: opts.harness,
      });
    } catch (err) {
      throw new SessionGatewayError("refused", messageOf(err), { cause: err });
    }
  }

  /** The PTY running for this Session, or the reason there is none to act on. */
  private async livePty(sessionId: string): Promise<string> {
    const { ptyId } = await this.client.findBySession(sessionId);
    if (ptyId === null) {
      throw new SessionGatewayError(
        "not-running",
        `session ${sessionId} has no harness running — nothing to read from or write to`,
      );
    }
    return ptyId;
  }

  private async findSessionRow(sessionId: string): Promise<CoreLinkSessionRow> {
    const { sessions } = await this.client.sessionRowsList();
    const row = sessions.find((row) => row.sessionId === sessionId);
    if (!row) {
      throw new SessionGatewayError("no-such-session", `this Core has no session ${sessionId}`);
    }
    return row;
  }


}

/**
 * Present one `CoreSession` as a {@link StartedSession}.
 *
 * `harness` is passed in rather than read off the Session: a spawn knows it
 * because it asked for it.
 */
function wrap(
  session: CoreSession,
  opts: {
    harness: string | null;
  },
): StartedSession {
  return {
    sessionId: session.sessionId,
    ptyId: session.ptyId,
    harness: opts.harness,
    command: session.command,
    reportsTurnStart: session.reportsTurnStart,
    wait: async (waitOpts) => {
      const idle = await session.waitForTurnEnd({
        ...(waitOpts.timeoutMs ? { timeoutMs: waitOpts.timeoutMs } : {}),
      });
      return {
        status: idle.status,
        exited: idle.exited,
        ...(idle.exitCode === undefined ? {} : { exitCode: idle.exitCode }),
      };
    },
    screen: () => session.screen(),
    dispose: () => session.dispose(),
  };
}

/**
 * A Session title from the prompt, because "SDK session" — the SDK's own default —
 * is not a title anybody can pick out of `session ls`.
 *
 * First line, trimmed, and short enough to sit in a table column. A Session
 * started with no prompt gets a neutral name rather than an empty cell.
 */
function titleFor(prompt: string | undefined): string {
  const firstLine = (prompt ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  if (firstLine === undefined) return "actana session";
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
