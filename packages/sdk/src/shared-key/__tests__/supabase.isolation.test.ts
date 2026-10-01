/**
 * Wire-level isolation for Supabase (not a live-provider test).
 * Asserts the exact storage restriction the issuer sends on the machine user,
 * and that a policy for Core A never names Core B or the bucket root.
 */
import { describe, expect, it } from "vitest";
import {
  coreMachineUserEmail,
  coreRootPrefix,
  coreStorageRestriction,
  createSupabaseKeyIssuer,
} from "../index.ts";
import { createFakeSupabase } from "./fake-supabase.ts";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const BUCKET = "actana-shared";
const PREFIX = "cores";
const A = "core-a";
const B = "core-b";

describe("Supabase issuer: wire isolation to the Core's own prefix", () => {
  it("sends a storage policy / allowed_prefix only for A's root on create", async () => {
    const fake = createFakeSupabase();
    const issuer = createSupabaseKeyIssuer({
      url: "https://proj.supabase.co",
      serviceRoleKey: "srv",
      jwtSecret: "jwt",
      bucket: BUCKET,
      prefix: PREFIX,
      fetch: fake.fetch,
      now: () => NOW,
    });
    await issuer.issue(A);

    const create = fake.requests.find((r) => r.method === "POST");
    expect(create).toBeDefined();
    const body = create!.body as {
      email: string;
      app_metadata: {
        allowed_prefix: string;
        storage_policy: { bucket: string; prefix: string };
        core_id: string;
      };
    };
    const expected = coreStorageRestriction(BUCKET, PREFIX, A);
    expect(body.email).toBe(coreMachineUserEmail(A));
    expect(body.app_metadata.allowed_prefix).toBe(expected.allowed_prefix);
    expect(body.app_metadata.storage_policy).toEqual(expected.storage_policy);
    expect(body.app_metadata.allowed_prefix).toBe(coreRootPrefix(PREFIX, A));

    const dumped = JSON.stringify(body.app_metadata);
    // Negative: never names Core B or the bucket / shared prefix root.
    expect(dumped).not.toContain(B);
    expect(dumped).not.toContain(`"${PREFIX}/"`);
    expect(body.app_metadata.storage_policy.prefix).not.toBe("");
    expect(body.app_metadata.storage_policy.prefix).not.toBe("/");
    expect(body.app_metadata.storage_policy.prefix).not.toBe(`${PREFIX}/`);
    expect(body.app_metadata.allowed_prefix).not.toBe("*");
  });

  it("a widened allowed_prefix (bucket root) fails the isolation assertion", () => {
    const widened = { allowed_prefix: `${PREFIX}/`, storage_policy: { bucket: BUCKET, prefix: `${PREFIX}/` } };
    const expected = coreStorageRestriction(BUCKET, PREFIX, A);
    expect(widened.allowed_prefix).not.toBe(expected.allowed_prefix);
    expect(() => {
      expect(widened.allowed_prefix).toBe(expected.allowed_prefix);
    }).toThrow();
  });
});
