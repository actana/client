import { describe, expect, it } from "vitest";
import {
  assertValidCoreId,
  createR2KeyIssuer,
  SHARED_KEY_LIFETIME_SECONDS,
  SharedKeyIssueError,
  type R2KeyIssuerOptions,
} from "../index.ts";
import { createFakeR2 } from "./fake-r2.ts";

const API_TOKEN = "cf-api-token-MASTER-never-leave";
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function setup(extra: Partial<R2KeyIssuerOptions> = {}, fakeOpts: Parameters<typeof createFakeR2>[0] = {}) {
  const fake = createFakeR2(fakeOpts);
  const issuer = createR2KeyIssuer({
    accountId: "acct1234567890abcdef1234567890ab",
    apiToken: API_TOKEN,
    parentAccessKeyId: "parent-akid",
    bucket: "actana-shared",
    prefix: "cores",
    fetch: fake.fetch,
    now: () => NOW,
    ...extra,
  });
  return { issuer, requests: fake.requests };
}

describe("createR2KeyIssuer", () => {
  it("requests temporary credentials with prefixes set to the Core's root for 1 hour", async () => {
    const { issuer, requests } = setup();
    const key = await issuer.issue("core-a");

    expect(key).toEqual({
      accessKeyId: "AKIAR2TEMP",
      secretAccessKey: "r2-temp-secret",
      sessionToken: "r2-temp-session",
      expiresAt: new Date(NOW + SHARED_KEY_LIFETIME_SECONDS * 1000),
    });
    expect(requests).toHaveLength(1);
    const { url, method, headers, body } = requests[0]!;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct1234567890abcdef1234567890ab/r2/temp-access-credentials",
    );
    expect(method).toBe("POST");
    expect(headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(body).toEqual({
      bucket: "actana-shared",
      parentAccessKeyId: "parent-akid",
      permission: "object-read-write",
      ttlSeconds: SHARED_KEY_LIFETIME_SECONDS,
      prefixes: ["cores/core-a/"],
    });
  });

  it("returns only the four SharedKey fields: no master material", async () => {
    const { issuer } = setup();
    const key = await issuer.issue("core-a");
    expect(Object.keys(key).sort()).toEqual(["accessKeyId", "expiresAt", "secretAccessKey", "sessionToken"]);
    const dump = JSON.stringify(key) + String(Object.values(key));
    expect(dump).not.toContain(API_TOKEN);
    expect(Object.isFrozen(key)).toBe(true);
  });

  it("leaks no master material in an R2 error", async () => {
    const { issuer } = setup({}, { error: { status: 403, code: 10000, message: `bad token ${API_TOKEN}` } });
    const error = await issuer.issue("core-a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SharedKeyIssueError);
    const text = `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}`;
    expect(text).toContain("10000");
    expect(text).not.toContain(API_TOKEN);
    expect(text).toContain("[redacted]");
  });

  it("leaks no master material when the network fails", async () => {
    const { issuer } = setup({}, { networkError: new Error(`connect refused with ${API_TOKEN}`) });
    const error = (await issuer.issue("core-a").catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(SharedKeyIssueError);
    expect(`${error.message}${error.stack}`).not.toContain(API_TOKEN);
  });

  it("rejects an incomplete R2 answer", async () => {
    const { issuer } = setup({}, { result: { accessKeyId: "only-id" } });
    await expect(issuer.issue("core-a")).rejects.toThrow(/incomplete/);
  });

  it.each(["", "Core-A", "core/a", "core*"])("refuses the Core id %j before anything is sent", async (id) => {
    const { issuer, requests } = setup();
    await expect(issuer.issue(id)).rejects.toThrow(/invalid core id/);
    expect(requests).toHaveLength(0);
    expect(() => assertValidCoreId(id)).toThrow(SharedKeyIssueError);
  });
});
