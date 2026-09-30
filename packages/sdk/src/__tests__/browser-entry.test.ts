import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));

const SUBPATH = "./core/link-frames";
// Files that pull undici, ws or Node builtins; the browser entry must never reach them.
const NODE_ONLY = ["client.ts", "durable-client.ts", "files-http.ts", "link-socket.ts", "link-transport.ts"];

// Matches `import ... from "x"`, `export ... from "x"`, `import "x"` and `import("x")`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/** Walks the static import graph from `entry`; returns bare/node specifiers and Node-only files reached. */
function walk(entry: string): { offenders: string[]; files: string[] } {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (NODE_ONLY.includes(file.split("/").pop() as string)) offenders.push(`file:${file}`);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] as string;
      if (!specifier.startsWith(".")) {
        offenders.push(specifier);
        continue;
      }
      queue.push(resolve(dirname(file), specifier));
    }
  }
  return { offenders, files: [...seen] };
}

describe("browser-safe subpath @actana/sdk/core/link-frames", () => {
  it("is in the exports map and the build outputs", () => {
    const entry = (packageJson.exports as Record<string, string>)[SUBPATH];
    expect(entry).toBeTypeOf("string");
    expect(existsSync(join(sdkRoot, entry as string))).toBe(true);
    const published = packageJson.publishConfig.exports[SUBPATH];
    expect(published.default).toMatch(/^\.\/dist\/.*\.js$/);
    expect(published.types).toMatch(/^\.\/dist\/.*\.d\.ts$/);
  });

  it("is declared side-effect free", () => {
    expect(packageJson.sideEffects).toBe(false);
  });

  it("reaches no undici, ws, Node builtin or Node-only file through its import graph", () => {
    const entry = (packageJson.exports as Record<string, string>)[SUBPATH] as string;
    const { offenders, files } = walk(join(sdkRoot, entry));
    expect(files.length).toBeGreaterThan(1);
    expect(offenders).toEqual([]);
  });
});
