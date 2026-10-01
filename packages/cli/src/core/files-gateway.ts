// Reaching a Core's files, at its home folder, for the `files` noun (client #10).
//
// One small factory, the same seam `shared-gateway.ts` is for `shared`: the
// command (`files-command.ts`) is written against the SDK's `CoreFiles` and does
// not know how it is reached. The real factory dials the Core with the SDK's
// `CoreClient` (the version gate and the `files` capability check come with it)
// and hands over `client.files`, which sends the Core's `/v1/files` routes over
// the same mTLS material and bearer the link uses. Tests bind a double through
// `deps.openFiles`.

import { CoreClient, type CoreFiles } from "@actana/sdk/core";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";
import { DEFAULT_CORE_TIMEOUT_MS } from "./core-connection.ts";

/** The four calls `actana files` makes; a `CoreFiles` satisfies it as it is. */
export type FilesPort = Pick<CoreFiles, "list" | "download" | "upload" | "remove">;

/** An open view of one Core's home folder. */
export type FilesHandle = {
  files: FilesPort;
  /** Release whatever the connection holds open. Called once, when the command is done. */
  close(): void;
};

/** How the `files` noun reaches a Core's home folder. Injected, so every verb is testable. */
export type OpenFilesFn = (blob: CoreRegistrationBlob, opts?: { timeoutMs?: number }) => Promise<FilesHandle>;

/** The default factory: a `CoreClient` on the blob, refused when it cannot speak to this Core. */
export const openFilesAtHome: OpenFilesFn = async (blob, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CORE_TIMEOUT_MS;
  const client = CoreClient.fromRegistrationBlob(blob, { connectTimeoutMs: timeoutMs, requestTimeoutMs: timeoutMs });
  let info;
  try {
    info = await client.connect();
  } catch (err) {
    client.close();
    throw err;
  }
  if (!info.compatible) {
    client.close();
    throw new Error(
      `this Core speaks core-link ${info.protocolVersion ?? "(none reported)"}, which this CLI does not. ` +
        "Update whichever of the two is older — `actana core status` reports both.",
    );
  }
  return { files: client.files, close: () => client.close() };
};
