// In-memory `PairingStore` — the contract suite's reference implementation.
//
// Claims are serialized through a promise-chain mutex so the concurrent cap
// test is meaningful even though everything runs in one process.

import {
  canRedeem,
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

export function createMemoryPairingStore<Grant = unknown>(): PairingStore<Grant> {
  return new MemoryPairingStore<Grant>();
}

class MemoryPairingStore<Grant> implements PairingStore<Grant> {
  private sessions = new Map<string, PairingSession<Grant>>();
  private clients: PairedClient<Grant>[] = [];
  private lock: Promise<void> = Promise.resolve();

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async createSession(input: NewPairingSession<Grant>): Promise<void> {
    await this.withLock(() => {
      const session = createPairingSession(input);
      this.sessions.set(session.id, session);
    });
  }

  async claimAttempt(sessionId: string, now: Date): Promise<AttemptClaim<Grant>> {
    return this.withLock(() => this.claimAttemptLocked(sessionId, now));
  }

  private claimAttemptLocked(sessionId: string, now: Date): AttemptClaim<Grant> {
    const at = now.getTime();
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: "unknown" };
    if (isRevoked(session)) return { ok: false, reason: "revoked" };
    if (isConsumed(session)) return { ok: false, reason: "consumed" };
    if (isExpired(session, at)) return { ok: false, reason: "expired" };
    if (isDead(session)) return { ok: false, reason: "exhausted" };

    const updated = recordWrongAttempt(session);
    this.sessions.set(sessionId, updated);

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
      const session = this.sessions.get(sessionId);
      if (!session) return false;
      const result = consumePairingSession(session, now.getTime());
      if (!result.ok) return false;
      this.sessions.set(sessionId, result.session);
      return true;
    });
  }

  async recordClient(client: PairedClient<Grant>): Promise<void> {
    await this.withLock(() => {
      this.clients = [
        ...this.clients.filter((row) => row.certSerial !== client.certSerial),
        client,
      ];
    });
  }

  async revoke(target: RevokeTarget): Promise<RevokeResult<Grant>> {
    return this.withLock(() => this.revokeLocked(target));
  }

  private revokeLocked(target: RevokeTarget): RevokeResult<Grant> {
    if (target.kind === "session") {
      const session = this.sessions.get(target.sessionId);
      if (!session) return { ok: false, reason: "not-found" };
      if (isConsumed(session)) return { ok: false, reason: "already-consumed", session };
      if (isRevoked(session)) return { ok: true, kind: "session", session };
      const cancelled: PairingSession<Grant> = { ...session, revokedAt: target.at };
      this.sessions.set(target.sessionId, cancelled);
      return { ok: true, kind: "session", session: cancelled };
    }

    const index = this.clients.findIndex((row) => row.certSerial === target.certSerial);
    if (index === -1) return { ok: false, reason: "not-found" };
    const existing = this.clients[index]!;
    if (existing.revokedAt !== null) {
      return { ok: true, kind: "client", client: existing };
    }
    const revoked: PairedClient<Grant> = { ...existing, revokedAt: target.at };
    this.clients[index] = revoked;
    return { ok: true, kind: "client", client: revoked };
  }

  async listSessions(): Promise<PairingSessionView<Grant>[]> {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toPairingSessionView);
  }

  async listClients(): Promise<PairedClient<Grant>[]> {
    return [...this.clients].sort((a, b) => b.pairedAt - a.pairedAt);
  }

  async revokedSerials(): Promise<ReadonlySet<string>> {
    return new Set(
      this.clients.filter((row) => row.revokedAt !== null).map((row) => row.certSerial),
    );
  }
}
