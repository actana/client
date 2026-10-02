// A host builds a complete `ClientDeps` from the package root alone (client issue 11 follow-up).
//
// Control's built-in CLI imports `@actana/cli` and calls `runClient(argv, deps)`. `ClientDeps` requires
// `openFiles` and `openShared`, and the runtime implementations used to be reachable only by deep path,
// which the package exports map does not allow. Everything below is imported from the package root
// (`../index.ts` is what `"."` maps to), as a host would; only the test doubles come from fixtures.

import { describe, it, expect, afterEach } from "vitest";
import {
  runClient,
  probeCore,
  connectCore,
  sdkCorePairing,
  openSessionGateway,
  openCoreShell,
  openSessionAttach,
  openSharedThroughCore,
  openFilesAtHome,
  terminalFromProcess,
  nodeClientPrompts,
  type ClientDeps,
} from "../index.ts";
import { fakeFiles, FILES_ENDPOINT } from "./files-fixture.ts";
import { fakeShared } from "./shared-fixture.ts";
import { makeCliFixture, registerCore, sentinelBlobText, type CliFixture } from "./cli-harness.ts";

let fixture: CliFixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** What a host writes: every port bound to the package's own implementation, `fakes` swapped in. */
function hostDeps(
  fixture: CliFixture,
  lines: { out: string[]; err: string[] },
  fakes: Partial<Pick<ClientDeps, "openFiles" | "openShared">> = {},
): ClientDeps {
  return {
    argv: [],
    env: { XDG_CONFIG_HOME: fixture.configHome },
    home: fixture.home,
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
    outBytes: (chunk) => lines.out.push(chunk),
    errBytes: (chunk) => lines.err.push(chunk),
    verbose: () => {},
    readStdin: async () => "",
    stdinIsTty: true,
    stdoutIsTty: false,
    hostname: "host",
    platform: "linux",
    interactive: false,
    system: nodeClientPrompts(),
    probe: probeCore,
    connect: connectCore,
    pairing: sdkCorePairing,
    openSessions: openSessionGateway,
    now: () => 0,
    terminal: terminalFromProcess(process),
    openShell: openCoreShell,
    openAttach: openSessionAttach,
    openShared: openSharedThroughCore,
    openFiles: openFilesAtHome,
    ...fakes,
  };
}

describe("a host binds every port from the package root", () => {
  it("exports a function for every port implementation entry.ts binds", () => {
    for (const port of [
      probeCore,
      connectCore,
      openSessionGateway,
      openCoreShell,
      openSessionAttach,
      openSharedThroughCore,
      openFilesAtHome,
      terminalFromProcess,
      nodeClientPrompts,
    ]) {
      expect(typeof port).toBe("function");
    }
    expect(typeof sdkCorePairing.identify).toBe("function");
    expect(typeof sdkCorePairing.pair).toBe("function");
  });

  it("runs a files verb through a complete ClientDeps", async () => {
    fixture = makeCliFixture();
    registerCore(fixture.paths, "prod", sentinelBlobText(FILES_ENDPOINT));
    const files = fakeFiles();
    files.home(FILES_ENDPOINT).seed("brief.md", "hello");
    const lines = { out: [] as string[], err: [] as string[] };

    const code = await runClient(["files", "ls"], hostDeps(fixture, lines, { openFiles: files.open }));

    expect(code, lines.err.join("\n")).toBe(0);
    expect(files.opened).toEqual([FILES_ENDPOINT]);
    expect(lines.out.join("\n")).toContain("brief.md");
  });

  it("runs a shared verb through a complete ClientDeps", async () => {
    fixture = makeCliFixture();
    registerCore(fixture.paths, "prod", sentinelBlobText("wss://core.test:9444"));
    const shared = fakeShared();
    shared.folder().seed("reports/a.md", "x");
    const lines = { out: [] as string[], err: [] as string[] };

    const code = await runClient(["shared", "ls"], hostDeps(fixture, lines, { openShared: shared.open }));

    expect(code, lines.err.join("\n")).toBe(0);
    expect(shared.opened).toEqual(["wss://core.test:9444"]);
    expect(lines.out.join("\n")).toContain("reports");
  });

  it("fails fast, on stderr, when a verb reaches a port the host did not replace and no Core exists", async () => {
    fixture = makeCliFixture();
    const lines = { out: [] as string[], err: [] as string[] };
    const code = await runClient(["files", "ls"], hostDeps(fixture, lines));
    expect(code).not.toBe(0);
    expect(lines.err.length).toBeGreaterThan(0);
  });
});
