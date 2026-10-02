// Projects are gone (actana/client#10 part 3, ADR 0041 D1). The `project` noun
// and every project argument must refuse. A 0.5.0 Core answers `projectsList`
// with "unhandled frame type" (actana/control#555 / PR 618), and the image smoke
// fails on exactly that (run 36851520551).

import { describe, it, expect, afterEach } from "vitest";
import { makeCliFixture, registerCore, type CliFixture } from "./cli-harness.ts";
import { EXIT_USAGE, EXIT_OK } from "../kit/exit-codes.ts";
import { sessionGatewayFor, type SessionRow } from "../core/session-gateway.ts";
import type { CoreClient } from "@actana/sdk/core";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe("actana project is gone", () => {
  it("treats `project` as an unknown command (empty stdout, usage on stderr, EXIT_USAGE)", async () => {
    const run = await cli().run(["project", "ls"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out.join("\n")).toBe("");
    expect(run.err.join("\n")).toMatch(/unknown command ["']project["']/i);
  });

  it("refuses `--cwd` on session start (EXIT_USAGE on stderr, empty stdout)", async () => {
    registerCore(cli().paths, "prod");
    const run = await cli().run(["session", "start", "--cwd", "/tmp", "hello"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out.join("\n")).toBe("");
    expect(run.err.join("\n")).toMatch(/--cwd/i);
  });
});

describe("session ls sends no project frame", () => {
  it("the real gateway list() dials sessionsList and sessionRowsList only", async () => {
    const frames: string[] = [];
    const client = {
      sessionsList: async () => {
        frames.push("sessionsList");
        return [{ sessionId: "s1", ptyId: null, status: "ready", updatedAt: 1 }];
      },
      sessionRowsList: async () => {
        frames.push("sessionRowsList");
        return {
          sessions: [
            {
              sessionId: "s1",
              title: "t",
              titleManuallySet: false,
              claudeSessionId: null,
              agent: "claude-code",
              status: "ready",
              pinned: false,
              archived: false,
              icon: null,
              updatedAt: 1,
            },
          ],
          archivedCount: 0,
        };
      },
      projectsList: async () => {
        frames.push("projectsList");
        throw new Error("projectsList must not be dialled");
      },
      close: () => undefined,
    } as unknown as CoreClient;

    const gateway = sessionGatewayFor(client);
    const rows = await gateway.list();
    expect(rows).toEqual([
      expect.objectContaining({ sessionId: "s1", title: "t", harness: "claude-code" }),
    ]);
    expect(rows[0]).not.toHaveProperty("projectId");
    expect(rows[0]).not.toHaveProperty("project");
    expect(frames).toEqual(["sessionsList", "sessionRowsList"]);
  });

  it("actana session ls --json never mentions a project on stdout", async () => {
    registerCore(cli().paths, "prod");
    const row: SessionRow = {
      sessionId: "s1",
      title: "hello",
      harness: "claude-code",
      status: "ready",
      ptyId: null,
      live: false,
      writable: null,
      lock: null,
      updatedAt: 1,
    };
    const run = await cli().run(["session", "ls", "--json"], {
      sessions: async () => ({
        list: async () => [row],
        start: async () => {
          throw new Error("start");
        },
        resume: async () => {
          throw new Error("resume");
        },
        logs: async () => {
          throw new Error("logs");
        },
        send: async () => ({ ok: false, failed: "text" }),
        kill: async () => ({ ptyId: "p", killed: true }),
        close: () => undefined,
      }),
    });
    expect(run.code).toBe(EXIT_OK);
    const payload = run.out.join("\n");
    expect(payload).not.toMatch(/project/i);
    expect(JSON.parse(payload)).toEqual([expect.objectContaining({ sessionId: "s1" })]);
  });
});
