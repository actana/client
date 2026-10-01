// Reaching a Core's Shared folder for the `shared` noun (client #7).
//
// One small factory is the whole seam between the command and a mode of
// `CoreShared`. The command (`shared-command.ts`) is written against the
// `CoreShared` interface that `@actana/sdk/shared` exports and nothing else: it
// does not know whether the folder is reached through the Core or straight in
// S3, and it never imports a mode.
//
// **The through-the-Core mode is the default for a paired Core**, because a
// paired Core is what the CLI holds a credential for. That mode is client PR 39,
// which is still in review. Until it merges there is no implementation to bind,
// so {@link openSharedThroughCore} is a stub that says so (exit 3,
// `EXIT_UNIMPLEMENTED`: "this build cannot do that yet"), and every test binds a
// double through `deps.openShared` instead.
//
// THE SEAM, for whoever lands PR 39: replace the body of
// {@link openSharedThroughCore} with the Core mode's constructor, fed from the
// blob, and return `{ shared, close }`. Nothing in `shared-command.ts` changes.
// The direct-S3 mode is not offered here on purpose: it needs the master key,
// which a Core blob does not carry.

import type { CoreShared } from "@actana/sdk/shared";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";

/** An open view of one Core's Shared folder. */
export type SharedHandle = {
  shared: CoreShared;
  /** How long `shared watch` waits between polls. Default {@link DEFAULT_WATCH_POLL_MS}. */
  pollIntervalMs?: number;
  /** Release whatever the mode holds open. Called once, when the command is done. */
  close(): void;
};

/** How the `shared` noun reaches a Core's Shared folder. Injected, so every verb is testable. */
export type OpenSharedFn = (
  blob: CoreRegistrationBlob,
  opts?: { timeoutMs?: number },
) => Promise<SharedHandle>;

/** `shared watch` polls `CoreShared.watch(since)`: the interface has no push. */
export const DEFAULT_WATCH_POLL_MS = 2_000;

/** This build has no implementation of the mode asked for. Not a typo, not a Core refusal. */
export class SharedUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedUnavailableError";
  }
}

/**
 * The default factory: the through-the-Core mode. A stub until client PR 39
 * merges (see the header).
 */
export const openSharedThroughCore: OpenSharedFn = async () => {
  throw new SharedUnavailableError(
    "reaching the Shared folder through a Core is not in this build yet (actana/client PR 39)",
  );
};
