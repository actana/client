// Step 4 of the recipe: dispatch a Task and turn its result files into status.
//
// What the Panel's dispatcher and result watcher do (control PR 629, issue 570), with the public SDK
// only and no database: where the Panel stores a Task, a comment and a status, this returns them.
//
//   1. note the dispatch time: only a result file NEWER than it counts (an older one is an earlier
//      attempt's);
//   2. on a re-run, rename the older results to `attempt-<n>-<name>` (client PR 41), so this attempt
//      starts with none;
//   3. start a Session with the Task, its comments and the result instructions. The prompt carries NO
//      standard block: the Core appends its own to a starting prompt, and leaves one that already has
//      a block alone;
//   4. watch `tasks/<id>/` for `success.md`, `fail.md` or `partial-<n>.md`. A FINISHED file (last
//      line `ACT-REPORT-END`) becomes one comment and one status: done, failed or partial;
//   5. an agent that exits with no result, or a Task that runs out of time, gets a `fail.md` written
//      by the dispatcher, and fails through the same path.
import { CoreSession } from "@actana/sdk/core";
import { CoreSharedError } from "@actana/sdk/shared";
import { realClock } from "./clock.mjs";
import { messageOf } from "./errors.mjs";
import {
  REPORT_END_MARKER,
  archivedTaskName,
  classifyTaskEntry,
  reportIsComplete,
  reportWithoutMarker,
  statusForResult,
  taskFolder,
  taskResultPath,
} from "./report-contract.mjs";

export const DEFAULT_TASK_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_EXIT_GRACE_MS = 30_000;
export const DEFAULT_POLL_MS = 2_000;
/** A report is read whole into memory; a larger file is left on the Shared folder and pointed to. */
export const MAX_REPORT_BYTES = 1024 * 1024;
export const MAX_PROMPT_COMMENTS = 20;
export const MAX_PROMPT_COMMENT_CHARS = 4_000;
export const MAX_PROMPT_DESCRIPTION_CHARS = 20_000;

/** The Core leaves a prompt that already holds its block alone, so text that quotes the block's opening must not. */
function defuse(text) {
  return text.replace(/\[(\/?)Actana standard block/g, "[$1Actana standard-block");
}

function clipTo(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)} [cut]`;
}

/**
 * What a Session is told when a Task is dispatched to it: the Task, its comments, and where and how to
 * report the result. `comments` are `{ authorName, authorKind, body }`; system comments are the
 * dispatcher talking to the operator and are left out.
 */
export function buildTaskPrompt(task, comments, attempt) {
  const thread = comments.filter((c) => c.authorKind !== "system").slice(-MAX_PROMPT_COMMENTS);
  const success = `~/shared/${taskResultPath(task.id, { kind: "success" })}`;
  const fail = `~/shared/${taskResultPath(task.id, { kind: "fail" })}`;
  const partial = `~/shared/${taskResultPath(task.id, { kind: "partial", n: 1 })}`.replace("partial-1.md", "partial-<n>.md");
  const lines = [
    "You have been given a Task by the operator's Panel. Do the work, then report the result as described at the end.",
    "",
    `Task: ${defuse(task.title.trim())}`,
    "",
    "Description:",
    defuse(clipTo(task.description.trim(), MAX_PROMPT_DESCRIPTION_CHARS)) || "(none)",
  ];
  if (thread.length > 0) {
    lines.push("", "Comments so far, oldest first:");
    for (const c of thread) lines.push(`- ${c.authorName} (${c.authorKind}): ${defuse(clipTo(c.body.trim(), MAX_PROMPT_COMMENT_CHARS))}`);
  }
  lines.push(
    "",
    `Result (attempt ${attempt}): when you are done, write your report in Markdown to exactly one of these files and make its last line exactly ${REPORT_END_MARKER}:`,
    `- ${success} if the Task is done;`,
    `- ${fail} if you could not do it;`,
    `- ${partial} (n = 1, 2, ...) if only part of it is done.`,
    "Say what you did, what is left, and what the next person needs to know.",
  );
  return lines.join("\n");
}

/** Rename the results an earlier attempt left to `attempt-<n>-<name>`, so this attempt starts with none (client PR 41). */
export async function archivePreviousResults(shared, taskId, previousAttempt) {
  const folder = taskFolder(taskId);
  for (const entry of await shared.list(folder)) {
    if (entry.kind !== "file") continue;
    const name = entry.path.slice(folder.length);
    if (classifyTaskEntry(name).kind !== "result") continue;
    try {
      await shared.move(entry.path, `${folder}${archivedTaskName(previousAttempt, name)}`);
    } catch (err) {
      // Already archived under that name: leave it, the time filter ignores the old file anyway.
      if (!(err instanceof CoreSharedError && err.code === "exists")) throw err;
    }
  }
}

function oversizeNote(path, size) {
  return `${REPORT_END_MARKER}\nThis result is ${size} bytes, over the ${MAX_REPORT_BYTES} kept as a comment. Read it at ${path} in the Shared folder.\n${REPORT_END_MARKER}`;
}

/**
 * Look at a batch of changes for this Task's result files. Returns the first finished result that
 * counts as `{ name, result, body }`, or null. Only direct children of the Task folder, only files
 * written after `dispatchedAt`, only finished ones.
 */
async function findResult({ shared, taskId, dispatchedAt, changes }) {
  const folder = taskFolder(taskId);
  const candidates = changes
    .filter((c) => c.kind === "file" && !c.deleted && c.path.startsWith(folder) && !c.path.slice(folder.length).includes("/"))
    .map((change) => ({ change, entry: classifyTaskEntry(change.path.slice(folder.length)) }))
    .filter(({ entry }) => entry.kind === "result")
    .sort((a, b) => (a.change.modifiedAt?.getTime() ?? 0) - (b.change.modifiedAt?.getTime() ?? 0) || (a.change.path < b.change.path ? -1 : 1));
  for (const { change, entry } of candidates) {
    const name = change.path.slice(folder.length);
    // Older than the dispatch: an earlier attempt's. Not remembered, so a newer write of the same name is still seen.
    if (change.modifiedAt && change.modifiedAt.getTime() <= dispatchedAt) continue;
    if (change.size !== undefined && change.size > MAX_REPORT_BYTES) {
      return { name, result: entry.result, body: oversizeNote(change.path, change.size) };
    }
    let file;
    try {
      file = await shared.get(change.path);
    } catch (err) {
      // Created and gone again within one poll: nothing to read.
      if (err instanceof CoreSharedError && err.code === "not-found") continue;
      throw err;
    }
    const modifiedAt = file.modifiedAt ?? change.modifiedAt;
    if (!modifiedAt || modifiedAt.getTime() <= dispatchedAt) continue;
    const body = new TextDecoder().decode(file.body);
    // Still being written: it will be reported changed again when it is done.
    if (!reportIsComplete(body)) continue;
    return { name, result: entry.result, body };
  }
  return null;
}

/** The dispatcher's own `fail.md`: written to the Shared folder, then recorded like any other result. */
async function synthesizeFailure({ shared, taskId, attempt, reason, dispatchedAt, log }) {
  // One last look at the folder itself, not at the change feed: a result whose event was missed still counts.
  try {
    const folder = taskFolder(taskId);
    const entries = await shared.list(folder);
    const changes = entries.map((e) => ({ path: e.path, kind: e.kind, deleted: false, size: e.size, modifiedAt: e.modifiedAt }));
    const found = await findResult({ shared, taskId, dispatchedAt, changes });
    if (found) return found;
  } catch (err) {
    log(`last look before fail.md failed: ${messageOf(err)}`);
  }
  const path = taskResultPath(taskId, { kind: "fail" });
  const body = `# Failed\n\n${reason} (attempt ${attempt}; written by the dispatcher.)\n\n${REPORT_END_MARKER}\n`;
  try {
    await shared.put(path, body);
  } catch (err) {
    // A folder that cannot be written to is no reason to leave the Task running: it fails either way.
    log(`could not write ${path}: ${messageOf(err)}`);
  }
  // Recorded from what was written, not read back: the store's clock is not ours, and a `fail.md` that
  // looked older than the dispatch would leave the Task in progress for ever.
  return { name: "fail.md", result: { kind: "fail" }, body };
}

/**
 * Dispatch one Task to the paired Core and resolve with where it ended up:
 * `{ taskId, attempt, sessionId, status, resultFile, sourceFile, comment }`, `status` being `done`,
 * `failed` or `partial`, `comment` the report without its end marker, and `sourceFile` the name the
 * comment is filed under (`attempt-<n>-<name>`, unique per Task).
 */
export async function dispatchTask({
  client,
  shared,
  task,
  comments = [],
  attempt = 1,
  harness,
  dangerouslySkipPermissions = false,
  timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  exitGraceMs = DEFAULT_EXIT_GRACE_MS,
  pollMs = DEFAULT_POLL_MS,
  clock = realClock,
  log = () => undefined,
}) {
  // 1. The dispatch time. Only a result newer than this counts.
  const dispatchedAt = clock.now();
  // 2. A re-run starts with no results in the folder.
  if (attempt > 1) await archivePreviousResults(shared, task.id, attempt - 1);

  // 3. The Session. The prompt carries the result instructions and no standard block.
  const session = await CoreSession.start(client, {
    harness,
    title: `Task: ${task.title.trim().slice(0, 80)}`,
    prompt: buildTaskPrompt(task, comments, attempt),
    ...(dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
  });
  let exitedAt = null;
  let exitCode = null;
  session.onExit((exit) => {
    exitedAt = clock.now();
    exitCode = exit.exitCode;
  });
  log(`task ${task.id}: attempt ${attempt} running as Session ${session.sessionId}`);

  // 4. Watch the Task's folder.
  let cursor;
  try {
    for (;;) {
      let found = null;
      try {
        const watched = await shared.watch(cursor);
        found = await findResult({ shared, taskId: task.id, dispatchedAt, changes: watched.changes });
        // Only once every change is dealt with: a read that failed is read again from the same cursor.
        cursor = watched.cursor;
      } catch (err) {
        // The Shared folder cannot be read right now. Timeout and exit below do not depend on it.
        log(`task ${task.id}: could not read its results: ${messageOf(err)}`);
      }
      // 5. Nothing, and the agent is gone or the time is up: the dispatcher fails the Task itself.
      if (found === null) {
        const now = clock.now();
        let reason = null;
        if (exitedAt !== null && now - exitedAt >= exitGraceMs) {
          reason = `The agent exited (code ${exitCode}) without writing a result file.`;
        } else if (now - dispatchedAt >= timeoutMs) {
          reason = `The agent wrote no result within ${Math.max(1, Math.round(timeoutMs / 60_000))} minute(s) of dispatch.`;
        }
        if (reason !== null) found = await synthesizeFailure({ shared, taskId: task.id, attempt, reason, dispatchedAt, log });
      }
      if (found !== null) {
        return {
          taskId: task.id,
          attempt,
          sessionId: session.sessionId,
          status: statusForResult(found.result),
          resultFile: found.name,
          sourceFile: archivedTaskName(attempt, found.name),
          comment: reportWithoutMarker(found.body) || `(${found.name} was empty)`,
        };
      }
      await clock.sleep(pollMs);
    }
  } finally {
    session.dispose();
  }
}
