// The S3 mode's change cursor. S3 has no change feed, so a cursor is the listing as it was: a
// snapshot of every entry under the Core's prefix, and the next `watch` diffs a fresh listing
// against it (the prototype's `changes since` shape, with the feed rebuilt by polling).
// It is opaque to callers (gzip + base64url), versioned, and bound to the prefix it came from.
// It grows with the number of entries (about 40 bytes each, compressed), which is the price of
// reporting deletions without a server-side log.
import { gunzipSync, gzipSync } from "node:zlib";
import { CoreSharedError } from "./types.ts";

/** path -> `kind:size:mtimeMs:etag` */
export type Snapshot = Map<string, string>;

const VERSION = 1;
const MAX_JSON_BYTES = 64 * 1024 * 1024;

export function encodeCursor(rootKey: string, snapshot: Snapshot): string {
  const body = JSON.stringify({ v: VERSION, r: rootKey, e: [...snapshot] });
  return gzipSync(Buffer.from(body)).toString("base64url");
}

export function decodeCursor(rootKey: string, cursor: unknown): Snapshot {
  const bad = (why: string): CoreSharedError => new CoreSharedError("invalid-cursor", `the cursor is not valid (${why})`);
  if (typeof cursor !== "string" || cursor === "") throw bad("not a string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(Buffer.from(cursor, "base64url"), { maxOutputLength: MAX_JSON_BYTES }).toString("utf8"));
  } catch {
    throw bad("unreadable");
  }
  const doc = parsed as { v?: unknown; r?: unknown; e?: unknown };
  if (doc === null || typeof doc !== "object" || doc.v !== VERSION) throw bad("unknown version");
  if (doc.r !== rootKey) throw bad("it belongs to another Shared folder");
  if (!Array.isArray(doc.e)) throw bad("no entries");
  const snapshot: Snapshot = new Map();
  for (const item of doc.e) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string") throw bad("bad entry");
    snapshot.set(item[0], item[1]);
  }
  return snapshot;
}
