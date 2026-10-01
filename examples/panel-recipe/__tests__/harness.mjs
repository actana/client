// What the fake Core's "harness" does with the prompt it was typed: find the report path the
// standard block names (`~/shared/...`) and write the report there, through the Shared folder.
import { REPORT_END_MARKER } from "../src/report-contract.mjs";

/** The `~/shared/<path>` file the block tells the harness to write, as a Shared-relative path. */
export function reportPathFromPrompt(prompt) {
  const match = /write your report to ~\/shared\/(\S+?) and make its last line exactly ACT-REPORT-END/.exec(prompt ?? "");
  return match === null ? null : match[1];
}

/** A harness that writes a finished report where the block says, after `delayMs`. */
export function reportingHarness(shared, { body = "All done.", delayMs = 5, then } = {}) {
  return async ({ prompt, sessionId }) => {
    const path = reportPathFromPrompt(prompt);
    if (path === null) throw new Error(`the typed prompt names no report file: ${prompt}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await shared.put(path, `# Report for ${sessionId}\n\n${body}\n\n${REPORT_END_MARKER}\n`);
    then?.();
  };
}
