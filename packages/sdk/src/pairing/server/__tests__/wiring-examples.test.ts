import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { page03WiringExamples } from "../wiring-examples.ts";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("page 03 wiring examples", () => {
  it("exports the snippet fixture", () => {
    expect(page03WiringExamples).toBeTypeOf("function");
  });

  it("typechecks the Control and Search snippets", () => {
    execFileSync("npm", ["run", "typecheck"], { cwd: sdkRoot, stdio: "pipe" });
  });
});
