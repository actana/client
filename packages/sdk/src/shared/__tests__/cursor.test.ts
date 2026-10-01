import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../cursor.ts";
import { CoreSharedError } from "../types.ts";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof CoreSharedError ? error.code : "other";
  }
  return undefined;
};

describe("the S3 change cursor", () => {
  it("round-trips a snapshot and is an opaque string", () => {
    const snapshot = new Map([["a.txt", "file:1:2:e"], ["d", "folder:0:3:e"]]);
    const cursor = encodeCursor("cores/a/", snapshot);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("a.txt");
    expect([...decodeCursor("cores/a/", cursor)]).toEqual([...snapshot]);
  });

  it("refuses another prefix's cursor, a changed one, and non-cursors", () => {
    const cursor = encodeCursor("cores/a/", new Map());
    expect(code(() => decodeCursor("cores/b/", cursor))).toBe("invalid-cursor");
    expect(code(() => decodeCursor("cores/a/", cursor.slice(0, -4)))).toBe("invalid-cursor");
    expect(code(() => decodeCursor("cores/a/", 42))).toBe("invalid-cursor");
    expect(code(() => decodeCursor("cores/a/", ""))).toBe("invalid-cursor");
  });
});
