import { describe, expect, it } from "vitest";
import {
  assertValidCoreId,
  corePrefixSessionPolicy,
  createStsKeyIssuer,
  SHARED_KEY_LIFETIME_SECONDS,
  SharedKeyIssueError,
  type StsKeyIssuerOptions,
} from "../index.ts";
import { createFakeSts } from "./fake-sts.ts";

const MASTER_ACCESS = "AKIAMASTEREXAMPLE";
const MASTER_SECRET = "master/secret+key/NEVER_LEAVE";
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function setup(extra: Partial<StsKeyIssuerOptions> = {}, fakeOpts: Parameters<typeof createFakeSts>[0] = {}) {
  const fake = createFakeSts({
    credentials: { expiration: new Date(NOW + 3600_000).toISOString() },
    ...fakeOpts,
  });
  const issuer = createStsKeyIssuer({
    endpoint: "https://sts.us-east-1.amazonaws.com/ignored",
    accessKeyId: MASTER_ACCESS,
    secretAccessKey: MASTER_SECRET,
    roleArn: "arn:aws:iam::123456789012:role/ActanaCoreShared",
    bucket: "actana-shared",
    prefix: "cores",
    region: "us-east-1",
    fetch: fake.fetch,
    now: () => NOW,
    ...extra,
  });
  return { issuer, requests: fake.requests };
}

describe("createStsKeyIssuer", () => {
  it("AssumeRole for a 1-hour key with an inline session policy limited to the Core prefix", async () => {
    const { issuer, requests } = setup();
    const key = await issuer.issue("core-a");

    expect(key).toEqual({
      accessKeyId: "ASIASTS",
      secretAccessKey: "sts-secret",
      sessionToken: "sts-session",
      expiresAt: new Date(NOW + 3600_000),
    });
    expect(requests).toHaveLength(1);
    const { url, method, form, headers } = requests[0]!;
    expect(url).toBe("https://sts.us-east-1.amazonaws.com/");
    expect(method).toBe("POST");
    expect(form.get("Action")).toBe("AssumeRole");
    expect(form.get("RoleArn")).toBe("arn:aws:iam::123456789012:role/ActanaCoreShared");
    expect(form.get("RoleSessionName")).toBe("core-a");
    expect(form.get("DurationSeconds")).toBe(String(SHARED_KEY_LIFETIME_SECONDS));
    expect(form.get("Policy")).toBe(corePrefixSessionPolicy("actana-shared", "cores", "core-a"));
    expect(headers.authorization).toMatch(/Credential=AKIAMASTEREXAMPLE\/\d{8}\/us-east-1\/sts\/aws4_request/);
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("returns only the four SharedKey fields: no master material", async () => {
    const { issuer } = setup();
    const key = await issuer.issue("core-a");
    expect(Object.keys(key).sort()).toEqual(["accessKeyId", "expiresAt", "secretAccessKey", "sessionToken"]);
    const dump = JSON.stringify(key) + String(Object.values(key));
    expect(dump).not.toContain(MASTER_SECRET);
    expect(dump).not.toContain(MASTER_ACCESS);
    expect(Object.isFrozen(key)).toBe(true);
  });

  it("leaks no master material in an STS error", async () => {
    const { issuer } = setup(
      {},
      { error: { status: 403, code: "AccessDenied", message: `denied for ${MASTER_SECRET}` } },
    );
    const error = await issuer.issue("core-a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SharedKeyIssueError);
    const text = `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}`;
    expect(text).toContain("AccessDenied");
    expect((error as SharedKeyIssueError).status).toBe(403);
    expect(text).not.toContain(MASTER_SECRET);
    expect(text).toContain("[redacted]");
  });

  it("leaks no master material when the network fails", async () => {
    const { issuer } = setup({}, { networkError: new Error(`connect refused with ${MASTER_SECRET}`) });
    const error = (await issuer.issue("core-a").catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(SharedKeyIssueError);
    expect(`${error.message}${error.stack}`).not.toContain(MASTER_SECRET);
  });

  it("rejects an incomplete STS answer", async () => {
    const fake = createFakeSts();
    const original = fake.fetch;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      await original(url, init);
      return new Response("<AssumeRoleResponse/>", { status: 200 });
    }) as unknown as typeof fetch;
    const issuer = createStsKeyIssuer({
      endpoint: "https://sts.example/",
      accessKeyId: MASTER_ACCESS,
      secretAccessKey: MASTER_SECRET,
      roleArn: "arn:aws:iam::1:role/R",
      bucket: "b",
      prefix: "cores",
      fetch: fetchFn,
      now: () => NOW,
    });
    await expect(issuer.issue("core-a")).rejects.toThrow(/incomplete/);
  });

  it.each(["", "Core-A", "core/a", "core*", "..", "a..b", "core a", "-core", "core.a", "a".repeat(64)])(
    "refuses the Core id %j before anything is sent",
    async (id) => {
      const { issuer, requests } = setup();
      await expect(issuer.issue(id)).rejects.toThrow(/invalid core id/);
      expect(requests).toHaveLength(0);
      expect(() => assertValidCoreId(id)).toThrow(SharedKeyIssueError);
    },
  );
});

describe("corePrefixSessionPolicy", () => {
  it("names only the Core's prefix under the bucket", () => {
    const policy = JSON.parse(corePrefixSessionPolicy("actana-shared", "cores/", "core-a")) as {
      Statement: { Resource: string | string[]; Condition?: { StringLike: { "s3:prefix": string[] } } }[];
    };
    const objectResource = policy.Statement[0]!.Resource;
    const listPrefix = policy.Statement[1]!.Condition!.StringLike["s3:prefix"];
    expect(objectResource).toEqual(["arn:aws:s3:::actana-shared/cores/core-a/*"]);
    expect(listPrefix).toEqual(["cores/core-a/*"]);
  });
});
