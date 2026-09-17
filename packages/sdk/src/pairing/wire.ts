// The pairing route's wire contract, and nothing else.
//
// This file exists so that the redeem request and response have **one**
// definition rather than two structurally identical ones — [ADR 0025][adr] D3:
// *"There is exactly one definition of every frame type, and a mirror is never
// the answer."* Until #306's review it was a mirror: `core-pairing.ts` declared
// the shapes for the client and `packages/core/src/core-pairing-routes.ts`
// hand-built the same shapes for the server, and nothing compiled the two
// against each other. A mirror does not fail; it disagrees, at runtime, on a
// wire, between two processes that each believe they are correct.
//
// It is a separate module from `core-pairing.ts` because of what D2 requires of
// anything the Core imports: **no I/O, no transport and no imports of its
// own.** `core-pairing.ts` dials, hashes and reads certificates, so a Core
// importing it would be a Core dialling itself. This file has no imports, and
// that is a property to preserve rather than a coincidence — it is the reason
// D2's list is allowed to grow to include it.
//
// [adr]: ../../docs/adr/0025-the-protocol-ships-with-the-client.md

/** The one route a client with no certificate may reach for pairing. */
export const PAIRING_REDEEM_PATH = "/v1/pair/redeem";

/**
 * What the client says about itself.
 *
 * The server keeps the label and ignores the rest. "Ignores" is the honest word
 * and is checked by `parseRedeemRequest`: an optional field a server drops is a
 * client courtesy, not a promise the server has broken.
 */
export type PairingClientInfo = {
  /** The machine's own name for itself, e.g. a hostname. */
  label?: string;
  /**
   * `process.platform`, sent by the CLI and the Panel.
   *
   * The server reads it off the wire and stores nothing: it is not on
   * {@link https://github.com/actana/control/issues/280 #280}'s paired-client
   * record and `actana pair ls` does not show it. Surfacing it means adding a
   * persisted field, which is a ticket rather than a parser change — #306's
   * review raised it and it is tracked there.
   */
  platform?: string;
};

/**
 * The redemption request body.
 *
 * `sessionId` names the pairing session the code belongs to and is not
 * optional: the server hashes a candidate code together with the session id and
 * refuses to search for a session a code might fit, which is what stops a code
 * lifted from one session being replayed against another.
 */
export type PairingRedeemRequest = {
  sessionId: string;
  code: string;
  client: PairingClientInfo;
  /** PEM `CERTIFICATE REQUEST`. The private half is not in this object. */
  csr: string;
};

/**
 * The 200 body.
 *
 * Four fields, and the absence of a fifth is the point: there is no key here,
 * because the server never had one. `pairWith` supplies the fifth from the
 * key it generated locally.
 */
export type PairingRedeemResponse = {
  /** The endpoint URL to dial from now on (`wss://` or `https://`). */
  endpoint: string;
  /** PEM CA certificate — the trust anchor for every later dial. */
  caCert: string;
  /** PEM client certificate, signed from the CSR just posted. */
  clientCert: string;
  /** The signed bearer for the `auth` frame. */
  bearer: string;
};

/** Everything a pairing failure knows beyond its reason code. */
export type PairingErrorDetail = {
  /** The HTTP status, when the failure came from one. */
  status?: number;
  /** `retry-after`, in seconds, on a `rate-limited` failure. */
  retryAfterSeconds?: number;
  /** The server's own refusal code, when it sent one. */
  serverCode?: string;
  /** Alias for {@link PairingErrorDetail.serverCode} — Control SDK callers. */
  coreCode?: string;
  /** The fingerprint the caller was told to expect. */
  expectedFingerprint?: string;
  /** The fingerprint the server actually presented. */
  presentedFingerprint?: string;
  /** The CA the server presented, PEM — for a UI that wants to show it. */
  presentedCaCert?: string;
  /** The TLS or OpenSSL code behind a dial failure, e.g. `CERT_HAS_EXPIRED`. */
  tlsCode?: string;
};

/** A refusal body, as every non-200 answer from the pairing route is shaped. */
export type PairingRefusalBody = {
  /** The machine-readable reason, e.g. `pairing-refused`. */
  code?: string;
  /** The human-readable one. */
  error?: string;
  /** A longer explanation when the server sends one. */
  message?: string;
  /** Structured detail — e.g. the server's own refusal code. */
  detail?: PairingErrorDetail;
};

/** @deprecated Use {@link PAIRING_REDEEM_PATH}. */
export const CORE_PAIRING_REDEEM_PATH = PAIRING_REDEEM_PATH;

/** @deprecated Use {@link PairingClientInfo}. */
export type CorePairingClientInfo = PairingClientInfo;

/** @deprecated Use {@link PairingRedeemRequest}. */
export type CorePairingRedeemRequest = PairingRedeemRequest;

/** @deprecated Use {@link PairingRedeemResponse}. */
export type CorePairingRedeemResponse = PairingRedeemResponse;

/** @deprecated Use {@link PairingRefusalBody}. */
export type CorePairingRefusalBody = PairingRefusalBody;
