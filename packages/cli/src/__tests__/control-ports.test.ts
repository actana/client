// `runClient(argv, deps)` against the port shapes Control binds today (client issue 11).
//
// Control's in-repo CLI (actana/control, `packages/cli/src/session-gateway.ts` at origin/feat/0.5.0)
// declares the Session gateway below. It is mirrored here by hand, shape for shape and without its
// comments, because this repository cannot import it. A host (Control's built-in CLI, actana/control
// issue 580) binds a gateway of exactly this shape and hands it to `runClient`; this file is the
// compile-time proof that it fits, using only what `@actana/cli` exports.
//
// Control's `send` returned `Promise<boolean>` against the client's `SendResult` until this issue, so
// `runClient(argv, deps)` did not typecheck with Control's ports. That is what the `@ts-expect-error`
// lines at the bottom keep honest: they fail the typecheck if the old shape ever fits again.

import { describe, it, expect } from "vitest";
import {
  runClient,
  type ClientDeps,
  type CoreProbeFn,
  type CoreConnectFn,
  type CorePairingPort,
  type OpenCoreShellFn,
  type OpenSessionAttachFn,
  type OpenSessionGateway,
  type OpenFilesFn,
  type OpenSharedFn,
  type SendResult,
  type PromptDeliveryReport,
  type CliTerminal,
} from "../index.ts";
import type { CoreLinkPtySpawnHarness, CoreLinkSessionLockState } from "@actana/sdk/core";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";

// ─── Control's shapes, mirrored ──────────────────────────────────────────────

type ControlPromptDeliveryReport =
  | { outcome: "delivered" }
  | { outcome: "abandoned"; reason: string }
  | { outcome: "unverified"; reason: string }
  | { outcome: "unavailable"; reason: string };

type ControlSendResult =
  | { ok: true }
  | { ok: false; failed: "text" }
  | { ok: false; failed: "carriage-return" };

type ControlSessionOutcome = { status: string; exited: boolean; exitCode?: number };

type ControlStartedSession = {
  sessionId: string;
  ptyId: string;
  harness: string | null;
  command: string | null;
  reportsTurnStart: boolean | null;
  wait(opts: { timeoutMs?: number }): Promise<ControlSessionOutcome>;
  screen(): string;
  promptAbandoned(): { reason: string } | null;
  promptDeliveryReport(): ControlPromptDeliveryReport | null;
  awaitPromptDelivery(): Promise<ControlPromptDeliveryReport>;
  dispose(): void;
};

type ControlSessionGateway = {
  list(): Promise<
    Array<{
      sessionId: string;
      title: string;
      harness: string;
      status: string;
      ptyId: string | null;
      live: boolean;
      writable: boolean | null;
      lock: CoreLinkSessionLockState | null;
      updatedAt: number;
    }>
  >;
  start(request: {
    prompt?: string;
    title?: string;
    harness: CoreLinkPtySpawnHarness | null;
    dangerouslySkipPermissions: boolean;
  }): Promise<ControlStartedSession>;
  resume(request: {
    sessionId: string;
    prompt?: string;
    dangerouslySkipPermissions: boolean;
  }): Promise<ControlStartedSession>;
  logs(sessionId: string): Promise<{ sessionId: string; ptyId: string; screen: string; raw: string }>;
  send(sessionId: string, text: string, opts?: { enter?: boolean }): Promise<ControlSendResult>;
  // Control's gateway also has these two; the client's does not, and extra members must still fit.
  wait(sessionId: string): Promise<ControlStartedSession>;
  sendAndWait(sessionId: string, text: string, opts?: { enter?: boolean }): Promise<ControlStartedSession>;
  kill(sessionId: string): Promise<{ ptyId: string; killed: boolean }>;
  close(): void;
};

type ControlOpenSessionGateway = (
  blob: CoreRegistrationBlob,
  opts: { timeoutMs: number },
) => Promise<ControlSessionGateway>;

// ─── The proof: a Control-shaped binding is accepted wherever the client wants one ───

const controlOpenSessions: ControlOpenSessionGateway = async () => {
  throw new Error("not dialled in this test");
};

// Each assignment is the type test. A mismatch fails `pnpm --filter @actana/cli typecheck`.
const asClientPort: OpenSessionGateway = controlOpenSessions;
const reportBothWays: [PromptDeliveryReport, ControlPromptDeliveryReport] = [
  {} as ControlPromptDeliveryReport,
  {} as PromptDeliveryReport,
];
const sendBothWays: [SendResult, ControlSendResult] = [{} as ControlSendResult, {} as SendResult];

// The old shape must NOT fit: this is what the issue fixed.
const oldGateway = async () => ({
  ...(await controlOpenSessions({} as CoreRegistrationBlob, { timeoutMs: 1 })),
  send: async (): Promise<boolean> => true,
});
// @ts-expect-error — a `send` that answers a boolean is not Control's, and is not the client's.
const oldPort: OpenSessionGateway = oldGateway;
// @ts-expect-error — a started Session with no prompt-delivery report cannot be bound.
const noReport: OpenSessionGateway = async () => ({
  ...(await controlOpenSessions({} as CoreRegistrationBlob, { timeoutMs: 1 })),
  start: async () => ({ ...({} as ControlStartedSession), awaitPromptDelivery: undefined }),
});

/** What a host builds: Control's session port, the rest of the bag from the exported port types. */
function hostDeps(): ClientDeps {
  const lines: string[] = [];
  const unused = (name: string) => async () => {
    throw new Error(`${name} is not bound in this test`);
  };
  return {
    argv: [],
    env: {},
    home: "/nonexistent",
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    outBytes: (chunk) => lines.push(chunk),
    errBytes: (chunk) => lines.push(chunk),
    verbose: () => {},
    readStdin: async () => "",
    stdinIsTty: false,
    stdoutIsTty: false,
    hostname: "host",
    platform: "linux",
    interactive: false,
    system: { confirm: async () => true },
    probe: unused("probe") as unknown as CoreProbeFn,
    connect: unused("connect") as unknown as CoreConnectFn,
    pairing: { identify: unused("identify"), pair: unused("pair") } as unknown as CorePairingPort,
    openSessions: controlOpenSessions,
    now: () => 0,
    terminal: {} as CliTerminal,
    openShell: unused("openShell") as unknown as OpenCoreShellFn,
    openAttach: unused("openAttach") as unknown as OpenSessionAttachFn,
    openShared: unused("openShared") as unknown as OpenSharedFn,
    openFiles: unused("openFiles") as unknown as OpenFilesFn,
  };
}

describe("runClient with Control's ports", () => {
  it("accepts a Control-shaped session port, and runs with it bound", async () => {
    expect(typeof asClientPort).toBe("function");
    expect(reportBothWays).toHaveLength(2);
    expect(sendBothWays).toHaveLength(2);
    expect(typeof oldPort).toBe("function");
    expect(typeof noReport).toBe("function");

    const deps = hostDeps();
    const seen: string[] = [];
    deps.out = (line) => seen.push(line);
    const code = await runClient(["--help"], deps);
    expect(code).toBe(0);
    expect(seen.join("\n")).toContain("session");
  });
});
