import { describe, expect, it } from "vitest";
import { derivePairingCodeKey, hashPairingCode, pairingCodeMatches } from "../digest.ts";

describe("the code digest", () => {
  const key = derivePairingCodeKey("a-core-bearer-secret");

  it("is not the code, and not a hash anybody can take without the secret", () => {
    const mine = hashPairingCode({ key, sessionId: "ps_1", code: "ABCD-EFGH" });
    const theirs = hashPairingCode({
      key: derivePairingCodeKey("some-other-core"),
      sessionId: "ps_1",
      code: "ABCD-EFGH",
    });

    expect(mine).not.toContain("ABCD");
    expect(mine).not.toBe(theirs);
  });

  it("differs from the bearer's own HMAC over the same input", () => {
    // The domain separator. Neither use may be an oracle for the other.
    expect(derivePairingCodeKey("s").toString("hex")).not.toBe(
      hashPairingCode({ key: Buffer.from("s"), sessionId: "", code: "" }),
    );
  });

  it("binds the digest to the session it was minted for", () => {
    // Session binding under the cryptography as well as at the lookup: a digest
    // lifted out of one session's row does not match another's.
    const a = hashPairingCode({ key, sessionId: "ps_a", code: "ABCD-EFGH" });
    const b = hashPairingCode({ key, sessionId: "ps_b", code: "ABCD-EFGH" });
    expect(a).not.toBe(b);
  });

  it("matches a digest of the same code and refuses everything else", () => {
    const stored = hashPairingCode({ key, sessionId: "ps_1", code: "ABCD-EFGH" });

    expect(pairingCodeMatches(stored, hashPairingCode({ key, sessionId: "ps_1", code: "ABCD-EFGH" }))).toBe(true);
    expect(pairingCodeMatches(stored, hashPairingCode({ key, sessionId: "ps_1", code: "ABCD-EFGJ" }))).toBe(false);
  });

  it("refuses a digest of the wrong length rather than throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, and a pre-auth endpoint is
    // not a place to find that out at runtime.
    expect(pairingCodeMatches("aabb", "aa")).toBe(false);
    expect(pairingCodeMatches("", "")).toBe(false);
  });
});
