// An in-memory `CoreShared` (the public interface of `@actana/sdk/shared`) for the tests that must
// run with no object store. It follows the interface's rules for what the recipe touches: folders
// are paths ending in `/`, a missing folder lists as empty, `put` creates parents, `move` onto a
// taken path is `exists`, and `watch(since)` reports every file changed after `since`, with a cursor.
//
// The S3 mode itself is NOT exercised here: that runs against SeaweedFS in CI (`seaweedfs.test.mjs`).
import { CoreSharedError } from "@actana/sdk/shared";

const encoder = new TextEncoder();

export function createMemoryShared({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {body: Uint8Array, at: number, seq: number}>} */
  const files = new Map();
  /** @type {{seq: number, path: string, deleted: boolean, at: number}[]} */
  const log = [];
  let seq = 0;
  const record = (path, deleted, at) => log.push({ seq: ++seq, path, deleted, at });

  const shared = {
    async list(path) {
      const folder = path === "" ? "" : path.endsWith("/") ? path : `${path}/`;
      const names = new Map();
      for (const [key, file] of files) {
        if (!key.startsWith(folder)) continue;
        const rest = key.slice(folder.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          names.set(rest, { path: key, kind: "file", size: file.body.length, modifiedAt: new Date(file.at) });
        } else {
          names.set(rest.slice(0, slash), { path: `${folder}${rest.slice(0, slash)}`, kind: "folder" });
        }
      }
      return [...names.values()].sort((a, b) => (a.kind === b.kind ? (a.path < b.path ? -1 : 1) : a.kind === "folder" ? -1 : 1));
    },
    async get(path) {
      const file = files.get(path);
      if (!file) throw new CoreSharedError("not-found", "no such file");
      return { path, kind: "file", size: file.body.length, modifiedAt: new Date(file.at), body: file.body };
    },
    async put(path, body, at = now()) {
      files.set(path, { body: typeof body === "string" ? encoder.encode(body) : body, at, seq: seq + 1 });
      record(path, false, at);
    },
    async mkdir() {},
    async rm(path) {
      if (files.delete(path)) record(path, true, now());
    },
    async move(from, to) {
      const file = files.get(from);
      if (!file) throw new CoreSharedError("not-found", "no such file");
      if (files.has(to)) throw new CoreSharedError("exists", "the destination is taken");
      files.delete(from);
      record(from, true, now());
      files.set(to, file);
      record(to, false, file.at);
    },
    async upload() {
      throw new Error("not used by the recipe");
    },
    async watch(since) {
      const from = since === undefined ? 0 : Number(since);
      if (since !== undefined && !Number.isInteger(from)) throw new CoreSharedError("invalid-cursor", "not a cursor");
      const latest = new Map();
      for (const entry of log) if (entry.seq > from) latest.set(entry.path, entry);
      const changes = [...latest.values()].map((e) => {
        const file = files.get(e.path);
        return e.deleted
          ? { path: e.path, kind: "file", deleted: true }
          : { path: e.path, kind: "file", deleted: false, size: file?.body.length ?? 0, modifiedAt: new Date(e.at) };
      });
      return { changes, cursor: String(seq) };
    },
    async signedUrl() {
      throw new Error("not used by the recipe");
    },
  };
  return shared;
}
