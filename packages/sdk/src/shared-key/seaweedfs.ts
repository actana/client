import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import {
  assertValidCoreId,
  SHARED_KEY_LIFETIME_SECONDS,
  SharedKeyIssueError,
  type SharedKey,
  type SharedKeyIssuer,
} from "./types.ts";

/** Role from actana/control deploy/seaweedfs/iam.json.tmpl. */
export const SEAWEEDFS_DEFAULT_ROLE_ARN = "arn:aws:iam::role/ActanaCoreShared";

export interface SeaweedfsKeyIssuerOptions {
  /** S3 gateway base URL; STS is served on the same port (e.g. http://seaweedfs:8333). */
  endpoint: string;
  /** Must equal SEAWEEDFS_OIDC_ISSUER on the SeaweedFS side. */
  issuer: string;
  /** Must equal SEAWEEDFS_OIDC_AUDIENCE (control default `actana-shared`). */
  audience: string;
  /** The controller's master key: an RSA private key (PEM or KeyObject). It signs tokens and never leaves. */
  signingKey: string | KeyObject;
  /** `kid` the matching public key has in the JWKS SeaweedFS fetches. */
  keyId: string;
  roleArn?: string;
  /** Lifetime of the token handed to STS. Default 300. */
  tokenTtlSeconds?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  now?: () => number;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

function loadPrivateKey(signingKey: string | KeyObject): KeyObject {
  let key: KeyObject;
  try {
    key = typeof signingKey === "string" ? createPrivateKey(signingKey) : signingKey;
  } catch {
    // Node's message can describe the PEM; say nothing about its content.
    throw new SharedKeyIssueError("signingKey is not a valid private key");
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "rsa") {
    throw new SharedKeyIssueError("signingKey must be an RSA private key");
  }
  return key;
}

/** The public half as a JWKS document: what the issuer's JWKS URL must serve to SeaweedFS. */
export function publicJwks(signingKey: string | KeyObject, keyId: string): { keys: Record<string, unknown>[] } {
  const jwk = createPublicKey(loadPrivateKey(signingKey)).export({ format: "jwk" });
  return { keys: [{ ...jwk, kid: keyId, use: "sig", alg: "RS256" }] };
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

/**
 * The default issuer. The controller signs a short token per Core (`sub` = core id) and
 * SeaweedFS STS `AssumeRoleWithWebIdentity` swaps it for a 1-hour key whose role policy
 * limits it to `<prefix>/<core-id>/`.
 */
export function createSeaweedfsKeyIssuer(options: SeaweedfsKeyIssuerOptions): SharedKeyIssuer {
  const privateKey = loadPrivateKey(options.signingKey);
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const roleArn = options.roleArn ?? SEAWEEDFS_DEFAULT_ROLE_ARN;
  const tokenTtl = options.tokenTtlSeconds ?? 300;
  const url = new URL(options.endpoint);
  url.pathname = "/";

  const mintToken = (coreId: string): string => {
    const iat = Math.floor(now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid: options.keyId };
    const claims = {
      iss: options.issuer,
      aud: options.audience,
      sub: coreId,
      iat,
      nbf: iat - 30,
      exp: iat + tokenTtl,
      jti: randomUUID(),
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    return `${signingInput}.${b64url(sign("sha256", Buffer.from(signingInput), privateKey))}`;
  };

  return {
    async issue(coreId: string): Promise<SharedKey> {
      assertValidCoreId(coreId);
      const token = mintToken(coreId);
      const body = new URLSearchParams({
        Action: "AssumeRoleWithWebIdentity",
        Version: "2011-06-15",
        RoleArn: roleArn,
        RoleSessionName: coreId,
        WebIdentityToken: token,
        DurationSeconds: String(SHARED_KEY_LIFETIME_SECONDS),
      });
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "error";
        throw new SharedKeyIssueError(`could not reach the SeaweedFS STS endpoint (${reason})`);
      }
      const xml = await response.text();
      if (!response.ok) {
        const code = tag(xml, "Code");
        const message = unescapeXml(tag(xml, "Message") ?? "").replaceAll(token, "[token]");
        throw new SharedKeyIssueError(
          `SeaweedFS STS refused the key for ${coreId}: HTTP ${response.status}${code ? ` ${code}` : ""}${
            message ? `: ${message.slice(0, 200)}` : ""
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
        throw new SharedKeyIssueError("SeaweedFS STS returned an incomplete key", { status: response.status });
      }
      return Object.freeze({ accessKeyId, secretAccessKey, sessionToken, expiresAt });
    },
  };
}
