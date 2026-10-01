// Waiting for a report to land in the Shared folder (client #8).
//
// A turn is over when its report file is there and ends with the marker — not when a screen looks
// idle, and not when a status says so. The Shared watcher is how this side hears that a file
// changed; nothing here polls the file itself, or runs a command on the Core to read it.
//
// **The cursor is taken before the first look.** `watch(cursor)` reports what changed after the
// cursor, so a watch that began after the report landed would wait for a change that already
// happened. Taking the cursor first and then reading the file closes that: whatever lands after the
// cursor is reported by the watch, and whatever landed before it is found by the read. A report
// already there when the wait starts settles it at once.

import { CoreSharedError, type CoreShared, type SharedCursor } from "@actana/sdk/shared";
import { reportIsComplete } from "./session-report.ts";

/** The deadline the operator asked for ran out. This side gave up; the Core said nothing. */
export class ReportWaitTimeoutError extends Error {
  constructor(
    readonly path: string,
    timeoutMs: number,
  ) {
    const seconds = Number((timeoutMs / 1000).toFixed(3));
    super(
      `gave up after ${seconds} second${seconds === 1 ? "" : "s"}: ${path} did not appear with its end marker. ` +
        "The Session is still running on the Core.",
    );
    this.name = "ReportWaitTimeoutError";
  }
}

export type ReportWaitOptions = {
  /** A cursor taken before the text that asks for this report was sent. Taken here when absent. */
  cursor?: SharedCursor;
  /** Between two `watch` calls. */
  pollIntervalMs: number;
  /** The operator's deadline, or null for none. */
  timeoutMs: number | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type LandedReport = { path: string; body: string; cursor: SharedCursor };

/** A cursor for "now", for a caller that has to take it before it sends. */
export async function reportCursor(shared: CoreShared): Promise<SharedCursor> {
  return (await shared.watch()).cursor;
}

async function readIfThere(shared: CoreShared, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode((await shared.get(path)).body);
  } catch (err) {
    if (err instanceof CoreSharedError && err.code === "not-found") return null;
    throw err;
  }
}

/**
 * Resolve with the report at `path` once it is there and complete.
 *
 * The file is read when the wait starts, and again each time a watch reports a change to it —
 * never on a timer. A file that appears without its marker (a harness that writes in steps) is
 * read again on its next change.
 */
export async function awaitReport(shared: CoreShared, path: string, opts: ReportWaitOptions): Promise<LandedReport> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const expired = (): boolean => opts.timeoutMs !== null && now() - startedAt >= opts.timeoutMs;
  const giveUp = (): never => {
    throw new ReportWaitTimeoutError(path, opts.timeoutMs ?? 0);
  };

  let cursor = opts.cursor ?? (await reportCursor(shared));

  // First look: the report may have landed before this wait began.
  let body = await readIfThere(shared, path);
  if (body !== null && reportIsComplete(body)) return { path, body, cursor };

  for (;;) {
    if (expired()) giveUp();
    const result = await shared.watch(cursor);
    cursor = result.cursor;
    if (result.changes.some((change) => change.path === path && !change.deleted)) {
      body = await readIfThere(shared, path);
      if (body !== null && reportIsComplete(body)) return { path, body, cursor };
      continue;
    }
    if (expired()) giveUp();
    await sleep(opts.pollIntervalMs);
  }
}
