import { createHmac, randomUUID } from "node:crypto";
import { coreRootPrefix } from "./prefix.ts";
import {
  assertValidCoreId,
  SHARED_KEY_LIFETIME_SECONDS,
  SharedKeyIssueError,
  type SharedKey,
  type SharedKeyIssuer,
} from "./types.ts";

export interface SupabaseKeyIssuerOptions {
  /** Project URL, e.g. https://xyz.supabase.co */
  url: string;
  /** Service-role key. Master material; used for the Admin API only. */
  serviceRoleKey: string;
  /** JWT secret used to mint the per-Core session token. Master material. */
  jwtSecret: string;
  bucket: string;
  /** Shared-folder prefix (e.g. `cores`). Each Core root is `<prefix>/<core-id>/`. */
  prefix: string;
  /** Test seams. */
  fetch?: typeof fetch;
  now?: () => number;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Email used for the one Auth user per Core (stable, derived from the Core id). */
export function coreMachineUserEmail(coreId: string): string {
  return `core-${coreId}@actana.shared`;
}

/**
 * Storage restriction carried on the machine user (and in the JWT). Storage RLS
 * must allow only objects under `allowed_prefix`. Same shape the prototype's
 * machineUsers path used: one user per Core, JWT as the session token.
 */
export function coreStorageRestriction(bucket: string, prefix: string, coreId: string): {
  allowed_prefix: string;
  storage_policy: { bucket: string; prefix: string };
} {
  const root = coreRootPrefix(prefix, coreId);
  return {
    allowed_prefix: root,
    storage_policy: { bucket, prefix: root },
  };
}

function signHs256Jwt(
  secret: string,
  claims: Record<string, unknown>,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

/**
 * Supabase issuer. One Auth user per Core; its JWT is the session token; the
 * user's `app_metadata` (and matching JWT claims) carry a storage policy that
 * restricts the Core to `<prefix>/<core-id>/`.
 */
export function createSupabaseKeyIssuer(options: SupabaseKeyIssuerOptions): SharedKeyIssuer {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.url.replace(/\/+$/, "");
  const master = [options.serviceRoleKey, options.jwtSecret];

  const adminHeaders = (): Record<string, string> => ({
    "content-type": "application/json",
    authorization: `Bearer ${options.serviceRoleKey}`,
    apikey: options.serviceRoleKey,
  });

  const readJson = async (response: Response): Promise<unknown> => {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SharedKeyIssueError("Supabase returned a non-JSON response", { status: response.status });
    }
  };

  const ensureUser = async (coreId: string): Promise<string> => {
    const email = coreMachineUserEmail(coreId);
    const restriction = coreStorageRestriction(options.bucket, options.prefix, coreId);
    const appMetadata = {
      core_id: coreId,
      ...restriction,
    };
    let response: Response;
    try {
      response = await doFetch(`${base}/auth/v1/admin/users`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          email,
          email_confirm: true,
          app_metadata: appMetadata,
          user_metadata: { core_id: coreId },
        }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "error";
      throw new SharedKeyIssueError(`could not reach the Supabase Auth Admin API (${reason})`);
    }
    if (response.ok) {
      const created = (await readJson(response)) as { id?: string };
      if (!created.id) throw new SharedKeyIssueError("Supabase created a user without an id", { status: response.status });
      return created.id;
    }
    // Already exists: find and update the storage restriction on the wire.
    const list = await doFetch(`${base}/auth/v1/admin/users?page=1&per_page=200`, {
      method: "GET",
      headers: adminHeaders(),
    });
    if (!list.ok) {
      const errBody = scrubSecrets(JSON.stringify(await readJson(list).catch(() => ({}))), master).slice(0, 200);
      throw new SharedKeyIssueError(
        `Supabase refused to list users for ${coreId}: HTTP ${list.status}${errBody ? `: ${errBody}` : ""}`,
        { status: list.status },
      );
    }
    const listed = (await readJson(list)) as { users?: { id: string; email?: string }[] };
    const existing = listed.users?.find((u) => u.email === email);
    if (!existing) {
      const errBody = scrubSecrets(JSON.stringify(await readJson(response).catch(() => ({}))), master).slice(0, 200);
      throw new SharedKeyIssueError(
        `Supabase refused to create the machine user for ${coreId}: HTTP ${response.status}${
          errBody ? `: ${errBody}` : ""
        }`,
        { status: response.status },
      );
    }
    const updated = await doFetch(`${base}/auth/v1/admin/users/${existing.id}`, {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ app_metadata: appMetadata }),
    });
    if (!updated.ok) {
      throw new SharedKeyIssueError(`Supabase refused to update the machine user for ${coreId}: HTTP ${updated.status}`, {
        status: updated.status,
      });
    }
    return existing.id;
  };

  return {
    async issue(coreId: string): Promise<SharedKey> {
      assertValidCoreId(coreId);
      const userId = await ensureUser(coreId);
      const iat = Math.floor(now() / 1000);
      const exp = iat + SHARED_KEY_LIFETIME_SECONDS;
      const restriction = coreStorageRestriction(options.bucket, options.prefix, coreId);
      const token = signHs256Jwt(options.jwtSecret, {
        iss: `${base}/auth/v1`,
        aud: "authenticated",
        sub: userId,
        role: "authenticated",
        iat,
        exp,
        jti: randomUUID(),
        app_metadata: { core_id: coreId, ...restriction },
      });
      return Object.freeze({
        accessKeyId: userId,
        // Public sentinel: the Core authenticates with the JWT in sessionToken.
        secretAccessKey: "supabase-user-jwt",
        sessionToken: token,
        expiresAt: new Date(exp * 1000),
      });
    },
  };
}
