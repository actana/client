import { describe, expect, it, afterEach } from "vitest";
import {
  CLI_VERSION,
  NOT_HANDLED,
  clientHelp,
  runClient,
} from "../run-client.ts";
import { EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";
import {
  fakePairing,
  healthyProbe,
  makeCliFixture,
  registerCore,
  SENTINELS,
  type CliFixture,
} from "./cli-harness.ts";
import { nonInteractiveTerminal } from "../kit/cli-terminal.ts";
import type { ClientDeps } from "../kit/cli-deps.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

function baseDeps(f: CliFixture, argv: string[], out: string[], err: string[]): ClientDeps {
  const verboseOn = argv.includes("--verbose");
  return {
    argv,
    env: { XDG_CONFIG_HOME: f.configHome },
    home: f.home,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    outBytes: (chunk) => out.push(chunk),
    errBytes: (chunk) => err.push(chunk),
    verbose: verboseOn
      ? (line) => {
          err.push(`actana: ${line}`);
        }
      : () => {},
    readStdin: async () => "",
    stdinIsTty: false,
    stdoutIsTty: false,
    probe: healthyProbe(),
    connect: async () => {
      throw new Error("unexpected connect");
    },
    pairing: fakePairing(),
    openSessions: async () => {
      throw new Error("unexpected sessions");
    },
    openFiles: async () => {
      throw new Error("unexpected files");
    },
    now: () => Date.now(),
    terminal: nonInteractiveTerminal(() => {}),
    openShell: async () => {
      throw new Error("unexpected shell");
    },
    openAttach: async () => {
      throw new Error("unexpected attach");
    },
    hostname: "vm-1",
    platform: "linux",
    interactive: false,
    system: { confirm: async () => false },
  };
}

describe("runClient dispatcher", () => {
  it("exports NOT_HANDLED and clientHelp from the package surface", () => {
    expect(typeof NOT_HANDLED).toBe("symbol");
    expect(clientHelp()).toContain("Cores");
    expect(clientHelp()).toContain("Search");
  });

  it("--help matches page 05 structure", async () => {
    const run = await cli().run(["--help"]);
    expect(run.code).toBe(EXIT_OK);
    const text = run.out.join("\n");
    expect(text).toContain("actana — reach your Cores and Search instances");
    expect(text).toContain("Cores");
    expect(text).toContain("core       pair, ls, use, rm, status, shell, exec");
    expect(text).toContain("Search");
    expect(text).toContain("search     pair, ls, use, rm, status, kb, ingest, query, endpoint");
    expect(text).toContain("Flags");
    expect(text).toContain("--core <name>");
    expect(text).toContain("--search <name>");
    expect(text).toContain("--json");
    expect(text).toContain("--verbose");
    expect(text).toContain("Never prints a credential");
  });

  it("appends extraHelp when a built-in composes the general CLI", async () => {
    const f = cli();
    const out: string[] = [];
    const err: string[] = [];
    await runClient(["--help"], baseDeps(f, ["--help"], out, err), {
      extraHelp: "Machine verbs:\n  install",
    });
    expect(out.join("\n")).toContain("install");
    expect(out.join("\n")).toContain("search     pair");
  });

  it("-V prints the general version", async () => {
    const run = await cli().run(["-V"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out).toEqual([`actana ${CLI_VERSION}`]);
  });

  it("with version.self prints both versions", async () => {
    const f = cli();
    const out: string[] = [];
    const err: string[] = [];
    await runClient(["-V"], baseDeps(f, ["-V"], out, err), {
      version: { self: "actana-control 9.9.9" },
    });
    expect(out).toEqual([`actana ${CLI_VERSION}`, "actana-control 9.9.9"]);
  });

  it("dispatches core ls", async () => {
    registerCore(cli().paths, "prod");
    const run = await cli().run(["core", "ls"], { probe: healthyProbe() });
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("prod");
  });

  it("dispatches search pair usage", async () => {
    const run = await cli().run(["search", "pair"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("name, an address and a code");
  });

  it("unknown command exits EXIT_USAGE for the global binary", async () => {
    const run = await cli().run(["install"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain('unknown command "install"');
  });

  it("--verbose never prints a credential through the dispatcher", async () => {
    registerCore(cli().paths, "prod");
    const run = await cli().run(["core", "status", "--verbose"], { probe: healthyProbe() });
    for (const secret of SENTINELS) {
      expect(run.all).not.toContain(secret);
    }
  });
});
