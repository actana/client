import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertValidCoreId,
  coreMachineUserEmail,
  coreStorageRestriction,
  createSupabaseKeyIssuer,
  SHARED_KEY_LIFETIME_SECONDS,
  SharedKeyIssueError,
  type SupabaseKeyIssuerOptions,
} from "../index.ts";
import { createFakeSupabase } from "./fake-supabase.ts";

const SERVICE_ROLE = "service-role-MASTER-never-leave";
const JWT_SECRET = "jwt-secret-MASTER-never-leave";
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const PROJECT = "https://proj.supabase.co";

function setup(extra: Partial<SupabaseKeyIssuerOptions> = {}, fakeOpts: Parameters<typeof createFakeSupabase>[0] = {}) {
  const fake = createFakeSupabase(fakeOpts);
  const issuer = createSupabaseKeyIssuer({
    url: PROJECT,
    serviceRoleKey: SERVICE_ROLE,
    jwtSecret: JWT_SECRET,
    bucket: "actana-shared",
    prefix: "cores",
    fetch: fake.fetch,
    now: () => NOW,
    ...extra,
  });
  return { issuer, requests: fake.requests, users: fake.users };
}

function verifyHs256(token: string, secret: string): { header: unknown; claims: Record<string, unknown> } {
  const [h, c, s] = token.split(".") as [string, string, string];
  const signingInput = `${h}.${c}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest("base64url");
  expect(s).toBe(expected);
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c, "base64url").toString()) as Record<string, unknown>,
  };
}

describe("createSupabaseKeyIssuer", () => {
  it("creates one machine user per Core and returns a 1-hour JWT as the session token", async () => {
    const { issuer, requests } = setup();
    const key = await issuer.issue("core-a");

    expect(key.accessKeyId).toBe("user-1");
    expect(key.secretAccessKey).toBe("supabase-user-jwt");
    expect(key.expiresAt).toEqual(new Date(NOW + SHARED_KEY_LIFETIME_SECONDS * 1000));
    const { header, claims } = verifyHs256(key.sessionToken, JWT_SECRET);
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(claims.sub).toBe("user-1");
    expect(claims.role).toBe("authenticated");
    expect(claims.exp as number).toBe(Math.floor(NOW / 1000) + SHARED_KEY_LIFETIME_SECONDS);
    expect(claims.app_metadata).toEqual({
      core_id: "core-a",
      ...coreStorageRestriction("actana-shared", "cores", "core-a"),
    });

    const create = requests.find((r) => r.method === "POST");
    expect(create?.url).toBe(`${PROJECT}/auth/v1/admin/users`);
    expect(create?.headers.authorization).toBe(`Bearer ${SERVICE_ROLE}`);
    expect(create?.body).toMatchObject({
      email: coreMachineUserEmail("core-a"),
      email_confirm: true,
      app_metadata: {
        core_id: "core-a",
        allowed_prefix: "cores/core-a/",
        storage_policy: { bucket: "actana-shared", prefix: "cores/core-a/" },
      },
    });
  });

  it("updates an existing machine user's storage restriction on the wire", async () => {
    const { issuer, requests } = setup(
      {},
      { users: [{ id: "user-existing", email: coreMachineUserEmail("core-a"), app_metadata: {} }] },
    );
    const key = await issuer.issue("core-a");
    expect(key.accessKeyId).toBe("user-existing");
    const update = requests.find((r) => r.method === "PUT");
    expect(update?.url).toBe(`${PROJECT}/auth/v1/admin/users/user-existing`);
    expect(update?.body).toEqual({
      app_metadata: {
        core_id: "core-a",
        ...coreStorageRestriction("actana-shared", "cores", "core-a"),
      },
    });
  });

  it("returns only the four SharedKey fields: no master material", async () => {
    const { issuer } = setup();
    const key = await issuer.issue("core-a");
    expect(Object.keys(key).sort()).toEqual(["accessKeyId", "expiresAt", "secretAccessKey", "sessionToken"]);
    const dump = JSON.stringify(key) + String(Object.values(key));
    expect(dump).not.toContain(SERVICE_ROLE);
    expect(dump).not.toContain(JWT_SECRET);
    expect(Object.isFrozen(key)).toBe(true);
  });

  it("leaks no master material in an Admin API error", async () => {
    const { issuer } = setup({}, { createError: { status: 401, message: `bad ${SERVICE_ROLE}` } });
    // create fails with 401 (not 422), list will also get createError only on POST — need network on list
    // Force create to fail non-422 and list to fail by using createError then empty list path:
    // createError returns 401; ensureUser then lists; list succeeds with empty users → create error path.
    const error = await issuer.issue("core-a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SharedKeyIssueError);
    const text = `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}`;
    expect(text).not.toContain(SERVICE_ROLE);
    expect(text).not.toContain(JWT_SECRET);
  });

  it("leaks no master material when the network fails", async () => {
    const { issuer } = setup({}, { networkError: new Error(`connect refused with ${SERVICE_ROLE} ${JWT_SECRET}`) });
    const error = (await issuer.issue("core-a").catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(SharedKeyIssueError);
    expect(`${error.message}${error.stack}`).not.toContain(SERVICE_ROLE);
    expect(`${error.message}${error.stack}`).not.toContain(JWT_SECRET);
  });

  it.each(["", "Core-A", "core/a", "core*"])("refuses the Core id %j before anything is sent", async (id) => {
    const { issuer, requests } = setup();
    await expect(issuer.issue(id)).rejects.toThrow(/invalid core id/);
    expect(requests).toHaveLength(0);
    expect(() => assertValidCoreId(id)).toThrow(SharedKeyIssueError);
  });
});
