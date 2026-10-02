// The skill-target table and the Pi fan-out, held to Control's (actana/client#11).
//
// `actana harness skills`, and the quiet install in front of every noun, write the skill into each Harness's
// directory that is on the machine. The published table had four rows where Control's has five: Pi was missing,
// so `actana harness skills --json` answered eight rows instead of ten and a Pi user never got the skill from
// the CLI. The rows below are Control's, field for field.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HARNESS_SKILL_TARGETS } from "../core/harness-skill-targets.ts";
import { KNOWN_HARNESSES } from "../core/session-gateway.ts";
import { ensureOrchestrationSkill } from "../core/orchestration-skill.ts";
import { ORCHESTRATION_SKILL_FILES, ORCHESTRATION_SKILL_NAMES } from "../core/orchestration-skill-payload.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-skill-targets-"));
  dirs.push(dir);
  return dir;
}
let fixture: CliFixture | null = null;
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  fixture?.cleanup();
  fixture = null;
});

describe("the skill-target table", () => {
  it("has a row for every harness this build can run, and nothing else", () => {
    expect(HARNESS_SKILL_TARGETS.map((row) => row.harness).sort()).toEqual([...KNOWN_HARNESSES].sort());
  });

  it("carries Control's Pi row, field for field", () => {
    const pi = HARNESS_SKILL_TARGETS.find((row) => row.harness === "pi");
    expect(pi).toMatchObject({
      harness: "pi",
      kind: "skill-dir",
      homeMarkers: [".pi"],
      skillDir: ".agents/skills",
      verifiedOn: "2026-09-10",
    });
    expect(pi?.source).toContain("earendil-works/pi");
  });
});

describe("the fan-out reaches Pi", () => {
  const skillFile = (home: string, dir: string, skill: string, file: string) => path.join(home, dir, skill, file);

  it("writes the skill under ~/.agents/skills when ~/.pi is there", () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, ".pi"));
    const entries = ensureOrchestrationSkill(home, {});
    expect(entries.filter((e) => e.harness === "pi").map((e) => e.outcome)).not.toContain("absent");
    for (const skill of ORCHESTRATION_SKILL_NAMES) {
      for (const [file, bytes] of Object.entries(ORCHESTRATION_SKILL_FILES[skill] ?? {})) {
        expect(fs.readFileSync(skillFile(home, ".agents/skills", skill, file), "utf8")).toBe(bytes);
      }
    }
  });

  it("reports Pi as absent when there is no ~/.pi", () => {
    const entries = ensureOrchestrationSkill(tmp(), {});
    expect(entries.filter((e) => e.harness === "pi").every((e) => e.outcome === "absent")).toBe(true);
    expect(entries.filter((e) => e.harness === "pi")).toHaveLength(ORCHESTRATION_SKILL_NAMES.length);
  });

  it("follows PI_CODING_AGENT_DIR outside the home, with an absolute marker", () => {
    const home = tmp();
    const elsewhere = tmp();
    // Pi's own directory is somewhere else; ~/.pi does not exist.
    const entries = ensureOrchestrationSkill(home, { PI_CODING_AGENT_DIR: elsewhere });
    expect(entries.filter((e) => e.harness === "pi").map((e) => e.outcome)).not.toContain("absent");
  });

  it("does not take a missing PI_CODING_AGENT_DIR for Pi being here", () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, ".pi"));
    // Pi is moved elsewhere and that directory is absent: the marker follows the variable, not the old default.
    const entries = ensureOrchestrationSkill(home, { PI_CODING_AGENT_DIR: path.join(tmp(), "gone") });
    expect(entries.filter((e) => e.harness === "pi").every((e) => e.outcome === "absent")).toBe(true);
  });

  it("lists both Pi rows in `actana harness skills --json`", async () => {
    fixture = makeCliFixture();
    fs.mkdirSync(path.join(fixture.home, ".pi"), { recursive: true });
    const run = await fixture.run(["harness", "skills", "--json"]);
    expect(run.code, run.err.join("\n")).toBe(0);
    const rows = (JSON.parse(run.out.join("\n")) as { harnesses: Array<{ harness: string }> }).harnesses;
    expect(rows.filter((r) => r.harness === "pi")).toHaveLength(ORCHESTRATION_SKILL_NAMES.length);
    expect(new Set(rows.map((r) => r.harness))).toEqual(new Set(KNOWN_HARNESSES));
  });
});
