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
  });
}
