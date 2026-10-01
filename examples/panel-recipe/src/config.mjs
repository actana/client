// Every endpoint, credential and path the recipe uses comes from here: an argument first, else an
// environment variable, else (for a few settings with a harmless default) the default named below.
// Nothing is hard-coded and nothing is read from the repository. A missing setting is a UsageError
// that names the variable, never its value.
import { parseArgs } from "node:util";
import { UsageError } from "./errors.mjs";

export const COMMANDS = ["pair", "attach", "session", "task", "all"];

/** Every setting, for the README and for `--help`: [environment variable, argument, what it is]. */
export const SETTINGS = [
  ["ACTANA_CORE_ADDRESS", "--address", "step 1: the Core to pair with, host:port"],
  ["ACTANA_PAIRING_CODE", "--code", "step 1: the one-time code, as <session>:<code>"],
  ["ACTANA_CA_FINGERPRINT", "--fingerprint", "step 1: the Core's CA fingerprint, read out by the operator"],
  ["ACTANA_BLOB_OUT", "--out", "step 1: where to write the registration blob (mode 0600)"],
  ["ACTANA_CORE_BLOB", "--blob", "steps 2-4: the registration blob, or a path to the file holding it"],
  ["SEAWEEDFS_ENDPOINT", "--s3-endpoint", "steps 2-4: the S3 gateway the controller reaches (also serves STS)"],
  ["SEAWEEDFS_CORE_ENDPOINT", "--core-s3-endpoint", "step 2: the same gateway as the Core reaches it (default: SEAWEEDFS_ENDPOINT)"],
  ["SEAWEEDFS_OIDC_ISSUER", "--oidc-issuer", "steps 2-4: must equal SeaweedFS's configured OIDC issuer"],
  ["SEAWEEDFS_OIDC_AUDIENCE", "--oidc-audience", "steps 2-4: must equal SeaweedFS's configured audience"],
  ["SEAWEEDFS_SIGNING_KEY_FILE", "--signing-key-file", "steps 2-4: the controller's RSA private key (PEM); the master key"],
  ["SEAWEEDFS_KEY_ID", "--key-id", "steps 2-4: the kid its public key has in the JWKS"],
  ["SEAWEEDFS_BUCKET", "--bucket", "steps 2-4: the bucket the Shared folders live in"],
  ["SEAWEEDFS_PREFIX", "--prefix", "steps 2-4: the folder of Cores in the bucket; a Core gets <prefix>/<core-id>/"],
  ["SEAWEEDFS_REGION", "--region", "step 2: the region sent to the Core (default us-east-1)"],
  ["SEAWEEDFS_JWKS_PORT", "--jwks-port", "step 2: serve the JWKS on 127.0.0.1:<port> while running (optional)"],
  ["ACTANA_HARNESS", "--harness", "steps 3-4: the harness to run (default claude-code)"],
  ["ACTANA_SKIP_PERMISSIONS", "--skip-permissions", "steps 3-4: 1 starts the harness with permission prompts off"],
  ["ACTANA_TIMEOUT_MS", "--timeout-ms", "steps 3-4: how long to wait for the report (default 300000 / 3600000)"],
  ["ACTANA_POLL_MS", "--poll-ms", "steps 3-4: how often to look at the Shared folder (default 2000)"],
  ["ACTANA_EXIT_GRACE_MS", "--exit-grace-ms", "steps 3-4: how long to keep looking after the harness exits (default 30000)"],
];

const OPTIONS = Object.fromEntries(
  [...SETTINGS.map(([, flag]) => flag.slice(2)), "task-id", "task-title", "task-description", "attempt", "keep-fresh", "help"].map((name) => [
    name,
    { type: name === "keep-fresh" || name === "help" || name === "skip-permissions" ? "boolean" : "string" },
  ]),
);

export function usage() {
  const width = Math.max(...SETTINGS.map(([env]) => env.length));
  return [
    "usage: node examples/panel-recipe/recipe.mjs <pair|attach|session|task|all> [prompt] [options]",
    "",
    "  pair      step 1: pair a Core, write the registration blob",
    "  attach    step 2: attach the Core's Shared folder with a key issuer (--keep-fresh stays running)",
    "  session   step 3: start a Session with [prompt] and wait for its report",
    "  task      step 4: dispatch a Task (--task-id, --task-title, --task-description, --attempt) and report its status",
    "  all       steps 1-4 in order (step 1 only when no blob is set)",
    "",
    "Every setting is an argument or an environment variable; the argument wins:",
    ...SETTINGS.map(([env, flag, what]) => `  ${env.padEnd(width)}  ${flag.padEnd(20)} ${what}`),
  ].join("\n");
}

/** Parse the command line and environment into one settings object. Throws UsageError. */
export function readConfig(argv, env) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(`${err.message}\n\n${usage()}`);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const [command, ...rest] = positionals;
  if (!COMMANDS.includes(command ?? "")) {
    throw new UsageError(`expected one of ${COMMANDS.join(", ")}, got ${command === undefined ? "nothing" : JSON.stringify(command)}\n\n${usage()}`);
  }

  const setting = (envName, flag) => {
    const fromArg = values[flag.slice(2)];
    const value = fromArg ?? env[envName];
    return value === undefined || value === "" ? undefined : value;
  };
  const byEnv = Object.fromEntries(SETTINGS.map(([envName, flag]) => [envName, setting(envName, flag)]));
  const need = (envName) => {
    const value = byEnv[envName];
    if (value === undefined) {
      const flag = SETTINGS.find(([name]) => name === envName)[1];
      throw new UsageError(`set ${envName} (or pass ${flag})`);
    }
    return value;
  };
  const positiveInt = (envName, fallback) => {
    const raw = byEnv[envName];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`${envName} must be a positive whole number of milliseconds`);
    return n;
  };

  const config = {
    command,
    prompt: rest.join(" ") || undefined,
    keepFresh: values["keep-fresh"] === true,
    harness: byEnv.ACTANA_HARNESS ?? "claude-code",
    dangerouslySkipPermissions: values["skip-permissions"] === true || env.ACTANA_SKIP_PERMISSIONS === "1",
    timeoutMs: byEnv.ACTANA_TIMEOUT_MS === undefined ? undefined : positiveInt("ACTANA_TIMEOUT_MS"),
    pollMs: byEnv.ACTANA_POLL_MS === undefined ? undefined : positiveInt("ACTANA_POLL_MS"),
    exitGraceMs: byEnv.ACTANA_EXIT_GRACE_MS === undefined ? undefined : positiveInt("ACTANA_EXIT_GRACE_MS"),
    task: {
      id: values["task-id"],
      title: values["task-title"],
      description: values["task-description"],
      attempt: values.attempt === undefined ? 1 : Number(values.attempt),
    },
    /** Each is read on demand, so a command asks only for the settings it uses. */
    pairing: () => ({
      address: need("ACTANA_CORE_ADDRESS"),
      code: need("ACTANA_PAIRING_CODE"),
      fingerprint: need("ACTANA_CA_FINGERPRINT"),
      out: need("ACTANA_BLOB_OUT"),
    }),
    blobSource: byEnv.ACTANA_CORE_BLOB,
    blobOut: byEnv.ACTANA_BLOB_OUT,
    blob: () => need("ACTANA_CORE_BLOB"),
    seaweedfs: () => ({
      endpoint: need("SEAWEEDFS_ENDPOINT"),
      coreEndpoint: byEnv.SEAWEEDFS_CORE_ENDPOINT,
      oidcIssuer: need("SEAWEEDFS_OIDC_ISSUER"),
      oidcAudience: need("SEAWEEDFS_OIDC_AUDIENCE"),
      signingKeyFile: need("SEAWEEDFS_SIGNING_KEY_FILE"),
      keyId: need("SEAWEEDFS_KEY_ID"),
      bucket: need("SEAWEEDFS_BUCKET"),
      prefix: need("SEAWEEDFS_PREFIX"),
      region: byEnv.SEAWEEDFS_REGION,
      jwksPort: byEnv.SEAWEEDFS_JWKS_PORT === undefined ? undefined : positiveInt("SEAWEEDFS_JWKS_PORT"),
    }),
  };
  if (!Number.isSafeInteger(config.task.attempt) || config.task.attempt < 1) throw new UsageError("--attempt must be a whole number from 1");
  return config;
}
