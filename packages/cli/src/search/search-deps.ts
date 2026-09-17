// What the Search client nouns need from the world, as one injected bag.

import type { SearchClient } from "@actana/sdk/search";
import type { PairingIdentity, PairWithSearchOptions, RegistrationBlob } from "@actana/sdk/pairing";

export type SearchPairingPort = {
  identify: (opts: { address: string; timeoutMs?: number }) => Promise<PairingIdentity>;
  pair: (opts: PairWithSearchOptions) => Promise<RegistrationBlob>;
};

export type SearchCliDeps = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  home: string;
  out: (line: string) => void;
  err: (line: string) => void;
  verbose: (line: string) => void;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Promise<Buffer>;
  stdoutIsTty: boolean;
  interactive: boolean;
  hostname: string;
  platform: NodeJS.Platform;
  now: () => number;
  pairing: SearchPairingPort;
  clientFor: (blob: RegistrationBlob) => SearchClient;
  confirmFingerprint?: (prompt: string) => Promise<boolean>;
};
