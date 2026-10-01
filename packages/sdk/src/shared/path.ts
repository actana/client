import { CoreSharedError } from "./types.ts";

export interface ParsedSharedPath {
  /** The names from the root down. Empty for the root. */
  readonly segments: readonly string[];
  /** The path ended in `/` (or is the root). */
  readonly folder: boolean;
  /** `a/b` for `a/b` and `a/b/`; `""` for the root. */
  readonly relative: string;
}

// C0 controls and DEL. A backslash is refused too: it is a separator on some Cores.
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/;

/**
 * The one place a caller's path becomes a path under the root. It never resolves anything: a `..`,
 * a `.`, an empty segment and a leading `/` are refused, not normalised, so there is nothing to
 * escape with. (Percent-escapes are not decoded: `%2e%2e` is a name.)
 */
export function parseSharedPath(input: unknown, what = "path"): ParsedSharedPath {
  if (typeof input !== "string") throw new CoreSharedError("invalid-path", `${what} must be a string`);
  if (input === "") return { segments: [], folder: true, relative: "" };
  if (input.startsWith("/")) throw new CoreSharedError("invalid-path", `${what} must be relative to the Shared folder, not absolute`);
  if (FORBIDDEN.test(input)) throw new CoreSharedError("invalid-path", `${what} holds a backslash or a control character`);
  const folder = input.endsWith("/");
  const segments = (folder ? input.slice(0, -1) : input).split("/");
  for (const segment of segments) {
    if (segment === "") throw new CoreSharedError("invalid-path", `${what} has an empty segment`);
    if (segment === "." || segment === "..") throw new CoreSharedError("invalid-path", `${what} may not contain "." or ".."`);
  }
  return { segments, folder, relative: segments.join("/") };
}

export function parseFilePath(input: unknown): ParsedSharedPath {
  const parsed = parseSharedPath(input);
  if (parsed.segments.length === 0) throw new CoreSharedError("invalid-path", "the root is not a file");
  if (parsed.folder) throw new CoreSharedError("is-folder", "path names a folder (it ends in /), a file is needed");
  return parsed;
}
