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
