import { describe, expect, it } from "vitest";
import { EXIT_PAIR_CORE_ERROR, EXIT_PAIR_SEARCH_ERROR } from "../exit-codes.ts";

describe("pairing server error codes", () => {
  it("keeps EXIT_PAIR_CORE_ERROR at 20", () => {
    expect(EXIT_PAIR_CORE_ERROR).toBe(20);
  });

  it("adds EXIT_PAIR_SEARCH_ERROR as a sibling at 20", () => {
    expect(EXIT_PAIR_SEARCH_ERROR).toBe(20);
    expect(EXIT_PAIR_SEARCH_ERROR).toBe(EXIT_PAIR_CORE_ERROR);
  });
});
