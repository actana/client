// The pairing store port — one interface every adapter implements.
//
// `claimAttempt` is the piece that cannot be raced: the attempt cap is enforced
// inside the store, not across awaits in the redeem route.

import type { NewPairingSession, PairingSession } from "./session.ts";

/** Why {@link PairingStore.claimAttempt} refused to hand back a compare. */
export type AttemptClaimReason = "unknown" | "revoked" | "consumed" | "exhausted" | "expired";

/**
 * The result of atomically reserving one compare against a session.
 *
 * Shaped exactly as page 03 of the modular-split plan proposes.
 */
export type AttemptClaim<G> =
  | { ok: true; codeDigest: Buffer; endpointHost?: string; label?: string; grant: G }
  | { ok: false; reason: AttemptClaimReason };

/**
 * A client this product has paired — one row per issued certificate.
 *
 * Control's `PairedClient` is the base; Search adds `id`, `certFingerprint`,
 * and `platform`. Those Search fields are optional so either product can use
 * the same port.
 */
export type PairedClient<Grant = undefined> = {
  /** Search row id. Control has none; keyed by serial instead. */
  id?: string;
  /** The certificate serial, hex. The identity of this pairing. */
  certSerial: string;
  /** SHA-256 of the issued certificate. Search only. */
  certFingerprint?: string;
  /** The certificate subject as issued, e.g. `CN=laptop`. */
  certSubject: string;
  /** The operator's name for the machine, carried over from the session. */
  label: string;
  /** Where the client runs. Search only; reported, never trusted. */
  platform?: string | null;
  /** The session this client redeemed. Kept so an audit can join the two. */
  sessionId: string;
  /** Wall-clock ms of the successful redemption. */
  pairedAt: number;
  /** Wall-clock ms the issued certificate stops verifying. */
  certNotAfter: number;
  /** Wall-clock ms of `pair revoke`, or `null` while the pairing stands. */
  revokedAt: number | null;
  /** Opaque grant copied from the session. */
  grant?: Grant;
  /** Inert: copied from the session, for a later identity layer. */
  created_by: string | null;
  /** Inert. */
  tenant_id: string | null;
  /** Inert. */
  auth_method: string | null;
};

/**
 * What `listSessions` returns — the session without the code digest.
 *
 * Matches what `actana pair ls --json` publishes: every field an operator needs
 * to see, and never `codeHash`.
 */
export type PairingSessionView<Grant = undefined> = {
  id: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  attemptCap: number;
  consumedAt: number | null;
  revokedAt?: number | null;
  endpointHost?: string | null;
  grant?: Grant;
};

/** What {@link PairingStore.revoke} is pointed at. */
export type RevokeTarget =
  | { kind: "session"; sessionId: string; at: number }
  | { kind: "client"; certSerial: string; at: number };

/** What {@link PairingStore.revoke} hands back. */
export type RevokeResult<Grant = undefined> =
  | { ok: true; kind: "session"; session: PairingSession<Grant> }
  | { ok: true; kind: "client"; client: PairedClient<Grant> }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "already-consumed"; session: PairingSession<Grant> };

export interface PairingStore<Grant = unknown> {
  createSession(session: NewPairingSession<Grant>): Promise<void>;

  /**
   * Atomically: refuse when revoked, consumed, expired or attempts >= cap;
   * otherwise reserve this attempt and hand back what the compare needs.
   *
   * The reservation is what keeps the cap race-proof; it is a charge only if
   * the code then fails to match. The caller hands it back with
   * {@link releaseAttempt} the moment the code compares equal.
   */
  claimAttempt(sessionId: string, now: Date): Promise<AttemptClaim<Grant>>;

  /**
   * Give back the attempt a {@link claimAttempt} reserved, because the code
   * matched. Never takes the count below zero; a no-op for an unknown session.
   */
  releaseAttempt(sessionId: string): Promise<void>;

  /** Spend the session. False when another redemption won. */
  consume(sessionId: string, now: Date): Promise<boolean>;

  recordClient(client: PairedClient<Grant>): Promise<void>;
  revoke(target: RevokeTarget): Promise<RevokeResult<Grant>>;
  listSessions(): Promise<PairingSessionView<Grant>[]>;
  listClients(): Promise<PairedClient<Grant>[]>;
  revokedSerials(): Promise<ReadonlySet<string>>;
}

export function toPairingSessionView<Grant>(
  session: PairingSession<Grant>,
): PairingSessionView<Grant> {
  return {
    id: session.id,
    label: session.label,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    attempts: session.attempts,
    attemptCap: session.attemptCap,
    consumedAt: session.consumedAt,
    revokedAt: session.revokedAt,
    endpointHost: session.endpointHost,
    grant: session.grant,
  };
}
