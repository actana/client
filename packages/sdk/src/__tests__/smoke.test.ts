import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../version.ts";

describe("@actana/sdk scaffold", () => {
  it("exports a version placeholder", () => {
    expect(SDK_VERSION).toBe("0.5.0");
  });
});
