// `actana files` — the surface (client #10).
//
// The command runs against `fakeFiles`, an in-memory Files API with the routes and
// refusals of control PR 620, through the SDK's real `CoreFiles`. What these suites
// cover is the command's own part (which Core a path means, what reaches stdout and
// stderr, the exit code) and that the SDK client sends the home routes and nothing else.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { fakeFiles, FILES_ENDPOINT } from "./files-fixture.ts";
import { makeCliFixture, registerCore, sentinelBlobText, type CliFixture } from "./cli-harness.ts";
import { openFilesAtHome } from "../core/files-gateway.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../kit/exit-codes.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

const PROD = FILES_ENDPOINT;
const STAGING = "wss://staging.test:9444";

/** Two paired Cores; `prod` is the current one. */
function twoCores(): void {
  registerCore(cli().paths, "prod", sentinelBlobText(PROD));
  registerCore(cli().paths, "staging", sentinelBlobText(STAGING));
}

describe("actana files ls", () => {
  it("lists the home of the current Core: folders first, then files, on the home routes", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("reports/a.md", "x");
    files.home(PROD).seed("brief.md", "hello");

    const run = await cli().run(["files", "ls"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(files.opened).toEqual([PROD]);
    expect(files.home(PROD).requests).toEqual(["GET /v1/files/list?path=&depth=1"]);
    expect(run.out).toEqual([
      "KIND    SIZE  MODIFIED  PATH",
      "folder  —     now       reports/",
      "file    5     now       brief.md",
    ]);
    expect(run.err).toEqual([]);
  });

  it("lists a folder by its path, relative to the home", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("reports/a.md", "x");
    files.home(PROD).seed("reports/deep/b.md", "yy");

    const run = await cli().run(["files", "ls", "reports/"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(files.home(PROD).requests).toEqual(["GET /v1/files/list?path=reports%2F&depth=1"]);
    expect(run.out.map((l) => l.split(/\s+/).pop())).toEqual(["PATH", "reports/deep/", "reports/a.md"]);
  });

  it("goes deeper with --depth, and the whole tree with --depth all", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("a/b/c.txt", "c");

    const three = await cli().run(["files", "ls", "--depth", "3"], { files: files.open });
    const all = await cli().run(["files", "ls", "--depth", "all"], { files: files.open });

    expect(three.out.map((l) => l.split(/\s+/).pop())).toEqual(["PATH", "a/", "a/b/", "a/b/c.txt"]);
    expect(all.out.map((l) => l.split(/\s+/).pop())).toEqual(["PATH", "a/", "a/b/", "a/b/c.txt"]);
    expect(files.home(PROD).requests).toEqual([
      "GET /v1/files/list?path=&depth=3",
      "GET /v1/files/list?path=",
    ]);
  });

  it("asks for digests only with --sha256", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("a.txt", "a");

    const plain = await cli().run(["files", "ls", "--json"], { files: files.open });
    const digested = await cli().run(["files", "ls", "--sha256", "--json"], { files: files.open });

    expect(JSON.parse(plain.out.join("\n"))[0]).not.toHaveProperty("sha256");
    expect(JSON.parse(digested.out.join("\n"))[0]).toMatchObject({ path: "a.txt", sha256: "sha-of-a.txt" });
  });

  it("reaches the Core in a <core>: prefix, not the current one", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(STAGING).seed("only-here.md", "s");

    const run = await cli().run(["files", "ls", "staging:"], { files: files.open });

    expect(files.opened).toEqual([STAGING]);
    expect(run.out.join("\n")).toContain("only-here.md");
  });

  it("prints a JSON array with --json", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("a.md", "abc");

    const run = await cli().run(["files", "ls", "--json"], { files: files.open });

    expect(JSON.parse(run.out.join("\n"))).toEqual([
      { path: "a.md", kind: "file", size: 3, modifiedAt: "2026-08-12T00:00:00.000Z", mode: 0o644 },
    ]);
  });

  it("says so when there is nothing in a folder", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).folder("empty");

    const run = await cli().run(["files", "ls", "empty/"], { files: files.open });

    expect(run.out).toEqual(["Nothing in empty/."]);
  });

  it("reports a missing folder on stderr with exit 1, and nothing on stdout", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "ls", "nope/"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toEqual(["actana files ls: no such path in the home: nope (not-found)"]);
    expect(run.out).toEqual([]);
  });
});

describe("actana files get", () => {
  it("writes the file to stdout, and nothing else on either stream", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("notes/a.md", "hello");

    const run = await cli().run(["files", "get", "notes/a.md"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(run.out).toEqual(["hello"]);
    expect(run.err).toEqual([]);
    expect(files.home(PROD).requests).toEqual(["GET /v1/files?path=notes%2Fa.md"]);
  });

  it("takes the Core in a prefix", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(STAGING).seed("a.md", "staged");

    const run = await cli().run(["files", "get", "staging:a.md"], { files: files.open });

    expect(run.out).toEqual(["staged"]);
    expect(files.opened).toEqual([STAGING]);
  });

  it("writes to a local file when one is named, byte for byte", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("bin.dat", new Uint8Array([0, 255, 128, 7]));
    const target = path.join(cli().home, "out.dat");
    mkdirSync(cli().home, { recursive: true });

    const run = await cli().run(["files", "get", "bin.dat", target], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect([...readFileSync(target)]).toEqual([0, 255, 128, 7]);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([`Wrote 4 bytes to ${target}.`]);
  });

  it("prints the bytes as base64 in a JSON document with --json, so binary survives", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("bin.dat", new Uint8Array([0, 255, 128]));

    const run = await cli().run(["files", "get", "bin.dat", "--json"], { files: files.open });

    expect(JSON.parse(run.out.join(""))).toEqual({ path: "bin.dat", size: 3, body: Buffer.from([0, 255, 128]).toString("base64") });
  });

  it("says a missing file is missing: stderr and exit 1, with no JSON document on stdout", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "get", "nope.md", "--json"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toEqual(["actana files get: no such path in the home: nope.md (not-found)"]);
    expect(run.out).toEqual([]);
  });

  it("refuses a folder named with a trailing slash before it dials", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "get", "reports/"], { files: files.open });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err[0]).toContain("is a folder");
    expect(files.opened).toEqual([]);
  });

  it("fails, exit 1 on stderr, for a folder spelt as a file: it does not print a tar", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("reports/a.md", "x");

    const run = await cli().run(["files", "get", "reports"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toEqual(['actana files get: "reports" is a folder; `actana files get` takes a file']);
    expect(run.out).toEqual([]);
  });
});

describe("actana files put", () => {
  it("writes stdin to the path and confirms on stderr", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "put", "notes/new.md"], { files: files.open, stdin: "fresh" });

    expect(run.code).toBe(EXIT_OK);
    expect(files.home(PROD).text("notes/new.md")).toBe("fresh");
    expect(files.home(PROD).requests).toEqual(["PUT /v1/files?path=notes%2Fnew.md"]);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual(["Wrote 5 bytes to prod:notes/new.md."]);
  });

  it("writes a local file, byte for byte, to the Core in the prefix", async () => {
    twoCores();
    const files = fakeFiles();
    mkdirSync(cli().home, { recursive: true });
    const local = path.join(cli().home, "in.dat");
    writeFileSync(local, new Uint8Array([1, 2, 3, 250]));

    const run = await cli().run(["files", "put", "staging:in.dat", local], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(files.opened).toEqual([STAGING]);
    expect(files.home(STAGING).has("in.dat")).toBe(true);
    expect(run.err).toEqual(["Wrote 4 bytes to staging:in.dat."]);
  });

  it("replaces a file that is already there", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("a.md", "old");

    const run = await cli().run(["files", "put", "a.md", "-"], { files: files.open, stdin: "new" });

    expect(run.code).toBe(EXIT_OK);
    expect(files.home(PROD).text("a.md")).toBe("new");
  });

  it("prints {path,size} with --json", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "put", "a.md", "--json"], { files: files.open, stdin: "abc" });

    expect(JSON.parse(run.out.join(""))).toEqual({ path: "a.md", size: 3 });
  });

  it("will not wait on a terminal for content it was not given", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "put", "a.md"], { files: files.open, stdinIsTty: true });

    expect(run.code).toBe(EXIT_USAGE);
    expect(files.opened).toEqual([]);
  });

  it("fails on a local file it cannot read, without dialling", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "put", "a.md", path.join(cli().home, "missing")], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err[0]).toMatch(/^actana files put: could not read .*missing \(ENOENT\)$/);
    expect(files.opened).toEqual([]);
  });

  it("refuses a folder path, before it dials", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "put", "reports/"], { files: files.open, stdin: "x" });

    expect(run.code).toBe(EXIT_USAGE);
    expect(files.opened).toEqual([]);
  });

  it("reports the Core's refusal when a folder is in the way: exit 1 on stderr", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("dir/inside.txt", "x");

    const run = await cli().run(["files", "put", "dir"], { files: files.open, stdin: "x" });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toEqual(["actana files put: dir is a non-empty directory (directory-in-the-way)"]);
  });
});

describe("actana files rm", () => {
  it("deletes a file", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("a.md", "x");

    const run = await cli().run(["files", "rm", "a.md"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(files.home(PROD).has("a.md")).toBe(false);
    expect(files.home(PROD).requests).toEqual(["DELETE /v1/files?path=a.md"]);
    expect(run.err).toEqual(["Deleted prod:a.md."]);
    expect(run.out).toEqual([]);
  });

  it("deletes a folder with its contents when the path ends in /", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("reports/a.md", "x");
    files.home(PROD).seed("reports/deep/b.md", "y");
    files.home(PROD).seed("keep.md", "k");

    const run = await cli().run(["files", "rm", "reports/"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(files.home(PROD).has("reports/a.md")).toBe(false);
    expect(files.home(PROD).has("reports/deep/b.md")).toBe(false);
    expect(files.home(PROD).has("keep.md")).toBe(true);
  });

  it("will not delete a folder spelt without the slash: the Core refuses, exit 1 on stderr", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("reports/a.md", "x");

    const run = await cli().run(["files", "rm", "reports"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err[0]).toContain("end the path with /");
    expect(files.home(PROD).has("reports/a.md")).toBe(true);
  });

  it("will not delete the home, and does not dial to find out", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "rm", ""], { files: files.open });
    const prefixed = await cli().run(["files", "rm", "staging:"], { files: files.open });

    expect(run.code).toBe(EXIT_USAGE);
    expect(prefixed.code).toBe(EXIT_USAGE);
    expect(run.err).toEqual(["actana files rm: the home folder cannot be deleted."]);
    expect(files.opened).toEqual([]);
  });

  it("reports a missing file on stderr with exit 1, and a JSON error document with --json", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "rm", "nope.md", "--json"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toEqual(["actana files rm: no such path in the home: nope.md (not-found)"]);
    expect(JSON.parse(run.out.join(""))).toEqual({ error: "no such path in the home: nope.md (not-found)" });
  });

  it("prints {path,deleted} with --json", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("a.md", "x");

    const run = await cli().run(["files", "rm", "a.md", "--json"], { files: files.open });

    expect(JSON.parse(run.out.join(""))).toEqual({ path: "a.md", deleted: true });
  });
});

describe("a path that leaves the home never reaches a Core", () => {
  const bad = ["../x", "a/../../x", "/abs", "a\\b"];
  const verbs: string[][] = [["ls"], ["get"], ["put"], ["rm"]];

  it("exits 2 on stderr for every verb, with the default factory too, and opens and sends nothing", async () => {
    twoCores();
    const files = fakeFiles();
    for (const verb of verbs) {
      for (const p of bad) {
        for (const factory of [files.open, openFilesAtHome]) {
          const run = await cli().run(["files", ...verb, `staging:${p}`], { files: factory, stdin: "x" });
          expect(run.code, `${verb[0]} ${p}`).toBe(EXIT_USAGE);
          expect(run.err[0], `${verb[0]} ${p}`).toMatch(new RegExp(`^actana files ${verb[0]}: `));
          expect(run.out, `${verb[0]} ${p}`).toEqual([]);
        }
      }
    }
    expect(files.opened).toEqual([]);
    expect(files.home(STAGING).requests).toEqual([]);
  });

  it("exits 2 when the Core is the one to refuse (a path it reads differently), not 1", async () => {
    twoCores();
    const files = fakeFiles();
    // The command's own check passes `a/b`; the Core answers 400 outside-project-root.
    const real = files.open;
    const open = async (blob: Parameters<typeof real>[0]) => {
      const handle = await real(blob);
      return {
        ...handle,
        files: {
          ...handle.files,
          list: handle.files.list.bind(handle.files),
          download: async () => {
            const { CoreFilesRequestError } = await import("@actana/sdk/core");
            throw new CoreFilesRequestError(400, "outside-project-root", "a symlink points out of the home");
          },
          upload: handle.files.upload.bind(handle.files),
          remove: handle.files.remove.bind(handle.files),
        },
      };
    };

    const run = await cli().run(["files", "get", "link/secret"], { files: open });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err).toEqual(["actana files get: a symlink points out of the home"]);
  });
});

describe("which Core a files command means", () => {
  it("uses --core the way a prefix does", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(STAGING).seed("a.md", "s");

    const run = await cli().run(["files", "get", "a.md", "--core", "staging"], { files: files.open });

    expect(run.out).toEqual(["s"]);
    expect(files.opened).toEqual([STAGING]);
  });

  it("refuses a prefix and a --core that disagree, before dialling", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "get", "prod:a.md", "--core", "staging"], { files: files.open });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err[0]).toContain('names Core "prod" and --core names "staging"');
    expect(files.opened).toEqual([]);
  });

  it("reads a colon in a path as part of the path when what precedes it is not a Core name", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("reports/a:b.md", "colon");

    const run = await cli().run(["files", "get", "reports/a:b.md"], { files: files.open });

    expect(run.out).toEqual(["colon"]);
    expect(files.opened).toEqual([PROD]);
  });

  it("reads a leading colon as no prefix at all", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("a:b.md", "lead");

    const run = await cli().run(["files", "get", ":a:b.md"], { files: files.open });

    expect(run.out).toEqual(["lead"]);
  });

  it("names the Core it could not find, as every other noun does", async () => {
    twoCores();
    const files = fakeFiles();

    const run = await cli().run(["files", "ls", "ghost:"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err[0]).toContain("ghost");
    expect(files.opened).toEqual([]);
  });

  it("says so, on stderr with exit 1, when the Core does not answer", async () => {
    twoCores();
    const files = fakeFiles();
    files.down(PROD);

    const run = await cli().run(["files", "ls"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err).toEqual([`actana files ls: ${PROD} did not answer — connect ECONNREFUSED`]);
    expect(run.out).toEqual([]);
  });
});

describe("actana files, the command line", () => {
  it("prints its help for --help and exits 0", async () => {
    const run = await cli().run(["files", "--help"]);

    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("relative to its home folder");
  });

  it("prints its help and exits 2 with no verb", async () => {
    const run = await cli().run(["files"]);

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out.join("\n")).toContain("actana files ls");
  });

  it("names the verbs for one it does not know", async () => {
    const run = await cli().run(["files", "mkdir", "x"]);

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err).toEqual(['actana files: unknown verb "mkdir".', "Verbs: ls, get, put, rm. `actana files --help` lists them."]);
  });

  it("keeps --depth and --sha256 for ls", async () => {
    twoCores();
    const files = fakeFiles();

    for (const verb of ["get", "rm"]) {
      const run = await cli().run(["files", verb, "a.md", "--depth", "2"], { files: files.open });
      expect(run.code, verb).toBe(EXIT_USAGE);
      expect(run.err[0], verb).toContain("belong to `actana files ls`");
    }
    expect(files.opened).toEqual([]);
  });

  it("takes a whole number or all for --depth", async () => {
    twoCores();
    const files = fakeFiles();

    for (const bad of ["0", "-1", "two", "1.5"]) {
      const run = await cli().run(["files", "ls", "--depth", bad], { files: files.open });
      expect(run.code, bad).toBe(EXIT_USAGE);
      expect(run.err[0], bad).toContain("--depth takes a whole number");
    }
    expect(files.opened).toEqual([]);
  });

  it("lists itself in `actana --help`", async () => {
    const run = await cli().run(["--help"]);

    expect(run.out.join("\n")).toContain("files      ls, get, put, rm");
  });

  it("takes no project: --project is an unknown flag, and no request names one", async () => {
    twoCores();
    const files = fakeFiles();
    files.home(PROD).seed("a.md", "x");

    const flag = await cli().run(["files", "ls", "--project", "p1"], { files: files.open });
    const ok = await cli().run(["files", "ls"], { files: files.open });

    expect(flag.code).toBe(EXIT_USAGE);
    expect(flag.err[0]).toBe("actana: unknown flag --project.");
    expect(ok.code).toBe(EXIT_OK);
    expect(files.home(PROD).requests.join("\n")).not.toMatch(/project/i);
  });
});
