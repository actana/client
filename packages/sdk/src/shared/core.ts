// CoreShared, through the Core: for a local CLI with no S3. Every operation goes through
// the Core's Files API under `~/shared` (control #557 / PR 620), and `watch` reads the
// `shared:changed` events on the Core's event log (control #561 / PR 619).
//
// Paths on the wire are home-relative: `shared/…`. The Shared folder name is fixed
// (`SHARED_FOLDER_NAME`). Dot-dot and absolute paths are refused here too, before any
// request leaves.
import type { CoreFilesFetch, CoreFilesRequest } from "../core/files-http.ts";
import { refusalFrom } from "../core/files-http.ts";
import { parseFilePath, parseSharedPath } from "./path.ts";
import {
  CoreSharedError,
  CoreSharedPartialError,
  type CoreShared,
  type SharedChange,
  type SharedCursor,
  type SharedEntry,
  type SharedFile,
  type SharedSignedUrl,
  type SharedUploadEntry,
  type SharedWatchResult,
} from "./types.ts";

/** The Shared folder's name in the home (control `packages/shared/src/shared-folder.ts`). */
export const SHARED_FOLDER_NAME = "shared";

const DEFAULT_SIGNED_URL_SECONDS = 300;
const utf8 = new TextEncoder();
const textDecoder = new TextDecoder();

/** One `shared:changed` payload plus its log id (control PR 619). */
export interface SharedChangedEvent {
  readonly eventId: number;
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  readonly deleted: boolean;
}

/**
 * The event-log half of through-the-Core `watch`: replay by cursor.
 * A real Core feeds this from `subscribe` / `event` / `eventsReplayed`; the fake Core
 * in unit tests keeps the same shape in memory.
 */
export interface SharedChangedEventSource {
  /** Highest event id on the log (0 when empty). */
  tip(): number | Promise<number>;
  /** Events with `eventId` strictly greater than `since`, in order. */
  since(since: number): readonly SharedChangedEvent[] | Promise<readonly SharedChangedEvent[]>;
}

export interface ThroughCoreSharedOptions {
  /** The Core's HTTPS (or loopback HTTP) origin — `CoreConnection.httpsBaseUrl`. No trailing slash. */
  baseUrl: string;
  /** The same signed bearer the core link presents, or null on a loopback rig. */
  bearer?: string | null;
  /**
   * How a Files request is sent. Reuse {@link createCoreFilesFetch} (mTLS + undici) or any
   * test double with the same shape. DELETE and POST are used for delete, folder and move.
   */
  fetch: CoreFilesFetch;
  /** `shared:changed` replay for {@link CoreShared.watch}. */
  events: SharedChangedEventSource;
  now?: () => number;
}

/** Map a Shared-relative path (`""` or `a/b`) onto the Files API home-relative `?path=`. */
export function homeRelativeSharedPath(relative: string, folder = false): string {
  if (relative === "") return folder ? `${SHARED_FOLDER_NAME}/` : SHARED_FOLDER_NAME;
  const base = `${SHARED_FOLDER_NAME}/${relative}`;
  return folder ? `${base}/` : base;
}

function stripSharedPrefix(homeRelative: string): string | null {
  if (homeRelative === SHARED_FOLDER_NAME) return "";
  const prefix = `${SHARED_FOLDER_NAME}/`;
  if (!homeRelative.startsWith(prefix)) return null;
  return homeRelative.slice(prefix.length);
}

function bytesStream(body: Uint8Array | string): ReadableStream<Uint8Array> {
  const bytes = typeof body === "string" ? utf8.encode(body) : body;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function authHeaders(bearer: string | null | undefined): Record<string, string> {
  return bearer ? { authorization: `Bearer ${bearer}` } : {};
}

function unavailable(what: string, status?: number): CoreSharedError {
  return new CoreSharedError("unavailable", `${what} failed`, { status });
}

/** Map a Core Files refusal onto a CoreSharedError. */
export function mapFilesRefusal(status: number, code: string, message: string): CoreSharedError {
  if (status === 404 || code === "not-found") return new CoreSharedError("not-found", message || "not found", { status });
  if (
    code === "absolute-path" ||
    code === "dot-dot-segment" ||
    code === "malformed-path" ||
    code === "outside-project-root" ||
    code === "outside-home"
  ) {
    return new CoreSharedError("invalid-path", message || "invalid path", { status });
  }
  if (code === "directory-in-the-way") return new CoreSharedError("is-folder", message || "a folder is already at that path", { status });
  if (status === 409 && (code === "bad-request" || /already exists/i.test(message))) {
    return new CoreSharedError("exists", message || "the destination is taken", { status });
  }
  if (status === 401 || status === 403 || code === "unauthorized") {
    return new CoreSharedError("forbidden", message || "forbidden", { status });
  }
  if (code === "transfer-in-progress") return unavailable(message || "transfer in progress", status);
  if (/is a folder/i.test(message)) return new CoreSharedError("is-folder", message, { status });
  if (/is not a folder/i.test(message) || /not a folder/i.test(message)) {
    return new CoreSharedError("not-folder", message, { status });
  }
  if (/into itself|onto itself/i.test(message)) return new CoreSharedError("invalid-move", message, { status });
  return unavailable(message || code || `HTTP ${status}`, status);
}

async function throwFromResponse(res: Response, what: string): Promise<never> {
  const err = await refusalFrom(res, what);
  throw mapFilesRefusal(err.status, String(err.code), err.message);
}

async function readNdjson(res: Response): Promise<Record<string, unknown>[]> {
  if (!res.body) return [];
  const raw = textDecoder.decode(await res.arrayBuffer());
  const lines: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      throw unavailable("ndjson");
    }
  }
  return lines;
}

function parseCursor(since: SharedCursor | undefined): number | undefined {
  if (since === undefined) return undefined;
  if (typeof since !== "string" || since === "" || !/^\d+$/.test(since)) {
    throw new CoreSharedError("invalid-cursor", "not a cursor this mode issued");
  }
  const id = Number(since);
  if (!Number.isSafeInteger(id) || id < 0) throw new CoreSharedError("invalid-cursor", "not a cursor this mode issued");
  return id;
}

/** The through-the-Core mode of CoreShared. */
export function createThroughCoreShared(options: ThroughCoreSharedOptions): CoreShared {
  const base = options.baseUrl.replace(/\/+$/, "");
  const bearer = options.bearer ?? null;
  const doFetch = options.fetch;
  const now = options.now ?? Date.now;

  function url(leaf: "files" | "files/list" | "files/folder" | "files/move", query?: Record<string, string>): string {
    const u = new URL(`${base}/v1/${leaf}`);
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  async function send(req: CoreFilesRequest): Promise<Response> {
    try {
      return await doFetch(req);
    } catch (error) {
      throw new CoreSharedError(
        "unavailable",
        `the Core could not be reached (${error instanceof Error ? error.name : "error"})`,
      );
    }
  }

  async function listRaw(homePath: string, depth: number | "all"): Promise<SharedEntry[]> {
    const res = await send({
      method: "GET",
      url: url("files/list", { path: homePath, depth: depth === "all" ? "all" : String(depth) }),
      headers: { ...authHeaders(bearer), accept: "application/x-ndjson" },
    });
    if (res.status === 404) return [];
    if (!res.ok) await throwFromResponse(res, "listing the Shared folder");
    const lines = await readNdjson(res);
    const folders: SharedEntry[] = [];
    const files: SharedEntry[] = [];
    for (const line of lines) {
      const type = typeof line.type === "string" ? line.type : "entry";
      if (type === "done") break;
      if (type === "error") throw unavailable(typeof line.message === "string" ? line.message : "listing failed");
      if (type !== "entry") continue;
      if (typeof line.path !== "string") continue;
      const relative = stripSharedPrefix(line.path);
      if (relative === null) continue;
      if (line.kind === "directory") {
        folders.push({
          path: relative,
          kind: "folder",
          ...(typeof line.mtime === "number" ? { modifiedAt: new Date(line.mtime) } : {}),
        });
      } else if (line.kind === "file") {
        files.push({
          path: relative,
          kind: "file",
          size: typeof line.size === "number" ? line.size : 0,
          ...(typeof line.mtime === "number" ? { modifiedAt: new Date(line.mtime) } : {}),
        });
      }
    }
    const byPath = (a: SharedEntry, b: SharedEntry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return [...folders.sort(byPath), ...files.sort(byPath)];
  }

  async function ensureParents(relative: string): Promise<void> {
    const parts = relative.split("/");
    if (parts.length <= 1) return;
    let built = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      built = built === "" ? (parts[i] as string) : `${built}/${parts[i]}`;
      await mkdirPath(built);
    }
  }

  async function mkdirPath(relative: string): Promise<void> {
    if (relative === "") return;
    const res = await send({
      method: "POST",
      url: url("files/folder", { path: homeRelativeSharedPath(relative) }),
      headers: { ...authHeaders(bearer), accept: "application/json" },
    });
    if (res.ok) {
      await res.arrayBuffer();
      return;
    }
    await throwFromResponse(res, `creating folder ${relative}`);
  }

  async function putFile(path: string, body: Uint8Array | string): Promise<void> {
    const parsed = parseFilePath(path);
    // Parents come into being on the Core for a single-file write (files-ops writeSingleFile).
    const bytes = typeof body === "string" ? utf8.encode(body) : body;
    const res = await send({
      method: "PUT",
      url: url("files", { path: homeRelativeSharedPath(parsed.relative) }),
      headers: {
        ...authHeaders(bearer),
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        accept: "application/x-ndjson",
      },
      body: bytesStream(bytes),
    });
    if (!res.ok) await throwFromResponse(res, `writing ${parsed.relative}`);
    const lines = await readNdjson(res);
    for (const line of lines) {
      if (line.type === "error") {
        throw mapFilesRefusal(
          500,
          typeof line.code === "string" ? line.code : "write-failed",
          typeof line.message === "string" ? line.message : "write failed",
        );
      }
    }
  }

  return {
    async list(path): Promise<SharedEntry[]> {
      const parsed = parseSharedPath(path);
      return listRaw(homeRelativeSharedPath(parsed.relative), 1);
    },

    async get(path): Promise<SharedFile> {
      const parsed = parseFilePath(path);
      const res = await send({
        method: "GET",
        url: url("files", { path: homeRelativeSharedPath(parsed.relative) }),
        headers: authHeaders(bearer),
      });
      if (!res.ok) await throwFromResponse(res, `reading ${parsed.relative}`);
      if (res.headers.get("x-actana-transfer-kind") === "tar") {
        await res.arrayBuffer();
        throw new CoreSharedError("is-folder", "path names a folder, a file is needed", { status: 400 });
      }
      const body = new Uint8Array(await res.arrayBuffer());
      const mtimeHeader = res.headers.get("x-actana-file-mtime");
      const mtime = mtimeHeader !== null ? Number(mtimeHeader) : NaN;
      return {
        path: parsed.relative,
        kind: "file",
        size: body.byteLength,
        body,
        ...(Number.isFinite(mtime) ? { modifiedAt: new Date(mtime) } : {}),
      };
    },

    put: putFile,

    async mkdir(path): Promise<void> {
      const parsed = parseSharedPath(path);
      await mkdirPath(parsed.relative);
    },

    async rm(path): Promise<void> {
      const parsed = parseSharedPath(path);
      if (parsed.segments.length === 0) throw new CoreSharedError("invalid-path", "the root cannot be deleted");
      const homePath = homeRelativeSharedPath(parsed.relative, parsed.folder);
      const res = await send({
        method: "DELETE",
        url: url("files", { path: homePath }),
        headers: { ...authHeaders(bearer), accept: "application/json" },
      });
      if (!res.ok) {
        // A file-spelled DELETE on a folder is 400 on the Core; CoreShared treats it as
        // "no file of that name" (same as the S3 mode's HEAD-then-DELETE).
        if (!parsed.folder && res.status === 400) {
          const err = await refusalFrom(res, `deleting ${parsed.relative}`);
          if (/is a folder/i.test(err.message)) {
            throw new CoreSharedError("not-found", "not found", { status: 404 });
          }
          throw mapFilesRefusal(err.status, String(err.code), err.message);
        }
        await throwFromResponse(res, `deleting ${parsed.relative}`);
      }
      await res.arrayBuffer();
    },

    // The Files API has POST /v1/files/move (control PR 620). Parents of `to` are created
    // first: the Core refuses a move whose destination folder does not exist
    // (files-ops.ts handleMove), while CoreShared.move creates missing parents (same as S3).
    async move(from, to): Promise<void> {
      const src = parseSharedPath(from, "from");
      const dst = parseSharedPath(to, "to");
      if (src.segments.length === 0 || dst.segments.length === 0) {
        throw new CoreSharedError("invalid-path", "the root cannot be moved or replaced");
      }
      if (src.folder !== dst.folder) {
        throw new CoreSharedError("invalid-path", "from and to must both name files or both name folders (a folder ends in /)");
      }
      if (src.folder && (dst.relative === src.relative || dst.relative.startsWith(`${src.relative}/`))) {
        throw new CoreSharedError("invalid-move", "a folder cannot move into itself");
      }
      await ensureParents(dst.relative);
      const res = await send({
        method: "POST",
        url: url("files/move"),
        headers: {
          ...authHeaders(bearer),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: bytesStream(
          JSON.stringify({
            from: homeRelativeSharedPath(src.relative, src.folder),
            to: homeRelativeSharedPath(dst.relative, dst.folder),
          }),
        ),
      });
      if (!res.ok) await throwFromResponse(res, `moving ${src.relative}`);
      await res.arrayBuffer();
    },

    async upload(destination, entries: Iterable<SharedUploadEntry>): Promise<string[]> {
      const dest = parseSharedPath(destination, "destination");
      const plan: { relative: string; entry: SharedUploadEntry }[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        const parsed = parseSharedPath(entry.path, "entry path");
        if (parsed.segments.length === 0) throw new CoreSharedError("invalid-path", "an entry needs a path");
        if ("body" in entry && parsed.folder) throw new CoreSharedError("is-folder", "a file entry's path ends in /");
        const relative = [...dest.segments, ...parsed.segments].join("/");
        if (seen.has(relative)) throw new CoreSharedError("invalid-path", "two entries have the same path");
        seen.add(relative);
        plan.push({ relative, entry });
      }
      // Entry-by-entry through PUT / folder (same plan as the S3 mode) so a mid-way failure
      // can list what was written. A single tar PUT is also on the Files API; this mode
      // keeps the CoreShared.upload contract identical across modes.
      const written: string[] = [];
      for (const { relative, entry } of plan) {
        try {
          if ("body" in entry) {
            await putFile(relative, entry.body);
          } else {
            await mkdirPath(relative);
          }
          written.push(relative);
        } catch (error) {
          if (!(error instanceof CoreSharedError)) throw error;
          if (written.length === 0) throw error;
          throw new CoreSharedPartialError("upload", "write", written, error);
        }
      }
      return written;
    },

    // No cursor: list every file under shared (Files API), because the change feed's first
    // scan is a baseline and does not report what was already there (shared-folder-watcher).
    // With a cursor: replay `shared:changed` from the event log; the opaque cursor is the
    // decimal event id.
    async watch(since): Promise<SharedWatchResult> {
      const cursorId = parseCursor(since);
      if (cursorId === undefined) {
        const entries = await listRaw(SHARED_FOLDER_NAME, "all");
        const changes: SharedChange[] = entries
          .filter((e) => e.kind === "file")
          .map((e) => ({
            path: e.path,
            kind: "file" as const,
            deleted: false,
            size: e.size,
            ...(e.modifiedAt ? { modifiedAt: e.modifiedAt } : {}),
          }));
        changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const tip = await options.events.tip();
        return { changes, cursor: String(tip) };
      }
      const events = await options.events.since(cursorId);
      const changes: SharedChange[] = events.map((event) =>
        event.deleted
          ? { path: event.path, kind: "file" as const, deleted: true }
          : {
              path: event.path,
              kind: "file" as const,
              deleted: false,
              size: event.size,
              modifiedAt: new Date(event.mtime),
            },
      );
      changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const tip = await options.events.tip();
      return { changes, cursor: String(tip) };
    },

    // The Files API has no signed-URL route. This mode returns a plain GET URL of the file
    // (same origin, `?path=shared/…`). On a loopback Core with no bearer it downloads with
    // no credentials; a bearer-gated Core still needs auth on that URL (see low-confidence).
    async signedUrl(path, urlOptions = {}): Promise<SharedSignedUrl> {
      const parsed = parseFilePath(path);
      const asked = urlOptions.expiresInSeconds ?? DEFAULT_SIGNED_URL_SECONDS;
      if (!Number.isInteger(asked) || asked < 1) {
        throw new CoreSharedError("invalid-argument", "expiresInSeconds must be a whole number of at least 1");
      }
      const startMs = Math.floor(now() / 1000) * 1000;
      return {
        url: url("files", { path: homeRelativeSharedPath(parsed.relative) }),
        expiresAt: new Date(startMs + asked * 1000),
      };
    },
  };
}
