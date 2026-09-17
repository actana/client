/**
 * Search-only route payloads that are not zod contracts.
 *
 * Pairing redemption wire lives in `pairing/wire.ts` (T-211); these are the
 * `GET /v1/health` and `GET /v1/pair/status` answer shapes.
 */

/** What `GET /v1/pair/status` answers an authenticated client with. */
export type SearchPairStatus = {
  /** The paired client's row id. */
  id: string;
  label: string;
  platform: string | null;
  /** `read`, `write` or `admin` (ADR 0003). */
  scope: "read" | "write" | "admin";
  /** The KB ids this client may touch, or `null` for all of its own. */
  kbIds: string[] | null;
  /** Hex serial of the certificate presented on this connection. */
  certSerial: string;
  /** ISO-8601, or `null` on the plain-HTTP development path. */
  certNotAfter: string | null;
  pairedAt: string;
};

/**
 * What `GET /v1/health` answers.
 *
 * `ok` always; `schemaVersion` only to a caller whose certificate resolved.
 */
export type SearchHealth = {
  ok: boolean;
  /** The migration count the instance has applied. Authenticated callers only. */
  schemaVersion?: number;
};
