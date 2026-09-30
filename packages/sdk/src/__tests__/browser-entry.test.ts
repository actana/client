import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));

const SUBPATH = "./core/link-frames";
// Files that pull undici, ws or Node builtins; the browser entry must never reach them.
const NODE_ONLY = ["client.ts", "durable-client.ts", "files-http.ts", "link-socket.ts", "link-transport.ts"];

// Matches `import ... from "x"`, `export ... from "x"`, `import "x"` and `import("x")`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]([^"'`]+)["'`]/g;
// Node globals and CommonJS loaders; checked on walked sources; comments are stripped first so prose does not count.
const NODE_GLOBALS = /\b(?:Buffer|__dirname|__filename)\b|\bprocess\.|\brequire\s*\(|\bimport\s+\w+\s*=\s*require\b/;
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
// What a browser bundle must not contain: undici, ws, node: specifiers, Vite's Node-builtin stub.
const NODE_IN_BUNDLE = /undici|__vite-browser-external|\bnode:|(["'`])ws\1/;

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
    const source = stripComments(readFileSync(file, "utf8"));
    if (NODE_GLOBALS.test(source)) offenders.push(`global:${file}`);
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
    expect(published).toEqual({ types: "./dist/core/browser.d.ts", default: "./dist/core/browser.js" });
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

  it("bundles for the browser with Vite without undici, ws, node: imports or Node stubs", async () => {
    // vite is only in the lockfile through vitest, so resolve it from there (no new dependency).
    const vitePath = createRequire(createRequire(import.meta.url).resolve("vitest")).resolve("vite");
    const { build } = (await import(pathToFileURL(vitePath).href)) as typeof import("vite");
    const dir = mkdtempSync(join(sdkRoot, ".browser-bundle-"));
    const outDir = join(dir, "out");
    const entry = join(dir, "entry.ts");
    // Self-reference through the exports map, the way a consumer imports the subpath.
    writeFileSync(entry, `export * from "@actana/sdk/core/link-frames";\n`);
    const logs: string[] = [];
    const sinks: Array<[NodeJS.WriteStream, NodeJS.WriteStream["write"]]> = [];
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write;
      sinks.push([stream, original]);
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        logs.push(String(chunk));
        return (original as (...a: unknown[]) => boolean).call(stream, chunk, ...rest);
      }) as typeof stream.write;
    }
    try {
      await build({
        root: dir,
        configFile: false,
        logLevel: "info",
        customLogger: {
          hasWarned: false,
          info: (msg) => void logs.push(msg),
          warn: (msg) => void logs.push(msg),
          warnOnce: (msg) => void logs.push(msg),
          error: (msg) => void logs.push(msg),
          clearScreen: () => {},
          hasErrorLogged: () => false,
        },
        build: {
          target: "esnext",
          minify: false,
          outDir,
          emptyOutDir: true,
          lib: { entry, formats: ["es"], fileName: "bundle" },
        },
      });
      const outputs = readdirSync(outDir).filter((name) => name.endsWith(".js"));
      expect(outputs.length).toBe(1);
      const code = readFileSync(join(outDir, outputs[0] as string), "utf8");
      expect(code).toContain("CORE_LINK_PROTOCOL_VERSION");
      expect(code.match(NODE_IN_BUNDLE)?.[0]).toBeUndefined();
      expect(logs.filter((line) => NODE_IN_BUNDLE.test(line) || /externalized|warn/i.test(line))).toEqual([]);
    } finally {
      for (const [stream, original] of sinks) stream.write = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
