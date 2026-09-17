// Postgres-backed `PairingStore` — lifted from Search's pairing-store.ts (T-206).
//
// `pg` is loaded only when this module is imported. Pairing session rules and
// the memory adapter stay pg-free.

import {
  createPairingSession,
  isConsumed,
  isDead,
  isExpired,
  isRevoked,
  type NewPairingSession,
  type PairingSession,
} from "../session.ts";
import {
  toPairingSessionView,
  type AttemptClaim,
  type AttemptClaimReason,
  type PairedClient,
  type PairingSessionView,
  type PairingStore,
  type RevokeResult,
  type RevokeTarget,
} from "../store-port.ts";
import { assertSchemaName, qualifiedTable } from "./postgres-schema.ts";

export type PostgresPairingStoreOptions = {
  /** Postgres schema for pairing tables. Defaults to `"search"`. */
  schema?: string;
};

type PgPool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type PairingCodeRow = {
  id: string;
  label: string;
  code_hash: string;
  created_at: Date;
  expires_at: Date;
  attempts: number;
  attempt_cap: number;
  consumed_at: Date | null;
  revoked_at: Date | null;
  scope: string;
  kb_ids: unknown;
  created_by: string | null;
  tenant_id: string | null;
  auth_method: string | null;
};

type PairedClientRow = {
  id: string;
  label: string;
  platform: string | null;
  cert_serial: string;
  cert_fingerprint: string;
  cert_subject: string;
  cert_not_after: Date | null;
  session_id: string | null;
  scope: string;
  kb_ids: unknown;
  status: string;
  revoked_at: Date | null;
  created_at: Date;
};

/** Hex only, upper case, no leading zeros — matches Search cert lookup. */
function normaliseCertSerial(serial: string): string {
  return serial.replace(/[^0-9a-fA-F]/g, "").toUpperCase().replace(/^0+(?=.)/, "");
}

function readScope(value: unknown): string {
  return value === "read" || value === "write" || value === "admin" ? value : "read";
}

function readKbIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => typeof id === "string");
  return ids.length > 0 ? ids : null;
}

function grantFromColumns<Grant>(scope: string, kbIds: unknown): Grant | undefined {
  const s = readScope(scope);
  const ids = readKbIds(kbIds);
  if (s === "read" && !ids) return undefined;
  return { scope: s, kbIds: ids } as Grant;
}

function grantToColumns(grant: unknown): { scope: string; kbIds: string[] | null } {
  if (grant && typeof grant === "object" && "scope" in grant) {
    const row = grant as { scope?: unknown; kbIds?: unknown };
    const scope = typeof row.scope === "string" ? readScope(row.scope) : "read";
    return { scope, kbIds: readKbIds(row.kbIds) };
  }
  return { scope: "read", kbIds: null };
}

function sessionFromRow<Grant>(row: PairingCodeRow): PairingSession<Grant> {
  return {
    id: row.id,
    label: row.label,
    codeHash: row.code_hash,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    attempts: row.attempts,
    attemptCap: row.attempt_cap,
    consumedAt: row.consumed_at ? row.consumed_at.getTime() : null,
    revokedAt: row.revoked_at ? row.revoked_at.getTime() : null,
    grant: grantFromColumns<Grant>(row.scope, row.kb_ids),
    created_by: row.created_by,
    tenant_id: row.tenant_id,
    auth_method: row.auth_method,
  };
}

function clientFromRow<Grant>(row: PairedClientRow): PairedClient<Grant> {
  const grant = grantFromColumns<Grant>(row.scope, row.kb_ids);
  return {
    id: row.id,
    certSerial: row.cert_serial,
    certFingerprint: row.cert_fingerprint || undefined,
    certSubject: row.cert_subject,
    label: row.label,
    platform: row.platform,
    sessionId: row.session_id ?? "",
    pairedAt: row.created_at.getTime(),
    certNotAfter: row.cert_not_after ? row.cert_not_after.getTime() : 0,
    revokedAt: row.revoked_at ? row.revoked_at.getTime() : null,
    grant,
    created_by: null,
    tenant_id: null,
    auth_method: null,
  };
}

function refusalReason<Grant>(session: PairingSession<Grant>, now: number): AttemptClaimReason {
  if (isRevoked(session)) return "revoked";
  if (isConsumed(session)) return "consumed";
  if (isExpired(session, now)) return "expired";
  if (isDead(session)) return "exhausted";
  return "exhausted";
}

function claimSuccess<Grant>(session: PairingSession<Grant>): AttemptClaim<Grant> {
  const codeDigest = Buffer.from(session.codeHash, "hex");
  const endpointHost = session.endpointHost ?? undefined;
  const label = session.label;
  const grant = session.grant as Grant;
  return {
    ok: true,
    codeDigest,
    ...(endpointHost !== undefined && endpointHost !== null ? { endpointHost } : {}),
    ...(label ? { label } : {}),
    grant,
  };
}

export function createPostgresPairingStore<Grant = unknown>(
  pool: PgPool,
  options: PostgresPairingStoreOptions = {},
): PairingStore<Grant> {
  return new PostgresPairingStore<Grant>(pool, options);
}

/** @see {@link createPostgresPairingStore} */
export const postgresStore = createPostgresPairingStore;

class PostgresPairingStore<Grant> implements PairingStore<Grant> {
  private readonly pool: PgPool;
  private readonly schema: string;
  private readonly pairingCode: string;
  private readonly pairedClient: string;

  constructor(pool: PgPool, options: PostgresPairingStoreOptions) {
    this.pool = pool;
    this.schema = assertSchemaName(options.schema ?? "search");
    this.pairingCode = qualifiedTable(this.schema, "pairing_code");
    this.pairedClient = qualifiedTable(this.schema, "paired_client");
  }

  async createSession(input: NewPairingSession<Grant>): Promise<void> {
    const session = createPairingSession(input);
    const { scope, kbIds } = grantToColumns(session.grant);
    await this.pool.query(
      `INSERT INTO ${this.pairingCode} (
        id, label, code_hash, created_at, expires_at, attempts, attempt_cap,
        consumed_at, revoked_at, scope, kb_ids, created_by, tenant_id, auth_method
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        session.id,
        session.label,
        session.codeHash,
        new Date(session.createdAt),
        new Date(session.expiresAt),
        session.attempts,
        session.attemptCap,
        session.consumedAt === null ? null : new Date(session.consumedAt),
        session.revokedAt ? new Date(session.revokedAt) : null,
        scope,
        kbIds === null ? null : JSON.stringify(kbIds),
        session.created_by,
        session.tenant_id,
        session.auth_method,
      ],
    );
  }

  async claimAttempt(sessionId: string, now: Date): Promise<AttemptClaim<Grant>> {
    const at = now.toISOString();
    const claimed = await this.pool.query(
      `UPDATE ${this.pairingCode}
       SET attempts = least(attempts + 1, attempt_cap)
       WHERE id = $1
         AND revoked_at IS NULL
         AND consumed_at IS NULL
         AND attempts < attempt_cap
         AND expires_at >= $2::timestamp
       RETURNING *`,
      [sessionId, at],
    );
    const row = claimed.rows[0] as PairingCodeRow | undefined;
    if (row) return claimSuccess(sessionFromRow<Grant>(row));

    const session = await this.getSession(sessionId);
    if (!session) return { ok: false, reason: "unknown" };
    return { ok: false, reason: refusalReason(session, now.getTime()) };
  }

  async consume(sessionId: string, now: Date): Promise<boolean> {
    const at = now.toISOString();
    const claimed = await this.pool.query(
      `UPDATE ${this.pairingCode}
       SET consumed_at = $2::timestamp
       WHERE id = $1
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at >= $2::timestamp
       RETURNING id`,
      [sessionId, at],
    );
    return claimed.rows.length > 0;
  }

  async recordClient(client: PairedClient<Grant>): Promise<void> {
    const { scope, kbIds } = grantToColumns(client.grant);
    const serial = client.certSerial;
    const rowId = client.id ?? serial;
    const fingerprint = client.certFingerprint ?? "";
    await this.pool.query(
      `INSERT INTO ${this.pairedClient} (
        id, label, platform, cert_serial, cert_fingerprint, cert_subject,
        cert_not_after, session_id, scope, kb_ids, status, revoked_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id) DO NOTHING`,
      [
        rowId,
        client.label,
        client.platform ?? null,
        serial,
        fingerprint,
        client.certSubject,
        new Date(client.certNotAfter),
        client.sessionId || null,
        scope,
        kbIds === null ? null : JSON.stringify(kbIds),
        client.revokedAt === null ? "active" : "revoked",
        client.revokedAt === null ? null : new Date(client.revokedAt),
        new Date(client.pairedAt),
      ],
    );
    if (client.sessionId) {
      await this.pool.query(
        `UPDATE ${this.pairingCode} SET paired_client_id = $2 WHERE id = $1`,
        [client.sessionId, rowId],
      );
    }
  }

  async revoke(target: RevokeTarget): Promise<RevokeResult<Grant>> {
    if (target.kind === "session") {
      const rows = await this.pool.query(
        `UPDATE ${this.pairingCode}
         SET revoked_at = $2::timestamp
         WHERE id = $1
           AND revoked_at IS NULL
           AND consumed_at IS NULL
         RETURNING *`,
        [target.sessionId, new Date(target.at).toISOString()],
      );
      const row = rows.rows[0] as PairingCodeRow | undefined;
      if (row) {
        return { ok: true, kind: "session", session: sessionFromRow<Grant>(row) };
      }
      const session = await this.getSession(target.sessionId);
      if (!session) return { ok: false, reason: "not-found" };
      if (isConsumed(session)) return { ok: false, reason: "already-consumed", session };
      return { ok: true, kind: "session", session };
    }

    const row =
      (await this.revokeClientBySerial(target.certSerial, target.at)) ??
      (await this.revokeClientBySerial(normaliseCertSerial(target.certSerial), target.at));
    if (row) return { ok: true, kind: "client", client: clientFromRow<Grant>(row) };

    const existing =
      (await this.findClientBySerial(target.certSerial)) ??
      (await this.findClientBySerial(normaliseCertSerial(target.certSerial)));
    if (!existing) return { ok: false, reason: "not-found" };
    return { ok: true, kind: "client", client: existing };
  }

  async listSessions(): Promise<PairingSessionView<Grant>[]> {
    const rows = await this.pool.query(
      `SELECT * FROM ${this.pairingCode} ORDER BY created_at DESC`,
    );
    return (rows.rows as PairingCodeRow[]).map((row) => toPairingSessionView(sessionFromRow(row)));
  }

  async listClients(): Promise<PairedClient<Grant>[]> {
    const rows = await this.pool.query(
      `SELECT * FROM ${this.pairedClient} ORDER BY created_at DESC`,
    );
    return (rows.rows as PairedClientRow[]).map((row) => clientFromRow<Grant>(row));
  }

  async revokedSerials(): Promise<ReadonlySet<string>> {
    const rows = await this.pool.query(
      `SELECT cert_serial FROM ${this.pairedClient} WHERE revoked_at IS NOT NULL`,
    );
    return new Set((rows.rows as { cert_serial: string }[]).map((row) => row.cert_serial));
  }

  private async getSession(id: string): Promise<PairingSession<Grant> | null> {
    const rows = await this.pool.query(`SELECT * FROM ${this.pairingCode} WHERE id = $1 LIMIT 1`, [
      id,
    ]);
    const row = rows.rows[0] as PairingCodeRow | undefined;
    return row ? sessionFromRow<Grant>(row) : null;
  }

  private async findClientBySerial(serial: string): Promise<PairedClient<Grant> | null> {
    const rows = await this.pool.query(
      `SELECT * FROM ${this.pairedClient} WHERE cert_serial = $1 LIMIT 1`,
      [serial],
    );
    const row = rows.rows[0] as PairedClientRow | undefined;
    return row ? clientFromRow<Grant>(row) : null;
  }

  private async revokeClientBySerial(
    serial: string,
    at: number,
  ): Promise<PairedClientRow | undefined> {
    const rows = await this.pool.query(
      `UPDATE ${this.pairedClient}
       SET revoked_at = $2::timestamp, status = 'revoked'
       WHERE cert_serial = $1
         AND revoked_at IS NULL
       RETURNING *`,
      [serial, new Date(at).toISOString()],
    );
    return rows.rows[0] as PairedClientRow | undefined;
  }
}
