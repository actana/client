// Every flag the shipped skill teaches exists on the binary beside it (actana/client#11).
//
// `skill-verbs-exist.test.ts` holds the verbs. The same complaint has a second half: the skill
// told agents to pass `--no-enter` and `--wait-timeout 0` while the CLI answered `unknown flag`,
// so the flags on every `actana …` line the skill shows are run through the parser here.

import { describe, it, expect } from "vitest";
import { parseArgs } from "../kit/cli-args.ts";
import {
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_NAMES,
} from "../core/orchestration-skill-payload.ts";

/** Every `--flag` on a line of the skill that shows an `actana` invocation. */
function flagsTaught(): Array<{ skill: string; file: string; flag: string }> {
  const found: Array<{ skill: string; file: string; flag: string }> = [];
  for (const skill of ORCHESTRATION_SKILL_NAMES) {
    for (const [file, text] of Object.entries(ORCHESTRATION_SKILL_FILES[skill] ?? {})) {
      for (const line of text.split("\n")) {
        if (!/\bactana\s+[a-z]/.test(line)) continue;
        for (const match of line.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) {
          found.push({ skill, file, flag: match[1]! });
        }
      }
    }
  }
  return found;
}

describe("the skill only teaches flags this binary has", () => {
  it("finds flags to check, so the sweep cannot go vacuous", () => {
    expect(flagsTaught().length).toBeGreaterThan(5);
  });

  it("parses every flag it shows on an actana line", () => {
    // `await.sh` is a program of its own with its own flags (`--kill`), declared as `case` arms.
    const own = new Set(
      [...(ORCHESTRATION_SKILL_FILES["actana-sessions"]?.["await.sh"] ?? "").matchAll(/^\s*(--[a-z-]+)\)/gm)].map(
        (m) => m[1]!,
      ),
    );
    expect(own.size, "await.sh declares no flags of its own, so the allowance is stale").toBeGreaterThan(0);
    for (const { skill, file, flag } of flagsTaught()) {
      if (file === "await.sh" && own.has(flag)) continue;
      // A value is supplied so a flag that takes one is not reported as missing it.
      const parsed = parseArgs([flag, "1"]);
      expect(parsed.unknown, `${skill}/${file} teaches ${flag}, which this build does not know`).not.toContain(
        flag,
      );
    }
  });

  it("parses the flags Control's CLI ships and the skill may teach", () => {
    for (const flag of ["--enter", "--no-enter", "--wait", "--wait-timeout", "--await-prompt"]) {
      expect(parseArgs([flag, "1"]).unknown, flag).toEqual([]);
    }
  });
});
