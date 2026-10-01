import { SHARED_KEY_REFRESH_MARGIN_SECONDS, type SharedKey, type SharedKeyIssuer } from "./types.ts";

export interface SharedKeyProviderOptions {
  issuer: SharedKeyIssuer;
  coreId: string;
  /** Margin before expiry, in ms. Default 15 minutes; never more than half the key's life. */
  refreshMarginMs?: number;
  /** Clock in ms, for tests. */
  now?: () => number;
}

export interface SharedKeyProvider {
  /** The cached key, or a freshly issued one once the refresh point has passed. */
  get(): Promise<SharedKey>;
}

/** When a key issued at `issuedAtMs` should be replaced. */
export function refreshAtMs(
  key: Pick<SharedKey, "expiresAt">,
  issuedAtMs: number,
  marginMs = SHARED_KEY_REFRESH_MARGIN_SECONDS * 1000,
): number {
  const expiresAtMs = key.expiresAt.getTime();
  const life = expiresAtMs - issuedAtMs;
  return expiresAtMs - Math.min(marginMs, Math.max(life, 0) / 2);
}

export function createSharedKeyProvider(options: SharedKeyProviderOptions): SharedKeyProvider {
  const now = options.now ?? Date.now;
  let current: { key: SharedKey; refreshAt: number } | undefined;
  let inflight: Promise<SharedKey> | undefined;

  const fetchKey = async (): Promise<SharedKey> => {
    const issuedAt = now();
    const key = await options.issuer.issue(options.coreId);
    current = { key, refreshAt: refreshAtMs(key, issuedAt, options.refreshMarginMs) };
    return key;
  };

  return {
    async get() {
      if (current && now() < current.refreshAt) return current.key;
      // One issue call at a time; concurrent callers share it. A failure is not cached.
      inflight ??= fetchKey().finally(() => {
        inflight = undefined;
      });
      try {
        return await inflight;
      } catch (error) {
        // A failed early refresh keeps the old key until it really expires.
        if (current && now() < current.key.expiresAt.getTime()) return current.key;
        throw error;
      }
    },
  };
}
