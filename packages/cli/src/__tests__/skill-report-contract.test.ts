// The shipped orchestration skills document the report contract of client #8, and only that one.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_NAMES,
} from "../core/orchestration-skill-payload.ts";
import { REPORT_END_MARKER, sessionReportFolder, sessionReportPath } from "../core/session-report.ts";

const SESSIONS = ORCHESTRATION_SKILL_FILES["actana-sessions"]!["SKILL.md"]!;
const AWAIT_SH = ORCHESTRATION_SKILL_FILES["actana-sessions"]!["await.sh"]!;
const SUBAGENT = ORCHESTRATION_SKILL_FILES["actana-subagent"]!["SKILL.md"]!;

describe("the retired conventions are gone from every shipped file", () => {
  const retired: Array<[string, RegExp]> = [
    ["the .actana/reports folder", /\.actana\/reports/],
    ["a -r<turn> report name", /-r<turn>|-r1\.md/],
    ["core exec", /core exec/],
    ["polling a file for its tail", /tail -n/],
    ["a home-relative report path", /home-relative/],
  ];

  for (const skill of ["actana-sessions", "actana-subagent"]) {
    for (const [file, text] of Object.entries(ORCHESTRATION_SKILL_FILES[skill] ?? {})) {
      for (const [what, pattern] of retired) {
        it(`${skill}/${file} no longer teaches ${what}`, () => {
          expect(text).not.toMatch(pattern);
        });
      }
    }
  }

  it("covers every skill this build ships", () => {
    expect([...ORCHESTRATION_SKILL_NAMES].sort()).toEqual(["actana-sessions", "actana-subagent"]);
  });
});

describe("the orchestrator skill teaches the Shared-folder contract", () => {
  it("names the Session and Task report paths, and the re-run rename", () => {
    expect(SESSIONS).toContain("sessions/<session-id>/report-<turn>.md");
    for (const name of ["success.md", "fail.md", "partial-<n>.md", "attempt-<n>.log", "attempt-<n>-"]) {
      expect(SESSIONS, name).toContain(name);
    }
  });

  it("agrees with the path helpers the CLI itself uses", () => {
    expect(sessionReportPath("<session-id>", 1).replace("report-1.md", "report-<turn>.md")).toBe(
      "sessions/<session-id>/report-<turn>.md",
    );
    expect(sessionReportFolder("<id>")).toBe("sessions/<id>/");
    expect(SESSIONS).toContain(sessionReportFolder("<id>"));
  });

  it("settles on the last line, through wait, and reads with shared get", () => {
    expect(SESSIONS).toContain(REPORT_END_MARKER);
    expect(SESSIONS).toContain("actana session wait");
    expect(SESSIONS).toContain("actana shared get");
    expect(SESSIONS).toContain("Shared folder");
    expect(SESSIONS).toContain("watcher");
  });

  it("says the Core appends the block, and does not ask for a path in the prompt", () => {
    expect(SESSIONS).toContain("The Core appends a standard block");
    expect(SESSIONS).toContain("Do not name a path of your own");
  });
});

describe("the sub-agent skill writes where the block says", () => {
  it("names the shared path, the Task files and the end marker", () => {
    expect(SUBAGENT).toContain("~/shared/sessions/<session-id>/report-<turn>.md");
    expect(SUBAGENT).toContain("~/shared/tasks/<task-id>/");
    expect(SUBAGENT).toContain("`ACT-REPORT-END`");
    expect(SUBAGENT).toContain("standard block");
  });

  it("still forbids starting Sessions", () => {
    expect(SUBAGENT).toContain("must not start Sessions");
  });
});

describe("await.sh waits with session wait and reads with shared get", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "await-sh-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in `actana` that records every call and answers `session wait` and `shared get`. */
  function stubActana(opts: { failFor?: string } = {}): { bin: string; calls: string } {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const calls = path.join(dir, "calls.log");
    const stub = [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${calls}"`,
      'args=("$@")',
      'noun=""; verb=""',
      'for a in "${args[@]}"; do case "$a" in session|shared|core) [ -z "$noun" ] && noun="$a" ;; esac; done',
      'if [ "$noun" = session ] && [[ " $* " == *" wait "* ]]; then',
      '  id=""; turn=1; take=0',
      '  for a in "${args[@]}"; do',
      '    if [ "$take" = 1 ]; then id="$a"; take=0; fi',
      '    [ "$a" = wait ] && take=1',
      "  done",
      '  prev=""; for a in "${args[@]}"; do [ "$prev" = --turn ] && turn="$a"; prev="$a"; done',
      `  if [ "$id" = "${opts.failFor ?? "__none__"}" ]; then echo "actana session wait: gave up after 1800 seconds" >&2; exit 1; fi`,
      '  echo "sessions/$id/report-$turn.md"; exit 0',
      "fi",
      'if [ "$noun" = shared ] && [[ " $* " == *" get "* ]]; then',
      '  dest="${args[$((${#args[@]}-1))]}"; printf "report text\\nACT-REPORT-END\\n" > "$dest"; exit 0',
      "fi",
      'if [ "$noun" = session ] && [[ " $* " == *" kill "* ]]; then exit 0; fi',
      'echo "stub actana: unexpected call: $*" >&2; exit 99',
    ].join("\n");
    fs.writeFileSync(path.join(bin, "actana"), `${stub}\n`, { mode: 0o755 });
    return { bin, calls };
  }

  function run(args: string[], env: { bin: string }) {
    const script = path.join(dir, "await.sh");
    fs.writeFileSync(script, AWAIT_SH);
    return spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${env.bin}:${process.env.PATH ?? ""}` },
    });
  }

  it("settles every lane through `session wait`, saves each report under the Session's own name, and never uses core exec", () => {
    const stub = stubActana();
    const out = path.join(dir, "out");

    const result = run(["--out", out, "--timeout", "30", "s1", "s2:2"], stub);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(out, "s1-report.md"), "utf8")).toContain(REPORT_END_MARKER);
    expect(fs.readFileSync(path.join(out, "s2-report-2.md"), "utf8")).toContain(REPORT_END_MARKER);
    expect(result.stdout.trim().split("\n").map((l) => l.split("\t").slice(0, 2).join(" ")).sort()).toEqual([
      "s1 saved",
      "s2 saved",
    ]);
    const calls = fs.readFileSync(stub.calls, "utf8");
    expect(calls).toContain("session wait s1 --wait-timeout 30");
    expect(calls).toContain("session wait s2 --wait-timeout 30 --turn 2");
    expect(calls).toContain("shared get sessions/s2/report-2.md");
    expect(calls).not.toContain("core exec");
  });

  it("exits 1 and says which lane did not settle, saving the others", () => {
    const stub = stubActana({ failFor: "s2" });
    const out = path.join(dir, "out");

    const result = run(["--out", out, "s1", "s2"], stub);

    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(out, "s1-report.md"))).toBe(true);
    expect(fs.existsSync(path.join(out, "s2-report.md"))).toBe(false);
    expect(result.stdout).toContain("s2\tfailed\tactana session wait: gave up after 1800 seconds");
  });

  it("kills a Session only after its report is on disk", () => {
    const stub = stubActana();

    const result = run(["--out", path.join(dir, "out"), "--kill", "s1"], stub);

    expect(result.status, result.stderr).toBe(0);
    const calls = fs.readFileSync(stub.calls, "utf8").trim().split("\n");
    const got = calls.findIndex((c) => c.includes("shared get"));
    const killed = calls.findIndex((c) => c.includes("session kill s1"));
    expect(got).toBeGreaterThanOrEqual(0);
    expect(killed).toBeGreaterThan(got);
  });

  it("refuses two lanes that would be saved as one file, before touching any Session", () => {
    const stub = stubActana();

    const result = run(["s1", "s1"], stub);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("would both be saved as");
    expect(fs.existsSync(stub.calls)).toBe(false);
  });

  it("refuses a lane with a turn that is not a number from 1", () => {
    const stub = stubActana();
    for (const lane of ["s1:0", "s1:x", "s1:"]) {
      expect(run([lane], stub).status, lane).toBe(2);
    }
  });
});
