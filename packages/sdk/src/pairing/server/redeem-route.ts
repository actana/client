// The pairing redeem endpoint — the one route a client with no certificate may
// reach (#280, #282). Lifted from Control's `core-pairing-routes.ts`, made
// async over {@link PairingStore}, and with a fixed refusal body shape.
//
//   POST /v1/pair/redeem
//   { "sessionId", "code", "client": { … }, "csr": "-----BEGIN CERTIFICATE REQUEST-----" }
//   → 200 { "caCert", "clientCert", "bearer", "endpoint" }

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CsrRejectedError, assertSignableCsr, signClientCsr } from "../cert-material.ts";
import { signBearer } from "../bearer.ts";
import { normalisePairingCode } from "../code.ts";
import { derivePairingCodeKey, hashPairingCode, pairingCodeMatches } from "../digest.ts";
import { pairingAuditor, type PairingAuditEvent } from "../audit.ts";
import type { AttemptClaimReason, PairingStore, PairedClient } from "../store-port.ts";
import {
  PAIRING_REDEEM_PATH,
  type PairingClientInfo,
  type PairingErrorDetail,
  type PairingRedeemRequest,
  type PairingRedeemResponse,
  type PairingRefusalBody,
} from "../wire.ts";
import { PairingRateLimiter } from "./rate-limit.ts";

/** Everything this module answers lives under here. */
export const PAIRING_ROUTE_PREFIX = "/v1/pair/";

/** @deprecated Use {@link PAIRING_ROUTE_PREFIX}. */
export const CORE_PAIRING_ROUTE_PREFIX = PAIRING_ROUTE_PREFIX;

/** The one route. Named so the pre-auth gate and the tests agree on the string. */
export { PAIRING_REDEEM_PATH };

/** @deprecated Use {@link PAIRING_REDEEM_PATH}. */
export const CORE_PAIRING_REDEEM_PATH = PAIRING_REDEEM_PATH;

export const MAX_REDEEM_BODY_BYTES = 16 * 1024;
export const DRAIN_CEILING_BYTES = 1024 * 1024;
export const DEFAULT_PAIRED_BEARER_DAYS = 365;

/** What this server signs and speaks as. A slice of persisted material. */
export type PairingIssuerMaterial = {
  caCert: string;
  caKey: string;
  bearerSecret: string;
  /** The `coreId` / instance id claim on the issued bearer. */
  issuerId: string;
  /** The stable UUID — the `aud` claim (#280). */
  audience: string;
  /** Bearer `iss` prefix, e.g. `core:` or `search:`. */
  issPrefix: string;
};

/** Whether a client-supplied label may fill in a missing session label. */
export type ClientLabelPolicy = "session" | "session-or-client";

export type PairingHttpRoutes = {
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  handleContinue(req: IncomingMessage, res: ServerResponse): boolean;
};

export type PairingRedeemRouteOptions<Grant = unknown> = {
  material: PairingIssuerMaterial;
  store: PairingStore<Grant>;
  /** `wss` for Control, `https` for Search. */
  endpointScheme: "wss" | "https";
  /**
   * Build the endpoint URL handed back after redemption. The only input is what
   * the stored session named — never a request header or body field.
   */
  endpointFor: (endpointHost?: string | null) => string;
  /** Session label only, or session label else the client's. */
  clientLabel: ClientLabelPolicy;
  bearerDays?: number;
  rateLimiter?: PairingRateLimiter;
  audit?: (event: PairingAuditEvent) => void;
  now?: () => number;
};

type Refusal = {
  status: number;
  code: string;
  message: string;
  detail?: PairingErrorDetail;
  headers?: Record<string, string>;
};

const PAIRING_REFUSED: Refusal = {
  status: 403,
  code: "pairing-refused",
  message: "this pairing code cannot be redeemed",
};

/** Build the pairing redeem route family. */
export function createPairingRedeemHandler<Grant = unknown>(
  opts: PairingRedeemRouteOptions<Grant>,
): PairingHttpRoutes {
  const now = opts.now ?? (() => Date.now());
  const rateLimiter = opts.rateLimiter ?? new PairingRateLimiter({ now });
  const audit = opts.audit ?? pairingAuditor(() => {});
  const bearerDays = opts.bearerDays ?? DEFAULT_PAIRED_BEARER_DAYS;
  const codeKey = derivePairingCodeKey(opts.material.bearerSecret);

  async function refuseClaim(
    res: ServerResponse,
    sessionId: string,
    peer: string,
    reason: AttemptClaimReason,
    at: number,
  ): Promise<void> {
    const view = await sessionView(opts.store, sessionId);
    audit({
      outcome: "refused",
      reason: claimRefusalReason(reason),
      sessionId,
      label: view?.label ?? null,
      peer,
      attempts: view?.attempts,
      at,
    });
    sendRefusal(res, PAIRING_REFUSED);
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "https://pairing.invalid");
    if (!url.pathname.startsWith(PAIRING_ROUTE_PREFIX)) return false;
    void route(req, res, url).catch((err: unknown) => {
      audit({ outcome: "core-error", reason: "unhandled", peer: peerOf(req), at: now() });
      sendRefusal(res, {
        status: 500,
        code: "core-error",
        message: "the server failed to handle this request",
      });
      if (process.env.NODE_ENV !== "test") {
        console.error("pairing.unhandled", err instanceof Error ? err.message : String(err));
      }
    });
    return true;
  }

  function handleContinue(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "https://pairing.invalid");
    if (!url.pathname.startsWith(PAIRING_ROUTE_PREFIX)) return false;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_REDEEM_BODY_BYTES) {
      sendRefusal(res, tooLarge());
      return true;
    }
    res.writeContinue();
    return handle(req, res);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const peer = peerOf(req);

    if (url.pathname !== PAIRING_REDEEM_PATH) {
      return sendRefusal(res, {
        status: 404,
        code: "not-found",
        message: `no route for ${url.pathname}`,
      });
    }
    if (req.method !== "POST") {
      return sendRefusal(res, {
        status: 405,
        code: "method-not-allowed",
        message: `${req.method ?? "?"} is not allowed here — use POST`,
        headers: { allow: "POST" },
      });
    }

    const verdict = rateLimiter.check(peer);
    if (!verdict.ok) {
      audit({ outcome: "rate-limited", reason: verdict.scope, peer, at: now() });
      const retryAfterSeconds = Math.ceil(verdict.retryAfterMs / 1000);
      return sendRefusal(res, {
        status: 429,
        code: "rate-limited",
        message: "too many pairing attempts — wait and try again",
        detail: { status: 429, retryAfterSeconds, serverCode: "rate-limited", coreCode: "rate-limited" },
        headers: { "retry-after": String(retryAfterSeconds) },
      });
    }

    const body = await readJsonBody(req);
    if (!body.ok) {
      audit({ outcome: "bad-request", reason: body.reason, peer, at: now() });
      return sendRefusal(res, body.refusal);
    }
    const request = parseRedeemRequest(body.value);
    if (!request.ok) {
      audit({ outcome: "bad-request", reason: request.reason, peer, at: now() });
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message: request.message,
      });
    }
    const { sessionId, code, label: wireClientLabel, csr } = request.value;
    const at = now();
    const claimed = await opts.store.claimAttempt(sessionId, new Date(at));
    if (!claimed.ok) {
      if (claimed.reason === "unknown") {
        audit({ outcome: "refused", reason: "unknown-session", sessionId, peer, at: now() });
        return sendRefusal(res, PAIRING_REFUSED);
      }
      return refuseClaim(res, sessionId, peer, claimed.reason, at);
    }

    const canonical = normalisePairingCode(code);
    const candidate =
      canonical === null ? null : hashPairingCode({ key: codeKey, sessionId, code: canonical });
    const storedDigest = claimed.codeDigest.toString("hex");
    if (candidate === null || !pairingCodeMatches(storedDigest, candidate)) {
      const attempts = await sessionAttempts(opts.store, sessionId);
      audit({
        outcome: "refused",
        reason: canonical === null ? "malformed-code" : "wrong-code",
        sessionId,
        label: claimed.label ?? null,
        peer,
        attempts,
        at: now(),
      });
      return sendRefusal(res, PAIRING_REFUSED);
    }

    try {
      await assertSignableCsr(csr);
    } catch (err) {
      if (!(err instanceof CsrRejectedError)) throw err;
      audit({
        outcome: "bad-request",
        reason: `csr-${err.rejection}`,
        sessionId,
        label: claimed.label ?? null,
        peer,
        at: now(),
      });
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message: "the CSR was not acceptable",
      });
    }

    const consumed = await opts.store.consume(sessionId, new Date(at));
    if (!consumed) {
      return refuseClaim(res, sessionId, peer, "consumed", at);
    }

    const subjectLabel = certSubjectLabel({
      sessionLabel: claimed.label ?? "",
      clientLabel: wireClientLabel,
      sessionId,
      policy: opts.clientLabel,
    });

    let issued;
    try {
      issued = await signClientCsr({
        ca: { cert: opts.material.caCert, key: opts.material.caKey },
        csrPem: csr,
        subject: subjectLabel,
      });
    } catch (err) {
      audit({ outcome: "core-error", reason: "sign-failed", sessionId, label: claimed.label ?? null, peer, at: now() });
      if (process.env.NODE_ENV !== "test") {
        console.error("pairing.sign-failed", err instanceof Error ? err.message : String(err));
      }
      return sendRefusal(res, {
        status: 500,
        code: "core-error",
        message: "this server could not sign the request",
      });
    }

    const client: PairedClient<Grant> = {
      certSerial: issued.serial,
      certSubject: issued.subject,
      label: claimed.label ?? wireClientLabel ?? sessionId,
      sessionId,
      pairedAt: at,
      certNotAfter: issued.notAfter,
      revokedAt: null,
      grant: claimed.grant,
      created_by: null,
      tenant_id: null,
      auth_method: null,
    };
    await opts.store.recordClient(client);

    const bearer = signBearer(
      {
        coreId: opts.material.issuerId,
        exp: at + bearerDays * 24 * 60 * 60 * 1000,
        iss: `${opts.material.issPrefix}${opts.material.issuerId}`,
        sub: pairingBearerSubject(issued.serial),
        aud: opts.material.audience,
        jti: randomUUID(),
      },
      opts.material.bearerSecret,
    );

    audit({
      outcome: "issued",
      sessionId,
      label: claimed.label ?? null,
      peer,
      certSerial: issued.serial,
      at: now(),
    });

    const answer: PairingRedeemResponse = {
      caCert: opts.material.caCert,
      clientCert: issued.cert,
      bearer,
      endpoint: opts.endpointFor(claimed.endpointHost ?? null),
    };
    sendJson(res, 200, answer);
  }

  return { handle, handleContinue };
}

/** @deprecated Use {@link createPairingRedeemHandler}. */
export const createCorePairingRequestHandler = createPairingRedeemHandler;

export type PairingEndpointOptions = {
  endpointScheme: "wss" | "https";
  publicHosts: readonly string[];
  port: number;
};

/** Build an `endpointFor` from configured public hosts and a listen port (#347). */
export function buildPairingEndpointResolver(opts: PairingEndpointOptions): (endpointHost?: string | null) => string {
  const primary = opts.publicHosts[0] ?? "localhost";
  const configured = new Set(opts.publicHosts);
  return (endpointHost) => {
    const chosen = endpointHost ?? "";
    const host = chosen.length > 0 && configured.has(chosen) ? chosen : primary;
    return `${opts.endpointScheme}://${host}:${opts.port}`;
  };
}

function pairingBearerSubject(certSerial: string): string {
  return `pair:${certSerial.toLowerCase()}`;
}

function claimRefusalReason(reason: AttemptClaimReason): string {
  switch (reason) {
    case "revoked":
      return "revoked";
    case "consumed":
      return "already-consumed";
    case "exhausted":
      return "attempts-exhausted";
    case "expired":
      return "expired";
    default:
      return "unknown-session";
  }
}

type RedeemRequest = Pick<PairingRedeemRequest, "sessionId" | "code" | "csr"> & {
  label: string | null;
};

type ParseResult =
  | { ok: true; value: RedeemRequest }
  | { ok: false; reason: string; message: string };

function parseRedeemRequest(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "not-an-object", message: "the body must be a JSON object" };
  }
  const o = body as Record<string, unknown>;
  const sessionId = o.sessionId;
  const code = o.code;
  const csr = o.csr;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) {
    return { ok: false, reason: "bad-session-id", message: "`sessionId` must be a non-empty string" };
  }
  if (typeof code !== "string" || code.length === 0 || code.length > 64) {
    return { ok: false, reason: "bad-code", message: "`code` must be a non-empty string" };
  }
  if (typeof csr !== "string" || !csr.includes("BEGIN CERTIFICATE REQUEST")) {
    return { ok: false, reason: "bad-csr", message: "`csr` must be a PEM certificate request" };
  }
  const client = o.client as PairingClientInfo | undefined;
  const label =
    client && typeof client === "object" && typeof client.label === "string"
      ? client.label.slice(0, 64)
      : null;
  return { ok: true, value: { sessionId, code, label, csr } };
}

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; refusal: Refusal };

function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "" && contentType !== "application/json") {
    return Promise.resolve({
      ok: false,
      reason: "content-type",
      refusal: {
        status: 415,
        code: "unsupported-media-type",
        message: "a redemption is `application/json`",
      },
    });
  }
  return new Promise<BodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REDEEM_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        if (size > DRAIN_CEILING_BYTES) {
          settle({ ok: false, reason: "too-large", refusal: tooLarge() });
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return settle({ ok: false, reason: "too-large", refusal: tooLarge() });
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        settle({
          ok: false,
          reason: "bad-json",
          refusal: { status: 400, code: "bad-request", message: "the body was not JSON" },
        });
        return;
      }
      settle({ ok: true, value: parsed });
    });
    req.on("error", () => {
      settle({
        ok: false,
        reason: "read-failed",
        refusal: { status: 400, code: "bad-request", message: "the request body could not be read" },
      });
    });
  });
}

function tooLarge(): Refusal {
  return {
    status: 413,
    code: "payload-too-large",
    message: `a redemption is at most ${MAX_REDEEM_BODY_BYTES} bytes`,
  };
}

function peerOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function certSubjectLabel(opts: {
  sessionLabel: string;
  clientLabel: string | null;
  sessionId: string;
  policy: ClientLabelPolicy;
}): string {
  const label =
    opts.policy === "session-or-client"
      ? opts.sessionLabel || opts.clientLabel || opts.sessionId
      : opts.sessionLabel || opts.sessionId;
  return `CN=${certCommonName(label)}`;
}

function certCommonName(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9 ._-]/g, "-").trim().slice(0, 48);
  return cleaned.length > 0 ? cleaned : "paired-client";
}

async function sessionAttempts(store: PairingStore, sessionId: string): Promise<number | undefined> {
  return (await sessionView(store, sessionId))?.attempts;
}

async function sessionView(store: PairingStore, sessionId: string) {
  const listed = await store.listSessions();
  return listed.find((row) => row.id === sessionId);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Write a refusal: `{ code, message, error, detail }` — fixed for every product. */
export function sendRefusal(res: ServerResponse, refusal: Refusal): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const detail: PairingErrorDetail = {
    status: refusal.status,
    serverCode: refusal.code,
    coreCode: refusal.code,
    ...(refusal.detail ?? {}),
  };
  const payload: PairingRefusalBody = {
    code: refusal.code,
    message: refusal.message,
    error: refusal.message,
    detail,
  };
  const body = JSON.stringify(payload);
  res.writeHead(refusal.status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    ...refusal.headers,
  });
  res.end(body);
}
