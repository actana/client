// A Core's home folder with no Core behind it, for the `files` noun's suites.
//
// `fakeHome` is an in-memory Files API with the routes and answers of control PR 620
// (`core-files-routes.ts`, `files-ops.ts`): `GET|PUT|DELETE /v1/files?path=`,
// `GET /v1/files/list?path=&depth=&sha256=`, paths relative to `~`, and the same
// refusal codes and statuses. It is a `fetch`, not a socket, and the command reaches it
// through the real SDK `CoreFiles`, so what these suites prove is the command and the
// client's URLs, headers and refusals together; the real Core's own routes are control's
// suite and the SDK's rig (`files-rig.ts` there, which runs the real handler).
// One home per Core endpoint, so a suite can tell which Core a verb reached.

import { CoreFiles, type CoreFilesFetch, type CoreFilesRequest } from "@actana/sdk/core";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";
import type { FilesHandle, OpenFilesFn } from "../core/files-gateway.ts";

type Stored = { body: Uint8Array; mtime: number };

export type FakeHome = {
  /** Every request, as `METHOD pathname?query`, in order. */
  requests: string[];
  /** Put a file there without a request being recorded. */
  seed(path: string, body: string | Uint8Array, mtime?: number): void;
  /** Make an (empty) folder. */
  folder(path: string): void;
  /** A file's text, or undefined. */
  text(path: string): string | undefined;
  has(path: string): boolean;
};

export type FakeFiles = {
  open: OpenFilesFn;
  /** The home of the Core at this endpoint (created on first use). */
  home(endpoint?: string): FakeHome;
  /** The endpoint of every Core `open` was asked for, in order. */
  opened: string[];
  closed: { count: number };
  /** Make every request on this endpoint fail the way an unreachable Core does. */
  down(endpoint: string): void;
};

export const FILES_ENDPOINT = "wss://core.test:9444";
const MTIME = Date.UTC(2026, 7, 12, 0, 0, 0);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const refuse = (status: number, code: string, error: string): Response => json(status, { code, error });

/** The checks control's `stringRefusal` makes first, with its codes. */
function unsafe(path: string): Response | null {
  if (path.includes("\0")) return refuse(400, "malformed-path", "path contains a NUL byte");
  if (path.includes("\\")) return refuse(400, "malformed-path", "path contains a backslash");
  if (path.startsWith("/")) return refuse(400, "absolute-path", "path must be relative to the home");
  if (path.split("/").includes("..")) return refuse(400, "dot-dot-segment", "path may not contain ..");
  return null;
}

async function readAll(body: ReadableStream<Uint8Array> | null | undefined): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  if (body) for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

function makeHome(): { home: FakeHome; fetch: CoreFilesFetch } {
  const files = new Map<string, Stored>();
  const folders = new Set<string>();
  const requests: string[] = [];

  const clean = (p: string): string => p.replace(/\/+$/, "");
  const hasFolder = (p: string): boolean =>
    p === "" || folders.has(p) || [...files.keys(), ...folders].some((k) => k.startsWith(`${p}/`));
  const ensureParents = (p: string): void => {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  };

  const home: FakeHome = {
    requests,
    seed(path, body, mtime = MTIME) {
      ensureParents(path);
      files.set(path, { body: typeof body === "string" ? new TextEncoder().encode(body) : body, mtime });
    },
    folder(path) {
      ensureParents(`${path}/x`);
      folders.add(clean(path));
    },
    text: (path) => (files.has(path) ? new TextDecoder().decode(files.get(path)!.body) : undefined),
    has: (path) => files.has(path) || hasFolder(clean(path)),
  };

  const fetch: CoreFilesFetch = async (req: CoreFilesRequest) => {
    const url = new URL(req.url);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const route = url.pathname;
    if (route !== "/v1/files" && route !== "/v1/files/list") return refuse(404, "not-found", `no route for ${route}`);
    const requested = url.searchParams.get("path") ?? "";
    const bad = unsafe(requested);
    if (bad) return bad;
    const rel = clean(requested);

    if (route === "/v1/files/list") {
      if (!hasFolder(rel) && !files.has(rel)) return refuse(404, "not-found", `no such path in the home: ${rel || "."}`);
      const depthParam = url.searchParams.get("depth");
      const depth = depthParam === null || depthParam === "all" ? Infinity : Number(depthParam);
      const withSha = url.searchParams.get("sha256") === "1";
      const under = (p: string): number | null => {
        if (rel === "") return p.split("/").length;
        if (!p.startsWith(`${rel}/`)) return null;
        return p.slice(rel.length + 1).split("/").length;
      };
      const entries: Record<string, unknown>[] = [];
      for (const dir of [...new Set([...folders, ...[...files.keys()].flatMap((f) => parentsOf(f))])].sort()) {
        const level = under(dir);
        if (level !== null && level <= depth) entries.push({ type: "entry", path: dir, kind: "directory", size: 0, mtime: MTIME, mode: 0o755, sha256: null });
      }
      for (const [p, f] of [...files].sort()) {
        const level = under(p);
        if (level !== null && level <= depth) {
          entries.push({ type: "entry", path: p, kind: "file", size: f.body.byteLength, mtime: f.mtime, mode: 0o644, sha256: withSha ? `sha-of-${p}` : null });
        }
      }
      const lines = [...entries, { type: "done", entries: entries.length, skipped: 0, bytes: 0 }];
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
        status: 200,
        headers: { "content-type": "application/x-ndjson", "x-actana-transfer-kind": "listing" },
      });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const f = files.get(rel);
      if (f) {
        return new Response(f.body as unknown as ConstructorParameters<typeof Response>[0], {
          status: 200,
          headers: { "content-type": "application/octet-stream", "x-actana-transfer-kind": "file", "x-actana-file-size": String(f.body.byteLength), "x-actana-file-mtime": String(f.mtime) },
        });
      }
      if (hasFolder(rel)) return new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/x-tar", "x-actana-transfer-kind": "tar" } });
      return refuse(404, "not-found", `no such path in the home: ${rel || "."}`);
    }

    if (req.method === "PUT") {
      if (rel === "") return refuse(400, "malformed-path", "a single-file write needs a name — this path resolves to the home itself.");
      if (files.has(rel) === false && hasFolder(rel)) return refuse(409, "directory-in-the-way", `${rel} is a non-empty directory`);
      const body = await readAll(req.body);
      home.seed(rel, body, MTIME);
      const done = [
        { type: "entry", path: rel, kind: "file", size: body.byteLength, mtime: MTIME, mode: 0o644, sha256: null, result: "written" },
        { type: "done", entries: 1, bytes: body.byteLength },
      ];
      return new Response(done.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }

    if (req.method === "DELETE") {
      if (rel === "") return refuse(400, "malformed-path", "the home itself cannot be deleted — name something inside it");
      const folderIntent = requested.endsWith("/");
      if (folderIntent) {
        if (files.has(rel)) return refuse(400, "bad-request", `${rel} is a file — drop the trailing slash`);
        if (!hasFolder(rel)) return refuse(404, "not-found", `no such path in the home: ${rel}`);
        for (const key of [...files.keys()]) if (key.startsWith(`${rel}/`)) files.delete(key);
        for (const key of [...folders]) if (key === rel || key.startsWith(`${rel}/`)) folders.delete(key);
        return json(200, { path: rel, deleted: true });
      }
      if (!files.has(rel) && !hasFolder(rel)) return refuse(404, "not-found", `no such path in the home: ${rel}`);
      if (!files.has(rel)) return refuse(400, "bad-request", `${rel} is a folder — end the path with / to delete it and everything in it`);
      files.delete(rel);
      return json(200, { path: rel, deleted: true });
    }

    return refuse(405, "method-not-allowed", `${req.method} is not allowed here`);
  };

  return { home, fetch };
}

function parentsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function fakeFiles(): FakeFiles {
  const homes = new Map<string, { home: FakeHome; fetch: CoreFilesFetch }>();
  const downEndpoints = new Set<string>();
  const homeFor = (endpoint: string): { home: FakeHome; fetch: CoreFilesFetch } => {
    let found = homes.get(endpoint);
    if (!found) {
      found = makeHome();
      homes.set(endpoint, found);
    }
    return found;
  };
  const state: FakeFiles = {
    opened: [],
    closed: { count: 0 },
    home: (endpoint = FILES_ENDPOINT) => homeFor(endpoint).home,
    down: (endpoint) => void downEndpoints.add(endpoint),
    open: async (blob: CoreRegistrationBlob) => {
      state.opened.push(blob.endpoint);
      if (downEndpoints.has(blob.endpoint)) throw new Error("connect ECONNREFUSED");
      const { fetch } = homeFor(blob.endpoint);
      const handle: FilesHandle = {
        files: new CoreFiles({ baseUrl: "https://core.invalid", bearer: null, availability: () => ({ available: true }), fetch }),
        close: () => void (state.closed.count += 1),
      };
      return handle;
    },
  };
  return state;
}
