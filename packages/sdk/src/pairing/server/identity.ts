// Who a TLS client certificate is — serial and fingerprint from the socket.
//
// Library-shaped extraction shared by product servers. Callers that need a
// paired-client row look up these fields in their store; this module reads only
// what Node puts on the socket and refuses unverified certificates.

/** Minimal TLS socket shape for reading a peer certificate. */
export type TlsPeerSocket = {
  authorized?: boolean;
  getPeerCertificate?: (detailed?: boolean) => { serialNumber?: string; fingerprint256?: string } | undefined;
};

/** Serial and fingerprint read from a verified peer certificate. */
export type PeerCertIdentity = {
  serial: string;
  fingerprint: string | null;
};

/**
 * The client certificate this connection presented, or `null`.
 *
 * Returns `null` unless `socket.authorized === true`, and when no certificate,
 * no serial, or `getPeerCertificate` is unavailable or throws.
 */
export function peerCertIdentityFromSocket(socket: TlsPeerSocket): PeerCertIdentity | null {
  if (socket.authorized !== true) return null;
  if (typeof socket.getPeerCertificate !== "function") return null;
  let cert: { serialNumber?: string; fingerprint256?: string } | undefined;
  try {
    cert = socket.getPeerCertificate();
  } catch {
    return null;
  }
  if (!cert?.serialNumber) return null;
  return {
    serial: cert.serialNumber,
    fingerprint: cert.fingerprint256 ?? null,
  };
}
