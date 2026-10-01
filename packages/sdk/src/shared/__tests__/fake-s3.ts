// A small in-memory S3 for fast local runs of the contract suite: path-style, single bucket,
// object PUT/GET/HEAD/DELETE, server-side copy and ListObjectsV2 (prefix, delimiter, paging).
// It only checks that a signed request with a session token arrives; the signature itself is
// checked by sigv4.test.ts against AWS's published vectors and, for real, by SeaweedFS in CI.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface StoredObject {
  body: Buffer;
  modified: Date;
  etag: string;
}

const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  objects: Map<string, StoredObject>;
  /** Every request seen: `METHOD key`. */
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeS3(options: { bucket?: string; pageSize?: number } = {}): Promise<FakeS3> {
  const bucket = options.bucket ?? "actana-shared";
  const pageSize = options.pageSize ?? 1000;
  const objects = new Map<string, StoredObject>();
  const requests: string[] = [];

  const reply = (res: ServerResponse, status: number, body = "", headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/xml", ...headers });
    res.end(body);
  };
  const error = (res: ServerResponse, status: number, code: string): void =>
    reply(res, status, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const key = parts.slice(1).join("/");
    requests.push(`${req.method} ${key}`);

    const query = url.searchParams;
    const presigned = query.has("X-Amz-Signature");
    if (!presigned && !(req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ") && req.headers["x-amz-security-token"])) {
      return error(res, 403, "AccessDenied");
    }
    if (presigned && !query.get("X-Amz-Security-Token")) return error(res, 403, "AccessDenied");
    if (parts[0] !== bucket) return error(res, 404, "NoSuchBucket");

    if (key === "" && req.method === "GET") {
      const prefix = query.get("prefix") ?? "";
      const delimiter = query.get("delimiter") ?? "";
      const after = query.get("continuation-token") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
      const contents: string[] = [];
      const prefixes = new Set<string>();
      let count = 0;
      let last = "";
      let truncated = false;
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const cut = delimiter ? rest.indexOf(delimiter) : -1;
        const common = cut >= 0 ? prefix + rest.slice(0, cut + delimiter.length) : undefined;
        if (common !== undefined && prefixes.has(common)) {
          last = k;
          continue;
        }
        if (count >= Math.min(pageSize, Number(query.get("max-keys") ?? pageSize))) {
          truncated = true;
          break;
        }
        count += 1;
        last = k;
        if (common !== undefined) prefixes.add(common);
        else {
          const o = objects.get(k) as StoredObject;
          contents.push(
            `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.body.length}</Size></Contents>`,
          );
        }
      }
      return reply(
        res,
        200,
        `<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>${truncated}</IsTruncated>${
          truncated ? `<NextContinuationToken>${xmlEscape(last)}</NextContinuationToken>` : ""
        }${contents.join("")}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`,
      );
    }

    if (req.method === "PUT") {
      const source = req.headers["x-amz-copy-source"];
      let data: Buffer = body;
      if (typeof source === "string") {
        const from = decodeURIComponent(source).replace(/^\//, "").split("/").slice(1).join("/");
        const found = objects.get(from);
        if (!found) return error(res, 404, "NoSuchKey");
        data = found.body;
      }
      const etag = createHash("md5").update(data).digest("hex");
      objects.set(key, { body: data, modified: new Date(Math.floor(Date.now() / 1000) * 1000), etag });
      return typeof source === "string"
        ? reply(res, 200, `<?xml version="1.0"?><CopyObjectResult><ETag>"${etag}"</ETag></CopyObjectResult>`)
        : reply(res, 200, "", { etag: `"${etag}"` });
    }
    const found = objects.get(key);
    if (req.method === "DELETE") {
      objects.delete(key);
      return reply(res, 204);
    }
    if (!found) return error(res, 404, "NoSuchKey");
    const headers = { "last-modified": found.modified.toUTCString(), etag: `"${found.etag}"`, "content-type": "application/octet-stream" };
    if (req.method === "HEAD") return reply(res, 200, "", headers);
    res.writeHead(200, headers);
    return void res.end(found.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
