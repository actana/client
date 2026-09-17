/**
 * Postgres `PairingStore` — contract suite against a real database.
 *
 * Uses `SEARCH_TEST_DATABASE_URL` or `ACTANA_TEST_DATABASE_URL` when set.
 * Otherwise tries a throwaway Docker Postgres on port 55432 and skips only when
 * the Docker daemon is unavailable.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { pairingStoreContract } from "./store-contract.ts";
import {
  ensurePairingTables,
  truncatePairingTables,
} from "../stores/postgres-schema.ts";
import { createPostgresPairingStore } from "../stores/postgres.ts";

const execFile = promisify(execFileCb);

const DOCKER_PORT = 55_432;
const DOCKER_IMAGE = "postgres:16-alpine";
const DOCKER_URL = `postgresql://postgres:postgres@127.0.0.1:${DOCKER_PORT}/postgres`;

type PgModule = typeof import("pg");

type TestDatabase = {
  url: string;
  pool: InstanceType<PgModule["Pool"]>;
  dockerContainerId: string | null;
  usedDocker: boolean;
};

async function dockerDaemonAvailable(): Promise<boolean> {
  try {
    await execFile("docker", ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForPostgres(url: string, attempts = 30): Promise<void> {
  const pg = await import("pg");
  for (let i = 0; i < attempts; i++) {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Postgres did not become ready at ${url}`);
}

async function startDockerPostgres(): Promise<string> {
  const { stdout } = await execFile("docker", [
    "run",
    "-d",
    "--rm",
    "-p",
    `${DOCKER_PORT}:5432`,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    DOCKER_IMAGE,
  ]);
  const containerId = stdout.trim();
  await waitForPostgres(DOCKER_URL);
  return containerId;
}

async function resolveTestDatabase(): Promise<TestDatabase | null> {
  const configured =
    process.env.SEARCH_TEST_DATABASE_URL ?? process.env.ACTANA_TEST_DATABASE_URL ?? "";
  if (configured !== "") {
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: configured, max: 4 });
    await pool.query("SELECT 1");
    return { url: configured, pool, dockerContainerId: null, usedDocker: false };
  }

  if (!(await dockerDaemonAvailable())) return null;

  const containerId = await startDockerPostgres();
  const pg = await import("pg");
  const pool = new pg.Pool({ connectionString: DOCKER_URL, max: 4 });
  return { url: DOCKER_URL, pool, dockerContainerId: containerId, usedDocker: true };
}

const dbPromise = resolveTestDatabase();

describe.skipIf(!(await dbPromise))("postgres pairing store", async () => {
  const db = (await dbPromise)!;
  const schema = `pairing_test_${Date.now().toString(36)}`;

  beforeAll(async () => {
    await ensurePairingTables((sql, params) => db.pool.query(sql, params), schema);
  });

  beforeEach(async () => {
    await truncatePairingTables((sql) => db.pool.query(sql), schema);
  });

  afterAll(async () => {
    await db.pool.end();
    if (db.dockerContainerId) {
      await execFile("docker", ["stop", db.dockerContainerId]).catch(() => undefined);
    }
  });

  pairingStoreContract(() => createPostgresPairingStore(db.pool, { schema }));
});
