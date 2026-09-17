// Pairing cert material — generates a self-signed CA + server cert + client cert.
//
// Uses the `selfsigned` package (pure-JS X.509 over Node WebCrypto) so material
// can be generated without shelling out to `openssl`. `selfsigned` v5 is
// async-only, so {@link generateCertMaterial} is a Promise.
//
// Node process only — never imported by the browser.

import selfsigned from "selfsigned";
import * as x509 from "@peculiar/x509";
import { createHash, randomBytes, webcrypto } from "node:crypto";

export type CertPem = {
  /** PEM-encoded certificate. */
  cert: string;
  /** PEM-encoded private key (unencrypted). */
  key: string;
};

/** A signing CA — the pair {@link issueServerCert} signs against. */
export type CertAuthority = {
  /** PEM-encoded CA certificate. */
  cert: string;
  /** PEM-encoded CA private key. */
  key: string;
};

export type CertMaterial = {
  /** Self-signed CA that signs the server + client certs. */
  ca: CertPem;
  /** Server cert presented in the mTLS handshake. */
  server: CertPem;
  /** Client cert presented in the mTLS handshake. */
  client: CertPem;
};

/** Distinguished names for the CA and client leaf this module mints. */
export type CertNaming = {
  caCommonName: string;
  clientCommonName: string;
  organizationName?: string;
};

export type GenerateCertMaterialOptions = {
  /**
   * The hosts the server cert is valid for (SANs). Defaults to `localhost` +
   * `127.0.0.1`. **The first entry is the primary**: common name and default
   * endpoint a pairing hands back.
   */
  hosts?: readonly string[];
  /** Cert validity in days. Defaults to 10 years for the CA, 1 year for leaves. */
  days?: number;
  /** CA and client leaf names. Required for product-specific installs. */
  names: CertNaming;
};

const CA_DAYS = 10 * 365;
const LEAF_DAYS = 365;

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Generate a fresh self-signed CA + server cert + client cert. Each call
 * produces new keys — reissuing is a separate flow.
 */
export async function generateCertMaterial(
  opts: GenerateCertMaterialOptions,
): Promise<CertMaterial> {
  const hosts = certHosts(opts.hosts);
  const caDays = opts.days ?? CA_DAYS;
  const leafDays = opts.days ?? LEAF_DAYS;
  const notBefore = new Date();
  const org = opts.names.organizationName;

  const caAttrs = [
    { name: "commonName", value: opts.names.caCommonName },
    ...(org ? [{ name: "organizationName", value: org }] : []),
  ];

  const ca = await selfsigned.generate(caAttrs, {
    algorithm: "sha256",
    notBeforeDate: notBefore,
    notAfterDate: addDays(notBefore, caDays),
    extensions: [
      { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
      {
        name: "keyUsage",
        keyCertSign: true,
        cRLSign: true,
        digitalSignature: true,
        critical: true,
      },
    ],
  });

  const server = await issueServerCert({
    ca: { cert: ca.cert, key: ca.private },
    hosts,
    days: leafDays,
    notBefore,
  });

  const client = await selfsigned.generate(
    [{ name: "commonName", value: opts.names.clientCommonName }],
    {
      algorithm: "sha256",
      notBeforeDate: notBefore,
      notAfterDate: addDays(notBefore, leafDays),
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: "extKeyUsage", clientAuth: true },
      ],
    },
  );

  return {
    ca: { cert: ca.cert, key: ca.private },
    server,
    client: { cert: client.cert, key: client.private },
  };
}

export type IssueServerCertOptions = {
  ca: CertAuthority;
  hosts: readonly string[];
  days?: number;
  notBefore?: Date;
};

export async function issueServerCert(opts: IssueServerCertOptions): Promise<CertPem> {
  const hosts = certHosts(opts.hosts);
  const notBefore = opts.notBefore ?? new Date();

  const server = await selfsigned.generate(
    [{ name: "commonName", value: hosts[0]! }],
    {
      algorithm: "sha256",
      notBeforeDate: notBefore,
      notAfterDate: addDays(notBefore, opts.days ?? LEAF_DAYS),
      ca: { key: opts.ca.key, cert: opts.ca.cert },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: serverSanAltNames(hosts) },
      ],
    },
  );
  return { cert: server.cert, key: server.private };
}

function certHosts(hosts: readonly string[] | undefined): string[] {
  const named = (hosts ?? []).map((host) => host.trim()).filter((host) => host.length > 0);
  return named.length > 0 ? named : ["localhost"];
}

function serverSanAltNames(hosts: readonly string[]): { type: 2 | 7; value?: string; ip?: string }[] {
  const altNames: { type: 2 | 7; value?: string; ip?: string }[] = [];
  const seen = new Set<string>();
  const add = (host: string): void => {
    if (host.length === 0 || seen.has(host)) return;
    seen.add(host);
    altNames.push(isIp(host) ? { type: 7, ip: host } : { type: 2, value: host });
  };
  for (const host of hosts) add(host);
  add("localhost");
  add("127.0.0.1");
  return altNames;
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

type X509Crypto = NonNullable<Parameters<typeof x509.cryptoProvider.set>[1]>;
type X509SigningKey = x509.X509CertificateCreateWithKeyParams["signingKey"];
type X509KeyPair = x509.Pkcs10CertificateRequestCreateParams["keys"];

x509.cryptoProvider.set(webcrypto as unknown as X509Crypto);

const CA_SIGNING_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const CLIENT_KEY_ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
} as const;

const MIN_RSA_MODULUS_BITS = 2048;
const CLIENT_LEAF_DAYS = LEAF_DAYS;

export type CsrRejection =
  | "unparseable"
  | "bad-signature"
  | "weak-key"
  | "unsupported-key";

export class CsrRejectedError extends Error {
  constructor(readonly rejection: CsrRejection, message: string) {
    super(message);
    this.name = "CsrRejectedError";
  }
}

export type SignClientCsrOptions = {
  ca: CertAuthority;
  csrPem: string;
  subject: string;
  days?: number;
  notBefore?: Date;
};

export type SignedClientCert = {
  cert: string;
  serial: string;
  subject: string;
  notAfter: number;
};

export async function signClientCsr(opts: SignClientCsrOptions): Promise<SignedClientCert> {
  const csr = await readSignableCsr(opts.csrPem);

  const notBefore = opts.notBefore ?? new Date();
  const notAfter = addDays(notBefore, opts.days ?? CLIENT_LEAF_DAYS);
  const caCert = new x509.X509Certificate(opts.ca.cert);
  const caKey = await importCaKey(opts.ca.key);

  const issued = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: opts.subject,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: CA_SIGNING_ALGORITHM,
    publicKey: csr.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
    ],
  });

  return {
    cert: issued.toString("pem"),
    serial: issued.serialNumber,
    subject: issued.subject,
    notAfter: notAfter.getTime(),
  };
}

export async function assertSignableCsr(csrPem: string): Promise<void> {
  await readSignableCsr(csrPem);
}

async function readSignableCsr(csrPem: string): Promise<x509.Pkcs10CertificateRequest> {
  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch (err) {
    throw new CsrRejectedError("unparseable", `the CSR could not be read: ${errorText(err)}`);
  }

  let selfSigned: boolean;
  try {
    selfSigned = await csr.verify();
  } catch (err) {
    throw new CsrRejectedError("bad-signature", `the CSR signature could not be checked: ${errorText(err)}`);
  }
  if (!selfSigned) {
    throw new CsrRejectedError("bad-signature", "the CSR is not signed by the key it carries");
  }

  assertKeyStrongEnough(csr.publicKey);
  return csr;
}

export type ClientCsr = {
  csrPem: string;
  privateKeyPem: string;
};

export async function generateClientCsr(commonName: string): Promise<ClientCsr> {
  const keys = (await webcrypto.subtle.generateKey(CLIENT_KEY_ALGORITHM, true, [
    "sign",
    "verify",
  ])) as unknown as X509KeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${commonName}`,
    keys,
    signingAlgorithm: CLIENT_KEY_ALGORITHM,
  });
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    csrPem: csr.toString("pem"),
    privateKeyPem: derToPem("PRIVATE KEY", Buffer.from(pkcs8)),
  };
}

function assertKeyStrongEnough(publicKey: x509.PublicKey): void {
  const algorithm = publicKey.algorithm as { name?: string; modulusLength?: number };
  const name = String(algorithm.name ?? "");
  if (name.startsWith("RSA")) {
    const bits = algorithm.modulusLength ?? 0;
    if (bits < MIN_RSA_MODULUS_BITS) {
      throw new CsrRejectedError(
        "weak-key",
        `the CSR carries a ${bits}-bit RSA key; this CA signs ${MIN_RSA_MODULUS_BITS} and up`,
      );
    }
    return;
  }
  if (name === "ECDSA" || name === "Ed25519") return;
  throw new CsrRejectedError("unsupported-key", `this CA does not sign ${name || "unnamed"} keys`);
}

async function importCaKey(pem: string): Promise<X509SigningKey> {
  try {
    return (await webcrypto.subtle.importKey("pkcs8", pemToDer(pem), CA_SIGNING_ALGORITHM, false, [
      "sign",
    ])) as unknown as X509SigningKey;
  } catch (err) {
    throw new Error(`the CA key could not be read for signing: ${errorText(err)}`);
  }
}

/** A positive 16-byte serial, hex-encoded — RFC 5280 §4.1.2.2 wants positive. */
export function randomSerial(): string {
  const bytes = randomBytes(16);
  const first = bytes[0]! & 0x7f;
  bytes[0] = first === 0 ? 0x01 : first;
  return bytes.toString("hex");
}

function pemToDer(pem: string) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const decoded = Buffer.from(body, "base64");
  const der = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  der.set(decoded);
  return der;
}

function derToPem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function certFingerprintSha256(certPem: string): string {
  const digest = createHash("sha256").update(pemToDer(certPem)).digest("hex").toUpperCase();
  return (digest.match(/.{2}/g) ?? []).join(":");
}
