// DDL for the Search pairing tables — parameterized by schema name.
//
// Only the columns {@link PostgresPairingStore} reads and writes are included.
// Tests call {@link ensurePairingTables} before running the contract suite.

/** Identifier-safe schema name (letters, digits, underscore). */
export function assertSchemaName(schema: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error(`invalid pairing schema name: ${schema}`);
  }
  return schema;
}

/** Fully quoted `"schema"."table"` for raw SQL. */
export function qualifiedTable(schema: string, table: "pairing_code" | "paired_client"): string {
  const safe = assertSchemaName(schema);
  return `"${safe}"."${table}"`;
}

/** Create schema and pairing tables if they are not already there. */
export async function ensurePairingTables(
  query: (sql: string, params?: unknown[]) => Promise<unknown>,
  schema: string,
): Promise<void> {
  const safe = assertSchemaName(schema);
  await query(`CREATE SCHEMA IF NOT EXISTS "${safe}"`);
  await query(`
    CREATE TABLE IF NOT EXISTS ${qualifiedTable(safe, "paired_client")} (
      id text PRIMARY KEY,
      label text NOT NULL,
      platform text,
      cert_serial text NOT NULL,
      cert_fingerprint text NOT NULL DEFAULT '',
      cert_subject text NOT NULL DEFAULT '',
      cert_not_after timestamp,
      session_id text,
      scope text NOT NULL DEFAULT 'read',
      kb_ids jsonb,
      status text NOT NULL DEFAULT 'active',
      last_seen_at timestamp,
      revoked_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS ${qualifiedTable(safe, "pairing_code")} (
      id text PRIMARY KEY,
      paired_client_id text REFERENCES ${qualifiedTable(safe, "paired_client")}(id) ON DELETE SET NULL,
      label text NOT NULL DEFAULT '',
      code_hash text NOT NULL,
      expires_at timestamp NOT NULL,
      consumed_at timestamp,
      revoked_at timestamp,
      attempts integer NOT NULL DEFAULT 0,
      attempt_cap integer NOT NULL DEFAULT 5,
      scope text NOT NULL,
      kb_ids jsonb,
      created_by text,
      tenant_id text,
      auth_method text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

/** Truncate pairing tables between contract cases. */
export async function truncatePairingTables(
  query: (sql: string) => Promise<unknown>,
  schema: string,
): Promise<void> {
  const pairingCode = qualifiedTable(schema, "pairing_code");
  const pairedClient = qualifiedTable(schema, "paired_client");
  await query(`TRUNCATE ${pairingCode}, ${pairedClient} CASCADE`);
}
