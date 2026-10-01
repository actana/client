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
      parseSharedPath(path);
      throw unavailable("list: not implemented yet");
    },
    async mkdir(path): Promise<void> {
      parseSharedPath(path);
      throw unavailable("mkdir: not implemented yet");
    },
    async rm(path): Promise<void> {
      parseSharedPath(path);
      throw unavailable("rm: not implemented yet");
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
