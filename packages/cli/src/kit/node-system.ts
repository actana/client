// The client prompts port, bound to the real terminal.

import * as readline from "node:readline";
import type { ClientPrompts } from "./cli-deps.ts";

/** Fingerprint confirmation and other client-side prompts on this machine. */
export function nodeClientPrompts(): ClientPrompts {
  return {
    confirm(question, defaultYes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, (answer) => {
          rl.close();
          const trimmed = answer.trim().toLowerCase();
          if (trimmed === "") resolve(defaultYes);
          else resolve(trimmed === "y" || trimmed === "yes");
        });
      });
    },
  };
}
