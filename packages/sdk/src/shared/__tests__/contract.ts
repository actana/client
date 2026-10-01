// The CoreShared contract suite. It is mode-agnostic: it knows the CoreShared interface and nothing
// about S3, so the through-the-Core mode runs the same tests by passing its own factory.
//
//   runCoreSharedContract("through the Core", async () => ({ shared, dispose }));
//
// Each test asks the factory for a CoreShared on an EMPTY Shared folder of its own.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreSharedError, type CoreShared, type CoreSharedErrorCode } from "../types.ts";

export interface ContractHarness {
  shared: CoreShared;
  dispose(): Promise<void>;
}

export type ContractFactory = () => Promise<ContractHarness>;

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Awaits `promise` and returns the CoreSharedError it rejects with. */
export async function refusal(promise: Promise<unknown>): Promise<CoreSharedError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CoreSharedError);
    return error as CoreSharedError;
  }
  throw new Error("expected a CoreSharedError, but the call succeeded");
}

export async function expectCode(promise: Promise<unknown>, code: CoreSharedErrorCode): Promise<void> {
  expect((await refusal(promise)).code).toBe(code);
}

export function runCoreSharedContract(mode: string, factory: ContractFactory): void {
  describe(`CoreShared contract: ${mode}`, () => {
    let harness: ContractHarness;
    let shared: CoreShared;

    beforeEach(async () => {
      harness = await factory();
      shared = harness.shared;
    });
    afterEach(async () => {
      await harness.dispose();
    });

    describe("put and get", () => {
      it("reads back what it wrote, text and bytes", async () => {
        await shared.put("notes.md", "hello");
        const file = await shared.get("notes.md");
        expect(text(file.body)).toBe("hello");
        expect(file.kind).toBe("file");
        expect(file.path).toBe("notes.md");
        expect(file.size).toBe(5);

        const bytes = Uint8Array.from([0, 1, 2, 254, 255, 10, 13]);
        await shared.put("blob.bin", bytes);
        expect([...(await shared.get("blob.bin")).body]).toEqual([...bytes]);
      });

      it("replaces a file and keeps an empty one", async () => {
        await shared.put("a.txt", "one");
        await shared.put("a.txt", "second");
        expect(text((await shared.get("a.txt")).body)).toBe("second");
        await shared.put("empty.txt", "");
        expect((await shared.get("empty.txt")).size).toBe(0);
      });

      it("creates the missing parent folders", async () => {
        await shared.put("a/b/c.txt", "deep");
        expect(text((await shared.get("a/b/c.txt")).body)).toBe("deep");
      });

      it("keeps names with spaces, unicode and URL-special characters", async () => {
        const names = ["with space.txt", "naïve ☃.txt", "a+b&c=d?e#f.txt", "100%.txt", "q'(x)*.txt"];
        for (const name of names) await shared.put(`odd/${name}`, name);
        for (const name of names) expect(text((await shared.get(`odd/${name}`)).body)).toBe(name);
      });

      it("refuses a missing file with not-found, and a folder path with is-folder", async () => {
        await expectCode(shared.get("nope.txt"), "not-found");
        await expectCode(shared.get("dir/"), "is-folder");
        await expectCode(shared.put("dir/", "x"), "is-folder");
      });
    });

    describe("list", () => {
      it("is empty on an empty Shared folder, and for a folder that is not there", async () => {
        expect(await shared.list("")).toEqual([]);
        expect(await shared.list("nothing/here/")).toEqual([]);
      });

      it("lists the direct children only: folders first, then files, each by name", async () => {
        await shared.put("b.txt", "bb");
        await shared.put("a.txt", "a");
        await shared.put("z/deep/x.txt", "x");
        await shared.put("m/y.txt", "y");
        const root = await shared.list("");
        expect(root.map((e) => `${e.kind}:${e.path}`)).toEqual(["folder:m", "folder:z", "file:a.txt", "file:b.txt"]);
        expect(root.find((e) => e.path === "b.txt")?.size).toBe(2);
        expect(root.find((e) => e.path === "b.txt")?.modifiedAt).toBeInstanceOf(Date);
        expect((await shared.list("z")).map((e) => `${e.kind}:${e.path}`)).toEqual(["folder:z/deep"]);
        expect((await shared.list("z/deep/")).map((e) => `${e.kind}:${e.path}`)).toEqual(["file:z/deep/x.txt"]);
      });

      it("does not mistake a look-alike sibling for a child", async () => {
        await shared.put("docs/a.txt", "1");
        await shared.put("docs-old/b.txt", "2");
        expect((await shared.list("docs")).map((e) => e.path)).toEqual(["docs/a.txt"]);
      });

      it("lists a folder bigger than one page of the store", async () => {
        const names = Array.from({ length: 12 }, (_, i) => `many/f${String(i).padStart(2, "0")}.txt`);
        for (const name of names) await shared.put(name, name);
        expect((await shared.list("many")).map((e) => e.path)).toEqual(names);
      });
    });

    describe("mkdir", () => {
      it("makes an empty folder that lists, and keeps it when asked twice", async () => {
        await shared.mkdir("empty");
        await shared.mkdir("empty/");
        expect(await shared.list("")).toEqual([{ path: "empty", kind: "folder" }]);
        expect(await shared.list("empty")).toEqual([]);
      });

      it("makes nested folders, so the parents are folders too", async () => {
        await shared.mkdir("a/b/c");
        expect((await shared.list("")).map((e) => e.path)).toEqual(["a"]);
        expect((await shared.list("a")).map((e) => e.path)).toEqual(["a/b"]);
        expect((await shared.list("a/b")).map((e) => e.path)).toEqual(["a/b/c"]);
      });

      it("leaves a folder's contents alone", async () => {
        await shared.put("keep/f.txt", "f");
        await shared.mkdir("keep");
        expect(text((await shared.get("keep/f.txt")).body)).toBe("f");
      });

      it("accepts the root as a no-op", async () => {
        await shared.mkdir("");
        expect(await shared.list("")).toEqual([]);
      });
    });

    describe("rm", () => {
      it("deletes a file and says not-found for one that is not there", async () => {
        await shared.put("x.txt", "x");
        await shared.rm("x.txt");
        await expectCode(shared.get("x.txt"), "not-found");
        await expectCode(shared.rm("x.txt"), "not-found");
      });

      it("deletes a folder with everything in it, and only that folder", async () => {
        await shared.put("gone/a.txt", "a");
        await shared.put("gone/sub/b.txt", "b");
        await shared.mkdir("gone/empty");
        await shared.put("gone-not/c.txt", "c");
        await shared.put("gone.txt", "d");
        await shared.rm("gone/");
        expect((await shared.list("")).map((e) => e.path)).toEqual(["gone-not", "gone.txt"]);
        await expectCode(shared.get("gone/sub/b.txt"), "not-found");
      });

      it("deletes an empty folder made by mkdir", async () => {
        await shared.mkdir("e");
        await shared.rm("e/");
        expect(await shared.list("")).toEqual([]);
      });

      it("refuses the root, and a folder that is not there", async () => {
        await shared.put("keep.txt", "k");
        await expectCode(shared.rm(""), "invalid-path");
        await expectCode(shared.rm("nope/"), "not-found");
        expect((await shared.list("")).map((e) => e.path)).toEqual(["keep.txt"]);
      });

      it("a file path does not delete a folder of that name", async () => {
        await shared.put("dir/f.txt", "f");
        await expectCode(shared.rm("dir"), "not-found");
        expect(text((await shared.get("dir/f.txt")).body)).toBe("f");
      });
    });

    describe("move", () => {
      it("renames a file in the same folder", async () => {
        await shared.put("docs/old.txt", "content");
        await shared.move("docs/old.txt", "docs/new.txt");
        expect(text((await shared.get("docs/new.txt")).body)).toBe("content");
        await expectCode(shared.get("docs/old.txt"), "not-found");
        expect((await shared.list("docs")).map((e) => e.path)).toEqual(["docs/new.txt"]);
      });

      it("moves a file into another folder, which then exists", async () => {
        await shared.put("a.txt", "a");
        await shared.move("a.txt", "x/y/a.txt");
        expect(text((await shared.get("x/y/a.txt")).body)).toBe("a");
        await expectCode(shared.get("a.txt"), "not-found");
      });

      it("moves a folder with everything in it: files, subfolders and empty folders", async () => {
        await shared.put("old/a.txt", "a");
        await shared.put("old/sub/deep/b.txt", "b");
        await shared.mkdir("old/empty");
        await shared.put("old-not/c.txt", "c");
        await shared.move("old/", "new/");
        expect(text((await shared.get("new/a.txt")).body)).toBe("a");
        expect(text((await shared.get("new/sub/deep/b.txt")).body)).toBe("b");
        expect((await shared.list("new")).map((e) => e.path)).toEqual(["new/empty", "new/sub", "new/a.txt"]);
        expect((await shared.list("")).map((e) => e.path)).toEqual(["new", "old-not"]);
        await expectCode(shared.get("old/a.txt"), "not-found");
      });

      it("renames an empty folder", async () => {
        await shared.mkdir("e");
        await shared.move("e/", "f/");
        expect(await shared.list("")).toEqual([{ path: "f", kind: "folder" }]);
      });

      it("moves a folder into another folder", async () => {
        await shared.put("src/a.txt", "a");
        await shared.mkdir("dst");
        await shared.move("src/", "dst/src/");
        expect(text((await shared.get("dst/src/a.txt")).body)).toBe("a");
        expect((await shared.list("")).map((e) => e.path)).toEqual(["dst"]);
      });

      it("refuses a taken destination (exists) and changes nothing", async () => {
        await shared.put("a.txt", "a");
        await shared.put("b.txt", "b");
        await expectCode(shared.move("a.txt", "b.txt"), "exists");
        await shared.put("f1/x.txt", "1");
        await shared.put("f2/y.txt", "2");
        await expectCode(shared.move("f1/", "f2/"), "exists");
        expect(text((await shared.get("b.txt")).body)).toBe("b");
        expect(text((await shared.get("f1/x.txt")).body)).toBe("1");
        expect(text((await shared.get("f2/y.txt")).body)).toBe("2");
      });

      it("refuses a missing source, a folder into itself, the root, and a file-to-folder mix", async () => {
        await shared.put("d/a.txt", "a");
        await expectCode(shared.move("nope.txt", "z.txt"), "not-found");
        await expectCode(shared.move("nope/", "z/"), "not-found");
        await expectCode(shared.move("d/", "d/inner/"), "invalid-move");
        await expectCode(shared.move("d/", "d/"), "invalid-move");
        await expectCode(shared.move("", "x/"), "invalid-path");
        await expectCode(shared.move("d/", ""), "invalid-path");
        await expectCode(shared.move("d/a.txt", "d/b/"), "invalid-path");
        await expectCode(shared.move("d/", "d2"), "invalid-path");
        expect((await shared.list("d")).map((e) => e.path)).toEqual(["d/a.txt"]);
      });

      it("does not move a look-alike sibling with the folder", async () => {
        await shared.put("d/a.txt", "a");
        await shared.put("d2/b.txt", "b");
        await shared.move("d/", "e/");
        expect((await shared.list("")).map((e) => e.path)).toEqual(["d2", "e"]);
      });
    });

    describe("upload of a folder tree", () => {
      it("keeps the tree, including empty folders and nested files", async () => {
        const written = await shared.upload("drop/", [
          { path: "readme.md", body: "# hi" },
          { path: "src/main.ts", body: "main" },
          { path: "src/lib/util.ts", body: Uint8Array.from([1, 2, 3]) },
          { path: "assets", folder: true },
        ]);
        expect(written).toEqual(["drop/readme.md", "drop/src/main.ts", "drop/src/lib/util.ts", "drop/assets"]);
        expect(text((await shared.get("drop/src/main.ts")).body)).toBe("main");
        expect([...(await shared.get("drop/src/lib/util.ts")).body]).toEqual([1, 2, 3]);
        expect((await shared.list("drop")).map((e) => `${e.kind}:${e.path}`)).toEqual([
          "folder:drop/assets",
          "folder:drop/src",
          "file:drop/readme.md",
        ]);
      });

      it("can upload at the root", async () => {
        await shared.upload("", [{ path: "top/a.txt", body: "a" }]);
        expect(text((await shared.get("top/a.txt")).body)).toBe("a");
      });

      it("checks every entry first: one bad path writes nothing", async () => {
        const bad = [
          { path: "../escape.txt", body: "x" },
          { path: "/abs.txt", body: "x" },
          { path: "a/../../b.txt", body: "x" },
          { path: "ok/../b.txt", body: "x" },
        ];
        for (const entry of bad) {
          await expectCode(shared.upload("drop", [{ path: "good.txt", body: "g" }, entry]), "invalid-path");
        }
        await expectCode(shared.upload("../out", [{ path: "a.txt", body: "a" }]), "invalid-path");
        await expectCode(shared.upload("/abs", [{ path: "a.txt", body: "a" }]), "invalid-path");
        await expectCode(shared.upload("drop", [{ path: "a.txt", body: "1" }, { path: "a.txt", body: "2" }]), "invalid-path");
        await expectCode(shared.upload("drop", [{ path: "dir/", body: "x" }]), "is-folder");
        expect(await shared.list("")).toEqual([]);
      });
    });

    describe("paths never escape the Shared folder", () => {
      const bad = [
        "../outside.txt",
        "a/../../outside.txt",
        "a/../b.txt",
        "./a.txt",
        "a/./b.txt",
        "/etc/passwd",
        "/abs.txt",
        "a//b.txt",
        "..",
        "../",
        "a\\b.txt",
        "a\u0000b.txt",
        "a\nb.txt",
      ];

      it.each(bad)("refuses %j in every operation and writes nothing", async (path) => {
        await shared.put("keep.txt", "k");
        const calls: Promise<unknown>[] = [
          shared.get(path),
          shared.put(path, "x"),
          shared.list(path),
          shared.mkdir(path),
          shared.rm(path),
          shared.rm(`${path}/`),
          shared.move(path, "dest.txt"),
          shared.move("keep.txt", path),
        ];
        for (const call of calls) await expectCode(call, "invalid-path");
        expect((await shared.list("")).map((e) => e.path)).toEqual(["keep.txt"]);
        expect(text((await shared.get("keep.txt")).body)).toBe("k");
      });

      it("does not decode percent-escapes: %2e%2e is a name, not a parent", async () => {
        await shared.put("keep.txt", "k");
        await shared.put("%2e%2e/x.txt", "x");
        expect((await shared.list("")).map((e) => e.path)).toEqual(["%2e%2e", "keep.txt"]);
      });
    });
  });
}
