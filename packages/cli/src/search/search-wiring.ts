// SDK wiring for the `search` noun — the counterpart of `sdkCorePairing`.

import { readFile } from "node:fs/promises";
import { SearchClient } from "@actana/sdk/search";
import { fetchSearchPairingIdentity, pairWithSearch } from "@actana/sdk/pairing";
import type { ClientDeps } from "../kit/cli-deps.ts";
import type { SearchCliDeps } from "./search-deps.ts";

export const sdkSearchPairing = {
  identify: fetchSearchPairingIdentity,
  pair: pairWithSearch,
};

/** Map the general client bag into what `runSearchCommand` needs. */
export function searchDepsFrom(deps: ClientDeps, argv: string[]): SearchCliDeps {
  return {
    argv,
    env: deps.env,
    home: deps.home,
    out: deps.out,
    err: deps.err,
    verbose: deps.verbose,
    readStdin: deps.readStdin,
    readFile,
    stdoutIsTty: deps.stdoutIsTty,
    interactive: deps.interactive,
    hostname: deps.hostname,
    platform: deps.platform,
    now: deps.now,
    pairing: sdkSearchPairing,
    clientFor: (blob) => SearchClient.fromRegistrationBlob(blob),
    confirmFingerprint: (prompt) => deps.system.confirm(prompt, false),
  };
}
