import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(join(repoRoot, ".github/workflows/changeset-required.yml"), "utf8");

// The job's `if:` is a GitHub expression, and the subset used here (`==`, `&&`, `!`, parentheses,
// single-quoted strings, dotted property reads) is also valid JavaScript, so the expression
// from the real workflow file is evaluated against a fake `github` context.
function jobCondition() {
  const match = workflow.match(/^ {4}if: >-\n((?: {6}.+\n)+)/m) ?? workflow.match(/^ {4}if: (.+)\n/m);
  expect(match, "the verify job has an `if:`").not.toBeNull();
  return match[1].replace(/\s*\n\s*/g, " ").trim();
}

function runs({ draft = false, headRef, headRepo = "actana/client" }) {
  const github = {
    head_ref: headRef,
    repository: "actana/client",
    event: { pull_request: { draft, head: { repo: { full_name: headRepo } } } },
  };
  return new Function("github", `return (${jobCondition()});`)(github);
}

describe("changeset-required.yml", () => {
  it("skips the Version Packages PR from this repository's changeset-release/main", () => {
    expect(runs({ headRef: "changeset-release/main" })).toBe(false);
  });

  it("still runs for every other branch of this repository", () => {
    for (const headRef of ["feat/10-sdk-session-id", "fix/28-release-pr-checks", "changeset-release/other", "changeset-release/main-2", "main"]) {
      expect(runs({ headRef }), headRef).toBe(true);
    }
  });

  it("still runs for a fork branch that is named changeset-release/main", () => {
    expect(runs({ headRef: "changeset-release/main", headRepo: "someone/client" })).toBe(true);
  });

  it("still skips a draft PR, as it did before", () => {
    expect(runs({ draft: true, headRef: "feat/x" })).toBe(false);
  });

  it("names no branch other than changeset-release/main, and says why in a comment", () => {
    const branches = [...workflow.matchAll(/head_ref\s*[=!]=\s*'([^']+)'/g)].map((m) => m[1]);
    expect(branches).toEqual(["changeset-release/main"]);
    expect(workflow).toMatch(/# .*consumes/);
  });

  it("keeps the Require changeset step itself unconditional on the branch", () => {
    const step = workflow.slice(workflow.indexOf("- name: Require changeset"));
    expect(step).toContain("if: steps.packages.outputs.touched == 'true'");
    expect(step).not.toContain("head_ref");
  });
});
