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
  /**
   * Public anon key. Returned as `SharedKey.secretAccessKey` so the Core can
   * sign Supabase S3 requests with the session token (see Supabase S3 auth).
   */
  anonKey: string;
  /**
   * Project ref returned as `SharedKey.accessKeyId`. Default: the first label
   * of `url`'s hostname (`xyz` from `https://xyz.supabase.co`).
   */
  projectRef?: string;
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
 * Storage restriction carried on the machine user (and in the JWT). This alone
 * does not limit the Core: apply {@link supabaseCoreStorageRlsSql} on the
 * project, or the token is an ordinary `authenticated` JWT.
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

/**
 * RLS on `storage.objects` that limits each Core to its `allowed_prefix`.
 * The issuer only writes that claim onto the user and JWT; **without this
 * policy (or an equivalent) the issuer restricts nothing.**
 */
export function supabaseCoreStorageRlsSql(bucket: string): string {
  const b = bucket.replaceAll("'", "''");
  // starts_with: literal prefix match. LIKE would treat '_' in a Core id as a wildcard.
  return `-- Actana Shared-folder: one Core per Auth user.
-- The issuer sets auth.jwt() -> 'app_metadata' ->> 'allowed_prefix' to
-- '<prefix>/<core-id>/'. Without these policies the issued JWT is not limited.
-- Run once per project (adjust the bucket name).
-- Use starts_with (not LIKE): Core ids may contain '_', which LIKE treats as a wildcard.

CREATE POLICY actana_core_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = '${b}'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  );

CREATE POLICY actana_core_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = '${b}'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  );

CREATE POLICY actana_core_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = '${b}'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  )
  WITH CHECK (
    bucket_id = '${b}'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  );

CREATE POLICY actana_core_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = '${b}'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  );
`;
}

function signHs256Jwt(secret: string, claims: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

function projectRefFromUrl(url: string): string {
  const host = new URL(url).hostname;
  const ref = host.split(".")[0];
  if (!ref) {
    throw new SharedKeyIssueError("could not derive projectRef from url: set projectRef explicitly");
  }
  return ref;
}

/**
 * Supabase issuer. One Auth user per Core; its JWT is the session token.
 * Returned credentials match Supabase S3 session-token auth: project ref +
 * anon key + JWT. The user's `app_metadata.allowed_prefix` is what
 * {@link supabaseCoreStorageRlsSql} compares; the issuer alone restricts nothing.
 */
export function createSupabaseKeyIssuer(options: SupabaseKeyIssuerOptions): SharedKeyIssuer {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.url.replace(/\/+$/, "");
  const projectRef = options.projectRef ?? projectRefFromUrl(base);
  const master = [options.serviceRoleKey, options.jwtSecret];
  const listPageSize = 200;

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

  const findUserByEmail = async (email: string, coreId: string): Promise<{ id: string; email?: string } | undefined> => {
    for (let page = 1; ; page++) {
      const list = await doFetch(`${base}/auth/v1/admin/users?page=${page}&per_page=${listPageSize}`, {
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
      const pageUsers = listed.users ?? [];
      const found = pageUsers.find((u) => u.email === email);
      if (found) return found;
      if (pageUsers.length < listPageSize) return undefined;
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
    // Already exists (or create refused): page the Admin list until found, then update.
    const existing = await findUserByEmail(email, coreId);
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
      // Supabase S3 session-token auth: accessKeyId = project ref, secret = anon key, token = JWT.
      return Object.freeze({
        accessKeyId: projectRef,
        secretAccessKey: options.anonKey,
        sessionToken: token,
        expiresAt: new Date(exp * 1000),
      });
    },
  };
}
