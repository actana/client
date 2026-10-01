// Through-the-Core mode: wire details against the fake Core, path escape before the
// wire, and watch cursor replay. Guard breaks for Evidence live in the PR body.
import { describe, expect, it } from "vitest";
import { createThroughCoreShared, homeRelativeSharedPath, SHARED_FOLDER_NAME } from "../core.ts";
import { CoreSharedError } from "../types.ts";
import { expectCode } from "./contract.ts";
import { fakeCoreFetch, startFakeCoreFiles } from "./fake-core-files.ts";

describe("through the Core: home-relative paths", () => {
  it("prefixes every Shared path with shared/", () => {
    expect(homeRelativeSharedPath("")).toBe(SHARED_FOLDER_NAME);
    expect(homeRelativeSharedPath("", true)).toBe(`${SHARED_FOLDER_NAME}/`);
    expect(homeRelativeSharedPath("a/b.txt")).toBe(`${SHARED_FOLDER_NAME}/a/b.txt`);
    expect(homeRelativeSharedPath("a/b", true)).toBe(`${SHARED_FOLDER_NAME}/a/b/`);
  });
});

describe("through the Core: list and get against the fake Core", () => {
  it("lists and reads through /v1/files?path=shared/…", async () => {
    const core = await startFakeCoreFiles();
    try {
      const shared = createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: core.events,
      });
      await shared.put("notes.md", "hello");
      expect(new TextDecoder().decode((await shared.get("notes.md")).body)).toBe("hello");
      expect((await shared.list("")).map((e) => `${e.kind}:${e.path}`)).toEqual(["file:notes.md"]);
      expect(core.requests.some((r) => r.startsWith("PUT /v1/files"))).toBe(true);
      expect(core.requests.some((r) => r.startsWith("GET /v1/files/list"))).toBe(true);
      expect(core.requests.some((r) => r === "GET /v1/files")).toBe(true);
    } finally {
      await core.close();
    }
  });

  it("refuses an escaping path before any request leaves", async () => {
    const core = await startFakeCoreFiles();
    try {
      const shared = createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: core.events,
      });
      const before = core.requests.length;
      await expectCode(shared.get("../outside.txt"), "invalid-path");
      await expectCode(shared.put("/abs.txt", "x"), "invalid-path");
      await expectCode(shared.list("a/../b"), "invalid-path");
      expect(core.requests.length).toBe(before);
    } finally {
      await core.close();
    }
  });
});

describe("through the Core: watch over the event log cursor", () => {
  it("replays shared:changed by opaque event-id cursor", async () => {
    const core = await startFakeCoreFiles();
    try {
      const shared = createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: core.events,
      });
      await shared.put("old.txt", "old");
      const base = await shared.watch();
      expect(base.cursor).toMatch(/^\d+$/);
      await shared.put("new.txt", "new");
      const next = await shared.watch(base.cursor);
      expect(next.changes.filter((c) => c.kind === "file").map((c) => `${c.deleted ? "-" : "+"}${c.path}`)).toEqual([
        "+new.txt",
      ]);
      expect(core.events.all().some((e) => e.path === "new.txt" && !e.deleted)).toBe(true);
    } finally {
      await core.close();
    }
  });

  it("refuses a cursor that is not a decimal event id", async () => {
    const core = await startFakeCoreFiles();
    try {
      const shared = createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: core.events,
      });
      for (const cursor of ["", "garbage", "not a cursor at all"]) {
        await expectCode(shared.watch(cursor), "invalid-cursor");
      }
    } finally {
      await core.close();
    }
  });

  it("does not lose a change appended between tip and since", async () => {
    const core = await startFakeCoreFiles();
    try {
      const shared = createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: core.events,
      });
      await shared.put("old.txt", "old");
      const base = await shared.watch();
      await shared.put("seen.txt", "seen");

      // Event source that appends one more change after tip() returns and before since() runs.
      let raceId = 0;
      const racing = {
        tip: () => {
          const tip = core.events.tip();
          raceId = tip + 1;
          return tip;
        },
        since: (since: number) => {
          // Append after tip was taken: without tip-first+bound this is lost behind the cursor.
          const all = [
            ...core.events.since(since),
            { eventId: raceId, path: "raced.txt", size: 5, mtime: Date.now(), deleted: false },
          ];
          return all;
        },
      };
      const mid = createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: racing,
      });
      const first = await mid.watch(base.cursor);
      expect(first.changes.map((c) => c.path)).toEqual(["seen.txt"]);
      expect(first.changes.map((c) => c.path)).not.toContain("raced.txt");
      // Cursor is the tip from before the race; a later watch that includes raceId reports it.
      const followUp = {
        tip: () => raceId,
        since: (since: number) =>
          [
            ...core.events.since(since),
            { eventId: raceId, path: "raced.txt", size: 5, mtime: Date.now(), deleted: false },
          ].filter((e) => e.eventId > since),
      };
      const next = await createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: followUp,
      }).watch(first.cursor);
      expect(next.changes.map((c) => `+${c.path}`)).toContain("+raced.txt");
    } finally {
      await core.close();
    }
  });
});

describe("through the Core: signedUrl", () => {
  it("refuses when a bearer is configured (Files URL is not an unsigned download)", async () => {
    const core = await startFakeCoreFiles();
    try {
      const shared = createThroughCoreShared({
        baseUrl: core.baseUrl,
        bearer: "not-a-loopback-token",
        fetch: fakeCoreFetch(),
        events: core.events,
      });
      await shared.put("a.txt", "a");
      await expectCode(shared.signedUrl("a.txt"), "unavailable");
    } finally {
      await core.close();
    }
  });
});

describe("through the Core: empty folder put", () => {
  it("refuses put onto an empty folder with is-folder (does not replace it)", async () => {
    const core = await startFakeCoreFiles();
    try {
      const shared = createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: core.events,
      });
      await shared.mkdir("empty");
      await expectCode(shared.put("empty", "x"), "is-folder");
      expect((await shared.list("")).map((e) => `${e.kind}:${e.path}`)).toEqual(["folder:empty"]);
    } finally {
      await core.close();
    }
  });
});

describe("through the Core: mkdir, rm, move", () => {
  it("creates a folder, moves a file (Core move after parents exist), and deletes with a trailing slash", async () => {
    const core = await startFakeCoreFiles();
    try {
      const shared = createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: core.events,
      });
      await shared.mkdir("docs");
      await shared.put("docs/a.txt", "a");
      await shared.move("docs/a.txt", "out/b.txt");
      expect(new TextDecoder().decode((await shared.get("out/b.txt")).body)).toBe("a");
      await expectCode(shared.get("docs/a.txt"), "not-found");
      await shared.rm("out/");
      // Disk keeps the empty `docs/` folder (unlike flat S3); that is allowed by the interface.
      expect((await shared.list("")).map((e) => e.path)).toEqual(["docs"]);
      expect(core.requests.some((r) => r === "POST /v1/files/folder")).toBe(true);
      expect(core.requests.some((r) => r === "POST /v1/files/move")).toBe(true);
      expect(core.requests.some((r) => r === "DELETE /v1/files")).toBe(true);
    } finally {
      await core.close();
    }
  });
});

describe("through the Core: error mapping", () => {
  it("maps Core not-found and directory-in-the-way onto CoreShared codes", async () => {
    const core = await startFakeCoreFiles();
    try {
      const shared = createThroughCoreShared({
        baseUrl: core.baseUrl,
        fetch: fakeCoreFetch(),
        events: core.events,
      });
      await expectCode(shared.get("missing.txt"), "not-found");
      await shared.put("dir/f.txt", "f");
      try {
        await shared.put("dir", "x");
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CoreSharedError);
        expect((error as CoreSharedError).code).toBe("is-folder");
      }
    } finally {
      await core.close();
    }
  });
});
