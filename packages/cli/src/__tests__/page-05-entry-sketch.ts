// Page 05 entry.ts sketch — must typecheck against @actana/cli exports.

import { runClient, NOT_HANDLED, clientHelp } from "../index.ts";
import type { ClientDeps } from "../kit/cli-deps.ts";

type MachineDeps = {
  client: ClientDeps;
};

async function machineVerbs(_argv: string[], _deps: MachineDeps): Promise<number | typeof NOT_HANDLED> {
  return NOT_HANDLED;
}

const machineHelp = clientHelp("Machine-only verbs from the built-in.");

export async function main(argv: string[], deps: MachineDeps): Promise<number> {
  const own = await machineVerbs(argv, deps);
  if (own !== NOT_HANDLED) return own;
  return runClient(argv, deps.client, {
    extraHelp: machineHelp,
    version: { self: "actana-control 0.5.0" },
  });
}
