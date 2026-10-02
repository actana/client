// Product-keyed credential registry — cores and Search under ~/.config/actana (T-216).
//
//   $XDG_CONFIG_HOME/actana/cores/<name>.txt    Core blob, mode 0600
//   $XDG_CONFIG_HOME/actana/search/<name>.txt   Search blob, same format
//   $XDG_CONFIG_HOME/actana/current.json        { core, search } pointers
//   $XDG_CONFIG_HOME/actana/current.txt         the Core pointer in its old spelling
//
// **One pointer, read from two files.** `current.json` is the pointer; `current.txt` is the same
// Core name in the form Control's own CLI has written since before this registry had a JSON file, and
// Control still writes only that one until actana/control issue 580 makes it write both. So a Core
// that was selected by Control alone has a `current.txt` and no `current.json`, and one selected by
// this client has both. Reading therefore prefers `current.json` and falls back to `current.txt`
// when the JSON names no Core this machine has (absent, empty, malformed, or a Core since removed).
// This client writes both on every change, which is what keeps the two files from disagreeing
// when only the client touches them.
//
// On first access, profiles from ~/.actana-search/cli.json import into search/.
// The legacy cli.json file continues to be read for one release when search/
// does not yet hold a profile.

import * as fs from "node:fs";
import * as path from "node:path";

/** Mode for a file holding a credential: owner read/write, nobody else. */
export const BLOB_FILE_MODE = 0o600;

/** Mode for the directory holding them: owner only, so a listing is private too. */
export const REGISTRY_DIR_MODE = 0o700;

export type CredentialProduct = "core" | "search";

/** The paths the registry is made of, resolved once. */
export type RegistryPaths = {
  /** `<config>/actana` — client credentials only. */
  root: string;
  /** `<config>/actana/cores` — one `<name>.txt` per Core. */
  coresDir: string;
  /** `<config>/actana/search` — one `<name>.txt` per Search instance. */
  searchDir: string;
  /** `<config>/actana/current.txt` — legacy Core pointer. */
  currentPointer: string;
  /** `<config>/actana/current.json` — `{ core, search }` pointers. */
  currentJson: string;
  /** `~/.actana-search/cli.json` — legacy Search profiles (one release). */
  legacySearchCliJson: string;
};

export type CurrentPointers = {
  core: string | null;
  search: string | null;
};

/** A decoded registration blob — the shape every product stores at rest. */
export type RegistrationBlob = {
  endpoint: string;
  label?: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  bearer: string;
};

export type BlobDecodeResult =
  | { ok: true; blob: RegistrationBlob }
  | { ok: false; error: string };

export type BlobSummary = {
  endpoint: string;
  label: string;
};

/** One row of `actana core ls`: what is known about a Core without dialling it. */
export type RegisteredCore = {
  name: string;
  current: boolean;
  summary: BlobSummary | null;
  error: string | null;
  insecureMode: boolean;
};

/** One row of `actana search ls`: what is known about a Search instance without dialling it. */
export type RegisteredSearch = {
  name: string;
  current: boolean;
  summary: BlobSummary | null;
  error: string | null;
  insecureMode: boolean;
};

type LegacyCliProfile = {
  blob: string;
  endpoint: string;
  label?: string;
};

type LegacyCliConfig = {
  defaultProfile: string;
  profiles: Record<string, LegacyCliProfile>;
};

const MAX_NAME_LENGTH = 64;

const REDACTED = "[redacted]";

/**
 * Where the registry lives, honouring `XDG_CONFIG_HOME`.
 *
 * A relative `XDG_CONFIG_HOME` is ignored rather than resolved against the
 * working directory: the specification says the variable holds an absolute
 * path, and a registry whose location depends on where the operator happened to
 * be standing when they paired a Core is a registry that loses Cores.
 */
export function registryPaths(env: NodeJS.ProcessEnv, home: string): RegistryPaths {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const configHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
  const root = path.join(configHome, "actana");
  return {
    root,
    coresDir: path.join(root, "cores"),
    searchDir: path.join(root, "search"),
    currentPointer: path.join(root, "current.txt"),
    currentJson: path.join(root, "current.json"),
    legacySearchCliJson: path.join(home, ".actana-search", "cli.json"),
  };
}

/**
 * Import legacy Search profiles and sync current.json from the old layout.
 *
 * Safe to call on every registry access: imports only when search/ is empty,
 * and writes current.json only when it is missing or incomplete.
 */
export function ensureCredentialRegistry(paths: RegistryPaths): void {
  importLegacySearchProfiles(paths);
  syncCurrentJsonFromLegacy(paths);
}

/**
 * Why this name cannot be used, or null when it can.
 *
 * The pattern is narrow because a name becomes a path segment. Nothing that
 * could traverse (`..`, a separator), hide (a leading dot), or arrive from a
 * shell's expansion of something else gets through.
 */
export function coreNameError(name: string): string | null {
  return credentialNameError(name);
}

export function searchNameError(name: string): string | null {
  if (!name) return "a Search name is required";
  const err = credentialNameError(name);
  if (err === null) return null;
  return err.replace(/^a Core name/, "a Search name");
}

export function credentialNameError(name: string): string | null {
  if (!name) return "a Core name is required";
  if (name.length > MAX_NAME_LENGTH) {
    return `a Core name is at most ${MAX_NAME_LENGTH} characters`;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    return "a Core name starts with a letter or digit and holds only letters, digits, dot, dash and underscore";
  }
  return null;
}

export function coreBlobPath(paths: RegistryPaths, name: string): string {
  return productBlobPath(paths, "core", name);
}

export function searchBlobPath(paths: RegistryPaths, name: string): string {
  return productBlobPath(paths, "search", name);
}

export function productBlobPath(paths: RegistryPaths, product: CredentialProduct, name: string): string {
  const dir = product === "core" ? paths.coresDir : paths.searchDir;
  return path.join(dir, `${name}.txt`);
}

export function writeCoreBlob(paths: RegistryPaths, name: string, text: string): void {
  writeProductBlob(paths, "core", name, text);
}

export function writeSearchBlob(paths: RegistryPaths, name: string, text: string): void {
  writeProductBlob(paths, "search", name, text);
}

export function writeProductBlob(
  paths: RegistryPaths,
  product: CredentialProduct,
  name: string,
  text: string,
): void {
  const dir = product === "core" ? paths.coresDir : paths.searchDir;
  fs.mkdirSync(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
  const file = productBlobPath(paths, product, name);
  fs.writeFileSync(file, `${text.trim()}\n`, { mode: BLOB_FILE_MODE });
  fs.chmodSync(file, BLOB_FILE_MODE);
}

export function readCoreBlobText(paths: RegistryPaths, name: string): string | null {
  return readProductBlobText(paths, "core", name);
}

export function readSearchBlobText(paths: RegistryPaths, name: string): string | null {
  const fromRegistry = readProductBlobText(paths, "search", name);
  if (fromRegistry !== null) return fromRegistry;
  const legacy = readLegacyCliConfig(paths.legacySearchCliJson);
  const profile = legacy.profiles[name];
  if (!profile?.blob) return null;
  return `${profile.blob.trim()}\n`;
}

export function readProductBlobText(
  paths: RegistryPaths,
  product: CredentialProduct,
  name: string,
): string | null {
  try {
    return fs.readFileSync(productBlobPath(paths, product, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function coreExists(paths: RegistryPaths, name: string): boolean {
  return productExists(paths, "core", name);
}

export function searchExists(paths: RegistryPaths, name: string): boolean {
  return productExists(paths, "search", name) || legacyProfileExists(paths, name);
}

function legacyProfileExists(paths: RegistryPaths, name: string): boolean {
  const legacy = readLegacyCliConfig(paths.legacySearchCliJson);
  return Boolean(legacy.profiles[name]?.blob);
}

export function productExists(paths: RegistryPaths, product: CredentialProduct, name: string): boolean {
  return fs.existsSync(productBlobPath(paths, product, name));
}

export function listCoreNames(paths: RegistryPaths): string[] {
  return listProductNames(paths, "core");
}

export function listSearchNames(paths: RegistryPaths): string[] {
  return listProductNames(paths, "search");
}

export function listProductNames(paths: RegistryPaths, product: CredentialProduct): string[] {
  const dir = product === "core" ? paths.coresDir : paths.searchDir;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => entry.name.slice(0, -".txt".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function listUsableCoreNames(paths: RegistryPaths): string[] {
  return listCoreNames(paths).filter((name) => coreNameError(name) === null);
}

export function removeCoreBlob(paths: RegistryPaths, name: string): boolean {
  return removeProductBlob(paths, "core", name);
}

export function removeSearchBlob(paths: RegistryPaths, name: string): boolean {
  return removeProductBlob(paths, "search", name);
}

export function removeProductBlob(
  paths: RegistryPaths,
  product: CredentialProduct,
  name: string,
): boolean {
  try {
    fs.unlinkSync(productBlobPath(paths, product, name));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export function readCurrentPointers(paths: RegistryPaths): CurrentPointers {
  ensureCredentialRegistry(paths);
  const fromJson = readCurrentJsonFile(paths);
  if (fromJson) return fromJson;
  return { core: readCurrentCoreFromTxtOnly(paths), search: null };
}

export function writeCurrentPointers(paths: RegistryPaths, pointers: CurrentPointers): void {
  fs.mkdirSync(paths.root, { recursive: true, mode: REGISTRY_DIR_MODE });
  fs.writeFileSync(paths.currentJson, `${JSON.stringify(pointers, null, 2)}\n`, { mode: BLOB_FILE_MODE });
  if (pointers.core) {
    fs.writeFileSync(paths.currentPointer, `${pointers.core}\n`, { mode: BLOB_FILE_MODE });
  }
}

/**
 * The `current` Core name, or null when nothing is selected.
 *
 * Reads current.json first. When it names no usable Core — absent, empty, malformed, or a Core that
 * has since been removed — it falls back to current.txt, the pointer Control's CLI writes (see the
 * header). A name that is neither usable in the JSON nor in the text file is "nothing selected".
 */
export function readCurrentCore(paths: RegistryPaths): string | null {
  ensureCredentialRegistry(paths);
  return usableCoreName(paths, readCurrentJsonFile(paths)?.core) ?? readCurrentCoreFromTxtOnly(paths);
}

/** The name when it is a valid Core name and a Core is registered under it, else null. */
function usableCoreName(paths: RegistryPaths, name: string | null | undefined): string | null {
  if (!name || coreNameError(name) !== null) return null;
  return coreExists(paths, name) ? name : null;
}

export function readCurrentSearch(paths: RegistryPaths): string | null {
  ensureCredentialRegistry(paths);
  const pointers = readCurrentJsonFile(paths);
  const fromJson = pointers?.search ?? null;
  if (fromJson && searchExists(paths, fromJson)) return fromJson;

  const legacy = readLegacyCliConfig(paths.legacySearchCliJson);
  const fallback = legacy.defaultProfile;
  if (fallback && legacy.profiles[fallback]?.blob) return fallback;
  return null;
}

function readCurrentCoreFromTxtOnly(paths: RegistryPaths): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.currentPointer, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const name = raw.trim();
  if (!name || coreNameError(name) !== null) return null;
  return coreExists(paths, name) ? name : null;
}

export function writeCurrentCore(paths: RegistryPaths, name: string): void {
  const pointers = readCurrentJsonFile(paths) ?? { core: null, search: null };
  pointers.core = name;
  writeCurrentPointers(paths, pointers);
}

export function writeCurrentSearch(paths: RegistryPaths, name: string): void {
  const pointers = readCurrentJsonFile(paths) ?? { core: null, search: null };
  pointers.search = name;
  writeCurrentPointers(paths, pointers);
}

export function clearCurrentCore(paths: RegistryPaths): void {
  const pointers = readCurrentJsonFile(paths) ?? { core: null, search: null };
  pointers.core = null;
  writeCurrentPointers(paths, pointers);
  try {
    fs.unlinkSync(paths.currentPointer);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function clearCurrentSearch(paths: RegistryPaths): void {
  const pointers = readCurrentJsonFile(paths) ?? { core: null, search: null };
  pointers.search = null;
  writeCurrentPointers(paths, pointers);
}

export function readRegisteredCore(paths: RegistryPaths, name: string, current: string | null): RegisteredCore {
  const text = readCoreBlobText(paths, name);
  const row: RegisteredCore = {
    name,
    current: current === name,
    summary: null,
    error: null,
    insecureMode: false,
  };
  try {
    const mode = fs.statSync(coreBlobPath(paths, name)).mode & 0o777;
    row.insecureMode = (mode & 0o077) !== 0;
  } catch {
    // A file that vanished between the listing and the stat is not a mode problem.
  }
  const nameError = coreNameError(name);
  if (nameError !== null) {
    row.error = `not a usable Core name (${nameError}) — rename ${name}.txt to reach it`;
    return row;
  }
  if (text === null) {
    row.error = "no blob stored for this Core";
    return row;
  }
  const decoded = decodeRegistrationBlobText(text, "wss://");
  if (!decoded.ok) {
    row.error = decoded.error;
    return row;
  }
  row.summary = summarizeBlob(decoded.blob);
  return row;
}

export function readRegistry(paths: RegistryPaths): RegisteredCore[] {
  const current = readCurrentCore(paths);
  return listCoreNames(paths).map((name) => readRegisteredCore(paths, name, current));
}

export function readRegisteredSearch(
  paths: RegistryPaths,
  name: string,
  current: string | null,
): RegisteredSearch {
  const text = readSearchBlobText(paths, name);
  const row: RegisteredSearch = {
    name,
    current: current === name,
    summary: null,
    error: null,
    insecureMode: false,
  };
  const blobPath = productBlobPath(paths, "search", name);
  try {
    if (fs.existsSync(blobPath)) {
      const mode = fs.statSync(blobPath).mode & 0o777;
      row.insecureMode = (mode & 0o077) !== 0;
    }
  } catch {
    // A file that vanished between the listing and the stat is not a mode problem.
  }
  const nameError = searchNameError(name);
  if (nameError !== null) {
    row.error = `not a usable Search name (${nameError}) — rename ${name}.txt to reach it`;
    return row;
  }
  if (text === null) {
    row.error = "no blob stored for this Search instance";
    return row;
  }
  const decoded = decodeRegistrationBlobText(text, "https://");
  if (!decoded.ok) {
    row.error = decoded.error;
    return row;
  }
  row.summary = summarizeBlob(decoded.blob);
  return row;
}

export function readSearchRegistry(paths: RegistryPaths): RegisteredSearch[] {
  const current = readCurrentSearch(paths);
  return listSearchNames(paths).map((name) => readRegisteredSearch(paths, name, current));
}

export function listUsableSearchNames(paths: RegistryPaths): string[] {
  return listSearchNames(paths).filter((name) => searchNameError(name) === null);
}

export function loadCoreBlob(
  paths: RegistryPaths,
  name: string,
): { ok: true; blob: RegistrationBlob } | { ok: false; error: string } {
  const text = readCoreBlobText(paths, name);
  if (text === null) {
    return { ok: false, error: `no Core named ${name} — \`actana core ls\` lists what this machine knows` };
  }
  const decoded = decodeRegistrationBlobText(text, "wss://");
  if (!decoded.ok) {
    return { ok: false, error: `the stored blob for ${name} is unusable: ${decoded.error}` };
  }
  return { ok: true, blob: decoded.blob };
}

export function loadSearchBlob(
  paths: RegistryPaths,
  name: string,
): { ok: true; blob: RegistrationBlob } | { ok: false; error: string } {
  const text = readSearchBlobText(paths, name);
  if (text === null) {
    return { ok: false, error: `no Search instance named ${name} — \`actana search ls\` lists what this machine knows` };
  }
  const decoded = decodeRegistrationBlobText(text, "https://");
  if (!decoded.ok) {
    return { ok: false, error: `the stored blob for ${name} is unusable: ${decoded.error}` };
  }
  return { ok: true, blob: decoded.blob };
}

/**
 * Redact credential material from text that may reach `--verbose` output.
 *
 * Strips base64 blobs, PEM blocks, and bearer tokens rather than echoing them.
 */
export function redactCredentialSecrets(text: string): string {
  let out = text;
  out = out.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, REDACTED);
  out = out.replace(/\bbearer[-\w.]*\.[\w.-]+\b/gi, REDACTED);
  out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, REDACTED);
  return out;
}

/** Format a verbose registry line that never carries credential bytes. */
export function verboseRegistryDetail(message: string, context: { path?: string; blobText?: string } = {}): string {
  const parts = [message];
  if (context.path) parts.push(`at ${context.path}`);
  return redactCredentialSecrets(parts.join(", "));
}

function importLegacySearchProfiles(paths: RegistryPaths): void {
  if (listSearchNames(paths).length > 0) return;
  const legacy = readLegacyCliConfig(paths.legacySearchCliJson);
  const names = Object.keys(legacy.profiles);
  if (names.length === 0) return;
  for (const name of names) {
    const profile = legacy.profiles[name]!;
    if (!profile.blob) continue;
    writeSearchBlob(paths, name, profile.blob);
  }
}

function syncCurrentJsonFromLegacy(paths: RegistryPaths): void {
  const existing = readCurrentJsonFile(paths);
  // The JSON's Core when it still names one, else the text pointer's — the same order as
  // `readCurrentCore`, so the file this writes never disagrees with what a read answers.
  const core = usableCoreName(paths, existing?.core) ?? readCurrentCoreFromTxtOnly(paths) ?? existing?.core ?? null;
  const legacy = readLegacyCliConfig(paths.legacySearchCliJson);
  const search =
    existing?.search ??
    (legacy.defaultProfile && legacy.profiles[legacy.defaultProfile] ? legacy.defaultProfile : null);

  if (!core && !search) return;
  if (existing && existing.core === core && existing.search === search) return;
  writeCurrentPointers(paths, { core, search });
}

function readCurrentJsonFile(paths: RegistryPaths): CurrentPointers | null {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.currentJson, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const core = typeof o.core === "string" && o.core ? o.core : null;
  const search = typeof o.search === "string" && o.search ? o.search : null;
  return { core, search };
}

function readLegacyCliConfig(configPath: string): LegacyCliConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return { defaultProfile: "default", profiles: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { defaultProfile: "default", profiles: {} };
  }
  if (!parsed || typeof parsed !== "object") return { defaultProfile: "default", profiles: {} };
  const o = parsed as Record<string, unknown>;
  const profiles: Record<string, LegacyCliProfile> = {};
  if (o.profiles && typeof o.profiles === "object") {
    for (const [name, value] of Object.entries(o.profiles as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const p = value as Record<string, unknown>;
      if (typeof p.blob !== "string" || typeof p.endpoint !== "string") continue;
      profiles[name] = {
        blob: p.blob,
        endpoint: p.endpoint,
        ...(typeof p.label === "string" ? { label: p.label } : {}),
      };
    }
  }
  const defaultProfile =
    typeof o.defaultProfile === "string" && o.defaultProfile ? o.defaultProfile : "default";
  return { defaultProfile, profiles };
}

function decodeRegistrationBlobText(raw: string, endpointPrefix: "wss://" | "https://"): BlobDecodeResult {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: false, error: "the blob is empty" };

  const compact = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return { ok: false, error: "the blob is not base64" };
  }
  const json = Buffer.from(compact, "base64").toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      error: "the stored credential does not decode to JSON — the file may be truncated",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "the blob decodes to JSON that is not an object" };
  }

  const o = parsed as Record<string, unknown>;
  const missing = (["endpoint", "caCert", "clientCert", "clientKey", "bearer"] as const).filter(
    (field) => typeof o[field] !== "string" || (o[field] as string).length === 0,
  );
  if (missing.length > 0) {
    return { ok: false, error: `the blob is missing ${missing.join(", ")}` };
  }

  const endpoint = o.endpoint as string;
  if (!endpoint.startsWith(endpointPrefix)) {
    return {
      ok: false,
      error: `the blob's endpoint is not ${endpointPrefix} — mTLS is required`,
    };
  }

  const label = typeof o.label === "string" ? o.label : "";
  return {
    ok: true,
    blob: {
      endpoint,
      label,
      caCert: o.caCert as string,
      clientCert: o.clientCert as string,
      clientKey: o.clientKey as string,
      bearer: o.bearer as string,
    },
  };
}

function summarizeBlob(blob: RegistrationBlob): BlobSummary {
  return { endpoint: blob.endpoint, label: blob.label ?? "" };
}
