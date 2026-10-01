// `actana shared` — a Core's Shared folder, from the command line (client #7).
//
//   actana shared ls [<core>:][<path>]
//   actana shared get <[<core>:]<path>> [<local-file>]
//   actana shared put <[<core>:]<path>> [<local-file>|-]
//   actana shared rm <[<core>:]<path>>
//   actana shared mkdir <[<core>:]<path>>
//   actana shared watch [<core>] [--since <cursor>] [--json]
//
// This is the orchestrator's way to send work, watch and read reports without
// `core exec`: files go in and come out of the Shared folder, and `watch` says
// when something changed.
//
// It is written against the `CoreShared` interface (`@actana/sdk/shared`) and
// nothing else. Which mode answers is the factory's business (`shared-gateway.ts`).
//
// **The `<core>:` prefix is the same Core naming as `--core`.** It is a name in
// the registry, resolved by `resolveCore` like every other noun's Core; there is
// no second resolution here. With no prefix the Core is the one `--core`, the
// environment or `actana core use` selects. A prefix is a name only when it is
// one (`coreNameError`), so a path with a colon in it still works; a leading
// colon (`:a:b`) says "no prefix" outright.
//
// **Output follows `session`.** Data on stdout, confirmations and failures on
// stderr, `--json` one document on stdout (an error document too, except for
// `get` and `watch`, whose stdout is data a consumer is reading as a stream).
// Exit codes are the CLI's three: 0, 1 (did not work) and 2 (the command line
// was wrong, which includes a path the interface refuses).

import * as fs from "node:fs";
import { CoreSharedError, CoreSharedPartialError } from "@actana/sdk/shared";
import type { SharedChange, SharedCursor, SharedEntry } from "@actana/sdk/shared";
import { errorText } from "./core-connection.ts";
import { resolveCore } from "./core-resolution.ts";
import { DEFAULT_WATCH_POLL_MS, SharedUnavailableError, type SharedHandle } from "./shared-gateway.ts";
import { formatJson, formatTable, orDash, relativeTime } from "../kit/cli-output.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "../kit/exit-codes.ts";
import { coreNameError, type RegistryPaths } from "../registry/credentials.ts";
import type { ClientDeps } from "../kit/cli-deps.ts";
import type { ParsedArgs } from "../kit/cli-args.ts";

export const SHARED_HELP = `actana shared — a Core's Shared folder

Usage
  actana shared ls [<core>:][<path>]
  actana shared get <[<core>:]<path>> [<local-file>]
  actana shared put <[<core>:]<path>> [<local-file>|-]
  actana shared rm <[<core>:]<path>>
  actana shared mkdir <[<core>:]<path>>
  actana shared watch [<core>] [flags]

Paths
  A path is relative to the Shared folder. A path ending in / is a folder, any
  other path is a file; ls with no path lists the root. <core>: is a Core's
  name, the same one --core takes; without it the Core is the one --core, the
  environment or \`actana core use\` selects. A leading colon (:a:b) means no
  <core>: prefix, for a path that has a colon of its own.

Verbs
  ls      list a folder: its folders first, then its files
  get     write a file to stdout, or to <local-file>
  put     create or replace a file from <local-file>, or from stdin with - or
          no file. Missing folders are created.
  rm      delete a file; a path ending in / deletes a folder and its contents
  mkdir   create a folder, and its parents. Succeeds if it is already there.
  watch   print each change as it happens, one per line, until Ctrl-C

Flags
  --core <name>    which Core, instead of a <core>: prefix
  --json           machine-readable output
  --since <cursor> watch: carry on after this cursor. --since start prints
                   everything; with no --since, watch starts from now.
  --limit <n>      watch: stop after n changes instead of following
  --verbose        explain the steps, on stderr. Never prints a blob.

Watch
  A change is one line: \`<path>  <kind>  <size>  <time>\`, or \`<path>  deleted\`.
  With --json it is one JSON object per line (NDJSON) and nothing else on
  stdout: path, kind, deleted, size and modifiedAt where there are any, and
  cursor. The lines of one poll share a cursor that names the position after
  all of them: resume with --since from the cursor of a line only once every
  line carrying it has been handled.
  A failure while following stops it and prints the cursor to resume from.`;

/** Dispatch a `shared` verb. `args.positionals` still has `shared` at [0]. */
export async function runSharedCommand(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const [verb, ...rest] = args.positionals.slice(1);

  if (args.help || verb === undefined) {
    deps.out(SHARED_HELP);
    return verb === undefined && !args.help ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "ls":
      return sharedLs(deps, args, paths, rest);
    case "get":
      return sharedGet(deps, args, paths, rest);
    case "put":
      return sharedPut(deps, args, paths, rest);
    case "rm":
      return sharedRm(deps, args, paths, rest);
    case "mkdir":
      return sharedMkdir(deps, args, paths, rest);
    case "watch":
      return sharedWatch(deps, args, paths, rest);
    default:
      deps.err(`actana shared: unknown verb "${verb}".`);
      deps.err("Verbs: ls, get, put, rm, mkdir, watch. `actana shared --help` lists them.");
      return EXIT_USAGE;
  }
}

// ─── Targets ────────────────────────────────────────────────────────────────

type Target = { core: string | null; path: string };

/**
 * `[<core>:]<path>`. The prefix is a Core name only when it is shaped like one,
 * so `reports/a:b` is a path; `:x` is the escape for a path whose first segment
 * would otherwise read as a prefix.
 */
function parseTarget(raw: string): Target {
  const colon = raw.indexOf(":");
  if (colon === -1) return { core: null, path: raw };
  const prefix = raw.slice(0, colon);
  if (prefix === "") return { core: null, path: raw.slice(1) };
  if (coreNameError(prefix) !== null) return { core: null, path: raw };
  return { core: prefix, path: raw.slice(colon + 1) };
}

/** The Core a target means: its prefix, or `--core`; both, and they have to agree. */
function coreFor(args: ParsedArgs, target: Target): { ok: true; core: string | null } | { ok: false; error: string } {
  if (target.core !== null && args.core !== null && target.core !== args.core) {
    return {
      ok: false,
      error: `the path names Core "${target.core}" and --core names "${args.core}". Give one.`,
    };
  }
  return { ok: true, core: target.core ?? args.core };
}

// ─── Running a verb on a Core's Shared folder ───────────────────────────────

/** One failure, reported the same way every time: prose on stderr, a document on stdout if `--json` says so. */
function failed(deps: ClientDeps, args: ParsedArgs, verb: string, message: string, code = EXIT_FAILURE, document = true): number {
  if (args.json && document) deps.out(formatJson({ error: message }));
  deps.err(`actana shared ${verb}: ${message}`);
  return code;
}

/** A command line this verb cannot act on. Never dials. */
function usage(deps: ClientDeps, verb: string, message: string): number {
  deps.err(`actana shared ${verb}: ${message}.`);
  return EXIT_USAGE;
}

/** What an SDK or factory failure means to the operator, and the exit code it earns. */
function reported(err: unknown): { message: string; code: number } {
  if (err instanceof SharedUnavailableError) return { message: err.message, code: EXIT_UNIMPLEMENTED };
  if (err instanceof CoreSharedPartialError) {
    const left = err.leftBehind.length > 0 ? ` Left behind: ${err.leftBehind.join(", ")}.` : "";
    return { message: `${err.message}.${left}`, code: EXIT_FAILURE };
  }
  // A path the interface refuses is the command line being wrong.
  if (err instanceof CoreSharedError && err.code === "invalid-path") return { message: err.message, code: EXIT_USAGE };
  return { message: errorText(err), code: EXIT_FAILURE };
}

async function withShared(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  verb: string,
  coreName: string | null,
  run: (handle: SharedHandle, where: string) => Promise<number>,
  document = true,
): Promise<number> {
  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: coreName });
  if (!resolved.ok) return failed(deps, args, verb, resolved.error, EXIT_FAILURE, false);

  const { name, blob } = resolved.core;
  deps.verbose(`dialling ${blob.endpoint}`);
  let handle: SharedHandle;
  try {
    handle = await deps.openShared(blob);
  } catch (err) {
    const { message, code } = reported(err);
    return failed(deps, args, verb, code === EXIT_UNIMPLEMENTED ? message : `${blob.endpoint} did not answer — ${message}`, code, document);
  }

  try {
    return await run(handle, name ?? blob.endpoint);
  } catch (err) {
    const { message, code } = reported(err);
    return failed(deps, args, verb, message, code, document);
  } finally {
    handle.close();
  }
}

// ─── ls ─────────────────────────────────────────────────────────────────────

async function sharedLs(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  const misused = watchOnlyFlag(args);
  if (misused) return usage(deps, "ls", misused);
  if (rest.length > 1) return usage(deps, "ls", `unexpected argument "${rest[1]}"`);
  const target = parseTarget(rest[0] ?? "");
  const core = coreFor(args, target);
  if (!core.ok) return usage(deps, "ls", core.error.replace(/\.$/, ""));

  return withShared(deps, args, paths, "ls", core.core, async ({ shared }) => {
    const rows = await shared.list(target.path);
    if (args.json) {
      deps.out(formatJson(rows.map(entryDocument)));
      return EXIT_OK;
    }
    if (rows.length === 0) {
      deps.out(`Nothing in ${target.path === "" ? "the Shared folder" : target.path}.`);
      return EXIT_OK;
    }
    const now = deps.now();
    const table = formatTable(
      ["KIND", "SIZE", "MODIFIED", "PATH"],
      rows.map((row) => [
        row.kind,
        orDash(row.size),
        row.modifiedAt ? relativeTime(row.modifiedAt.toISOString(), now) : "—",
        row.kind === "folder" ? `${row.path}/` : row.path,
      ]),
    );
    for (const line of table) deps.out(line);
    return EXIT_OK;
  });
}

/** An entry as `--json` prints it: the interface's fields, the time as ISO text. */
function entryDocument(entry: SharedEntry): Record<string, unknown> {
  return {
    path: entry.path,
    kind: entry.kind,
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt.toISOString() }),
  };
}

// ─── get ────────────────────────────────────────────────────────────────────

/** The one target a verb takes, and the Core it means; or the usage error to print. */
function oneTarget(
  args: ParsedArgs,
  rest: string[],
  max: number,
  needs: string,
): { ok: true; target: Target; core: string | null; extra: string[] } | { ok: false; message: string } {
  const watchOnly = watchOnlyFlag(args);
  if (watchOnly) return { ok: false, message: watchOnly };
  const [raw, ...extra] = rest;
  if (raw === undefined) return { ok: false, message: needs };
  if (extra.length > max) return { ok: false, message: `unexpected argument "${extra[max]}"` };
  const target = parseTarget(raw);
  const core = coreFor(args, target);
  if (!core.ok) return { ok: false, message: core.error.replace(/\.$/, "") };
  return { ok: true, target, core: core.core, extra };
}

/** `--since` and `--limit` mean something to `watch` alone. */
function watchOnlyFlag(args: ParsedArgs): string | null {
  if (args.since !== null) return "--since belongs to `actana shared watch`";
  if (args.limit !== null) return "--limit belongs to `actana shared watch`";
  return null;
}

/** `actana shared get` — a file's bytes, to stdout or to a local file. */
async function sharedGet(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  const parsed = oneTarget(args, rest, 1, "a path is required — `actana shared get <[<core>:]<path>> [<local-file>]`");
  if (!parsed.ok) return usage(deps, "get", parsed.message);
  const { target, extra } = parsed;
  const out = extra[0];
  if (target.path === "" || target.path.endsWith("/")) {
    return usage(deps, "get", `"${target.path}" is a folder; \`actana shared get\` takes a file`);
  }
  if (out !== undefined && args.json) return usage(deps, "get", "--json prints the file; it does not combine with a local file");

  // stdout is the file, so a failure here is on stderr only (`document` off): a
  // JSON error document would land in the middle of what a consumer reads as data.
  return withShared(deps, args, paths, "get", parsed.core, async ({ shared }) => {
    const file = await shared.get(target.path);
    if (out !== undefined) {
      try {
        fs.writeFileSync(out, file.body);
      } catch (err) {
        return failed(deps, args, "get", `could not write ${out} (${errnoOf(err)})`, EXIT_FAILURE, false);
      }
      deps.err(`Wrote ${file.size} bytes to ${out}.`);
      return EXIT_OK;
    }
    if (args.json) {
      deps.out(formatJson({ ...entryDocument(file), body: Buffer.from(file.body).toString("base64") }));
      return EXIT_OK;
    }
    // Text, as `cat` would. A binary file wants a <local-file> or --json: stdout
    // here is a string sink, and a string is not bytes.
    deps.outBytes(new TextDecoder().decode(file.body));
    return EXIT_OK;
  }, false);
}

// ─── put ────────────────────────────────────────────────────────────────────

/** `actana shared put` — create or replace a file, from a local file or stdin. */
async function sharedPut(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  const parsed = oneTarget(args, rest, 1, "a path is required — `actana shared put <[<core>:]<path>> [<local-file>|-]`");
  if (!parsed.ok) return usage(deps, "put", parsed.message);
  const { target, extra } = parsed;
  if (target.path === "" || target.path.endsWith("/")) {
    return usage(deps, "put", `"${target.path}" is a folder; \`actana shared put\` writes a file`);
  }

  const source = extra[0];
  let body: Uint8Array | string;
  if (source === undefined || source === "-") {
    if (source === undefined && deps.stdinIsTty) {
      return usage(deps, "put", "nothing to write — pass a local file, or pipe the content in on stdin");
    }
    body = await deps.readStdin();
  } else {
    // Read before dialling: a typo in the file name should not cost a connection.
    try {
      body = new Uint8Array(fs.readFileSync(source));
    } catch (err) {
      return failed(deps, args, "put", `could not read ${source} (${errnoOf(err)})`);
    }
  }
  const size = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;

  return withShared(deps, args, paths, "put", parsed.core, async ({ shared }, where) => {
    await shared.put(target.path, body);
    if (args.json) deps.out(formatJson({ path: target.path, size }));
    else deps.err(`Wrote ${size} bytes to ${where}:${target.path}.`);
    return EXIT_OK;
  });
}

// ─── rm and mkdir ───────────────────────────────────────────────────────────

/** `actana shared rm` — a file, or with a trailing / a folder and everything in it. */
async function sharedRm(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  const parsed = oneTarget(args, rest, 0, "a path is required — `actana shared rm <[<core>:]<path>>`");
  if (!parsed.ok) return usage(deps, "rm", parsed.message);
  const { target } = parsed;
  if (target.path === "") return usage(deps, "rm", "the root of the Shared folder cannot be deleted");

  return withShared(deps, args, paths, "rm", parsed.core, async ({ shared }, where) => {
    await shared.rm(target.path);
    if (args.json) deps.out(formatJson({ path: target.path, deleted: true }));
    else deps.err(`Deleted ${where}:${target.path}.`);
    return EXIT_OK;
  });
}

/** `actana shared mkdir` — a folder and its parents; fine if it is already there. */
async function sharedMkdir(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  const parsed = oneTarget(args, rest, 0, "a path is required — `actana shared mkdir <[<core>:]<path>>`");
  if (!parsed.ok) return usage(deps, "mkdir", parsed.message);
  const { target } = parsed;
  if (target.path === "") return usage(deps, "mkdir", "the root of the Shared folder is already there");
  // `mkdir reports` means the folder `reports/`: nobody types a verb that makes
  // folders to make a file.
  const folder = target.path.endsWith("/") ? target.path : `${target.path}/`;

  return withShared(deps, args, paths, "mkdir", parsed.core, async ({ shared }, where) => {
    await shared.mkdir(folder);
    if (args.json) deps.out(formatJson({ path: folder, created: true }));
    else deps.err(`Created ${where}:${folder}.`);
    return EXIT_OK;
  });
}

function errnoOf(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? errorText(err);
}

// ─── watch ──────────────────────────────────────────────────────────────────

/**
 * `actana shared watch [<core>]` — what changes in the Shared folder, as it does.
 *
 * `CoreShared.watch(since)` is a request that answers with the changes after a
 * cursor and the cursor to ask with next, so this is a poll. Where it starts
 * mirrors `events tail`: with no `--since` it starts from now, like `tail -f`
 * (the first poll is made only to learn the cursor, and its changes are history
 * the operator did not ask for); `--since start` asks for everything; any other
 * `--since` is a cursor from an earlier run, handed back untouched because it is
 * the mode's to judge, not this command's.
 *
 * Every change is printed as it is read and nothing is held back, so Ctrl-C ends
 * it the way it ends `tail -f`: no handler, nothing to flush.
 */
async function sharedWatch(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  if (rest.length > 1) return usage(deps, "watch", `unexpected argument "${rest[1]}"`);
  const named = rest[0]?.replace(/:$/, "");
  if (named !== undefined) {
    const bad = coreNameError(named);
    if (bad !== null) return usage(deps, "watch", `"${rest[0]}" is not a Core name (${bad})`);
  }
  const core = coreFor(args, { core: named ?? null, path: "" });
  if (!core.ok) return usage(deps, "watch", core.error.replace(/\.$/, ""));

  let limit: number | null = null;
  if (args.limit !== null) {
    const n = Number(args.limit);
    if (!Number.isInteger(n) || n < 0) return usage(deps, "watch", `--limit takes a whole number of changes, not "${args.limit}"`);
    limit = n;
  }

  // stdout is the stream, so failures are stderr only (`document` off).
  return withShared(deps, args, paths, "watch", core.core, async ({ shared, pollIntervalMs }) => {
    if (limit === 0) return EXIT_OK;
    const interval = pollIntervalMs ?? DEFAULT_WATCH_POLL_MS;

    let cursor: SharedCursor | undefined;
    try {
      if (args.since === null) {
        cursor = (await shared.watch()).cursor;
        deps.verbose("following from now");
      } else if (args.since === "start") {
        deps.verbose("following from the start");
      } else {
        cursor = args.since;
        deps.verbose("following from the given cursor");
      }
    } catch (err) {
      const { message, code } = reported(err);
      return failed(deps, args, "watch", message, code, false);
    }

    let printed = 0;
    for (;;) {
      let result;
      try {
        result = await shared.watch(cursor);
      } catch (err) {
        const { message, code } = reported(err);
        failed(deps, args, "watch", message, code, false);
        if (cursor !== undefined) deps.err(`Resume with --since ${cursor}`);
        return code;
      }
      for (const change of result.changes) {
        deps.out(args.json ? changeDocument(change, result.cursor) : changeLine(change));
        printed += 1;
        if (limit !== null && printed >= limit) return EXIT_OK;
      }
      cursor = result.cursor;
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
  }, false);
}

/** One change as a line a person reads. */
function changeLine(change: SharedChange): string {
  const shown = change.kind === "folder" ? `${change.path}/` : change.path;
  if (change.deleted) return `${shown}  deleted`;
  const parts = [shown, change.kind, orDash(change.size), change.modifiedAt ? change.modifiedAt.toISOString() : "—"];
  return parts.join("  ");
}

/**
 * One change as one line of JSON: NDJSON, because this never ends. `cursor` is
 * the position after the whole poll the change came in, the same on every line
 * of that poll.
 */
function changeDocument(change: SharedChange, cursor: SharedCursor): string {
  return JSON.stringify({
    path: change.path,
    kind: change.kind,
    deleted: change.deleted,
    ...(change.size === undefined ? {} : { size: change.size }),
    ...(change.modifiedAt === undefined ? {} : { modifiedAt: change.modifiedAt.toISOString() }),
    cursor,
  });
}
