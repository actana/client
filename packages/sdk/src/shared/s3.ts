// CoreShared, directly in S3: for a controller that holds the master key. It works while the Core is
// offline or paused, because it talks to the bucket and not to the Core.
//
// Layout (what the Panel Drive reads): a file is an object at `<prefix><path>`. A folder is every
// key prefix `<prefix><path>/`; an EMPTY folder is a folder marker, a zero-byte object whose key is
// the folder path with a trailing slash (`<prefix>docs/`), the convention of the S3 console.
import type { SharedKey } from "../shared-key/types.ts";
import { parseFilePath, parseSharedPath } from "./path.ts";
import { decodeCursor, encodeCursor, type Snapshot } from "./cursor.ts";
import { canonicalPath, presignGetUrl, signRequest } from "./sigv4.ts";
import {
  CoreSharedError,
  CoreSharedPartialError,
  type CoreShared,
  type SharedChange,
  type SharedEntry,
  type SharedFile,
  type SharedSignedUrl,
  type SharedUploadEntry,
  type SharedWatchResult,
} from "./types.ts";

export interface S3CoreSharedOptions {
  /** S3 gateway base URL, path-style (e.g. http://seaweedfs:8333). */
  endpoint: string;
  bucket: string;
  /** The Core's prefix, e.g. `cores/core-a`. Every path lives under it and none can leave it. */
  prefix: string;
  region?: string;
  /** Where the key comes from: a `SharedKeyProvider` from `@actana/sdk/shared-key`, or any `{ get }`. */
  credentials: { get(): Promise<SharedKey> };
  /** Keys asked of the store per list page (its limit is 1000). Small values exist to test paging. */
  listPageSize?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  now?: () => number;
}

interface Reply {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

const utf8 = new TextEncoder();
const MARKER_TYPE = "application/x-directory";
/** S3 refuses a presigned URL valid for longer than 7 days. */
const MAX_PRESIGN_SECONDS = 604800;
const DEFAULT_SIGNED_URL_SECONDS = 300;

const unescapeXml = (text: string): string =>
  text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const tag = (xml: string, name: string): string | undefined => {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return match === null ? undefined : unescapeXml(match[1] as string);
};

interface Listed {
  key: string;
  size: number;
  modified: Date;
  etag: string;
}
interface ListPage {
  objects: Listed[];
  prefixes: string[];
}
const unavailable = (what: string, status?: number): CoreSharedError =>
  new CoreSharedError("unavailable", `${what} failed`, { status });

/** The S3 mode of CoreShared. */
export function createS3CoreShared(options: S3CoreSharedOptions): CoreShared {
  const endpoint = new URL(options.endpoint);
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const region = options.region ?? "us-east-1";
  const root = options.prefix.replace(/^\/+|\/+$/g, "");
  const rootKey = root === "" ? "" : `${root}/`;

  const keyPath = (key: string): string => canonicalPath([options.bucket, ...key.split("/")]);

  async function send(
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    key: string | undefined,
    init: { query?: Record<string, string>; body?: Uint8Array | string; headers?: Record<string, string>; unsigned?: Record<string, string> } = {},
  ): Promise<Reply> {
    const credentials = await options.credentials.get();
    const signed = signRequest({
      method,
      endpoint,
      path: key === undefined ? canonicalPath([options.bucket]) : keyPath(key),
      query: init.query,
      headers: init.headers,
      unsignedHeaders: init.unsigned,
      body: init.body,
      credentials,
      region,
      nowMs: now(),
    });
    let response: Response;
    try {
      response = await doFetch(signed.url, {
        method,
        headers: signed.headers,
        body: typeof init.body === "string" ? utf8.encode(init.body) : init.body,
      });
    } catch (error) {
      throw new CoreSharedError("unavailable", `the store could not be reached (${error instanceof Error ? error.name : "error"})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status >= 200 && response.status < 300) return { status: response.status, headers: response.headers, bytes };
    const text = new TextDecoder().decode(bytes);
    const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
    if (response.status === 404 || code === "NoSuchKey") throw new CoreSharedError("not-found", "not found", { status: 404 });
    if (code === "ExpiredToken" || code === "InvalidToken") throw new CoreSharedError("expired", "the key has expired", { status: response.status });
    if (response.status === 403 || response.status === 401) throw new CoreSharedError("forbidden", "the key may not do this", { status: response.status });
    throw unavailable(`${method} ${code ?? response.status}`, response.status);
  }

  const fileKey = (relative: string): string => rootKey + relative;
  /** The key prefix of a folder: `<root>a/b/`; the root's own prefix for the root. */
  const folderPrefix = (relative: string): string => (relative === "" ? rootKey : `${rootKey}${relative}/`);
  /** A key back to a path relative to the root. */
  const relativeOf = (key: string): string => key.slice(rootKey.length);

  /** Every page of a ListObjectsV2 under `prefix`; with a delimiter it also yields the folders. */
  async function* listPages(prefix: string, delimiter?: string, pageSize = options.listPageSize): AsyncGenerator<ListPage> {
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2" };
      if (prefix !== "") query.prefix = prefix;
      if (delimiter) query.delimiter = delimiter;
      if (pageSize) query["max-keys"] = String(pageSize);
      if (token) query["continuation-token"] = token;
      const xml = new TextDecoder().decode((await send("GET", undefined, { query })).bytes);
      const objects: Listed[] = [];
      for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const body = block[1] as string;
        const key = tag(body, "Key");
        if (key === undefined) continue;
        objects.push({
          key,
          size: Number(tag(body, "Size") ?? 0),
          modified: new Date(tag(body, "LastModified") ?? 0),
          etag: tag(body, "ETag") ?? "",
        });
      }
      const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)].map((m) => unescapeXml(m[1] as string));
      yield { objects, prefixes };
      token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
      if (tag(xml, "IsTruncated") === "true" && token === undefined) throw unavailable("list (no continuation token)");
    } while (token !== undefined);
  }

  /** Every key under a prefix, folder markers included. */
  async function allKeys(prefix: string): Promise<Listed[]> {
    const all: Listed[] = [];
    for await (const page of listPages(prefix)) all.push(...page.objects);
    return all;
  }

  /**
   * What deleting a folder deletes, in order: its files, then its directory keys, deepest first.
   * The directory keys are the folder markers the listing shows PLUS every ancestor directory of
   * every key down to the folder itself: SeaweedFS keeps a directory after its last file is deleted
   * (a delimiter listing still shows it), and a DELETE on `dir/` removes an empty one, does nothing
   * to one that still has something in it, and on S3 proper is a delete of a key that is not there.
   */
  function deletionOrder(folderKey: string, keys: readonly string[]): string[] {
    const dirs = new Set<string>([folderKey]);
    const files: string[] = [];
    for (const key of keys) {
      if (key.endsWith("/")) dirs.add(key);
      else files.push(key);
      for (let i = key.indexOf("/", folderKey.length); i !== -1; i = key.indexOf("/", i + 1)) dirs.add(key.slice(0, i + 1));
    }
    return [...files, ...[...dirs].sort().reverse()];
  }

  async function exists(key: string): Promise<boolean> {
    try {
      await send("HEAD", key);
      return true;
    } catch (error) {
      if (error instanceof CoreSharedError && error.code === "not-found") return false;
      throw error;
    }
  }

  /** True when anything at all is under `prefix`. */
  async function anyUnder(prefix: string): Promise<boolean> {
    for await (const page of listPages(prefix, undefined, 1)) return page.objects.length > 0;
    return false;
  }

  /** A file and a folder of the same name are one name on a Core's disk, so S3 may not hold both. */
  async function assertNoFolderAt(relative: string): Promise<void> {
    if (await anyUnder(`${fileKey(relative)}/`)) throw new CoreSharedError("is-folder", "a folder is already at that path");
  }
  async function assertNoFileAt(relative: string): Promise<void> {
    if (await exists(fileKey(relative))) throw new CoreSharedError("not-folder", "a file is already at that path");
  }

  /** Server-side copy; S3 can answer 200 and still carry an error in the body. */
  async function copyKey(from: string, to: string): Promise<void> {
    if (from.endsWith("/")) {
      // SeaweedFS keeps a folder marker as a directory and refuses to copy it, so it is made again.
      await send("PUT", to, { body: "", unsigned: { "content-type": MARKER_TYPE } });
      return;
    }
    const reply = await send("PUT", to, { headers: { "x-amz-copy-source": keyPath(from) } });
    if (/<Error>/.test(new TextDecoder().decode(reply.bytes))) throw unavailable("copy");
  }

  /** Delete the objects at `keys`, stopping at the first failure and saying which were left. */
  async function deleteKeys(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1) {
      try {
        await send("DELETE", keys[i] as string);
      } catch (error) {
        if (!(error instanceof CoreSharedError)) throw error;
        throw new CoreSharedPartialError("rm", "delete", keys.slice(i).map(relativeOf), error);
      }
    }
  }

  return {
    async get(path): Promise<SharedFile> {
      const parsed = parseFilePath(path);
      const reply = await send("GET", fileKey(parsed.relative));
      const modified = reply.headers.get("last-modified");
      return {
        path: parsed.relative,
        kind: "file",
        size: reply.bytes.byteLength,
        ...(modified ? { modifiedAt: new Date(modified) } : {}),
        body: reply.bytes,
      };
    },

    async put(path, body): Promise<void> {
      const parsed = parseFilePath(path);
      await assertNoFolderAt(parsed.relative);
      await send("PUT", fileKey(parsed.relative), { body });
    },

    async list(path): Promise<SharedEntry[]> {
      const parsed = parseSharedPath(path);
      const prefix = folderPrefix(parsed.relative);
      const folders: SharedEntry[] = [];
      const files: SharedEntry[] = [];
      for await (const page of listPages(prefix, "/")) {
        for (const common of page.prefixes) {
          folders.push({ path: relativeOf(common.slice(0, -1)), kind: "folder" });
        }
        for (const object of page.objects) {
          if (object.key === prefix) continue; // the folder's own marker
          files.push({ path: relativeOf(object.key), kind: "file", size: object.size, modifiedAt: object.modified });
        }
      }
      const byPath = (a: SharedEntry, b: SharedEntry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      return [...folders.sort(byPath), ...files.sort(byPath)];
    },

    async mkdir(path): Promise<void> {
      const parsed = parseSharedPath(path);
      if (parsed.segments.length === 0) return; // the root always exists
      await assertNoFileAt(parsed.relative);
      await send("PUT", folderPrefix(parsed.relative), { body: "", unsigned: { "content-type": MARKER_TYPE } });
    },

    async rm(path): Promise<void> {
      const parsed = parseSharedPath(path);
      if (parsed.segments.length === 0) throw new CoreSharedError("invalid-path", "the root cannot be deleted");
      if (!parsed.folder) {
        await send("HEAD", fileKey(parsed.relative)); // not-found if it is not there; DELETE alone would say yes
        await send("DELETE", fileKey(parsed.relative));
        return;
      }
      const keys = (await allKeys(folderPrefix(parsed.relative))).map((o) => o.key);
      if (keys.length === 0) throw new CoreSharedError("not-found", "not found", { status: 404 });
      // Files first, then directories deepest first, the folder itself last: a stop part-way leaves the folder there.
      await deleteKeys(deletionOrder(folderPrefix(parsed.relative), keys));
    },
    // S3 has no rename, so a move is copy, then delete. The destination is complete before the first
    // source is deleted. A failed COPY is rolled back (the source was never touched), so it changes
    // nothing unless the rollback fails too; a failed DELETE leaves the source part-there and the
    // destination complete: both are reported by a CoreSharedPartialError listing what is left.
    // Files go first and directories after, deepest first, in both phases (see deletionOrder).
    async move(from, to): Promise<void> {
      const src = parseSharedPath(from, "from");
      const dst = parseSharedPath(to, "to");
      if (src.segments.length === 0 || dst.segments.length === 0) throw new CoreSharedError("invalid-path", "the root cannot be moved or replaced");
      if (src.folder !== dst.folder) throw new CoreSharedError("invalid-path", "from and to must both name files or both name folders (a folder ends in /)");

      let pairs: { from: string; to: string }[];
      let removals: string[];
      if (!src.folder) {
        const fromKey = fileKey(src.relative);
        if (!(await exists(fromKey))) throw new CoreSharedError("not-found", "not found", { status: 404 });
        if (await exists(fileKey(dst.relative))) throw new CoreSharedError("exists", "the destination is taken");
        pairs = [{ from: fromKey, to: fileKey(dst.relative) }];
        removals = [fromKey];
      } else {
        const fromPrefix = folderPrefix(src.relative);
        const toPrefix = folderPrefix(dst.relative);
        if (toPrefix.startsWith(fromPrefix)) throw new CoreSharedError("invalid-move", "a folder cannot move into itself");
        const keys = (await allKeys(fromPrefix)).map((o) => o.key);
        if (keys.length === 0) throw new CoreSharedError("not-found", "not found", { status: 404 });
        if (await anyUnder(toPrefix)) throw new CoreSharedError("exists", "the destination is taken");
        // Copy what is there (files and the folder markers the listing shows); delete in deletionOrder.
        pairs = keys.map((key) => ({ from: key, to: toPrefix + key.slice(fromPrefix.length) }));
        removals = deletionOrder(fromPrefix, keys);
      }

      const copied: string[] = [];
      for (const pair of pairs) {
        try {
          await copyKey(pair.from, pair.to);
          copied.push(pair.to);
        } catch (error) {
          if (!(error instanceof CoreSharedError)) throw error;
          const stuck: string[] = [];
          for (const key of copied) {
            try {
              await send("DELETE", key);
            } catch {
              stuck.push(key);
            }
          }
          if (stuck.length === 0) throw error; // rolled back: nothing changed
          throw new CoreSharedPartialError("move", "copy", stuck.map(relativeOf), error);
        }
      }
      const sources = removals;
      for (let i = 0; i < sources.length; i += 1) {
        try {
          await send("DELETE", sources[i] as string);
        } catch (error) {
          if (!(error instanceof CoreSharedError)) throw error;
          throw new CoreSharedPartialError("move", "delete", sources.slice(i).map(relativeOf), error);
        }
      }
    },

    async upload(destination, entries: Iterable<SharedUploadEntry>): Promise<string[]> {
      const dest = parseSharedPath(destination, "destination");
      // All of it is checked before anything is written.
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
      const written: string[] = [];
      for (const { relative, entry } of plan) {
        try {
          if ("body" in entry) {
            await assertNoFolderAt(relative);
            await send("PUT", fileKey(relative), { body: entry.body });
          } else {
            await assertNoFileAt(relative);
            await send("PUT", folderPrefix(relative), { body: "", unsigned: { "content-type": MARKER_TYPE } });
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
    // S3 has no change feed. Each call lists everything under the prefix and diffs it against the
    // listing the cursor remembers (see cursor.ts). A move shows as a delete plus a change.
    async watch(since): Promise<SharedWatchResult> {
      const before: Snapshot = since === undefined ? new Map() : decodeCursor(rootKey, since);
      const current: Snapshot = new Map();
      const details = new Map<string, Listed>();
      for (const object of await allKeys(rootKey)) {
        if (object.key === rootKey) continue; // the root's own marker
        const folder = object.key.endsWith("/");
        const path = relativeOf(folder ? object.key.slice(0, -1) : object.key);
        const kind = folder ? "folder" : "file";
        current.set(path, `${kind}:${object.size}:${object.modified.getTime()}:${object.etag}`);
        details.set(path, object);
      }
      const changes: SharedChange[] = [];
      for (const [path, state] of current) {
        if (before.get(path) === state) continue;
        const object = details.get(path) as Listed;
        changes.push(
          state.startsWith("folder:")
            ? { path, kind: "folder", deleted: false, modifiedAt: object.modified }
            : { path, kind: "file", deleted: false, size: object.size, modifiedAt: object.modified },
        );
      }
      for (const [path, state] of before) {
        if (!current.has(path)) changes.push({ path, kind: state.startsWith("folder:") ? "folder" : "file", deleted: true });
      }
      changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { changes, cursor: encodeCursor(rootKey, current) };
    },

    // Signed locally, no request. It never outlives the key that signs it: a URL valid longer than
    // the key would only be refused by the store once the key's session ends.
    async signedUrl(path, urlOptions = {}): Promise<SharedSignedUrl> {
      const parsed = parseFilePath(path);
      const asked = urlOptions.expiresInSeconds ?? DEFAULT_SIGNED_URL_SECONDS;
      if (!Number.isInteger(asked) || asked < 1) throw new CoreSharedError("invalid-argument", "expiresInSeconds must be a whole number of at least 1");
      const credentials = await options.credentials.get();
      const nowMs = now();
      const left = Math.floor((credentials.expiresAt.getTime() - nowMs) / 1000);
      if (left < 1) throw new CoreSharedError("expired", "the key has expired");
      const seconds = Math.min(asked, MAX_PRESIGN_SECONDS, left);
      const startMs = Math.floor(nowMs / 1000) * 1000;
      return {
        url: presignGetUrl({ endpoint, path: keyPath(fileKey(parsed.relative)), credentials, region, nowMs: startMs, expiresInSeconds: seconds }),
        expiresAt: new Date(startMs + seconds * 1000),
      };
    },
  };
}
