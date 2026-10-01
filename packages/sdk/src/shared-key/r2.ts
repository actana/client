import { coreRootPrefix } from "./prefix.ts";
import {
  assertValidCoreId,
  SHARED_KEY_LIFETIME_SECONDS,
  SharedKeyIssueError,
  type SharedKey,
  type SharedKeyIssuer,
} from "./types.ts";

export interface R2KeyIssuerOptions {
  /** Cloudflare account id. */
  accountId: string;
  /** Cloudflare API token that can create R2 temporary credentials. Master material. */
  apiToken: string;
  /** Parent R2 S3 access key id; temporary credentials cannot exceed its permissions. */
  parentAccessKeyId: string;
  bucket: string;
  /** Shared-folder prefix (e.g. `cores`). Each Core root is `<prefix>/<core-id>/`. */
  prefix: string;
  /** Override the Cloudflare API base (tests). Default https://api.cloudflare.com/client/v4 */
  apiBase?: string;
  /** Test seams. */
  fetch?: typeof fetch;
  now?: () => number;
}

function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Cloudflare R2 issuer. Temporary credentials with `prefixes` set to the Core's root.
 * Master material is the Cloudflare API token (and is never returned).
 */
export function createR2KeyIssuer(options: R2KeyIssuerOptions): SharedKeyIssuer {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const apiBase = (options.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  const url = `${apiBase}/accounts/${options.accountId}/r2/temp-access-credentials`;
  const master = [options.apiToken];

  return {
    async issue(coreId: string): Promise<SharedKey> {
      assertValidCoreId(coreId);
      const root = coreRootPrefix(options.prefix, coreId);
      const body = JSON.stringify({
        bucket: options.bucket,
        parentAccessKeyId: options.parentAccessKeyId,
        permission: "object-read-write",
        ttlSeconds: SHARED_KEY_LIFETIME_SECONDS,
        prefixes: [root],
      });
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiToken}`,
          },
          body,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "error";
        throw new SharedKeyIssueError(`could not reach the R2 temporary-credentials API (${reason})`);
      }
      const text = await response.text();
      let parsed: {
        success?: boolean;
        errors?: { code?: number; message?: string }[];
        result?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
      };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new SharedKeyIssueError("R2 returned a non-JSON response", { status: response.status });
      }
      if (!response.ok || parsed.success === false) {
        const err = parsed.errors?.[0];
        const message = scrubSecrets(err?.message ?? "", master).slice(0, 200);
        throw new SharedKeyIssueError(
          `R2 refused the key for ${coreId}: HTTP ${response.status}${err?.code ? ` ${err.code}` : ""}${
            message ? `: ${message}` : ""
          }`,
          { status: response.status, code: err?.code !== undefined ? String(err.code) : undefined },
        );
      }
      const accessKeyId = parsed.result?.accessKeyId;
      const secretAccessKey = parsed.result?.secretAccessKey;
      const sessionToken = parsed.result?.sessionToken;
      if (!accessKeyId || !secretAccessKey || !sessionToken) {
        throw new SharedKeyIssueError("R2 returned an incomplete key", { status: response.status });
      }
      const expiresAt = new Date(now() + SHARED_KEY_LIFETIME_SECONDS * 1000);
      return Object.freeze({ accessKeyId, secretAccessKey, sessionToken, expiresAt });
    },
  };
}
