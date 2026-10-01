// `actana files` — a Core's files, relative to its home folder (client #10).
//
//   actana files ls [<core>:][<path>] [--depth <n>|all] [--sha256]
//   actana files get <[<core>:]<path>> [<local-file>]
//   actana files put <[<core>:]<path>> [<local-file>|-]
//   actana files rm <[<core>:]<path>>
//
// Every path is relative to `~` on the Core (control #557: the Files API at
// `/v1/files`). There is no Project and no project argument: a Core has one home.
//
// **The conventions are `actana shared`'s**, and the two commands differ only in
// what the path is relative to. The `<core>:` prefix is a name in the registry,
// resolved by `resolveCore` like every other noun's Core; a prefix is a name only
// when it is one (`coreNameError`), so a path with a colon still works, and a
// leading colon (`:a:b`) says "no prefix" outright. A path ending in `/` is a
// folder. Data goes on stdout, confirmations and failures on stderr, `--json` is
// one document on stdout (not for `get`, whose stdout is the file). Exit codes
// are the CLI's three: 0, 1 (did not work) and 2 (the command line was wrong,
// which includes a path the Core would refuse, `..` and absolute ones: those are
// refused here, before a connection is made).

import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CoreFilesRequestError,
  CoreFilesUnavailableError,
  homePathRefusal,
  type CoreFileEntry,
} from "@actana/sdk/core";
import { errorText } from "./core-connection.ts";
import { resolveCore } from "./core-resolution.ts";
import type { FilesHandle } from "./files-gateway.ts";
import { formatJson, formatTable, orDash, relativeTime } from "../kit/cli-output.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";
import { coreNameError, type RegistryPaths } from "../registry/credentials.ts";
import type { ClientDeps } from "../kit/cli-deps.ts";
import type { ParsedArgs } from "../kit/cli-args.ts";

export const FILES_HELP = `actana files — a Core's files, relative to its home folder

Usage
  actana files ls [<core>:][<path>] [flags]
  actana files get <[<core>:]<path>> [<local-file>]
  actana files put <[<core>:]<path>> [<local-file>|-]
  actana files rm <[<core>:]<path>>

Paths
  A path is relative to the home folder (~) on the Core. A path ending in / is a
  folder, any other path is a file; ls with no path lists the home itself. .. and
  absolute paths are refused before anything is sent. <core>: is a Core's name,
  the same one --core takes; without it the Core is the one --core, the
  environment or \`actana core use\` selects. A leading colon (:a:b) means no
  <core>: prefix, for a path that has a colon of its own.

Verbs
  ls      list a folder: its folders first, then its files
  get     write a file to stdout, or to <local-file>
  put     create or replace a file from <local-file>, or from stdin with - or
          no file. Missing folders are created.
  rm      delete a file; a path ending in / deletes a folder and its contents

Flags
  --core <name>    which Core, instead of a <core>: prefix
  --json           machine-readable output
  --depth <n|all>  ls: how many levels to list (default 1: the children)
  --sha256         ls: also print each file's SHA-256 (reads every byte; off by default)
  --verbose        explain the steps, on stderr. Never prints a blob.`;

/** Dispatch a `files` verb. `args.positionals` still has `files` at [0]. */
export async function runFilesCommand(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths): Promise<number> {
  const [verb, ...rest] = args.positionals.slice(1);

  if (args.help || verb === undefined) {
    deps.out(FILES_HELP);
    return verb === undefined && !args.help ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "ls":
      return filesLs(deps, args, paths, rest);
    case "get":
      return filesGet(deps, args, paths, rest);
    case "put":
      return filesPut(deps, args, paths, rest);
    case "rm":
      return filesRm(deps, args, paths, rest);
    default:
      deps.err(`actana files: unknown verb "${verb}".`);
      deps.err("Verbs: ls, get, put, rm. `actana files --help` lists them.");
      return EXIT_USAGE;
  }
}

// ─── Targets ────────────────────────────────────────────────────────────────

type Target = { core: string | null; path: string };

/** `[<core>:]<path>`, read exactly as `actana shared` reads it. */
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
    return { ok: false, error: `the path names Core "${target.core}" and --core names "${args.core}". Give one.` };
  }
  return { ok: true, core: target.core ?? args.core };
}

/** The target a verb takes, checked without dialling; or the usage error to print. */
function oneTarget(
  args: ParsedArgs,
  rest: string[],
  max: number,
  needs: string,
): { ok: true; target: Target; core: string | null; extra: string[] } | { ok: false; message: string } {
  if (args.depth !== null || args.sha256) return { ok: false, message: "--depth and --sha256 belong to `actana files ls`" };
  const [raw, ...extra] = rest;
  if (raw === undefined) return { ok: false, message: needs };
  if (extra.length > max) return { ok: false, message: `unexpected argument "${extra[max]}"` };
  return checkedTarget(args, raw, extra);
}

function checkedTarget(
  args: ParsedArgs,
  raw: string,
  extra: string[],
): { ok: true; target: Target; core: string | null; extra: string[] } | { ok: false; message: string } {
  const target = parseTarget(raw);
  const core = coreFor(args, target);
  if (!core.ok) return { ok: false, message: core.error.replace(/\.$/, "") };
  const refused = homePathRefusal(target.path);
  if (refused !== null) return { ok: false, message: refused.message };
  return { ok: true, target, core: core.core, extra };
}

// ─── Running a verb on a Core's files ───────────────────────────────────────

/** One failure, reported the same way every time: prose on stderr, a document on stdout if `--json` says so. */
function failed(deps: ClientDeps, args: ParsedArgs, verb: string, message: string, code = EXIT_FAILURE, document = true): number {
  if (args.json && document) deps.out(formatJson({ error: message }));
  deps.err(`actana files ${verb}: ${message}`);
  return code;
}

/** A command line this verb cannot act on. Never dials. */
function usage(deps: ClientDeps, verb: string, message: string): number {
  deps.err(`actana files ${verb}: ${message}.`);
  return EXIT_USAGE;
}

/** The codes the Core uses for a path it will not act on: the command line was wrong. */
const PATH_REFUSALS: ReadonlySet<string> = new Set([
  "absolute-path",
  "dot-dot-segment",
  "malformed-path",
  "outside-project-root",
]);

/** What an SDK failure means to the operator, and the exit code it earns. */
function reported(err: unknown): { message: string; code: number } {
  if (err instanceof CoreFilesRequestError && err.status === 400 && PATH_REFUSALS.has(String(err.code))) {
    return { message: err.message, code: EXIT_USAGE };
  }
  if (err instanceof CoreFilesUnavailableError) return { message: err.reason, code: EXIT_FAILURE };
  return { message: errorText(err), code: EXIT_FAILURE };
}

async function withFiles(
  deps: ClientDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  verb: string,
  coreName: string | null,
  run: (handle: FilesHandle, where: string) => Promise<number>,
  document = true,
): Promise<number> {
  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: coreName });
  if (!resolved.ok) return failed(deps, args, verb, resolved.error, EXIT_FAILURE, false);

  const { name, blob } = resolved.core;
  deps.verbose(`dialling ${blob.endpoint}`);
  let handle: FilesHandle;
  try {
    handle = await deps.openFiles(blob);
  } catch (err) {
    return failed(deps, args, verb, `${blob.endpoint} did not answer — ${errorText(err)}`, EXIT_FAILURE, document);
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

/** `--depth`: a whole number of levels, or `all`. Absent means the children only. */
function parseDepth(raw: string | null): { ok: true; depth: number | null } | { ok: false; message: string } {
  if (raw === null) return { ok: true, depth: 1 };
  if (raw === "all") return { ok: true, depth: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return { ok: false, message: `--depth takes a whole number of levels (1 or more) or "all", not "${raw}"` };
  return { ok: true, depth: n };
}

/** How a listing names an entry's kind. */
function kindOf(entry: CoreFileEntry): "folder" | "file" | "link" {
  if (entry.kind === "directory") return "folder";
  if (entry.kind === "symlink") return "link";
  return "file";
}

async function filesLs(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  if (rest.length > 1) return usage(deps, "ls", `unexpected argument "${rest[1]}"`);
  const checked = checkedTarget(args, rest[0] ?? "", []);
  if (!checked.ok) return usage(deps, "ls", checked.message);
  const depth = parseDepth(args.depth);
  if (!depth.ok) return usage(deps, "ls", depth.message);
  const { target } = checked;

  return withFiles(deps, args, paths, "ls", checked.core, async ({ files }) => {
    const rows: CoreFileEntry[] = [];
    for await (const entry of files.list({
      path: target.path,
      ...(depth.depth === null ? {} : { depth: depth.depth }),
      ...(args.sha256 ? { sha256: true } : {}),
    })) {
      rows.push(entry);
    }
    // Folders first, then the rest, each by path: the order `shared ls` prints.
    rows.sort((a, b) => Number(kindOf(b) === "folder") - Number(kindOf(a) === "folder") || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    if (args.json) {
      deps.out(formatJson(rows.map(entryDocument)));
      return EXIT_OK;
    }
    if (rows.length === 0) {
      deps.out(`Nothing in ${target.path === "" ? "the home folder" : target.path}.`);
      return EXIT_OK;
    }
    const now = deps.now();
    const header = ["KIND", "SIZE", "MODIFIED", "PATH", ...(args.sha256 ? ["SHA256"] : [])];
    const table = formatTable(
      header,
      rows.map((row) => [
        kindOf(row),
        kindOf(row) === "folder" ? "—" : orDash(row.size),
        row.mtime > 0 ? relativeTime(new Date(row.mtime).toISOString(), now) : "—",
        kindOf(row) === "folder" ? `${row.path}/` : row.path,
        ...(args.sha256 ? [orDash(row.sha256)] : []),
      ]),
    );
    for (const line of table) deps.out(line);
    return EXIT_OK;
  });
}

/** An entry as `--json` prints it: the time as ISO text, the kind as `ls` names it. */
function entryDocument(entry: CoreFileEntry): Record<string, unknown> {
  return {
    path: entry.path,
    kind: kindOf(entry),
    ...(kindOf(entry) === "file" ? { size: entry.size } : {}),
    ...(entry.mtime > 0 ? { modifiedAt: new Date(entry.mtime).toISOString() } : {}),
    mode: entry.mode,
    ...(entry.sha256 === null ? {} : { sha256: entry.sha256 }),
  };
}

// ─── get ────────────────────────────────────────────────────────────────────

/** `actana files get` — a file's bytes, to stdout or to a local file. */
async function filesGet(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  const parsed = oneTarget(args, rest, 1, "a path is required — `actana files get <[<core>:]<path>> [<local-file>]`");
  if (!parsed.ok) return usage(deps, "get", parsed.message);
  const { target, extra } = parsed;
  const out = extra[0];
  if (target.path === "" || target.path.endsWith("/")) {
    return usage(deps, "get", `"${target.path}" is a folder; \`actana files get\` takes a file`);
  }
  if (out !== undefined && args.json) return usage(deps, "get", "--json prints the file; it does not combine with a local file");

  // stdout is the file, so a failure here is on stderr only (`document` off): a
  // JSON error document would land in the middle of what a consumer reads as data.
  return withFiles(deps, args, paths, "get", parsed.core, async ({ files }) => {
    const file = await files.download({ path: target.path });
    if (file.kind === "tar") {
      await file.stream.cancel();
      return failed(deps, args, "get", `"${target.path}" is a folder; \`actana files get\` takes a file`, EXIT_FAILURE, false);
    }
    const source = Readable.fromWeb(file.stream as import("node:stream/web").ReadableStream<Uint8Array>);

    if (out !== undefined) {
      let written = 0;
      try {
        source.on("data", (chunk: Buffer) => void (written += chunk.byteLength));
        await pipeline(source, fs.createWriteStream(out));
      } catch (err) {
        return failed(deps, args, "get", `could not write ${out} (${errnoOf(err)})`, EXIT_FAILURE, false);
      }
      deps.err(`Wrote ${written} bytes to ${out}.`);
      return EXIT_OK;
    }

    if (args.json) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      deps.out(formatJson({ path: target.path, size: body.byteLength, body: body.toString("base64") }));
      return EXIT_OK;
    }
    // Text, as `cat` would. A binary file wants a <local-file> or --json: stdout
    // here is a string sink, and a string is not bytes.
    const decoder = new TextDecoder();
    for await (const chunk of source) deps.outBytes(decoder.decode(chunk as Buffer, { stream: true }));
    const tail = decoder.decode();
    if (tail !== "") deps.outBytes(tail);
    return EXIT_OK;
  }, false);
}

// ─── put ────────────────────────────────────────────────────────────────────

/** `actana files put` — create or replace a file, from a local file or stdin. */
async function filesPut(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  const parsed = oneTarget(args, rest, 1, "a path is required — `actana files put <[<core>:]<path>> [<local-file>|-]`");
  if (!parsed.ok) return usage(deps, "put", parsed.message);
  const { target, extra } = parsed;
  if (target.path === "" || target.path.endsWith("/")) {
    return usage(deps, "put", `"${target.path}" is a folder; \`actana files put\` writes a file`);
  }

  const source = extra[0];
  let body: AsyncIterable<Uint8Array | string>;
  let size: number;
  if (source === undefined || source === "-") {
    if (source === undefined && deps.stdinIsTty) {
      return usage(deps, "put", "nothing to write — pass a local file, or pipe the content in on stdin");
    }
    const text = await deps.readStdin();
    size = Buffer.byteLength(text);
    body = (async function* () {
      yield text;
    })();
  } else {
    // Stat before dialling: a typo in the file name should not cost a connection.
    try {
      const stat = fs.statSync(source);
      if (!stat.isFile()) return failed(deps, args, "put", `could not read ${source} (not a file)`);
      size = stat.size;
    } catch (err) {
      return failed(deps, args, "put", `could not read ${source} (${errnoOf(err)})`);
    }
    body = fs.createReadStream(source);
  }

  return withFiles(deps, args, paths, "put", parsed.core, async ({ files }, where) => {
    // The progress stream is drained for its refusals, which arrive as its last line.
    for await (const line of files.upload({ path: target.path, body, contentLength: size })) void line;
    if (args.json) deps.out(formatJson({ path: target.path, size }));
    else deps.err(`Wrote ${size} bytes to ${where}:${target.path}.`);
    return EXIT_OK;
  });
}

// ─── rm ─────────────────────────────────────────────────────────────────────

/** `actana files rm` — a file, or with a trailing / a folder and everything in it. */
async function filesRm(deps: ClientDeps, args: ParsedArgs, paths: RegistryPaths, rest: string[]): Promise<number> {
  const parsed = oneTarget(args, rest, 0, "a path is required — `actana files rm <[<core>:]<path>>`");
  if (!parsed.ok) return usage(deps, "rm", parsed.message);
  const { target } = parsed;
  if (target.path === "") return usage(deps, "rm", "the home folder cannot be deleted");

  return withFiles(deps, args, paths, "rm", parsed.core, async ({ files }, where) => {
    await files.remove(target.path);
    if (args.json) deps.out(formatJson({ path: target.path, deleted: true }));
    else deps.err(`Deleted ${where}:${target.path}.`);
    return EXIT_OK;
  });
}

function errnoOf(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? errorText(err);
}
