// Minimal AWS Signature V4 for S3 (path-style), for tests only. node:crypto and fetch, no AWS SDK.
import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();
const encode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface S3Result {
  status: number;
  body: string;
}

export async function s3Request(
  endpoint: string,
  creds: S3Credentials,
  method: "GET" | "PUT" | "DELETE" | "HEAD",
  path: string,
  options: { query?: Record<string, string>; body?: string; region?: string } = {},
): Promise<S3Result> {
  const region = options.region ?? "us-east-1";
  const url = new URL(endpoint);
  const canonicalPath = "/" + path.split("/").filter((_, i) => i > 0 || path[0] !== "/").map(encode).join("/");
  const query = Object.entries(options.query ?? {})
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(options.body ?? "");

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [method, canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");

  const response = await fetch(`${url.origin}${canonicalPath}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: options.body,
  });
  return { status: response.status, body: await response.text() };
}
