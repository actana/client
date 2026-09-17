import { SDK_VERSION } from "@actana/sdk/version.ts";

/** Placeholder entry until T-215+ lifts the client dispatcher from Control. */
export async function runClient(_argv: string[]): Promise<number> {
  process.stdout.write(`actana client scaffold (${SDK_VERSION})\n`);
  return 0;
}
