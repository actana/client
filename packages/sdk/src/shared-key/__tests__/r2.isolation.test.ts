/**
 * Wire-level isolation for Cloudflare R2 (not a live-provider test).
 * Asserts the exact `prefixes` the issuer sends, and that a request for Core A
 * never names Core B or the bucket root.
 */
import { describe, expect, it } from "vitest";
import { coreRootPrefix, createR2KeyIssuer } from "../index.ts";
import { createFakeR2 } from "./fake-r2.ts";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const PREFIX = "cores";
const A = "core-a";
const B = "core-b";

describe("R2 issuer: wire isolation to the Core's own prefix", () => {
  it("sends prefixes set only to A's root", async () => {
    const fake = createFakeR2();
    const issuer = createR2KeyIssuer({
      accountId: "acct1234567890abcdef1234567890ab",
      apiToken: "tok",
      parentAccessKeyId: "parent",
      bucket: "actana-shared",
      prefix: PREFIX,
      fetch: fake.fetch,
      now: () => NOW,
    });
    await issuer.issue(A);

    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0]!.body as { prefixes: string[]; bucket: string };
    const root = coreRootPrefix(PREFIX, A);
    expect(body.prefixes).toEqual([root]);
    expect(body.prefixes).toEqual(["cores/core-a/"]);
    // Negative: never names Core B or the bucket / shared prefix root.
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain(B);
    expect(body.prefixes).not.toContain("");
    expect(body.prefixes).not.toContain("/");
    expect(body.prefixes).not.toContain(`${PREFIX}/`);
    expect(body.prefixes).not.toContain("*");
  });

  it("a widened prefixes list (bucket root) fails the isolation assertion", () => {
    const widened = { prefixes: [""] };
    expect(widened.prefixes).not.toEqual([coreRootPrefix(PREFIX, A)]);
    expect(() => {
      expect(widened.prefixes).toEqual([coreRootPrefix(PREFIX, A)]);
    }).toThrow();
  });
});
