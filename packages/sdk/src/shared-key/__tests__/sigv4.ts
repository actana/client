// S3 requests for tests, path-style, on node:crypto and fetch: no AWS SDK. The signing itself
// lives in src/shared/sigv4.ts (the CoreShared S3 mode needs it too); this keeps the tests'
// small `s3Request(endpoint, creds, method, "bucket/key")` call shape.
import { canonicalPath, signRequest } from "../../shared/sigv4.ts";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

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
  const segments = path.split("/").filter((_, i) => i > 0 || path[0] !== "/");
  const signed = signRequest({
    method,
    endpoint: new URL(endpoint),
    path: canonicalPath(segments),
    query: options.query,
    body: options.body,
    credentials: creds,
    region: options.region ?? "us-east-1",
    nowMs: Date.now(),
  });
  const response = await fetch(signed.url, { method, headers: signed.headers, body: options.body });
  return { status: response.status, body: await response.text() };
}
