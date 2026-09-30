// Pairing composition root — wires store, material, gate, redeem, and revocation
// into the surface each product mounts in a dozen lines (T-210).

import type { IncomingMessage } from "node:http";
import { pairingAuditor, type PairingAuditSink } from "../audit.ts";
import type { CertNaming } from "../cert-material.ts";
import type { PersistedMaterial } from "../material-store.ts";
import type { PairingStore } from "../store-port.ts";
import { PAIRING_REDEEM_PATH } from "../wire.ts";
import {
  clientCertGate,
  clientCertRefusalMessage,
  type OpenPathSpec,
  isOpenPath,
  openPathPredicateFrom,
  rejectUnauthorizedAtHandshake,
  type PreAuthPathPredicate,
} from "./preauth-gate.ts";
import {
  buildPairingEndpointResolver,
  createPairingRedeemHandler,
  type ClientLabelPolicy,
  type PairingHttpRoutes,
} from "./redeem-route.ts";
import {
  PairingRevocations,
  startPairingRevocationSweep,
  type PairingRevocationSweep,
  type RevocationLogger,
} from "./revocation.ts";

/** Product-specific cert and bearer naming. */
export type PairingProductNames = CertNaming & {
  /** Bearer `iss` prefix, e.g. `core:` or `search:`. */
  issPrefix: string;
};

export type CreatePairingOptions<Grant = unknown> = {
  store: PairingStore<Grant>;
  material: PersistedMaterial;
  /** `wss` for Control, `https` for Search. */
  endpointScheme: "wss" | "https";
  /** Listen port for the endpoint URL handed back after redemption. */
  port?: number;
  /** Hosts the server certificate covers; defaults to `material.serverHosts`. */
  publicHosts?: readonly string[];
  /**
   * Routes reachable without a verified client certificate.
   * Defaults to redeem only; Search adds `GET /v1/health`.
   */
  openPaths?: readonly OpenPathSpec[];
  /** Called when the revocation set changes — required. */
  onRevoked: (revokedSerials?: readonly string[]) => void;
  /** Session label only, or session label else the client's. Defaults to `session`. */
  clientLabel?: ClientLabelPolicy;
  /** Product cert names and bearer prefix; neutral defaults when omitted. */
  names?: PairingProductNames;
  /**
   * Where pairing audit records go — one redacted record per redemption attempt
   * (`pairing.attempt` in Control 0.4.5). Defaults to discarding them.
   */
  audit?: PairingAuditSink;
  /**
   * Receives the revocation logs: `core-pairing.revocation.unreadable` and
   * `pairing.revoked`. Defaults to discarding them.
   */
  logger?: RevocationLogger;
  /**
   * Validity of a redeemed bearer, in days — Control's `AC_CORE_BEARER_DAYS`.
   * Defaults to 365.
   */
  bearerDays?: number;
};

export type PairingGate = {
  /** Pathname predicate for TLS and legacy gates. */
  isPreAuthPath: PreAuthPathPredicate;
  /** Exact method + pathname check for HTTP requests. */
  isOpen: (method: string, pathname: string) => boolean;
  revocations: PairingRevocations;
  /** Whether TLS should demand a verified client certificate at handshake. */
  rejectUnauthorizedAtHandshake: boolean;
  /** Human-readable refusal when a client certificate is required. */
  refusalMessage: string;
  /** May this request be served on its connection? */
  mayServe(req: IncomingMessage): boolean;
};

export type PairingComposition<Grant = unknown> = {
  gate: PairingGate;
  redeem: PairingHttpRoutes;
  /** Arm the revocation poll — call after the server exists. */
  startRevocationSweep(): PairingRevocationSweep;
};

const NEUTRAL_NAMES: PairingProductNames = {
  caCommonName: "actana-pairing-ca",
  clientCommonName: "actana-paired-client",
  organizationName: "Actana",
  issPrefix: "pairing:",
};

function peerCertSerial(req: IncomingMessage): string | null {
  const socket = req.socket as {
    authorized?: boolean;
    getPeerCertificate?: () => { serialNumber?: string } | undefined;
  };
  if (socket.authorized !== true) return null;
  if (typeof socket.getPeerCertificate !== "function") return null;
  try {
    return socket.getPeerCertificate()?.serialNumber ?? null;
  } catch {
    return null;
  }
}

function clientCertVerified(req: IncomingMessage): boolean {
  const socket = req.socket as { authorized?: boolean };
  return socket.authorized !== false;
}

/**
 * Wire pairing for a product server: gate, redeem route, and revocation sweep.
 */
export function createPairing<Grant = unknown>(opts: CreatePairingOptions<Grant>): PairingComposition<Grant> {
  // A NaN or non-positive lifetime would sign a bearer that never verifies (or
  // one already expired) and only fail at the first client — refuse it here.
  if (opts.bearerDays !== undefined && !(Number.isFinite(opts.bearerDays) && opts.bearerDays > 0)) {
    throw new RangeError(`createPairing: bearerDays must be a finite number above 0, got ${String(opts.bearerDays)}`);
  }
  const names = opts.names ?? NEUTRAL_NAMES;
  const openPaths: readonly OpenPathSpec[] = opts.openPaths ?? [PAIRING_REDEEM_PATH];
  const hosts = opts.material.serverHosts ?? [];
  const publicHosts = opts.publicHosts ?? (hosts.length > 0 ? hosts : ["localhost"]);
  const port = opts.port ?? (opts.endpointScheme === "https" ? 443 : 8765);
  const isPreAuthPath = openPathPredicateFrom(openPaths);
  const revocations = new PairingRevocations(opts.store, opts.logger);
  const productLabel = names.clientCommonName.replace(/^actana-/, "").replace(/-client$/, "") || "this server";

  const redeem = createPairingRedeemHandler<Grant>({
    material: {
      caCert: opts.material.caCert,
      caKey: opts.material.caKey,
      bearerSecret: opts.material.bearerSecret,
      issuerId: opts.material.coreId,
      audience: opts.material.coreUuid,
      issPrefix: names.issPrefix,
    },
    store: opts.store,
    endpointScheme: opts.endpointScheme,
    endpointFor: buildPairingEndpointResolver({
      endpointScheme: opts.endpointScheme,
      publicHosts,
      port,
    }),
    clientLabel: opts.clientLabel ?? "session",
    ...(opts.audit ? { audit: pairingAuditor(opts.audit) } : {}),
    ...(opts.bearerDays === undefined ? {} : { bearerDays: opts.bearerDays }),
  });

  const gate: PairingGate = {
    isPreAuthPath,
    isOpen: (method, pathname) => isOpenPath(method, pathname, openPaths),
    revocations,
    rejectUnauthorizedAtHandshake: rejectUnauthorizedAtHandshake(isPreAuthPath),
    refusalMessage: clientCertRefusalMessage(productLabel),
    mayServe(req) {
      const pathname = new URL(req.url ?? "/", "https://pairing.invalid").pathname;
      const method = req.method ?? "GET";
      if (clientCertVerified(req)) {
        return !revocations.isRevoked(peerCertSerial(req));
      }
      return isOpenPath(method, pathname, openPaths);
    },
  };

  return {
    gate,
    redeem,
    startRevocationSweep() {
      return startPairingRevocationSweep({
        revocations,
        onRevoked: opts.onRevoked,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
    },
  };
}
