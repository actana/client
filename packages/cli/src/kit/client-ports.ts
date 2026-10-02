// Client-side port shapes the dependency bag names (re-exported from core modules).

export type { CoreProbe, CoreProbeFn } from "../core/core-probe.ts";
export type {
  CoreConnectFn,
  CoreConnectOptions,
  CoreLinkClient,
} from "../core/core-connection.ts";
export type { CorePairingPort } from "../core/core-pair.ts";
export type { OpenCoreShellFn, CoreShellChannel, CoreShellExit } from "../core/core-shell-channel.ts";
export type {
  OpenSessionGateway,
  SessionGateway,
  SendResult,
  StartedSession,
  SessionOutcome,
  SessionRow,
  SessionLogs,
  PromptDeliveryReport,
} from "../core/session-gateway.ts";
export type { OpenFilesFn } from "../core/files-gateway.ts";
export type { OpenSharedFn } from "../core/shared-gateway.ts";
export type {
  OpenSessionAttachFn,
  SessionAttachment,
  SessionAttachExit,
  AttachAuthority,
} from "../core/session-attach-channel.ts";
export type { CoreRegistrationBlob } from "@actana/sdk/pairing";
