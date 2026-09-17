import {
  loadSearchBlob,
  readCurrentSearch,
  searchExists,
  searchNameError,
  type RegistryPaths,
  type RegistrationBlob,
} from "../registry/credentials.ts";

export type ResolvedSearch = {
  name: string;
  source: "flag" | "current";
  blob: RegistrationBlob;
};

export type ResolveSearchResult =
  | { ok: true; search: ResolvedSearch }
  | { ok: false; error: string };

export function resolveSearch(opts: {
  paths: RegistryPaths;
  searchFlag: string | null;
}): ResolveSearchResult {
  if (opts.searchFlag) {
    const name = opts.searchFlag;
    if (searchNameError(name) !== null || !searchExists(opts.paths, name)) {
      return { ok: false, error: `no Search instance named "${name}"` };
    }
    const loaded = loadSearchBlob(opts.paths, name);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return { ok: true, search: { name, source: "flag", blob: loaded.blob } };
  }

  const current = readCurrentSearch(opts.paths);
  if (!current) {
    return {
      ok: false,
      error: "no Search instance is selected — `actana search ls` lists what this machine knows",
    };
  }
  const loaded = loadSearchBlob(opts.paths, current);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, search: { name: current, source: "current", blob: loaded.blob } };
}
