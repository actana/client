import { appendFileSync } from "node:fs";

const logPath = process.env.ACTANA_ISOLATION_LOG;
if (!logPath) {
  throw new Error("ACTANA_ISOLATION_LOG is required for isolation-hook.mjs");
}

/** @param {string} specifier */
export async function resolve(specifier, context, nextResolve) {
  appendFileSync(logPath, `${specifier}\n`);
  return nextResolve(specifier, context);
}
