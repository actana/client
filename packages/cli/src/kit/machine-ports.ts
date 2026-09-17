// Machine-side port shapes — types only, no `actana-*` machine modules.
//
// The built-in CLIs (`actana/control`, `actana/search`) inject real
// implementations; the general client CLI never reads these fields. The shapes
// live here so `MachineDeps` can name them without importing
// `actana-system.ts` or `actana-release.ts`.

/** The outcome of a captured command run. */
export type CommandResult = {
  /** Exit status. 127 stands in for "could not be started at all". */
  status: number;
  stdout: string;
  stderr: string;
};

export type ActanaSystem = {
  run(command: string, args: string[]): CommandResult;
  passthrough(command: string, args: string[]): Promise<number>;
  waitForPort(port: number, timeoutMs: number): Promise<boolean>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  signal(pid: number, signal: NodeJS.Signals): boolean;
};

/** Fetching bytes — the only impure thing in the update path's release half. */
export type ReleaseFetcher = {
  fetchText(url: string): Promise<string>;
  download(url: string, destPath: string): Promise<void>;
};
