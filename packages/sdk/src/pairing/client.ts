// Pairing, from the client's side: a key pair born here, a fingerprint checked
// before a secret moves, and a {@link RegistrationBlob} at the end of it.
//
// One implementation serves Core (`wss://`) and Search (`https://`) through
// {@link pairWith}'s `product` field. Wire types live in `wire.ts` and are
// re-exported here.

import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity as checkTlsServerIdentity, connect as tlsConnect } from "node:tls";
import type { DetailedPeerCertificate, PeerCertificate } from "node:tls";
import { generateClientCsr } from "./csr.ts";
import type { PairingProduct, RegistrationBlob } from "./registration-blob.ts";

export {
  PAIRING_REDEEM_PATH,
  CORE_PAIRING_REDEEM_PATH,
  type PairingClientInfo,
  type PairingRedeemRequest,
  type PairingRedeemResponse,
  type PairingRefusalBody,
  type CorePairingClientInfo,
  type CorePairingRedeemRequest,
  type CorePairingRedeemResponse,
  type CorePairingRefusalBody,
} from "./wire.ts";

import { PAIRING_REDEEM_PATH } from "./wire.ts";
import type { PairingRedeemRequest, PairingRedeemResponse, PairingRefusalBody } from "./wire.ts";

// ─── Failures ───

/** Why a pairing attempt did not produce a blob — shared across products. */
export type PairingFailure =
  | "bad-address"
  | "bad-code"
  | "bad-fingerprint"
  | "unreachable"
  | "no-ca-presented"
  | "fingerprint-unconfirmed"
  | "fingerprint-mismatch"
  | "hostname-mismatch"
  | "certificate-invalid"
  | "refused"
  | "rate-limited"
  | "rejected"
  | "not-pairable"
  | "core-error"
  | "malformed-response";

/** @deprecated Use {@link PairingFailure}. */
export type CorePairingFailure = PairingFailure;

/** @deprecated Use {@link PairingFailure}. */
export type SearchPairingFailure = PairingFailure;

/** Everything a failure knows beyond its {@link PairingFailure}. */
export type PairingErrorDetail = {
  status?: number;
  retryAfterSeconds?: number;
  serverCode?: string;
  /** Alias for {@link PairingErrorDetail.serverCode} — Control SDK callers. */
  coreCode?: string;
  expectedFingerprint?: string;
  presentedFingerprint?: string;
  presentedCaCert?: string;
  tlsCode?: string;
};

/** @deprecated Use {@link PairingErrorDetail}. */
export type CorePairingErrorDetail = PairingErrorDetail;

/** @deprecated Use {@link PairingErrorDetail}. */
export type SearchPairingErrorDetail = PairingErrorDetail;

export class PairingError extends Error {
  override readonly name: string = "PairingError";
  readonly failure: PairingFailure;
  readonly detail: PairingErrorDetail;

  constructor(
    failure: PairingFailure,
    message: string,
    detail: PairingErrorDetail = {},
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.failure = failure;
    this.detail = detail;
  }
}

/** @deprecated Use {@link PairingError}. */
export class CorePairingError extends PairingError {
  override readonly name = "CorePairingError";
}

/** @deprecated Use {@link PairingError}. */
export class SearchPairingError extends PairingError {
  override readonly name = "SearchPairingError";
}

// ─── First contact ───

export type PairingIdentity = {
  fingerprint: string;
  caCert: string;
  host: string;
  port: number;
  httpsOrigin: string;
};

/** @deprecated Use {@link PairingIdentity}. */
export type CorePairingIdentity = PairingIdentity;

/** @deprecated Use {@link PairingIdentity}. */
export type SearchPairingIdentity = PairingIdentity;

export const DEFAULT_PAIRING_TIMEOUT_MS = 15_000;

const PRODUCT_LABEL: Record<PairingProduct, string> = {
  core: "Core",
  search: "Search",
};

const ENDPOINT_SCHEME: Record<PairingProduct, string> = {
  core: "wss://",
  search: "https://",
};

const DEFAULT_CSR_LABEL: Record<PairingProduct, string> = {
  core: "actana-client",
  search: "actana-search-client",
};

function productLabel(product: PairingProduct): string {
  return PRODUCT_LABEL[product];
}

function refusalDetail(status: number, code?: string): PairingErrorDetail {
  return {
    status,
    ...(code === undefined ? {} : { serverCode: code, coreCode: code }),
  };
}

export async function fetchPairingIdentity(opts: {
  product: PairingProduct;
  address: string;
  timeoutMs?: number;
}): Promise<PairingIdentity> {
  const { host, port, httpsOrigin } = parseProductAddress(opts.product, opts.address);
  const chain = await presentedChain(host, port, opts.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS);
  const ca = certificateAuthorityIn(chain);
  if (!ca) {
    throw new PairingError(
      "no-ca-presented",
      `${httpsOrigin} presented a certificate chain with no certificate authority in it, so there is nothing to compare against the fingerprint`,
    );
  }
  return { fingerprint: fingerprintOf(ca.raw), caCert: derToCertificatePem(ca.raw), host, port, httpsOrigin };
}

/** @deprecated Use {@link fetchPairingIdentity} with `product: "core"`. */
export async function fetchCorePairingIdentity(
  opts: Omit<Parameters<typeof fetchPairingIdentity>[0], "product">,
): Promise<PairingIdentity> {
  return fetchPairingIdentity({ ...opts, product: "core" });
}

/** @deprecated Use {@link fetchPairingIdentity} with `product: "search"`. */
export async function fetchSearchPairingIdentity(
  opts: Omit<Parameters<typeof fetchPairingIdentity>[0], "product">,
): Promise<PairingIdentity> {
  return fetchPairingIdentity({ ...opts, product: "search" });
}

// ─── Pairing ───

export type PairWithOptions = {
  product: PairingProduct;
  address: string;
  code: string;
  sessionId?: string;
  expectedCaFingerprint?: string | null;
  label?: string;
  platform?: string;
  client?: { label?: string; platform?: string };
  timeoutMs?: number;
};

export type PairWithCoreOptions = Omit<PairWithOptions, "product">;

export type PairWithSearchOptions = Omit<PairWithOptions, "product">;

export async function pairWith(opts: PairWithOptions): Promise<RegistrationBlob> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;
  const label = opts.client?.label ?? opts.label;
  const platform = opts.client?.platform ?? opts.platform;
  const product = opts.product;

  const address = parseProductAddress(product, opts.address);
  const ticket = parsePairingTicket(opts.code, opts.sessionId);
  const expected = opts.expectedCaFingerprint ? parseFingerprint(opts.expectedCaFingerprint) : null;

  const identity = await fetchPairingIdentity({ product, address: opts.address, timeoutMs });

  if (!expected) {
    throw new PairingError(
      "fingerprint-unconfirmed",
      `${identity.httpsOrigin} presents a certificate authority with fingerprint ${identity.fingerprint}; no expected fingerprint was given, so the pairing code was not sent`,
      { presentedFingerprint: identity.fingerprint, presentedCaCert: identity.caCert },
    );
  }
  if (expected !== identity.fingerprint) {
    throw new PairingError(
      "fingerprint-mismatch",
      `${identity.httpsOrigin} presented a certificate authority with fingerprint ${identity.fingerprint}, but ${expected} was expected — the pairing code was not sent`,
      {
        expectedFingerprint: expected,
        presentedFingerprint: identity.fingerprint,
        presentedCaCert: identity.caCert,
      },
    );
  }

  const { csrPem, privateKeyPem } = await generateClientCsr(label ?? DEFAULT_CSR_LABEL[product]);

  const body: PairingRedeemRequest = {
    sessionId: ticket.sessionId,
    code: ticket.code,
    client: {
      ...(label === undefined ? {} : { label }),
      ...(platform === undefined ? {} : { platform }),
    },
    csr: csrPem,
  };

  const answer = await postRedemption({
    host: address.host,
    port: address.port,
    origin: identity.httpsOrigin,
    caCert: identity.caCert,
    expectedFingerprint: expected,
    body: JSON.stringify(body),
    timeoutMs,
    product,
  });

  const issued = readRedeemResponse(answer, identity.httpsOrigin, product);

  const issuedFingerprint = fingerprintOf(pemToDer(issued.caCert));
  if (issuedFingerprint !== expected) {
    throw new PairingError(
      "fingerprint-mismatch",
      `${identity.httpsOrigin} answered with a certificate authority whose fingerprint is ${issuedFingerprint}, not the ${expected} it presented in the handshake`,
      { expectedFingerprint: expected, presentedFingerprint: issuedFingerprint },
    );
  }

  return {
    endpoint: issued.endpoint,
    ...(label === undefined ? {} : { label }),
    caCert: issued.caCert,
    clientCert: issued.clientCert,
    clientKey: privateKeyPem,
    bearer: issued.bearer,
  };
}

export async function pairWithCore(opts: PairWithCoreOptions): Promise<RegistrationBlob> {
  return pairWith({ ...opts, product: "core" });
}

export async function pairWithSearch(opts: PairWithSearchOptions): Promise<RegistrationBlob> {
  return pairWith({ ...opts, product: "search" });
}

// ─── The pieces ───

export type PairingTicket = { sessionId: string; code: string };

export function parsePairingTicket(input: string, sessionId?: string): PairingTicket {
  const trimmed = input.trim();
  const separator = trimmed.indexOf(":");
  const explicit = sessionId?.trim() ?? "";
  const carried = separator === -1 ? "" : trimmed.slice(0, separator).trim();
  const rawCode = separator === -1 ? trimmed : trimmed.slice(separator + 1);

  if (explicit !== "" && carried !== "" && explicit !== carried) {
    throw new PairingError(
      "bad-code",
      `the code names session "${carried}" and "${explicit}" was passed beside it — they must agree`,
    );
  }
  const session = explicit !== "" ? explicit : carried;
  if (session === "") {
    throw new PairingError(
      "bad-code",
      "a pairing code names a pairing session — pass the session id as `sessionId`, or a `<sessionId>:<XXXX-XXXX>` code",
    );
  }

  const stripped = rawCode.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(stripped)) {
    throw new PairingError(
      "bad-code",
      `a pairing code is eight characters, written XXXX-XXXX — "${rawCode.trim()}" is not`,
    );
  }
  return { sessionId: session, code: `${stripped.slice(0, 4)}-${stripped.slice(4)}` };
}

type ProductAddress = { host: string; port: number; httpsOrigin: string };

export function parseProductAddress(product: PairingProduct, address: string): ProductAddress {
  const trimmed = address.trim();
  const label = productLabel(product);
  if (trimmed === "") throw new PairingError("bad-address", `a ${label} address is required`);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new PairingError("bad-address", `"${address}" is not a ${label} address — try host:port`);
  }
  if (url.protocol === "ws:" || url.protocol === "http:") {
    throw new PairingError(
      "bad-address",
      `pairing needs the ${label}'s TLS port: "${address}" names a plaintext one, and there is no certificate on it to check the fingerprint against`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new PairingError("bad-address", `"${address}" is not a ${label} address — try host:port`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "") throw new PairingError("bad-address", `"${address}" names no host`);
  const port = url.port === "" ? 443 : Number(url.port);
  return { host, port, httpsOrigin: `https://${url.host}` };
}

/** @deprecated Use {@link parseProductAddress} with `product: "core"`. */
export function parseCoreAddress(address: string): ProductAddress {
  return parseProductAddress("core", address);
}

/** @deprecated Use {@link parseProductAddress} with `product: "search"`. */
export function parseSearchAddress(address: string): ProductAddress {
  return parseProductAddress("search", address);
}

export function parseFingerprint(input: string): string {
  const hex = input.trim().replace(/^sha-?256[:=]/i, "").replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    throw new PairingError(
      "bad-fingerprint",
      `"${input.trim()}" is not a SHA-256 fingerprint — expected 32 bytes of hex, as AA:BB:…`,
    );
  }
  return groupHex(hex);
}

export function fingerprintOf(der: Uint8Array): string {
  return groupHex(createHash("sha256").update(der).digest("hex").toUpperCase());
}

function groupHex(hex: string): string {
  return (hex.match(/../g) ?? []).join(":");
}

function presentedChain(host: string, port: number, timeoutMs: number): Promise<DetailedPeerCertificate[]> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      rejectUnauthorized: false,
      ...(isIP(host) === 0 ? { servername: host } : {}),
    });
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new PairingError("unreachable", `${host}:${port} did not answer within ${timeoutMs}ms`),
        ),
      );
    }, timeoutMs);
    socket.once("secureConnect", () => {
      const chain = chainOf(socket.getPeerCertificate(true));
      settle(() => resolve(chain));
    });
    socket.once("error", (err: Error) => {
      settle(() =>
        reject(
          new PairingError(
            "unreachable",
            `${host}:${port} could not be reached: ${err.message}`,
            {},
            { cause: err },
          ),
        ),
      );
    });
  });
}

function chainOf(leaf: DetailedPeerCertificate): DetailedPeerCertificate[] {
  const chain: DetailedPeerCertificate[] = [];
  const seen = new Set<string>();
  let current: DetailedPeerCertificate | undefined = leaf;
  while (current && current.raw && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    chain.push(current);
    current = current.issuerCertificate;
  }
  return chain;
}

function certificateAuthorityIn(chain: DetailedPeerCertificate[]): DetailedPeerCertificate | null {
  const top = chain.at(-1);
  if (!top) return null;
  return sameName(top.subject, top.issuer) ? top : null;
}

function sameName(a: PeerCertificate["subject"], b: PeerCertificate["issuer"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type RedemptionAnswer = { status: number; body: string; retryAfterSeconds?: number };

function postRedemption(opts: {
  host: string;
  port: number;
  origin: string;
  caCert: string;
  expectedFingerprint: string;
  body: string;
  timeoutMs: number;
  product: PairingProduct;
}): Promise<RedemptionAnswer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: opts.host,
        port: opts.port,
        path: PAIRING_REDEEM_PATH,
        method: "POST",
        ca: opts.caCert,
        rejectUnauthorized: true,
        agent: false,
        ...(isIP(opts.host) === 0 ? { servername: opts.host } : {}),
        checkServerIdentity: (host: string, cert: PeerCertificate) => {
          const identity = checkTlsServerIdentity(host, cert);
          if (identity) return identity;
          const ca = certificateAuthorityIn(chainOf(cert as DetailedPeerCertificate));
          if (!ca) {
            return pinFailure(`${opts.origin} presented no certificate authority on the redemption dial`);
          }
          const presented = fingerprintOf(ca.raw);
          if (presented !== opts.expectedFingerprint) {
            return pinFailure(
              `${opts.origin} presented ${presented} on the redemption dial, not the ${opts.expectedFingerprint} it presented before`,
            );
          }
          return undefined;
        },
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(opts.body)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          const retryAfter = Number(res.headers["retry-after"]);
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
          });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`no answer within ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    req.on("error", (err: Error) => {
      clearTimeout(timer);
      const code = failureCode(err);
      const tls = code === undefined ? {} : { tlsCode: code };
      reject(dialFailure(classifyDialFailure(err), err, opts, tls, opts.product));
    });
    req.end(opts.body);
  });
}

function dialFailure(
  kind: DialFailure,
  err: Error,
  opts: { origin: string; host: string; expectedFingerprint: string },
  tls: { tlsCode?: string },
  product: PairingProduct,
): PairingError {
  const cause = { cause: err };
  const label = productLabel(product);
  if (kind === "pin") {
    return new PairingError(
      "fingerprint-mismatch",
      `${opts.origin} did not present the certificate authority whose fingerprint was confirmed — the pairing code was not sent (${err.message})`,
      { ...tls, expectedFingerprint: opts.expectedFingerprint },
      cause,
    );
  }
  if (kind === "hostname") {
    return new PairingError(
      "hostname-mismatch",
      `${opts.origin} presented the expected certificate authority, but its certificate does not cover ${opts.host} — dial the address this ${label} was set up for (${err.message})`,
      { ...tls, expectedFingerprint: opts.expectedFingerprint },
      cause,
    );
  }
  if (kind === "certificate") {
    return new PairingError(
      "certificate-invalid",
      `${opts.origin} presented the expected certificate authority, but its certificate could not be used: ${err.message}`,
      { ...tls, expectedFingerprint: opts.expectedFingerprint },
      cause,
    );
  }
  return new PairingError("unreachable", `${opts.origin} could not be reached: ${err.message}`, tls, cause);
}

function readRedeemResponse(
  answer: RedemptionAnswer,
  origin: string,
  product: PairingProduct,
): PairingRedeemResponse {
  if (answer.status !== 200) throw refusalFor(answer, origin, product);

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    throw new PairingError("malformed-response", `${origin} answered 200 with something that was not JSON`, {
      status: answer.status,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PairingError("malformed-response", `${origin} answered 200 with something that was not an object`, {
      status: answer.status,
    });
  }
  const fields = parsed as Partial<Record<keyof PairingRedeemResponse, unknown>>;
  const missing = (["endpoint", "caCert", "clientCert", "bearer"] as const).filter(
    (field) => typeof fields[field] !== "string" || (fields[field] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new PairingError(
      "malformed-response",
      `${origin} answered 200 without ${missing.join(", ")}`,
      { status: answer.status },
    );
  }
  const endpoint = (fields.endpoint as string).trim();
  const scheme = ENDPOINT_SCHEME[product];
  if (!endpoint.startsWith(scheme)) {
    const noun = product === "core" ? "core link" : "HTTPS origin";
    throw new PairingError(
      "malformed-response",
      `${origin} answered with the endpoint ${endpoint}, which is not a \`${scheme}\` ${noun} — a paired credential is only a credential on one`,
      { status: answer.status },
    );
  }
  return {
    endpoint,
    caCert: fields.caCert as string,
    clientCert: fields.clientCert as string,
    bearer: fields.bearer as string,
  };
}

function refusalFor(answer: RedemptionAnswer, origin: string, product: PairingProduct): PairingError {
  const body = safeRefusal(answer.body);
  const detail = refusalDetail(answer.status, body.code);
  const said = body.error ?? `HTTP ${answer.status}`;

  if (answer.status === 429) {
    return new PairingError(
      "rate-limited",
      `${origin} is refusing pairing attempts for now: ${said}`,
      { ...detail, ...(answer.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: answer.retryAfterSeconds }) },
    );
  }
  if (answer.status === 403) {
    return new PairingError(
      "refused",
      `${origin} refused the pairing code: it is wrong, expired, already used, or the session is out of attempts`,
      detail,
    );
  }
  if (answer.status === 404) {
    return new PairingError("not-pairable", `${origin} has no pairing endpoint — ${said}`, detail);
  }
  if (answer.status >= 500) {
    return new PairingError("core-error", `${origin} failed to handle the redemption: ${said}`, detail);
  }
  return new PairingError("rejected", `${origin} would not accept the redemption: ${said}`, detail);
}

const PIN_FAILURE_CODE = "ERR_ACTANA_PAIRING_PIN";

function pinFailure(message: string): Error {
  return Object.assign(new Error(message), { code: PIN_FAILURE_CODE });
}

function certificateFailure(code: string): boolean {
  return (
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.includes("CERT") ||
    code.startsWith("UNABLE_TO_") ||
    code.startsWith("DEPTH_ZERO_") ||
    code.startsWith("SELF_SIGNED_")
  );
}

const CHAIN_FAILURE_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "INVALID_CA",
]);

const HOSTNAME_FAILURE_CODE = "ERR_TLS_CERT_ALTNAME_INVALID";

type DialFailure = "pin" | "hostname" | "certificate" | "transport";

function classifyDialFailure(err: unknown): DialFailure {
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  if (code === PIN_FAILURE_CODE) return "pin";
  if (CHAIN_FAILURE_CODES.has(code)) return "pin";
  if (code === HOSTNAME_FAILURE_CODE) return "hostname";
  return certificateFailure(code) ? "certificate" : "transport";
}

function failureCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function safeRefusal(body: string): PairingRefusalBody {
  try {
    const parsed = JSON.parse(body) as PairingRefusalBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function derToCertificatePem(der: Uint8Array): string {
  const body = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function pemToDer(pem: string): Uint8Array {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  return new Uint8Array(Buffer.from((match?.[1] ?? "").replace(/\s+/g, ""), "base64"));
}
