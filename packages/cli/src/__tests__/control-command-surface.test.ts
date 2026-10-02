// The client command surface, row by row, against what Control's CLI answers (actana/client#11).
//
// Control's `packages/cli` at `feat/0.5.0` ships these nouns inside `actana`, and Control's own
// `command-surface.test.ts` (actana/control#580, T-403) pins what every row answers: the exit code, a
// prefix of the first stderr line and, where the command prints, the first stdout line. The rows
// that belong to the client are carried across so the next drift from Control fails here, in the
// client's CI, before it is bound into a Core. Machine verbs (`install`, `setup`, `status`, `pair`,
// `daemon`, ...) are Control's alone and are not here. The `files` and `shared` nouns are the
// client's own and have their own suites.
//
// Where the client says something different on purpose, the row says so instead of being dropped.

import { describe, it, expect, afterEach } from "vitest";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";

type Row = readonly [argv: string[], code: number, errPrefix: string, outPrefix: string];

let fixture: CliFixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

async function run(argv: string[]) {
  fixture = makeCliFixture();
  const r = await fixture.run(argv);
  return { code: r.code, err: r.err.join("\n"), out: r.out.join("\n") };
}

const SURFACE: Row[] = [
  [["core","pair"], 2, "actana core pair: a name, an address and a code are required", ""],
  [["core","ls"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","list"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","use"], 2, "actana core use: a name is required — `actana core use <name", ""],
  [["core","rm"], 2, "actana core rm: a name is required — `actana core rm <name>`", ""],
  [["core","remove"], 2, "actana core rm: a name is required — `actana core rm <name>`", ""],
  [["core","status"], 1, "actana core status: no Core selected. Pass --core <name>, se", ""],
  [["core","shell"], 2, "actana core shell: this is an interactive command and stdin/", ""],
  [["core","exec"], 2, "actana core exec: a command is required — `actana core exec ", ""],
  [["core","bogus"], 2, "actana core: unknown verb \"bogus\".", ""],
  [["harness","ls"], 1, "actana harness ls: no Core selected. Pass --core <name>, set", ""],
  [["harness","list"], 1, "actana harness ls: no Core selected. Pass --core <name>, set", ""],
  [["harness","install"], 2, "actana harness install: a Harness id is required —", ""],
  [["harness","skills"], 0, "No Harness of the four this build knows has a directory in t", "HARNESS      RESULT  SKILL FOLDER"],
  [["harness","bogus"], 2, "actana harness: unknown verb \"bogus\".", ""],
  [["events","tail"], 1, "actana events tail: no Core selected. Pass --core <name>, se", ""],
  [["events","bogus"], 2, "actana events: unknown verb \"bogus\".", ""],
  [["session","start"], 1, "actana session start: no Core selected. Pass --core <name>, ", ""],
  [["session","ls"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","list"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","logs"], 2, "actana session logs: a session id is required — `actana sess", ""],
  [["session","resume"], 2, "actana session resume: a session id is required — `actana se", ""],
  [["session","send"], 2, "actana session send: a session id is required — `actana sess", ""],
  [["session","wait"], 2, "actana session wait: a session id is required — `actana sess", ""],
  [["session","kill"], 2, "actana session kill: a session id is required — `actana sess", ""],
  [["session","attach"], 2, "actana session attach: a session id is required — `actana se", ""],
  [["session","bogus"], 2, "actana session: unknown verb \"bogus\".", ""],
  [["bogus"], 2, "actana: unknown command \"bogus\".", ""],
  [["session","ls","--json"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--verbose"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--sha256"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--wait"], 2, "actana session ls: --wait does not apply here.", ""],
  [["session","ls","--await-prompt"], 2, "actana session ls: --await-prompt does not apply here.", ""],
  [["session","ls","--raw"], 2, "actana session ls: --raw does not apply here.", ""],
  [["session","ls","--enter"], 2, "actana session ls: --enter does not apply here.", ""],
  [["session","ls","--no-enter"], 2, "actana session ls: --no-enter does not apply here.", ""],
  [["session","ls","--dangerously-skip-permissions"], 2, "actana session ls: --dangerously-skip-permissions does not a", ""],
  [["session","ls","--read-only"], 2, "actana session ls: --read-only does not apply here.", ""],
  [["session","ls","-h"], 0, "", "actana session — the Sessions running on a Core"],
  [["session","ls","--help"], 0, "", "actana session — the Sessions running on a Core"],
  [["session","ls","-V"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--version"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--bogus"], 2, "actana: unknown flag --bogus.", ""],
  [["core","ls","--core","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--since","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--kind","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--limit","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--depth","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--wait-timeout","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--harness","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--cwd","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--title","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--fingerprint","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--session","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--label","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--core"], 2, "actana: --core needs a value.", ""],
  [["core","ls","--since"], 2, "actana: --since needs a value.", ""],
  [["core","ls","--kind"], 2, "actana: --kind needs a value.", ""],
  [["core","ls","--limit"], 2, "actana: --limit needs a value.", ""],
  [["core","ls","--depth"], 2, "actana: --depth needs a value.", ""],
  [["core","ls","--wait-timeout"], 2, "actana: --wait-timeout needs a value.", ""],
  [["core","ls","--harness"], 2, "actana: --harness needs a value.", ""],
  [["core","ls","--cwd"], 2, "actana: --cwd needs a value.", ""],
  [["core","ls","--title"], 2, "actana: --title needs a value.", ""],
  [["core","ls","--fingerprint"], 2, "actana: --fingerprint needs a value.", ""],
  [["core","ls","--session"], 2, "actana: --session needs a value.", ""],
  [["core","ls","--label"], 2, "actana: --label needs a value.", ""],
  [["--json","core","ls"], 0, "", "[]"],
  [["core","ls","--json"], 0, "", "[]"],
];

describe("the client command surface matches Control's", () => {
  it.each(SURFACE.map((r) => [r[0].join(" "), r] as const))("%s", async (_name, row) => {
    const [argv, code, errPrefix, outPrefix] = row;
    const got = await run(argv);
    expect(got.code).toBe(code);
    if (errPrefix === "") {
      // Silent on stderr in Control: a new warning there is a change a script reading it can see.
      if (code === 0) expect(got.err).toBe("");
    } else {
      expect(got.err).toContain(errPrefix);
    }
    if (outPrefix !== "") expect(got.out).toContain(outPrefix);
  });

  // ticket 211: a flag that is accepted and then not sent is the one answer a flag must never get.
  // `--model` and the other flags only `search` takes are unknown on every other noun.
  it.each([
    ["--model", "composer-2.5"],
    ["--search", "kb"],
    ["--external-id", "e1"],
    ["--provider", "p"],
    ["--template", "t"],
    ["--dimensions", "8"],
    ["--base-url", "http://x"],
    ["--top-k", "3"],
    ["--keyword-weight", "0.5"],
    ["--key-stdin"],
  ])("refuses %s on a Core noun as an unknown flag", async (...flag) => {
    for (const argv of [
      ["session", "start", "web", "go", ...flag],
      ["session", "ls", ...flag],
      ["core", "ls", ...flag],
      ["events", "tail", ...flag],
    ]) {
      const got = await run(argv);
      expect(got.code, argv.join(" ")).toBe(2);
      expect(got.err, argv.join(" ")).toContain(`unknown flag ${flag[0]}`);
    }
  });
});
