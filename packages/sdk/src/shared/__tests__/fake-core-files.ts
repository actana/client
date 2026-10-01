// A fake Core HTTP Files surface for the through-the-Core CoreShared contract suite.
// Route shapes, query names and status codes match control PR 620 (`core-files-routes.ts`,
// `files-ops.ts`); `shared:changed` events match control PR 619 (`shared-folder-feed.ts`).
// Real-Core runs are the control repo's job; this is what unit CI drives.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SHARED_FOLDER_NAME, type SharedChangedEvent, type SharedChangedEventSource } from "../core.ts";

export interface FakeCoreFiles {
  baseUrl: string;
  home: string;
  shared: string;
  events: SharedChangedEventSource & {
    /** Every `shared:changed` appended so far (tests). */
    all(): readonly SharedChangedEvent[];
  };
  /** Every request seen: `METHOD pathname`. */
  requests: string[];
  close(): Promise<void>;
}

type Refusal = { status: number; code: string; message: string };

function refuse(res: ServerResponse, refusal: Refusal): void {
  const body = JSON.stringify({ code: refusal.code, error: refusal.message });
  res.writeHead(refusal.status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  res.end(body);
}

function answerJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Confine a home-relative path the way control's stringRefusal + resolve do for a fake. */
function confine(home: string, requested: string): { ok: true; absolute: string; relative: string } | { ok: false; refusal: Refusal } {
  if (requested.startsWith("/") || path.isAbsolute(requested)) {
    return { ok: false, refusal: { status: 400, code: "absolute-path", message: "path must be relative to the home" } };
  }
  const trimmed = requested.replace(/\/+$/, "");
  const segments = trimmed === "" ? [] : trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return {
        ok: false,
        refusal: { status: 400, code: segment === ".." || segment === "." ? "dot-dot-segment" : "malformed-path", message: "path may not escape the home" },
      };
    }
  }
  const relative = segments.join("/");
  const absolute = relative === "" ? home : path.join(home, ...segments);
  if (!absolute.startsWith(home)) {
    return { ok: false, refusal: { status: 400, code: "outside-project-root", message: "path leaves the home" } };
  }
  return { ok: true, absolute, relative };
}

function underShared(relative: string): string | null {
  if (relative === SHARED_FOLDER_NAME) return "";
  const prefix = `${SHARED_FOLDER_NAME}/`;
  if (!relative.startsWith(prefix)) return null;
  return relative.slice(prefix.length);
}

export async function startFakeCoreFiles(): Promise<FakeCoreFiles> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "actana-fake-core-"));
  const shared = path.join(home, SHARED_FOLDER_NAME);
  await fsp.mkdir(shared, { recursive: true });

  const log: SharedChangedEvent[] = [];
  let nextId = 1;
  const appendChange = (change: Omit<SharedChangedEvent, "eventId">): number => {
    const eventId = nextId++;
    log.push({ ...change, eventId });
    return eventId;
  };
  const events: FakeCoreFiles["events"] = {
    tip: () => (log.length === 0 ? 0 : (log[log.length - 1] as SharedChangedEvent).eventId),
    since: (since) => log.filter((e) => e.eventId > since),
    all: () => log,
  };

  const noteFile = async (absolute: string, sharedRel: string, deleted: boolean): Promise<void> => {
    if (deleted) {
      appendChange({ path: sharedRel, size: 0, mtime: Date.now(), deleted: true });
      return;
    }
    const stat = await fsp.stat(absolute);
    appendChange({ path: sharedRel, size: stat.size, mtime: Math.floor(stat.mtimeMs), deleted: false });
  };

  const noteTreeDeleted = async (absolute: string, sharedRel: string): Promise<void> => {
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const childAbs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(childAbs, childRel);
        else if (entry.isFile()) appendChange({ path: childRel, size: 0, mtime: Date.now(), deleted: true });
      }
    };
    await walk(absolute, sharedRel);
  };

  const requests: string[] = [];

  const listTree = async (
    absolute: string,
    relative: string,
    depth: number,
  ): Promise<Array<{ path: string; kind: "file" | "directory"; size: number; mtime: number; mode: number; sha256: null }>> => {
    const out: Array<{ path: string; kind: "file" | "directory"; size: number; mtime: number; mode: number; sha256: null }> = [];
    const walk = async (dir: string, rel: string, level: number): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const childAbs = path.join(dir, entry.name);
        const stat = await fsp.lstat(childAbs).catch(() => null);
        if (!stat) continue;
        if (stat.isDirectory()) {
          out.push({ path: childRel, kind: "directory", size: 0, mtime: Math.floor(stat.mtimeMs), mode: stat.mode & 0o777, sha256: null });
          if (level < depth) await walk(childAbs, childRel, level + 1);
        } else if (stat.isFile()) {
          out.push({ path: childRel, kind: "file", size: stat.size, mtime: Math.floor(stat.mtimeMs), mode: stat.mode & 0o777, sha256: null });
        }
      }
    };
    const top = await fsp.lstat(absolute);
    if (!top.isDirectory()) {
      out.push({
        path: relative,
        kind: "file",
        size: top.size,
        mtime: Math.floor(top.mtimeMs),
        mode: top.mode & 0o777,
        sha256: null,
      });
      return out;
    }
    await walk(absolute, relative, 1);
    return out;
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://fake-core.invalid");
      requests.push(`${req.method} ${url.pathname}`);
      const segments = url.pathname.split("/").filter((s) => s.length > 0);
      if (segments[0] !== "v1" || segments[1] !== "files") {
        return refuse(res, { status: 404, code: "not-found", message: `no route for ${url.pathname}` });
      }
      const leaf = segments.length === 2 ? "files" : segments[2];
      if (segments.length > 3 || (segments.length === 3 && leaf !== "list" && leaf !== "folder" && leaf !== "move")) {
        return refuse(res, { status: 404, code: "not-found", message: `no route for ${url.pathname}` });
      }

      if (leaf === "move") {
        if (req.method !== "POST") {
          return refuse(res, { status: 405, code: "method-not-allowed", message: "POST only" });
        }
        const raw = await readBody(req);
        let body: { from?: unknown; to?: unknown };
        try {
          body = JSON.parse(raw.toString("utf8")) as { from?: unknown; to?: unknown };
        } catch {
          return refuse(res, { status: 400, code: "bad-request", message: "move needs JSON {from,to}" });
        }
        if (typeof body.from !== "string" || typeof body.to !== "string") {
          return refuse(res, { status: 400, code: "bad-request", message: 'a move needs a JSON body of the form {"from": <path>, "to": <path>}' });
        }
        const source = confine(home, body.from);
        if (!source.ok) return refuse(res, source.refusal);
        const target = confine(home, body.to);
        if (!target.ok) return refuse(res, target.refusal);
        if (source.relative === "" || target.relative === "") {
          return refuse(res, { status: 400, code: "malformed-path", message: "the home cannot be moved, or moved onto" });
        }
        const existing = await fsp.lstat(source.absolute).catch(() => null);
        if (!existing) {
          return refuse(res, { status: 404, code: "not-found", message: `no such path in the home: ${source.relative}` });
        }
        if (target.absolute === source.absolute || target.absolute.startsWith(source.absolute + path.sep)) {
          return refuse(res, {
            status: 400,
            code: "bad-request",
            message: `${source.relative} cannot be moved onto itself or into itself`,
          });
        }
        if (await fsp.lstat(target.absolute).catch(() => null)) {
          return refuse(res, {
            status: 409,
            code: "bad-request",
            message: `${target.relative} already exists — a move does not overwrite`,
          });
        }
        const parent = await fsp.stat(path.dirname(target.absolute)).catch(() => null);
        if (!parent?.isDirectory()) {
          return refuse(res, {
            status: 404,
            code: "not-found",
            message: `the folder for ${target.relative} does not exist — create it first`,
          });
        }
        // Emit deletes for source files, then changes at the destination (control: move = delete + change).
        const srcShared = underShared(source.relative);
        const dstShared = underShared(target.relative);
        if (existing.isDirectory() && srcShared !== null) await noteTreeDeleted(source.absolute, srcShared);
        else if (srcShared !== null) appendChange({ path: srcShared, size: 0, mtime: Date.now(), deleted: true });
        await fsp.rename(source.absolute, target.absolute);
        if (dstShared !== null) {
          if ((await fsp.lstat(target.absolute)).isDirectory()) {
            const walk = async (dir: string, rel: string): Promise<void> => {
              for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
                const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
                const childAbs = path.join(dir, entry.name);
                if (entry.isDirectory()) await walk(childAbs, childRel);
                else if (entry.isFile()) await noteFile(childAbs, childRel, false);
              }
            };
            await walk(target.absolute, dstShared);
          } else {
            await noteFile(target.absolute, dstShared, false);
          }
        }
        return answerJson(res, 200, { from: source.relative, to: target.relative, moved: true });
      }

      const requested = url.searchParams.get("path") ?? "";
      const confined = confine(home, requested);
      if (!confined.ok) return refuse(res, confined.refusal);

      if (leaf === "folder") {
        if (req.method !== "POST") {
          return refuse(res, { status: 405, code: "method-not-allowed", message: "POST only" });
        }
        if (confined.relative === "") {
          return refuse(res, { status: 400, code: "malformed-path", message: "the home exists — name a folder inside it" });
        }
        const existing = await fsp.lstat(confined.absolute).catch(() => null);
        if (existing) {
          if (existing.isDirectory()) return answerJson(res, 200, { path: confined.relative, created: false });
          return refuse(res, {
            status: 400,
            code: "bad-request",
            message: `${confined.relative} already exists and is not a folder`,
          });
        }
        await fsp.mkdir(confined.absolute, { recursive: true });
        return answerJson(res, 201, { path: confined.relative, created: true });
      }

      if (leaf === "list") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return refuse(res, { status: 405, code: "method-not-allowed", message: "GET and HEAD only" });
        }
        const exists = await fsp.lstat(confined.absolute).catch(() => null);
        if (!exists) {
          return refuse(res, { status: 404, code: "not-found", message: `no such path in the home: ${confined.relative || "."}` });
        }
        const depthParam = url.searchParams.get("depth");
        let depth = Number.POSITIVE_INFINITY;
        if (depthParam !== null && depthParam !== "" && depthParam !== "all") {
          const value = Number(depthParam);
          if (!Number.isInteger(value) || value < 1) {
            return refuse(res, {
              status: 400,
              code: "bad-request",
              message: `depth must be a whole number of levels (1 or more) or \`all\`, got ${JSON.stringify(depthParam)}`,
            });
          }
          depth = value;
        }
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "transfer-encoding": "chunked",
          "cache-control": "no-store",
          "x-actana-transfer-kind": "listing",
        });
        if (req.method === "HEAD") return res.end();
        const entries = await listTree(confined.absolute, confined.relative, depth);
        let bytes = 0;
        for (const entry of entries) {
          if (entry.kind === "file") bytes += entry.size;
          res.write(`${JSON.stringify({ type: "entry", ...entry })}\n`);
        }
        res.write(`${JSON.stringify({ type: "done", entries: entries.length, skipped: 0, bytes })}\n`);
        return res.end();
      }

      // leaf === "files"
      if (req.method === "GET" || req.method === "HEAD") {
        const stats = await fsp.stat(confined.absolute).catch(() => null);
        if (!stats) {
          return refuse(res, { status: 404, code: "not-found", message: `no such path in the home: ${confined.relative || "."}` });
        }
        if (stats.isDirectory()) {
          // Real Core streams a tar; for Shared get() we only need the kind header so the
          // client can refuse with is-folder. Body is empty.
          res.writeHead(200, {
            "content-type": "application/x-tar",
            "x-actana-transfer-kind": "tar",
            "cache-control": "no-store",
          });
          return res.end();
        }
        const body = req.method === "HEAD" ? null : await fsp.readFile(confined.absolute);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(stats.size),
          "x-actana-transfer-kind": "file",
          "x-actana-file-size": String(stats.size),
          "x-actana-file-mtime": String(Math.floor(stats.mtimeMs)),
          "cache-control": "no-store",
        });
        if (body) res.write(body);
        return res.end();
      }

      if (req.method === "PUT") {
        const contentType = (req.headers["content-type"] ?? "").toLowerCase();
        const asTar = contentType === "application/x-tar" || contentType === "application/tar";
        if (!asTar && confined.relative === "") {
          return refuse(res, {
            status: 400,
            code: "malformed-path",
            message: "a single-file write needs a name — this path resolves to the home itself.",
          });
        }
        const body = await readBody(req);
        if (!asTar) {
          const existing = await fsp.lstat(confined.absolute).catch(() => null);
          if (existing?.isDirectory()) {
            const kids = await fsp.readdir(confined.absolute);
            if (kids.length > 0) {
              return refuse(res, {
                status: 409,
                code: "directory-in-the-way",
                message: `${confined.relative} is a non-empty directory`,
              });
            }
            // Real Core (files-ops writeSingleFile): an empty directory is removed and the
            // file is written in its place. Match that so a missing client guard is visible.
            await fsp.rmdir(confined.absolute);
          }
          await fsp.mkdir(path.dirname(confined.absolute), { recursive: true });
          await fsp.writeFile(confined.absolute, body);
          const sharedRel = underShared(confined.relative);
          if (sharedRel !== null) await noteFile(confined.absolute, sharedRel, false);
          const stat = await fsp.stat(confined.absolute);
          res.writeHead(200, {
            "content-type": "application/x-ndjson",
            "transfer-encoding": "chunked",
            "cache-control": "no-store",
            "x-actana-transfer-kind": "file",
          });
          res.write(
            `${JSON.stringify({
              type: "entry",
              path: confined.relative,
              kind: "file",
              size: stat.size,
              mtime: Math.floor(stat.mtimeMs),
              mode: stat.mode & 0o777,
              sha256: null,
              result: "written",
            })}\n`,
          );
          res.write(`${JSON.stringify({ type: "done", entries: 1, bytes: stat.size })}\n`);
          return res.end();
        }
        // Tar upload is on the real Files API; this fake answers 501 so a mistaken
        // caller is obvious. CoreShared.upload uses per-file PUT instead.
        return refuse(res, { status: 501, code: "bad-request", message: "tar upload is not implemented in the fake Core" });
      }

      if (req.method === "DELETE") {
        const folderIntent = requested.trim().endsWith("/");
        if (confined.relative === "") {
          return refuse(res, {
            status: 400,
            code: "malformed-path",
            message: "the home itself cannot be deleted — name something inside it",
          });
        }
        const existing = await fsp.lstat(confined.absolute).catch(() => null);
        if (!existing) {
          return refuse(res, { status: 404, code: "not-found", message: `no such path in the home: ${confined.relative}` });
        }
        if (existing.isDirectory() && !folderIntent) {
          return refuse(res, {
            status: 400,
            code: "bad-request",
            message: `${confined.relative} is a folder — end the path with / to delete it and everything in it`,
          });
        }
        if (!existing.isDirectory() && folderIntent) {
          return refuse(res, { status: 400, code: "bad-request", message: `${confined.relative} is not a folder` });
        }
        const sharedRel = underShared(confined.relative);
        if (existing.isDirectory() && sharedRel !== null) await noteTreeDeleted(confined.absolute, sharedRel);
        else if (sharedRel !== null) appendChange({ path: sharedRel, size: 0, mtime: Date.now(), deleted: true });
        await fsp.rm(confined.absolute, { recursive: existing.isDirectory(), force: false });
        return answerJson(res, 200, {
          path: confined.relative,
          kind: existing.isDirectory() ? "directory" : "file",
          deleted: true,
        });
      }

      return refuse(res, { status: 405, code: "method-not-allowed", message: `${req.method ?? "?"} is not allowed here` });
    } catch (err) {
      refuse(res, {
        status: 500,
        code: "write-failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    home,
    shared,
    events,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await fsp.rm(home, { recursive: true, force: true });
    },
  };
}

/** A CoreFilesFetch against the fake (or any) origin — no mTLS. */
export function fakeCoreFetch(): import("../../core/files-http.ts").CoreFilesFetch {
  return async (req) => {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      ...(req.body ? { body: req.body, duplex: "half" } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    };
    return fetch(req.url, init as RequestInit);
  };
}
