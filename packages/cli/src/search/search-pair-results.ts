// Success-line formatting for `actana search pair`.

export type SearchPairGrant = {
  scope: string;
  kbCount: number | null;
};

/** Format `✓ paired Search docs  (scope read · 2 knowledge bases)`. */
export function formatSearchPairSuccessLine(name: string, grant: SearchPairGrant): string {
  const kbPart =
    grant.kbCount === null
      ? "all knowledge bases"
      : grant.kbCount === 1
        ? "1 knowledge base"
        : `${grant.kbCount} knowledge bases`;
  return `✓ paired Search ${name}  (scope ${grant.scope} · ${kbPart})`;
}

/** Derive grant facts from pair status, or fall back when the route is unavailable. */
export function grantFromPairStatus(status: {
  scope?: string | null;
  kbIds?: string[] | null;
}): SearchPairGrant {
  const scope = typeof status.scope === "string" && status.scope ? status.scope : "read";
  const kbIds = status.kbIds;
  const kbCount = kbIds === null || kbIds === undefined ? null : kbIds.length;
  return { scope, kbCount };
}
