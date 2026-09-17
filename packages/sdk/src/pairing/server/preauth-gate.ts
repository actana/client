// The one hole in the mTLS wall, and the wall around it.
//
// Every route on a product server sits behind the mutual TLS handshake:
// `requestCert: true, rejectUnauthorized: true`, so a client with no
// certificate is refused by TLS before a byte of HTTP is parsed. Pairing is the
// one exchange where that cannot hold — the client is posting a CSR precisely
// *because* it has no certificate yet — and this module is how the exception is
// made without becoming a hole.
//
// **Why the TLS flag has to move at all.** There is no per-route TLS. A
// server either demands a verified client certificate to complete a handshake
// or it does not, and the decision is made before the request line exists. So
// a server that serves a pre-auth route completes the handshake without one
// (`rejectUnauthorized: false`, with `requestCert` still true so a certificate
// that *is* presented is still parsed and verified) and enforces the same rule
// one layer up, per request, from `socket.authorized`.
//
// **What that costs, stated plainly.** Refusal moves from the TLS layer to the
// HTTP layer: an unauthenticated caller now gets a `403` where they used to get
// a handshake failure. What it does not cost is access — the gate below is
// applied to every request and every WebSocket upgrade, and it defaults to
// refusing.
//
// **And a server with no pairing surface does not pay it.** No pre-auth path
// means the server keeps `rejectUnauthorized: true` and behaves exactly as it
// did before pairing existed, TLS refusal and all. The relaxation is scoped to
// the servers that mount the endpoint, which is what "without weakening the mTLS
// posture of every other route" means here.

import { PAIRING_REDEEM_PATH } from "../wire.js";

/** Does this pathname name the pre-auth surface? */
export type PreAuthPathPredicate = (pathname: string) => boolean;

/** What the gate decides. There is no third answer. */
export type ClientCertVerdict = "serve" | "refuse";

/** The status a refused request gets, and the body that explains it. */
export const CLIENT_CERT_REFUSAL_STATUS = 403;
export const CLIENT_CERT_REFUSAL_CODE = "client-certificate-required";

/** Paths that may be served without a verified client certificate. */
export const DEFAULT_OPEN_PATHS: readonly string[] = [PAIRING_REDEEM_PATH];

/** One route that may be served without a verified client certificate. */
export type OpenPathSpec = string | { method: string; path: string };

/** Pathname strings from an open-path list — for TLS predicates that lack a method. */
export function openPathnames(openPaths: readonly OpenPathSpec[]): string[] {
  const names: string[] = [];
  for (const entry of openPaths) {
    names.push(typeof entry === "string" ? entry : entry.path);
  }
  return names;
}

/**
 * Exact match on method and pathname when an entry names both; pathname-only
 * entries match any method on that path.
 */
export function isOpenPath(method: string, pathname: string, openPaths: readonly OpenPathSpec[]): boolean {
  const verb = method.toUpperCase();
  for (const entry of openPaths) {
    if (typeof entry === "string") {
      if (entry === pathname) return true;
      continue;
    }
    if (entry.path === pathname && entry.method.toUpperCase() === verb) return true;
  }
  return false;
}

/** Build a pathname predicate from an open-path list (method-agnostic). */
export function openPathPredicateFrom(openPaths: readonly OpenPathSpec[]): PreAuthPathPredicate {
  return openPathPredicate(openPathnames(openPaths));
}

/**
 * Human-readable refusal for a connection that presented no verified client
 * certificate on a route outside the open set.
 */
export function clientCertRefusalMessage(productLabel = "this server"): string {
  return `${productLabel} requires a client certificate on every route but its pairing endpoint`;
}

/** Default refusal message — product-neutral wording for callers that need a constant. */
export const CLIENT_CERT_REFUSAL_MESSAGE = clientCertRefusalMessage();

/**
 * Returns true only when `pathname` exactly matches one of `openPaths`.
 *
 * Prefix and trailing-slash variants are refused deliberately: the open set is
 * enumerated, not inferred from a route family.
 */
export function openPathPredicate(openPaths: readonly string[]): PreAuthPathPredicate {
  const open = new Set(openPaths);
  return (pathname: string) => open.has(pathname);
}

/**
 * May this request be served on a connection that presented no verified client
 * certificate?
 *
 * The default is `refuse`, and every argument has to line up to get anything
 * else: an authorized connection is served whatever it asked for, and an
 * unauthorized one is served only what the predicate names.
 *
 * `isPreAuthPath` absent means no pre-auth surface is mounted. Such a server
 * keeps `rejectUnauthorized: true` and never reaches this function with
 * `authorized: false` — but it answers `refuse` if it does, because a gate
 * whose safety depends on a flag set somewhere else is not a gate.
 *
 * **`revoked` is checked before anything else, `authorized` included.**
 * A revoked client's certificate is still signed by this server's CA and still
 * completes the handshake — TLS has no idea an operator took it back — so
 * `authorized: true` is exactly what a revoked client arrives with, and a gate
 * that read it first would serve every one of them. Revocation is also the one
 * refusal with no pre-auth exception: a client here to *redeem a code* has no
 * certificate to have had revoked, so nothing legitimate is turned away.
 */
export function clientCertGate(opts: {
  pathname: string;
  authorized: boolean;
  /** Did this connection present a certificate `pair revoke` took back? */
  revoked?: boolean;
  isPreAuthPath?: PreAuthPathPredicate;
}): ClientCertVerdict {
  if (opts.revoked) return "refuse";
  if (opts.authorized) return "serve";
  if (!opts.isPreAuthPath) return "refuse";
  return opts.isPreAuthPath(opts.pathname) ? "serve" : "refuse";
}

/**
 * May this connection be upgraded to a protocol other than HTTP?
 *
 * Separate from {@link clientCertGate} because the answer is not a function of
 * the path: no pairing exception reaches an upgrade, ever.
 *
 * `revoked` refuses for the reason spelled out on {@link clientCertGate}: a
 * revoked certificate is a valid certificate, and this is the layer that knows
 * the difference.
 */
export function upgradeGate(authorized: boolean, revoked = false): ClientCertVerdict {
  if (revoked) return "refuse";
  return authorized ? "serve" : "refuse";
}

/**
 * @deprecated Use {@link upgradeGate}. Kept for Control callers during the lift.
 */
export const coreLinkUpgradeGate = upgradeGate;

/**
 * Should the TLS server demand a verified client certificate to complete the
 * handshake at all?
 *
 * Yes unless a pre-auth surface is mounted — see the header. Written as a named
 * function rather than inlined at the `https.createServer` call so that the one
 * line that relaxes TLS posture is a line with a name, a reason and a test,
 * rather than a ternary inside an options object.
 */
export function rejectUnauthorizedAtHandshake(isPreAuthPath: PreAuthPathPredicate | undefined): boolean {
  return isPreAuthPath === undefined;
}
