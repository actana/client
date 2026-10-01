// Step 3 of the recipe: start a Session and watch its report.
//
// What the Panel does for a Session turn, with the public SDK only. `CoreSession.start` creates the
// Session on the Core and types the prompt in; the Core appends its standard block to that prompt
// itself (control PR 621), naming this Session's own report file. The harness writes that file under
// the Core's Shared folder, and this side learns it landed through `CoreShared.watch`, never from
// the terminal and never with `core exec`.
//
// How the wait settles (client PR 41): take a Shared cursor BEFORE the Session starts, look at the
// file, and if it is not finished `watch(cursor)` until that path changes, then look again. A report
// that landed before the first look still settles it, because the cursor is older than the look.
import { CoreSession } from "@actana/sdk/core";
import { CoreSharedError } from "@actana/sdk/shared";
import { NoReportError, TimeoutError } from "./errors.mjs";
import { realClock } from "./clock.mjs";
import { reportIsComplete, reportWithoutMarker, sessionReportPath } from "./report-contract.mjs";

export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_POLL_MS = 2_000;
/** After the harness exits, how long to keep looking: the Shared folder reaches S3 a few seconds after the Core writes it. */
export const DEFAULT_EXIT_GRACE_MS = 30_000;

const decoder = new TextDecoder();

/** A file's text, or null when it is not there (yet). Any other failure is the caller's. */
export async function readTextIfThere(shared, path) {
  try {
    return decoder.decode((await shared.get(path)).body);
  } catch (err) {
    if (err instanceof CoreSharedError && err.code === "not-found") return null;
    throw err;
  }
}

/**
 * Wait for one report file to be finished. `since` is a cursor taken before the work began.
 * `exited()` returns when the harness ended (ms timestamp) or null while it runs.
 */
export async function awaitReport({
  shared,
  path,
  since,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  exitGraceMs = DEFAULT_EXIT_GRACE_MS,
  exited = () => null,
  clock = realClock,
}) {
  const startedAt = clock.now();
  let cursor = since;
  let look = true;
  for (;;) {
    if (look) {
      const body = await readTextIfThere(shared, path);
      if (body !== null && reportIsComplete(body)) return body;
    }
    const endedAt = exited();
    if (endedAt !== null && clock.now() - endedAt >= exitGraceMs) {
      throw new NoReportError(`the harness exited without finishing ${path}`);
    }
    if (clock.now() - startedAt >= timeoutMs) {
      throw new TimeoutError(`${path} was not finished within ${Math.round(timeoutMs / 1000)} s`);
    }
    await clock.sleep(pollMs);
    const watched = await shared.watch(cursor);
    cursor = watched.cursor;
    look = watched.changes.some((c) => c.path === path && !c.deleted);
    // Once the harness has exited, look on every pass: its last write may have landed with no event.
    if (exited() !== null) look = true;
  }
}

/**
 * Start a Session on the paired Core with `prompt` and wait for its first report.
 * Resolves with the Session id, the report's path and its text without the end marker.
 */
export async function startSessionAndWatch({
  client,
  shared,
  harness,
  prompt,
  title = "Panel recipe session",
  dangerouslySkipPermissions = false,
  timeoutMs,
  pollMs,
  exitGraceMs,
  clock = realClock,
  log = () => undefined,
}) {
  // The cursor first. See the header.
  const { cursor } = await shared.watch();
  const session = await CoreSession.start(client, {
    harness,
    title,
    prompt,
    ...(dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
  });
  let exitedAt = null;
  session.onExit(({ exitCode }) => {
    exitedAt = clock.now();
    log(`harness exited (code ${exitCode})`);
  });
  const path = sessionReportPath(session.sessionId, 1);
  log(`session ${session.sessionId} started; waiting for ${path}`);
  try {
    const body = await awaitReport({
      shared,
      path,
      since: cursor,
      timeoutMs,
      pollMs,
      exitGraceMs,
      exited: () => exitedAt,
      clock,
    });
    return { sessionId: session.sessionId, reportPath: path, report: reportWithoutMarker(body) };
  } finally {
    session.dispose();
  }
}
