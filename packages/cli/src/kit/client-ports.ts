// Client-side port shapes the dependency bag names.
//
// Implementations arrive with the client nouns (T-217); the types live here so
// `ClientDeps` is stable and nothing under `cli/src` imports an `actana-*`
// machine module.

import type { CliTerminal, Unsubscribe } from "./cli-terminal.ts";

/** Credential for reaching a Core — shape owned by `@actana/sdk` (T-212). */
export type CoreRegistrationBlob = {
  endpoint: string;
  label?: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  bearer: string;
};

/** What one round trip to a Core tells you about it. */
export type CoreProbe = {
  coreId: string | null;
  protocolVersion: string | null;
  compatible: boolean;
  multiConnection: boolean;
  bearerExpiresAt: number | null;
};

export type CoreProbeFn = (
  blob: CoreRegistrationBlob,
  opts: { timeoutMs: number },
) => Promise<CoreProbe>;

export type CoreLinkCursorStorage = {
  read(): Promise<number | null>;
  write(eventId: number): Promise<void>;
};

export type CoreConnectOptions = {
  durable?: boolean;
  storage?: CoreLinkCursorStorage;
  timeoutMs?: number;
};

/** Connected client slice the client nouns use — satisfied by the SDK client. */
export type CoreLinkClient = {
  close(): void;
};

export type CoreConnectFn = (
  blob: CoreRegistrationBlob,
  opts?: CoreConnectOptions,
) => Promise<CoreLinkClient>;

export type CorePairingIdentity = {
  caFingerprint: string;
};

export type PairWithCoreOptions = {
  address: string;
  code: string;
  sessionId: string;
  expectedCaFingerprint: string;
  label?: string;
  timeoutMs?: number;
};

export type CorePairingPort = {
  identify: (opts: { address: string; timeoutMs?: number }) => Promise<CorePairingIdentity>;
  pair: (opts: PairWithCoreOptions) => Promise<CoreRegistrationBlob>;
};

export type CoreShellExit = { exitCode: number; signal?: number };

export type CoreShellChannel = {
  readonly ptyId: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  onData(cb: (data: string) => void): Unsubscribe;
  onExit(cb: (exit: CoreShellExit) => void): Unsubscribe;
  onDisconnected(cb: (info: { error?: string }) => void): Unsubscribe;
  kill(): Promise<void>;
  close(): void;
};

export type OpenCoreShellFn = (
  blob: CoreRegistrationBlob,
  opts: { cols: number; rows: number; connectTimeoutMs: number },
) => Promise<CoreShellChannel>;

export type SessionGateway = {
  close(): void;
};

export type OpenSessionGateway = (
  blob: CoreRegistrationBlob,
  opts: { timeoutMs: number },
) => Promise<SessionGateway>;

export type ProjectFilesGateway = {
  close(): void;
};

export type OpenProjectFilesFn = (
  blob: CoreRegistrationBlob,
  opts: { timeoutMs: number },
) => Promise<ProjectFilesGateway>;

export type AttachAuthority = "writer" | "reader";

export type SessionAttachExit = { exitCode: number; signal?: number };

export type SessionAttachment = {
  readonly taskId: string;
  readonly ptyId: string;
  readonly authority: AttachAuthority;
  readonly backlog: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  onData(cb: (data: string) => void): Unsubscribe;
  onExit(cb: (exit: SessionAttachExit) => void): Unsubscribe;
  onDisconnected(cb: (info: { error?: string }) => void): Unsubscribe;
  release(): Promise<boolean>;
  close(): void;
};

export type OpenSessionAttachFn = (
  blob: CoreRegistrationBlob,
  opts: {
    taskId: string;
    cols: number;
    rows: number;
    connectTimeoutMs: number;
    claimWrite: boolean;
  },
) => Promise<SessionAttachment>;
