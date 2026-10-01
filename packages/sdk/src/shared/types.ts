// The CoreShared interface: one view of a Core's Shared folder, whichever way it is reached.
// Mode-agnostic on purpose: nothing here names S3. The direct-S3 mode (./s3.ts) and the
// through-the-Core mode (./core.ts) both implement it and must pass the same contract suite.

/**
 * Paths are relative to the Core's Shared folder root, use `/` and never escape it.
 * A path ending in `/` names a folder, any other path names a file. The root is `""`.
 * Refused as `invalid-path`: a leading `/`, a `.` or `..` segment, an empty segment (`a//b`),
 * a backslash, and control characters.
 */
export type SharedPath = string;

export type SharedEntryKind = "file" | "folder";

export interface SharedEntry {
  /** Relative to the root, with no trailing slash, even for a folder. */
  readonly path: string;
  readonly kind: SharedEntryKind;
  /** Bytes. Absent for a folder. */
  readonly size?: number;
  /**
   * Always present for a file. For a folder it is optional in every mode: a mode may give a time
   * for a folder (a Core's disk has one) or none (an object store has none for a folder that exists
   * only because something is inside it). A caller must not rely on either, and a test may not
   * compare a folder entry as a whole object, only by `kind` and `path`.
   */
  readonly modifiedAt?: Date;
}

export interface SharedFile extends SharedEntry {
  readonly kind: "file";
  readonly size: number;
  readonly body: Uint8Array;
}

/** One entry of a folder tree to upload. `path` is relative to the upload destination. */
export type SharedUploadEntry =
  | { readonly path: string; readonly body: Uint8Array | string }
  | { readonly path: string; readonly folder: true };

/** An opaque position in the change feed. Treat it as a string to store and hand back. */
export type SharedCursor = string;

/**
 * Folder rules, the same in every mode (a Core's disk, an object store):
 *
 * - A folder you made with `mkdir`, or that holds something, is listed by `list`.
 * - `rm` of a folder and `move` of a folder remove the folder at the old path, with its contents.
 * - Whether a folder stays once its last file is deleted or moved out is NOT defined: a disk keeps
 *   it, flat S3 does not. Callers must `mkdir` (or not rely on) a folder they want to keep empty,
 *   and no test asserts either way.
 * - `watch` must report every change to a FILE. It MAY report folders (created, removed), and which
 *   ones is the mode's business: an object store can tell a made-empty folder from a folder that
 *   merely holds files, a disk cannot. A caller treats folder changes as hints and never depends
 *   on one; the contract suite looks at files only.
 */
export interface SharedChange {
  readonly path: string;
  readonly kind: SharedEntryKind;
  /** True when the entry was removed since the cursor; `size` and `modifiedAt` are then absent. */
  readonly deleted: boolean;
  readonly size?: number;
  readonly modifiedAt?: Date;
}

export interface SharedWatchResult {
  readonly changes: readonly SharedChange[];
  /** Pass it to the next `watch` to get only what changed after this call. */
  readonly cursor: SharedCursor;
}

export interface SharedSignedUrl {
  readonly url: string;
  /** Never later than the key it was signed with expires. */
  readonly expiresAt: Date;
}

export interface CoreShared {
  /** The direct children of a folder: folders first, then files, each by name. A missing folder lists as empty. */
  list(path: SharedPath): Promise<SharedEntry[]>;
  /** A file's bytes. `not-found` if there is none. */
  get(path: SharedPath): Promise<SharedFile>;
  /** Create or replace a file. Missing parent folders come into being. */
  put(path: SharedPath, body: Uint8Array | string): Promise<void>;
  /** Create a folder (and so its parents). Succeeds if it already exists. */
  mkdir(path: SharedPath): Promise<void>;
  /** Delete a file, or, for a path ending in `/`, a folder and everything in it. The root is refused. */
  rm(path: SharedPath): Promise<void>;
  /**
   * Move or rename. `from` and `to` are both files or both folders (both end in `/`); a folder
   * moves with its contents; a rename is a move within the same folder. `exists` if `to` is taken.
   */
  move(from: SharedPath, to: SharedPath): Promise<void>;
  /**
   * Upload a folder tree under `destination`. Every entry is checked before anything is written,
   * so a bad path writes nothing. Files are then written one by one; if that fails part-way the
   * thrown {@link CoreSharedPartialError} lists what was written.
   */
  upload(destination: SharedPath, entries: Iterable<SharedUploadEntry>): Promise<SharedPath[]>;
  /**
   * What changed since `since` (everything, when omitted) and the cursor to continue from.
   * Every file change is reported; folder changes are optional (see {@link SharedChange}).
   * The cursor is opaque and only meaningful to the mode that issued it. A string that is empty or is
   * not a cursor at all (for example `"garbage"`) is `invalid-cursor` in every mode; beyond that a mode
   * decides what it accepts, so a cursor of one mode may be a valid cursor of another.
   */
  watch(since?: SharedCursor): Promise<SharedWatchResult>;
  /** A URL that downloads one file without credentials, valid for `expiresInSeconds` (default 300) or until the key behind it expires. */
  signedUrl(path: SharedPath, options?: { expiresInSeconds?: number }): Promise<SharedSignedUrl>;
}

export type CoreSharedErrorCode =
  | "invalid-path" // the path is not one this interface accepts (escape, root, empty segment, ...)
  | "invalid-argument"
  | "invalid-cursor"
  | "invalid-move" // a folder into itself
  | "not-found"
  | "exists" // move onto a taken path
  | "is-folder" // a file operation on a path that is a folder
  | "not-folder" // a folder operation on a path that is a file
  | "forbidden" // the key may not do this (outside its prefix, or not allowed)
  | "expired" // the key has expired
  | "unavailable" // the store could not be reached or failed
  | "partial"; // see CoreSharedPartialError

/** Thrown by every operation. The message never carries a key, a signed URL or a file's content. */
export class CoreSharedError extends Error {
  override readonly name: string = "CoreSharedError";
  readonly code: CoreSharedErrorCode;
  readonly status?: number;

  constructor(code: CoreSharedErrorCode, message: string, details: { status?: number } = {}) {
    super(message);
    this.code = code;
    this.status = details.status;
  }
}

/**
 * An operation of many writes failed part-way and left some of them behind (see each mode's docs
 * for the exact leftovers). `leftBehind` are paths relative to the root, the ones the operation
 * did not finish with:
 *
 * - `move`, `stage: "copy"`: copies at the destination that could not be rolled back (empty when
 *   the rollback worked). The source is untouched.
 * - `move`, `stage: "delete"`: the source paths that are still there. The destination is complete.
 * - `rm`: the paths that were not deleted.
 * - `upload`: the files that were written before the failure.
 */
export class CoreSharedPartialError extends CoreSharedError {
  override readonly name = "CoreSharedPartialError";
  readonly operation: "move" | "rm" | "upload";
  readonly stage: "copy" | "delete" | "write";
  readonly leftBehind: readonly string[];
  /** The code of the failure that stopped it. */
  readonly reason: CoreSharedErrorCode;

  constructor(
    operation: "move" | "rm" | "upload",
    stage: "copy" | "delete" | "write",
    leftBehind: readonly string[],
    cause: CoreSharedError,
  ) {
    super("partial", `${operation} stopped during ${stage} after a failure (${cause.code}); ${leftBehind.length} path(s) left behind`, {
      status: cause.status,
    });
    this.operation = operation;
    this.stage = stage;
    this.leftBehind = leftBehind;
    this.reason = cause.code;
  }
}
