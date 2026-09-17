import { describe, expect, it } from "vitest";
import { formatSearchPairSuccessLine, grantFromPairStatus } from "../search-pair-results.ts";

describe("formatSearchPairSuccessLine", () => {
  it("formats scope and knowledge-base count", () => {
    expect(formatSearchPairSuccessLine("docs", { scope: "read", kbCount: 2 })).toBe(
      "✓ paired Search docs  (scope read · 2 knowledge bases)",
    );
  });

  it("formats singular and all-kb grants", () => {
    expect(formatSearchPairSuccessLine("ops", { scope: "write", kbCount: 1 })).toBe(
      "✓ paired Search ops  (scope write · 1 knowledge base)",
    );
    expect(formatSearchPairSuccessLine("all", { scope: "admin", kbCount: null })).toBe(
      "✓ paired Search all  (scope admin · all knowledge bases)",
    );
  });
});

describe("grantFromPairStatus", () => {
  it("reads scope and kb count from pair status", () => {
    expect(grantFromPairStatus({ scope: "read", kbIds: ["kb-1", "kb-2"] })).toEqual({
      scope: "read",
      kbCount: 2,
    });
    expect(grantFromPairStatus({ scope: "admin", kbIds: null })).toEqual({
      scope: "admin",
      kbCount: null,
    });
  });
});
