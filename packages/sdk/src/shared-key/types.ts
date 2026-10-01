/** Lifetime of every issued Shared-folder key. */
export const SHARED_KEY_LIFETIME_SECONDS = 3600;

/** A key is refreshed this long before it expires, capped at half its life. */
export const SHARED_KEY_REFRESH_MARGIN_SECONDS = 900;

/**
 * What a Core receives: a short-lived S3 key limited to `<prefix>/<core-id>/`.
 * It never carries the controller's master key; an issuer returns only these four fields.
 */
export interface SharedKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: Date;
}

/** Controller-side: holds the master key and issues one key per Core. */
export interface SharedKeyIssuer {
  /** Issue a 1-hour key for `coreId`, limited to that Core's prefix. */
  issue(coreId: string): Promise<SharedKey>;
}

/** Thrown by issuers. The message never contains master key material or the token sent. */
export class SharedKeyIssueError extends Error {
  override readonly name = "SharedKeyIssueError";
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, details: { status?: number; code?: string } = {}) {
    super(message);
    this.status = details.status;
    this.code = details.code;
  }
}

// Lowercase only: the SeaweedFS policy compares resources case-insensitively and substitutes
// the id unescaped, so ids must not carry wildcards, slashes or dots, and must be unique
// ignoring case (actana/control deploy/seaweedfs/README.md, "Two properties").
const CORE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function assertValidCoreId(coreId: string): void {
  if (typeof coreId !== "string" || !CORE_ID.test(coreId)) {
    throw new SharedKeyIssueError(
      "invalid core id: use 1-63 lowercase letters, digits, '-' or '_', starting with a letter or digit",
    );
  }
}
