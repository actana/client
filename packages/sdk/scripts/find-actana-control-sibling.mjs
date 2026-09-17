// Walk up from `startDir` until `../actana-control` exists (worktree or actana-client).
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * @param {string} startDir
 * @returns {string}
 */
export function findActanaControlSibling(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const sibling = path.resolve(dir, "..", "actana-control");
    if (existsSync(sibling)) return sibling;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `actana-control sibling not found walking up from ${startDir}`,
      );
    }
    dir = parent;
  }
}
