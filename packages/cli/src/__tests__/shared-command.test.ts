// `actana shared` — the surface (client #7).
//
// The command runs against `fakeShared`, an in-memory `CoreShared`: what these
// suites cover is the command's own part — which Core a path means, what reaches
// stdout and stderr, the exit code — not a mode of the interface. The mode that
// reaches a real Core is client PR 39; until it lands the factory's default is a
// stub, and the last suite here pins what that stub says.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { CoreSharedError } from "@actana/sdk/shared";
import { fakeShared } from "./shared-fixture.ts";
import { makeCliFixture, registerCore, sentinelBlobText, type CliFixture } from "./cli-harness.ts";
import { openSharedThroughCore } from "../core/shared-gateway.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "../kit/exit-codes.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

const PROD = "wss://prod.test:9444";
const STAGING = "wss://staging.test:9444";

/** Two paired Cores; `prod` is the current one. */
function twoCores(): void {
  registerCore(cli().paths, "prod", sentinelBlobText(PROD));
  registerCore(cli().paths, "staging", sentinelBlobText(STAGING));
}

describe("actana shared ls", () => {
  it("lists the root of the current Core: folders first, then files", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("reports/a.md", "x");
    shared.folder(PROD).seed("brief.md", "hello");

    const run = await cli().run(["shared", "ls"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(shared.opened).toEqual([PROD]);
    expect(shared.folder(PROD).calls).toEqual(["list "]);
    expect(run.out).toEqual([
      "KIND    SIZE  MODIFIED  PATH",
      "folder  —     —         reports/",
      "file    5     now       brief.md",
    ]);
    expect(run.err).toEqual([]);
  });

  it("reaches the Core in a <core>: prefix, not the current one", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(STAGING).seed("reports/a.md", "x");

    const run = await cli().run(["shared", "ls", "staging:reports/"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(shared.opened).toEqual([STAGING]);
    expect(shared.folder(STAGING).calls).toEqual(["list reports/"]);
    expect(run.out[1]).toContain("reports/a.md");
  });

  it("prints a JSON array with --json", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("brief.md", "hello");

    const run = await cli().run(["shared", "ls", "--json"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n"))).toEqual([
      { path: "brief.md", kind: "file", size: 5, modifiedAt: "2026-08-12T00:00:00.000Z" },
    ]);
  });
});

describe("actana shared get", () => {
  it("writes the file to stdout, and nothing else on either stream", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("reports/a.md", "# done\n");

    const run = await cli().run(["shared", "get", "reports/a.md"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(run.out).toEqual(["# done\n"]);
    expect(run.err).toEqual([]);
  });

  it("prints the bytes as base64 in a JSON document with --json, so binary survives", async () => {
    twoCores();
    const shared = fakeShared();
    await shared.folder(PROD).put("b.bin", new Uint8Array([0, 255, 128]));

    const run = await cli().run(["shared", "get", "b.bin", "--json"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n"))).toEqual({
      path: "b.bin",
      kind: "file",
      size: 3,
      modifiedAt: "2026-08-12T00:00:00.000Z",
      body: "AP+A",
    });
  });

  it("takes the Core in a prefix", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(STAGING).seed("a.md", "staging copy");

    const run = await cli().run(["shared", "get", "staging:a.md"], { shared: shared.open });

    expect(run.out).toEqual(["staging copy"]);
    expect(shared.opened).toEqual([STAGING]);
  });

  it("writes to a local file when one is named", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("a.md", "bytes");
    const target = path.join(cli().home, "out.md");
    mkdirSync(cli().home, { recursive: true });

    const run = await cli().run(["shared", "get", "a.md", target], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(readFileSync(target, "utf8")).toBe("bytes");
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([`Wrote 5 bytes to ${target}.`]);
  });

  it("says a missing file is missing: stderr and exit 1, with no JSON document on stdout", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "get", "nope.md", "--json"], { shared: shared.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toEqual(["actana shared get: no file at nope.md"]);
    expect(run.out).toEqual([]);
  });

  it("refuses a folder before it dials", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "get", "reports/"], { shared: shared.open });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err[0]).toContain("is a folder");
    expect(shared.opened).toEqual([]);
  });
});

describe("actana shared put", () => {
  it("writes stdin to the path and confirms on stderr", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "put", "tasks/one.md"], { shared: shared.open, stdin: "do it\n" });

    expect(run.code).toBe(EXIT_OK);
    expect(shared.folder(PROD).text("tasks/one.md")).toBe("do it\n");
    expect(run.out).toEqual([]);
    expect(run.err).toEqual(["Wrote 6 bytes to prod:tasks/one.md."]);
  });

  it("writes a local file, byte for byte, to the Core in the prefix", async () => {
    twoCores();
    const shared = fakeShared();
    mkdirSync(cli().home, { recursive: true });
    const source = path.join(cli().home, "in.bin");
    writeFileSync(source, Buffer.from([0, 255, 1, 128]));

    const run = await cli().run(["shared", "put", "staging:in.bin", source], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(shared.opened).toEqual([STAGING]);
    expect([...(await shared.folder(STAGING).get("in.bin")).body]).toEqual([0, 255, 1, 128]);
  });

  it("reads stdin for -, even at a terminal", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "put", "a.md", "-"], { shared: shared.open, stdin: "x", stdinIsTty: true });

    expect(run.code).toBe(EXIT_OK);
    expect(shared.folder(PROD).text("a.md")).toBe("x");
  });

  it("will not wait on a terminal for content it was not given", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "put", "a.md"], { shared: shared.open, stdinIsTty: true });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err[0]).toContain("nothing to write");
    expect(shared.opened).toEqual([]);
  });

  it("fails on a local file it cannot read, without dialling", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "put", "a.md", path.join(cli().home, "missing")], { shared: shared.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err[0]).toMatch(/^actana shared put: could not read .*missing \(ENOENT\)$/);
    expect(shared.opened).toEqual([]);
  });

  it("refuses a path that escapes the folder: exit 2, on stderr, before anything is opened", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "put", "../etc/x", "-"], { shared: shared.open, stdin: "x" });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err).toEqual(['actana shared put: path may not contain "." or "..".']);
    expect(shared.opened).toEqual([]);
    expect(shared.folder(PROD).calls).toEqual([]);
  });
});

describe("actana shared rm", () => {
  it("deletes a file", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("a.md", "x");

    const run = await cli().run(["shared", "rm", "a.md"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(shared.folder(PROD).text("a.md")).toBeUndefined();
    expect(run.err).toEqual(["Deleted prod:a.md."]);
  });

  it("deletes a folder with its contents when the path ends in /", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("old/a.md", "x");
    shared.folder(PROD).seed("old/deep/b.md", "y");
    shared.folder(PROD).seed("keep.md", "z");

    const run = await cli().run(["shared", "rm", "old/"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(shared.folder(PROD).calls).toEqual(["rm old/"]);
    expect(shared.folder(PROD).text("old/deep/b.md")).toBeUndefined();
    expect(shared.folder(PROD).text("keep.md")).toBe("z");
  });

  it("will not delete the root", async () => {
    twoCores();
    const shared = fakeShared();

    for (const argv of [["shared", "rm", ""], ["shared", "rm", "staging:"]]) {
      const run = await cli().run(argv, { shared: shared.open });
      expect(run.code).toBe(EXIT_USAGE);
      expect(run.err[0]).toContain("cannot be deleted");
    }
    expect(shared.opened).toEqual([]);
  });

  it("reports a missing file on stderr with exit 1, and a JSON error document with --json", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "rm", "nope.md", "--json"], { shared: shared.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toEqual(["actana shared rm: no file at nope.md"]);
    expect(JSON.parse(run.out.join("\n"))).toEqual({ error: "no file at nope.md" });
  });
});

describe("actana shared mkdir", () => {
  it("creates a folder, and treats the path as a folder without a trailing /", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "mkdir", "reports/2026"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(shared.folder(PROD).calls).toEqual(["mkdir reports/2026/"]);
    expect([...shared.folder(PROD).folders].sort()).toEqual(["reports", "reports/2026"]);
    expect(run.err).toEqual(["Created prod:reports/2026/."]);
  });

  it("succeeds when the folder is already there", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("reports/a.md", "x");

    const run = await cli().run(["shared", "mkdir", "reports/"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
  });

  it("fails, exit 1, where a file is in the way", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("a", "x");

    const run = await cli().run(["shared", "mkdir", "a"], { shared: shared.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toEqual(["actana shared mkdir: a file is already at that path"]);
  });
});

/** Let a running `watch` make its first poll. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("actana shared watch", () => {
  it("starts from now: what was already there is history, what changes after is printed", async () => {
    twoCores();
    const shared = fakeShared({ pollIntervalMs: 1 });
    shared.folder(PROD).seed("old.md", "x");

    const run = cli().run(["shared", "watch", "--limit", "1"], { shared: shared.open });
    await settle();
    await shared.folder(PROD).put("reports/new.md", "hello");
    const result = await run;

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual(["reports/new.md  file  5  2026-08-12T00:00:00.000Z"]);
    expect(result.err).toEqual([]);
    expect(shared.closed.count).toBe(1);
  });

  it("prints everything there is with --since start", async () => {
    twoCores();
    const shared = fakeShared({ pollIntervalMs: 1 });
    shared.folder(PROD).seed("a.md", "x");
    shared.folder(PROD).seed("b.md", "yy");

    const result = await cli().run(["shared", "watch", "--since", "start", "--limit", "2"], { shared: shared.open });

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.map((line) => line.split("  ")[0])).toEqual(["a.md", "b.md"]);
  });

  it("resumes after the cursor it is given, and not before", async () => {
    twoCores();
    const shared = fakeShared({ pollIntervalMs: 1 });
    await shared.folder(PROD).put("one.md", "1");
    await shared.folder(PROD).put("two.md", "22");
    await shared.folder(PROD).rm("one.md");

    const result = await cli().run(["shared", "watch", "--since", "1", "--limit", "2"], { shared: shared.open });

    expect(result.code).toBe(EXIT_OK);
    expect(shared.folder(PROD).calls.filter((call) => call.startsWith("watch"))).toEqual(["watch 1"]);
    expect(result.out).toEqual(["two.md  file  2  2026-08-12T00:00:00.000Z", "one.md  deleted"]);
  });

  it("prints one JSON object per line with --json, the cursor on each, and nothing else on stdout", async () => {
    twoCores();
    const shared = fakeShared({ pollIntervalMs: 1 });
    await shared.folder(PROD).put("a.md", "x");
    await shared.folder(PROD).mkdir("d/");
    await shared.folder(PROD).rm("a.md");

    const result = await cli().run(["shared", "watch", "--since", "0", "--json", "--limit", "3"], { shared: shared.open });

    expect(result.code).toBe(EXIT_OK);
    expect(result.err).toEqual([]);
    expect(result.out.map((line) => JSON.parse(line))).toEqual([
      { path: "a.md", kind: "file", deleted: false, size: 1, modifiedAt: "2026-08-12T00:00:00.000Z", cursor: "3" },
      { path: "d", kind: "folder", deleted: false, cursor: "3" },
      { path: "a.md", kind: "file", deleted: true, cursor: "3" },
    ]);
  });

  it("follows the Core named on the command line", async () => {
    twoCores();
    const shared = fakeShared({ pollIntervalMs: 1 });

    const run = cli().run(["shared", "watch", "staging", "--limit", "1"], { shared: shared.open });
    await settle();
    await shared.folder(STAGING).put("a.md", "x");
    const result = await run;

    expect(result.code).toBe(EXIT_OK);
    expect(shared.opened).toEqual([STAGING]);
  });

  it("stops after a failure and says which cursor to resume from, on stderr", async () => {
    twoCores();
    const shared = fakeShared({ pollIntervalMs: 1 });
    const folder = shared.folder(PROD);
    const watch = folder.watch.bind(folder);
    let polls = 0;
    folder.watch = async (since) => {
      polls += 1;
      if (polls === 3) throw new CoreSharedError("unavailable", "the Core stopped answering");
      return watch(since);
    };

    const result = await cli().run(["shared", "watch", "--since", "0", "--limit", "9"], { shared: shared.open });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err).toEqual(["actana shared watch: the Core stopped answering", "Resume with --since 0"]);
    expect(result.out).toEqual([]);
    expect(shared.closed.count).toBe(1);
  });

  it("refuses a cursor the mode does not accept: exit 1, on stderr, nothing on stdout", async () => {
    twoCores();
    const shared = fakeShared({ pollIntervalMs: 1 });

    const result = await cli().run(["shared", "watch", "--since", "garbage", "--json"], { shared: shared.open });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err[0]).toBe("actana shared watch: that is not a cursor");
    expect(result.out).toEqual([]);
  });

  it("takes a whole number for --limit", async () => {
    twoCores();
    const shared = fakeShared();

    const result = await cli().run(["shared", "watch", "--limit", "many"], { shared: shared.open });

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err).toEqual(['actana shared watch: --limit takes a whole number of changes, not "many".']);
    expect(shared.opened).toEqual([]);
  });
});

describe("which Core a shared command means", () => {
  it("uses --core the way a prefix does", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "ls", "--core", "staging"], { shared: shared.open });

    expect(run.code).toBe(EXIT_OK);
    expect(shared.opened).toEqual([STAGING]);
  });

  it("refuses a prefix and a --core that disagree, before dialling", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "ls", "prod:reports/", "--core", "staging"], { shared: shared.open });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err[0]).toContain('names Core "prod" and --core names "staging"');
    expect(shared.opened).toEqual([]);
  });

  it("reads a colon in a path as part of the path when what precedes it is not a Core name", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("notes/a:b.md", "x");

    const run = await cli().run(["shared", "get", "notes/a:b.md"], { shared: shared.open });

    expect(run.out).toEqual(["x"]);
    expect(shared.opened).toEqual([PROD]);
  });

  it("reads a leading colon as no prefix at all", async () => {
    twoCores();
    const shared = fakeShared();
    shared.folder(PROD).seed("a:b", "x");

    const run = await cli().run(["shared", "get", ":a:b"], { shared: shared.open });

    expect(run.out).toEqual(["x"]);
    expect(shared.opened).toEqual([PROD]);
  });

  it("names the Core it could not find, as every other noun does", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "ls", "nowhere:"], { shared: shared.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toHaveLength(1);
    expect(run.err[0]).toMatch(/^actana shared ls: .*nowhere/);
    expect(shared.opened).toEqual([]);
  });

  it("says so when no Core is selected at all", async () => {
    const shared = fakeShared();

    const run = await cli().run(["shared", "ls"], { shared: shared.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err[0]).toMatch(/^actana shared ls: no Core selected\./);
  });
});

describe("actana shared, the command line", () => {
  it("prints its help for --help and exits 0", async () => {
    const run = await cli().run(["shared", "--help"]);

    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("actana shared — a Core's Shared folder");
  });

  it("prints its help and exits 2 with no verb", async () => {
    const run = await cli().run(["shared"]);

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out.join("\n")).toContain("actana shared watch [<core>]");
  });

  it("names the verbs for one it does not know", async () => {
    const run = await cli().run(["shared", "cp"]);

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err[0]).toBe('actana shared: unknown verb "cp".');
    expect(run.err[1]).toContain("ls, get, put, rm, mkdir, watch");
  });

  it("keeps --since and --limit for watch", async () => {
    twoCores();
    const shared = fakeShared();

    const run = await cli().run(["shared", "ls", "--since", "3"], { shared: shared.open });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err[0]).toBe("actana shared ls: --since belongs to `actana shared watch`.");
  });

  it("lists itself in `actana --help`", async () => {
    const run = await cli().run(["--help"]);

    expect(run.out.join("\n")).toContain("shared     ls, get, put, rm, mkdir, watch");
  });
});

describe("the default factory, until the through-the-Core mode lands (client PR 39)", () => {
  it("says this build cannot reach the Shared folder yet: exit 3, on stderr", async () => {
    twoCores();

    const run = await cli().run(["shared", "ls"], { shared: openSharedThroughCore });

    expect(run.code).toBe(EXIT_UNIMPLEMENTED);
    expect(run.err).toEqual([
      "actana shared ls: reaching the Shared folder through a Core is not in this build yet (actana/client PR 39)",
    ]);
    expect(run.out).toEqual([]);
  });
});

describe("a path the interface refuses never reaches a mode", () => {
  const bad = ["../x", "/abs", "a//b", "a/./b", "a\\b"];
  const verbs: string[][] = [["ls"], ["get"], ["put"], ["rm"], ["mkdir"]];

  it("exits 2 on stderr for every verb, with the default factory too, and opens nothing", async () => {
    twoCores();
    const shared = fakeShared();
    for (const verb of verbs) {
      for (const path of bad) {
        for (const factory of [shared.open, openSharedThroughCore]) {
          const run = await cli().run(["shared", ...verb, `staging:${path}`], { shared: factory, stdin: "x" });
          expect(run.code, `${verb[0]} ${path}`).toBe(EXIT_USAGE);
          expect(run.err[0], `${verb[0]} ${path}`).toMatch(new RegExp(`^actana shared ${verb[0]}: `));
          expect(run.out).toEqual([]);
        }
      }
    }
    expect(shared.opened).toEqual([]);
  });
});

describe("actana shared watch --limit and --since", () => {
  it("prints the whole poll that reaches the limit, so the cursor it printed skips nothing", async () => {
    twoCores();
    const shared = fakeShared({ pollIntervalMs: 1 });
    const folder = shared.folder(PROD);
    await folder.put("r1.md", "1");
    await folder.put("r2.md", "2");
    await folder.put("r3.md", "3");

    const first = await cli().run(["shared", "watch", "--since", "0", "--json", "--limit", "1"], { shared: shared.open });

    expect(first.code).toBe(EXIT_OK);
    const lines = first.out.map((line) => JSON.parse(line));
    expect(lines.map((l) => l.path)).toEqual(["r1.md", "r2.md", "r3.md"]);

    // Resuming from that cursor loses nothing and repeats nothing.
    await folder.put("r4.md", "4");
    const resumed = await cli().run(["shared", "watch", "--since", lines[0].cursor, "--json", "--limit", "1"], { shared: shared.open });
    expect(resumed.out.map((line) => JSON.parse(line).path)).toEqual(["r4.md"]);
  });
});
