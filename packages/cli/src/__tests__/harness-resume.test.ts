// The command `session resume` types per harness, held to Control's table (actana/client#11).
//
// Control's own test compares these with the Core's spawn plan through `@actana/shared`, which this repository
// does not have; what it pins is these strings, so they are pinned here as literals. Pi's resume flag is
// `--session`, as it is in Control: a `--resume` there started a fresh Pi that never saw the conversation.

import { describe, it, expect } from "vitest";
import { harnessResumeCommand } from "../core/harness-resume.ts";
import { KNOWN_HARNESSES } from "../core/session-gateway.ts";

const ID = "00000000-0000-4000-8000-000000000001";

describe("harnessResumeCommand", () => {
  it.each([
    ["claude-code", `claude --resume ${ID}`],
    ["codex", `codex resume ${ID} --enable hooks`],
    ["cursor-cli", `cursor-agent --resume ${ID}`],
    ["opencode", `opencode --session ${ID}`],
    ["pi", `pi --session ${ID}`],
  ] as const)("resumes %s with Control's command", (harness, expected) => {
    expect(harnessResumeCommand(harness, ID)).toBe(expected);
  });

  it("covers every harness this build knows", () => {
    for (const harness of KNOWN_HARNESSES) {
      expect(harnessResumeCommand(harness, "abc"), harness).toContain("abc");
    }
  });

  it("appends the auto-mode flag only when asked", () => {
    expect(harnessResumeCommand("pi", "abc", { dangerouslySkipPermissions: false })).toBe("pi --session abc");
    expect(harnessResumeCommand("claude-code", "abc", { dangerouslySkipPermissions: true })).toContain(
      "--dangerously-skip-permissions",
    );
  });
});
