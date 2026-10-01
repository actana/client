// The report contract of client #8, as pure functions: where a report lives in the Shared folder,
// what ends it, and the block of prompt text that tells a harness both.
//
// A harness hands work back by writing a file under the Core's Shared folder (`~/shared`), and the
// Shared watcher is how this side learns it landed. Paths here are relative to the Shared folder,
// which is what `CoreShared` takes; the Core's block names the same file from the home (`~/shared/…`).
//
//   a plain Session turn   sessions/<session-id>/report-<turn>.md
//   a Task                 tasks/<task-id>/success.md | fail.md | partial-<n>.md, and attempt-<n>.log
//   a re-run               the older results are renamed to attempt-<n>-<name>
//
// **The block text is the Core's.** `buildPromptBlock` reproduces, word for word, what the Core
// appends to a Session's starting prompt (control `packages/core/src/prompt-standard-block.ts`,
// PR 621). A follow-up turn is a raw write, so `session send` appends the same block itself, with
// the turn's own report path. If the two texts ever disagree the harness is told two things; the
// test pins this one to the Core's, and a change on either side bumps `PROMPT_BLOCK_VERSION`.

/** The fixed last line a report ends with. A watcher settles on it. */
export const REPORT_END_MARKER = "ACT-REPORT-END";

/** Bumped by the Core with any wording change; this copy follows it. */
export const PROMPT_BLOCK_VERSION = 1;

/** The folder every Session's reports live under, relative to the Shared folder. */
export function sessionReportFolder(sessionId: string): string {
  return `sessions/${sessionId}/`;
}

/** Where a plain Session turn writes its report, relative to the Shared folder. */
export function sessionReportPath(sessionId: string, turn: number): string {
  return `sessions/${sessionId}/report-${turn}.md`;
}

/** The same file as the harness is told it, from its home directory. */
export function sessionReportPathFromHome(sessionId: string, turn: number): string {
  return `shared/${sessionReportPath(sessionId, turn)}`;
}

/** The turn a file name is the report of, or null when it is not a report name. */
export function sessionReportTurn(name: string): number | null {
  const match = /^report-([1-9][0-9]*)\.md$/.exec(name);
  if (match === null) return null;
  const turn = Number(match[1]);
  return Number.isSafeInteger(turn) ? turn : null;
}

/** A Task's folder, relative to the Shared folder. */
export function taskFolder(taskId: string): string {
  return `tasks/${taskId}/`;
}

export type TaskResult = { kind: "success" } | { kind: "fail" } | { kind: "partial"; n: number };

/** The file a Task's result is written to: `success.md`, `fail.md` or `partial-<n>.md`. */
export function taskResultPath(taskId: string, result: TaskResult): string {
  const name =
    result.kind === "partial" ? `partial-${result.n}.md` : result.kind === "success" ? "success.md" : "fail.md";
  return `tasks/${taskId}/${name}`;
}

/** The log of one attempt of a Task. */
export function taskAttemptLogPath(taskId: string, attempt: number): string {
  return `tasks/${taskId}/attempt-${attempt}.log`;
}

/** What an older result is renamed to when a Task runs again: `success.md` becomes `attempt-1-success.md`. */
export function archivedTaskName(attempt: number, name: string): string {
  return `attempt-${attempt}-${name}`;
}

/** A Task folder entry, told apart: a current result, an archived one, an attempt log, or none of these. */
export type TaskEntry =
  | { kind: "result"; result: TaskResult }
  | { kind: "archived"; attempt: number; result: TaskResult }
  | { kind: "log"; attempt: number }
  | { kind: "other" };

function taskResultOfName(name: string): TaskResult | null {
  if (name === "success.md") return { kind: "success" };
  if (name === "fail.md") return { kind: "fail" };
  const partial = /^partial-([1-9][0-9]*)\.md$/.exec(name);
  return partial === null ? null : { kind: "partial", n: Number(partial[1]) };
}

export function classifyTaskEntry(name: string): TaskEntry {
  const current = taskResultOfName(name);
  if (current !== null) return { kind: "result", result: current };
  const log = /^attempt-([1-9][0-9]*)\.log$/.exec(name);
  if (log !== null) return { kind: "log", attempt: Number(log[1]) };
  const archived = /^attempt-([1-9][0-9]*)-(.+)$/.exec(name);
  if (archived !== null) {
    const result = taskResultOfName(archived[2]!);
    if (result !== null) return { kind: "archived", attempt: Number(archived[1]), result };
  }
  return { kind: "other" };
}

/** Is this the body of a finished report: its last non-blank line exactly the end marker? */
export function reportIsComplete(body: string): boolean {
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.replace(/\r$/, "").trimEnd();
    if (line === "") continue;
    return line === REPORT_END_MARKER;
  }
  return false;
}

const BLOCK_OPEN = `[Actana standard block v${PROMPT_BLOCK_VERSION}]`;
const BLOCK_CLOSE = `[/Actana standard block v${PROMPT_BLOCK_VERSION}]`;

/** The block the Core appends to a starting prompt, for one turn of one Session. */
export function buildPromptBlock(input: { sessionId: string; turn: number }): string {
  const path = `~/${sessionReportPathFromHome(input.sessionId, input.turn)}`;
  return (
    `${BLOCK_OPEN} ` +
    "Your workspace is your home directory (~); go into a subfolder only when this prompt says so. " +
    "~/shared is shared with the operator and syncs within seconds. " +
    `When this turn is done, write your report to ${path} and make its last line exactly ${REPORT_END_MARKER}. ` +
    `Never use sudo. ${BLOCK_CLOSE}`
  );
}

/** `text` with the block after it, once: a text that already carries a block of any version is left alone. */
export function appendPromptBlock(text: string, input: { sessionId: string; turn: number }): string {
  if (/\[Actana standard block v\d+\]/.test(text)) return text;
  return `${text} ${buildPromptBlock(input)}`;
}

/** The names in a Session's report folder that are reports, as turn numbers. */
export function reportTurns(names: readonly string[]): number[] {
  return names.flatMap((name) => {
    const turn = sessionReportTurn(name);
    return turn === null ? [] : [turn];
  });
}

/**
 * The turn a `send` is: one after the highest report there is, and never 1. The starting prompt is
 * turn 1 (the Core numbers it so), and its report may not be written yet when a follow-up goes in,
 * so a follow-up that took 1 would be settled by the starting prompt's report.
 */
export function turnForSend(names: readonly string[]): number {
  return Math.max(Math.max(0, ...reportTurns(names)) + 1, 2);
}
