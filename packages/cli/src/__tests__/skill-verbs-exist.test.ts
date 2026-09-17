// Every verb the shipped skill teaches exists on the binary beside it (#288).

import { describe, it, expect } from "vitest";
import { CLIENT_NOUNS, clientHelp } from "../run-client.ts";
import {
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_NAMES,
} from "../core/orchestration-skill-payload.ts";

function namesTaughtBy(skillName: string): string[] {
  const files = ORCHESTRATION_SKILL_FILES[skillName] ?? {};
  const text = Object.values(files).join("\n");
  const names = new Set<string>();
  for (const match of text.matchAll(/\bactana\s+([a-z][a-z-]*)/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

function namesTaughtBySkill(): string[] {
  return namesTaughtBy("actana-sessions");
}

function namesInHelp(): string[] {
  const names = new Set<string>();
  for (const heading of ["Cores"]) {
    const block = clientHelp().split(new RegExp(`^${heading}$`, "m"))[1]?.split(/\n\s*\n/)[0] ?? "";
    for (const line of block.split("\n")) {
      const match = /^ {2}([a-z][a-z-]*)/.exec(line);
      if (match) names.add(match[1]!);
    }
  }
  return [...names].sort();
}

describe("the skill only teaches verbs this binary has (#288)", () => {
  it("reads every skill this build ships, not just the first", () => {
    expect([...ORCHESTRATION_SKILL_NAMES].length).toBeGreaterThan(1);
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      const files = ORCHESTRATION_SKILL_FILES[skillName] ?? {};
      expect(Object.keys(files).length, `${skillName} has no files in the payload`).toBeGreaterThan(0);
    }
  });

  it("finds something to check", () => {
    const taught = namesTaughtBySkill();
    expect(taught.length).toBeGreaterThan(3);
    expect(taught).toContain("core");
    expect(taught).toContain("session");
  });

  it("teaches no name the CLI does not answer to, in any shipped skill", () => {
    const known = new Set([...namesInHelp(), ...CLIENT_NOUNS, "daemon", "help", "pair"]);
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      for (const name of namesTaughtBy(skillName)) {
        expect(
          known.has(name),
          `${skillName} teaches \`actana ${name}\`, which this build has no case for`,
        ).toBe(true);
      }
    }
  });

  it("teaches the client nouns, which is the point of it on a Core", () => {
    const taught = new Set(namesTaughtBySkill());
    for (const noun of CLIENT_NOUNS) {
      expect(taught.has(noun), `the skill never shows \`actana ${noun}\``).toBe(true);
    }
  });

  it("no longer tells an agent that an empty `core ls` means nobody paired the machine", () => {
    const text = ORCHESTRATION_SKILL_FILES["actana-sessions"]?.["SKILL.md"] ?? "";
    expect(text).not.toContain("the operator has not\n  paired this machine with a Core");
    expect(text).toContain("a machine running a Core registers it automatically");
  });
});
