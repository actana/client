// Signed bearer token for the app-layer session after mTLS.
//
// Compact URL-safe string: `base64url(payload).base64url(sig)` where `payload`
// is JSON `{coreId, exp}` plus optional standard claims, and `sig` is
// HMAC-SHA256 over the payload string.

import { createHmac, timingSafeEqual } from "node:crypto";

export type BearerSecret = string;

export type BearerClaims = {
  coreId: string;
  exp: number;
  iss?: string;
  sub?: string;
  aud?: string;
  jti?: string;
};

const STANDARD_CLAIMS = ["iss", "sub", "aud", "jti"] as const;

export interface HmacPort {
  sha256(key: string, data: string): Buffer;
}

const defaultHmac: HmacPort = {
  sha256: (key, data) => createHmac("sha256", key).update(data).digest(),
};

const SEP = ".";

function encodeBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function decodeBase64Url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signBearer(
  claims: BearerClaims,
  secret: BearerSecret,
  hmac: HmacPort = defaultHmac,
): string {
  const payload: Record<string, string | number> = { coreId: claims.coreId, exp: claims.exp };
  for (const claim of STANDARD_CLAIMS) {
    const value = claims[claim];
    if (value !== undefined) payload[claim] = value;
  }
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = encodeBase64Url(Buffer.from(payloadJson, "utf8"));
  const sig = hmac.sha256(secret, payloadB64);
  return `${payloadB64}${SEP}${encodeBase64Url(sig)}`;
}

export type BearerVerifyOk = {
  ok: true;
  coreId: string;
  exp: number;
  iss?: string;
  sub?: string;
  aud?: string;
  jti?: string;
};
export type BearerVerifyErr =
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "bad-signature" }
  | { ok: false; reason: "expired" };
export type BearerVerifyResult = BearerVerifyOk | BearerVerifyErr;

export function verifyBearer(
  token: string,
  secret: BearerSecret,
  opts: { now?: number; hmac?: HmacPort } = {},
): BearerVerifyResult {
  const hmac = opts.hmac ?? defaultHmac;
  const sep = token.indexOf(SEP);
  if (sep <= 0 || sep === token.length - 1) return { ok: false, reason: "malformed" };
  const payloadB64 = token.slice(0, sep);
  const sigB64 = token.slice(sep + 1);
  let payloadJson: string;
  try {
    payloadJson = decodeBase64Url(payloadB64).toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let expectedSig: Buffer;
  try {
    expectedSig = decodeBase64Url(sigB64);
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  const actualSig = hmac.sha256(secret, payloadB64);
  if (!safeEqual(actualSig, expectedSig)) return { ok: false, reason: "bad-signature" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed" };
  const obj = parsed as { coreId?: unknown; exp?: unknown };
  if (typeof obj.coreId !== "string" || typeof obj.exp !== "number" || !Number.isFinite(obj.exp)) {
    return { ok: false, reason: "malformed" };
  }
  const claims = readStandardClaims(parsed as Record<string, unknown>);
  if (claims === null) return { ok: false, reason: "malformed" };
  const now = opts.now ?? Date.now();
  if (obj.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, coreId: obj.coreId, exp: obj.exp, ...claims };
}

function readStandardClaims(payload: Record<string, unknown>): Partial<BearerClaims> | null {
  const claims: Partial<BearerClaims> = {};
  for (const claim of STANDARD_CLAIMS) {
    const value = payload[claim];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    claims[claim] = value;
  }
  return claims;
}

export function decodeBearer(token: string): BearerClaims | null {
  const sep = token.indexOf(SEP);
  if (sep <= 0 || sep === token.length - 1) return null;
  let payloadJson: string;
  try {
    payloadJson = decodeBase64Url(token.slice(0, sep)).toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { coreId?: unknown; exp?: unknown };
  if (typeof obj.coreId !== "string" || typeof obj.exp !== "number" || !Number.isFinite(obj.exp)) {
    return null;
  }
  const claims = readStandardClaims(parsed as Record<string, unknown>);
  if (claims === null) return null;
  return { coreId: obj.coreId, exp: obj.exp, ...claims };
}
