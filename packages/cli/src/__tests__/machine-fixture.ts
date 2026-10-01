// Machine-half fakes for tests that still build one dependency bag (#288).

import { spawnSync } from "node:child_process";
import type { ClientDeps, MachineDeps } from "../kit/cli-deps.ts";
import type { ActanaSystem, CommandResult, ReleaseFetcher } from "../kit/machine-ports.ts";
import { nonInteractiveTerminal } from "../kit/cli-terminal.ts";

/** The `ActanaSystem` a suite drives `systemctl` and `tar` through. */
export type FakeSystem = ActanaSystem & {
  calls: string[][];
  signals: Array<[number, string]>;
  answers: boolean[];
  passthroughFailures: Record<string, number>;
  listening: boolean;
};

export function fakeSystem(
  overrides: Record<string, CommandResult> = {},
  realRun?: (command: string, args: string[]) => CommandResult,
): FakeSystem {
  const calls: string[][] = [];
  const signals: Array<[number, string]> = [];
  const system: FakeSystem = {
    calls,
    signals,
    answers: [],
    passthroughFailures: {},
    listening: true,
    run(command, args) {
      calls.push([command, ...args]);
      const key = [command, ...args].join(" ");
      for (const [prefix, result] of Object.entries(overrides)) {
        if (key.startsWith(prefix)) return result;
      }
      if (realRun) {
        const real = realRun(command, args);
        if (real) return real;
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    async passthrough(command, args) {
      calls.push([command, ...args]);
      const line = args.join(" ");
      for (const [needle, code] of Object.entries(system.passthroughFailures)) {
        if (line.includes(needle)) return code;
      }
      return 0;
    },
    async waitForPort() {
      return system.listening;
    },
    async confirm() {
      return system.answers.length > 1 ? (system.answers.shift() ?? true) : (system.answers[0] ?? true);
    },
    signal(pid, sig) {
      signals.push([pid, sig]);
      return true;
    },
  };
  return system;
}

export function realTar(command: string, args: string[]): CommandResult {
  if (command !== "tar") return null as unknown as CommandResult;
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 127,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function refusingFetcher(): ReleaseFetcher {
  return {
    async fetchText(url) {
      throw new Error(`this test did not expect to fetch ${url}`);
    },
    async download(url) {
      throw new Error(`this test did not expect to download ${url}`);
    },
  };
}

export type MachineHalf = Pick<
  MachineDeps,
  | "networkInterfaces"
  | "arch"
  | "user"
  | "uid"
  | "installRoot"
  | "fetcher"
  | "debug"
  | "probeHarnesses"
  | "runDaemon"
>;

export function stubMachineHalf(over: Partial<MachineHalf> = {}): MachineHalf {
  return {
    networkInterfaces: { eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }] },
    arch: "x64",
    user: "op",
    uid: 501,
    installRoot: "",
    fetcher: refusingFetcher(),
    debug: () => {},
    probeHarnesses: () => ({ "claude-code": { available: true } }),
    runDaemon: async () => {
      throw new Error("this test did not expect to start a daemon");
    },
    ...over,
  };
}

export type ClientHalf = Pick<
  ClientDeps,
  | "outBytes"
  | "errBytes"
  | "verbose"
  | "readStdin"
  | "stdinIsTty"
  | "stdoutIsTty"
  | "hostname"
  | "platform"
  | "interactive"
  | "system"
  | "probe"
  | "connect"
  | "pairing"
  | "openSessions"
  | "now"
  | "terminal"
  | "openShell"
  | "openAttach"
>;

export function stubClientHalf(
  now: () => number = () => Date.UTC(2026, 7, 12),
): ClientHalf {
  const refuse = (what: string) => async () => {
    throw new Error(`this test did not expect to ${what}`);
  };
  return {
    outBytes: () => {},
    errBytes: () => {},
    verbose: () => {},
    readStdin: async () => "",
    stdinIsTty: false,
    stdoutIsTty: false,
    hostname: "vm-1",
    platform: "linux",
    interactive: false,
    system: fakeSystem(),
    probe: refuse("dial a Core"),
    connect: refuse("dial a Core"),
    pairing: { identify: refuse("identify a Core"), pair: refuse("pair with a Core") },
    openSessions: refuse("open a session gateway"),
    now,
    terminal: nonInteractiveTerminal(),
    openShell: refuse("open a shell"),
    openAttach: refuse("attach to a session"),
  };
}
