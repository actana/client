/**
 * Join a Shared-folder bucket prefix with a Core id into the Core's root path,
 * always with a trailing slash: `cores/core-a/`. Empty prefix → `core-a/`.
 */
export function coreRootPrefix(prefix: string, coreId: string): string {
  const base = prefix.replace(/^\/+|\/+$/g, "");
  return base === "" ? `${coreId}/` : `${base}/${coreId}/`;
}
