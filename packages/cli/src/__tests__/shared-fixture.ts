// A Shared folder with no Core behind it, for the `shared` noun's suites.
//
// `fakeShared` is an in-memory `CoreShared`: it keeps files and folders, orders a
// listing the way the interface says (folders first, then files, each by name),
// and keeps a change log so `watch(since)` has a cursor to hand back. One folder
// per Core endpoint, so a suite can tell which Core a verb reached. The command
// under test reaches it through `deps.openShared`, which is the seam the
// through-the-Core mode (client PR 39) will fill; nothing here is that mode.

import { CoreSharedError } from "@actana/sdk/shared";
import type {
  CoreShared,
  SharedChange,
  SharedEntry,
  SharedFile,
  SharedWatchResult,
} from "@actana/sdk/shared";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";
import type { OpenSharedFn, SharedHandle } from "../core/shared-gateway.ts";

type StoredFile = { body: Uint8Array; modifiedAt: Date };
type Logged = SharedChange & { seq: number };

export type FakeSharedFolder = CoreShared & {
  /** Every call, as `verb path`, in order. */
  calls: string[];
  /** Put a file there without a call being recorded or a change logged. */
  seed(path: string, body: string, modifiedAt?: Date): void;
  /** A file's text, or undefined. */
  text(path: string): string | undefined;
  folders: Set<string>;
};

export type FakeShared = {
  open: OpenSharedFn;
  /** The folder of the Core at this endpoint (created on first use). */
  folder(endpoint?: string): FakeSharedFolder;
  /** The endpoint of every Core `open` was asked for, in order. */
  opened: string[];
  /** How many handles were closed. */
  closed: { count: number };
};

export const DEFAULT_ENDPOINT = "wss://core.test:9444";

const MTIME = new Date(Date.UTC(2026, 7, 12, 0, 0, 0));

export function fakeShared(opts: { pollIntervalMs?: number } = {}): FakeShared {
  const folders = new Map<string, FakeSharedFolder>();
  const state: FakeShared = {
    opened: [],
    closed: { count: 0 },
    folder: (endpoint = DEFAULT_ENDPOINT) => {
      let found = folders.get(endpoint);
      if (!found) {
        found = makeFolder();
        folders.set(endpoint, found);
      }
      return found;
    },
    open: async (blob: CoreRegistrationBlob) => {
      state.opened.push(blob.endpoint);
      const handle: SharedHandle = {
        shared: state.folder(blob.endpoint),
        ...(opts.pollIntervalMs === undefined ? {} : { pollIntervalMs: opts.pollIntervalMs }),
        close: () => {
          state.closed.count += 1;
        },
      };
      return handle;
    },
  };
  return state;
}

function makeFolder(): FakeSharedFolder {
  const files = new Map<string, StoredFile>();
  const dirs = new Set<string>();
  const log: Logged[] = [];
  const calls: string[] = [];
  let seq = 0;

  const record = (change: SharedChange) => log.push({ ...change, seq: ++seq });
  const strip = (path: string) => path.replace(/\/$/, "");
  const parents = (path: string) => {
    const parts = strip(path).split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  };
  const refuse = (_path: string) => {};

  const folder: FakeSharedFolder = {
    calls,
    folders: dirs,
    seed: (path, body, modifiedAt = MTIME) => {
      parents(path);
      files.set(path, { body: new TextEncoder().encode(body), modifiedAt });
    },
    text: (path) => {
      const file = files.get(path);
      return file ? new TextDecoder().decode(file.body) : undefined;
    },
    async list(path) {
      calls.push(`list ${path}`);
      refuse(path);
      const base = strip(path);
      const prefix = base === "" ? "" : `${base}/`;
      const childFolders = new Set<string>();
      const entries: SharedEntry[] = [];
      for (const dir of dirs) {
        if (dir.startsWith(prefix) && dir !== base && !dir.slice(prefix.length).includes("/")) childFolders.add(dir);
      }
      for (const dir of [...childFolders].sort()) entries.push({ path: dir, kind: "folder" });
      for (const [file, stored] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
          entries.push({ path: file, kind: "file", size: stored.body.byteLength, modifiedAt: stored.modifiedAt });
        }
      }
      return entries;
    },
    async get(path): Promise<SharedFile> {
      calls.push(`get ${path}`);
      refuse(path);
      if (path.endsWith("/")) throw new CoreSharedError("is-folder", "path names a folder, a file is needed");
      const stored = files.get(path);
      if (!stored) throw new CoreSharedError("not-found", `no file at ${path}`);
      return { path, kind: "file", size: stored.body.byteLength, modifiedAt: stored.modifiedAt, body: stored.body };
    },
    async put(path, body) {
      calls.push(`put ${path}`);
      refuse(path);
      if (path.endsWith("/") || path === "") throw new CoreSharedError("is-folder", "path names a folder, a file is needed");
      if (dirs.has(path)) throw new CoreSharedError("is-folder", "a folder is already at that path");
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      parents(path);
      files.set(path, { body: bytes, modifiedAt: MTIME });
      record({ path, kind: "file", deleted: false, size: bytes.byteLength, modifiedAt: MTIME });
    },
    async mkdir(path) {
      calls.push(`mkdir ${path}`);
      refuse(path);
      const dir = strip(path);
      if (dir === "") return;
      if (files.has(dir)) throw new CoreSharedError("not-folder", "a file is already at that path");
      parents(dir);
      dirs.add(dir);
      record({ path: dir, kind: "folder", deleted: false });
    },
    async rm(path) {
      calls.push(`rm ${path}`);
      refuse(path);
      if (path === "") throw new CoreSharedError("invalid-path", "the root cannot be deleted");
      if (!path.endsWith("/")) {
        if (!files.delete(path)) throw new CoreSharedError("not-found", `no file at ${path}`);
        record({ path, kind: "file", deleted: true });
        return;
      }
      const dir = strip(path);
      if (!dirs.has(dir)) throw new CoreSharedError("not-found", `no folder at ${path}`);
      for (const file of [...files.keys()]) {
        if (file.startsWith(path)) {
          files.delete(file);
          record({ path: file, kind: "file", deleted: true });
        }
      }
      for (const d of [...dirs]) if (d === dir || d.startsWith(path)) dirs.delete(d);
      record({ path: dir, kind: "folder", deleted: true });
    },
    async move() {
      throw new Error("this test did not expect move");
    },
    async upload() {
      throw new Error("this test did not expect upload");
    },
    async watch(since): Promise<SharedWatchResult> {
      calls.push(`watch ${since ?? ""}`.trimEnd());
      let after = 0;
      if (since !== undefined) {
        if (!/^\d+$/.test(since)) throw new CoreSharedError("invalid-cursor", "that is not a cursor");
        after = Number(since);
      }
      const changes: SharedChange[] =
        since === undefined
          ? [...files].map(([path, stored]) => ({
              path,
              kind: "file" as const,
              deleted: false,
              size: stored.body.byteLength,
              modifiedAt: stored.modifiedAt,
            }))
          : log.filter((entry) => entry.seq > after).map(({ seq: _seq, ...change }) => change);
      return { changes, cursor: String(seq) };
    },
    async signedUrl() {
      throw new Error("this test did not expect signedUrl");
    },
  };
  return folder;
}
