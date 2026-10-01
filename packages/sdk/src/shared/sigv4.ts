// AWS Signature V4 for S3 (path-style), on node:crypto and fetch: no AWS SDK. It is the helper
// PR 32 wrote for its isolation test, grown to take bytes, extra signed headers and a presigned URL.
import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 3986 percent-encoding, as S3's canonical form wants it. */
export const sigv4Encode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `/bucket/a/b` from the segments, each encoded once (S3 does not double-encode). */
export const canonicalPath = (segments: readonly string[]): string => "/" + segments.map(sigv4Encode).join("/");

const amzDate = (ms: number): string => new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, "");

const canonicalQuery = (query: Record<string, string>): string =>
  Object.entries(query)
    .map(([k, v]) => [sigv4Encode(k), sigv4Encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

function signature(creds: SigV4Credentials, day: string, region: string, service: string, toSign: string): string {
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), service), "aws4_request");
  return createHmac("sha256", signingKey).update(toSign).digest("hex");
}

export interface SignedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * Sign a request with an Authorization header. `path` is the canonical (already encoded) path.
 * Every header in `headers` is signed, together with host, x-amz-content-sha256, x-amz-date and
 * the session token; `unsignedHeaders` ride along unsigned (S3 allows that).
 * `service` defaults to `s3`; Generic STS uses `sts`.
 */
export function signRequest(input: {
  method: string;
  endpoint: URL;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  unsignedHeaders?: Record<string, string>;
  body?: Uint8Array | string;
  credentials: SigV4Credentials;
  region: string;
  nowMs: number;
  /** AWS service name in the credential scope. Default `s3`. */
  service?: string;
}): SignedRequest {
  const service = input.service ?? "s3";
  const date = amzDate(input.nowMs);
  const day = date.slice(0, 8);
  const payloadHash = sha256(input.body ?? "");
  const query = canonicalQuery(input.query ?? {});
  const signed: Record<string, string> = { host: input.endpoint.host, "x-amz-content-sha256": payloadHash, "x-amz-date": date };
  for (const [name, value] of Object.entries(input.headers ?? {})) signed[name.toLowerCase()] = value.trim();
  if (input.credentials.sessionToken) signed["x-amz-security-token"] = input.credentials.sessionToken;
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [input.method, input.path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  const sig = signature(input.credentials, day, input.region, service, toSign);
  const { host: _host, ...sendHeaders } = signed;
  return {
    url: `${input.endpoint.origin}${input.path}${query ? `?${query}` : ""}`,
    headers: {
      ...sendHeaders,
      ...input.unsignedHeaders,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
  };
}

/** A GET URL that carries its own signature (query authentication). `expiresInSeconds` is 1 to 604800. */
export function presignGetUrl(input: {
  endpoint: URL;
  path: string;
  credentials: SigV4Credentials;
  region: string;
  nowMs: number;
  expiresInSeconds: number;
}): string {
  const date = amzDate(input.nowMs);
  const day = date.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(input.expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  if (input.credentials.sessionToken) query["X-Amz-Security-Token"] = input.credentials.sessionToken;
  const q = canonicalQuery(query);
  const canonical = ["GET", input.path, q, `host:${input.endpoint.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  return `${input.endpoint.origin}${input.path}?${q}&X-Amz-Signature=${signature(input.credentials, day, input.region, "s3", toSign)}`;
}
