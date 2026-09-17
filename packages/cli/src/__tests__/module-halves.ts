// Which half of the client CLI a module belongs to.
//
// `@actana/cli` ships client nouns only; machine verbs live in product repos.
// Every shipped module is client-side and is swept by the boundary tests.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** This package's `src`, from any test file under `src/__tests__`. */
export const SRC = path.resolve(import.meta.dirname, "..");

/** No machine modules ship in the general client CLI (T-217). */
export const MACHINE_MODULES: Record<string, string> = {};

export function shippedSources(dir: string = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...shippedSources(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

export function clientSources(): string[] {
  return shippedSources().filter((file) => !MACHINE_MODULES[path.relative(SRC, file)]);
}

export function machineSources(): string[] {
  return shippedSources().filter((file) => MACHINE_MODULES[path.relative(SRC, file)]);
}

export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n"'`]*\/\/[^\n]*$/gm, "");
}

export function importSpecifiers(source: string): string[] {
  return [
    ...withoutComments(source).matchAll(/(?:^|[\s(])(?:from|import)\s*\(?\s*(["'])([^"']+)\1/gm),
  ].map((m) => m[2]!);
}

export function named(file: string): { name: string; source: string } {
  return { name: path.relative(SRC, file), source: readFileSync(file, "utf8") };
}
