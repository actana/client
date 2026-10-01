// What the recipe throws, and the exit code each one ends the script with. A message here never
// carries a key, a token or a blob: the only values it names are ids, paths and states.

export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  usage: 2,
  timeout: 3,
  refused: 4,
  noReport: 5,
});

export class RecipeError extends Error {
  name = "RecipeError";
  /** @param {number} exitCode one of {@link EXIT} */
  constructor(message, exitCode = EXIT.failed, options) {
    super(message, options);
    this.exitCode = exitCode;
  }
}

/** A missing or malformed environment variable or argument. */
export class UsageError extends RecipeError {
  name = "UsageError";
  constructor(message) {
    super(message, EXIT.usage);
  }
}

/** The Core, or the Shared folder, said no. */
export class RefusedError extends RecipeError {
  name = "RefusedError";
  constructor(message, options) {
    super(message, EXIT.refused, options);
  }
}

/** Nothing arrived in time. */
export class TimeoutError extends RecipeError {
  name = "TimeoutError";
  constructor(message) {
    super(message, EXIT.timeout);
  }
}

/** The harness ended and left no report. */
export class NoReportError extends RecipeError {
  name = "NoReportError";
  constructor(message) {
    super(message, EXIT.noReport);
  }
}

export function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
