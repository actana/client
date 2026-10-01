// CoreShared, directly in S3: for a controller that holds the master key. It works while the Core is
// offline or paused, because it talks to the bucket and not to the Core.
//
// Layout (what the Panel Drive reads): a file is an object at `<prefix><path>`. A folder is every
// key prefix `<prefix><path>/`; an EMPTY folder is a folder marker, a zero-byte object whose key is
// the folder path with a trailing slash (`<prefix>docs/`), the convention of the S3 console.
import type { SharedKey } from "../shared-key/types.ts";
import { parseFilePath, parseSharedPath } from "./path.ts";
import { canonicalPath, signRequest } from "./sigv4.ts";
import {
  CoreSharedError,
  CoreSharedPartialError,
  type CoreShared,
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
  async function* listPages(prefix: string, delimiter?: string): AsyncGenerator<ListPage> {
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2" };
      if (prefix !== "") query.prefix = prefix;
      if (delimiter) query.delimiter = delimiter;
      if (options.listPageSize) query["max-keys"] = String(options.listPageSize);
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
      // Contents first, the folder's own marker last: a stop part-way leaves the folder still there.
      const marker = folderPrefix(parsed.relative);
      await deleteKeys([...keys.filter((k) => k !== marker), ...keys.filter((k) => k === marker)]);
    },
    async move(from, to): Promise<void> {
      parseSharedPath(from, "from");
      parseSharedPath(to, "to");
      throw unavailable("move: not implemented yet");
    },
    async upload(_destination, _entries: Iterable<SharedUploadEntry>): Promise<string[]> {
      throw unavailable("upload: not implemented yet");
    },
    async watch(): Promise<SharedWatchResult> {
      throw unavailable("watch: not implemented yet");
    },
    async signedUrl(): Promise<SharedSignedUrl> {
      throw unavailable("signedUrl: not implemented yet");
    },
  };
}
