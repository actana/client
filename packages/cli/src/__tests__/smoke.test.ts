import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runClient } from "../entry.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(here, "../../package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

describe("@actana/cli scaffold", () => {
  it("lists @actana/sdk as its only @actana dependency", () => {
    const actanaDeps = Object.keys(pkg.dependencies ?? {}).filter((name) =>
      name.startsWith("@actana/"),
    );
    expect(actanaDeps).toEqual(["@actana/sdk"]);
  });

  it("runClient exits zero", async () => {
    await expect(runClient([])).resolves.toBe(0);
  });
});
