import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("pg optional peer", () => {
  it("does not load pg when importing session or digest", async () => {
    const keysBefore = new Set(Object.keys(require.cache));
    await import("../session.ts");
    await import("../digest.ts");
    const loadedPg = [...Object.keys(require.cache)].some(
      (key) => key.includes("/node_modules/pg/") || key.endsWith("/node_modules/pg"),
    );
    const newKeys = [...Object.keys(require.cache)].filter((key) => !keysBefore.has(key));
    expect(loadedPg).toBe(false);
    expect(newKeys.some((key) => key.includes("/stores/postgres"))).toBe(false);
  });
});
