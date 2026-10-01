import { signRequest } from "../shared/sigv4.ts";
import { coreRootPrefix } from "./prefix.ts";
import {
  assertValidCoreId,
  SHARED_KEY_LIFETIME_SECONDS,
  SharedKeyIssueError,
  type SharedKey,
  type SharedKeyIssuer,
} from "./types.ts";

export interface StsKeyIssuerOptions {
  /** STS endpoint base URL (e.g. https://sts.us-east-1.amazonaws.com or a Ceph/RustFS/Wasabi STS URL). */
  endpoint: string;
  /** Long-lived IAM access key that can AssumeRole. Master material; never returned. */
  accessKeyId: string;
  /** Matching secret. Master material; never returned. */
  secretAccessKey: string;
  roleArn: string;
  /** S3 bucket the session policy names. */
  bucket: string;
  /** Shared-folder prefix (e.g. `cores` or `cores/`). Each Core is limited to `<prefix>/<core-id>/`. */
  prefix: string;
  region?: string;
  /** Test seams. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** Inline session policy: objects and list under `<prefix>/<core-id>/` only. */
export function corePrefixSessionPolicy(bucket: string, prefix: string, coreId: string): string {
  const root = coreRootPrefix(prefix, coreId);
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ObjectsUnderOwnPrefix",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        Resource: [`arn:aws:s3:::${bucket}/${root}*`],
      },
      {
        Sid: "ListOwnPrefixOnly",
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { "s3:prefix": [`${root}*`] } },
      },
    ],
  });
}

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return match?.[1]?.trim() || undefined;
}

function unescapeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Generic STS issuer (AWS, Ceph RGW, RustFS, Wasabi). `AssumeRole` with an inline
 * session policy limited to `<prefix>/<core-id>/`, signed with SigV4 (no AWS SDK).
 */
export function createStsKeyIssuer(options: StsKeyIssuerOptions): SharedKeyIssuer {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const region = options.region ?? "us-east-1";
  const endpoint = new URL(options.endpoint);
  endpoint.pathname = "/";
  const master = [options.accessKeyId, options.secretAccessKey];

  return {
    async issue(coreId: string): Promise<SharedKey> {
      assertValidCoreId(coreId);
      const policy = corePrefixSessionPolicy(options.bucket, options.prefix, coreId);
      const body = new URLSearchParams({
        Action: "AssumeRole",
        Version: "2011-06-15",
        RoleArn: options.roleArn,
        RoleSessionName: coreId,
        Policy: policy,
        DurationSeconds: String(SHARED_KEY_LIFETIME_SECONDS),
      }).toString();
      const signed = signRequest({
        method: "POST",
        endpoint,
        path: "/",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
        region,
        nowMs: now(),
        service: "sts",
      });
      let response: Response;
      try {
        response = await doFetch(signed.url, { method: "POST", headers: signed.headers, body });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "error";
        throw new SharedKeyIssueError(`could not reach the STS endpoint (${reason})`);
      }
      const xml = await response.text();
      if (!response.ok) {
        const code = tag(xml, "Code");
        const message = scrubSecrets(unescapeXml(tag(xml, "Message") ?? ""), master).slice(0, 200);
        throw new SharedKeyIssueError(
          `STS refused the key for ${coreId}: HTTP ${response.status}${code ? ` ${code}` : ""}${
            message ? `: ${message}` : ""
          }`,
          { status: response.status, code },
        );
      }
      const accessKeyId = tag(xml, "AccessKeyId");
      const secretAccessKey = tag(xml, "SecretAccessKey");
      const sessionToken = tag(xml, "SessionToken");
      const expiration = tag(xml, "Expiration");
      const expiresAt = expiration ? new Date(expiration) : undefined;
      if (!accessKeyId || !secretAccessKey || !sessionToken || !expiresAt || Number.isNaN(expiresAt.getTime())) {
        throw new SharedKeyIssueError("STS returned an incomplete key", { status: response.status });
      }
      return Object.freeze({ accessKeyId, secretAccessKey, sessionToken, expiresAt });
    },
  };
}
