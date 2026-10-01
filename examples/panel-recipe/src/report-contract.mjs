// The report contract of client #8 (merged as client PR 41): where a report lives in the Core's
// Shared folder, what ends it, and the prompt block a harness is told it by.
//
// **These are client PR 41's, word for word** (`packages/cli/src/core/session-report.ts`). They are
// copied, not imported, because the SDK does not export them and an example may use only what the
// public packages export (the Panel copied the Task half the same way, control PR 629).
// `__tests__/report-contract.test.mjs` pins every string and reads the CLI's source as text to catch
// a drift. Paths are relative to the Shared folder, which is what `CoreShared` takes.
//
//   a plain Session turn   sessions/<session-id>/report-<turn>.md
//   a Task                 tasks/<task-id>/success.md | fail.md | partial-<n>.md, and attempt-<n>.log
//   a re-run               the older results are renamed to attempt-<n>-<name>

/** The fixed last line a report ends with. A watcher settles on it. */
export const REPORT_END_MARKER = "ACT-REPORT-END";

/** Bumped by the Core with any wording change. */
export const PROMPT_BLOCK_VERSION = 1;

/** Where a plain Session turn writes its report, relative to the Shared folder. */
export function sessionReportPath(sessionId, turn) {
  return `sessions/${sessionId}/report-${turn}.md`;
}

/** The same file as the harness is told it, from its home directory. */
export function sessionReportPathFromHome(sessionId, turn) {
  return `shared/${sessionReportPath(sessionId, turn)}`;
}

/** A Task's folder, relative to the Shared folder. */
export function taskFolder(taskId) {
  return `tasks/${taskId}/`;
}

/** The file a Task's result is written to: `success.md`, `fail.md` or `partial-<n>.md`. */
export function taskResultPath(taskId, result) {
  const name =
    result.kind === "partial" ? `partial-${result.n}.md` : result.kind === "success" ? "success.md" : "fail.md";
  return `tasks/${taskId}/${name}`;
}

/** What an older result is renamed to when a Task runs again: `success.md` becomes `attempt-1-success.md`. */
export function archivedTaskName(attempt, name) {
  return `attempt-${attempt}-${name}`;
}

function taskResultOfName(name) {
  if (name === "success.md") return { kind: "success" };
  if (name === "fail.md") return { kind: "fail" };
  const partial = /^partial-([1-9][0-9]*)\.md$/.exec(name);
  return partial === null ? null : { kind: "partial", n: Number(partial[1]) };
}

/** A Task folder entry, told apart: a current result, an archived one, an attempt log, or none of these. */
export function classifyTaskEntry(name) {
  const current = taskResultOfName(name);
  if (current !== null) return { kind: "result", result: current };
  const log = /^attempt-([1-9][0-9]*)\.log$/.exec(name);
  if (log !== null) return { kind: "log", attempt: Number(log[1]) };
  const archived = /^attempt-([1-9][0-9]*)-(.+)$/.exec(name);
  if (archived !== null) {
    const result = taskResultOfName(archived[2]);
    if (result !== null) return { kind: "archived", attempt: Number(archived[1]), result };
  }
  return { kind: "other" };
}

/** Is this the body of a finished report: its last non-blank line exactly the end marker? */
export function reportIsComplete(body) {
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(/\r$/, "").trimEnd();
    if (line === "") continue;
    return line === REPORT_END_MARKER;
  }
  return false;
}

/** The report as a reader wants it: the body without its closing end-marker line, which is protocol, not prose. */
export function reportWithoutMarker(body) {
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(/\r$/, "").trimEnd();
    if (line === "") continue;
    if (line === REPORT_END_MARKER) lines.splice(i, 1);
    break;
  }
  return lines.join("\n").trim();
}

/** The Task status a result file moves the Task to (the Panel's `statusForResult`). */
export function statusForResult(result) {
  return result.kind === "success" ? "done" : result.kind === "fail" ? "failed" : "partial";
}

const BLOCK_OPEN = `[Actana standard block v${PROMPT_BLOCK_VERSION}]`;
const BLOCK_CLOSE = `[/Actana standard block v${PROMPT_BLOCK_VERSION}]`;

/**
 * The block the Core appends to a starting prompt, for one turn of one Session. The Core does this
 * itself (control PR 621), so the recipe never sends it with a starting prompt; it is here for a
 * follow-up turn, which is a raw write, and for the fake Core in the tests.
 */
export function buildPromptBlock({ sessionId, turn }) {
  const path = `~/${sessionReportPathFromHome(sessionId, turn)}`;
  return (
    `${BLOCK_OPEN} ` +
    "Your workspace is your home directory (~); go into a subfolder only when this prompt says so. " +
    "~/shared is shared with the operator and syncs within seconds. " +
    `When this turn is done, write your report to ${path} and make its last line exactly ${REPORT_END_MARKER}. ` +
    `Never use sudo. ${BLOCK_CLOSE}`
  );
}

/** `text` with the block after it, once: a text that already carries a block of any version is left alone. */
export function appendPromptBlock(text, input) {
  if (/\[Actana standard block v\d+\]/.test(text)) return text;
  return `${text} ${buildPromptBlock(input)}`;
}
