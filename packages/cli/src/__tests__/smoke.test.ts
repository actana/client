import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOT_HANDLED, clientHelp, runClient as runDispatcher } from "../index.ts";
import { runClient } from "../entry.ts";
import { EXIT_OK } from "../kit/exit-codes.ts";

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

  it("exports NOT_HANDLED and clientHelp from the package root", () => {
    expect(typeof NOT_HANDLED).toBe("symbol");
    expect(clientHelp()).toContain("Search");
    expect(typeof runDispatcher).toBe("function");
  });

  it("runClient prints general help and exits zero", async () => {
    await expect(runClient([])).resolves.toBe(EXIT_OK);
  });
});
