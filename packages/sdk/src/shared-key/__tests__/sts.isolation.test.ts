/**
 * Wire-level isolation for Generic STS (not a live-provider test).
 * Asserts the exact session policy the issuer sends, and that a policy for
 * Core A never names Core B or the bucket root.
 */
import { describe, expect, it } from "vitest";
import { corePrefixSessionPolicy, createStsKeyIssuer, coreRootPrefix } from "../index.ts";
import { createFakeSts } from "./fake-sts.ts";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const BUCKET = "actana-shared";
const PREFIX = "cores";
const A = "core-a";
const B = "core-b";

describe("Generic STS issuer: wire isolation to the Core's own prefix", () => {
  it("sends a session policy whose resources are only A's prefix", async () => {
    const fake = createFakeSts({ credentials: { expiration: new Date(NOW + 3600_000).toISOString() } });
    const issuer = createStsKeyIssuer({
      endpoint: "https://sts.example/",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      roleArn: "arn:aws:iam::1:role/ActanaCoreShared",
      bucket: BUCKET,
      prefix: PREFIX,
      fetch: fake.fetch,
      now: () => NOW,
    });
    await issuer.issue(A);

    expect(fake.requests).toHaveLength(1);
    const policyJson = fake.requests[0]!.form.get("Policy")!;
    expect(policyJson).toBe(corePrefixSessionPolicy(BUCKET, PREFIX, A));

    const policy = JSON.parse(policyJson) as {
      Statement: {
        Resource: string | string[];
        Condition?: { StringLike: { "s3:prefix": string[] } };
      }[];
    };
    const root = coreRootPrefix(PREFIX, A);
    const dumped = JSON.stringify(policy);
    expect(dumped).toContain(`${BUCKET}/${root}`);
    expect(dumped).toContain(`${root}*`);
    // Negative: never names Core B or the bare bucket / shared prefix root.
    expect(dumped).not.toContain(B);
    expect(dumped).not.toContain(`${BUCKET}/*`);
    expect(dumped).not.toContain(`arn:aws:s3:::${BUCKET}/${PREFIX}/*`);
    expect(dumped).not.toContain(`"${PREFIX}/*"`);
    expect(policy.Statement[0]!.Resource).toEqual([`arn:aws:s3:::${BUCKET}/${root}*`]);
    expect(policy.Statement[1]!.Condition!.StringLike["s3:prefix"]).toEqual([`${root}*`]);
  });

  it("a widened policy (bucket /*) fails the isolation assertion", () => {
    // Documents the guard: if the issuer ever sent this, the negative checks above fail.
    const widened = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:*"],
          Resource: [`arn:aws:s3:::${BUCKET}/*`],
        },
      ],
    });
    expect(widened).toContain(`${BUCKET}/*`);
    expect(widened).not.toBe(corePrefixSessionPolicy(BUCKET, PREFIX, A));
    expect(() => {
      expect(widened).not.toContain(`${BUCKET}/*`);
    }).toThrow();
  });
});
