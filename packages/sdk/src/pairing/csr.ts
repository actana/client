// The client half of pairing that never leaves the machine: a key pair, and the
// certificate signing request that proves possession of it.
//
// A pairing exchange hands a server a *public* key and gets a certificate back.
// This module is where the other half stays. Everything here runs before a
// socket is opened, and the only value that ever crosses one is
// {@link ClientCsr.csrPem} — the private key is returned to the caller, put
// into the resulting registration blob, and never given to `client.ts` in a form
// it could serialise.

import { generateKeyPair, sign } from "node:crypto";

/** A client key pair and the request that asks a CA to certify it. */
export type ClientCsr = {
  /** PEM `CERTIFICATE REQUEST`, for the body of a redemption. */
  csrPem: string;
  /**
   * PEM PKCS#8 private key. **Stays on the machine that made it** — it is the
   * `clientKey` of the resulting blob and appears in no request, ever.
   */
  privateKeyPem: string;
};

/** Modulus size. What the server's CA is known to sign. */
const RSA_MODULUS_BITS = 2048;

/** Longest common name written into the request. The server caps its own at 48. */
const MAX_COMMON_NAME = 48;

/** The common name used when a caller offers nothing usable. */
const FALLBACK_COMMON_NAME = "actana-client";

/**
 * Mint a key pair and a CSR naming `commonName`.
 *
 * The subject here is a *request*, and the server does not honour it: the
 * certificate is issued for the label the operator typed when they opened the
 * pairing session. It is filled in anyway because a CSR with an empty subject is a
 * worse artifact to debug than one that says which machine asked.
 */
export async function generateClientCsr(commonName: string): Promise<ClientCsr> {
  const { publicKey, privateKey } = await new Promise<{
    publicKey: import("node:crypto").KeyObject;
    privateKey: import("node:crypto").KeyObject;
  }>((resolve, reject) => {
    generateKeyPair("rsa", { modulusLength: RSA_MODULUS_BITS }, (err, publicKey, privateKey) => {
      if (err) reject(err);
      else resolve({ publicKey, privateKey });
    });
  });

  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const info = derSequence(
    DER_VERSION_V1,
    derName(certificationRequestName(commonName)),
    spki,
    DER_EMPTY_ATTRIBUTES,
  );

  const signature = new Uint8Array(sign("sha256", info, privateKey));

  const csr = derSequence(info, DER_SHA256_WITH_RSA, derBitString(signature));

  return {
    csrPem: derToPem("CERTIFICATE REQUEST", csr),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function certificationRequestName(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9 ._-]/g, "-").trim().slice(0, MAX_COMMON_NAME);
  return cleaned.length > 0 ? cleaned : FALLBACK_COMMON_NAME;
}

const DER_VERSION_V1 = Uint8Array.from([0x02, 0x01, 0x00]);
const DER_EMPTY_ATTRIBUTES = Uint8Array.from([0xa0, 0x00]);
const DER_SHA256_WITH_RSA = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00,
]);
const DER_OID_COMMON_NAME = Uint8Array.from([0x06, 0x03, 0x55, 0x04, 0x03]);

function derSequence(...members: Uint8Array[]): Uint8Array {
  return derTagged(0x30, concat(members));
}

function derName(commonName: string): Uint8Array {
  const attribute = derSequence(DER_OID_COMMON_NAME, derUtf8String(commonName));
  const rdn = derTagged(0x31, attribute);
  return derSequence(rdn);
}

function derUtf8String(value: string): Uint8Array {
  return derTagged(0x0c, new TextEncoder().encode(value));
}

function derBitString(bytes: Uint8Array): Uint8Array {
  return derTagged(0x03, concat([Uint8Array.from([0x00]), bytes]));
}

function derTagged(tag: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([tag]), derLength(content.length), content]);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function derToPem(label: string, der: Uint8Array): string {
  const body = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
