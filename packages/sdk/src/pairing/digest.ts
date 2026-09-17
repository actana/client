// The code digest — split from the bottom half of Control's `pairing-store.ts`.
//
// `pairing-session.ts` carries a `codeHash` and deliberately says nothing about
// what hashes it. This is that decision, made once for both the process that
// mints a session and the process that redeems one.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Domain separator, so the derived key cannot collide with the bearer's use. */
const PAIRING_CODE_KEY_INFO = "actana:pairing-code:v1";

/**
 * Derive the key the code digest is taken under, from the Core's bearer secret.
 *
 * A bare `sha256(code)` would not do. The code is eight characters from a
 * 31-character alphabet — around 2^39.6 possibilities — which is a number of
 * hashes an attacker who has copied `pairing.json` can simply enumerate. A
 * digest keyed by a secret that is *not* in that file cannot be attacked that
 * way at all without the material file too.
 *
 * The bearer secret is reused rather than a second secret invented, because a
 * second secret is a second thing to mint, persist and lose; the separator
 * above is what keeps this from being the same computation the bearer does, so
 * neither use is an oracle for the other.
 */
export function derivePairingCodeKey(bearerSecret: string): Buffer {
  return createHmac("sha256", bearerSecret).update(PAIRING_CODE_KEY_INFO).digest();
}

/**
 * The digest stored in a session's `codeHash`.
 *
 * Bound to the session id as well as the code, which is session binding at the
 * cryptographic layer rather than only at the lookup: a digest lifted from one
 * session's row cannot be matched against another session, even by something
 * that can write this file.
 *
 * `code` must be the canonical form from `normalisePairingCode` — the hash of
 * `abcd-efgh` and of `ABCDEFGH` are different strings, and the endpoint
 * canonicalises before it gets here for exactly that reason.
 */
export function hashPairingCode(opts: { key: Buffer; sessionId: string; code: string }): string {
  return createHmac("sha256", opts.key).update(`${opts.sessionId}:${opts.code}`).digest("hex");
}

/**
 * Compare a candidate digest against a stored one in constant time.
 *
 * The comparison is on the *digests*, not the codes, so a timing signal here
 * would leak the digest rather than the code — but a digest is enough to
 * redeem, being what the store compares, so it gets `timingSafeEqual` all the
 * same. `core-link-bearer.ts` makes the same call for the same reason.
 */
export function pairingCodeMatches(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash, "hex");
  const candidate = Buffer.from(candidateHash, "hex");
  if (stored.length === 0 || stored.length !== candidate.length) return false;
  try {
    return timingSafeEqual(stored, candidate);
  } catch {
    return false;
  }
}
