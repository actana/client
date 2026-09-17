import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      files.push(...walkTsFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("cli/src has no actana-* machine imports", () => {
  it("imports no actana-* machine module under packages/cli/src", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(srcRoot)) {
      const text = readFileSync(file, "utf8");
      const rel = path.relative(srcRoot, file);
      for (const line of text.split("\n")) {
        const match = line.match(/from\s+["']([^"']+)["']/);
        if (!match) continue;
        const spec = match[1]!;
        if (/actana-(system|release|install|update|setup|status|service|config|layout|manifest|launcher|container|systemd|launchd|uninstall|tree|fetch-release|harnesses|cli)\.ts/.test(spec)) {
          offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
