// JSON-file `PairingStore` — Control's pairing file, behind the port.
//
// Lifted from the top half of Control's `pairing-store.ts`: one JSON file, read
// and rewritten under a process lock so the CLI and daemon keep atomicity across
// processes (closing the lost-revoke race Control documents).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  consumePairingSession,
  createPairingSession,
  isConsumed,
  isDead,
  isExpired,
  isRevoked,
  recordWrongAttempt,
  type NewPairingSession,
  type PairingSession,
} from "../session.ts";
import {
  toPairingSessionView,
  type AttemptClaim,
  type PairedClient,
  type PairingSessionView,
  type PairingStore,
  type RevokeResult,
  type RevokeTarget,
} from "../store-port.ts";

/** The filename, beside `material.json` in the same directory. */
export const PAIRING_STORE_FILENAME = "pairing.json";

/**
 * The pairing file for a Core whose material file is `materialFile`.
 *
 * Derived from the material path rather than configured separately: the daemon
 * is handed exactly one path (`AC_CORE_MATERIAL_FILE`), a container mounts
 * exactly one volume, and a second env var to keep in step with it is a second
 * thing to get wrong.
 */
export function pairingStorePath(materialFile: string): string {
  return path.join(path.dirname(materialFile), PAIRING_STORE_FILENAME);
}

/** The file's shape. Versioned so a later change can migrate rather than guess. */
export type PairingRecords = {
  version: 1;
  sessions: PairingSession<unknown>[];
  clients: PairedClient<unknown>[];
};

/** An empty store — what a missing or unreadable file reads as. */
export function emptyPairingRecords(): PairingRecords {
  return { version: 1, sessions: [], clients: [] };
}

/**
 * How long a session stays in the file after it stops being redeemable.
 *
 * Expired and consumed sessions are kept for a day rather than deleted on the
 * spot, because they are what an operator reads when asking why a pairing
 * failed an hour ago.
 */
export const PAIRING_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

export function createJsonFilePairingStore<Grant = unknown>(filePath: string): PairingStore<Grant> {
  return new JsonFilePairingStore<Grant>(filePath);
}

/** @deprecated Use {@link createJsonFilePairingStore}. */
export const jsonFileStore = createJsonFilePairingStore;

class JsonFilePairingStore<Grant> implements PairingStore<Grant> {
  private readonly persistence: PairingFilePersistence;
  private lock: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.persistence = new PairingFilePersistence(filePath);
  }

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    await acquireFileLock(this.persistence.filePath);
    try {
      return await fn();
    } finally {
      releaseFileLock(this.persistence.filePath);
      release();
    }
  }

  async createSession(input: NewPairingSession<Grant>): Promise<void> {
    await this.withLock(() => {
      const now = input.now;
      const session = createPairingSession(input);
      const records = this.persistence.read();
      records.sessions = prune(
        [...records.sessions.filter((s) => s.id !== session.id), session],
        now,
      );
      this.persistence.write(records);
    });
  }

  async claimAttempt(sessionId: string, now: Date): Promise<AttemptClaim<Grant>> {
    return this.withLock(() => this.claimAttemptLocked(sessionId, now));
  }

  private claimAttemptLocked(sessionId: string, now: Date): AttemptClaim<Grant> {
    const at = now.getTime();
    const records = this.persistence.read();
    const index = records.sessions.findIndex((session) => session.id === sessionId);
    if (index === -1) return { ok: false, reason: "unknown" };
    const session = records.sessions[index]! as PairingSession<Grant>;
    if (isRevoked(session)) return { ok: false, reason: "revoked" };
    if (isConsumed(session)) return { ok: false, reason: "consumed" };
    if (isExpired(session, at)) return { ok: false, reason: "expired" };
    if (isDead(session)) return { ok: false, reason: "exhausted" };

    const updated = recordWrongAttempt(session);
    records.sessions[index] = updated;
    this.persistence.write(records);

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

  async consume(sessionId: string, now: Date): Promise<boolean> {
    return this.withLock(() => {
      const records = this.persistence.read();
      const index = records.sessions.findIndex((session) => session.id === sessionId);
      if (index === -1) return false;
      const result = consumePairingSession(records.sessions[index]!, now.getTime());
      if (!result.ok) return false;
      records.sessions[index] = result.session;
      this.persistence.write(records);
      return true;
    });
  }

  async recordClient(client: PairedClient<Grant>): Promise<void> {
    await this.withLock(() => {
      const now = Date.now();
      const records = this.persistence.read();
      records.clients = [...records.clients.filter((c) => c.certSerial !== client.certSerial), client];
      records.sessions = prune(records.sessions, now);
      this.persistence.write(records);
    });
  }

  async revoke(target: RevokeTarget): Promise<RevokeResult<Grant>> {
    return this.withLock(() => this.revokeLocked(target));
  }

  private revokeLocked(target: RevokeTarget): RevokeResult<Grant> {
    const records = this.persistence.read();
    if (target.kind === "session") {
      const index = records.sessions.findIndex((session) => session.id === target.sessionId);
      if (index === -1) return { ok: false, reason: "not-found" };
      const session = records.sessions[index]! as PairingSession<Grant>;
      if (isConsumed(session)) return { ok: false, reason: "already-consumed", session };
      if (isRevoked(session)) return { ok: true, kind: "session", session };
      const cancelled: PairingSession<Grant> = { ...session, revokedAt: target.at };
      records.sessions[index] = cancelled;
      this.persistence.write(records);
      return { ok: true, kind: "session", session: cancelled };
    }

    const index = records.clients.findIndex((row) => row.certSerial === target.certSerial);
    if (index === -1) return { ok: false, reason: "not-found" };
    const existing = records.clients[index]! as PairedClient<Grant>;
    if (existing.revokedAt !== null) {
      return { ok: true, kind: "client", client: existing };
    }
    const revoked: PairedClient<Grant> = { ...existing, revokedAt: target.at };
    records.clients[index] = revoked;
    this.persistence.write(records);
    return { ok: true, kind: "client", client: revoked };
  }

  async listSessions(): Promise<PairingSessionView<Grant>[]> {
    const records = this.persistence.read();
    return [...records.sessions]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => toPairingSessionView(session as PairingSession<Grant>));
  }

  async listClients(): Promise<PairedClient<Grant>[]> {
    const records = this.persistence.read();
    return [...records.clients].sort((a, b) => b.pairedAt - a.pairedAt) as PairedClient<Grant>[];
  }

  async revokedSerials(): Promise<ReadonlySet<string>> {
    const records = this.persistence.read();
    return new Set(
      records.clients.filter((row) => row.revokedAt !== null).map((row) => row.certSerial),
    );
  }
}

/**
 * The pairing file reader/writer — lifted from Control's synchronous store.
 *
 * Every mutating port method holds the file lock and calls through here so
 * read-modify-write stays atomic across processes.
 */
class PairingFilePersistence {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Everything on disk. A missing, corrupt or wrong-shaped file reads as empty,
   * and a single unrecognised row is dropped while the rest are kept.
   */
  read(): PairingRecords {
    try {
      return this.parse(false);
    } catch {
      return emptyPairingRecords();
    }
  }

  /**
   * Everything on disk, or throw saying why it could not be read.
   *
   * A file that is not there is not an error — a Core that has never paired
   * anything has no `pairing.json`.
   */
  readStrict(): PairingRecords {
    return this.parse(true);
  }

  private parse(strict: boolean): PairingRecords {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyPairingRecords();
      throw new Error(`${this.filePath} could not be read: ${errorText(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${this.filePath} is not valid JSON: ${errorText(err)}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${this.filePath} is not a pairing store`);
    }
    const o = parsed as Partial<PairingRecords>;
    return {
      version: 1,
      sessions: this.rows(o.sessions, isPairingSession, "session", strict).map(normaliseSession),
      clients: this.rows(o.clients, isPairedClient, "client", strict),
    };
  }

  private rows<T>(
    value: unknown,
    isRow: (row: unknown) => row is T,
    what: string,
    strict: boolean,
  ): T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      if (!strict) return [];
      throw new Error(`${this.filePath}: ${what}s is not a list`);
    }
    if (!strict) return value.filter(isRow);
    return value.map((row, index) => {
      if (!isRow(row)) {
        throw new Error(`${this.filePath}: ${what} ${index} is not a ${what} this build knows`);
      }
      return row;
    });
  }

  write(records: PairingRecords): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* best effort — non-POSIX filesystems have no mode to set */
    }
  }
}

/** Read a pairing file strictly — for callers whose safety depends on contents. */
export function readPairingRecordsStrict(filePath: string): PairingRecords {
  return new PairingFilePersistence(filePath).readStrict();
}

function lockPath(filePath: string): string {
  return `${filePath}.lock`;
}

/**
 * Cross-process exclusive lock via `O_CREAT|O_EXCL`.
 *
 * Serialises read-modify-write across CLI and daemon; paired with the in-process
 * promise mutex so concurrent async calls in one process queue fairly too.
 */
async function acquireFileLock(filePath: string): Promise<void> {
  const lock = lockPath(filePath);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        await delay(5);
        continue;
      }
      throw err;
    }
  }
}

function releaseFileLock(filePath: string): void {
  try {
    fs.unlinkSync(lockPath(filePath));
  } catch {
    /* best effort */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function prune(sessions: PairingSession<unknown>[], now: number): PairingSession<unknown>[] {
  return sessions.filter((session) => {
    const settled = session.consumedAt ?? session.expiresAt;
    return now - settled < PAIRING_SESSION_RETENTION_MS;
  });
}

function isPairingSession(value: unknown): value is PairingSession<unknown> {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    typeof o.codeHash === "string" &&
    typeof o.createdAt === "number" &&
    typeof o.expiresAt === "number" &&
    typeof o.attempts === "number" &&
    typeof o.attemptCap === "number" &&
    (o.consumedAt === null || typeof o.consumedAt === "number")
  );
}

function normaliseSession(session: PairingSession<unknown>): PairingSession<unknown> {
  const raw: unknown = session.endpointHost;
  if (raw === undefined || raw === null) return session;
  const host = typeof raw === "string" ? raw.trim() : "";
  if (host.length > 0 && host === raw) return session;
  return { ...session, endpointHost: host.length > 0 ? host : null };
}

function isPairedClient(value: unknown): value is PairedClient<unknown> {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.certSerial === "string" &&
    typeof o.certSubject === "string" &&
    typeof o.label === "string" &&
    typeof o.pairedAt === "number" &&
    (o.revokedAt === null || typeof o.revokedAt === "number")
  );
}
