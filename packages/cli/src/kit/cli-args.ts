// Flag parsing.
//
// Small on purpose, and hand-written rather than a dependency: a published CLI
// whose only runtime dependency is the SDK is a CLI whose install is one
// package deep, and the flag surface #129 D10 describes is a dozen booleans and
// two values. The moment that stops being true the trade changes; it is not
// true yet.
//
// Flags may appear before or after positionals — `actana core ls --json` and
// `actana --json core ls` both work — because a person who has just been told
// the flag exists will type it wherever they are looking. `--` ends flag
// parsing, so a value that starts with a dash can still be passed.

/** Global flags plus whatever was left over. */
export type ParsedArgs = {
  /** The nouns and verbs, in order, with flags removed. */
  positionals: string[];
  /** `--json`: machine-readable output. */
  json: boolean;
  /** `--verbose`: explain the steps. Never prints credentials — see the CLI header. */
  verbose: boolean;
  /** `-h` / `--help`. */
  help: boolean;
  /** `-V` / `--version`. */
  version: boolean;
  /** `--core <name>`, or null when the flag was absent. */
  core: string | null;
  /** `--search <name>`, or null when the flag was absent. */
  search: string | null;
  /** `--external-id <id>` — stable endpoint id for `search endpoint add`. */
  externalId: string | null;
  /** `--provider <id>` — catalog provider for `search endpoint add`. */
  provider: string | null;
  /** `--template <id>` — request shape for `search endpoint add`. */
  template: string | null;
  /** `--model <name>` — provider-side model for `search endpoint add`. */
  model: string | null;
  /** `--dimensions <n>` — vector width for an embedding endpoint. Raw. */
  dimensions: string | null;
  /** `--base-url <url>` — OpenAI-compatible base URL override. */
  baseUrl: string | null;
  /** `--top-k <n>` — how many query matches to return. Raw. */
  topK: string | null;
  /** `--keyword-weight <0..1>` — keyword score weight for `search query`. Raw. */
  keywordWeight: string | null;
  /** `--key-stdin` — read a provider key from stdin (`search endpoint add`). */
  keyStdin: boolean;
  /**
   * `--since <eventId>` — where `events tail` starts, overriding the stored
   * cursor. Kept as the raw string: "what the operator typed" and "a number" are
   * different things, and the verb that reads it is the one that can say what a
   * bad value means (`--since start` is a word, not a number).
   */
  since: string | null;
  /** `--kind <k>`, repeatable — the event kinds `events tail` prints. Empty means all. */
  kind: string[];
  /** `--limit <n>` — stop after this many rows. Raw, for the same reason as `since`. */
  limit: string | null;
  // ─── `files ls`'s flags (#10) ───
  /**
   * `--depth <n>` — how far `files ls` descends. Raw, like `--limit`: the
   * verb that reads it is the one that can say what `--depth all` means.
   */
  depth: string | null;
  /**
   * `--sha256`: ask the Core to digest every file in a listing.
   *
   * Off by default and not free — a listing has no bytes in hand, so a digest
   * means reading every one of them (ADR 0027 D6). A flag rather than always-on
   * for that reason alone.
   */
  sha256: boolean;
  // ─── The `session` noun's flags (#160) ───
  /** `--wait`: block until the Core reports a started Session settled. */
  wait: boolean;
  /** `--wait-timeout <seconds>`, unparsed — the verb decides what a bad value means. */
  waitTimeout: string | null;
  /**
   * `--await-prompt`: block until the Core says whether the starting prompt reached the harness
   * (#395 on Control).
   *
   * Shorter than `--wait`, and a different question: `--wait` waits for the turn to end, this waits
   * only for the Session to become able to take a `send`. Nothing in this package times it — the wait
   * ends on the Core's own report.
   */
  awaitPrompt: boolean;
  /** `--turn <n>`, unparsed: which turn's report `session send` / `session wait` means. */
  turn: string | null;
  /** `--harness <name>`, or null to take the default harness. */
  harness: string | null;
  /** `--cwd <path>`: a directory on the **Core's** machine. */
  cwd: string | null;
  /** `--title <text>`: what a started Session is called in a listing. */
  title: string | null;
  /** `--raw`: hand over bytes rather than a rendered screen. */
  raw: boolean;
  /** `--no-block`: `session send` types the text as given: no report block, no turn. */
  noBlock: boolean;
  /**
   * `--no-enter`: type the text and send no carriage return after it (Control #404).
   *
   * A `send` presses Enter by default; this is the opt-out, for filling a composer or answering the
   * numbered option of a dialog before the return that confirms it.
   */
  noEnter: boolean;
  /** `--enter`: follow sent text with a carriage return, because the operator asked. */
  enter: boolean;
  /** `--dangerously-skip-permissions`: start the harness without permission prompts. */
  skipPermissions: boolean;
  // ─── `core pair`'s flags (#285) ───
  /**
   * `--fingerprint <sha256>` — the CA fingerprint the operator was read out by
   * `actana pair new`, in any form a human copies it in.
   *
   * Raw, like `--since` and `--limit`: what shape a fingerprint has is the
   * SDK's business, and the verb that hands it over is the one that can say
   * what a bad one means without this parser mirroring a format it does not
   * own.
   */
  fingerprint: string | null;
  /**
   * `--session <id>` — the pairing session the code belongs to, when the code
   * the operator was given does not already carry it as `<session>:<XXXX-XXXX>`.
   *
   * A code names a session and the Core will not go looking for which one
   * (#282), so one of the two spellings has to supply it.
   */
  session: string | null;
  /** `--label <name>` — what this machine calls itself in the Core's `pair ls`. */
  label: string | null;
  /**
   * `--read-only`: attach without claiming the Session's write lock (#163).
   *
   * A Session starts unlocked and its creator gets no privilege (ADR 0024 D5),
   * so an ordinary `attach` on a Session nobody has claimed takes the lock — and
   * an operator who only meant to watch an automation would take it from the
   * automation that was about to. This is how they say "watch, do not take".
   */
  readOnly: boolean;
  /** Flags this build does not know, in the order they appeared. */
  unknown: string[];
  /** A flag that takes a value and was given none, or null. */
  missingValue: string | null;
};

/** Flags that take a value. */
const VALUE_FLAGS = new Set([
  "--core",
  "--search",
  "--since",
  "--kind",
  "--limit",
  "--depth",
  "--wait-timeout",
  "--turn",
  "--harness",
  "--cwd",
  "--title",
  "--fingerprint",
  "--session",
  "--label",
  "--external-id",
  "--provider",
  "--template",
  "--model",
  "--dimensions",
  "--base-url",
  "--top-k",
  "--keyword-weight",
]);

/** Parse `process.argv.slice(2)`. Never throws; malformed input is reported in the result. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    json: false,
    verbose: false,
    help: false,
    version: false,
    core: null,
    search: null,
    externalId: null,
    provider: null,
    template: null,
    model: null,
    dimensions: null,
    baseUrl: null,
    topK: null,
    keywordWeight: null,
    keyStdin: false,
    since: null,
    kind: [],
    limit: null,
    depth: null,
    sha256: false,
    wait: false,
    awaitPrompt: false,
    waitTimeout: null,
    turn: null,
    harness: null,
    cwd: null,
    title: null,
    fingerprint: null,
    session: null,
    label: null,
    raw: false,
    noBlock: false,
    noEnter: false,
    enter: false,
    skipPermissions: false,
    readOnly: false,
    unknown: [],
    missingValue: null,
  };

  let flagsEnded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (flagsEnded || arg === "-" || !arg.startsWith("-")) {
      // A bare `-` is a positional: it is the conventional name for stdin, and
      // `actana files put - notes.md` is a sentence somebody will type.
      parsed.positionals.push(arg);
      continue;
    }

    if (arg === "--") {
      flagsEnded = true;
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue ?? argv[++i] ?? null;
      if (value === null || value === "") {
        parsed.missingValue ??= name;
        continue;
      }
      if (name === "--core") parsed.core = value;
      else if (name === "--search") parsed.search = value;
      else if (name === "--since") parsed.since = value;
      else if (name === "--external-id") parsed.externalId = value;
      else if (name === "--provider") parsed.provider = value;
      else if (name === "--template") parsed.template = value;
      else if (name === "--model") parsed.model = value;
      else if (name === "--dimensions") parsed.dimensions = value;
      else if (name === "--base-url") parsed.baseUrl = value;
      else if (name === "--top-k") parsed.topK = value;
      else if (name === "--keyword-weight") parsed.keywordWeight = value;
      // Repeatable, unlike the other three: `--kind session:created --kind
      // pty:exit` is a filter somebody will build up, and the alternative — one
      // comma-joined string — puts a second syntax inside a flag value.
      else if (name === "--kind") parsed.kind.push(value);
      else if (name === "--limit") parsed.limit = value;
      else if (name === "--depth") parsed.depth = value;
      else if (name === "--wait-timeout") parsed.waitTimeout = value;
      else if (name === "--turn") parsed.turn = value;
      else if (name === "--harness") parsed.harness = value;
      else if (name === "--cwd") parsed.cwd = value;
      else if (name === "--title") parsed.title = value;
      else if (name === "--fingerprint") parsed.fingerprint = value;
      else if (name === "--session") parsed.session = value;
      else if (name === "--label") parsed.label = value;
      continue;
    }

    switch (name) {
      case "--json":
        parsed.json = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--sha256":
        parsed.sha256 = true;
        break;
      case "--wait":
        parsed.wait = true;
        break;
      case "--await-prompt":
        parsed.awaitPrompt = true;
        break;
      case "--no-block":
        parsed.noBlock = true;
        break;
      case "--no-enter":
        parsed.noEnter = true;
        break;
      case "--raw":
        parsed.raw = true;
        break;
      case "--enter":
        parsed.enter = true;
        break;
      case "--dangerously-skip-permissions":
        parsed.skipPermissions = true;
        break;
      case "--read-only":
        parsed.readOnly = true;
        break;
      case "--key-stdin":
        parsed.keyStdin = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "-V":
      case "--version":
        parsed.version = true;
        break;
      default:
        parsed.unknown.push(name);
    }
  }

  return parsed;
}

/** A positive integer flag, or the reason it is not one. */
export function parseInteger(raw: string, what: string): { value: number } | { error: string } {
  if (!/^\d+$/.test(raw.trim())) {
    return { error: `${what} has to be a whole number — "${raw}" is not` };
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (value <= 0) return { error: `${what} has to be more than zero` };
  return { value };
}

/** A number between 0 and 1, or the reason it is not one. */
export function parseFraction(raw: string, what: string): { value: number } | { error: string } {
  const value = Number.parseFloat(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return { error: `${what} is a number between 0 and 1 — "${raw}" is not` };
  }
  return { value };
}
