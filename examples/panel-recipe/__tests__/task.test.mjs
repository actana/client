// Step 4 against the fake Core: dispatch a Task, the "harness" writes a result file into the Shared
// folder, and the recipe turns it into a status and a comment, the way the Panel's dispatcher does
// (control PR 629). Times are real and small; every file is judged against the dispatch time.
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient } from "@actana/sdk/core";
import { startFakeCore } from "./fake-core.mjs";
import { createMemoryShared } from "./memory-shared.mjs";
import { archivePreviousResults, buildTaskPrompt, dispatchTask, MAX_REPORT_BYTES } from "../src/task.mjs";
import { REPORT_END_MARKER } from "../src/report-contract.mjs";

const clients = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

async function connect(core) {
  const client = new CoreClient({ url: "wss://fake-core.invalid", bearer: core.bearer, createSocket: core.createSocket });
  clients.push(client);
  await client.connect();
  return client;
}

const task = { id: "T-42", title: "Fix the flaky test", description: "It fails one run in ten." };
const fast = { pollMs: 5, exitGraceMs: 40, timeoutMs: 1_500, harness: "claude-code" };

/** A harness that writes `file` (default success.md) with `body` after a short delay. */
function writes(shared, file, body, { delayMs = 10, marker = true } = {}) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await shared.put(`tasks/${task.id}/${file}`, `${body}\n${marker ? `\n${REPORT_END_MARKER}\n` : ""}`);
  };
}

describe("step 4: dispatch a Task and turn its result files into status", () => {
  it.each([
    ["success.md", "done"],
    ["fail.md", "failed"],
    ["partial-2.md", "partial"],
  ])("%s moves the Task to %s, with the report as the comment", async (file, status) => {
    const shared = createMemoryShared();
    const core = startFakeCore({ harness: writes(shared, file, `# ${file}\n\nWhat I did.`) });
    const client = await connect(core);

    const out = await dispatchTask({ client, shared, task, ...fast });

    expect(out).toMatchObject({ taskId: "T-42", attempt: 1, sessionId: "sess-1", status, resultFile: file, sourceFile: `attempt-1-${file}` });
    expect(out.comment).toBe(`# ${file}\n\nWhat I did.`);
    expect(out.comment).not.toContain(REPORT_END_MARKER);
  });

  it("starts the Session with the Task and the result instructions, and no standard block of its own", async () => {
    const shared = createMemoryShared();
    const core = startFakeCore({ harness: writes(shared, "success.md", "ok") });
    const client = await connect(core);
    await dispatchTask({
      client, shared, task, attempt: 1, ...fast,
      comments: [
        { authorName: "Ada", authorKind: "user", body: "Please look at CI." },
        { authorName: "Panel", authorKind: "system", body: "Dispatched." },
      ],
    });
    const sent = core.framesOfType("spawn")[0].opts.initialInput;
    expect(sent).toContain("Task: Fix the flaky test");
    expect(sent).toContain("It fails one run in ten.");
    expect(sent).toContain("- Ada (user): Please look at CI.");
    expect(sent).not.toContain("Dispatched.");
    expect(sent).toContain("~/shared/tasks/T-42/success.md");
    expect(sent).toContain("~/shared/tasks/T-42/fail.md");
    expect(sent).toContain("~/shared/tasks/T-42/partial-<n>.md");
    expect(sent).toContain(`last line exactly ${REPORT_END_MARKER}`);
    expect(sent).not.toContain("[Actana standard block");
  });

  it("ignores a result file older than the dispatch and takes the one written after it", async () => {
    const shared = createMemoryShared();
    await shared.put("tasks/T-42/success.md", `# last week's\n\n${REPORT_END_MARKER}\n`, Date.now() - 60_000);
    const core = startFakeCore({ harness: writes(shared, "fail.md", "this time it failed") });
    const client = await connect(core);
    const out = await dispatchTask({ client, shared, task, ...fast });
    expect(out.status).toBe("failed");
    expect(out.comment).toBe("this time it failed");
  });

  it("does not settle on a file that is still being written, only on the finished one", async () => {
    const shared = createMemoryShared();
    const core = startFakeCore({
      harness: async () => {
        await new Promise((r) => setTimeout(r, 10));
        await shared.put("tasks/T-42/success.md", "# half a repo");
        await new Promise((r) => setTimeout(r, 40));
        await shared.put("tasks/T-42/success.md", `# the whole report\n\n${REPORT_END_MARKER}\n`);
      },
    });
    const client = await connect(core);
    const out = await dispatchTask({ client, shared, task, ...fast });
    expect(out.status).toBe("done");
    expect(out.comment).toBe("# the whole report");
  });

  it("on a re-run, renames the older results to attempt-<n>-<name> first, and files the new comment under the new attempt", async () => {
    const shared = createMemoryShared();
    await shared.put("tasks/T-42/success.md", `# attempt one\n\n${REPORT_END_MARKER}\n`, Date.now() - 60_000);
    await shared.put("tasks/T-42/attempt-1.log", "log", Date.now() - 60_000);
    const core = startFakeCore({ harness: writes(shared, "success.md", "attempt two") });
    const client = await connect(core);

    const out = await dispatchTask({ client, shared, task, attempt: 2, ...fast });

    expect(out).toMatchObject({ status: "done", attempt: 2, sourceFile: "attempt-2-success.md" });
    const names = (await shared.list("tasks/T-42/")).map((e) => e.path.split("/").pop()).sort();
    expect(names).toEqual(["attempt-1-success.md", "attempt-1.log", "success.md"]);
    expect(new TextDecoder().decode((await shared.get("tasks/T-42/attempt-1-success.md")).body)).toContain("attempt one");
  });

  it("an agent that exits with no result gets a fail.md written for it, and the Task fails", async () => {
    const shared = createMemoryShared();
    const core = startFakeCore({ harness: async ({ exit }) => exit(3) });
    const client = await connect(core);

    const out = await dispatchTask({ client, shared, task, ...fast });

    expect(out.status).toBe("failed");
    expect(out.comment).toContain("The agent exited (code 3) without writing a result file.");
    const written = new TextDecoder().decode((await shared.get("tasks/T-42/fail.md")).body);
    expect(written).toContain("written by the dispatcher");
    expect(written.trimEnd().endsWith(REPORT_END_MARKER)).toBe(true);
  });

  it("a result that lands during the grace after the exit still counts", async () => {
    const shared = createMemoryShared();
    const core = startFakeCore({
      harness: async ({ exit }) => {
        exit(0);
        await new Promise((r) => setTimeout(r, 15));
        await shared.put("tasks/T-42/success.md", `# made it\n\n${REPORT_END_MARKER}\n`);
      },
    });
    const client = await connect(core);
    const out = await dispatchTask({ client, shared, task, ...fast, exitGraceMs: 80 });
    expect(out.status).toBe("done");
  });

  it("a Task that runs out of time fails with that reason", async () => {
    const shared = createMemoryShared();
    const core = startFakeCore({ harness: () => undefined });
    const client = await connect(core);
    const out = await dispatchTask({ client, shared, task, ...fast, timeoutMs: 40 });
    expect(out.status).toBe("failed");
    expect(out.comment).toContain("wrote no result within");
  });

  it("keeps a report over the size limit on the Shared folder and points to it", async () => {
    const shared = createMemoryShared();
    const big = "x".repeat(MAX_REPORT_BYTES + 1);
    const core = startFakeCore({ harness: writes(shared, "success.md", big) });
    const client = await connect(core);
    const out = await dispatchTask({ client, shared, task, ...fast });
    expect(out.status).toBe("done");
    expect(out.comment).toContain("Read it at tasks/T-42/success.md");
    expect(out.comment.length).toBeLessThan(500);
  });
});

describe("buildTaskPrompt", () => {
  it("defuses text that quotes the standard block, so the Core still appends its own", () => {
    const prompt = buildTaskPrompt({ id: "T-1", title: "t", description: "see [Actana standard block v1] and [/Actana standard block v1]" }, [], 1);
    expect(prompt).not.toMatch(/\[\/?Actana standard block/);
    expect(prompt).toContain("[Actana standard-block v1]");
  });
});

describe("archivePreviousResults", () => {
  it("leaves a result already archived under that name, and does not throw", async () => {
    const shared = createMemoryShared();
    await shared.put("tasks/T-1/success.md", "new");
    await shared.put("tasks/T-1/attempt-1-success.md", "old");
    await archivePreviousResults(shared, "T-1", 1);
    expect(new TextDecoder().decode((await shared.get("tasks/T-1/attempt-1-success.md")).body)).toBe("old");
  });
});
