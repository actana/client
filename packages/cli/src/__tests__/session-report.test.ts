// The report contract's paths, end marker and prompt block (client #8).

import { describe, expect, it } from "vitest";
import {
  appendPromptBlock,
  archivedTaskName,
  buildPromptBlock,
  classifyTaskEntry,
  PROMPT_BLOCK_VERSION,
  REPORT_END_MARKER,
  reportIsComplete,
  reportTurns,
  sessionReportPath,
  sessionReportPathFromHome,
  sessionReportTurn,
  taskAttemptLogPath,
  taskResultPath,
  turnForSend,
} from "../core/session-report.ts";

// Control PR 621, packages/core/src/__tests__/prompt-standard-block.test.ts, verbatim: the text the
// Core appends to a starting prompt. Not rewritten here; if this test and the Core disagree, the
// harness is told two things.
const CONTROL_PR_621_BLOCK =
  "[Actana standard block v1] Your workspace is your home directory (~); go into a subfolder only when this prompt says so. ~/shared is shared with the operator and syncs within seconds. When this turn is done, write your report to ~/shared/sessions/t-abc/report-1.md and make its last line exactly ACT-REPORT-END. Never use sudo. [/Actana standard block v1]";

describe("the prompt block", () => {
  it("is the Core's text, word for word (control PR 621)", () => {
    expect(buildPromptBlock({ sessionId: "t-abc", turn: 1 })).toBe(CONTROL_PR_621_BLOCK);
    expect(PROMPT_BLOCK_VERSION).toBe(1);
  });

  it("names the turn's own report path from the home directory", () => {
    expect(buildPromptBlock({ sessionId: "t-abc", turn: 3 })).toContain(
      "write your report to ~/shared/sessions/t-abc/report-3.md and",
    );
  });

  it("goes after the text, once, and is not stacked on a text that carries one", () => {
    const once = appendPromptBlock("fix the bug", { sessionId: "t-abc", turn: 2 });
    expect(once.startsWith("fix the bug [Actana standard block v1]")).toBe(true);
    expect(once.match(/\[Actana standard block/g)).toHaveLength(1);
    expect(appendPromptBlock(once, { sessionId: "t-abc", turn: 2 })).toBe(once);
  });
});

describe("Session report paths", () => {
  it("are sessions/<id>/report-<turn>.md in the Shared folder, shared/… from the home", () => {
    expect(sessionReportPath("s1", 3)).toBe("sessions/s1/report-3.md");
    expect(sessionReportPathFromHome("s1", 3)).toBe("shared/sessions/s1/report-3.md");
  });

  it("read a turn back from a file name, and nothing else", () => {
    expect(sessionReportTurn("report-12.md")).toBe(12);
    for (const name of ["report-0.md", "report-01.md", "report-1.md.bak", "report-.md", "xreport-1.md", "report-1.txt"]) {
      expect(sessionReportTurn(name), name).toBeNull();
    }
  });

  it("number a follow-up after the highest report, and never as turn 1", () => {
    expect(reportTurns(["report-1.md", "notes.md", "report-3.md"])).toEqual([1, 3]);
    expect(turnForSend([])).toBe(2);
    expect(turnForSend(["report-1.md"])).toBe(2);
    expect(turnForSend(["report-1.md", "report-4.md"])).toBe(5);
  });
});

describe("Task report paths", () => {
  it("are tasks/<id>/success.md, fail.md or partial-<n>.md, with an attempt log", () => {
    expect(taskResultPath("t9", { kind: "success" })).toBe("tasks/t9/success.md");
    expect(taskResultPath("t9", { kind: "fail" })).toBe("tasks/t9/fail.md");
    expect(taskResultPath("t9", { kind: "partial", n: 2 })).toBe("tasks/t9/partial-2.md");
    expect(taskAttemptLogPath("t9", 3)).toBe("tasks/t9/attempt-3.log");
  });

  it("rename an older result to attempt-<n>-<name> on a re-run, and tell the names apart", () => {
    expect(archivedTaskName(1, "success.md")).toBe("attempt-1-success.md");
    expect(classifyTaskEntry("success.md")).toEqual({ kind: "result", result: { kind: "success" } });
    expect(classifyTaskEntry("partial-2.md")).toEqual({ kind: "result", result: { kind: "partial", n: 2 } });
    expect(classifyTaskEntry("attempt-1-success.md")).toEqual({
      kind: "archived",
      attempt: 1,
      result: { kind: "success" },
    });
    expect(classifyTaskEntry("attempt-2-partial-1.md")).toEqual({
      kind: "archived",
      attempt: 2,
      result: { kind: "partial", n: 1 },
    });
    expect(classifyTaskEntry("attempt-3.log")).toEqual({ kind: "log", attempt: 3 });
    for (const name of ["notes.md", "attempt-x.log", "attempt-1-notes.md", "attempt-1.md"]) {
      expect(classifyTaskEntry(name), name).toEqual({ kind: "other" });
    }
  });
});

describe("the end marker", () => {
  it("finishes a report only as its last non-blank line", () => {
    expect(reportIsComplete(`done\n${REPORT_END_MARKER}`)).toBe(true);
    expect(reportIsComplete(`done\r\n${REPORT_END_MARKER}\r\n\n  \n`)).toBe(true);
    expect(reportIsComplete(`done\n${REPORT_END_MARKER}   `)).toBe(true);
  });

  it("is not met by the marker anywhere else, or as a part of a line", () => {
    expect(reportIsComplete(`${REPORT_END_MARKER}\nmore work`)).toBe(false);
    expect(reportIsComplete("```\nACT-REPORT-END\n```")).toBe(false);
    expect(reportIsComplete(`see ${REPORT_END_MARKER}`)).toBe(false);
    expect(reportIsComplete(` ${REPORT_END_MARKER}`)).toBe(false);
    expect(reportIsComplete("")).toBe(false);
  });
});
