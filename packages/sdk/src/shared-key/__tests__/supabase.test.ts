import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertValidCoreId,
  coreMachineUserEmail,
  coreStorageRestriction,
  createSupabaseKeyIssuer,
  SHARED_KEY_LIFETIME_SECONDS,
  SharedKeyIssueError,
  supabaseCoreStorageRlsSql,
  type SupabaseKeyIssuerOptions,
} from "../index.ts";
import { createFakeSupabase } from "./fake-supabase.ts";

const SERVICE_ROLE = "service-role-MASTER-never-leave";
const JWT_SECRET = "jwt-secret-MASTER-never-leave";
const ANON_KEY = "anon-key-public";
const PROJECT = "https://proj.supabase.co";
const PROJECT_REF = "proj";
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function setup(extra: Partial<SupabaseKeyIssuerOptions> = {}, fakeOpts: Parameters<typeof createFakeSupabase>[0] = {}) {
  const fake = createFakeSupabase(fakeOpts);
  const issuer = createSupabaseKeyIssuer({
    url: PROJECT,
    serviceRoleKey: SERVICE_ROLE,
    jwtSecret: JWT_SECRET,
    anonKey: ANON_KEY,
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

    // R1: Supabase S3 session-token auth wants project ref + anon key + JWT.
    expect(key.accessKeyId).toBe(PROJECT_REF);
    expect(key.secretAccessKey).toBe(ANON_KEY);
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

  it("uses an explicit projectRef when the URL host is not the ref", async () => {
    const { issuer } = setup({ url: "https://db.example.com", projectRef: "myref" });
    const key = await issuer.issue("core-a");
    expect(key.accessKeyId).toBe("myref");
    expect(key.secretAccessKey).toBe(ANON_KEY);
  });

  it("updates an existing machine user's storage restriction on the wire", async () => {
    const { issuer, requests } = setup(
      {},
      { users: [{ id: "user-existing", email: coreMachineUserEmail("core-a"), app_metadata: {} }] },
    );
    const key = await issuer.issue("core-a");
    expect(key.accessKeyId).toBe(PROJECT_REF);
    expect(key.secretAccessKey).toBe(ANON_KEY);
    const update = requests.find((r) => r.method === "PUT");
    expect(update?.url).toBe(`${PROJECT}/auth/v1/admin/users/user-existing`);
    expect(update?.body).toEqual({
      app_metadata: {
        core_id: "core-a",
        ...coreStorageRestriction("actana-shared", "cores", "core-a"),
      },
    });
    const { claims } = verifyHs256(key.sessionToken, JWT_SECRET);
    expect(claims.sub).toBe("user-existing");
  });

  it("finds an existing machine user on page 2 of the Admin list (R3)", async () => {
    const fillers: { id: string; email: string; app_metadata: Record<string, unknown> }[] = [];
    for (let i = 0; i < 200; i++) {
      fillers.push({ id: `filler-${i}`, email: `filler-${i}@example.com`, app_metadata: {} });
    }
    fillers.push({ id: "user-page-2", email: coreMachineUserEmail("core-a"), app_metadata: {} });
    const { issuer, requests } = setup({}, { users: fillers, perPage: 200 });
    const key = await issuer.issue("core-a");
    expect(key.accessKeyId).toBe(PROJECT_REF);
    const { claims } = verifyHs256(key.sessionToken, JWT_SECRET);
    expect(claims.sub).toBe("user-page-2");
    const listUrls = requests.filter((r) => r.method === "GET").map((r) => r.url);
    expect(listUrls.some((u) => u.includes("page=1"))).toBe(true);
    expect(listUrls.some((u) => u.includes("page=2"))).toBe(true);
    const update = requests.find((r) => r.method === "PUT");
    expect(update?.url).toBe(`${PROJECT}/auth/v1/admin/users/user-page-2`);
  });

  it("returns only the four SharedKey fields: no master material", async () => {
    const { issuer } = setup();
    const key = await issuer.issue("core-a");
    expect(Object.keys(key).sort()).toEqual(["accessKeyId", "expiresAt", "secretAccessKey", "sessionToken"]);
    const dump = JSON.stringify(key) + String(Object.values(key));
    expect(dump).not.toContain(SERVICE_ROLE);
    expect(dump).not.toContain(JWT_SECRET);
    // Anon key and project ref are public S3 credentials; they are the returned key.
    expect(dump).toContain(ANON_KEY);
    expect(dump).toContain(PROJECT_REF);
    expect(Object.isFrozen(key)).toBe(true);
  });

  it("leaks no master material in an Admin API error", async () => {
    const { issuer } = setup({}, { createError: { status: 401, message: `bad ${SERVICE_ROLE}` } });
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

describe("supabaseCoreStorageRlsSql (R2/R4)", () => {
  it("ships SELECT/INSERT/UPDATE/DELETE policies that read allowed_prefix from the JWT", () => {
    const sql = supabaseCoreStorageRlsSql("actana-shared");
    expect(sql).toMatch(/CREATE POLICY/i);
    for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      expect(sql.toUpperCase()).toContain(cmd);
    }
    expect(sql).toContain("storage.objects");
    expect(sql).toContain("actana-shared");
    expect(sql).toContain("allowed_prefix");
    expect(sql).toContain("auth.jwt()");
    expect(sql).toContain("app_metadata");
  });

  it("matches the Core prefix literally with starts_with, not LIKE (R4)", () => {
    // LIKE treats '_' in a Core id (e.g. team_a) as a single-character wildcard.
    const sql = supabaseCoreStorageRlsSql("actana-shared");
    const predicate =
      "starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')";
    expect(sql).toContain(predicate);
    // Every policy arm must use the literal predicate (select/insert/update×2/delete = 5).
    expect(sql.split(predicate)).toHaveLength(6);
    expect(sql).not.toMatch(/name\s+LIKE\b/i);
    expect(sql).not.toContain("|| '%'");
  });
});
