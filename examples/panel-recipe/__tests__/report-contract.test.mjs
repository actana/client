// The report paths and the prompt block are client PR 41's, word for word. The example copies them
// (the SDK does not export them), so this file pins every string and reads the CLI's source as TEXT
// to catch a drift: it imports nothing from the CLI.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROMPT_BLOCK_VERSION,
  REPORT_END_MARKER,
  appendPromptBlock,
  archivedTaskName,
  buildPromptBlock,
  classifyTaskEntry,
  reportIsComplete,
  reportWithoutMarker,
  sessionReportPath,
  sessionReportPathFromHome,
  statusForResult,
  taskFolder,
  taskResultPath,
} from "../src/report-contract.mjs";

const cliSource = readFileSync(fileURLToPath(new URL("../../../packages/cli/src/core/session-report.ts", import.meta.url)), "utf8");

const BLOCK_FOR_T_ABC_TURN_1 =
  "[Actana standard block v1] Your workspace is your home directory (~); go into a subfolder only when this prompt says so. " +
  "~/shared is shared with the operator and syncs within seconds. " +
  "When this turn is done, write your report to ~/shared/sessions/t-abc/report-1.md and make its last line exactly ACT-REPORT-END. " +
  "Never use sudo. [/Actana standard block v1]";

describe("the prompt block", () => {
  it("is PR 41's text for a Session turn", () => {
    expect(buildPromptBlock({ sessionId: "t-abc", turn: 1 })).toBe(BLOCK_FOR_T_ABC_TURN_1);
    expect(BLOCK_FOR_T_ABC_TURN_1).toHaveLength(355);
  });

  it("names the turn's own report file", () => {
    expect(buildPromptBlock({ sessionId: "s_9f2", turn: 3 })).toContain("~/shared/sessions/s_9f2/report-3.md");
  });

  it("is appended once, and a text that already has a block of any version is left alone", () => {
    const once = appendPromptBlock("do it", { sessionId: "a", turn: 2 });
    expect(once).toBe(`do it ${buildPromptBlock({ sessionId: "a", turn: 2 })}`);
    expect(appendPromptBlock(once, { sessionId: "a", turn: 2 })).toBe(once);
    expect(appendPromptBlock("x [Actana standard block v9] y", { sessionId: "a", turn: 2 })).toBe("x [Actana standard block v9] y");
  });

  it("matches the CLI's source, sentence by sentence", () => {
    for (const fragment of [
      "[Actana standard block v${PROMPT_BLOCK_VERSION}]",
      "Your workspace is your home directory (~); go into a subfolder only when this prompt says so. ",
      "~/shared is shared with the operator and syncs within seconds. ",
      "When this turn is done, write your report to ${path} and make its last line exactly ${REPORT_END_MARKER}. ",
      "Never use sudo. ${BLOCK_CLOSE}",
      "export const PROMPT_BLOCK_VERSION = 1;",
      'export const REPORT_END_MARKER = "ACT-REPORT-END";',
    ]) {
      expect(cliSource, fragment).toContain(fragment);
    }
    expect(PROMPT_BLOCK_VERSION).toBe(1);
    expect(REPORT_END_MARKER).toBe("ACT-REPORT-END");
  });
});

describe("the report paths", () => {
  it("are PR 41's", () => {
    expect(sessionReportPath("s1", 2)).toBe("sessions/s1/report-2.md");
    expect(sessionReportPathFromHome("s1", 2)).toBe("shared/sessions/s1/report-2.md");
    expect(taskFolder("T-1")).toBe("tasks/T-1/");
    expect(taskResultPath("T-1", { kind: "success" })).toBe("tasks/T-1/success.md");
    expect(taskResultPath("T-1", { kind: "fail" })).toBe("tasks/T-1/fail.md");
    expect(taskResultPath("T-1", { kind: "partial", n: 3 })).toBe("tasks/T-1/partial-3.md");
    expect(archivedTaskName(2, "success.md")).toBe("attempt-2-success.md");
  });

  it("match the CLI's source", () => {
    for (const fragment of [
      "`sessions/${sessionId}/report-${turn}.md`",
      "`shared/${sessionReportPath(sessionId, turn)}`",
      "`tasks/${taskId}/`",
      "`partial-${result.n}.md`",
      '"success.md"',
      '"fail.md"',
      "`tasks/${taskId}/${name}`",
      "`attempt-${attempt}-${name}`",
    ]) {
      expect(cliSource, fragment).toContain(fragment);
    }
  });

  it("tell a current result, an archived one, a log and anything else apart", () => {
    expect(classifyTaskEntry("success.md")).toEqual({ kind: "result", result: { kind: "success" } });
    expect(classifyTaskEntry("partial-12.md")).toEqual({ kind: "result", result: { kind: "partial", n: 12 } });
    expect(classifyTaskEntry("attempt-1-fail.md")).toEqual({ kind: "archived", attempt: 1, result: { kind: "fail" } });
    expect(classifyTaskEntry("attempt-3.log")).toEqual({ kind: "log", attempt: 3 });
    expect(classifyTaskEntry("partial-0.md")).toEqual({ kind: "other" });
    expect(classifyTaskEntry("notes.md")).toEqual({ kind: "other" });
  });

  it("map a result to the Task status the Panel uses", () => {
    expect(statusForResult({ kind: "success" })).toBe("done");
    expect(statusForResult({ kind: "fail" })).toBe("failed");
    expect(statusForResult({ kind: "partial", n: 1 })).toBe("partial");
  });
});

describe("a finished report", () => {
  it("ends with the marker as its last non-blank line, exactly", () => {
    expect(reportIsComplete("# r\n\nACT-REPORT-END\n")).toBe(true);
    expect(reportIsComplete("# r\r\nACT-REPORT-END  \r\n\r\n")).toBe(true);
    expect(reportIsComplete("# r\nACT-REPORT-END\nmore")).toBe(false);
    expect(reportIsComplete("# r\nACT-REPORT-END-NOT")).toBe(false);
    expect(reportIsComplete("")).toBe(false);
  });

  it("is read without its marker line", () => {
    expect(reportWithoutMarker("# r\n\nbody\n\nACT-REPORT-END\n")).toBe("# r\n\nbody");
    expect(reportWithoutMarker("no marker here")).toBe("no marker here");
  });
});
